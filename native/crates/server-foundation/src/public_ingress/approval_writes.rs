//! Complete public Approval lifecycle. Identity and bounded HTTP parsing are
//! adapted here; all decisions, comments and effects belong to D1 Rust.
use super::*;
use futures_util::StreamExt;
use rudder_d1_persistence::{
    StoreError,
    approval_writes::{
        ApprovalWriteContext, ApprovalWriteError, ApprovalWriteOperation, apply_approval_write,
        validate_input,
    },
};
use serde_json::{Value, json};

#[derive(Clone, Debug, PartialEq, Eq)]
struct Endpoint {
    operation: ApprovalWriteOperation,
    organization_id: Option<String>,
    approval_id: Option<String>,
}

fn endpoint(path: &str, method: &Method) -> Option<Endpoint> {
    let path = path.strip_prefix('/')?;
    let parts = path
        .strip_suffix('/')
        .unwrap_or(path)
        .split('/')
        .collect::<Vec<_>>();
    if parts.iter().any(|v| v.is_empty()) || !parts.first()?.eq_ignore_ascii_case("api") {
        return None;
    }
    let capture = |value: &str| {
        percent_encoding::percent_decode_str(value)
            .decode_utf8()
            .ok()
            .map(|v| v.into_owned())
    };
    if parts.len() == 4
        && parts[1].eq_ignore_ascii_case("orgs")
        && parts[3].eq_ignore_ascii_case("approvals")
        && *method == Method::POST
    {
        return Some(Endpoint {
            operation: ApprovalWriteOperation::Create,
            organization_id: Some(capture(parts[2])?),
            approval_id: None,
        });
    }
    if parts.len() != 4 || !parts[1].eq_ignore_ascii_case("approvals") {
        return None;
    }
    let operation = match (parts[3].to_ascii_lowercase().as_str(), method.as_str()) {
        ("approve", "POST") => ApprovalWriteOperation::Approve,
        ("reject", "POST") => ApprovalWriteOperation::Reject,
        ("request-revision", "POST") => ApprovalWriteOperation::RequestRevision,
        ("resubmit", "POST") => ApprovalWriteOperation::Resubmit,
        ("comments", "GET" | "HEAD") => ApprovalWriteOperation::ReadComments,
        ("comments", "POST") => ApprovalWriteOperation::CreateComment,
        _ => return None,
    };
    Some(Endpoint {
        operation,
        organization_id: None,
        approval_id: Some(capture(parts[2])?),
    })
}

pub(super) fn is_reserved_path(path: &str, method: &Method) -> bool {
    endpoint(path, method).is_some()
}

pub(super) async fn dispatch_alias(
    state: web::Data<IngressState>,
    request: HttpRequest,
    mut payload: web::Payload,
) -> HttpResponse {
    let Some(endpoint) = endpoint(request.uri().path(), request.method()) else {
        return HttpResponse::NotFound().json(json!({"error":"Not found"}));
    };
    let mut body = Vec::new();
    while let Some(chunk) = payload.next().await {
        let Ok(chunk) = chunk else {
            return HttpResponse::BadRequest().json(json!({"error":"Invalid request body"}));
        };
        if body.len().saturating_add(chunk.len())
            > state
                .foundation
                .config
                .max_request_bytes
                .min(10 * 1024 * 1024)
        {
            return HttpResponse::PayloadTooLarge()
                .json(json!({"error":"Request body is too large"}));
        }
        body.extend_from_slice(&chunk);
    }
    execute(state, request, &body, endpoint).await
}

async fn execute(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: &[u8],
    endpoint: Endpoint,
) -> HttpResponse {
    if let Some(response) = malformed_public_json_response(&request, body) {
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
    let input = if endpoint.operation == ApprovalWriteOperation::ReadComments {
        json!({})
    } else if request
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
    {
        std::str::from_utf8(body)
            .ok()
            .and_then(|raw| rudder_d1_persistence::agent_core::parse_public_json_value(raw).ok())
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    if let Err(error) = validate_input(endpoint.operation, &input) {
        return response_error(error);
    }
    if state.config.identity_auth.is_none() {
        return state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "native_identity_unavailable",
        );
    }
    let identity = match resolve_public_http_identity(&state, &request).await {
        Ok(value) => value,
        Err((status, reason)) => return state.foundation.json_error(status, reason),
    };
    if let Some(response) = agent_run_context_mismatch_response(&request, &identity) {
        return response;
    }
    if let Some(response) = agent_core::agent_cli_context_mismatch_response(&request, &identity) {
        return response;
    }
    let Some((actor, session)) = agent_core::actor_and_session(&identity) else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    if actor.kind != "user"
        && matches!(
            endpoint.operation,
            ApprovalWriteOperation::Approve
                | ApprovalWriteOperation::Reject
                | ApprovalWriteOperation::RequestRevision
        )
    {
        return HttpResponse::Forbidden().json(json!({"error":"Board access required"}));
    }
    if endpoint.operation != ApprovalWriteOperation::ReadComments
        && matches!(&identity, NativeIngressIdentity::Session(_))
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
    let DatabaseState::Configured(pool) = &state.foundation.database else {
        return state
            .foundation
            .json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
    };
    let Some(authorizer) = agent_core::native_authorizer(&identity, &actor, &session, &state)
    else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    let org = match endpoint.organization_id {
        Some(org) => org,
        None => {
            let Some(id) = endpoint
                .approval_id
                .as_deref()
                .and_then(|id| Uuid::parse_str(id).ok())
            else {
                return HttpResponse::NotFound().json(json!({"error":"Approval not found"}));
            };
            match sqlx::query_scalar::<_, String>(
                "SELECT org_id::text FROM approvals WHERE id=$1::uuid",
            )
            .bind(id.to_string())
            .fetch_optional(pool)
            .await
            {
                Ok(Some(org)) => org,
                Ok(None) => {
                    return HttpResponse::NotFound().json(json!({"error":"Approval not found"}));
                }
                Err(_) => return internal_error(),
            }
        }
    };
    if Uuid::parse_str(&org).is_err() {
        return HttpResponse::BadRequest().json(json!({"error":"Validation error"}));
    }
    let Ok(host) = agent_core::approval_host_request(
        &state,
        &org,
        matches!(&identity, NativeIngressIdentity::LocalImplicit),
    ) else {
        return state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "agent_core_host_context_unavailable",
        );
    };
    let Some(key) = state.foundation.config.actor_envelope_key.as_ref() else {
        return state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "actor_envelope_unconfigured",
        );
    };
    let request_id = Uuid::new_v4().to_string();
    let now = unix_time_seconds();
    let action = "approval.public.execute";
    let target = request.uri().to_string();
    let command = json!({"operation":format!("{:?}",endpoint.operation),"organizationId":org,"approvalId":endpoint.approval_id,"input":input});
    let Ok(bytes) = serde_json::to_vec(&command) else {
        return internal_error();
    };
    let verified = ActorEnvelope::new(
        actor.clone(),
        &org,
        &session,
        1,
        ACTOR_ENVELOPE_AUDIENCE,
        request.method().as_str(),
        &target,
        action,
        &bytes,
        &request_id,
        Uuid::new_v4().to_string(),
        now,
        now + 30,
    )
    .and_then(|envelope| envelope.sign_with_key(key))
    .ok()
    .and_then(|envelope| {
        state
            .foundation
            .verify_actor_envelope_parts(
                key,
                &envelope,
                &request,
                &org,
                action,
                None,
                &bytes,
                &request_id,
            )
            .ok()
    });
    let Some(verified) = verified else {
        return state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "actor_envelope_unavailable",
        );
    };
    let run_id = match &identity {
        NativeIngressIdentity::AgentJwt(jwt) => Some(jwt.run_id.as_str()),
        _ => request
            .headers()
            .get("x-rudder-run-id")
            .and_then(|value| value.to_str().ok()),
    };
    let context = ApprovalWriteContext {
        organization_id: &org,
        actor: &verified,
        run_id,
        agent_host: &host,
        authorizer: &authorizer,
        asset_storage: state.config.issue_asset_storage.as_deref().map(|storage| {
            storage as &dyn rudder_d1_persistence::issue_core_writes::IssueAssetStorage
        }),
    };
    match apply_approval_write(
        pool,
        context,
        endpoint.operation,
        endpoint.approval_id.as_deref(),
        &input,
    )
    .await
    {
        Ok(value) => HttpResponse::build(
            if matches!(
                endpoint.operation,
                ApprovalWriteOperation::Create | ApprovalWriteOperation::CreateComment
            ) {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            },
        )
        .json(value),
        Err(error) => response_error(error),
    }
}

fn internal_error() -> HttpResponse {
    HttpResponse::InternalServerError().json(json!({"error":"Internal server error"}))
}
fn http_error(status: u16, message: String, details: Option<Value>) -> HttpResponse {
    let mut body = json!({"error":message});
    if let Some(details) = details {
        body["details"] = details;
    }
    HttpResponse::build(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .json(body)
}
fn response_error(error: ApprovalWriteError) -> HttpResponse {
    use rudder_d1_persistence::{
        agent_core::AgentCoreError, agent_execution::AgentExecutionError,
        issue_core_writes::IssueCoreWriteError,
    };
    match error {
        ApprovalWriteError::Http(status, message, details)
        | ApprovalWriteError::Agent(AgentCoreError::Http(status, message, details))
        | ApprovalWriteError::Execution(AgentExecutionError::Http(status, message, details)) => {
            http_error(status, message, details)
        }
        ApprovalWriteError::Issue(IssueCoreWriteError::Http(status, message)) => {
            http_error(status, message, None)
        }
        ApprovalWriteError::StaleGoal(details) => http_error(
            409,
            "Goal changed before the approved update could be applied".into(),
            Some(details),
        ),
        ApprovalWriteError::Store(StoreError::NotFound) => {
            http_error(404, "Approval not found".into(), None)
        }
        ApprovalWriteError::Store(
            StoreError::PublicIdentityUnauthorized | StoreError::Unauthorized,
        ) => http_error(401, "Unauthorized".into(), None),
        ApprovalWriteError::Store(
            StoreError::PublicIdentityForbidden | StoreError::GoalForbidden,
        ) => http_error(
            403,
            "User does not have access to this organization".into(),
            None,
        ),
        ApprovalWriteError::Store(
            StoreError::InvalidInput | StoreError::OrganizationInvalid(_),
        ) => http_error(422, "Invalid Approval request".into(), None),
        ApprovalWriteError::Store(
            StoreError::GoalConflict
            | StoreError::NotOwned
            | StoreError::IdempotencyConflict
            | StoreError::StaleFence
            | StoreError::StaleVersion,
        ) => http_error(
            409,
            "Approval operation conflicts with current state".into(),
            None,
        ),
        error => {
            tracing::warn!(error=%error,"native Approval write failed");
            internal_error()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aliases_cover_only_approval_owned_methods() {
        assert!(is_reserved_path(
            "/API/approvals/abc/APPROVE/",
            &Method::POST
        ));
        assert!(is_reserved_path(
            "/api/approvals/abc/comments",
            &Method::GET
        ));
        assert!(is_reserved_path("/api/orgs/abc/approvals", &Method::POST));
        assert!(!is_reserved_path("/api/approvals/abc/issues", &Method::GET));
        assert!(!is_reserved_path(
            "/api/approvals/abc/approve",
            &Method::GET
        ));
    }
}
