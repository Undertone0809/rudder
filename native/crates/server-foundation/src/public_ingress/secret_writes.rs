//! The four public Secret writes reuse D1 CRUD, encryption and atomic receipts.
//! Native identity and organization authorization never depend on Node adapters.
use super::*;
use crate::native_session_auth::NativeIngressIdentity;
use actix_web::http::Method;
use futures_util::StreamExt;
use rudder_d1_persistence::secrets::{
    SecretsError, database_unavailable, execute_secrets_for_actor,
};
use serde::Deserializer as _;
use serde_json::{Value, json};
use std::env;

const PROVIDERS: &[&str] = &[
    "local_encrypted",
    "aws_secrets_manager",
    "gcp_secret_manager",
    "vault",
];

#[derive(Clone, Debug, PartialEq, Eq)]
enum Endpoint {
    Create(String),
    Rotate(String),
    Update(String),
    Delete(String),
}
impl Endpoint {
    fn operation(&self) -> &'static str {
        match self {
            Self::Create(_) => "create",
            Self::Rotate(_) => "rotate",
            Self::Update(_) => "update",
            Self::Delete(_) => "delete",
        }
    }
}

pub(super) fn is_reserved_path(path: &str, method: &Method) -> bool {
    endpoint_for_path(path, method).is_some()
}
fn endpoint_for_path(path: &str, method: &Method) -> Option<Endpoint> {
    let path = path.strip_prefix('/')?;
    let parts: Vec<_> = path.strip_suffix('/').unwrap_or(path).split('/').collect();
    if parts.iter().any(|p| p.is_empty()) || !parts.first()?.eq_ignore_ascii_case("api") {
        return None;
    }
    let capture = |value: &str| {
        percent_encoding::percent_decode_str(value)
            .decode_utf8_lossy()
            .into_owned()
    };
    match parts.as_slice() {
        [_, orgs, org, secrets]
            if orgs.eq_ignore_ascii_case("orgs")
                && secrets.eq_ignore_ascii_case("secrets")
                && *method == Method::POST =>
        {
            Some(Endpoint::Create(capture(org)))
        }
        [_, secrets, id, rotate]
            if secrets.eq_ignore_ascii_case("secrets")
                && rotate.eq_ignore_ascii_case("rotate")
                && *method == Method::POST =>
        {
            Some(Endpoint::Rotate(capture(id)))
        }
        [_, secrets, id] if secrets.eq_ignore_ascii_case("secrets") => match *method {
            Method::PATCH => Some(Endpoint::Update(capture(id))),
            Method::DELETE => Some(Endpoint::Delete(capture(id))),
            _ => None,
        },
        _ => None,
    }
}

pub(super) async fn dispatch_alias(
    state: web::Data<IngressState>,
    request: HttpRequest,
    mut payload: web::Payload,
) -> HttpResponse {
    let Some(endpoint) = endpoint_for_path(request.uri().path(), request.method()) else {
        return error(404, "Secret not found");
    };
    let mut body = Vec::new();
    while let Some(chunk) = payload.next().await {
        let Ok(chunk) = chunk else {
            return error(400, "Invalid request body");
        };
        if body.len().saturating_add(chunk.len())
            > state
                .foundation
                .config
                .max_request_bytes
                .min(10 * 1024 * 1024)
        {
            return error(413, "Request body too large");
        }
        body.extend_from_slice(&chunk);
    }
    if let Some(response) = malformed_public_json_response(&request, &body) {
        return response;
    }
    if let Some(response) = private_host_rejection(&state, &request) {
        return response;
    }
    let json_body = if request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .eq_ignore_ascii_case("application/json")
        })
        && !body.is_empty()
    {
        match serde_json::from_slice::<Value>(&body) {
            Ok(value) => value,
            Err(_) => return error(500, "Internal server error"),
        }
    } else {
        json!({})
    };
    // Express validates these bodies before assertBoard and Secret lookup.
    let input = match normalize_body(&endpoint, json_body, &body_keys(&body)) {
        Ok(value) => value,
        Err(details) => {
            return HttpResponse::BadRequest()
                .json(json!({"error":"Validation error","details":details}));
        }
    };
    if state.config.forwarding_policy.identity(&request).is_err() {
        return state
            .foundation
            .json_error(StatusCode::BAD_REQUEST, "invalid_forwarding_identity");
    }
    if state.config.identity_auth.is_none() {
        return error(503, "Rust Secrets is unavailable");
    }
    let identity = match resolve_public_http_identity(&state, &request).await {
        Ok(identity) => identity,
        Err((status, code)) => return state.foundation.json_error(status, code),
    };
    if let Some(response) = agent_run_context_mismatch_response(&request, &identity) {
        return response;
    }
    let Some((actor, session_id)) = agent_core::actor_and_session(&identity) else {
        return error(403, "Board access required");
    };
    if actor.kind != "user" {
        return error(403, "Board access required");
    }
    if matches!(&identity, NativeIngressIdentity::Session(_))
        && !crate::local_account_ingress::has_trusted_board_origin(&request)
    {
        return error(403, crate::local_account_ingress::BOARD_ORIGIN_ERROR);
    }
    let Some(authorizer) = agent_core::native_authorizer(&identity, &actor, &session_id, &state)
    else {
        return error(401, "Unauthorized");
    };
    let _permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(_) => {
            return state
                .foundation
                .json_error(StatusCode::SERVICE_UNAVAILABLE, "request_queue_full");
        }
    };
    let DatabaseState::Configured(pool) = &state.foundation.database else {
        return error(503, "Rust Secrets is unavailable");
    };
    let (organization_id, command) = match endpoint {
        Endpoint::Create(org) => (org, json!({"operation":"create","input":input})),
        endpoint => {
            let id = match &endpoint {
                Endpoint::Rotate(id) | Endpoint::Update(id) | Endpoint::Delete(id) => id,
                Endpoint::Create(_) => unreachable!(),
            };
            // Preserve the legacy PostgreSQL UUID lookup failure; missing or
            // managed secrets are 404 before organization permission checks.
            if Uuid::parse_str(id).is_err() {
                return error(500, "Internal server error");
            }
            let org = match sqlx::query_scalar::<_, String>("SELECT org_id::text FROM organization_secrets WHERE id=$1::uuid AND purpose='user_managed'").bind(id).fetch_optional(pool).await {
                Ok(Some(org)) => org,
                Ok(None) => return error(404, "Secret not found"),
                Err(e) if database_unavailable(&e) => return error(503, "Rust Secrets is unavailable"),
                Err(_) => return error(500, "Internal server error"),
            };
            let mut command = json!({"operation":endpoint.operation(),"id":id});
            if !matches!(endpoint, Endpoint::Delete(_)) {
                command["input"] = input;
            }
            (org, command)
        }
    };
    match execute_secrets_for_actor(pool, &organization_id, &actor.id, &command, &authorizer).await
    {
        Ok((status, value)) => HttpResponse::build(
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        )
        .json(value),
        Err(SecretsError::Http(status, message)) => error(status, &message),
        Err(SecretsError::Database(e)) if database_unavailable(&e) => {
            error(503, "Rust Secrets is unavailable")
        }
        Err(SecretsError::Database(_)) => error(500, "Internal server error"),
    }
}

fn error(status: u16, message: &str) -> HttpResponse {
    HttpResponse::build(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .json(json!({"error":message}))
}
fn received(value: Option<&Value>) -> &'static str {
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
fn invalid_type(expected: &str, value: Option<&Value>, path: Value) -> Value {
    let received = received(value);
    json!({"code":"invalid_type","expected":expected,"received":received,"path":path,"message":if received=="undefined" {"Required".to_owned()} else {format!("Expected {expected}, received {received}")}})
}
// Zod reports unknown keys in JavaScript object enumeration order. Retain
// that small piece of wire metadata separately from serde_json's sorted map.
fn body_keys(raw: &[u8]) -> Vec<String> {
    struct Keys;
    impl<'de> serde::de::Visitor<'de> for Keys {
        type Value = Vec<String>;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("a JSON object")
        }
        fn visit_map<A: serde::de::MapAccess<'de>>(
            self,
            mut map: A,
        ) -> Result<Self::Value, A::Error> {
            let mut keys = Vec::new();
            while let Some((key, _)) = map.next_entry::<String, serde::de::IgnoredAny>()? {
                if !keys.contains(&key) {
                    keys.push(key);
                }
            }
            let index = |key: &str| {
                key.parse::<u32>()
                    .ok()
                    .filter(|n| *n < u32::MAX && n.to_string() == key)
            };
            keys.sort_by_key(|key| index(key).map_or((1, 0), |n| (0, n)));
            Ok(keys)
        }
    }
    serde_json::Deserializer::from_slice(raw)
        .deserialize_map(Keys)
        .unwrap_or_default()
}

fn normalize_body(
    endpoint: &Endpoint,
    mut body: Value,
    keys: &[String],
) -> Result<Value, Vec<Value>> {
    if matches!(endpoint, Endpoint::Delete(_)) {
        return Ok(json!({}));
    }
    let Some(fields) = body.as_object_mut() else {
        return Err(vec![invalid_type("object", Some(&body), json!([]))]);
    };
    let names: &[&str] = match endpoint {
        Endpoint::Create(_) => &["name", "provider", "value", "description", "externalRef"],
        Endpoint::Rotate(_) => &["value", "externalRef"],
        Endpoint::Update(_) => &["name", "description", "externalRef"],
        Endpoint::Delete(_) => unreachable!(),
    };
    let mut issues = Vec::new();
    for key in names {
        let value = fields.get(*key);
        let required =
            (*key == "name" && matches!(endpoint, Endpoint::Create(_))) || *key == "value";
        if value.is_none() && !required {
            continue;
        }
        if *key == "provider" {
            if let Some(Value::String(provider)) = value {
                if !PROVIDERS.contains(&provider.as_str()) {
                    issues.push(json!({"received":provider,"code":"invalid_enum_value","options":PROVIDERS,"path":[key],"message":format!("Invalid enum value. Expected 'local_encrypted' | 'aws_secrets_manager' | 'gcp_secret_manager' | 'vault', received '{provider}'")}));
                }
            } else {
                issues.push(invalid_type(
                    "'local_encrypted' | 'aws_secrets_manager' | 'gcp_secret_manager' | 'vault'",
                    value,
                    json!([key]),
                ));
            }
        } else if matches!(*key, "description" | "externalRef") && value.is_some_and(Value::is_null)
        {
            continue;
        } else if let Some(Value::String(text)) = value {
            if text.is_empty() && matches!(*key, "name" | "value") {
                issues.push(json!({"code":"too_small","minimum":1,"type":"string","inclusive":true,"exact":false,"message":"String must contain at least 1 character(s)","path":[key]}));
            }
        } else {
            issues.push(invalid_type("string", value, json!([key])));
        }
    }
    let unknown: Vec<_> = if keys.is_empty() {
        fields
            .keys()
            .filter(|key| !names.contains(&key.as_str()))
            .cloned()
            .collect()
    } else {
        keys.iter()
            .filter(|key| !names.contains(&key.as_str()))
            .cloned()
            .collect()
    };
    if !unknown.is_empty() {
        issues.push(json!({"code":"unrecognized_keys","keys":unknown,"path":[],"message":format!("Unrecognized key(s) in object: {}",unknown.iter().map(|key|format!("'{key}'")).collect::<Vec<_>>().join(", "))}));
    }
    if !issues.is_empty() {
        return Err(issues);
    }
    if matches!(endpoint, Endpoint::Create(_)) && !fields.contains_key("provider") {
        let configured = env::var("RUDDER_SECRETS_PROVIDER").ok();
        fields.insert(
            "provider".to_owned(),
            Value::String(default_provider(configured.as_deref()).to_owned()),
        );
    }
    Ok(body)
}

fn default_provider(configured: Option<&str>) -> &str {
    configured
        .filter(|provider| PROVIDERS.contains(provider))
        .unwrap_or("local_encrypted")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reserves_only_the_four_write_shapes_including_express_aliases() {
        for (path, method) in [
            ("/api/orgs/o/secrets", Method::POST),
            ("/API/SECRETS/s/ROTATE/", Method::POST),
            ("/api/secrets/s", Method::PATCH),
            ("/api/secrets/s/", Method::DELETE),
        ] {
            assert!(is_reserved_path(path, &method));
        }
        for (path, method) in [
            ("/api/orgs/o/secrets", Method::GET),
            ("/api/orgs/o/secret-providers", Method::GET),
            ("/api/secrets/s", Method::GET),
            ("/api/secrets/s/rotate", Method::PATCH),
            ("/api/secrets/s/resolve", Method::POST),
        ] {
            assert!(!is_reserved_path(path, &method));
        }
    }
    #[test]
    fn default_provider_retains_the_existing_environment_rules() {
        for value in [None, Some(""), Some("bogus"), Some(" vault ")] {
            assert_eq!(default_provider(value), "local_encrypted");
        }
        for provider in PROVIDERS {
            assert_eq!(default_provider(Some(provider)), *provider);
        }
    }
    #[test]
    fn public_validation_details_match_the_existing_zod_schemas() {
        let cases: Value =
            serde_json::from_str(include_str!("secret_writes/validation-cases.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let endpoint = match case["operation"].as_str().unwrap() {
                "create" => Endpoint::Create("org".to_owned()),
                "rotate" => Endpoint::Rotate("id".to_owned()),
                _ => Endpoint::Update("id".to_owned()),
            };
            let raw = case["rawBody"].as_str().unwrap();
            let body = serde_json::from_str(raw).unwrap();
            assert_eq!(
                normalize_body(&endpoint, body, &body_keys(raw.as_bytes())).unwrap_err(),
                *case["issues"].as_array().unwrap()
            );
        }
    }
    #[test]
    fn keeps_strict_zod_fields_and_validation_order() {
        let issues = normalize_body(
            &Endpoint::Create("org".to_owned()),
            json!({"name":"","value":3,"extra":true}),
            &[],
        )
        .unwrap_err();
        assert_eq!(issues.len(), 3);
        assert_eq!(issues[0]["code"], "too_small");
        assert_eq!(
            issues[1],
            invalid_type("string", Some(&json!(3)), json!(["value"]))
        );
        assert_eq!(issues[2]["keys"], json!(["extra"]));
        assert!(normalize_body(&Endpoint::Update("id".to_owned()), json!({}), &[]).is_ok());
        assert!(normalize_body(&Endpoint::Delete("id".to_owned()), json!([1, 2]), &[]).is_ok());
    }
}

#[cfg(test)]
#[path = "secret_writes/http_tests.rs"]
mod http_tests;
