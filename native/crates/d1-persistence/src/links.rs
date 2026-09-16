use crate::transaction::{self, Effect, Metadata, Tx};
use crate::{AuthorizedActor, CommittedMutation, LinkRequest, Outcome, ResultState, StoreError};
use rudder_project_goal_link_core::{LinkMutationOutcome, Operation, ProjectGoalLinkState};
use serde_json::json;
use sqlx::Row;
use std::collections::BTreeSet;

const MAX_PROJECT_GOALS: usize = 1024;

pub(crate) async fn apply(
    tx: &mut Tx<'_>,
    actor: &AuthorizedActor,
    request: LinkRequest,
    meta: &Metadata,
) -> Result<CommittedMutation, StoreError> {
    let (version, fence) = transaction::lock(tx, actor, meta).await?;
    if let Some(receipt) = transaction::replay(tx, meta).await? {
        return Ok(receipt);
    }
    meta.check_fresh(version, fence)?;
    let command = request.command;
    let project = sqlx::query(
        "SELECT goal_id::text FROM projects WHERE id=$1::uuid AND org_id=$2::uuid FOR UPDATE",
    )
    .bind(&command.project_id)
    .bind(&meta.org)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(StoreError::NotFound)?;
    goal(tx, &meta.org, &command.goal_id).await?;
    let previous_primary: Option<String> = project.try_get("goal_id")?;
    // Detect a corrupt association through the owned project, without returning foreign data.
    let corrupt: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM project_goals pg JOIN projects p ON p.id=pg.project_id WHERE p.id=$1::uuid AND p.org_id=$2::uuid AND pg.org_id<>p.org_id)")
        .bind(&command.project_id).bind(&meta.org).fetch_one(&mut **tx).await?;
    if corrupt {
        return Err(StoreError::InvalidProjection);
    }
    let ids: Vec<String> = sqlx::query_scalar("SELECT goal_id::text FROM project_goals WHERE project_id=$1::uuid AND org_id=$2::uuid ORDER BY goal_id LIMIT 1025 FOR UPDATE")
        .bind(&command.project_id).bind(&meta.org).fetch_all(&mut **tx).await?;
    if ids.len() > MAX_PROJECT_GOALS {
        return Err(StoreError::InvalidInput);
    }
    validate_goal_set(tx, &meta.org, &ids).await?;
    let mut goals: BTreeSet<String> = ids.into_iter().collect();
    if let Some(primary) = &previous_primary {
        goal(tx, &meta.org, primary).await?;
        if !goals.contains(primary) {
            return Err(StoreError::InvalidProjection);
        }
    }
    let linked = goals.contains(&command.goal_id);
    let mut state =
        ProjectGoalLinkState::new(&meta.org, &meta.org, &meta.org, version, fence, linked);
    let core = state.apply(command.clone())?;
    let (next_version, next_linked, outcome) = match core {
        LinkMutationOutcome::Applied {
            version, linked, ..
        } => (version, linked, Outcome::Applied),
        LinkMutationOutcome::Noop {
            version, linked, ..
        } => (version, linked, Outcome::Noop),
        LinkMutationOutcome::AlreadyApplied { .. } => return Err(StoreError::InvalidReceipt),
    };
    transaction::signed(next_version)?;
    // Never commit a state beyond the adapter's own bounded read contract.
    if next_linked {
        if !linked && goals.len() == MAX_PROJECT_GOALS {
            return Err(StoreError::InvalidInput);
        }
        goals.insert(command.goal_id.clone());
    } else {
        goals.remove(&command.goal_id);
    }
    let projection_valid = match &request.primary_goal_after {
        Some(id) => goals.contains(id),
        None => goals.is_empty(),
    };
    if !projection_valid
        || (outcome == Outcome::Noop && previous_primary != request.primary_goal_after)
    {
        return Err(StoreError::InvalidProjection);
    }
    if outcome == Outcome::Applied {
        match command.operation {
            Operation::Attach => {
                sqlx::query("INSERT INTO project_goals (project_id,goal_id,org_id) VALUES ($1::uuid,$2::uuid,$3::uuid)")
                    .bind(&command.project_id).bind(&command.goal_id).bind(&meta.org).execute(&mut **tx).await?;
            }
            Operation::Detach => {
                sqlx::query("DELETE FROM project_goals WHERE project_id=$1::uuid AND goal_id=$2::uuid AND org_id=$3::uuid")
                    .bind(&command.project_id).bind(&command.goal_id).bind(&meta.org).execute(&mut **tx).await?;
            }
        }
        sqlx::query("UPDATE projects SET goal_id=$3::uuid,updated_at=now() WHERE id=$1::uuid AND org_id=$2::uuid")
            .bind(&command.project_id).bind(&meta.org).bind(&request.primary_goal_after).execute(&mut **tx).await?;
    }
    let mut ordered = Vec::new();
    if let Some(primary) = &request.primary_goal_after {
        ordered.push(primary.clone());
    }
    ordered.extend(
        goals
            .into_iter()
            .filter(|id| Some(id) != request.primary_goal_after.as_ref()),
    );
    let details = json!({"goalIds":ordered});
    let entity_id = command.project_id.clone();
    transaction::persist(
        tx,
        actor,
        meta,
        Effect {
            version: next_version,
            fence,
            outcome,
            result: ResultState::ProjectGoalLink {
                project_id: command.project_id,
                goal_id: command.goal_id,
                linked: next_linked,
                primary_goal_after: request.primary_goal_after,
            },
            entity_id,
            details,
        },
    )
    .await
}

async fn validate_goal_set(tx: &mut Tx<'_>, org: &str, ids: &[String]) -> Result<(), StoreError> {
    if ids.is_empty() {
        return Ok(());
    }
    // One scoped query instead of one database round trip per association.
    let found: Vec<String> = sqlx::query_scalar(
        "SELECT id::text FROM goals WHERE org_id=$1::uuid AND id=ANY($2::text[]::uuid[]) ORDER BY id FOR UPDATE",
    )
    .bind(org)
    .bind(ids)
    .fetch_all(&mut **tx)
    .await?;
    if found.len() != ids.len() {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

async fn goal(tx: &mut Tx<'_>, org: &str, id: &str) -> Result<(), StoreError> {
    let found =
        sqlx::query("SELECT id FROM goals WHERE id=$1::uuid AND org_id=$2::uuid FOR UPDATE")
            .bind(id)
            .bind(org)
            .fetch_optional(&mut **tx)
            .await?;
    if found.is_none() {
        return Err(StoreError::NotFound);
    }
    Ok(())
}
