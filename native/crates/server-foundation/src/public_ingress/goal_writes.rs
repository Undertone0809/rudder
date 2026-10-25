//! Direct public Rust ingress for Goal writes whose transitions do not need
//! the legacy Node wakeup dispatcher. Matched paths never proxy to Node.

use super::*;
use crate::native_session_auth::NativeIngressIdentity;
use actix_web::http::Method;
use futures_util::StreamExt;
use rudder_d1_persistence::{
    StoreError,
    goal_writes::{GoalWriteContext, GoalWriteOperation, apply_goal_write},
};
use serde_json::{Map, Value, json};
use uuid::Uuid;

#[derive(Clone, Debug, Eq, PartialEq)]
enum Endpoint {
    Create { organization_id: String },
    Update { goal_id: String },
    Activate { goal_id: String },
    UpdatePlan { goal_id: String },
    CreateActivity { goal_id: String },
    AssignOwner { goal_id: String },
    Delete { goal_id: String },
}

pub(super) fn is_reserved_path(path: &str, method: &Method) -> bool {
    endpoint_for_path(path, method).is_some()
}

pub(super) async fn create(
    state: web::Data<IngressState>,
    request: HttpRequest,
    payload: web::Payload,
) -> HttpResponse {
    dispatch_alias(state, request, payload).await
}

pub(super) async fn dispatch_alias(
    state: web::Data<IngressState>,
    request: HttpRequest,
    mut payload: web::Payload,
) -> HttpResponse {
    let Some(endpoint) = endpoint_for_path(request.uri().path(), request.method()) else {
        return HttpResponse::NotFound().json(json!({"error":"Goal route not found"}));
    };
    let max_bytes = state
        .foundation
        .config
        .max_request_bytes
        .min(10 * 1024 * 1024);
    let mut body = Vec::new();
    while let Some(chunk) = payload.next().await {
        let Ok(chunk) = chunk else {
            return HttpResponse::BadRequest().json(json!({"error":"Invalid request body"}));
        };
        if body.len().saturating_add(chunk.len()) > max_bytes {
            return HttpResponse::PayloadTooLarge().json(json!({"error":"Request body too large"}));
        }
        body.extend_from_slice(&chunk);
    }
    execute(state, request, web::Bytes::from(body), endpoint).await
}

fn endpoint_for_path(path: &str, method: &Method) -> Option<Endpoint> {
    let path = path.strip_prefix('/')?;
    let path = path.strip_suffix('/').unwrap_or(path);
    let parts = path.split('/').collect::<Vec<_>>();
    if parts.iter().any(|part| part.is_empty()) {
        return None;
    }
    if parts.len() == 4
        && parts[0].eq_ignore_ascii_case("api")
        && parts[1].eq_ignore_ascii_case("orgs")
        && parts[3].eq_ignore_ascii_case("goals")
        && *method == Method::POST
    {
        return Some(Endpoint::Create {
            organization_id: decode_capture(parts[2])?,
        });
    }
    if parts.len() == 3
        && parts[0].eq_ignore_ascii_case("api")
        && parts[1].eq_ignore_ascii_case("goals")
    {
        let goal_id = decode_capture(parts[2])?;
        return match *method {
            Method::PATCH => Some(Endpoint::Update { goal_id }),
            Method::DELETE => Some(Endpoint::Delete { goal_id }),
            _ => None,
        };
    }
    if parts.len() == 4
        && parts[0].eq_ignore_ascii_case("api")
        && parts[1].eq_ignore_ascii_case("goals")
    {
        let goal_id = decode_capture(parts[2])?;
        return match (parts[3].to_ascii_lowercase().as_str(), method.as_str()) {
            ("activate", "POST") => Some(Endpoint::Activate { goal_id }),
            ("plan", "POST") => Some(Endpoint::UpdatePlan { goal_id }),
            ("activities", "POST") => Some(Endpoint::CreateActivity { goal_id }),
            ("owner", "POST") => Some(Endpoint::AssignOwner { goal_id }),
            _ => None,
        };
    }
    None
}

fn decode_capture(value: &str) -> Option<String> {
    percent_encoding::percent_decode_str(value)
        .decode_utf8()
        .ok()
        .map(|value| value.into_owned())
}

async fn execute(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: web::Bytes,
    endpoint: Endpoint,
) -> HttpResponse {
    if let Some(response) = malformed_public_json_response(&request, &body) {
        return response;
    }
    if let Some(response) = private_host_rejection(&state, &request) {
        return response;
    }
    let operation = match &endpoint {
        Endpoint::Create { .. } => GoalWriteOperation::Create,
        Endpoint::Update { .. } => GoalWriteOperation::Update,
        Endpoint::Activate { .. } => GoalWriteOperation::Activate,
        Endpoint::UpdatePlan { .. } => GoalWriteOperation::UpdatePlan,
        Endpoint::CreateActivity { .. } => GoalWriteOperation::CreateActivity,
        Endpoint::AssignOwner { .. } => GoalWriteOperation::AssignOwner,
        Endpoint::Delete { .. } => GoalWriteOperation::Delete,
    };
    let input = match normalized_body(&request, &body, operation) {
        Ok(value) => value,
        Err(BodyNormalizationError::BadRequest) => {
            return HttpResponse::BadRequest().json(json!({"error":"Invalid Goal request"}));
        }
        Err(BodyNormalizationError::InvalidJson) => {
            return HttpResponse::InternalServerError()
                .json(json!({"error":"Internal server error"}));
        }
    };
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
    let permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(_) => {
            return state
                .foundation
                .json_error(StatusCode::SERVICE_UNAVAILABLE, "request_queue_full");
        }
    };
    let Some((actor, session_id)) = agent_core::actor_and_session(&identity) else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    let Some(authorizer) = agent_core::native_authorizer(&identity, &actor, &session_id, &state)
    else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    let DatabaseState::Configured(pool) = &state.foundation.database else {
        return state
            .foundation
            .json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
    };

    let (operation, route_organization_id, goal_id, status) = match endpoint {
        Endpoint::Create { organization_id } => (
            GoalWriteOperation::Create,
            Some(organization_id),
            None,
            StatusCode::CREATED,
        ),
        Endpoint::Update { goal_id } => (
            GoalWriteOperation::Update,
            None,
            Some(goal_id),
            StatusCode::OK,
        ),
        Endpoint::Activate { goal_id } => (
            GoalWriteOperation::Activate,
            None,
            Some(goal_id),
            StatusCode::OK,
        ),
        Endpoint::UpdatePlan { goal_id } => (
            GoalWriteOperation::UpdatePlan,
            None,
            Some(goal_id),
            StatusCode::CREATED,
        ),
        Endpoint::CreateActivity { goal_id } => (
            GoalWriteOperation::CreateActivity,
            None,
            Some(goal_id),
            StatusCode::CREATED,
        ),
        Endpoint::AssignOwner { goal_id } => (
            GoalWriteOperation::AssignOwner,
            None,
            Some(goal_id),
            StatusCode::OK,
        ),
        Endpoint::Delete { goal_id } => (
            GoalWriteOperation::Delete,
            None,
            Some(goal_id),
            StatusCode::OK,
        ),
    };
    let organization_id = if let Some(organization_id) = route_organization_id {
        organization_id
    } else if let Some(goal_id) = goal_id.as_deref() {
        match resolve_goal_organization(
            pool,
            goal_id,
            (actor.kind == "agent").then_some(actor.id.as_str()),
        )
        .await
        {
            Ok(Some(organization_id)) => organization_id,
            Ok(None) => return HttpResponse::NotFound().json(json!({"error":"Goal not found"})),
            Err(_) => {
                return state
                    .foundation
                    .json_error(StatusCode::INTERNAL_SERVER_ERROR, "goal_write_failed");
            }
        }
    } else {
        return HttpResponse::NotFound().json(json!({"error":"Goal not found"}));
    };
    let organization_id = match Uuid::parse_str(&organization_id) {
        Ok(value) => value.to_string(),
        Err(_) => return HttpResponse::NotFound().json(json!({"error":"Goal not found"})),
    };
    let run_id = identity_run_id(&identity);
    let context = GoalWriteContext {
        organization_id: &organization_id,
        actor_kind: actor.kind.as_str(),
        actor_id: actor.id.as_str(),
        actor_agent_id: (actor.kind == "agent").then_some(actor.id.as_str()),
        run_id: run_id.as_deref(),
    };
    // Keep the admission permit alive until the transaction and response are complete.
    let _permit = permit;
    match apply_goal_write(
        pool,
        &authorizer,
        context,
        operation,
        goal_id.as_deref(),
        &input,
    )
    .await
    {
        Ok(value) => HttpResponse::build(status).json(value),
        Err(error) => goal_write_error(&state, error),
    }
}

async fn resolve_goal_organization(
    pool: &sqlx::PgPool,
    goal_id: &str,
    actor_agent_id: Option<&str>,
) -> Result<Option<String>, sqlx::Error> {
    if let Ok(goal_id) = Uuid::parse_str(goal_id) {
        return sqlx::query_scalar("SELECT org_id::text FROM goals WHERE id=$1::uuid")
            .bind(goal_id.to_string())
            .fetch_optional(pool)
            .await;
    }
    let Some(actor_agent_id) = actor_agent_id else {
        return Ok(None);
    };
    sqlx::query_scalar("SELECT org_id::text FROM agents WHERE id=$1::uuid")
        .bind(actor_agent_id)
        .fetch_optional(pool)
        .await
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BodyNormalizationError {
    BadRequest,
    InvalidJson,
}

fn normalized_body(
    request: &HttpRequest,
    body: &[u8],
    operation: GoalWriteOperation,
) -> Result<Value, BodyNormalizationError> {
    let is_delete = operation == GoalWriteOperation::Delete;
    let mut value = if body.is_empty() {
        Value::Object(Map::new())
    } else if request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .eq_ignore_ascii_case("application/json")
        })
    {
        serde_json::from_slice::<Value>(body).map_err(|_| BodyNormalizationError::InvalidJson)?
    } else {
        Value::Object(Map::new())
    };
    if is_delete {
        return Ok(Value::Object(Map::new()));
    }
    if !value.is_object() {
        return Err(BodyNormalizationError::BadRequest);
    }
    let allowed: &[&str] = match operation {
        GoalWriteOperation::Create => &[
            "title",
            "description",
            "alignmentQuestion",
            "targetTime",
            "level",
            "status",
            "parentId",
            "ownerAgentId",
            "ownerAgentRuntimeOverrides",
        ],
        GoalWriteOperation::Update => &[
            "title",
            "description",
            "alignmentQuestion",
            "ownerAgentId",
            "ownerAgentRuntimeOverrides",
            "targetTime",
        ],
        GoalWriteOperation::Activate => &[
            "confirmed",
            "ownerAgentId",
            "outcomeStatement",
            "objectiveMode",
            "criteria",
            "autonomyEnvelope",
            "humanAuthorities",
            "evaluationPolicy",
            "actionDeadline",
            "evaluationDeadline",
            "initialContinuation",
            "initialPlan",
        ],
        GoalWriteOperation::UpdatePlan => &[
            "summary",
            "hypotheses",
            "selectedPaths",
            "rejectedPaths",
            "sequencing",
            "budgetAllocations",
            "invalidationConditions",
        ],
        GoalWriteOperation::CreateActivity => &[
            "summary",
            "activityKind",
            "commitmentRef",
            "runRef",
            "evidenceRefs",
            "idempotencyKey",
            "occurredAt",
        ],
        GoalWriteOperation::AssignOwner => &["agentId", "authorityRef"],
        _ => &[],
    };
    let Some(object) = value.as_object_mut() else {
        return Err(BodyNormalizationError::BadRequest);
    };
    if matches!(
        operation,
        GoalWriteOperation::Update
            | GoalWriteOperation::CreateActivity
            | GoalWriteOperation::AssignOwner
    ) && object.keys().any(|key| !allowed.contains(&key.as_str()))
    {
        return Err(BodyNormalizationError::BadRequest);
    }
    object.retain(|key, _| allowed.contains(&key.as_str()));
    if operation == GoalWriteOperation::Activate {
        normalize_activation(object);
    }
    if operation == GoalWriteOperation::UpdatePlan {
        for key in [
            "hypotheses",
            "selectedPaths",
            "rejectedPaths",
            "sequencing",
            "invalidationConditions",
        ] {
            object.entry(key).or_insert_with(|| json!([]));
        }
        object
            .entry("budgetAllocations")
            .or_insert_with(|| json!({}));
    }
    if operation == GoalWriteOperation::CreateActivity {
        object.entry("evidenceRefs").or_insert_with(|| json!([]));
    }
    Ok(value)
}

fn normalize_activation(object: &mut Map<String, Value>) {
    for key in ["autonomyEnvelope", "humanAuthorities", "evaluationPolicy"] {
        object.entry(key).or_insert_with(|| json!({}));
    }
    if let Some(continuation) = object
        .get_mut("initialContinuation")
        .and_then(Value::as_object_mut)
    {
        continuation.retain(|key, _| ["kind", "summary", "wakeCondition"].contains(&key.as_str()));
    }
    if let Some(plan) = object.get_mut("initialPlan").and_then(Value::as_object_mut) {
        plan.retain(|key, _| {
            [
                "summary",
                "hypotheses",
                "selectedPaths",
                "rejectedPaths",
                "sequencing",
                "budgetAllocations",
                "invalidationConditions",
            ]
            .contains(&key.as_str())
        });
        for key in [
            "hypotheses",
            "selectedPaths",
            "rejectedPaths",
            "sequencing",
            "invalidationConditions",
        ] {
            plan.entry(key).or_insert_with(|| json!([]));
        }
        plan.entry("budgetAllocations").or_insert_with(|| json!({}));
    }
    if let Some(criteria) = object.get_mut("criteria").and_then(Value::as_array_mut) {
        for criterion in criteria {
            if let Some(criterion) = criterion.as_object_mut() {
                criterion.retain(|key, _| {
                    ["id", "label", "evaluator", "evidenceRequirements"].contains(&key.as_str())
                });
            }
        }
    }
}

fn identity_run_id(identity: &NativeIngressIdentity) -> Option<String> {
    match identity {
        NativeIngressIdentity::AgentJwt(identity) => Some(identity.run_id.clone()),
        _ => None,
    }
}

fn goal_write_error(state: &IngressState, error: StoreError) -> HttpResponse {
    match error {
        StoreError::NotFound => HttpResponse::NotFound().json(json!({"error":"Goal not found"})),
        StoreError::PublicIdentityUnauthorized | StoreError::Unauthorized => {
            HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}))
        }
        StoreError::PublicIdentityForbidden | StoreError::GoalForbidden => {
            HttpResponse::Forbidden().json(json!({"error":"Forbidden"}))
        }
        StoreError::InvalidInput => {
            HttpResponse::UnprocessableEntity().json(json!({"error":"Invalid Goal request"}))
        }
        StoreError::GoalConflict | StoreError::NotOwned => {
            HttpResponse::Conflict().json(json!({"error":"Goal changed; reload and retry"}))
        }
        other => state.foundation.mutation_error(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_goal_write_routes_leave_wakeup_workflows_on_the_existing_path() {
        let native = [
            ("/api/orgs/org-1/goals", Method::POST),
            ("/API/ORGS/org-1/GOALS/", Method::POST),
            (
                "/api/goals/11111111-1111-4111-8111-111111111111",
                Method::PATCH,
            ),
            ("/api/goals/gol_abcdef01", Method::DELETE),
            ("/api/goals/gol_abcdef01/activate", Method::POST),
            ("/api/goals/gol_abcdef01/plan", Method::POST),
            ("/api/goals/gol_abcdef01/activities", Method::POST),
            ("/api/goals/gol_abcdef01/owner", Method::POST),
        ];
        for (path, method) in native {
            assert!(is_reserved_path(path, &method), "{method} {path}");
            assert!(
                endpoint_for_path(path, &method).is_some(),
                "{method} {path}"
            );
        }

        for path in [
            "/api/goals/gol_abcdef01/focus",
            "/api/goals/gol_abcdef01/checkpoint",
            "/api/goals/gol_abcdef01/feedback",
            "/api/goals/gol_abcdef01/change-proposals",
            "/api/goals/gol_abcdef01/result-proposals",
            "/api/orgs/org-1/goals/start",
            "/api/orgs/org-1/goals/start-preview",
        ] {
            assert!(!is_reserved_path(path, &Method::POST), "POST {path}");
        }
        assert!(!is_reserved_path("/api/goals/gol_abcdef01", &Method::POST));
    }
}
