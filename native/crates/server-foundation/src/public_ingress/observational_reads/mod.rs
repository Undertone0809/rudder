//! Public observational GET/HEAD cutover. Existing D1 readers own SQL and
//! projection; these modules own native identity, scope, references and input.
mod activity;
mod overview;
mod workspace;

use super::*;
use crate::{
    member_directory_auth::MemberDirectoryNativeAccess, native_session_auth::NativeIngressIdentity,
};
use actix_web::http::Method;
use futures_util::StreamExt;
use serde_json::{Value, json};
use sqlx::Row;
use std::collections::HashMap;

enum Endpoint {
    Activity(String),
    IssueActivity(String),
    Ledger(String, String),
    IssueRuns(String),
    RunIssues(String, bool),
    Overview(String, bool),
    WorkspaceList(String),
    Workspace(String),
}

fn endpoint(path: &str, method: &Method) -> Option<Endpoint> {
    if !matches!(*method, Method::GET | Method::HEAD) {
        return None;
    }
    let path = path.strip_prefix('/')?;
    let path = path.strip_suffix('/').unwrap_or(path);
    let parts = path.split('/').collect::<Vec<_>>();
    if parts.iter().any(|p| p.is_empty()) || !parts.first()?.eq_ignore_ascii_case("api") {
        return None;
    }
    let is = |at: usize, value: &str| parts.get(at).is_some_and(|p| p.eq_ignore_ascii_case(value));
    let raw = |at: usize| parts[at].to_owned();
    match parts.len() {
        4 if is(1, "orgs") && is(3, "activity") => Some(Endpoint::Activity(raw(2))),
        4 if is(1, "issues") && is(3, "activity") => Some(Endpoint::IssueActivity(raw(2))),
        4 if is(1, "issues") && is(3, "runs") => Some(Endpoint::IssueRuns(raw(2))),
        4 if (is(1, "heartbeat-runs") || is(1, "agent-runs")) && is(3, "issues") => {
            Some(Endpoint::RunIssues(raw(2), is(1, "heartbeat-runs")))
        }
        6 if is(1, "orgs") && is(3, "users") && is(5, "activity-ledger") => {
            Some(Endpoint::Ledger(raw(2), raw(4)))
        }
        4 if is(1, "orgs") && is(3, "dashboard") => Some(Endpoint::Overview(raw(2), false)),
        5 if is(1, "orgs") && is(3, "budgets") && is(4, "overview") => {
            Some(Endpoint::Overview(raw(2), true))
        }
        4 if is(1, "orgs") && (is(3, "run-workspaces") || is(3, "execution-workspaces")) => {
            Some(Endpoint::WorkspaceList(raw(2)))
        }
        3 if is(1, "run-workspaces") || is(1, "execution-workspaces") => {
            Some(Endpoint::Workspace(raw(2)))
        }
        _ => None,
    }
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
        body.extend_from_slice(&chunk);
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
    let DatabaseState::Configured(pool) = &state.foundation.database else {
        return state
            .foundation
            .json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
    };
    let identity = match resolve_public_http_identity(&state, &request).await {
        Ok(identity) => identity,
        Err((status, reason)) => return state.foundation.json_error(status, reason),
    };
    if let Some(response) = agent_run_context_mismatch_response(&request, &identity) {
        return response;
    }
    let Some((actor, session_id)) = agent_core::actor_and_session(&identity) else {
        return error(StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    let Some(auth) = agent_core::native_authorizer(&identity, &actor, &session_id, &state) else {
        return error(StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    // Authentication precedes all target lookups, including missing or malformed IDs.
    let (org, target) = match resolve_target(pool, &state, &identity, &auth, &endpoint).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return internal_error(),
    };
    if sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return internal_error();
    }
    match auth.revalidate(&mut tx, &org).await {
        Ok(MemberDirectoryNativeAccess::Authorized) => (),
        Ok(MemberDirectoryNativeAccess::Unauthorized) => {
            return error(StatusCode::UNAUTHORIZED, "Unauthorized");
        }
        Ok(MemberDirectoryNativeAccess::Forbidden) => {
            return project_reads::forbidden_response(&identity);
        }
        Err(_) => return internal_error(),
    }
    if tx.commit().await.is_err() {
        return internal_error();
    }
    let query = query_values(request.query_string());
    match endpoint {
        Endpoint::Activity(_)
        | Endpoint::IssueActivity(_)
        | Endpoint::Ledger(_, _)
        | Endpoint::IssueRuns(_)
        | Endpoint::RunIssues(_, _) => {
            activity::read(pool, &org, target.as_deref(), &identity, &query, endpoint).await
        }
        Endpoint::Overview(_, budget) => overview::read(pool, &org, budget).await,
        Endpoint::WorkspaceList(_) | Endpoint::Workspace(_) => {
            workspace::read(pool, &org, target.as_deref(), &query).await
        }
    }
}

#[allow(clippy::result_large_err)]
fn decode(raw: &str) -> Result<String, HttpResponse> {
    percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .map(|value| value.into_owned())
        .map_err(|_| error(StatusCode::BAD_REQUEST, "Invalid request path"))
}

#[allow(clippy::result_large_err)]
async fn resolve_target(
    pool: &sqlx::PgPool,
    state: &IngressState,
    identity: &NativeIngressIdentity,
    auth: &crate::member_directory_auth::MemberDirectoryNativeAuth<'_>,
    endpoint: &Endpoint,
) -> Result<(String, Option<String>), HttpResponse> {
    match endpoint {
        Endpoint::Activity(org)
        | Endpoint::Ledger(org, _)
        | Endpoint::Overview(org, _)
        | Endpoint::WorkspaceList(org) => Ok((decode(org)?, None)),
        Endpoint::IssueActivity(id) | Endpoint::IssueRuns(id) => {
            run_reads::resolve_issue_reference(pool, &decode(id)?)
                .await
                .map_err(|_| internal_error())?
                .map(|(id, org)| (org, Some(id)))
                .ok_or_else(|| error(StatusCode::NOT_FOUND, "Issue not found"))
        }
        Endpoint::RunIssues(id, heartbeat) => run_reads::resolve_run_reference(
            pool,
            state,
            identity,
            auth,
            &decode(id)?,
            if *heartbeat {
                "Heartbeat run not found"
            } else {
                "Agent run not found"
            },
        )
        .await
        .map(|(id, org)| (org, Some(id))),
        Endpoint::Workspace(id) => {
            let row = sqlx::query("SELECT id::text id,org_id::text org_id FROM execution_workspaces WHERE id=$1::uuid")
                .bind(decode(id)?)
                .fetch_optional(pool)
                .await
                .map_err(|_| internal_error())?
                .ok_or_else(|| error(StatusCode::NOT_FOUND, "Run workspace not found"))?;
            Ok((
                row.try_get("org_id").map_err(|_| internal_error())?,
                Some(row.try_get("id").map_err(|_| internal_error())?),
            ))
        }
    }
}

type Query = HashMap<String, Vec<String>>;
fn query_values(raw: &str) -> Query {
    let mut result = Query::new();
    for (key, value) in url::form_urlencoded::parse(raw.as_bytes()) {
        result
            .entry(key.into_owned())
            .or_default()
            .push(value.into_owned());
    }
    result
}
fn string(query: &Query, key: &str) -> Option<String> {
    match query.get(key)?.as_slice() {
        [value] if !value.trim().is_empty() => Some(value.clone()),
        _ => None,
    }
}
fn value(query: &Query, key: &str) -> Option<Value> {
    query
        .get(key)
        .map(|v| if v.len() == 1 { json!(v[0]) } else { json!(v) })
}
#[allow(clippy::result_large_err)]
fn positive_limit(query: &Query) -> Result<Option<f64>, HttpResponse> {
    let Some(values) = query.get("limit") else {
        return Ok(None);
    };
    let invalid = || error(StatusCode::BAD_REQUEST, "invalid 'limit' value");
    let [raw] = values.as_slice() else {
        return Err(invalid());
    };
    if raw.trim().is_empty() {
        return Err(invalid());
    }
    let parsed = run_reads::js_number(raw).ok_or_else(invalid)?;
    if !parsed.is_finite() || parsed.fract() != 0.0 || parsed < 1.0 {
        return Err(invalid());
    }
    Ok(Some(parsed))
}
fn error(status: StatusCode, message: &str) -> HttpResponse {
    HttpResponse::build(status).json(json!({"error":message}))
}
fn internal_error() -> HttpResponse {
    error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}
fn success(body: String) -> HttpResponse {
    HttpResponse::Ok()
        .content_type("application/json")
        .body(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reserves_all_twelve_read_shapes_and_both_methods() {
        for path in [
            "/api/orgs/o/activity",
            "/api/issues/i/activity",
            "/api/issues/i/runs",
            "/api/heartbeat-runs/r/issues",
            "/api/agent-runs/r/issues",
            "/api/orgs/o/users/me/activity-ledger",
            "/api/orgs/o/dashboard",
            "/api/orgs/o/budgets/overview",
            "/api/orgs/o/run-workspaces",
            "/api/orgs/o/execution-workspaces",
            "/api/run-workspaces/w",
            "/api/execution-workspaces/w",
        ] {
            for method in [Method::GET, Method::HEAD] {
                assert!(is_reserved_path(path, &method), "{path}");
                assert!(is_reserved_path(
                    &format!("{}/", path.to_uppercase()),
                    &method
                ));
            }
            assert!(!is_reserved_path(path, &Method::POST));
        }
        for path in [
            "/api/orgs/o/dashboard/skills/analytics",
            "/api/agent-runs/r/events",
            "/api//activity",
        ] {
            assert!(!is_reserved_path(path, &Method::GET));
        }
    }
}
