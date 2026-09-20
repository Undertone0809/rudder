use crate::{CommittedMutation, Outcome, ResultState, StoreError, transaction};
use rudder_project_goal_link_core::{LinkMutationError, Operation, ProjectGoalLinkCommand};
use serde_json::json;
use sqlx::Row;
use std::collections::BTreeSet;

pub(crate) async fn apply(
    tx: &mut transaction::Tx<'_>,
    command: ProjectGoalLinkCommand,
    primary_goal_after: Option<String>,
    metadata: &transaction::Metadata,
) -> Result<CommittedMutation, StoreError> {
    let (version, fence_epoch) = transaction::lock_scope(tx, metadata).await?;
    if let Some(receipt) = transaction::replay(tx, metadata).await? {
        return Ok(receipt);
    }
    metadata.check_fresh(version, fence_epoch)?;

    let view = command.as_integration_view()?;
    let context = view.context();
    let project_id = context.project_id();
    let goal_id = context.goal_id();
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
    let primary_before: Option<String> = project.try_get("goal_id")?;
    if let Some(primary) = &primary_before {
        transaction::uuid(primary)?;
    }
    goal(tx, &metadata.org, goal_id).await?;

    let rows = sqlx::query(
        "SELECT org_id::text, goal_id::text
         FROM project_goals
         WHERE project_id=$1::uuid
         ORDER BY goal_id
         LIMIT $2
         FOR UPDATE",
    )
    .bind(project_id)
    .bind(i64::try_from(transaction::MAX_PROJECT_GOALS + 1).expect("goal limit fits BIGINT"))
    .fetch_all(&mut **tx)
    .await?;
    if rows.len() > transaction::MAX_PROJECT_GOALS {
        return Err(StoreError::InvalidInput);
    }

    let mut goal_ids = Vec::with_capacity(rows.len());
    for row in rows {
        let row_org: String = row.try_get("org_id")?;
        let row_goal: String = row.try_get("goal_id")?;
        if row_org != metadata.org {
            return Err(StoreError::InvalidProjection);
        }
        transaction::uuid(&row_goal)?;
        goal_ids.push(row_goal);
    }
    validate_goal_set(tx, &metadata.org, &goal_ids).await?;
    let mut goals: BTreeSet<String> = goal_ids.into_iter().collect();
    validate_primary_projection(&goals, primary_before.as_deref())?;

    let linked = goals.contains(goal_id);
    if linked != context.linked() {
        return Err(StoreError::Link(LinkMutationError::TargetStateMismatch));
    }
    if context.cancelled() {
        return Err(StoreError::Link(LinkMutationError::Cancelled));
    }
    let operation = view.operation();
    let primary_after_matches_before = primary_goal_after.as_deref() == primary_before.as_deref();

    let (next_version, next_fence_epoch, next_linked, next_cancelled, outcome) = match operation {
        Operation::Cancel => {
            if !primary_after_matches_before {
                return Err(StoreError::InvalidProjection);
            }
            (
                version
                    .checked_add(1)
                    .ok_or(LinkMutationError::VersionOverflow)?,
                fence_epoch
                    .checked_add(1)
                    .ok_or(LinkMutationError::FenceOverflow)?,
                linked,
                true,
                Outcome::Applied,
            )
        }
        Operation::Attach | Operation::Detach => {
            let requested_linked = matches!(operation, Operation::Attach);
            if requested_linked == linked {
                if !primary_after_matches_before {
                    return Err(StoreError::InvalidProjection);
                }
                (version, fence_epoch, linked, false, Outcome::Noop)
            } else {
                if requested_linked {
                    if goals.len() == transaction::MAX_PROJECT_GOALS {
                        return Err(StoreError::InvalidInput);
                    }
                    goals.insert(goal_id.to_owned());
                } else {
                    goals.remove(goal_id);
                }
                validate_primary_projection(&goals, primary_goal_after.as_deref())?;
                (
                    version
                        .checked_add(1)
                        .ok_or(LinkMutationError::VersionOverflow)?,
                    fence_epoch,
                    requested_linked,
                    false,
                    Outcome::Applied,
                )
            }
        }
    };
    transaction::signed(next_version)?;
    transaction::signed(next_fence_epoch)?;

    if outcome == Outcome::Applied {
        match operation {
            Operation::Attach => {
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
            Operation::Detach => {
                sqlx::query(
                    "DELETE FROM project_goals
                     WHERE project_id=$1::uuid AND goal_id=$2::uuid AND org_id=$3::uuid",
                )
                .bind(project_id)
                .bind(goal_id)
                .bind(&metadata.org)
                .execute(&mut **tx)
                .await?;
            }
            Operation::Cancel => {}
        }
        if operation != Operation::Cancel {
            sqlx::query(
                "UPDATE projects
                 SET goal_id=$3::uuid, updated_at=now()
                 WHERE id=$1::uuid AND org_id=$2::uuid",
            )
            .bind(project_id)
            .bind(&metadata.org)
            .bind(primary_goal_after.as_deref())
            .execute(&mut **tx)
            .await?;
        }
    }

    let ordered = ordered_goals(&goals, primary_goal_after.as_deref());
    let details = json!({
        "goalIds": ordered,
        "linkIdentifier": &metadata.link_identifier,
        "operation": operation_name(operation),
    });
    transaction::persist(
        tx,
        metadata,
        transaction::Effect {
            version: next_version,
            fence_epoch: next_fence_epoch,
            outcome,
            result: ResultState::ProjectGoalLink {
                project_id: project_id.to_owned(),
                goal_id: goal_id.to_owned(),
                linked: next_linked,
                cancelled: next_cancelled,
                primary_goal_after,
                state_integrity: context.state_integrity().to_owned(),
            },
            entity_id: project_id.to_owned(),
            details,
        },
    )
    .await
}

async fn validate_goal_set(
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
    .bind(goal_ids)
    .fetch_all(&mut **tx)
    .await?;
    if found.len() != goal_ids.len() {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

async fn goal(
    tx: &mut transaction::Tx<'_>,
    organization_id: &str,
    goal_id: &str,
) -> Result<(), StoreError> {
    let found = sqlx::query(
        "SELECT id
         FROM goals
         WHERE id=$1::uuid AND org_id=$2::uuid
         FOR UPDATE",
    )
    .bind(goal_id)
    .bind(organization_id)
    .fetch_optional(&mut **tx)
    .await?;
    if found.is_none() {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

fn validate_primary_projection(
    goals: &BTreeSet<String>,
    primary_goal_after: Option<&str>,
) -> Result<(), StoreError> {
    if primary_goal_after.is_some_and(|primary| !goals.contains(primary))
        || primary_goal_after.is_none() && !goals.is_empty()
    {
        return Err(StoreError::InvalidProjection);
    }
    Ok(())
}

fn ordered_goals(goals: &BTreeSet<String>, primary_goal_after: Option<&str>) -> Vec<String> {
    let mut ordered = Vec::with_capacity(goals.len());
    if let Some(primary) = primary_goal_after {
        ordered.push(primary.to_owned());
    }
    ordered.extend(
        goals
            .iter()
            .filter(|goal_id| Some(goal_id.as_str()) != primary_goal_after)
            .cloned(),
    );
    ordered
}

fn operation_name(operation: Operation) -> &'static str {
    match operation {
        Operation::Attach => "attach",
        Operation::Detach => "detach",
        Operation::Cancel => "cancel",
    }
}
