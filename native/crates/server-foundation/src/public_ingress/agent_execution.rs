//! Public transport for the native generic Agent executor.
//!
//! Compiled independently of activation: startup must install the consumer and
//! retire legacy producers before mounting admission routes.
use super::*;
use crate::native_session_auth::NativeIngressIdentity;
use crate::run_reads::Surface;
use futures_util::StreamExt;
use rudder_d1_persistence::agent_execution::{
    self, AgentExecutionActor, AgentExecutionError, AgentWakeRequest,
};
use serde_json::{Value, json};

#[derive(Clone, Debug, PartialEq)]
pub(super) enum Endpoint {
    Wake(String),
    Invoke(String),
    Cancel(String, Surface),
    Retry(String, Surface),
}

pub(super) fn endpoint_for_path(path: &str, method: &Method) -> Option<Endpoint> {
    if *method != Method::POST {
        return None;
    }
    let path = path.strip_prefix('/')?;
    let parts: Vec<_> = path.strip_suffix('/').unwrap_or(path).split('/').collect();
    if parts.iter().any(|part| part.is_empty()) || !parts.first()?.eq_ignore_ascii_case("api") {
        return None;
    }
    let capture = |value: &str| {
        percent_encoding::percent_decode_str(value)
            .decode_utf8()
            .ok()
            .map(|value| value.into_owned())
            .filter(|value| !value.is_empty())
    };
    if parts.len() == 4
        && parts[1].eq_ignore_ascii_case("agents")
        && parts[3].eq_ignore_ascii_case("wakeup")
    {
        return Some(Endpoint::Wake(capture(parts[2])?));
    }
    if parts.len() == 5
        && parts[1].eq_ignore_ascii_case("agents")
        && parts[3].eq_ignore_ascii_case("heartbeat")
        && parts[4].eq_ignore_ascii_case("invoke")
    {
        return Some(Endpoint::Invoke(capture(parts[2])?));
    }
    if parts.len() != 4 {
        return None;
    }
    let surface = if parts[1].eq_ignore_ascii_case("agent-runs") {
        Surface::Agent
    } else if parts[1].eq_ignore_ascii_case("heartbeat-runs") {
        Surface::Heartbeat
    } else {
        return None;
    };
    if parts[3].eq_ignore_ascii_case("cancel") {
        Some(Endpoint::Cancel(capture(parts[2])?, surface))
    } else if parts[3].eq_ignore_ascii_case("retry") {
        Some(Endpoint::Retry(capture(parts[2])?, surface))
    } else {
        None
    }
}

fn wake_validation(value: &Value) -> Result<(), Value> {
    fn received(value: &Value) -> &'static str {
        match value {
            Value::Null => "null",
            Value::Bool(_) => "boolean",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
        }
    }
    fn wrong(expected: &str, value: &Value, path: Value) -> Value {
        let kind = received(value);
        json!({"code":"invalid_type","expected":expected,"received":kind,"path":path,"message":format!("Expected {expected}, received {kind}")})
    }
    let mut issues = Vec::new();
    if let Some(object) = value.as_object() {
        for (key, options) in [
            (
                "source",
                &["timer", "assignment", "review", "on_demand", "automation"][..],
            ),
            (
                "triggerDetail",
                &["manual", "ping", "callback", "system"][..],
            ),
        ] {
            if let Some(value) = object.get(key) {
                let expected = options
                    .iter()
                    .map(|v| format!("'{v}'"))
                    .collect::<Vec<_>>()
                    .join(" | ");
                if let Some(text) = value.as_str() {
                    if !options.contains(&text) {
                        issues.push(json!({"received":text,"code":"invalid_enum_value","options":options,"path":[key],"message":format!("Invalid enum value. Expected {expected}, received '{text}'")}));
                    }
                } else {
                    issues.push(wrong(&expected, value, json!([key])));
                }
            }
        }
        for (key, expected) in [
            ("reason", "string"),
            ("payload", "object"),
            ("idempotencyKey", "string"),
            ("forceFreshSession", "boolean"),
        ] {
            if let Some(value) = object.get(key) {
                if !value.is_null() && received(value) != expected {
                    issues.push(wrong(expected, value, json!([key])));
                }
            }
        }
    } else {
        issues.push(wrong("object", value, json!([])));
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(json!({"error":"Validation error","details":issues}))
    }
}

fn wake_input(
    value: Value,
    org: String,
    agent: String,
    actor: &AgentExecutionActor,
    board: bool,
    invoke: bool,
) -> Result<AgentWakeRequest, HttpResponse> {
    if !invoke {
        wake_validation(&value).map_err(|body| HttpResponse::BadRequest().json(body))?;
    }
    let invalid = || HttpResponse::BadRequest().json(json!({"error":"Invalid request body"}));
    let input = value.as_object().ok_or_else(invalid)?;
    let source = if invoke {
        "on_demand"
    } else {
        input
            .get("source")
            .map_or(Some("on_demand"), Value::as_str)
            .ok_or_else(invalid)?
    };
    if !matches!(
        source,
        "timer" | "assignment" | "review" | "on_demand" | "automation"
    ) {
        return Err(invalid());
    }
    let detail = if invoke {
        "manual"
    } else {
        input
            .get("triggerDetail")
            .map_or(Some("manual"), Value::as_str)
            .ok_or_else(invalid)?
    };
    if !matches!(detail, "manual" | "ping" | "callback" | "system") {
        return Err(invalid());
    }
    let optional_string = |key: &str| -> Result<Option<String>, HttpResponse> {
        match input.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(value)) => Ok(Some(value.clone())),
            _ => Err(invalid()),
        }
    };
    let payload = if invoke {
        None
    } else {
        match input.get("payload") {
            None | Some(Value::Null) => None,
            Some(Value::Object(_)) => input.get("payload").cloned(),
            _ => return Err(invalid()),
        }
    };
    let fresh = if invoke {
        false
    } else {
        match input.get("forceFreshSession") {
            None | Some(Value::Null) => false,
            Some(Value::Bool(value)) => *value,
            _ => return Err(invalid()),
        }
    };
    let mut context =
        json!({"triggeredBy":if board {"board"} else {"agent"},"actorId":actor.actor_id});
    if !invoke {
        context["forceFreshSession"] = json!(fresh);
    }
    Ok(AgentWakeRequest {
        organization_id: org,
        agent_id: agent,
        source: source.into(),
        trigger_detail: Some(detail.into()),
        reason: if invoke {
            None
        } else {
            optional_string("reason")?
        },
        payload,
        idempotency_key: if invoke {
            None
        } else {
            optional_string("idempotencyKey")?
        },
        context_snapshot: context,
    })
}

pub(super) async fn execute(
    state: web::Data<IngressState>,
    request: HttpRequest,
    mut payload: web::Payload,
    endpoint: Endpoint,
) -> HttpResponse {
    let mut body = Vec::new();
    while let Some(chunk) = payload.next().await {
        let Ok(chunk) = chunk else {
            return state
                .foundation
                .json_error(StatusCode::BAD_REQUEST, "invalid_request_body");
        };
        if body.len().saturating_add(chunk.len())
            > state
                .foundation
                .config
                .max_request_bytes
                .min(10 * 1024 * 1024)
        {
            return state
                .foundation
                .json_error(StatusCode::PAYLOAD_TOO_LARGE, "request_body_too_large");
        }
        body.extend_from_slice(&chunk);
    }
    if let Some(response) = malformed_public_json_response(&request, &body) {
        return response;
    }
    if matches!(&endpoint, Endpoint::Wake(_)) {
        let value = if body.is_empty() {
            json!({})
        } else {
            match serde_json::from_slice(&body) {
                Ok(value) => value,
                Err(_) => {
                    return state
                        .foundation
                        .json_error(StatusCode::BAD_REQUEST, "invalid_request_body");
                }
            }
        };
        if let Err(body) = wake_validation(&value) {
            return HttpResponse::BadRequest().json(body);
        }
    }
    if let Some(response) = private_host_rejection(&state, &request) {
        return response;
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
    if matches!(&identity, NativeIngressIdentity::Session(_))
        && !crate::local_account_ingress::has_trusted_board_origin(&request)
    {
        return HttpResponse::Forbidden()
            .json(json!({"error":crate::local_account_ingress::BOARD_ORIGIN_ERROR}));
    }
    let Some((actor, session)) = agent_core::actor_and_session(&identity) else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    let Some(auth) = agent_core::native_authorizer(&identity, &actor, &session, &state) else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    let DatabaseState::Configured(pool) = &state.foundation.database else {
        return state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "agent_execution_unavailable",
        );
    };
    let _permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(_) => {
            return state
                .foundation
                .json_error(StatusCode::SERVICE_UNAVAILABLE, "request_queue_full");
        }
    };
    let board = actor.kind == "user";
    let execution_actor = AgentExecutionActor {
        actor_type: if board { "user" } else { "agent" },
        actor_id: actor.id.clone(),
        run_id: match &identity {
            NativeIngressIdentity::AgentJwt(identity) => Some(identity.run_id.clone()),
            _ => None,
        },
    };
    let invoke = matches!(&endpoint, Endpoint::Invoke(_));
    let retry = matches!(&endpoint, Endpoint::Retry(..));
    let (org, run_id, surface, status) =
        match endpoint {
            Endpoint::Wake(reference) | Endpoint::Invoke(reference) => {
                let agent = match sqlx::query_scalar::<_, String>(
                    "SELECT org_id::text FROM agents WHERE id=$1::uuid",
                )
                .bind(&reference)
                .fetch_optional(pool)
                .await
                {
                    Ok(Some(org)) => org,
                    Ok(None) => {
                        return HttpResponse::NotFound().json(json!({"error":"Agent not found"}));
                    }
                    Err(_) => {
                        return state.foundation.json_error(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "agent_execution_failed",
                        );
                    }
                };
                let value = if invoke || body.is_empty() {
                    json!({})
                } else {
                    match serde_json::from_slice(&body) {
                        Ok(value) => value,
                        Err(_) => {
                            return HttpResponse::BadRequest()
                                .json(json!({"error":"Invalid request body"}));
                        }
                    }
                };
                let input = match wake_input(
                    value,
                    agent.clone(),
                    reference,
                    &execution_actor,
                    board,
                    invoke,
                ) {
                    Ok(input) => input,
                    Err(response) => return response,
                };
                let admission =
                    match agent_execution::admit(pool, &auth, &execution_actor, &input).await {
                        Ok(value) => value,
                        Err(error) => return execution_error(error),
                    };
                let Some(run_id) = admission.run_id else {
                    return HttpResponse::Accepted().json(json!({"status":"skipped"}));
                };
                (agent, run_id, Surface::Heartbeat, StatusCode::ACCEPTED)
            }
            Endpoint::Cancel(reference, surface) | Endpoint::Retry(reference, surface) => {
                let message = if surface == Surface::Agent {
                    "Agent run not found"
                } else {
                    "Heartbeat run not found"
                };
                let (run_id, org) = match run_reads::resolve_run_reference(
                    pool, &state, &identity, &auth, &reference, message,
                )
                .await
                {
                    Ok(value) => value,
                    Err(response) => return response,
                };
                if retry {
                    let admission =
                        match agent_execution::retry(pool, &auth, &execution_actor, &org, &run_id)
                            .await
                        {
                            Ok(value) => value,
                            Err(error) => return execution_error(error),
                        };
                    let Some(run_id) = admission.run_id else {
                        return HttpResponse::Accepted().json(json!({"status":"skipped"}));
                    };
                    (org, run_id, surface, StatusCode::OK)
                } else {
                    if let Err(error) =
                        agent_execution::cancel(pool, &auth, &execution_actor, &org, &run_id).await
                    {
                        return execution_error(error);
                    }
                    (org, run_id, surface, StatusCode::OK)
                }
            }
        };
    let owner = board.then_some(actor.id.as_str());
    match crate::run_reads::mutation_response(pool, &org, &run_id, owner, surface).await {
        Ok(Some(response)) => HttpResponse::build(status)
            .content_type("application/json; charset=utf-8")
            .body(response),
        Ok(None) => HttpResponse::NotFound().json(json!({"error":"Agent run not found"})),
        Err(error) => {
            tracing::warn!(error=%error,"native Agent execution projection failed");
            state
                .foundation
                .json_error(StatusCode::INTERNAL_SERVER_ERROR, "agent_execution_failed")
        }
    }
}

fn execution_error(error: AgentExecutionError) -> HttpResponse {
    match error {
        AgentExecutionError::Http(status, message, details) => {
            let mut body = json!({"error":message});
            if let Some(details) = details {
                body["details"] = details;
            }
            HttpResponse::build(
                StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            )
            .json(body)
        }
        error => {
            tracing::warn!(error=%error,"native Agent execution failed");
            HttpResponse::InternalServerError().json(json!({"error":"Internal server error"}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_route_contract_keeps_aliases_and_rejects_neighbouring_routes() {
        for (path, expected) in [
            ("/api/agents/a/wakeup", Endpoint::Wake("a".into())),
            (
                "/API/AGENTS/%61/HEARTBEAT/INVOKE/",
                Endpoint::Invoke("a".into()),
            ),
            (
                "/api/heartbeat-runs/run_abcd1234/cancel",
                Endpoint::Cancel("run_abcd1234".into(), Surface::Heartbeat),
            ),
            (
                "/api/agent-runs/a/cancel",
                Endpoint::Cancel("a".into(), Surface::Agent),
            ),
            (
                "/api/heartbeat-runs/a/retry",
                Endpoint::Retry("a".into(), Surface::Heartbeat),
            ),
            (
                "/api/agent-runs/a/retry",
                Endpoint::Retry("a".into(), Surface::Agent),
            ),
        ] {
            assert_eq!(endpoint_for_path(path, &Method::POST), Some(expected));
            assert_eq!(endpoint_for_path(path, &Method::GET), None);
        }
        for path in [
            "/api/agents/a/wakeup/extra",
            "/api/agent-runs/delegation",
            "/api/agents/a/claude-login",
            "/api/agent-runs//cancel",
            "/api/agent-runs/a/retry/extra",
        ] {
            assert_eq!(endpoint_for_path(path, &Method::POST), None, "{path}");
        }
    }

    #[test]
    fn wake_validation_matches_existing_zod_corpus() {
        for line in include_str!("agent_execution_wake_golden.jsonl").lines() {
            let case: Value = serde_json::from_str(line).unwrap();
            let actual = wake_validation(&case["input"]);
            if let Some(expected) = case.get("error") {
                assert_eq!(actual.unwrap_err(), *expected, "{}", case["input"]);
            } else {
                assert!(actual.is_ok(), "{}", case["input"]);
            }
        }
    }

    #[test]
    fn wake_contract_preserves_defaults_nullable_fields_and_ignores_unknown_keys() {
        let actor = AgentExecutionActor {
            actor_type: "user",
            actor_id: "board".into(),
            run_id: None,
        };
        let request = wake_input(json!({"forceFreshSession":null,"reason":null,"payload":null,"idempotencyKey":"","ignored":"value"}),"org".into(),"agent".into(),&actor,true,false).unwrap();
        assert_eq!(request.source, "on_demand");
        assert_eq!(request.trigger_detail.as_deref(), Some("manual"));
        assert_eq!(request.idempotency_key.as_deref(), Some(""));
        assert_eq!(
            request.context_snapshot,
            json!({"triggeredBy":"board","actorId":"board","forceFreshSession":false})
        );
        assert!(request.payload.is_none());
        for invalid in [
            json!([]),
            json!(null),
            json!({"source":null}),
            json!({"source":"unknown"}),
            json!({"triggerDetail":null}),
            json!({"forceFreshSession":1}),
            json!({"payload":[]}),
            json!({"reason":false}),
            json!({"idempotencyKey":123}),
        ] {
            assert!(
                wake_input(invalid, "org".into(), "agent".into(), &actor, true, false).is_err()
            );
        }
    }
}
