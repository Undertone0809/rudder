use crate::{CommittedMutation, Outcome, ResultState, StoreError, transaction};
use rudder_project_goal_link_core::LinkMutationOutcome;
use rudder_project_goal_link_core::{
    LinkMutationError, Operation, ProjectGoalLinkCommand, ProjectGoalLinkState,
};
use serde_json::json;
use sqlx::Row;
use std::collections::BTreeSet;

#[derive(Debug)]
struct PersistedLinkReceipt {
    idempotency_key: String,
    core_fingerprint: String,
    outcome: Outcome,
    state: ProjectGoalLinkState,
    project_id: String,
    goal_id: String,
    operation: Operation,
    target_version: u64,
    target_fence_epoch: u64,
    linked: bool,
    target_integrity: String,
}

pub(crate) async fn apply(
    tx: &mut transaction::Tx<'_>,
    command: ProjectGoalLinkCommand,
    primary_goal_after: Option<String>,
    metadata: &transaction::Metadata,
) -> Result<CommittedMutation, StoreError> {
    let (version, fence_epoch) = transaction::lock_scope(tx, metadata).await?;
    if let Some(receipt) = transaction::replay(tx, metadata).await? {
        validate_project_goal_replay(&command, &receipt)?;
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

    let persisted =
        load_link_state(tx, metadata, version, fence_epoch, goals.contains(goal_id)).await?;
    if context.linked() != persisted.linked
        || context.cancelled() != persisted.cancelled
        || context.state_integrity() != persisted.state_integrity()
    {
        return Err(StoreError::Link(LinkMutationError::TargetStateMismatch));
    }
    if persisted.cancelled {
        return Err(StoreError::Link(LinkMutationError::Cancelled));
    }

    let operation = view.operation();
    let core_fingerprint = view.fingerprint()?;
    let link_identifier = view.link_identifier()?;
    let outcome = match view.resulting_outcome()? {
        LinkMutationOutcome::Applied { .. } => Outcome::Applied,
        LinkMutationOutcome::Noop { .. } => Outcome::Noop,
        LinkMutationOutcome::AlreadyApplied { .. } => {
            return Err(StoreError::InvalidReceipt);
        }
    };
    let resulting_state = view.resulting_state()?;
    let primary_after_matches_before = primary_goal_after.as_deref() == primary_before.as_deref();

    if outcome == Outcome::Noop {
        if !primary_after_matches_before {
            return Err(StoreError::InvalidProjection);
        }
    } else {
        match operation {
            Operation::Attach => {
                if goals.len() == transaction::MAX_PROJECT_GOALS {
                    return Err(StoreError::InvalidInput);
                }
                goals.insert(goal_id.to_owned());
            }
            Operation::Detach => {
                goals.remove(goal_id);
            }
            Operation::Cancel => {
                if !primary_after_matches_before {
                    return Err(StoreError::InvalidProjection);
                }
            }
        }
        validate_primary_projection(&goals, primary_goal_after.as_deref())?;
    }
    let expected_cancelled = matches!(operation, Operation::Cancel) && outcome == Outcome::Applied;
    if resulting_state.linked != goals.contains(goal_id)
        || resulting_state.cancelled != expected_cancelled
    {
        return Err(StoreError::InvalidReceipt);
    }
    if outcome == Outcome::Noop && resulting_state.state_integrity() == persisted.state_integrity()
    {
        return Err(StoreError::InvalidReceipt);
    }
    transaction::signed(resulting_state.version)?;
    transaction::signed(resulting_state.fence_epoch)?;

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
            version: resulting_state.version,
            fence_epoch: resulting_state.fence_epoch,
            outcome,
            result: ResultState::ProjectGoalLink {
                state: Box::new(resulting_state.clone()),
                project_id: project_id.to_owned(),
                goal_id: goal_id.to_owned(),
                operation,
                link_identifier,
                core_fingerprint,
                target_version: context.version(),
                target_fence_epoch: context.fence_epoch(),
                linked: resulting_state.linked,
                cancelled: resulting_state.cancelled,
                primary_goal_after,
                state_integrity: resulting_state.state_integrity().to_owned(),
                target_integrity: context.state_integrity().to_owned(),
            },
            entity_id: project_id.to_owned(),
            details,
        },
    )
    .await
}

async fn load_link_state(
    tx: &mut transaction::Tx<'_>,
    metadata: &transaction::Metadata,
    version: u64,
    fence_epoch: u64,
    linked: bool,
) -> Result<ProjectGoalLinkState, StoreError> {
    let rows = sqlx::query(
        "SELECT idempotency_key, command_fingerprint, receipt_format, outcome,
                resulting_version, fence_epoch, activity_id::text, result::text
         FROM organization_mutation_receipts
         WHERE org_id=$1::uuid
           AND command_kind=$2
         ORDER BY resulting_version, fence_epoch, created_at, idempotency_key",
    )
    .bind(&metadata.org)
    .bind(crate::project_goal_kind())
    .fetch_all(&mut **tx)
    .await?;

    let mut receipts = Vec::new();
    for row in rows {
        let row_key: String = row.try_get("idempotency_key")?;
        let row_fingerprint: String = row.try_get("command_fingerprint")?;
        let row_format: i32 = row.try_get("receipt_format")?;
        let row_outcome: String = row.try_get("outcome")?;
        let row_version: i64 = row.try_get("resulting_version")?;
        let row_fence_epoch: i64 = row.try_get("fence_epoch")?;
        let row_activity_id: String = row.try_get("activity_id")?;
        let text: String = row.try_get("result")?;
        let stored_value: serde_json::Value =
            serde_json::from_str(&text).map_err(|_| StoreError::InvalidReceipt)?;
        let receipt: crate::Receipt =
            serde_json::from_value(stored_value.clone()).map_err(|_| StoreError::InvalidReceipt)?;
        if serde_json::to_value(&receipt).map_err(|_| StoreError::InvalidReceipt)? != stored_value {
            return Err(StoreError::InvalidReceipt);
        }
        let row_version = u64::try_from(row_version).map_err(|_| StoreError::InvalidReceipt)?;
        let row_fence_epoch =
            u64::try_from(row_fence_epoch).map_err(|_| StoreError::InvalidReceipt)?;
        if row_format != 2
            || !transaction::is_sha256_hex(&row_fingerprint)
            || receipt.organization_id != metadata.org
            || receipt.fingerprint != row_fingerprint
            || receipt.version != row_version
            || receipt.fence_epoch != row_fence_epoch
            || receipt.activity_id != row_activity_id
            || receipt.outcome.as_str() != row_outcome
        {
            return Err(StoreError::InvalidReceipt);
        }
        transaction::uuid(&row_activity_id)?;
        let crate::ResultState::ProjectGoalLink {
            state,
            project_id,
            goal_id,
            operation,
            link_identifier,
            core_fingerprint,
            target_version,
            target_fence_epoch,
            linked: result_linked,
            cancelled,
            primary_goal_after,
            state_integrity,
            target_integrity,
        } = receipt.result
        else {
            return Err(StoreError::InvalidReceipt);
        };
        if receipt.organization_id != metadata.org
            || receipt.version != state.version
            || receipt.fence_epoch != state.fence_epoch
            || state.organization_id != metadata.org
            || state.project_org_id != metadata.org
            || state.goal_org_id != metadata.org
            || state.project_id != project_id
            || state.goal_id != goal_id
            || state.link_identifier().ok().as_deref() != Some(link_identifier.as_str())
            || state.linked != result_linked
            || state.cancelled != cancelled
            || state.state_integrity() != state_integrity
            || !transaction::is_sha256_hex(&core_fingerprint)
            || !transaction::is_sha256_hex(&target_integrity)
            || receipt.fingerprint
                != transaction::adapter_fingerprint(
                    crate::project_goal_kind(),
                    &core_fingerprint,
                    primary_goal_after.as_deref(),
                )?
        {
            return Err(StoreError::InvalidReceipt);
        }
        transaction::uuid(&project_id)?;
        transaction::uuid(&goal_id)?;
        if let Some(primary) = primary_goal_after.as_deref() {
            transaction::uuid(primary)?;
        }
        state.validate_persisted()?;
        state.validate_persisted_receipt(
            &row_key,
            &core_fingerprint,
            operation,
            target_version,
            target_fence_epoch,
            receipt.version,
            receipt.fence_epoch,
            result_linked,
            cancelled,
            &target_integrity,
            receipt.outcome.as_str(),
        )?;
        receipts.push(PersistedLinkReceipt {
            idempotency_key: row_key,
            core_fingerprint,
            outcome: receipt.outcome,
            state: *state,
            project_id,
            goal_id,
            operation,
            target_version,
            target_fence_epoch,
            linked: result_linked,
            target_integrity,
        });
    }

    let project_id = metadata
        .project_id
        .as_deref()
        .ok_or(StoreError::InvalidReceipt)?;
    let goal_id = metadata
        .goal_id
        .as_deref()
        .ok_or(StoreError::InvalidReceipt)?;
    let receipts: Vec<_> = receipts
        .into_iter()
        .filter(|receipt| receipt.project_id == project_id && receipt.goal_id == goal_id)
        .collect();

    let state = if receipts.is_empty() {
        ProjectGoalLinkState::bootstrap(
            &metadata.org,
            &metadata.org,
            &metadata.org,
            project_id,
            goal_id,
            version,
            fence_epoch,
            linked,
        )
    } else {
        fold_persisted_link_receipts(&metadata.org, project_id, goal_id, &receipts)?
    };
    if state.linked != linked {
        return Err(StoreError::InvalidReceipt);
    }
    let state = state.rebase_scope(version, fence_epoch)?;
    if state.linked != linked {
        return Err(StoreError::InvalidReceipt);
    }
    Ok(state)
}

fn fold_persisted_link_receipts(
    organization_id: &str,
    project_id: &str,
    goal_id: &str,
    receipts: &[PersistedLinkReceipt],
) -> Result<ProjectGoalLinkState, StoreError> {
    let mut genesis_index = None;
    let mut genesis = None;
    for (index, receipt) in receipts.iter().enumerate() {
        let linked = genesis_linked(receipt)?;
        let candidate = ProjectGoalLinkState::bootstrap(
            organization_id,
            organization_id,
            organization_id,
            project_id,
            goal_id,
            receipt.target_version,
            receipt.target_fence_epoch,
            linked,
        );
        if candidate.state_integrity() == receipt.target_integrity {
            if genesis_index.replace(index).is_some() {
                return Err(StoreError::InvalidReceipt);
            }
            genesis = Some(candidate);
        }
    }

    let Some(genesis_index) = genesis_index else {
        return Err(StoreError::InvalidReceipt);
    };
    let mut state = genesis.ok_or(StoreError::InvalidReceipt)?;
    let first = &receipts[genesis_index];
    first.state.validate_persisted_successor(
        &state,
        &first.idempotency_key,
        &first.core_fingerprint,
        first.operation,
        first.target_version,
        first.target_fence_epoch,
        &first.target_integrity,
        first.outcome.as_str(),
    )?;
    state = first.state.clone();

    let mut consumed = vec![false; receipts.len()];
    consumed[genesis_index] = true;
    for _ in 1..receipts.len() {
        let mut successor_index = None;
        for (index, receipt) in receipts.iter().enumerate() {
            if consumed[index] {
                continue;
            }
            let matches_target = state
                .rebase_scope(receipt.target_version, receipt.target_fence_epoch)
                .is_ok_and(|rebased| rebased.state_integrity() == receipt.target_integrity);
            if matches_target && successor_index.replace(index).is_some() {
                return Err(StoreError::InvalidReceipt);
            }
        }
        let Some(successor_index) = successor_index else {
            return Err(StoreError::InvalidReceipt);
        };
        let successor = &receipts[successor_index];
        successor.state.validate_persisted_successor(
            &state,
            &successor.idempotency_key,
            &successor.core_fingerprint,
            successor.operation,
            successor.target_version,
            successor.target_fence_epoch,
            &successor.target_integrity,
            successor.outcome.as_str(),
        )?;
        state = successor.state.clone();
        consumed[successor_index] = true;
    }
    Ok(state)
}

fn genesis_linked(receipt: &PersistedLinkReceipt) -> Result<bool, StoreError> {
    match (receipt.operation, receipt.outcome) {
        (Operation::Attach, Outcome::Applied) => Ok(false),
        (Operation::Attach, Outcome::Noop) => Ok(true),
        (Operation::Detach, Outcome::Applied) => Ok(true),
        (Operation::Detach, Outcome::Noop) => Ok(false),
        (Operation::Cancel, Outcome::Applied) => Ok(receipt.linked),
        (Operation::Cancel, Outcome::Noop) => Err(StoreError::InvalidReceipt),
    }
}

fn validate_project_goal_replay(
    command: &ProjectGoalLinkCommand,
    receipt: &CommittedMutation,
) -> Result<(), StoreError> {
    let ResultState::ProjectGoalLink { state, .. } = &receipt.receipt.result else {
        return Err(StoreError::InvalidReceipt);
    };
    state.validate_replay(command)?;
    Ok(())
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
