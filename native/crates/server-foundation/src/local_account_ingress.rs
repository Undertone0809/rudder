//! Native HTTP transport for the four Local Account lifecycle endpoints.
//!
//! The public ingress owns these paths as soon as they are enabled. They must
//! never fall back to the private Node lifecycle router after a native error.

use crate::local_account_auth::{
    LocalAccountAuthError, LocalAccountForbiddenReason, LocalOfflineGrantRequest,
    LocalServerExchangeRequest,
};
use crate::native_session_auth::{
    NativeIngressIdentity, NativeSessionResolution, has_session_cookie,
};
use crate::public_ingress::IngressState;
use crate::public_ingress_config::NativeSessionAuthKind;
use actix_web::{
    HttpRequest, HttpResponse,
    http::{Method, StatusCode, header},
    web,
};
use futures_util::StreamExt;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use url::Url;

const MAX_LOCAL_ACCOUNT_BODY_BYTES: usize = 256 * 1024;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const SESSION_REQUIRED_ERROR: &str = "Rudder Account session required";
const BOARD_ORIGIN_ERROR: &str = "Board mutation requires trusted browser origin";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum LocalAccountEndpoint {
    Exchange,
    Offline,
    Claim,
    SignoutAll,
}

pub(super) fn endpoint_for_path(path: &str) -> Option<LocalAccountEndpoint> {
    let path = path.strip_suffix('/').unwrap_or(path);
    if path.eq_ignore_ascii_case("/api/auth/local-exchange") {
        Some(LocalAccountEndpoint::Exchange)
    } else if path.eq_ignore_ascii_case("/api/auth/local-offline") {
        Some(LocalAccountEndpoint::Offline)
    } else if path.eq_ignore_ascii_case("/api/auth/local-claim") {
        Some(LocalAccountEndpoint::Claim)
    } else if path.eq_ignore_ascii_case("/api/auth/local-signout-all") {
        Some(LocalAccountEndpoint::SignoutAll)
    } else {
        None
    }
}

pub(super) async fn local_exchange(
    state: web::Data<IngressState>,
    request: HttpRequest,
    payload: web::Payload,
) -> HttpResponse {
    handle(state, request, payload, LocalAccountEndpoint::Exchange).await
}

pub(super) async fn local_offline(
    state: web::Data<IngressState>,
    request: HttpRequest,
    payload: web::Payload,
) -> HttpResponse {
    handle(state, request, payload, LocalAccountEndpoint::Offline).await
}

pub(super) async fn local_claim(
    state: web::Data<IngressState>,
    request: HttpRequest,
    payload: web::Payload,
) -> HttpResponse {
    handle(state, request, payload, LocalAccountEndpoint::Claim).await
}

pub(super) async fn local_signout_all(
    state: web::Data<IngressState>,
    request: HttpRequest,
    payload: web::Payload,
) -> HttpResponse {
    handle(state, request, payload, LocalAccountEndpoint::SignoutAll).await
}

pub(super) async fn handle(
    state: web::Data<IngressState>,
    request: HttpRequest,
    payload: web::Payload,
    endpoint: LocalAccountEndpoint,
) -> HttpResponse {
    if request.method() != Method::POST {
        return method_not_allowed();
    }

    let body = match read_limited_body(&request, payload).await {
        Ok(body) => body,
        Err(BodyReadError::TooLarge) => {
            return api_error(StatusCode::PAYLOAD_TOO_LARGE, "Payload too large");
        }
        Err(BodyReadError::Invalid) => return validation_error(),
    };

    let Some(service) = state.local_account.as_ref() else {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Service temporarily unavailable",
        );
    };
    if let Some(response) = enforce_agent_context_if_present(&state, &request).await {
        return response;
    }

    match endpoint {
        LocalAccountEndpoint::Exchange => {
            let input = match parse_json::<LocalServerExchangeRequest>(
                &request,
                &body,
                validate_exchange_schema,
                normalize_json_noop,
            ) {
                Ok(input) => input,
                Err(issues) => return validation_error_with(issues),
            };
            if let Some(response) = enforce_selected_session_origin(&state, &request).await {
                return response;
            }
            match service.redeem_exchange(&input.exchange_code).await {
                Ok(result) => HttpResponse::Ok()
                    .insert_header((header::SET_COOKIE, result.session.set_cookie))
                    .json(json!({
                        "userId": result.user_id,
                        "session": {
                            "id": result.session.id,
                            "expiresAt": result.session.expires_at,
                        },
                    })),
                Err(error) => service_error(error, endpoint),
            }
        }
        LocalAccountEndpoint::Offline => {
            let input = match parse_json::<LocalOfflineGrantRequest>(
                &request,
                &body,
                validate_offline_schema,
                normalize_offline_schema,
            ) {
                Ok(input) => input,
                Err(issues) => return validation_error_with(issues),
            };
            if let Some(response) = enforce_selected_session_origin(&state, &request).await {
                return response;
            }
            match service.redeem_offline(input).await {
                Ok(result) => HttpResponse::Ok()
                    .insert_header((header::SET_COOKIE, result.session.set_cookie))
                    .json(json!({
                        "userId": result.user_id,
                        "nextTrustedTimeMs": result.next_trusted_time_ms,
                        "session": {
                            "id": result.session.id,
                            "expiresAt": result.session.expires_at,
                        },
                    })),
                Err(error) => service_error(error, endpoint),
            }
        }
        LocalAccountEndpoint::Claim => {
            if !valid_ignored_json_body(&request, &body) {
                return validation_error();
            }
            let (user_id, requires_origin) =
                match require_local_board_identity(&state, &request).await {
                    Ok(identity) => identity,
                    Err(response) => return response,
                };
            if requires_origin && !has_trusted_board_origin(&request) {
                return api_error(StatusCode::FORBIDDEN, BOARD_ORIGIN_ERROR);
            }
            match service.claim_legacy_installation(&user_id).await {
                Ok(result) => HttpResponse::Ok().json(result),
                Err(error) => service_error(error, endpoint),
            }
        }
        LocalAccountEndpoint::SignoutAll => {
            if !valid_ignored_json_body(&request, &body) {
                return validation_error();
            }
            let (user_id, requires_origin) =
                match require_local_board_identity(&state, &request).await {
                    Ok(identity) => identity,
                    Err(response) => return response,
                };
            if requires_origin && !has_trusted_board_origin(&request) {
                return api_error(StatusCode::FORBIDDEN, BOARD_ORIGIN_ERROR);
            }
            match service
                .revoke_all_sessions_owned(user_id, state.foundation.session_revocation.clone())
                .await
            {
                Ok(result) => HttpResponse::Ok().json(json!({
                    "revokedSessionCount": result.revoked_session_count,
                })),
                Err(error) => service_error(error, endpoint),
            }
        }
    }
}

async fn read_limited_body(
    request: &HttpRequest,
    mut payload: web::Payload,
) -> Result<Vec<u8>, BodyReadError> {
    if request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_LOCAL_ACCOUNT_BODY_BYTES)
    {
        return Err(BodyReadError::TooLarge);
    }

    let mut body = Vec::new();
    while let Some(chunk) = payload.next().await {
        let chunk = chunk.map_err(|_| BodyReadError::Invalid)?;
        if body.len().saturating_add(chunk.len()) > MAX_LOCAL_ACCOUNT_BODY_BYTES {
            return Err(BodyReadError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BodyReadError {
    Invalid,
    TooLarge,
}

fn parse_json<T: DeserializeOwned>(
    request: &HttpRequest,
    body: &[u8],
    validate: fn(&Value) -> Vec<Value>,
    normalize: fn(&mut Value),
) -> Result<T, Vec<Value>> {
    let mut value = parse_json_value(request, body)?;
    let issues = validate(&value);
    if !issues.is_empty() {
        return Err(issues);
    }
    normalize(&mut value);
    serde_json::from_value(value).map_err(|_| invalid_json_issues())
}

fn normalize_json_noop(_: &mut Value) {}

fn normalize_offline_schema(value: &mut Value) {
    if let Some(version) = value
        .get_mut("proof")
        .and_then(Value::as_object_mut)
        .and_then(|proof| proof.get_mut("payload"))
        .and_then(Value::as_object_mut)
        .and_then(|payload| payload.get_mut("version"))
        && version.as_f64().is_some_and(|number| number == 1.0)
    {
        *version = Value::Number(1.into());
    }

    let Some(number) = value
        .get_mut("proof")
        .and_then(Value::as_object_mut)
        .and_then(|proof| proof.get_mut("payload"))
        .and_then(Value::as_object_mut)
        .and_then(|payload| payload.get_mut("issuedAtMs"))
        .and_then(|issued_at_ms| issued_at_ms.as_f64())
    else {
        return;
    };
    if number.fract() == 0.0
        && (-MAX_SAFE_INTEGER as f64..=MAX_SAFE_INTEGER as f64).contains(&number)
    {
        let normalized = number as i64;
        if let Some(issued_at_ms) = value
            .get_mut("proof")
            .and_then(Value::as_object_mut)
            .and_then(|proof| proof.get_mut("payload"))
            .and_then(Value::as_object_mut)
            .and_then(|payload| payload.get_mut("issuedAtMs"))
        {
            *issued_at_ms = Value::Number(normalized.into());
        }
    }
}

fn parse_json_value(request: &HttpRequest, body: &[u8]) -> Result<Value, Vec<Value>> {
    if !is_json_content_type(request) {
        return Err(vec![invalid_type_issue(&[], "object", "undefined")]);
    }
    // Express/body-parser turns an empty JSON body into an empty object before
    // the route's Zod schema sees it.
    if body.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(body).map_err(|_| invalid_json_issues())
}

fn validate_exchange_schema(value: &Value) -> Vec<Value> {
    let mut issues = Vec::new();
    let Some(object) = zod_object(Some(value), &[], &mut issues) else {
        return issues;
    };
    validate_string_field(object, "exchangeCode", &[], 16, 16_384, &mut issues);
    add_unknown_key_issue(object, &["exchangeCode"], &[], &mut issues);
    issues
}

fn validate_offline_schema(value: &Value) -> Vec<Value> {
    let mut issues = Vec::new();
    let Some(root) = zod_object(Some(value), &[], &mut issues) else {
        return issues;
    };
    validate_string_field(root, "grant", &[], 32, 32_768, &mut issues);
    validate_string_field(root, "devicePublicKeySpki", &[], 32, 4_096, &mut issues);

    if let Some(proof) = zod_object(root.get("proof"), &["proof"], &mut issues) {
        if let Some(payload) = zod_object(proof.get("payload"), &["proof", "payload"], &mut issues)
        {
            validate_literal_one(payload, &["proof", "payload"], "version", &mut issues);
            validate_string_field(
                payload,
                "grantHash",
                &["proof", "payload"],
                16,
                128,
                &mut issues,
            );
            validate_string_field(payload, "method", &["proof", "payload"], 1, 16, &mut issues);
            validate_string_field(
                payload,
                "path",
                &["proof", "payload"],
                1,
                2_048,
                &mut issues,
            );
            validate_string_field(
                payload,
                "bodyHash",
                &["proof", "payload"],
                1,
                128,
                &mut issues,
            );
            validate_string_field(
                payload,
                "nonce",
                &["proof", "payload"],
                16,
                256,
                &mut issues,
            );
            validate_safe_integer_field(payload, &["proof", "payload"], "issuedAtMs", &mut issues);
            add_unknown_key_issue(
                payload,
                &[
                    "version",
                    "grantHash",
                    "method",
                    "path",
                    "bodyHash",
                    "nonce",
                    "issuedAtMs",
                ],
                &["proof", "payload"],
                &mut issues,
            );
        }
        validate_string_field(proof, "signature", &["proof"], 16, 1_024, &mut issues);
        add_unknown_key_issue(proof, &["payload", "signature"], &["proof"], &mut issues);
    }
    add_unknown_key_issue(
        root,
        &["grant", "devicePublicKeySpki", "proof"],
        &[],
        &mut issues,
    );
    issues
}

fn zod_object<'a>(
    value: Option<&'a Value>,
    path: &[&str],
    issues: &mut Vec<Value>,
) -> Option<&'a serde_json::Map<String, Value>> {
    match value {
        Some(Value::Object(object)) => Some(object),
        other => {
            issues.push(invalid_type_issue(path, "object", zod_received_type(other)));
            None
        }
    }
}

fn validate_string_field(
    object: &serde_json::Map<String, Value>,
    key: &'static str,
    prefix: &[&str],
    minimum: usize,
    maximum: usize,
    issues: &mut Vec<Value>,
) {
    let mut path = prefix.to_vec();
    path.push(key);
    let value = object.get(key);
    let Some(Value::String(value)) = value else {
        issues.push(invalid_type_issue(
            &path,
            "string",
            zod_received_type(value),
        ));
        return;
    };
    let length = js_string_length(value);
    if length < minimum {
        issues.push(json!({
            "code": "too_small",
            "minimum": minimum,
            "type": "string",
            "inclusive": true,
            "exact": false,
            "path": path,
            "message": format!("String must contain at least {minimum} character(s)"),
        }));
    } else if length > maximum {
        issues.push(json!({
            "code": "too_big",
            "maximum": maximum,
            "type": "string",
            "inclusive": true,
            "exact": false,
            "path": path,
            "message": format!("String must contain at most {maximum} character(s)"),
        }));
    }
}

fn validate_literal_one(
    object: &serde_json::Map<String, Value>,
    prefix: &[&str],
    key: &'static str,
    issues: &mut Vec<Value>,
) {
    let received = object.get(key);
    if received
        .and_then(Value::as_f64)
        .is_some_and(|value| value == 1.0)
    {
        return;
    }
    let mut path = prefix.to_vec();
    path.push(key);
    let mut issue = json!({
        "code": "invalid_literal",
        "expected": 1,
        "path": path,
        "message": "Invalid literal value, expected 1",
    });
    if let Some(received) = received {
        issue["received"] = received.clone();
    }
    issues.push(issue);
}

fn validate_safe_integer_field(
    object: &serde_json::Map<String, Value>,
    prefix: &[&str],
    key: &'static str,
    issues: &mut Vec<Value>,
) {
    let mut path = prefix.to_vec();
    path.push(key);
    let value = object.get(key);
    let Some(Value::Number(number)) = value else {
        issues.push(invalid_type_issue(
            &path,
            "number",
            zod_received_type(value),
        ));
        return;
    };
    let Some(number) = number.as_f64() else {
        issues.push(invalid_type_issue(&path, "number", "number"));
        return;
    };
    if number.fract() != 0.0 {
        issues.push(invalid_type_issue(&path, "integer", "float"));
    } else if number > MAX_SAFE_INTEGER as f64 {
        issues.push(json!({
            "code": "too_big",
            "maximum": MAX_SAFE_INTEGER,
            "type": "number",
            "inclusive": true,
            "exact": false,
            "path": path,
            "message": format!("Number must be less than or equal to {MAX_SAFE_INTEGER}"),
        }));
    } else if number < -(MAX_SAFE_INTEGER as f64) {
        issues.push(json!({
            "code": "too_small",
            "minimum": -MAX_SAFE_INTEGER,
            "type": "number",
            "inclusive": true,
            "exact": false,
            "path": path,
            "message": format!("Number must be greater than or equal to -{MAX_SAFE_INTEGER}"),
        }));
    }
}

fn add_unknown_key_issue(
    object: &serde_json::Map<String, Value>,
    allowed: &[&str],
    path: &[&str],
    issues: &mut Vec<Value>,
) {
    let keys = object
        .keys()
        .filter(|key| !allowed.contains(&key.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if keys.is_empty() {
        return;
    }
    let quoted = keys
        .iter()
        .map(|key| format!("'{key}'"))
        .collect::<Vec<_>>()
        .join(", ");
    issues.push(json!({
        "code": "unrecognized_keys",
        "keys": keys,
        "path": path,
        "message": format!("Unrecognized key(s) in object: {quoted}"),
    }));
}

fn invalid_type_issue(path: &[&str], expected: &str, received: &str) -> Value {
    json!({
        "code": "invalid_type",
        "expected": expected,
        "received": received,
        "path": path,
        "message": if received == "undefined" {
            "Required".to_owned()
        } else {
            format!("Expected {expected}, received {received}")
        },
    })
}

fn zod_received_type(value: Option<&Value>) -> &'static str {
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

fn invalid_json_issues() -> Vec<Value> {
    vec![json!({
        "code": "custom",
        "path": [],
        "message": "Invalid request body",
    })]
}

fn js_string_length(value: &str) -> usize {
    value.encode_utf16().count()
}

fn valid_ignored_json_body(request: &HttpRequest, body: &[u8]) -> bool {
    if !is_json_content_type(request) || body.is_empty() {
        return true;
    }
    serde_json::from_slice::<Value>(body).is_ok_and(|value| value.is_object() || value.is_array())
}

fn is_json_content_type(request: &HttpRequest) -> bool {
    request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
}

/// Mirror the existing actor middleware's agent-context guard before any of
/// the four routes run. It is a transport identity check only; route authority
/// below still accepts only a board user for claim and sign-out.
async fn enforce_agent_context_if_present(
    state: &IngressState,
    request: &HttpRequest,
) -> Option<HttpResponse> {
    let expected_agent_id = request
        .headers()
        .get("x-rudder-agent-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())?;

    let identity = if authorization_selects_bearer(request) {
        match crate::public_ingress::resolve_public_http_identity(state, request).await {
            Ok(identity) => Some(identity),
            Err((status, _)) if status == StatusCode::SERVICE_UNAVAILABLE => {
                return Some(api_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Service temporarily unavailable",
                ));
            }
            Err(_) => None,
        }
    } else if has_session_cookie(request.headers()) {
        let Some(session_auth) = state.config.session_auth.as_ref() else {
            return Some(api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Service temporarily unavailable",
            ));
        };
        if session_auth.kind != NativeSessionAuthKind::LocalAccount {
            return Some(api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Service temporarily unavailable",
            ));
        }
        match state
            .foundation
            .resolve_public_session(session_auth, request.headers())
            .await
        {
            NativeSessionResolution::Authenticated(identity) => {
                Some(NativeIngressIdentity::Session(identity))
            }
            NativeSessionResolution::Anonymous => None,
            NativeSessionResolution::DatabaseDisabled | NativeSessionResolution::Unavailable => {
                return Some(api_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Service temporarily unavailable",
                ));
            }
        }
    } else {
        None
    };

    match identity.as_ref() {
        Some(identity @ NativeIngressIdentity::AgentJwt(_)) => {
            if let Some(response) =
                crate::public_ingress::agent_run_context_mismatch_response(request, identity)
            {
                return Some(response);
            }
            let NativeIngressIdentity::AgentJwt(agent) = identity else {
                unreachable!();
            };
            (agent.agent_id != expected_agent_id)
                .then(|| agent_context_mismatch(expected_agent_id, &agent.agent_id))
        }
        Some(NativeIngressIdentity::AgentKey { agent_id, .. }) => (agent_id != expected_agent_id)
            .then(|| agent_context_mismatch(expected_agent_id, agent_id)),
        Some(NativeIngressIdentity::BoardKey { .. }) => {
            Some(agent_auth_required(expected_agent_id, "board", "board_key"))
        }
        Some(NativeIngressIdentity::Session(_)) => {
            Some(agent_auth_required(expected_agent_id, "board", "session"))
        }
        Some(NativeIngressIdentity::LocalImplicit) => Some(agent_auth_required(
            expected_agent_id,
            "board",
            "local_implicit",
        )),
        Some(NativeIngressIdentity::None) | None => {
            Some(agent_auth_required(expected_agent_id, "none", "none"))
        }
    }
}

fn agent_auth_required(
    expected_agent_id: &str,
    actor_type: &'static str,
    actor_source: &'static str,
) -> HttpResponse {
    HttpResponse::Unauthorized().json(json!({
        "error": "Agent authentication required for agent-scoped CLI request",
        "code": "agent_auth_required",
        "details": {
            "expectedAgentId": expected_agent_id,
            "actorType": actor_type,
            "actorSource": actor_source,
        },
    }))
}

fn agent_context_mismatch(expected_agent_id: &str, authenticated_agent_id: &str) -> HttpResponse {
    HttpResponse::Forbidden().json(json!({
        "error": "Agent authentication does not match the CLI agent context",
        "code": "agent_context_mismatch",
        "details": {
            "expectedAgentId": expected_agent_id,
            "authenticatedAgentId": authenticated_agent_id,
        },
    }))
}

async fn enforce_selected_session_origin(
    state: &IngressState,
    request: &HttpRequest,
) -> Option<HttpResponse> {
    if authorization_selects_bearer(request) || !has_session_cookie(request.headers()) {
        return None;
    }
    let Some(session_auth) = state.config.session_auth.as_ref() else {
        return Some(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Service temporarily unavailable",
        ));
    };
    if session_auth.kind != NativeSessionAuthKind::LocalAccount {
        return Some(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Service temporarily unavailable",
        ));
    }
    match state
        .foundation
        .resolve_public_session(session_auth, request.headers())
        .await
    {
        NativeSessionResolution::Authenticated(_) if !has_trusted_board_origin(request) => {
            Some(api_error(StatusCode::FORBIDDEN, BOARD_ORIGIN_ERROR))
        }
        NativeSessionResolution::Authenticated(_) | NativeSessionResolution::Anonymous => None,
        NativeSessionResolution::DatabaseDisabled | NativeSessionResolution::Unavailable => {
            Some(api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Service temporarily unavailable",
            ))
        }
    }
}

/// Resolve the identity selected by the legacy actor middleware: Bearer first,
/// then the Local Account session cookie. Only native board identities can
/// claim or revoke sessions; the request body never supplies the user id.
async fn require_local_board_identity(
    state: &IngressState,
    request: &HttpRequest,
) -> Result<(String, bool), HttpResponse> {
    if authorization_selects_bearer(request) {
        let identity =
            match crate::public_ingress::resolve_public_http_identity(state, request).await {
                Ok(identity) => identity,
                Err((status, _)) if status == StatusCode::SERVICE_UNAVAILABLE => {
                    return Err(api_error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Service temporarily unavailable",
                    ));
                }
                Err(_) => return Err(session_required()),
            };
        return match identity {
            NativeIngressIdentity::BoardKey { user_id, .. } => Ok((user_id, false)),
            NativeIngressIdentity::AgentKey { .. } | NativeIngressIdentity::AgentJwt(_) => {
                Err(api_error(
                    StatusCode::UNAUTHORIZED,
                    "A local Rudder user session is required",
                ))
            }
            _ => Err(session_required()),
        };
    }
    if !has_session_cookie(request.headers()) {
        return Err(session_required());
    }
    let Some(session_auth) = state.config.session_auth.as_ref() else {
        return Err(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Service temporarily unavailable",
        ));
    };
    if session_auth.kind != NativeSessionAuthKind::LocalAccount {
        return Err(api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Service temporarily unavailable",
        ));
    }
    match state
        .foundation
        .resolve_public_session(session_auth, request.headers())
        .await
    {
        NativeSessionResolution::Authenticated(identity) => Ok((identity.user_id, true)),
        NativeSessionResolution::Anonymous => Err(session_required()),
        NativeSessionResolution::DatabaseDisabled | NativeSessionResolution::Unavailable => {
            Err(api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Service temporarily unavailable",
            ))
        }
    }
}

fn authorization_selects_bearer(request: &HttpRequest) -> bool {
    let mut values = request.headers().get_all(header::AUTHORIZATION);
    let Some(value) = values.next() else {
        return false;
    };
    if values.next().is_some() {
        return true;
    }
    let Ok(value) = value.to_str() else {
        return true;
    };
    value
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("Bearer "))
}

fn session_required() -> HttpResponse {
    HttpResponse::Unauthorized().json(json!({
        "error": SESSION_REQUIRED_ERROR,
        "code": "account_session_required",
    }))
}

fn has_trusted_board_origin(request: &HttpRequest) -> bool {
    let mut allowed = vec![
        "http://localhost:3100".to_owned(),
        "http://127.0.0.1:3100".to_owned(),
    ];
    if let Some(host) = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|host| !host.is_empty())
    {
        for scheme in ["http", "https"] {
            if let Some(origin) = normalized_origin(&format!("{scheme}://{host}")) {
                allowed.push(origin);
            }
        }
    }
    [header::ORIGIN, header::REFERER].into_iter().any(|name| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .and_then(normalized_origin)
            .is_some_and(|origin| {
                allowed
                    .iter()
                    .any(|allowed_origin| allowed_origin.eq_ignore_ascii_case(&origin))
            })
    })
}

fn normalized_origin(value: &str) -> Option<String> {
    let url = Url::parse(value.trim()).ok()?;
    if url.host_str().is_none() {
        return None;
    }
    Some(url.origin().ascii_serialization().to_ascii_lowercase())
}

fn service_error(error: LocalAccountAuthError, endpoint: LocalAccountEndpoint) -> HttpResponse {
    let (status, message) = match error {
        LocalAccountAuthError::InvalidCredential => (
            StatusCode::UNAUTHORIZED,
            match endpoint {
                LocalAccountEndpoint::Offline => "Offline Grant proof was rejected",
                _ => "Rudder Identity rejected the server exchange",
            },
        ),
        LocalAccountAuthError::Conflict => (
            StatusCode::CONFLICT,
            match endpoint {
                LocalAccountEndpoint::Offline => "Offline Grant proof has already been redeemed",
                _ => "Server exchange code has already been redeemed",
            },
        ),
        LocalAccountAuthError::Forbidden(reason) => (
            StatusCode::FORBIDDEN,
            match reason {
                LocalAccountForbiddenReason::OfflineAccountNotBoundToWorkspace => {
                    "Offline Grant account is not bound to this Local Workspace"
                }
                LocalAccountForbiddenReason::OfflineGrantDoesNotMatchClaimedWorkspace => {
                    "Offline Grant does not match the claimed Local Workspace"
                }
                LocalAccountForbiddenReason::CurrentLocalUserNotBoundToRudderAccount => {
                    "The current local user is not bound to a Rudder Account"
                }
                LocalAccountForbiddenReason::InstallationAlreadyClaimedByAnotherAccount => {
                    "This Rudder installation is already claimed by another account"
                }
            },
        ),
        LocalAccountAuthError::Unavailable => (
            StatusCode::SERVICE_UNAVAILABLE,
            "Service temporarily unavailable",
        ),
        LocalAccountAuthError::InvalidVerifierResponse => (
            StatusCode::UNAUTHORIZED,
            "Rudder Identity returned invalid server exchange claims",
        ),
        LocalAccountAuthError::InvalidConfiguration
        | LocalAccountAuthError::Database(_)
        | LocalAccountAuthError::SessionSigning
        | LocalAccountAuthError::InvalidTime
        | LocalAccountAuthError::RevocationTask => {
            (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    };
    api_error(status, message)
}

fn validation_error() -> HttpResponse {
    validation_error_with(invalid_json_issues())
}

fn validation_error_with(details: Vec<Value>) -> HttpResponse {
    HttpResponse::BadRequest().json(json!({
        "error": "Validation error",
        "details": details,
    }))
}

fn method_not_allowed() -> HttpResponse {
    HttpResponse::NotFound().json(json!({ "error": "API route not found" }))
}

fn api_error(status: StatusCode, message: &'static str) -> HttpResponse {
    HttpResponse::build(status).json(json!({ "error": message }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::test as actix_test;

    #[test]
    fn matches_only_local_lifecycle_paths_with_express_case_and_slash_rules() {
        assert_eq!(
            endpoint_for_path("/api/auth/local-exchange"),
            Some(LocalAccountEndpoint::Exchange)
        );
        assert_eq!(
            endpoint_for_path("/API/AUTH/LOCAL-OFFLINE/"),
            Some(LocalAccountEndpoint::Offline)
        );
        assert_eq!(
            endpoint_for_path("/api/auth/local-claim"),
            Some(LocalAccountEndpoint::Claim)
        );
        assert_eq!(
            endpoint_for_path("/api/auth/local-signout-all/"),
            Some(LocalAccountEndpoint::SignoutAll)
        );
        assert_eq!(endpoint_for_path("/api/auth/local-exchange/extra"), None);
        assert_eq!(endpoint_for_path("/api/auth/local-exchange//"), None);
    }

    #[test]
    fn requires_a_trusted_origin_for_selected_cookie_board_mutations() {
        let request = actix_test::TestRequest::post()
            .insert_header((header::HOST, "rudder.example"))
            .insert_header((header::ORIGIN, "https://evil.example"))
            .insert_header((header::REFERER, "https://rudder.example/settings"))
            .to_http_request();
        assert!(has_trusted_board_origin(&request));

        let untrusted = actix_test::TestRequest::post()
            .insert_header((header::HOST, "rudder.example"))
            .insert_header((header::ORIGIN, "https://evil.example"))
            .to_http_request();
        assert!(!has_trusted_board_origin(&untrusted));

        let same_host = actix_test::TestRequest::post()
            .insert_header((header::HOST, "rudder.example"))
            .insert_header((header::ORIGIN, "https://rudder.example/path"))
            .to_http_request();
        assert!(has_trusted_board_origin(&same_host));
    }

    #[test]
    fn follows_bearer_before_cookie_credential_selection() {
        let bearer_with_cookie = actix_test::TestRequest::post()
            .insert_header((header::AUTHORIZATION, "Bearer board-key"))
            .insert_header((header::COOKIE, "better-auth.session_token=session"))
            .to_http_request();
        assert!(authorization_selects_bearer(&bearer_with_cookie));

        let non_bearer_with_cookie = actix_test::TestRequest::post()
            .insert_header((header::AUTHORIZATION, "Basic ignored"))
            .insert_header((header::COOKIE, "better-auth.session_token=session"))
            .to_http_request();
        assert!(!authorization_selects_bearer(&non_bearer_with_cookie));

        let ambiguous = actix_test::TestRequest::post()
            .append_header((header::AUTHORIZATION, "Basic ignored"))
            .append_header((header::AUTHORIZATION, "Bearer board-key"))
            .insert_header((header::COOKIE, "better-auth.session_token=session"))
            .to_http_request();
        assert!(authorization_selects_bearer(&ambiguous));
    }

    #[test]
    fn lifecycle_body_ignores_submitted_user_ids_and_rejects_json_scalars() {
        let request = actix_test::TestRequest::post()
            .insert_header((header::CONTENT_TYPE, "application/json"))
            .to_http_request();
        assert!(valid_ignored_json_body(
            &request,
            br#"{"userId":"untrusted-user"}"#,
        ));
        assert!(!valid_ignored_json_body(&request, br#""untrusted-user""#));
    }

    #[test]
    fn absent_json_content_type_matches_zod_undefined_root_issue() {
        let request = actix_test::TestRequest::post().to_http_request();
        assert_eq!(
            parse_json_value(&request, br#"{}"#).unwrap_err(),
            vec![json!({
                "code": "invalid_type",
                "expected": "object",
                "received": "undefined",
                "path": [],
                "message": "Required",
            })]
        );
    }

    #[actix_web::test]
    async fn missing_native_service_returns_503_on_the_owned_route() {
        let state = web::Data::new(IngressState {
            foundation: std::sync::Arc::new(
                crate::AppState::new(crate::ServerConfig::default()).unwrap(),
            ),
            config: crate::public_ingress_config::PublicIngressConfig::new(
                "127.0.0.1:0".parse().unwrap(),
                "http://127.0.0.1:1",
                "0123456789abcdef0123456789abcdef",
            )
            .unwrap(),
            local_account: None,
        });
        let app = actix_test::init_service(
            actix_web::App::new()
                .app_data(state)
                .route("/api/auth/local-claim", web::route().to(local_claim)),
        )
        .await;
        let response = actix_test::call_service(
            &app,
            actix_test::TestRequest::post()
                .uri("/api/auth/local-claim")
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = actix_test::read_body(response).await;
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({ "error": "Service temporarily unavailable" })
        );
    }

    #[actix_web::test]
    async fn wrong_methods_match_legacy_api_not_found_contract() {
        let response = method_not_allowed();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = actix_web::body::to_bytes(response.into_body())
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({ "error": "API route not found" })
        );
    }

    #[actix_web::test]
    async fn forbidden_reasons_keep_legacy_route_messages() {
        let cases = [
            (
                LocalAccountForbiddenReason::OfflineAccountNotBoundToWorkspace,
                LocalAccountEndpoint::Offline,
                "Offline Grant account is not bound to this Local Workspace",
            ),
            (
                LocalAccountForbiddenReason::OfflineGrantDoesNotMatchClaimedWorkspace,
                LocalAccountEndpoint::Offline,
                "Offline Grant does not match the claimed Local Workspace",
            ),
            (
                LocalAccountForbiddenReason::CurrentLocalUserNotBoundToRudderAccount,
                LocalAccountEndpoint::Claim,
                "The current local user is not bound to a Rudder Account",
            ),
            (
                LocalAccountForbiddenReason::InstallationAlreadyClaimedByAnotherAccount,
                LocalAccountEndpoint::Claim,
                "This Rudder installation is already claimed by another account",
            ),
        ];

        for (reason, endpoint, message) in cases {
            let response = service_error(LocalAccountAuthError::Forbidden(reason), endpoint);
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
            let body = actix_web::body::to_bytes(response.into_body())
                .await
                .unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(&body).unwrap(),
                json!({ "error": message })
            );
        }
    }

    #[test]
    fn exchange_schema_details_match_zod_missing_length_and_strict_key_issues() {
        assert_eq!(
            validate_exchange_schema(&json!({})),
            vec![json!({
                "code": "invalid_type",
                "expected": "string",
                "received": "undefined",
                "path": ["exchangeCode"],
                "message": "Required",
            })]
        );

        assert_eq!(
            validate_exchange_schema(&json!({
                "exchangeCode": "short",
                "extra": true,
            })),
            vec![
                json!({
                    "code": "too_small",
                    "minimum": 16,
                    "type": "string",
                    "inclusive": true,
                    "exact": false,
                    "path": ["exchangeCode"],
                    "message": "String must contain at least 16 character(s)",
                }),
                json!({
                    "code": "unrecognized_keys",
                    "keys": ["extra"],
                    "path": [],
                    "message": "Unrecognized key(s) in object: 'extra'",
                }),
            ]
        );

        assert_eq!(
            validate_exchange_schema(&json!({ "exchangeCode": 42 })),
            vec![json!({
                "code": "invalid_type",
                "expected": "string",
                "received": "number",
                "path": ["exchangeCode"],
                "message": "Expected string, received number",
            })]
        );

        let too_long = "x".repeat(16_385);
        assert_eq!(
            validate_exchange_schema(&json!({ "exchangeCode": too_long })),
            vec![json!({
                "code": "too_big",
                "maximum": 16_384,
                "type": "string",
                "inclusive": true,
                "exact": false,
                "path": ["exchangeCode"],
                "message": "String must contain at most 16384 character(s)",
            })]
        );
    }

    #[test]
    fn offline_schema_reports_nested_paths_strict_keys_and_safe_integer_bounds() {
        let issues = validate_offline_schema(&json!({
            "grant": "g".repeat(32),
            "devicePublicKeySpki": "k".repeat(32),
            "proof": {
                "payload": {
                    "version": 1,
                    "grantHash": "h".repeat(16),
                    "method": "POST",
                    "path": "/api/auth/local-offline",
                    "bodyHash": "",
                    "nonce": "n".repeat(16),
                    "issuedAtMs": 9_007_199_254_740_992_i64,
                    "extra": true,
                },
                "signature": "s".repeat(16)
            }
        }));
        assert_eq!(
            issues,
            vec![
                json!({
                    "code": "too_small",
                    "minimum": 1,
                    "type": "string",
                    "inclusive": true,
                    "exact": false,
                    "path": ["proof", "payload", "bodyHash"],
                    "message": "String must contain at least 1 character(s)",
                }),
                json!({
                    "code": "too_big",
                    "maximum": 9_007_199_254_740_991_i64,
                    "type": "number",
                    "inclusive": true,
                    "exact": false,
                    "path": ["proof", "payload", "issuedAtMs"],
                    "message": "Number must be less than or equal to 9007199254740991",
                }),
                json!({
                    "code": "unrecognized_keys",
                    "keys": ["extra"],
                    "path": ["proof", "payload"],
                    "message": "Unrecognized key(s) in object: 'extra'",
                }),
            ]
        );
    }

    #[test]
    fn normalizes_integer_valued_numbers_after_zod_safe_integer_validation() {
        let mut value: Value =
            serde_json::from_str(r#"{"proof":{"payload":{"version":1.0,"issuedAtMs":1234.0}}}"#)
                .unwrap();
        normalize_offline_schema(&mut value);
        assert_eq!(value["proof"]["payload"]["version"].as_u64(), Some(1));
        assert_eq!(
            serde_json::from_value::<u8>(value["proof"]["payload"]["version"].clone()).unwrap(),
            1
        );
        assert_eq!(value["proof"]["payload"]["issuedAtMs"].as_i64(), Some(1234));
    }

    #[test]
    fn literal_issues_include_received_values_but_omit_missing_values() {
        assert_eq!(
            validate_offline_schema(&json!({
                "grant": "g".repeat(32),
                "devicePublicKeySpki": "k".repeat(32),
                "proof": {
                    "payload": { "version": 2 },
                    "signature": "s".repeat(16),
                },
            }))[0],
            json!({
                "code": "invalid_literal",
                "expected": 1,
                "received": 2,
                "path": ["proof", "payload", "version"],
                "message": "Invalid literal value, expected 1",
            })
        );

        let issues = validate_offline_schema(&json!({
            "grant": "g".repeat(32),
            "devicePublicKeySpki": "k".repeat(32),
            "proof": {
                "payload": {},
                "signature": "s".repeat(16),
            },
        }));
        assert_eq!(issues[0]["code"], "invalid_literal");
        assert!(issues[0].get("received").is_none());
    }
}
