use super::{Result, http};
use sqlx::{Postgres, Row, Transaction};

/// Lock the optional primary-Issue reference chain in the same order used by
/// its foreign-key delete paths: Project, ProjectWorkspace, then Issue. The
/// unlocked references are hints only; callers must compare the returned
/// Issue id with the locked Conversation before relying on this path.
pub(super) async fn lock_primary_issue_path_before_conversation(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    conversation_id: &str,
) -> Result<Option<String>> {
    let conversation = sqlx::query(
        "SELECT primary_issue_id::text AS primary_issue_id
         FROM chat_conversations
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(organization_id)
    .bind(conversation_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(404, "Chat conversation not found"))?;
    let issue_id: Option<String> = conversation.try_get("primary_issue_id")?;
    let Some(issue_id) = issue_id else {
        return Ok(None);
    };

    let issue_hint = sqlx::query(
        "SELECT project_id::text AS project_id,
                project_workspace_id::text AS project_workspace_id
         FROM issues
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(organization_id)
    .bind(&issue_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(409, "Chat primary Issue changed"))?;
    let issue_project_id: Option<String> = issue_hint.try_get("project_id")?;
    let issue_workspace_id: Option<String> = issue_hint.try_get("project_workspace_id")?;

    let workspace_project_id = if let Some(workspace_id) = issue_workspace_id.as_deref() {
        let workspace = sqlx::query(
            "SELECT project_id::text AS project_id
             FROM project_workspaces
             WHERE org_id=$1::uuid AND id=$2::uuid",
        )
        .bind(organization_id)
        .bind(workspace_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| http(409, "Chat primary Issue workspace changed"))?;
        Some(workspace.try_get::<String, _>("project_id")?)
    } else {
        None
    };

    let project_id = match (issue_project_id.as_deref(), workspace_project_id.as_deref()) {
        (Some(issue_project), Some(workspace_project)) if issue_project != workspace_project => {
            return Err(http(409, "Chat primary Issue workspace changed"));
        }
        (Some(issue_project), _) => Some(issue_project),
        (None, Some(workspace_project)) => Some(workspace_project),
        (None, None) => None,
    };

    if let Some(project_id) = project_id {
        let project = sqlx::query_scalar::<_, String>(
            "/* native_chat_claim_project_prelock */
             SELECT id::text FROM projects
             WHERE org_id=$1::uuid AND id=$2::uuid FOR SHARE",
        )
        .bind(organization_id)
        .bind(project_id)
        .fetch_optional(&mut **tx)
        .await?;
        if project.is_none() {
            return Err(http(409, "Chat primary Issue project changed"));
        }
    }

    if let (Some(workspace_id), Some(expected_project_id)) = (
        issue_workspace_id.as_deref(),
        workspace_project_id.as_deref(),
    ) {
        let locked_workspace = sqlx::query_scalar::<_, String>(
            "/* native_chat_claim_workspace_prelock */
             SELECT project_id::text FROM project_workspaces
             WHERE org_id=$1::uuid AND id=$2::uuid FOR SHARE",
        )
        .bind(organization_id)
        .bind(workspace_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| http(409, "Chat primary Issue workspace changed"))?;
        if locked_workspace != expected_project_id {
            return Err(http(409, "Chat primary Issue workspace changed"));
        }
    }

    let locked_issue = sqlx::query(
        "/* native_chat_claim_issue_prelock */
         SELECT project_id::text AS project_id,
                project_workspace_id::text AS project_workspace_id
         FROM issues
         WHERE org_id=$1::uuid AND id=$2::uuid FOR SHARE",
    )
    .bind(organization_id)
    .bind(&issue_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(409, "Chat primary Issue changed"))?;
    let locked_project_id: Option<String> = locked_issue.try_get("project_id")?;
    let locked_workspace_id: Option<String> = locked_issue.try_get("project_workspace_id")?;
    if locked_project_id != issue_project_id || locked_workspace_id != issue_workspace_id {
        return Err(http(409, "Chat primary Issue context changed"));
    }

    Ok(Some(issue_id))
}

/// Reject a stale Run→Agent association before reading Issue or Project hints.
/// The Conversation is revalidated after its lock as well.
pub(super) async fn verify_selected_agent_hint(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    conversation_id: &str,
    expected_agent_id: &str,
) -> Result<()> {
    let conversation = sqlx::query(
        "/* native_chat_claim_selected_agent_precheck */
         SELECT COALESCE(preferred_agent_id, routed_agent_id)::text AS selected_agent_id
         FROM chat_conversations WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(organization_id)
    .bind(conversation_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(404, "Chat conversation not found"))?;
    let selected_agent_id: Option<String> = conversation.try_get("selected_agent_id")?;
    if selected_agent_id.as_deref() != Some(expected_agent_id) {
        return Err(http(409, "Native Chat selected Agent changed"));
    }
    Ok(())
}
