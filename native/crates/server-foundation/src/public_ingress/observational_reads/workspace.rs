use super::*;
use rudder_d1_persistence::{
    StoreError,
    run_workspace_reads::{RunWorkspaceReadInput, RunWorkspaceReadOperation, read_run_workspaces},
};

pub(super) async fn read(
    pool: &sqlx::PgPool,
    org: &str,
    target: Option<&str>,
    query: &Query,
) -> HttpResponse {
    let statuses = if target.is_none() {
        match query.get("status").map(Vec::as_slice) {
            None => None,
            Some([one]) => Some(
                one.split(',')
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(str::to_owned)
                    .collect(),
            ),
            // The old route called split on a repeated query array and failed.
            Some(_) => return internal_error(),
        }
    } else {
        None
    };
    let input = RunWorkspaceReadInput {
        operation: if target.is_some() {
            RunWorkspaceReadOperation::Detail
        } else {
            RunWorkspaceReadOperation::List
        },
        workspace_id: target.map(str::to_owned),
        project_id: if target.is_none() {
            value(query, "projectId")
        } else {
            None
        },
        project_workspace_id: if target.is_none() {
            value(query, "projectWorkspaceId")
        } else {
            None
        },
        issue_id: if target.is_none() {
            value(query, "issueId")
        } else {
            None
        },
        statuses,
        reuse_eligible: target.is_none()
            && query
                .get("reuseEligible")
                .is_some_and(|v| v.as_slice() == ["true"]),
        legacy_date_timezone: Some("UTC".into()),
    };
    match read_run_workspaces(pool, org, &input).await {
        Ok(body) => success(body),
        Err(StoreError::NotFound) => error(StatusCode::NOT_FOUND, "Run workspace not found"),
        Err(_) => internal_error(),
    }
}
