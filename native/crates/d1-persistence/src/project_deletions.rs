use crate::{CommittedMutation, ProjectDeleteCommand, StoreError, transaction};
use serde_json::{Value, json};
use sqlx::Row;

struct ProjectDeleteSnapshot {
    id: String,
    org_id: String,
    goal_id: Option<String>,
    name: String,
    description: Option<String>,
    status: String,
    lead_agent_id: Option<String>,
    target_date: Option<String>,
    color: Option<String>,
    icon: Option<String>,
    pause_reason: Option<String>,
    paused_at: Option<String>,
    execution_workspace_policy: Option<Value>,
    archived_at: Option<String>,
    created_at: String,
    updated_at: String,
}

pub(crate) async fn apply(
    tx: &mut transaction::Tx<'_>,
    command: ProjectDeleteCommand,
    metadata: &transaction::Metadata,
) -> Result<CommittedMutation, StoreError> {
    // This organization lock serializes Project deletion with ownership
    // transfer, organization deletion, and Node's legacy Project writers.
    transaction::lock_organization_boundary(tx, metadata).await?;
    transaction::authorize_project_delete_caller(tx, metadata).await?;
    if let Some(receipt) = transaction::replay(tx, metadata).await? {
        return Ok(receipt);
    }

    let scope = transaction::lock_scope_for_project_delete(tx, metadata).await?;
    metadata.check_fresh(scope.version, scope.fence_epoch)?;

    let row = sqlx::query(
        "SELECT id::text,
                org_id::text,
                goal_id::text AS goal_id,
                name,
                description,
                status,
                lead_agent_id::text AS lead_agent_id,
                target_date::text AS target_date,
                color,
                icon,
                pause_reason,
                CASE WHEN paused_at IS NULL THEN NULL ELSE
                  to_char(paused_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
                END AS paused_at,
                execution_workspace_policy,
                CASE WHEN archived_at IS NULL THEN NULL ELSE
                  to_char(archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
                END AS archived_at,
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at,
                to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at
         FROM projects
         WHERE id=$1::uuid AND org_id=$2::uuid
         FOR UPDATE",
    )
    .bind(&command.project_id)
    .bind(&command.organization_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(StoreError::NotFound)?;
    let snapshot = ProjectDeleteSnapshot {
        id: row.try_get("id")?,
        org_id: row.try_get("org_id")?,
        goal_id: row.try_get("goal_id")?,
        name: row.try_get("name")?,
        description: row.try_get("description")?,
        status: row.try_get("status")?,
        lead_agent_id: row.try_get("lead_agent_id")?,
        target_date: row.try_get("target_date")?,
        color: row.try_get("color")?,
        icon: row.try_get("icon")?,
        pause_reason: row.try_get("pause_reason")?,
        paused_at: row.try_get("paused_at")?,
        execution_workspace_policy: row.try_get("execution_workspace_policy")?,
        archived_at: row.try_get("archived_at")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    };
    let response = project_response(snapshot);

    let deleted = sqlx::query("DELETE FROM projects WHERE id=$1::uuid AND org_id=$2::uuid")
        .bind(&command.project_id)
        .bind(&command.organization_id)
        .execute(&mut **tx)
        .await?;
    if deleted.rows_affected() != 1 {
        return Err(StoreError::NotFound);
    }

    let version = scope
        .version
        .checked_add(1)
        .ok_or(StoreError::VersionRange)?;
    transaction::signed(version)?;
    transaction::persist_project_delete(tx, metadata, version, scope.fence_epoch, response).await
}

fn project_response(row: ProjectDeleteSnapshot) -> Value {
    let url_key = derive_project_url_key(&row.name, &row.id);
    json!({
        "id": row.id,
        "orgId": row.org_id,
        "goalId": row.goal_id,
        "name": row.name,
        "description": row.description,
        "status": row.status,
        "leadAgentId": row.lead_agent_id,
        "targetDate": row.target_date,
        "color": row.color,
        "icon": row.icon.unwrap_or_else(|| "folder".to_owned()),
        "pauseReason": row.pause_reason,
        "pausedAt": row.paused_at,
        "executionWorkspacePolicy": row.execution_workspace_policy,
        "archivedAt": row.archived_at,
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
        "urlKey": url_key,
    })
}

fn derive_project_url_key(name: &str, fallback: &str) -> String {
    fn normalize(value: &str) -> Option<String> {
        let mut normalized = String::new();
        let mut pending_delimiter = false;
        for character in value.trim().to_lowercase().chars() {
            if character.is_ascii_lowercase() || character.is_ascii_digit() {
                if pending_delimiter && !normalized.is_empty() {
                    normalized.push('-');
                }
                pending_delimiter = false;
                normalized.push(character);
            } else {
                pending_delimiter = true;
            }
        }
        (!normalized.is_empty()).then_some(normalized)
    }

    normalize(name)
        .or_else(|| normalize(fallback))
        .unwrap_or_else(|| "project".to_owned())
}

#[cfg(test)]
mod tests {
    use super::derive_project_url_key;

    #[test]
    fn project_url_key_matches_shared_normalization_and_fallback() {
        assert_eq!(derive_project_url_key("  Work Plan  ", "id"), "work-plan");
        assert_eq!(
            derive_project_url_key("東京", "20000000-0000-4000-8000-000000000001"),
            "20000000-0000-4000-8000-000000000001"
        );
        assert_eq!(derive_project_url_key("!!!", "id"), "id");
        assert_eq!(derive_project_url_key("!!!", "!!!"), "project");
    }
}
