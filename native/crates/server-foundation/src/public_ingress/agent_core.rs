//! Native public ingress for Agent roster, detail, permissions and instructions.
//! Parsing, authentication and host context are adapted here; the
//! existing D1 AgentCore remains the only business and persistence authority.
mod host_paths;

use super::*;
use crate::{MemberDirectoryNativeAuth, native_session_auth::NativeIngressIdentity};
use actix_web::http::header::CONTENT_TYPE;
use futures_util::StreamExt;
use rudder_d1_persistence::agent_core::{
    AgentCoreError, AgentCoreRequest, admit_agent, execute_agent_with_native_auth,
};
use serde_json::{Map, Value, json};

#[derive(Clone, Debug, Eq, PartialEq)]
enum Endpoint {
    Roster(String),
    Detail(String),
    Me,
    Permissions(String),
    InstructionsPath { org_id: String, agent_id: String },
    InstructionsBundle(String),
    InstructionsFile(String),
}

pub(super) async fn roster(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: web::Bytes,
    path: web::Path<String>,
) -> HttpResponse {
    execute(state, request, body, Endpoint::Roster(path.into_inner())).await
}

pub(super) async fn permissions(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: web::Bytes,
    path: web::Path<String>,
) -> HttpResponse {
    execute(
        state,
        request,
        body,
        Endpoint::Permissions(path.into_inner()),
    )
    .await
}

pub(super) fn is_reserved_path(path: &str, method: &Method) -> bool {
    endpoint_for_path(path).is_some_and(|endpoint| match endpoint {
        Endpoint::Roster(_) | Endpoint::Detail(_) | Endpoint::Me => {
            matches!(*method, Method::GET | Method::HEAD)
        }
        Endpoint::Permissions(_) => *method == Method::PATCH,
        Endpoint::InstructionsPath { .. } => {
            matches!(*method, Method::GET | Method::HEAD | Method::PATCH)
        }
        Endpoint::InstructionsBundle(_) => {
            matches!(*method, Method::GET | Method::HEAD | Method::PATCH)
        }
        Endpoint::InstructionsFile(_) => {
            matches!(
                *method,
                Method::GET | Method::HEAD | Method::PUT | Method::DELETE
            )
        }
    })
}

pub(super) fn is_detail_path(path: &str, method: &Method) -> bool {
    matches!(*method, Method::GET | Method::HEAD)
        && matches!(
            endpoint_for_path(path),
            Some(Endpoint::Detail(_) | Endpoint::Me)
        )
}

/// Handles Express-compatible casing and the optional trailing slash from the
/// default service. Matched endpoint families never continue to Node.
pub(super) async fn dispatch_alias(
    state: web::Data<IngressState>,
    request: HttpRequest,
    mut payload: web::Payload,
) -> HttpResponse {
    let Some(endpoint) = endpoint_for_path(request.uri().path()) else {
        return not_found();
    };
    let mut body = Vec::new();
    while let Some(chunk) = payload.next().await {
        let Ok(chunk) = chunk else {
            return state
                .foundation
                .json_error(StatusCode::BAD_REQUEST, "invalid_request_body");
        };
        if body.len().saturating_add(chunk.len()) > state.foundation.config.max_request_bytes {
            return state
                .foundation
                .json_error(StatusCode::PAYLOAD_TOO_LARGE, "request_body_too_large");
        }
        body.extend_from_slice(&chunk);
    }
    execute(state, request, web::Bytes::from(body), endpoint).await
}

fn endpoint_for_path(path: &str) -> Option<Endpoint> {
    let path = path.strip_prefix('/')?;
    let path = path.strip_suffix('/').unwrap_or(path);
    let segments: Vec<_> = path.split('/').collect();
    if segments.iter().any(|segment| segment.is_empty()) {
        return None;
    }
    if segments.len() == 3
        && segments[0].eq_ignore_ascii_case("api")
        && segments[1].eq_ignore_ascii_case("agents")
    {
        // Express matches the literal route before the parameter route. An
        // encoded capture remains an Agent reference, just as in Express.
        return if segments[2].eq_ignore_ascii_case("me") {
            Some(Endpoint::Me)
        } else {
            decode_capture(segments[2]).map(Endpoint::Detail)
        };
    }
    if segments.len() == 6
        && segments[0].eq_ignore_ascii_case("api")
        && segments[1].eq_ignore_ascii_case("orgs")
        && segments[3].eq_ignore_ascii_case("agents")
        && segments[5].eq_ignore_ascii_case("instructions-path")
    {
        return Some(Endpoint::InstructionsPath {
            org_id: decode_capture(segments[2])?,
            agent_id: decode_capture(segments[4])?,
        });
    }
    if segments.len() == 5
        && segments[0].eq_ignore_ascii_case("api")
        && segments[1].eq_ignore_ascii_case("agents")
        && segments[3].eq_ignore_ascii_case("instructions-bundle")
        && segments[4].eq_ignore_ascii_case("file")
    {
        return decode_capture(segments[2]).map(Endpoint::InstructionsFile);
    }
    if segments.len() == 4
        && segments[0].eq_ignore_ascii_case("api")
        && segments[1].eq_ignore_ascii_case("agents")
        && segments[3].eq_ignore_ascii_case("instructions-bundle")
    {
        return decode_capture(segments[2]).map(Endpoint::InstructionsBundle);
    }
    if segments.len() != 4 {
        return None;
    }
    if segments[0].eq_ignore_ascii_case("api")
        && segments[1].eq_ignore_ascii_case("orgs")
        && segments[3].eq_ignore_ascii_case("agents")
    {
        return decode_capture(segments[2]).map(Endpoint::Roster);
    }
    if segments[0].eq_ignore_ascii_case("api")
        && segments[1].eq_ignore_ascii_case("agents")
        && segments[3].eq_ignore_ascii_case("permissions")
    {
        return decode_capture(segments[2]).map(Endpoint::Permissions);
    }
    None
}

fn decode_capture(value: &str) -> Option<String> {
    percent_encoding::percent_decode_str(value)
        .decode_utf8()
        .ok()
        .map(|value| value.into_owned())
}

fn method_matches(request: &HttpRequest, endpoint: &Endpoint) -> bool {
    match endpoint {
        Endpoint::Roster(_) | Endpoint::Detail(_) | Endpoint::Me => {
            matches!(*request.method(), Method::GET | Method::HEAD)
        }
        Endpoint::Permissions(_) => *request.method() == Method::PATCH,
        Endpoint::InstructionsPath { .. } => matches!(
            *request.method(),
            Method::GET | Method::HEAD | Method::PATCH
        ),
        Endpoint::InstructionsBundle(_) => matches!(
            *request.method(),
            Method::GET | Method::HEAD | Method::PATCH
        ),
        Endpoint::InstructionsFile(_) => matches!(
            *request.method(),
            Method::GET | Method::HEAD | Method::PUT | Method::DELETE
        ),
    }
}

fn not_found() -> HttpResponse {
    HttpResponse::NotFound().json(json!({"error":"API route not found"}))
}

async fn execute(
    state: web::Data<IngressState>,
    request: HttpRequest,
    public_body: web::Bytes,
    endpoint: Endpoint,
) -> HttpResponse {
    let requested_org = match &endpoint {
        Endpoint::InstructionsPath { org_id, .. } => Some(org_id.clone()),
        _ => None,
    };
    // Express JSON parsing runs before auth and route middleware. Preserve its
    // parse-error precedence and leave non-JSON bodies absent on the command.
    let parsed_body = match parse_public_json_body(&request, &public_body) {
        Ok(body) => body,
        // The current Express error handler does not special-case body-parser
        // SyntaxErrors, so malformed JSON and strict-parser scalar values are
        // surfaced as the generic 500 response despite body-parser's 400 tag.
        Err(()) => {
            return HttpResponse::InternalServerError()
                .json(json!({"error":"Internal server error"}));
        }
    };
    if let Some(response) = super::private_host_rejection(&state, &request) {
        return response;
    }
    if !method_matches(&request, &endpoint) {
        return not_found();
    }
    if state.config.forwarding_policy.identity(&request).is_err() {
        return state
            .foundation
            .json_error(StatusCode::BAD_REQUEST, "invalid_forwarding_identity");
    }
    if state.config.identity_auth.is_none() {
        return state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "native_identity_unavailable",
        );
    }
    let identity = match resolve_public_http_identity(&state, &request).await {
        Ok(identity) => identity,
        Err((status, code)) => return state.foundation.json_error(status, code),
    };
    if let Some(response) = agent_run_context_mismatch_response(&request, &identity) {
        return response;
    }
    // This is the Rust equivalent of boardMutationGuard(): cookie-backed
    // board actors need a same-host browser origin; local-implicit and bearer
    // actors are exempt exactly as the legacy middleware specifies.
    if matches!(
        &endpoint,
        Endpoint::Permissions(_)
            | Endpoint::InstructionsPath { .. }
            | Endpoint::InstructionsBundle(_)
            | Endpoint::InstructionsFile(_)
    ) && matches!(&identity, NativeIngressIdentity::Session(_))
        && !matches!(
            *request.method(),
            Method::GET | Method::HEAD | Method::OPTIONS
        )
        && !crate::local_account_ingress::has_trusted_board_origin(&request)
    {
        return HttpResponse::Forbidden()
            .json(json!({"error":crate::local_account_ingress::BOARD_ORIGIN_ERROR}));
    }
    let _permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(AdmissionError::QueueFull) => {
            return state
                .foundation
                .json_error(StatusCode::SERVICE_UNAVAILABLE, "request_queue_full");
        }
    };
    let Some((actor, session_id)) = actor_and_session(&identity) else {
        return state
            .foundation
            .json_error(StatusCode::UNAUTHORIZED, "unauthorized");
    };
    let native_auth = match native_authorizer(&identity, &actor, &session_id, &state) {
        Some(authorizer) => authorizer,
        None => {
            return state
                .foundation
                .json_error(StatusCode::UNAUTHORIZED, "unauthorized");
        }
    };
    let mut command = request_command(&state, &request, endpoint, parsed_body);
    command["localImplicit"] = json!(matches!(&identity, NativeIngressIdentity::LocalImplicit));
    if let NativeIngressIdentity::AgentJwt(jwt) = &identity {
        command["actorRunId"] = json!(jwt.run_id);
    }
    let DatabaseState::Configured(pool) = &state.foundation.database else {
        return state
            .foundation
            .json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
    };
    let Some(key) = state.foundation.config.actor_envelope_key.as_ref() else {
        return state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "actor_envelope_unconfigured",
        );
    };
    let request_target = request.uri().to_string();
    let request_id = Uuid::new_v4().to_string();
    let now = unix_time_seconds();
    let action = "agent.core.execute";
    let command_bytes = match serde_json::to_vec(&command) {
        Ok(bytes) => bytes,
        Err(_) => {
            return state
                .foundation
                .json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal_server_error");
        }
    };
    let envelope = ActorEnvelope::new(
        actor.clone(),
        "agent-core",
        session_id.clone(),
        1,
        ACTOR_ENVELOPE_AUDIENCE,
        request.method().as_str(),
        &request_target,
        action,
        &command_bytes,
        &request_id,
        Uuid::new_v4().to_string(),
        now,
        now + 30,
    )
    .and_then(|unsigned| unsigned.sign_with_key(key));
    let actor = match envelope.ok().and_then(|envelope| {
        state
            .foundation
            .verify_actor_envelope_parts(
                key,
                &envelope,
                &request,
                "agent-core",
                action,
                None,
                &command_bytes,
                &request_id,
            )
            .ok()
    }) {
        Some(actor) => actor,
        None => {
            return state.foundation.json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "actor_envelope_unavailable",
            );
        }
    };
    let parsed = match AgentCoreRequest::parse(&command_bytes) {
        Ok(command) => command,
        Err(_) => {
            return HttpResponse::BadRequest().json(json!({"error":"Invalid Agent command"}));
        }
    };
    if let Err(error) = admit_agent(&actor, &parsed) {
        return response_error(error);
    }
    if matches!(
        command["operation"].as_str(),
        Some("detail" | "me" | "permissions")
    ) || command["operation"]
        .as_str()
        .is_some_and(|op| op.starts_with("instructions-"))
    {
        command["resolveOnly"] = json!(true);
        let resolve_bytes = match serde_json::to_vec(&command) {
            Ok(bytes) => bytes,
            Err(_) => {
                return state
                    .foundation
                    .json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal_server_error");
            }
        };
        let resolve_command = match AgentCoreRequest::parse(&resolve_bytes) {
            Ok(command) => command,
            Err(_) => {
                return HttpResponse::BadRequest().json(json!({"error":"Invalid Agent command"}));
            }
        };
        let resolved = match execute_agent_with_native_auth(
            pool,
            &actor,
            &resolve_command,
            &native_auth,
        )
        .await
        {
            Ok((200, body)) => match serde_json::from_str::<Value>(&body) {
                Ok(value) => value,
                Err(_) => {
                    return state.foundation.json_error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "agent_core_resolution_unavailable",
                    );
                }
            },
            Ok((status, body)) => return agent_response(request.method(), status, body),
            Err(error) => return response_error(error),
        };
        let Some(org_id) = resolved["orgId"].as_str() else {
            return state.foundation.json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "agent_core_resolution_unavailable",
            );
        };
        if requested_org
            .as_deref()
            .is_some_and(|requested| requested != org_id)
        {
            // Keep the organization-scoped Express route's 404 boundary: a
            // valid Agent id must not be usable through another org's URL.
            return HttpResponse::NotFound().json(json!({"error":"Agent not found"}));
        }
        let Some(agent_id) = resolved["id"].as_str() else {
            return state.foundation.json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "agent_core_resolution_unavailable",
            );
        };
        let Ok(facts) = host_paths::AgentHostFacts::resolve(org_id) else {
            return state.foundation.json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "agent_core_host_context_unavailable",
            );
        };
        command["id"] = json!(agent_id);
        command["orgId"] = json!(org_id);
        command["resolveOnly"] = json!(false);
        command["homeDirectory"] = json!(facts.home_directory);
        command["processWorkingDirectory"] = json!(facts.process_working_directory);
        command["instructionsHost"] = json!({
            "instanceRoot": facts.instructions_host.instance_root,
            "workspaceHome": facts.instructions_host.workspace_home,
            "previousDocumentsRoot": facts.instructions_host.previous_documents_root,
            "friendlyWorkspaceHome": facts.instructions_host.friendly_workspace_home,
            "hostname": facts.instructions_host.hostname,
        });
    }
    let command_bytes = match serde_json::to_vec(&command) {
        Ok(bytes) => bytes,
        Err(_) => {
            return state
                .foundation
                .json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal_server_error");
        }
    };
    let command = match AgentCoreRequest::parse(&command_bytes) {
        Ok(command) => command,
        Err(_) => {
            return HttpResponse::BadRequest().json(json!({"error":"Invalid Agent command"}));
        }
    };
    if let Err(error) = admit_agent(&actor, &command) {
        return response_error(error);
    }
    match execute_agent_with_native_auth(pool, &actor, &command, &native_auth).await {
        Ok((status, body)) => agent_response(request.method(), status, body),
        Err(error) => response_error(error),
    }
}

fn request_command(
    state: &IngressState,
    request: &HttpRequest,
    endpoint: Endpoint,
    parsed_body: Option<Value>,
) -> Value {
    let (operation, org_id, id) = match endpoint {
        Endpoint::Roster(org_id) => ("list", Some(org_id), None),
        Endpoint::Detail(agent_id) => ("detail", None, Some(agent_id)),
        Endpoint::Me => ("me", None, None),
        Endpoint::Permissions(agent_id) => ("permissions", None, Some(agent_id)),
        Endpoint::InstructionsPath { org_id, agent_id } => {
            let op = match *request.method() {
                Method::GET | Method::HEAD => "instructions-path-get",
                _ => "instructions-path-patch",
            };
            (op, Some(org_id), Some(agent_id))
        }
        Endpoint::InstructionsBundle(agent_id) => {
            let op = if matches!(*request.method(), Method::GET | Method::HEAD) {
                "instructions-bundle-get"
            } else {
                "instructions-bundle-patch"
            };
            (op, None, Some(agent_id))
        }
        Endpoint::InstructionsFile(agent_id) => {
            let op = match *request.method() {
                Method::GET | Method::HEAD => "instructions-file-get",
                Method::PUT => "instructions-file-put",
                _ => "instructions-file-delete",
            };
            (op, None, Some(agent_id))
        }
    };
    let mut command = json!({
        "operation": operation,
        "orgId": org_id,
        "id": id,
        "query": query_value(request.uri().query().unwrap_or_default()),
        "localImplicit": false,
        "actorRunId": request
            .headers()
            .get("x-rudder-run-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned),
        "resolveOnly": false,
        "organizationAgentsRoot": "",
        "homeDirectory": "",
        "processWorkingDirectory": "",
        "canonicalLocale": "en-US",
        "deploymentMode": state.config.deployment_mode,
    });
    if matches!(
        operation,
        "permissions"
            | "instructions-path-patch"
            | "instructions-bundle-patch"
            | "instructions-file-put"
    ) && let Some(input) = parsed_body
    {
        command["input"] = input;
    }
    command
}

fn parse_public_json_body(request: &HttpRequest, public_body: &[u8]) -> Result<Option<Value>, ()> {
    let content_type = request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !is_json_content_type(content_type) || public_body.is_empty() {
        return Ok(None);
    }
    let body = serde_json::from_slice::<Value>(public_body).map_err(|_| ())?;
    // Express's default express.json() parser is strict: JSON values must be
    // objects or arrays. Explicit null therefore stays a parser error, while
    // a missing body remains omitted from AgentCoreRequest.input.
    if !body.is_object() && !body.is_array() {
        return Err(());
    }
    Ok(Some(body))
}

fn agent_response(method: &Method, status: u16, body: String) -> HttpResponse {
    let mut response = HttpResponse::build(
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
    );
    response.content_type("application/json; charset=utf-8");
    if *method == Method::HEAD {
        response.insert_header(("content-length", body.len().to_string()));
    }
    // Keep the representation size available to Actix's HEAD encoder. An
    // empty response body would cause it to replace Content-Length with zero.
    response.body(body)
}

fn is_json_content_type(value: &str) -> bool {
    let media_type = value.split(';').next().unwrap_or_default().trim();
    media_type.eq_ignore_ascii_case("application/json")
}

fn query_value(query: &str) -> Value {
    let mut object = Map::new();
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        match object.entry(key.into_owned()) {
            serde_json::map::Entry::Vacant(entry) => {
                entry.insert(Value::String(value.into_owned()));
            }
            serde_json::map::Entry::Occupied(mut entry) => {
                let current = entry.get_mut();
                if let Value::Array(values) = current {
                    values.push(Value::String(value.into_owned()));
                } else {
                    let first = std::mem::replace(current, Value::Null);
                    *current = json!([first, value.into_owned()]);
                }
            }
        }
    }
    Value::Object(object)
}

fn actor_and_session(identity: &NativeIngressIdentity) -> Option<(ActorIdentity, String)> {
    match identity {
        NativeIngressIdentity::None => None,
        NativeIngressIdentity::LocalImplicit => Some((
            ActorIdentity::new("user", "local-board").ok()?,
            "local-implicit".to_owned(),
        )),
        NativeIngressIdentity::Session(identity) => Some((
            ActorIdentity::new("user", &identity.user_id).ok()?,
            identity.session_id.clone(),
        )),
        NativeIngressIdentity::BoardKey {
            user_id, key_id, ..
        } => Some((
            ActorIdentity::new("user", user_id).ok()?,
            format!("board-key:{key_id}"),
        )),
        NativeIngressIdentity::AgentKey {
            agent_id, key_id, ..
        } => Some((
            ActorIdentity::new("agent", agent_id).ok()?,
            format!("agent-key:{key_id}"),
        )),
        NativeIngressIdentity::AgentJwt(identity) => Some((
            ActorIdentity::new("agent", &identity.agent_id).ok()?,
            format!("agent-jwt:{}", identity.agent_id),
        )),
    }
}

fn native_authorizer<'a>(
    identity: &'a NativeIngressIdentity,
    actor: &'a ActorIdentity,
    session_id: &'a str,
    state: &'a IngressState,
) -> Option<MemberDirectoryNativeAuth<'a>> {
    match identity {
        NativeIngressIdentity::None => None,
        NativeIngressIdentity::LocalImplicit => Some(MemberDirectoryNativeAuth::LocalImplicit),
        NativeIngressIdentity::Session(identity) => Some(MemberDirectoryNativeAuth::Session {
            identity,
            kind: state
                .config
                .session_auth
                .as_ref()
                .map_or(NativeSessionAuthKind::BetterAuth, |config| config.kind),
        }),
        NativeIngressIdentity::BoardKey { token_hash, .. }
        | NativeIngressIdentity::AgentKey { token_hash, .. } => {
            Some(MemberDirectoryNativeAuth::Bearer {
                actor,
                session_id,
                token_hash,
            })
        }
        NativeIngressIdentity::AgentJwt(identity) => {
            Some(MemberDirectoryNativeAuth::AgentJwt { identity })
        }
    }
}

fn response_error(error: AgentCoreError) -> HttpResponse {
    match error {
        AgentCoreError::Http(status, message, details) => {
            let mut value = json!({"error":message});
            if let Some(details) = details {
                value["details"] = details;
            }
            HttpResponse::build(
                StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            )
            .json(value)
        }
        AgentCoreError::Database(error) => {
            tracing::warn!(error=?error,"Agent authority database command failed");
            HttpResponse::InternalServerError().json(json!({"error":"Internal server error"}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::test::TestRequest;

    fn request(method: Method) -> HttpRequest {
        TestRequest::default().method(method).to_http_request()
    }

    #[test]
    fn detail_routes_are_native_for_aliases_and_head_without_capturing_mutations() {
        for path in ["/api/agents/agent-1", "/API/AGENTS/agent-1/"] {
            assert_eq!(
                endpoint_for_path(path),
                Some(Endpoint::Detail("agent-1".into()))
            );
            for method in [Method::GET, Method::HEAD] {
                assert!(is_detail_path(path, &method));
                assert!(is_reserved_path(path, &method));
            }
            for method in [Method::POST, Method::PATCH, Method::DELETE] {
                assert!(!is_reserved_path(path, &method));
            }
        }
        assert_eq!(endpoint_for_path("/API/AGENTS/ME/"), Some(Endpoint::Me));
        assert_eq!(
            endpoint_for_path("/api/agents/%6De"),
            Some(Endpoint::Detail("me".into()))
        );
        assert!(!is_detail_path("/api/agents/me/inbox-lite", &Method::GET));
        assert!(!is_detail_path("/api/agents/a//", &Method::GET));
        assert_eq!(endpoint_for_path("/api/agents/%FF"), None);
    }

    #[test]
    fn instructions_routes_are_reserved_with_exact_method_contracts() {
        let cases = [
            (
                "/api/orgs/org%2Fone/agents/agent-1/instructions-path",
                Endpoint::InstructionsPath {
                    org_id: "org/one".to_owned(),
                    agent_id: "agent-1".to_owned(),
                },
                [Method::GET, Method::PATCH, Method::POST],
            ),
            (
                "/api/agents/agent-1/instructions-bundle",
                Endpoint::InstructionsBundle("agent-1".to_owned()),
                [Method::GET, Method::PATCH, Method::POST],
            ),
            (
                "/api/agents/agent-1/instructions-bundle/file",
                Endpoint::InstructionsFile("agent-1".to_owned()),
                [Method::GET, Method::PUT, Method::DELETE],
            ),
        ];
        for (path, expected, methods) in cases {
            assert_eq!(endpoint_for_path(path), Some(expected.clone()));
            for method in methods {
                let accepted = method_matches(&request(method.clone()), &expected);
                let should_accept = match &expected {
                    Endpoint::InstructionsPath { .. } => {
                        matches!(method, Method::GET | Method::HEAD | Method::PATCH)
                    }
                    Endpoint::InstructionsBundle(_) => {
                        matches!(method, Method::GET | Method::HEAD | Method::PATCH)
                    }
                    Endpoint::InstructionsFile(_) => {
                        matches!(
                            method,
                            Method::GET | Method::HEAD | Method::PUT | Method::DELETE
                        )
                    }
                    _ => false,
                };
                assert_eq!(accepted, should_accept, "{path} {method}");
            }
        }
    }

    #[test]
    fn instructions_routes_reject_unsupported_methods_and_malformed_paths() {
        let path = "/api/agents/agent-1/instructions-bundle";
        let endpoint = endpoint_for_path(path).expect("bundle route");
        assert!(!method_matches(&request(Method::POST), &endpoint));
        assert_eq!(
            endpoint_for_path("/api/agents/agent-1/instructions-bundle/file/extra"),
            None
        );
        assert_eq!(
            endpoint_for_path("/api/orgs/org-1/agents/agent-1/instructions-path//"),
            None
        );
    }
}
