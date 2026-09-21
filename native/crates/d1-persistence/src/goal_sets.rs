use crate::{CommittedMutation, Outcome, ResultState, StoreError, transaction};
use rudder_project_goal_link_core::ProjectGoalSetReplacementCommand;
use serde_json::json;
use sqlx::Row;

/// Persist the complete Project goal set as one fenced business mutation.
///
/// The join-table replacement, legacy `projects.goal_id` projection, mutation
/// version, activity row, and immutable receipt all share the caller's
/// transaction. Any failed step is rolled back by `transaction::finish`.
pub(crate) async fn apply(
    tx: &mut transaction::Tx<'_>,
    command: ProjectGoalSetReplacementCommand,
    metadata: &transaction::Metadata,
) -> Result<CommittedMutation, StoreError> {
    let scope = transaction::lock_scope(tx, metadata).await?;
    if let Some(receipt) = transaction::replay(tx, metadata).await? {
        return Ok(receipt);
    }
    metadata.check_fresh(scope.version, scope.fence_epoch)?;

    let view = command.as_integration_view()?;
    let context = view.context();
    let project_id = context.project_id();
    let project = sqlx::query(
        "SELECT goal_id::text
         FROM projects
         WHERE id=$1::uuid AND org_id=$2::uuid
         FOR UPDATE",
    )
    .bind(project_id)
    .bind(&metadata.org)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(StoreError::NotFound)?;
    let _current_primary: Option<String> = project.try_get("goal_id")?;

    let existing = sqlx::query(
        "SELECT org_id::text, goal_id::text
         FROM project_goals
         WHERE project_id=$1::uuid
         ORDER BY goal_id
         FOR UPDATE",
    )
    .bind(project_id)
    .fetch_all(&mut **tx)
    .await?;
    for row in existing {
        let row_org: String = row.try_get("org_id")?;
        let row_goal: String = row.try_get("goal_id")?;
        if row_org != metadata.org {
            return Err(StoreError::InvalidProjection);
        }
        transaction::uuid(&row_goal)?;
    }

    validate_goals(tx, &metadata.org, context.goal_ids()).await?;
    let state = view.resulting_state(
        scope
            .version
            .checked_add(1)
            .ok_or(StoreError::VersionRange)?,
        scope.fence_epoch,
    )?;
    state.validate_persisted()?;

    sqlx::query(
        "DELETE FROM project_goals
         WHERE project_id=$1::uuid AND org_id=$2::uuid",
    )
    .bind(project_id)
    .bind(&metadata.org)
    .execute(&mut **tx)
    .await?;

    for goal_id in context.goal_ids() {
        sqlx::query(
            "INSERT INTO project_goals (project_id, goal_id, org_id)
             VALUES ($1::uuid, $2::uuid, $3::uuid)",
        )
        .bind(project_id)
        .bind(goal_id)
        .bind(&metadata.org)
        .execute(&mut **tx)
        .await?;
    }

    let updated = sqlx::query(
        "UPDATE projects
         SET goal_id=$3::uuid, updated_at=now()
         WHERE id=$1::uuid AND org_id=$2::uuid",
    )
    .bind(project_id)
    .bind(&metadata.org)
    .bind(context.primary_goal_after())
    .execute(&mut **tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(StoreError::NotFound);
    }

    let details = json!({
        "goalIds": &state.goal_ids,
        "primaryGoalId": state.primary_goal_after,
    });
    transaction::persist(
        tx,
        metadata,
        &scope,
        transaction::Effect {
            version: state.version,
            fence_epoch: state.fence_epoch,
            outcome: Outcome::Applied,
            result: ResultState::ProjectGoalSetReplacement {
                state: Box::new(state.clone()),
                project_id: project_id.to_owned(),
                goal_ids: state.goal_ids.clone(),
                primary_goal_after: state.primary_goal_after.clone(),
                state_integrity: state.state_integrity().to_owned(),
            },
            entity_id: project_id.to_owned(),
            details,
        },
    )
    .await
}

async fn validate_goals(
    tx: &mut transaction::Tx<'_>,
    organization_id: &str,
    goal_ids: &[String],
) -> Result<(), StoreError> {
    if goal_ids.is_empty() {
        return Ok(());
    }
    let found: Vec<String> = sqlx::query_scalar(
        "SELECT id::text
         FROM goals
         WHERE org_id=$1::uuid AND id=ANY($2::text[]::uuid[])
         ORDER BY id
         FOR UPDATE",
    )
    .bind(organization_id)
    .bind(goal_ids.to_vec())
    .fetch_all(&mut **tx)
    .await?;
    if found.len() != goal_ids.len() {
        return Err(StoreError::NotFound);
    }
    Ok(())
}
