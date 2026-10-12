//! Ordinary Run workspace PATCH mutations only. Requests with status=archived
//! remain on the explicitly selected Node archive authority.
mod boundary;
mod store;
mod validation;
use base64::Engine as _;
use rudder_auth_core::VerifiedActor;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool};
use store::*;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{1}")]
    Http(u16, String, Option<Value>),
    #[error("Workspace database operation failed")]
    Database(#[from] sqlx::Error),
}
type Result<T> = std::result::Result<T, Error>;
fn http(status: u16, message: impl Into<String>) -> Error {
    Error::Http(status, message.into(), None)
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub id: String,
    #[serde(default)]
    pub input: Value,
    #[serde(default)]
    pub input_missing: bool,
    #[serde(default)]
    pub local_implicit: bool,
    pub actor_run_id: Option<String>,
    pub credential_expires_at: Option<i64>,
    pub authenticated_org_id: Option<String>,
    #[serde(skip)]
    deferred_metadata_json: Option<String>,
    #[serde(skip)]
    metadata_serialization_failed: bool,
}

impl Request {
    pub fn parse(body: &[u8]) -> std::result::Result<Self, serde_json::Error> {
        boundary::stack(|| {
            let raw = std::str::from_utf8(body)
                .map_err(<serde_json::Error as serde::de::Error>::custom)?;
            let mut value = boundary::parse(raw)?;
            let missing = value.get("input").is_none();
            let mut input = value
                .as_object_mut()
                .and_then(|value| value.remove("input"))
                .unwrap_or(Value::Null);
            let sidecar = value
                .as_object_mut()
                .and_then(|value| value.remove("metadataJsonBase64"));
            let serialization_failed = value
                .as_object_mut()
                .and_then(|value| value.remove("metadataSerializationFailed"));
            let invalid = || {
                <serde_json::Error as serde::de::Error>::custom("Invalid metadata encoding fact")
            };
            if let Some(marker) = &serialization_failed
                && (marker != &Value::Bool(true)
                    || sidecar.is_some()
                    || !input
                        .as_object()
                        .and_then(|input| input.get("metadata"))
                        .is_some_and(Value::is_null))
            {
                return Err(invalid());
            }
            let mut deferred_metadata_json = None;
            if let Some(sidecar) = sidecar {
                let encoded = sidecar.as_str().ok_or_else(invalid)?;
                let metadata = input
                    .as_object_mut()
                    .and_then(|input| input.get_mut("metadata"))
                    .filter(|metadata| metadata.is_null())
                    .ok_or_else(invalid)?;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|_| invalid())?;
                let raw = String::from_utf8(bytes).map_err(|_| invalid())?;
                // The common parser first validates syntax and its depth guard.
                // Only well-formed JSON with unpaired UTF-16 escapes is deferred
                // to PostgreSQL; unrelated parsing failures stay malformed commands.
                match boundary::parse(&raw) {
                    Ok(value) if value.is_object() || value.is_null() => *metadata = value,
                    Ok(_) => return Err(invalid()),
                    Err(error)
                        if raw.trim_start().starts_with('{') && unicode_escape_error(&error) =>
                    {
                        *metadata = json!({});
                        deferred_metadata_json = Some(raw);
                    }
                    Err(error) => return Err(error),
                }
            }
            let mut request: Self = serde_json::from_value(value)?;
            request.deferred_metadata_json = deferred_metadata_json;
            request.metadata_serialization_failed = serialization_failed.is_some();
            request.input = input;
            request.input_missing |= missing;
            Ok(request)
        })
    }
}
fn unicode_escape_error(error: &serde_json::Error) -> bool {
    let message = error.to_string();
    message.starts_with("lone leading surrogate in hex escape")
        || message.starts_with("unexpected end of hex escape")
}

impl Drop for Request {
    fn drop(&mut self) {
        boundary::stack(|| drop(std::mem::take(&mut self.input)));
    }
}

pub async fn execute(pool: &PgPool, actor: &VerifiedActor, req: &Request) -> Result<String> {
    boundary::run(async {
        execute_inner(pool, actor, req)
            .await
            .map(|value| value.to_string())
    })
    .await
}

pub fn admit(req: &Request) -> Result<()> {
    boundary::stack(|| {
        let patch = validation::validate((!req.input_missing).then_some(&req.input))?;
        if text(&patch, "status") == "archived" {
            return Err(http(
                400,
                "Archive requests must use the Node archive authority",
            ));
        }
        Ok(())
    })
}

async fn execute_inner(pool: &PgPool, actor: &VerifiedActor, req: &Request) -> Result<Value> {
    let patch = validation::validate((!req.input_missing).then_some(&req.input))?;
    if text(&patch, "status") == "archived" {
        return Err(http(
            400,
            "Archive requests must use the Node archive authority",
        ));
    }
    let mut tx = pool.begin().await?;
    let before = workspace(&mut tx, &req.id)
        .await?
        .ok_or_else(|| http(404, "Run workspace not found"))?;
    authorize(&mut tx, actor, req, text(&before, "orgId")).await?;
    // The row lock serializes ordinary patches with every existing SQL writer.
    // Credentials and organization access are checked again after this wait.
    sqlx::query("SELECT id FROM execution_workspaces WHERE id=$1::uuid FOR UPDATE")
        .bind(&req.id)
        .execute(&mut *tx)
        .await?;
    let current = workspace(&mut tx, &req.id)
        .await?
        .ok_or_else(|| http(404, "Run workspace not found"))?;
    let org = text(&current, "orgId");
    authorize(&mut tx, actor, req, org).await?;
    // The signed host fact is specific to the legacy JSON.stringify failure.
    // Preserve target/access precedence and reject without any mutation.
    if req.metadata_serialization_failed {
        return Err(http(500, "Internal server error"));
    }
    let result = update(
        &mut tx,
        &req.id,
        &patch,
        req.deferred_metadata_json.as_deref(),
    )
    .await?;
    let details = json!({"changedKeys":patch.as_object().expect("validated patch").keys().collect::<Vec<_>>()});
    let audit = crate::activity::ActivityActor {
        actor_type: if actor.actor().kind == "agent" {
            "agent"
        } else {
            "user"
        },
        actor_id: actor.actor().id.clone(),
        run_id: req.actor_run_id.clone(),
    };
    crate::activity::write_activity_options(
        &mut tx,
        crate::activity::ActivityWrite {
            org,
            audit: &audit,
            action: "run_workspace.updated",
            entity_type: "run_workspace",
            entity_id: &req.id,
            details: Some(&details),
            options: crate::activity::ActivityOptions {
                agent_id: (actor.actor().kind == "agent").then_some(actor.actor().id.as_str()),
                bind_run: true,
                ..Default::default()
            },
        },
    )
    .await?;
    // Activity/outbox foreign-key locks can also wait. Expiry/revocation during
    // that wait rolls back both the patch and its audit.
    authorize(&mut tx, actor, req, org).await?;
    tx.commit().await?;
    Ok(result)
}

#[cfg(test)]
mod wire_tests {
    use super::*;
    fn command(metadata: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({"id":"synthetic", "input":{"metadata":null},
            "metadataJsonBase64":base64::engine::general_purpose::STANDARD.encode(metadata)}))
        .unwrap()
    }
    #[test]
    fn metadata_sidecar_preserves_valid_literals_and_js_numbers() {
        for raw in [
            "null",
            "{}",
            r#"{"value":"\\ud800","pair":"\ud83d\ude00","$serde_json::private::RawValue":"literal","number":9007199254740993}"#,
        ] {
            let req = Request::parse(&command(raw)).unwrap();
            assert!(req.deferred_metadata_json.is_none());
            assert_eq!(req.input["metadata"], boundary::parse(raw).unwrap());
            assert!(admit(&req).is_ok());
        }
        let direct = Request::parse(br#"{"id":"synthetic","input":{"metadata":null}}"#).unwrap();
        assert!(direct.input["metadata"].is_null());
    }
    #[test]
    fn only_unpaired_unicode_objects_are_deferred_to_postgres() {
        for raw in [
            r#"{"value":"\ud800"}"#,
            r#"{"value":"\udfff"}"#,
            r#"{"\ud800":"value"}"#,
            r#"{"value":"\ud800\u0041"}"#,
        ] {
            let req = Request::parse(&command(raw)).unwrap();
            assert_eq!(req.deferred_metadata_json.as_deref(), Some(raw));
            assert_eq!(req.input["metadata"], json!({}));
            assert!(admit(&req).is_ok());
        }
        for raw in [
            r#"{"value":"\ud800",}"#,
            r#"{"value":"\ud80x"}"#,
            r#"{"value":"\ud800"} trailing"#,
            "[]",
            "42",
            r#""\ud800""#,
        ] {
            assert!(Request::parse(&command(raw)).is_err(), "{raw}");
        }
    }
    #[test]
    fn sidecar_requires_exact_null_placeholder_and_valid_encoding() {
        for raw in [
            r#"{"id":"s","metadataJsonBase64":"e30="}"#,
            r#"{"id":"s","input":{},"metadataJsonBase64":"e30="}"#,
            r#"{"id":"s","input":{"metadata":{}},"metadataJsonBase64":"e30="}"#,
            r#"{"id":"s","input":{"metadata":null},"metadataJsonBase64":null}"#,
            r#"{"id":"s","input":{"metadata":null},"metadataJsonBase64":"invalid!"}"#,
            r#"{"id":"s","input":{"metadata":null},"metadataJsonBase64":"/w=="}"#,
            r#"{"id":"s","input":{"metadata":null},"deferredMetadataJson":"{}"}"#,
        ] {
            assert!(Request::parse(raw.as_bytes()).is_err(), "{raw}");
        }
    }
    #[test]
    fn serialization_failure_fact_requires_strict_exclusive_shape() {
        let raw = br#"{"id":"s","input":{"metadata":null},"metadataSerializationFailed":true}"#;
        let req = Request::parse(raw).unwrap();
        assert!(req.metadata_serialization_failed);
        assert!(req.deferred_metadata_json.is_none());
        assert!(admit(&req).is_ok());
        for raw in [
            r#"{"id":"s","input":{"metadata":null},"metadataSerializationFailed":false}"#,
            r#"{"id":"s","input":{"metadata":null},"metadataSerializationFailed":null}"#,
            r#"{"id":"s","input":{"metadata":null},"metadataSerializationFailed":"true"}"#,
            r#"{"id":"s","input":{"metadata":null},"metadataSerializationFailed":1}"#,
            r#"{"id":"s","input":{"metadata":{}},"metadataSerializationFailed":true}"#,
            r#"{"id":"s","input":{},"metadataSerializationFailed":true}"#,
            r#"{"id":"s","metadataSerializationFailed":true}"#,
            r#"{"id":"s","input":{"metadata":null},"metadataSerializationFailed":true,"metadataJsonBase64":"e30="}"#,
        ] {
            assert!(Request::parse(raw.as_bytes()).is_err(), "{raw}");
        }
    }

    #[test]
    fn depth_failures_are_never_deferred_as_database_errors() {
        boundary::stack(|| {
            for terminal in ["0", r#""\ud800""#] {
                let at_limit = format!(
                    "{{\"nested\":{}{terminal}{}}}",
                    "[".repeat(8191),
                    "]".repeat(8191)
                );
                let req = Request::parse(&command(&at_limit)).unwrap();
                assert_eq!(req.deferred_metadata_json.is_some(), terminal != "0");
                let over_limit = format!(
                    "{{\"nested\":{}{terminal}{}}}",
                    "[".repeat(8192),
                    "]".repeat(8192)
                );
                assert!(Request::parse(&command(&over_limit)).is_err());
            }
        });
    }
}
