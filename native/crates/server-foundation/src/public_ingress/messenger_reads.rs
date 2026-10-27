//! Native public Messenger read ingress. The D1 domain owns aggregation,
//! visibility and GET effects; Node is absent for these selected read shapes.
use super::*;
use futures_util::StreamExt;
use rudder_d1_persistence::messenger_reads::{self as domain, Read};
use serde_json::{Value, json};

#[derive(Debug, PartialEq, Eq)]
enum Endpoint {
    Groups,
    Threads,
    Chat(String),
    Issues,
    Approvals,
    System(String),
}
fn endpoint(path: &str, method: &Method) -> Option<(String, Endpoint)> {
    if method != Method::GET && method != Method::HEAD {
        return None;
    }
    let path = path.strip_prefix('/')?;
    let raw = path
        .strip_suffix('/')
        .unwrap_or(path)
        .split('/')
        .collect::<Vec<_>>();
    if raw.iter().any(|part| part.is_empty()) {
        return None;
    }
    let lower = raw
        .iter()
        .map(|part| part.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let parts = lower.iter().map(String::as_str).collect::<Vec<_>>();
    let endpoint = match parts.as_slice() {
        ["api", "orgs", _, "messenger", "groups"] => Endpoint::Groups,
        ["api", "orgs", _, "messenger", "threads"] => Endpoint::Threads,
        ["api", "orgs", _, "messenger", "chat", _] => Endpoint::Chat(raw[5].into()),
        ["api", "orgs", _, "messenger", "issues"] => Endpoint::Issues,
        ["api", "orgs", _, "messenger", "approvals"] => Endpoint::Approvals,
        ["api", "orgs", _, "messenger", "system", _] => Endpoint::System(raw[5].into()),
        _ => return None,
    };
    Some((raw[2].into(), endpoint))
}
pub(super) fn is_reserved_path(path: &str, method: &Method) -> bool {
    endpoint(path, method).is_some()
}
pub(super) async fn dispatch(
    state: web::Data<IngressState>,
    request: HttpRequest,
    mut payload: web::Payload,
) -> HttpResponse {
    let Some((org, endpoint)) = endpoint(request.uri().path(), request.method()) else {
        return error(StatusCode::NOT_FOUND, "Not found");
    };
    let mut body = Vec::new();
    while let Some(chunk) = payload.next().await {
        let Ok(chunk) = chunk else {
            return error(StatusCode::BAD_REQUEST, "Invalid request body");
        };
        if body.len().saturating_add(chunk.len())
            > state
                .foundation
                .config
                .max_request_bytes
                .min(10 * 1024 * 1024)
        {
            return error(StatusCode::PAYLOAD_TOO_LARGE, "Request body is too large");
        }
        body.extend_from_slice(&chunk)
    }
    if let Some(response) = malformed_public_json_response(&request, &body) {
        return response;
    }
    if let Some(response) = private_host_rejection(&state, &request) {
        return response;
    }
    if state.config.forwarding_policy.identity(&request).is_err() {
        return state
            .foundation
            .json_error(StatusCode::BAD_REQUEST, "invalid_forwarding_identity");
    }
    let _permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(AdmissionError::QueueFull) => {
            return state
                .foundation
                .json_error(StatusCode::SERVICE_UNAVAILABLE, "request_queue_full");
        }
    };
    if state.config.identity_auth.is_none() {
        return state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "native_identity_unavailable",
        );
    }
    let identity = match resolve_public_http_identity(&state, &request).await {
        Ok(identity) => identity,
        Err((status, reason)) => return state.foundation.json_error(status, reason),
    };
    if let Some(response) = agent_run_context_mismatch_response(&request, &identity) {
        return response;
    }
    let Some((actor, session)) = agent_core::actor_and_session(&identity) else {
        return error(StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    let Some(auth) = agent_core::native_authorizer(&identity, &actor, &session, &state) else {
        return error(StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    let user = match crate::run_reads::native_run_owner(&identity) {
        Ok(Some(user)) => user,
        Ok(None) => return error(StatusCode::FORBIDDEN, "Board access required"),
        Err(response) => return response,
    };
    let DatabaseState::Configured(pool) = &state.foundation.database else {
        return state
            .foundation
            .json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
    };
    let org = match decode(&org) {
        Ok(org) => org,
        Err(response) => return response,
    };
    let org = match Uuid::parse_str(&org) {
        Ok(org) => org.to_string(),
        Err(_) => return error(StatusCode::NOT_FOUND, "Organization not found"),
    };
    let query = query(&request);
    let scalar = |key: &str| query.get(key).and_then(Value::as_str);
    let input = match endpoint {
        Endpoint::Groups => Read::Groups,
        Endpoint::Threads => Read::Threads {
            paged: scalar("limit").is_some() || scalar("cursor").is_some(),
            limit: scalar("limit").and_then(parse_limit),
            cursor: scalar("cursor").map(normalize_cursor),
            split_issues: scalar("splitIssues") == Some("true"),
        },
        Endpoint::Issues => Read::Issues {
            limit: scalar("limit").and_then(parse_limit),
            cursor: scalar("cursor").map(normalize_cursor),
        },
        Endpoint::Chat(id) => match decode(&id) {
            Ok(id) => Read::Chat {
                conversation_id: id,
            },
            Err(response) => return response,
        },
        Endpoint::Approvals => Read::Approvals,
        Endpoint::System(kind) => match decode(&kind) {
            Ok(kind) => Read::System { kind },
            Err(response) => return response,
        },
    };
    // Node hands off its resolved ICU locale because sanitized child environments
    // do not inherit Linux LANG/LC_* variables. Standalone native runs use the OS.
    let host = std::env::var("RUDDER_NATIVE_HOST_LOCALE").ok();
    let locale = host_locale(host.as_deref(), sys_locale::get_locale);
    match domain::read(pool, &org, user, &locale, &input, &auth).await {
        Ok(value) => HttpResponse::Ok().json(value),
        Err(domain::Error::Http(status, message)) => error(
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            &message,
        ),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
    }
}
fn host_locale(host: Option<&str>, native: impl FnOnce() -> Option<String>) -> String {
    let locale = host
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(native)
        .unwrap_or_else(|| "en-US".into());
    // POSIX default locales are not BCP-47 identifiers. Node Intl uses en-US.
    if matches!(locale.as_str(), "C" | "POSIX") {
        "en-US".into()
    } else {
        locale
    }
}
fn normalize_cursor(raw: &str) -> String {
    domain::normalize_cursor_date(raw, run_reads::js_date_to_iso).unwrap_or_else(|| raw.to_owned())
}
#[allow(clippy::result_large_err)]
fn decode(raw: &str) -> Result<String, HttpResponse> {
    percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .map(|s| s.into_owned())
        .map_err(|_| error(StatusCode::BAD_REQUEST, "Invalid path parameter"))
}
fn query(request: &HttpRequest) -> std::collections::HashMap<String, Value> {
    let mut query = std::collections::HashMap::new();
    for (key, value) in url::form_urlencoded::parse(request.query_string().as_bytes()) {
        query
            .entry(key.into_owned())
            .and_modify(|old| match old {
                Value::Array(values) => values.push(json!(value)),
                old => *old = json!([old.clone(), value]),
            })
            .or_insert_with(|| json!(value));
    }
    query
}
/// Express Number.parseInt(value,10), followed by the existing bounded limit.
fn parse_limit(raw: &str) -> Option<u32> {
    let raw = raw.trim_start();
    let (negative, digits) = if let Some(s) = raw.strip_prefix('-') {
        (true, s)
    } else {
        (false, raw.strip_prefix('+').unwrap_or(raw))
    };
    let digits = digits
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>();
    if digits.is_empty() {
        return None;
    }
    let number = digits.parse::<f64>().ok()?;
    if !number.is_finite() {
        return None;
    }
    Some(if negative || number < 1.0 {
        1
    } else {
        number.min(u32::MAX as f64) as u32
    })
}
fn error(status: StatusCode, message: &str) -> HttpResponse {
    HttpResponse::build(status).json(json!({"error":message}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reserves_only_the_six_read_shapes() {
        for suffix in [
            "groups",
            "threads",
            "chat/id",
            "issues",
            "approvals",
            "system/kind",
        ] {
            let path = format!("/api/orgs/org/messenger/{suffix}");
            assert!(is_reserved_path(&path, &Method::GET));
            assert!(is_reserved_path(&path, &Method::HEAD));
            assert!(is_reserved_path(
                &format!("{}/", path.to_uppercase()),
                &Method::GET
            ));
            assert!(!is_reserved_path(&path, &Method::POST));
        }
        assert!(!is_reserved_path(
            "/api/orgs/org/messenger/saved-views",
            &Method::GET
        ));
    }
    #[test]
    fn explicit_host_locale_precedes_standalone_native_fallback() {
        assert_eq!(
            host_locale(Some(" sv-SE "), || panic!("host handoff must win")),
            "sv-SE"
        );
        assert_eq!(host_locale(Some(" "), || Some("fr-FR".into())), "fr-FR");
        assert_eq!(host_locale(None, || None), "en-US");
        for locale in ["C", "POSIX"] {
            assert_eq!(host_locale(None, || Some(locale.into())), "en-US");
            assert_eq!(host_locale(Some(locale), || None), "en-US");
        }
    }
    #[test]
    fn decimal_limits_follow_node() {
        for (raw, expected) in [
            ("0x10", Some(1)),
            ("-5", Some(1)),
            ("  +12tail", Some(12)),
            ("1e2", Some(1)),
            ("n/a", None),
            ("", None),
        ] {
            assert_eq!(parse_limit(raw), expected, "{raw}");
        }
    }
}
