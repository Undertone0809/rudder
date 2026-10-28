//! Label CRUD and its transactional activity/outbox receipts.
use crate::activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_options};
use crate::agent_core::{NativeAgentAccess, NativeAgentAuthorizer};
use serde_json::{Value, json};
use sqlx::PgPool;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Create,
    Update,
    Delete,
}
pub struct Audit {
    pub actor_type: &'static str,
    pub actor_id: String,
    pub run_id: Option<String>,
}
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{1}")]
    Http(u16, String),
    #[error("Validation error")]
    Validation(Vec<Value>),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
fn http(status: u16, message: impl Into<String>) -> Error {
    Error::Http(status, message.into())
}

#[derive(Debug, PartialEq, Eq)]
struct Input {
    name: Option<String>,
    color: Option<String>,
}
fn kind(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}
fn type_issue(value: Option<&Value>, expected: &str, path: Value) -> Value {
    let received = kind(value);
    json!({"code":"invalid_type","expected":expected,"received":received,"path":path,
        "message":if received=="undefined" {"Required".to_owned()}else{format!("Expected {expected}, received {received}")}})
}
fn trim(value: &str) -> &str {
    value.trim_matches(|c| matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}
fn validate(body: Option<&Value>, partial: bool) -> Result<Input, Error> {
    let Some(value) = body.and_then(Value::as_object) else {
        return Err(Error::Validation(vec![type_issue(
            body,
            "object",
            json!([]),
        )]));
    };
    let mut issues = Vec::new();
    let mut name = None;
    let mut color = None;
    for key in ["name", "color"] {
        let raw = value.get(key);
        if partial && raw.is_none() {
            continue;
        }
        let Some(raw) = raw.and_then(Value::as_str) else {
            issues.push(type_issue(raw, "string", json!([key])));
            continue;
        };
        if key == "name" {
            let value = trim(raw).to_owned();
            let length = value.encode_utf16().count();
            if length < 1 {
                issues.push(json!({"code":"too_small","minimum":1,"type":"string","inclusive":true,"exact":false,"message":"String must contain at least 1 character(s)","path":[key]}));
            }
            if length > 48 {
                issues.push(json!({"code":"too_big","maximum":48,"type":"string","inclusive":true,"exact":false,"message":"String must contain at most 48 character(s)","path":[key]}));
            }
            name = Some(value);
        } else {
            if raw.len() != 7
                || !raw.starts_with('#')
                || !raw.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
            {
                issues.push(json!({"validation":"regex","code":"invalid_string","message":"Color must be a 6-digit hex value","path":[key]}));
            }
            color = Some(raw.to_owned());
        }
    }
    if partial && name.is_none() && color.is_none() && issues.is_empty() {
        issues.push(json!({"code":"custom","message":"At least one label field must be provided","path":[]}));
    }
    if issues.is_empty() {
        Ok(Input { name, color })
    } else {
        Err(Error::Validation(issues))
    }
}

pub fn validate_public(body: Option<&Value>, operation: Operation) -> Result<(), Error> {
    if operation != Operation::Delete {
        let _ = validate(body, operation == Operation::Update)?;
    }
    Ok(())
}

pub async fn organization_for_label(pool: &PgPool, id: &str) -> Result<Option<String>, Error> {
    Ok(
        sqlx::query_scalar("SELECT org_id::text FROM labels WHERE id=$1::uuid")
            .bind(id)
            .fetch_optional(pool)
            .await?,
    )
}

pub struct Write<'a> {
    pub org_id: &'a str,
    pub label_id: Option<&'a str>,
    pub operation: Operation,
    pub body: Option<&'a Value>,
    pub audit: &'a Audit,
    pub authorizer: &'a dyn NativeAgentAuthorizer,
}
pub async fn execute(pool: &PgPool, write: Write<'_>) -> Result<(u16, Value), Error> {
    let Write {
        org_id,
        label_id,
        operation,
        body,
        audit,
        authorizer,
    } = write;
    let input = if operation == Operation::Delete {
        Input {
            name: None,
            color: None,
        }
    } else {
        validate(body, operation == Operation::Update)?
    };
    let mut tx = pool.begin().await?;
    sqlx::query("SET LOCAL TIME ZONE 'UTC'")
        .execute(&mut *tx)
        .await?;
    let projection = crate::approval_reads::projection("labels");
    let before = if operation != Operation::Create {
        let sql = format!(
            "SELECT {projection}::text FROM labels t WHERE t.org_id=$1::uuid AND t.id=$2::uuid FOR UPDATE"
        );
        let row: Option<String> = sqlx::query_scalar(&sql)
            .bind(org_id)
            .bind(label_id)
            .fetch_optional(&mut *tx)
            .await?;
        Some(serde_json::from_str::<Value>(
            &row.ok_or_else(|| http(404, "Label not found"))?,
        )?)
    } else {
        None
    };
    match authorizer.revalidate(&mut tx, org_id).await? {
        NativeAgentAccess::Authorized => {}
        NativeAgentAccess::Unauthorized => return Err(http(401, "Unauthorized")),
        NativeAgentAccess::Forbidden => {
            return Err(http(
                403,
                if audit.actor_type == "agent" {
                    "Agent key cannot access another organization"
                } else {
                    "User does not have access to this organization"
                },
            ));
        }
    }
    let result:Result<String,sqlx::Error>=match operation {
        Operation::Create=>sqlx::query_scalar("INSERT INTO labels(org_id,name,color) VALUES($1::uuid,$2,$3) RETURNING id::text")
            .bind(org_id).bind(&input.name).bind(&input.color).fetch_one(&mut *tx).await,
        Operation::Update=>sqlx::query_scalar("UPDATE labels SET name=COALESCE($3,name),color=COALESCE($4,color),updated_at=now() WHERE org_id=$1::uuid AND id=$2::uuid RETURNING id::text")
            .bind(org_id).bind(label_id).bind(&input.name).bind(&input.color).fetch_one(&mut *tx).await,
        Operation::Delete=>sqlx::query_scalar("DELETE FROM labels WHERE org_id=$1::uuid AND id=$2::uuid RETURNING id::text")
            .bind(org_id).bind(label_id).fetch_one(&mut *tx).await,
    };
    let id = match result {
        Ok(id) => id,
        Err(sqlx::Error::Database(error))
            if error.constraint() == Some("labels_company_name_idx") =>
        {
            let name = input
                .name
                .as_deref()
                .or_else(|| before.as_ref().and_then(|v| v["name"].as_str()))
                .unwrap_or("");
            return Err(http(409, format!("Label already exists: {name}")));
        }
        Err(error) => return Err(error.into()),
    };
    let value = if operation == Operation::Delete {
        before.unwrap()
    } else {
        let sql = format!(
            "SELECT {projection}::text FROM labels t WHERE t.org_id=$1::uuid AND t.id=$2::uuid"
        );
        let row: String = sqlx::query_scalar(&sql)
            .bind(org_id)
            .bind(&id)
            .fetch_one(&mut *tx)
            .await?;
        serde_json::from_str::<Value>(&row)?
    };
    let action = match operation {
        Operation::Create => "label.created",
        Operation::Update => "label.updated",
        Operation::Delete => "label.deleted",
    };
    let actor = ActivityActor {
        actor_type: audit.actor_type,
        actor_id: audit.actor_id.clone(),
        run_id: audit.run_id.clone(),
    };
    write_activity_options(
        &mut tx,
        ActivityWrite {
            org: org_id,
            audit: &actor,
            action,
            entity_type: "label",
            entity_id: &id,
            details: Some(&json!({"name":value["name"],"color":value["color"]})),
            options: ActivityOptions {
                agent_id: (audit.actor_type == "agent").then_some(audit.actor_id.as_str()),
                bind_run: true,
                effects: None,
            },
        },
    )
    .await?;
    tx.commit().await?;
    Ok((
        if operation == Operation::Create {
            201
        } else {
            200
        },
        value,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_the_actual_shared_zod_validation_and_normalization_corpus() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("label_writes-validation-cases.json")).unwrap();
        for case in cases {
            match validate(case.get("input"), case["operation"] == "update") {
                Ok(input) => {
                    let mut output = serde_json::Map::new();
                    if let Some(name) = input.name {
                        output.insert("name".into(), json!(name));
                    }
                    if let Some(color) = input.color {
                        output.insert("color".into(), json!(color));
                    }
                    assert_eq!(Value::Object(output), case["output"], "{case}");
                }
                Err(Error::Validation(issues)) => {
                    assert_eq!(json!(issues), case["issues"], "{case}");
                }
                Err(error) => panic!("unexpected validator error {error}: {case}"),
            }
        }
    }
    #[test]
    fn normalizes_only_declared_fields_and_preserves_color_case() {
        assert_eq!(
            validate(
                Some(&json!({"name":" \u{feff}Roadmap \n","color":"#aB10Ef","unknown":true})),
                false
            )
            .unwrap(),
            Input {
                name: Some("Roadmap".into()),
                color: Some("#aB10Ef".into())
            }
        );
        assert!(matches!(
            validate(Some(&json!({"unknown":1})), true),
            Err(Error::Validation(_))
        ));
        assert!(
            validate(
                Some(&json!({"name":"x".repeat(48),"color":"#123456"})),
                false
            )
            .is_ok()
        );
        assert!(
            validate(
                Some(&json!({"name":"😀".repeat(25),"color":"#123456"})),
                false
            )
            .is_err()
        );
    }
}
