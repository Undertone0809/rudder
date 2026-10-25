//! Transactional Goal writes used by the Rust Goal command boundary.
//!
//! The API transport may validate and normalize the public wire payload, but
//! Goal state transitions, organization scoping, and the durable activity row
//! are applied together here. Project-to-Goal links remain in `goal_sets`.

use crate::{
    StoreError, activity,
    agent_core::{NativeAgentAccess, NativeAgentAuthorizer},
    goal_reads::{GoalReadRequest, GoalReadView, read_goals_for_actor_in_transaction},
};
use serde_json::{Map, Value, json};
use sqlx::{PgPool, Row, Transaction};

#[derive(Clone, Debug)]
pub struct GoalWriteContext<'a> {
    pub organization_id: &'a str,
    pub actor_kind: &'a str,
    pub actor_id: &'a str,
    pub actor_agent_id: Option<&'a str>,
    pub run_id: Option<&'a str>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GoalWriteOperation {
    Create,
    Update,
    Activate,
    UpdatePlan,
    AssignOwner,
    SetFocus,
    CreateActivity,
    Delete,
}

/// Apply a Goal command in one transaction. `input` is the already-parsed
/// command object from the trusted HTTP adapter; every field used below is
/// checked again before it reaches SQL.
pub async fn apply_goal_write(
    pool: &PgPool,
    authorizer: &dyn NativeAgentAuthorizer,
    context: GoalWriteContext<'_>,
    operation: GoalWriteOperation,
    goal_id: Option<&str>,
    input: &Value,
) -> Result<Value, StoreError> {
    let organization_id = canonical_uuid(context.organization_id)?;
    let goal_reference = goal_id.map(str::to_owned);
    if !input.is_object() {
        return Err(StoreError::InvalidInput);
    }
    let mut tx = pool.begin().await?;
    let result = async {
        lock_organization(&mut tx, &organization_id).await?;
        match authorizer.revalidate(&mut tx, &organization_id).await? {
            NativeAgentAccess::Authorized => {}
            NativeAgentAccess::Unauthorized => return Err(StoreError::PublicIdentityUnauthorized),
            NativeAgentAccess::Forbidden => return Err(StoreError::PublicIdentityForbidden),
        }
        let resolved_goal_id = match goal_reference.as_deref() {
            Some(reference) => Some(
                resolve_goal_reference(
                    &mut tx,
                    &organization_id,
                    reference,
                    context.actor_agent_id.is_some(),
                )
                .await?,
            ),
            None => None,
        };
        match operation {
            GoalWriteOperation::Create => {
                let goal_id = create(&mut tx, &context, &organization_id, input).await?;
                log_goal_activity(&mut tx, &context, &organization_id, "goal.created", &goal_id,
                    json!({"lifecycle":"draft","title":input["title"]})).await?;
                public_goal(&mut tx, &organization_id, &goal_id, false).await
            }
            GoalWriteOperation::Update => {
                let goal_id = required_goal_id(resolved_goal_id.as_deref())?;
                let current = lock_goal(&mut tx, &organization_id, goal_id).await?;
                update(&mut tx, &context, &organization_id, goal_id, &current, input).await?;
                log_goal_activity(&mut tx, &context, &organization_id, "goal.updated", goal_id,
                    input.clone()).await?;
                public_goal(&mut tx, &organization_id, goal_id, false).await
            }
            GoalWriteOperation::Activate => {
                let goal_id = required_goal_id(resolved_goal_id.as_deref())?;
                let current = lock_goal(&mut tx, &organization_id, goal_id).await?;
                activate(&mut tx, &context, &organization_id, goal_id, &current, input).await?;
                log_goal_activity(&mut tx, &context, &organization_id, "goal.activated", goal_id,
                    json!({"ownerAgentId":input["ownerAgentId"],"objectiveMode":input["objectiveMode"]})).await?;
                public_goal(&mut tx, &organization_id, goal_id, true).await
            }
            GoalWriteOperation::UpdatePlan => {
                let goal_id = required_goal_id(resolved_goal_id.as_deref())?;
                let current = lock_goal(&mut tx, &organization_id, goal_id).await?;
                let revision = update_plan(&mut tx, &context, &organization_id, goal_id, &current, input).await?;
                log_goal_activity(&mut tx, &context, &organization_id, "goal.plan_updated", goal_id,
                    json!({"revision":revision})).await?;
                plan_view(&mut tx, &organization_id, goal_id, revision).await
            }
            GoalWriteOperation::AssignOwner => {
                let goal_id = required_goal_id(resolved_goal_id.as_deref())?;
                let current = lock_goal(&mut tx, &organization_id, goal_id).await?;
                let assignment = assign_owner(&mut tx, &context, &organization_id, goal_id, &current, input).await?;
                log_goal_activity(&mut tx, &context, &organization_id, "goal.owner_reassigned", goal_id,
                    json!({"agentId":assignment["agentId"],"assignmentRevision":assignment["assignmentRevision"]})).await?;
                Ok(assignment)
            }
            GoalWriteOperation::SetFocus => {
                let goal_id = required_goal_id(resolved_goal_id.as_deref())?;
                let current = lock_goal(&mut tx, &organization_id, goal_id).await?;
                set_focus(&mut tx, &context, &organization_id, goal_id, &current, input).await?;
                log_goal_activity(&mut tx, &context, &organization_id, "goal.focus_changed", goal_id,
                    json!({"focus":input["focus"]})).await?;
                public_goal(&mut tx, &organization_id, goal_id, false).await
            }
            GoalWriteOperation::CreateActivity => {
                let goal_id = required_goal_id(resolved_goal_id.as_deref())?;
                let current = lock_goal(&mut tx, &organization_id, goal_id).await?;
                let (activity, inserted) = create_activity(&mut tx, &context, &organization_id, goal_id, &current, input).await?;
                if inserted {
                    log_goal_activity(&mut tx, &context, &organization_id, "goal.activity_added", goal_id,
                        json!({"activityId":activity["id"],"activityKind":activity["activityKind"]})).await?;
                }
                Ok(activity)
            }
            GoalWriteOperation::Delete => {
                let goal_id = required_goal_id(resolved_goal_id.as_deref())?;
                let current = lock_goal(&mut tx, &organization_id, goal_id).await?;
                require_board(&context)?;
                require_deletable_draft(&mut tx, &organization_id, goal_id, &current).await?;
                let response = public_goal(&mut tx, &organization_id, goal_id, false).await?;
                sqlx::query("DELETE FROM goals WHERE org_id=$1::uuid AND id=$2::uuid")
                    .bind(&organization_id).bind(goal_id).execute(&mut *tx).await?;
                log_goal_activity(&mut tx, &context, &organization_id, "goal.deleted", goal_id, Value::Null).await?;
                Ok(response)
            }
        }
    }.await;
    match result {
        Ok(value) => {
            tx.commit().await?;
            Ok(value)
        }
        Err(error) => {
            tx.rollback().await?;
            Err(error)
        }
    }
}

async fn lock_organization(
    tx: &mut Transaction<'_, sqlx::Postgres>,
    org: &str,
) -> Result<(), StoreError> {
    // This is the same first lock used by the legacy Node Goal mutations. It
    // serializes an in-flight request with a cutover without changing the
    // organization-wide owner used by unrelated domains.
    let state = sqlx::query(
        "SELECT org_id FROM organization_mutation_state WHERE org_id=$1::uuid FOR UPDATE",
    )
    .bind(org)
    .fetch_optional(&mut **tx)
    .await?;
    if state.is_none() {
        let exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM organizations WHERE id=$1::uuid)",
        )
        .bind(org)
        .fetch_one(&mut **tx)
        .await?;
        return Err(if exists {
            StoreError::NotOwned
        } else {
            StoreError::NotFound
        });
    }
    let organization = sqlx::query("SELECT id FROM organizations WHERE id=$1::uuid FOR UPDATE")
        .bind(org)
        .fetch_optional(&mut **tx)
        .await?;
    if organization.is_none() {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

/// Use the same mutation-state then organization-row lock order for the
/// internal Goal Run claim that serializes Goal Start and focus mutations.
pub(crate) async fn lock_goal_run_organization(
    tx: &mut Transaction<'_, sqlx::Postgres>,
    org: &str,
) -> Result<(), StoreError> {
    lock_organization(tx, org).await
}

async fn resolve_goal_reference(
    tx: &mut Transaction<'_, sqlx::Postgres>,
    org: &str,
    reference: &str,
    allow_short_ref: bool,
) -> Result<String, StoreError> {
    if let Ok(id) = canonical_uuid(reference) {
        return sqlx::query_scalar::<_, String>(
            "SELECT id::text FROM goals WHERE org_id=$1::uuid AND id=$2::uuid",
        )
        .bind(org)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(StoreError::NotFound);
    }
    if !allow_short_ref {
        return Err(StoreError::NotFound);
    }
    let Some(prefix) = goal_short_ref_prefix(reference) else {
        return Err(StoreError::NotFound);
    };
    let rows = sqlx::query_scalar::<_, String>(
        "SELECT id::text FROM goals WHERE org_id=$1::uuid AND replace(lower(id::text), '-', '') LIKE $2 ORDER BY id LIMIT 2",
    )
    .bind(org)
    .bind(format!("{prefix}%"))
    .fetch_all(&mut **tx)
    .await?;
    match rows.as_slice() {
        [id] => Ok(id.clone()),
        [] => Err(StoreError::NotFound),
        _ => Err(StoreError::GoalConflict),
    }
}

fn goal_short_ref_prefix(reference: &str) -> Option<String> {
    let (kind, prefix) = reference.trim().split_once('_')?;
    (kind.eq_ignore_ascii_case("gol")
        && (8..=32).contains(&prefix.len())
        && prefix.bytes().all(|byte| byte.is_ascii_hexdigit()))
    .then(|| prefix.to_ascii_lowercase())
}

async fn lock_goal(
    tx: &mut Transaction<'_, sqlx::Postgres>,
    org: &str,
    id: &str,
) -> Result<sqlx::postgres::PgRow, StoreError> {
    sqlx::query("SELECT g.*, g.owner_agent_id::text AS owner_agent_id_text FROM goals g WHERE g.org_id=$1::uuid AND g.id=$2::uuid FOR UPDATE")
        .bind(org).bind(id).fetch_optional(&mut **tx).await?.ok_or(StoreError::NotFound)
}

async fn create(
    tx: &mut Transaction<'_, sqlx::Postgres>,
    context: &GoalWriteContext<'_>,
    org: &str,
    input: &Value,
) -> Result<String, StoreError> {
    require_board(context)?;
    let title = required_trimmed(input, "title")?;
    let description = optional_text(input, "description")?;
    let alignment = optional_trimmed(input, "alignmentQuestion")?;
    let target = optional_date(input, "targetTime")?;
    let owner = optional_uuid(input, "ownerAgentId")?;
    let overrides = input
        .get("ownerAgentRuntimeOverrides")
        .filter(|v| !v.is_null());
    validate_owner_overrides(overrides)?;
    if let Some(owner) = owner.as_deref() {
        require_invokable_owner(tx, org, owner).await?;
    }
    let id: String = sqlx::query_scalar("SELECT gen_random_uuid()::text")
        .fetch_one(&mut **tx)
        .await?;
    sqlx::query(
        "INSERT INTO goals (id,org_id,title,description,alignment_question,evaluation_deadline,level,status,lifecycle,parent_id,owner_agent_id,owner_agent_runtime_overrides) \
         VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::timestamptz,'task','planned','draft',NULL,$7::uuid,$8::jsonb)",
    ).bind(&id).bind(org).bind(title).bind(description).bind(alignment).bind(target)
        .bind(owner.as_deref()).bind(overrides.map(Value::to_string)).execute(&mut **tx).await?;
    Ok(id)
}

async fn update(
    tx: &mut Transaction<'_, sqlx::Postgres>,
    context: &GoalWriteContext<'_>,
    org: &str,
    id: &str,
    current: &sqlx::postgres::PgRow,
    input: &Value,
) -> Result<(), StoreError> {
    let actor_agent = context.actor_agent_id;
    ensure_actor_matches(context)?;
    let lifecycle: String = current.try_get("lifecycle")?;
    let owner_current: Option<String> = current.try_get("owner_agent_id_text")?;
    if actor_agent.is_some() && actor_agent != owner_current.as_deref() {
        return Err(StoreError::GoalForbidden);
    }
    if lifecycle == "closed" {
        return Err(StoreError::GoalConflict);
    }
    if lifecycle != "draft" && actor_agent.is_some() {
        return Err(StoreError::GoalForbidden);
    }
    let owner_present = input.get("ownerAgentId").is_some();
    let target_present = input.get("targetTime").is_some();
    if lifecycle != "draft" && (owner_present || target_present) {
        return Err(StoreError::GoalConflict);
    }
    let title = input
        .get("title")
        .map(|_| required_trimmed(input, "title"))
        .transpose()?;
    let description = input
        .get("description")
        .map(|_| optional_text(input, "description"))
        .transpose()?;
    let alignment = input
        .get("alignmentQuestion")
        .map(|_| optional_trimmed(input, "alignmentQuestion"))
        .transpose()?;
    let target = input
        .get("targetTime")
        .map(|_| optional_date(input, "targetTime"))
        .transpose()?;
    let owner = input
        .get("ownerAgentId")
        .map(|_| optional_uuid(input, "ownerAgentId"))
        .transpose()?;
    if let Some(Some(owner)) = owner.as_ref() {
        require_invokable_owner(tx, org, owner).await?;
    }
    let override_value = input.get("ownerAgentRuntimeOverrides");
    validate_owner_overrides(override_value.filter(|value| !value.is_null()))?;
    let changed_owner = owner
        .as_ref()
        .is_some_and(|new| new.as_deref() != owner_current.as_deref());
    let target_value = target.as_ref().and_then(Clone::clone);
    let owner_value = owner.as_ref().and_then(Clone::clone);
    sqlx::query(
        "UPDATE goals SET title=CASE WHEN $3 THEN $4 ELSE title END, description=CASE WHEN $5 THEN $6 ELSE description END, \
         alignment_question=CASE WHEN $7 THEN $8 ELSE alignment_question END, evaluation_deadline=CASE WHEN $9 THEN $10::timestamptz ELSE evaluation_deadline END, \
         owner_agent_id=CASE WHEN $11 THEN $12::uuid ELSE owner_agent_id END, \
         owner_agent_runtime_overrides=CASE WHEN $13 THEN $14::jsonb WHEN $15 THEN NULL ELSE owner_agent_runtime_overrides END, updated_at=now() \
         WHERE id=$1::uuid AND org_id=$2::uuid",
    ).bind(id).bind(org).bind(title.is_some()).bind(title).bind(description.is_some()).bind(description.flatten())
        .bind(alignment.is_some()).bind(alignment.flatten()).bind(target.is_some()).bind(target_value)
        .bind(owner.is_some()).bind(owner_value).bind(override_value.is_some())
        .bind(override_value.filter(|v| !v.is_null()).map(Value::to_string)).bind(changed_owner)
        .execute(&mut **tx).await?;
    Ok(())
}

async fn activate(
    tx: &mut Transaction<'_, sqlx::Postgres>,
    context: &GoalWriteContext<'_>,
    org: &str,
    id: &str,
    current: &sqlx::postgres::PgRow,
    input: &Value,
) -> Result<(), StoreError> {
    ensure_actor_matches(context)?;
    let lifecycle: String = current.try_get("lifecycle")?;
    if lifecycle != "draft" {
        return Err(StoreError::GoalConflict);
    }
    if input.get("confirmed") != Some(&Value::Bool(true)) {
        return Err(StoreError::InvalidInput);
    }
    let owner = required_uuid(input, "ownerAgentId")?;
    if context.actor_agent_id.is_some_and(|actor| actor != owner) {
        return Err(StoreError::GoalForbidden);
    }
    require_invokable_owner(tx, org, &owner).await?;
    let outcome = required_trimmed(input, "outcomeStatement")?;
    let mode = required_enum(
        input,
        "objectiveMode",
        &["target", "maximize", "maintain", "decide"],
    )?;
    let criteria = normalize_criteria(&required_array(input, "criteria")?)?;
    let autonomy = object_or_default(input, "autonomyEnvelope")?;
    let authorities = object_or_default(input, "humanAuthorities")?;
    let policy = object_or_default(input, "evaluationPolicy")?;
    let action_deadline = optional_date(input, "actionDeadline")?;
    let evaluation_deadline = optional_date(input, "evaluationDeadline")?;
    if let (Some(action), Some(evaluation)) = (&action_deadline, &evaluation_deadline) {
        let action =
            time::OffsetDateTime::parse(action, &time::format_description::well_known::Rfc3339)
                .map_err(|_| StoreError::InvalidInput)?;
        let evaluation =
            time::OffsetDateTime::parse(evaluation, &time::format_description::well_known::Rfc3339)
                .map_err(|_| StoreError::InvalidInput)?;
        if evaluation < action {
            return Err(StoreError::InvalidInput);
        }
    }
    let plan = input
        .get("initialPlan")
        .and_then(Value::as_object)
        .ok_or(StoreError::InvalidInput)?;
    let continuation = input
        .get("initialContinuation")
        .and_then(Value::as_object)
        .ok_or(StoreError::InvalidInput)?;
    let plan_summary = required_trimmed(plan, "summary")?;
    let continuation_kind = required_enum(
        continuation,
        "kind",
        &["commitment", "verification", "wait", "decision"],
    )?;
    let continuation_summary = required_trimmed(continuation, "summary")?;
    let wake = nullable_trimmed(continuation, "wakeCondition")?;
    let owner_current: Option<String> = current.try_get("owner_agent_id_text")?;
    let revision = 1;
    let result = sqlx::query(
        "UPDATE goals SET outcome_statement=$3,objective_mode=$4,lifecycle='active',status='active',contract_revision=1,criteria=$5::jsonb,autonomy_envelope=$6::jsonb,human_authorities=$7::jsonb,evaluation_policy=$8::jsonb,action_deadline=$9::timestamptz,evaluation_deadline=$10::timestamptz,owner_agent_id=$11::uuid,plan_revision=1,continuation_kind=$12,continuation_summary=$13,wake_condition=$14,alignment_question=NULL,updated_at=now() WHERE org_id=$1::uuid AND id=$2::uuid AND lifecycle='draft'",
    ).bind(org).bind(id).bind(outcome).bind(mode).bind(criteria.to_string()).bind(autonomy.to_string())
        .bind(authorities.to_string()).bind(policy.to_string()).bind(action_deadline).bind(evaluation_deadline)
        .bind(&owner).bind(continuation_kind).bind(continuation_summary).bind(wake)
        .execute(&mut **tx).await?;
    if result.rows_affected() != 1 {
        return Err(StoreError::GoalConflict);
    }
    sqlx::query("INSERT INTO goal_owner_assignments (org_id,goal_id,agent_id,assignment_revision,assigned_by_authority_ref) VALUES ($1::uuid,$2::uuid,$3::uuid,1,'activation')")
        .bind(org).bind(id).bind(&owner).execute(&mut **tx).await?;
    sqlx::query("INSERT INTO goal_plans (org_id,goal_id,revision,summary,hypotheses,selected_paths,rejected_paths,sequencing,budget_allocations,invalidation_conditions,created_by_agent_id) VALUES ($1::uuid,$2::uuid,1,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::uuid)")
        .bind(org).bind(id).bind(plan_summary).bind(array_or_default(plan,"hypotheses")?.to_string())
        .bind(array_or_default(plan,"selectedPaths")?.to_string()).bind(array_or_default(plan,"rejectedPaths")?.to_string())
        .bind(array_or_default(plan,"sequencing")?.to_string()).bind(object_or_default(plan,"budgetAllocations")?.to_string())
        .bind(array_or_default(plan,"invalidationConditions")?.to_string()).bind(context.actor_agent_id)
        .execute(&mut **tx).await?;
    let summary = crate::goal_reads::public_goal_text(&format!(
        "The Agent is starting with: {continuation_summary}"
    ));
    sqlx::query("INSERT INTO goal_activities (org_id,goal_id,contract_revision,submitted_by_agent_id,agent_owner_ref_at_time,activity_kind,summary,evidence_refs) VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,'progress',$6,'[]'::jsonb)")
        .bind(org).bind(id).bind(revision).bind(context.actor_agent_id).bind(owner_current.as_deref().or(Some(owner.as_str()))).bind(summary)
        .execute(&mut **tx).await?;
    Ok(())
}

async fn update_plan(
    tx: &mut Transaction<'_, sqlx::Postgres>,
    context: &GoalWriteContext<'_>,
    org: &str,
    id: &str,
    current: &sqlx::postgres::PgRow,
    input: &Value,
) -> Result<i32, StoreError> {
    require_active_goal(current)?;
    ensure_actor_matches(context)?;
    let owner: Option<String> = current.try_get("owner_agent_id_text")?;
    if context.actor_agent_id.is_some() && context.actor_agent_id != owner.as_deref() {
        return Err(StoreError::GoalForbidden);
    }
    let revision: i32 = current.try_get("plan_revision")?;
    let next = revision.checked_add(1).ok_or(StoreError::VersionRange)?;
    let summary = required_trimmed(input, "summary")?;
    sqlx::query("INSERT INTO goal_plans (org_id,goal_id,revision,summary,hypotheses,selected_paths,rejected_paths,sequencing,budget_allocations,invalidation_conditions,created_by_agent_id) VALUES ($1::uuid,$2::uuid,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::uuid)")
        .bind(org).bind(id).bind(next).bind(summary).bind(array_or_default(input,"hypotheses")?.to_string())
        .bind(array_or_default(input,"selectedPaths")?.to_string()).bind(array_or_default(input,"rejectedPaths")?.to_string())
        .bind(array_or_default(input,"sequencing")?.to_string()).bind(object_or_default(input,"budgetAllocations")?.to_string())
        .bind(array_or_default(input,"invalidationConditions")?.to_string()).bind(context.actor_agent_id)
        .execute(&mut **tx).await?;
    let updated = sqlx::query("UPDATE goals SET plan_revision=$3,updated_at=now() WHERE org_id=$1::uuid AND id=$2::uuid AND lifecycle='active' AND plan_revision=$4")
        .bind(org).bind(id).bind(next).bind(revision).execute(&mut **tx).await?;
    if updated.rows_affected() != 1 {
        return Err(StoreError::GoalConflict);
    }
    Ok(next)
}

async fn assign_owner(
    tx: &mut Transaction<'_, sqlx::Postgres>,
    context: &GoalWriteContext<'_>,
    org: &str,
    id: &str,
    current: &sqlx::postgres::PgRow,
    input: &Value,
) -> Result<Value, StoreError> {
    require_board(context)?;
    require_active_goal(current)?;
    let agent_id = required_uuid(input, "agentId")?;
    require_invokable_owner(tx, org, &agent_id).await?;
    let previous = sqlx::query("SELECT id::text,agent_id::text,assignment_revision FROM goal_owner_assignments WHERE org_id=$1::uuid AND goal_id=$2::uuid AND ends_at IS NULL FOR UPDATE")
        .bind(org).bind(id).fetch_optional(&mut **tx).await?;
    if let Some(previous) = previous.as_ref() {
        let previous_agent: String = previous.try_get("agent_id")?;
        if previous_agent == agent_id {
            return assignment_view(tx, org, id).await;
        }
        sqlx::query("UPDATE goal_owner_assignments SET ends_at=now() WHERE id=$1::uuid")
            .bind(previous.try_get::<String, _>("id")?)
            .execute(&mut **tx)
            .await?;
    }
    let revision = previous
        .as_ref()
        .map(|row| row.try_get::<i32, _>("assignment_revision"))
        .transpose()?
        .unwrap_or(0)
        + 1;
    let authority_ref = nullable_trimmed(input, "authorityRef")?;
    let assignment_id: String = sqlx::query_scalar("INSERT INTO goal_owner_assignments (org_id,goal_id,agent_id,assignment_revision,assigned_by_authority_ref,starts_at) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,now()) RETURNING id::text")
        .bind(org).bind(id).bind(&agent_id).bind(revision).bind(authority_ref).fetch_one(&mut **tx).await?;
    sqlx::query("UPDATE goals SET owner_agent_id=$3::uuid,owner_agent_runtime_overrides=NULL,updated_at=now() WHERE org_id=$1::uuid AND id=$2::uuid AND lifecycle='active'")
        .bind(org).bind(id).bind(&agent_id).execute(&mut **tx).await?;
    assignment_view_by_id(tx, org, &assignment_id).await
}

async fn set_focus(
    tx: &mut Transaction<'_, sqlx::Postgres>,
    context: &GoalWriteContext<'_>,
    org: &str,
    id: &str,
    current: &sqlx::postgres::PgRow,
    input: &Value,
) -> Result<(), StoreError> {
    require_active_goal(current)?;
    ensure_actor_matches(context)?;
    let owner: Option<String> = current.try_get("owner_agent_id_text")?;
    if context.actor_agent_id.is_some() && context.actor_agent_id != owner.as_deref() {
        return Err(StoreError::GoalForbidden);
    }
    let focus = input
        .get("focus")
        .and_then(Value::as_bool)
        .ok_or(StoreError::InvalidInput)?;
    if focus {
        sqlx::query("UPDATE goals SET focus=false WHERE org_id=$1::uuid AND lifecycle='active' AND focus=true")
            .bind(org).execute(&mut **tx).await?;
    }
    let changed = sqlx::query("UPDATE goals SET focus=$3,updated_at=now() WHERE org_id=$1::uuid AND id=$2::uuid AND lifecycle='active'")
        .bind(org).bind(id).bind(focus).execute(&mut **tx).await?;
    if changed.rows_affected() != 1 {
        return Err(StoreError::GoalConflict);
    }
    Ok(())
}

async fn create_activity(
    tx: &mut Transaction<'_, sqlx::Postgres>,
    context: &GoalWriteContext<'_>,
    org: &str,
    id: &str,
    current: &sqlx::postgres::PgRow,
    input: &Value,
) -> Result<(Value, bool), StoreError> {
    require_active_goal(current)?;
    ensure_actor_matches(context)?;
    let owner: Option<String> = current.try_get("owner_agent_id_text")?;
    if context.actor_agent_id.is_some() && context.actor_agent_id != owner.as_deref() {
        return Err(StoreError::GoalForbidden);
    }
    let summary = required_trimmed(input, "summary")?;
    let kind = optional_enum(
        input,
        "activityKind",
        &[
            "progress",
            "evidence",
            "decision_requested",
            "checkpoint",
            "bottleneck",
            "closeout",
        ],
    )?
    .unwrap_or_else(|| "progress".to_owned());
    let requested_run_ref = optional_uuid(input, "runRef")?;
    let run_ref = context
        .run_id
        .map(canonical_uuid)
        .transpose()?
        .or(requested_run_ref);
    if context.actor_agent_id.is_some() && run_ref.is_none() {
        return Err(StoreError::InvalidInput);
    }
    if kind == "closeout" && run_ref.is_none() {
        return Err(StoreError::InvalidInput);
    }
    if let Some(run_id) = run_ref.as_deref() {
        let run = sqlx::query("SELECT org_id::text,agent_id::text,goal_id::text,status FROM heartbeat_runs WHERE id=$1::uuid FOR KEY SHARE")
            .bind(run_id).fetch_optional(&mut **tx).await?.ok_or(StoreError::NotFound)?;
        if run.try_get::<String, _>("org_id")? != org
            || run.try_get::<Option<String>, _>("goal_id")?.as_deref() != Some(id)
            || context.actor_agent_id.is_some_and(|agent| {
                run.try_get::<Option<String>, _>("agent_id")
                    .ok()
                    .flatten()
                    .as_deref()
                    != Some(agent)
            })
        {
            return Err(StoreError::InvalidInput);
        }
        if kind == "closeout"
            && !matches!(
                run.try_get::<String, _>("status")?.as_str(),
                "succeeded" | "failed" | "cancelled" | "canceled" | "timed_out" | "timeout"
            )
        {
            return Err(StoreError::GoalConflict);
        }
    }
    let evidence = match input.get("evidenceRefs") {
        None => Vec::new(),
        Some(Value::Array(evidence)) => evidence.clone(),
        Some(_) => return Err(StoreError::InvalidInput),
    };
    if evidence.len() > 100 {
        return Err(StoreError::InvalidInput);
    }
    let evidence = evidence
        .into_iter()
        .map(|value| {
            let reference = value.as_str().ok_or(StoreError::InvalidInput)?.trim();
            if reference.is_empty() || !valid_evidence_ref(reference) {
                return Err(StoreError::InvalidInput);
            }
            Ok(Value::String(reference.to_owned()))
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    let occurred = optional_date(input, "occurredAt")?;
    let idempotency = nullable_trimmed(input, "idempotencyKey")?;
    let contract_revision: i32 = current.try_get("contract_revision")?;
    let submitted = context.actor_agent_id;
    let owner_id: Option<String> = current.try_get("owner_agent_id_text")?;
    let activity_id = sqlx::query_scalar::<_, String>("INSERT INTO goal_activities (org_id,goal_id,contract_revision,submitted_by_agent_id,agent_owner_ref_at_time,commitment_ref,run_ref,activity_kind,summary,evidence_refs,idempotency_key,occurred_at) VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6,$7::uuid,$8,$9,$10::jsonb,$11,COALESCE($12::timestamptz,now())) ON CONFLICT DO NOTHING RETURNING id::text")
        .bind(org).bind(id).bind(contract_revision).bind(submitted).bind(owner_id.as_deref()).bind(nullable_trimmed(input, "commitmentRef")?)
        .bind(run_ref.as_deref()).bind(&kind).bind(summary).bind(Value::Array(evidence).to_string()).bind(idempotency.as_deref()).bind(occurred)
        .fetch_optional(&mut **tx).await?;
    let (activity_id, inserted) = match activity_id {
        Some(id) => (id, true),
        None if idempotency.is_some() => (
            sqlx::query_scalar::<_, String>("SELECT id::text FROM goal_activities WHERE org_id=$1::uuid AND goal_id=$2::uuid AND idempotency_key=$3")
                .bind(org).bind(id).bind(idempotency.as_deref()).fetch_optional(&mut **tx).await?.ok_or(StoreError::GoalConflict)?,
            false,
        ),
        None => return Err(StoreError::GoalConflict),
    };
    let activities = read_goals_for_actor_in_transaction(
        tx,
        org,
        &GoalReadRequest {
            view: GoalReadView::Activities,
            goal_id: Some(id.to_owned()),
            cursor: None,
            limit: None,
            agent_id: None,
            lifecycle: None,
            focus: None,
            facet: None,
        },
        None,
    )
    .await
    .map_err(|error| match error {
        crate::goal_reads::GoalReadError::Store(store) => store,
        _ => StoreError::InvalidInput,
    })?;
    let array: Value = serde_json::from_str(&activities).map_err(|_| StoreError::InvalidReceipt)?;
    let activity = array
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"] == activity_id))
        .cloned()
        .ok_or(StoreError::InvalidReceipt)?;
    Ok((activity, inserted))
}

async fn require_deletable_draft(
    tx: &mut Transaction<'_, sqlx::Postgres>,
    org: &str,
    id: &str,
    current: &sqlx::postgres::PgRow,
) -> Result<(), StoreError> {
    if current.try_get::<String, _>("lifecycle")? != "draft" {
        return Err(StoreError::GoalConflict);
    }
    let query = "SELECT
      EXISTS(SELECT 1 FROM goals WHERE org_id=$1::uuid AND parent_id=$2::uuid)
      OR EXISTS(SELECT 1 FROM projects WHERE org_id=$1::uuid AND goal_id=$2::uuid)
      OR EXISTS(SELECT 1 FROM project_goals WHERE org_id=$1::uuid AND goal_id=$2::uuid)
      OR EXISTS(SELECT 1 FROM issues WHERE org_id=$1::uuid AND goal_id=$2::uuid)
      OR EXISTS(SELECT 1 FROM automations WHERE org_id=$1::uuid AND goal_id=$2::uuid)
      OR EXISTS(SELECT 1 FROM calendar_events WHERE org_id=$1::uuid AND goal_id=$2::uuid AND deleted_at IS NULL)
      OR EXISTS(SELECT 1 FROM cost_events WHERE org_id=$1::uuid AND goal_id=$2::uuid)
      OR EXISTS(SELECT 1 FROM finance_events WHERE org_id=$1::uuid AND goal_id=$2::uuid)";
    let blocked = sqlx::query_scalar::<_, bool>(query)
        .bind(org)
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
    if blocked {
        return Err(StoreError::GoalConflict);
    }
    Ok(())
}

async fn require_invokable_owner(
    tx: &mut Transaction<'_, sqlx::Postgres>,
    org: &str,
    agent: &str,
) -> Result<(), StoreError> {
    let row = sqlx::query("SELECT status FROM agents WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(org)
        .bind(agent)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(StoreError::InvalidInput)?;
    let status: String = row.try_get("status")?;
    if matches!(status.as_str(), "terminated" | "pending_approval") {
        return Err(StoreError::InvalidInput);
    }
    Ok(())
}

async fn public_goal(
    tx: &mut Transaction<'_, sqlx::Postgres>,
    org: &str,
    id: &str,
    detail: bool,
) -> Result<Value, StoreError> {
    let text = read_goals_for_actor_in_transaction(
        tx,
        org,
        &GoalReadRequest {
            view: GoalReadView::Detail,
            goal_id: Some(id.to_owned()),
            cursor: None,
            limit: None,
            agent_id: None,
            lifecycle: None,
            focus: None,
            facet: None,
        },
        None,
    )
    .await
    .map_err(|error| match error {
        crate::goal_reads::GoalReadError::Store(store) => store,
        _ => StoreError::InvalidInput,
    })?;
    let mut value: Value = serde_json::from_str(&text).map_err(|_| StoreError::InvalidReceipt)?;
    if !detail && let Some(object) = value.as_object_mut() {
        object.remove("ownerAssignment");
        object.remove("plan");
        object.remove("activities");
    }
    Ok(value)
}

async fn plan_view(
    tx: &mut Transaction<'_, sqlx::Postgres>,
    org: &str,
    goal_id: &str,
    revision: i32,
) -> Result<Value, StoreError> {
    let row = sqlx::query("SELECT id::text,org_id::text,goal_id::text,revision,summary,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at FROM goal_plans WHERE org_id=$1::uuid AND goal_id=$2::uuid AND revision=$3")
        .bind(org).bind(goal_id).bind(revision).fetch_one(&mut **tx).await?;
    Ok(
        json!({"id":row.try_get::<String,_>("id")?,"orgId":row.try_get::<String,_>("org_id")?,"goalId":row.try_get::<String,_>("goal_id")?,"revision":row.try_get::<i32,_>("revision")?,"summary":crate::goal_reads::public_goal_text(&row.try_get::<String,_>("summary")?),"createdAt":row.try_get::<String,_>("created_at")?,"updatedAt":row.try_get::<String,_>("updated_at")?}),
    )
}

async fn assignment_view(
    tx: &mut Transaction<'_, sqlx::Postgres>,
    org: &str,
    goal: &str,
) -> Result<Value, StoreError> {
    let row = sqlx::query("SELECT id::text FROM goal_owner_assignments WHERE org_id=$1::uuid AND goal_id=$2::uuid AND ends_at IS NULL")
        .bind(org).bind(goal).fetch_optional(&mut **tx).await?.ok_or(StoreError::NotFound)?;
    assignment_view_by_id(tx, org, &row.try_get::<String, _>("id")?).await
}
async fn assignment_view_by_id(
    tx: &mut Transaction<'_, sqlx::Postgres>,
    org: &str,
    id: &str,
) -> Result<Value, StoreError> {
    let row = sqlx::query("SELECT id::text,org_id::text,goal_id::text,agent_id::text,assignment_revision,to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS starts_at,CASE WHEN ends_at IS NULL THEN NULL ELSE to_char(ends_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') END AS ends_at,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at FROM goal_owner_assignments WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(org).bind(id).fetch_optional(&mut **tx).await?.ok_or(StoreError::NotFound)?;
    Ok(
        json!({"id":row.try_get::<String,_>("id")?,"orgId":row.try_get::<String,_>("org_id")?,"goalId":row.try_get::<String,_>("goal_id")?,"agentId":row.try_get::<String,_>("agent_id")?,"assignmentRevision":row.try_get::<i32,_>("assignment_revision")?,"startsAt":row.try_get::<String,_>("starts_at")?,"endsAt":row.try_get::<Option<String>,_>("ends_at")?,"createdAt":row.try_get::<String,_>("created_at")?}),
    )
}

async fn log_goal_activity(
    tx: &mut Transaction<'_, sqlx::Postgres>,
    context: &GoalWriteContext<'_>,
    org: &str,
    action: &'static str,
    id: &str,
    details: Value,
) -> Result<(), StoreError> {
    let actor_type = match context.actor_kind {
        "agent" => "agent",
        "user" => "user",
        _ => return Err(StoreError::Unauthorized),
    };
    activity::write_activity(
        tx,
        org,
        &activity::ActivityActor {
            actor_type,
            actor_id: context.actor_id.to_owned(),
            run_id: context.run_id.map(str::to_owned),
        },
        action,
        "goal",
        id,
        Some(&details),
    )
    .await?;
    Ok(())
}

fn require_board(context: &GoalWriteContext<'_>) -> Result<(), StoreError> {
    if context.actor_kind == "user" && context.actor_agent_id.is_none() {
        Ok(())
    } else {
        Err(StoreError::GoalForbidden)
    }
}
fn ensure_actor_matches(context: &GoalWriteContext<'_>) -> Result<(), StoreError> {
    match context.actor_kind {
        "user" if context.actor_agent_id.is_none() => Ok(()),
        "agent" if context.actor_agent_id == Some(context.actor_id) => Ok(()),
        _ => Err(StoreError::Unauthorized),
    }
}
fn required_goal_id(id: Option<&str>) -> Result<&str, StoreError> {
    id.ok_or(StoreError::InvalidInput)
}
fn canonical_uuid(value: &str) -> Result<String, StoreError> {
    if value.len() != 36
        || !value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
    {
        return Err(StoreError::InvalidInput);
    }
    Ok(value.to_ascii_lowercase())
}
fn required_trimmed<'a>(object: &'a impl AsObject, name: &str) -> Result<&'a str, StoreError> {
    object
        .object()
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(StoreError::InvalidInput)
}
fn optional_text(object: &impl AsObject, name: &str) -> Result<Option<String>, StoreError> {
    match object.object().get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(StoreError::InvalidInput),
    }
}
fn optional_trimmed(object: &impl AsObject, name: &str) -> Result<Option<String>, StoreError> {
    match object.object().get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            let value = value.trim();
            if value.is_empty() {
                Err(StoreError::InvalidInput)
            } else {
                Ok(Some(value.to_owned()))
            }
        }
        _ => Err(StoreError::InvalidInput),
    }
}
fn nullable_trimmed(object: &impl AsObject, name: &str) -> Result<Option<String>, StoreError> {
    match object.object().get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            let value = value.trim();
            if value.is_empty() {
                Err(StoreError::InvalidInput)
            } else {
                Ok(Some(value.to_owned()))
            }
        }
        _ => Err(StoreError::InvalidInput),
    }
}
fn optional_uuid(object: &impl AsObject, name: &str) -> Result<Option<String>, StoreError> {
    match object.object().get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => canonical_uuid(value).map(Some),
        _ => Err(StoreError::InvalidInput),
    }
}
fn required_uuid(object: &impl AsObject, name: &str) -> Result<String, StoreError> {
    optional_uuid(object, name)?.ok_or(StoreError::InvalidInput)
}
fn optional_date(object: &impl AsObject, name: &str) -> Result<Option<String>, StoreError> {
    match object.object().get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value))
            if time::OffsetDateTime::parse(
                value,
                &time::format_description::well_known::Rfc3339,
            )
            .is_ok() =>
        {
            Ok(Some(value.clone()))
        }
        _ => Err(StoreError::InvalidInput),
    }
}
fn required_enum(
    object: &impl AsObject,
    name: &str,
    choices: &[&str],
) -> Result<String, StoreError> {
    object
        .object()
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| choices.contains(value))
        .map(str::to_owned)
        .ok_or(StoreError::InvalidInput)
}
fn optional_enum(
    object: &impl AsObject,
    name: &str,
    choices: &[&str],
) -> Result<Option<String>, StoreError> {
    match object.object().get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if choices.contains(&value.as_str()) => Ok(Some(value.clone())),
        _ => Err(StoreError::InvalidInput),
    }
}
fn required_array(object: &impl AsObject, name: &str) -> Result<Value, StoreError> {
    object
        .object()
        .get(name)
        .filter(|value| value.is_array())
        .cloned()
        .ok_or(StoreError::InvalidInput)
}
fn array_or_default(object: &impl AsObject, name: &str) -> Result<Value, StoreError> {
    match object.object().get(name) {
        None => Ok(json!([])),
        Some(value) if value.is_array() => Ok(value.clone()),
        _ => Err(StoreError::InvalidInput),
    }
}
fn object_or_default(object: &impl AsObject, name: &str) -> Result<Value, StoreError> {
    match object.object().get(name) {
        None => Ok(json!({})),
        Some(value) if value.is_object() => Ok(value.clone()),
        _ => Err(StoreError::InvalidInput),
    }
}

fn validate_owner_overrides(value: Option<&Value>) -> Result<(), StoreError> {
    let Some(value) = value else {
        return Ok(());
    };
    let object = value.as_object().ok_or(StoreError::InvalidInput)?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "agentRuntimeConfig" | "useProjectWorkspace"))
    {
        return Err(StoreError::InvalidInput);
    }
    if object
        .get("agentRuntimeConfig")
        .is_some_and(|value| !value.is_object())
        || object
            .get("useProjectWorkspace")
            .is_some_and(|value| !value.is_boolean())
    {
        return Err(StoreError::InvalidInput);
    }
    Ok(())
}

fn normalize_criteria(value: &Value) -> Result<Value, StoreError> {
    let criteria = value.as_array().ok_or(StoreError::InvalidInput)?;
    if criteria.is_empty() {
        return Err(StoreError::InvalidInput);
    }
    let mut ids = std::collections::HashSet::with_capacity(criteria.len());
    let mut normalized = Vec::with_capacity(criteria.len());
    for criterion in criteria {
        let object = criterion.as_object().ok_or(StoreError::InvalidInput)?;
        let id = required_trimmed(object, "id")?;
        if !ids.insert(id.to_owned()) {
            return Err(StoreError::InvalidInput);
        }
        let label = required_trimmed(object, "label")?;
        let evaluator = required_enum(
            object,
            "evaluator",
            &["artifact", "metric", "policy", "human"],
        )?;
        let mut normalized_criterion = json!({
            "id": id,
            "label": label,
            "evaluator": evaluator,
        });
        if let Some(evidence) = object.get("evidenceRequirements") {
            let evidence = evidence.as_array().ok_or(StoreError::InvalidInput)?;
            let mut normalized_evidence = Vec::with_capacity(evidence.len());
            for value in evidence {
                let reference = value.as_str().ok_or(StoreError::InvalidInput)?.trim();
                if reference.is_empty() || !valid_evidence_ref(reference) {
                    return Err(StoreError::InvalidInput);
                }
                normalized_evidence.push(Value::String(reference.to_owned()));
            }
            normalized_criterion["evidenceRequirements"] = Value::Array(normalized_evidence);
        }
        normalized.push(normalized_criterion);
    }
    Ok(Value::Array(normalized))
}

fn valid_evidence_ref(value: &str) -> bool {
    let Some((scheme, target)) = value.trim().split_once(':') else {
        return false;
    };
    let mut bytes = scheme.bytes();
    bytes.next().is_some_and(|byte| byte.is_ascii_alphabetic())
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'.' | b'-'))
        && !target.is_empty()
        && !target.chars().any(char::is_whitespace)
}

fn require_active_goal(row: &sqlx::postgres::PgRow) -> Result<(), StoreError> {
    if row.try_get::<String, _>("lifecycle")? != "active" {
        return Err(StoreError::GoalConflict);
    }
    let owner: Option<String> = row.try_get("owner_agent_id_text")?;
    let outcome: Option<String> = row.try_get("outcome_statement")?;
    let criteria: Value = row.try_get("criteria")?;
    let plan_revision: i32 = row.try_get("plan_revision")?;
    let continuation: Option<String> = row.try_get("continuation_kind")?;
    let summary: Option<String> = row.try_get("continuation_summary")?;
    if owner.is_none()
        || outcome.as_deref().is_none_or(str::is_empty)
        || !criteria.as_array().is_some_and(|items| !items.is_empty())
        || plan_revision < 1
        || continuation.is_none()
        || summary.as_deref().is_none_or(str::is_empty)
    {
        return Err(StoreError::GoalConflict);
    }
    Ok(())
}
trait AsObject {
    fn object(&self) -> &Map<String, Value>;
}
impl AsObject for Value {
    fn object(&self) -> &Map<String, Value> {
        self.as_object().expect("Goal command object validated")
    }
}
impl AsObject for Map<String, Value> {
    fn object(&self) -> &Map<String, Value> {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::{goal_short_ref_prefix, normalize_criteria};
    use serde_json::json;

    #[test]
    fn goal_short_references_match_the_shared_parser_contract() {
        assert_eq!(
            goal_short_ref_prefix("gol_abcdef01"),
            Some("abcdef01".to_owned())
        );
        assert_eq!(
            goal_short_ref_prefix("GOL_ABCDEF0123456789ABCDEF01"),
            Some("abcdef0123456789abcdef01".to_owned())
        );
        assert_eq!(goal_short_ref_prefix("gol_abcdef0"), None);
        assert_eq!(goal_short_ref_prefix("agt_abcdef01"), None);
        assert_eq!(goal_short_ref_prefix("gol_abcdefg1"), None);
    }

    #[test]
    fn activation_criteria_match_zod_trim_and_unknown_field_behavior() {
        let normalized = normalize_criteria(&json!([{
            "id": " result ",
            "label": " Verified result ",
            "evaluator": "artifact",
            "evidenceRequirements": [" artifact://result "],
            "ignored": true
        }]))
        .unwrap();
        assert_eq!(
            normalized,
            json!([{
                "id": "result",
                "label": "Verified result",
                "evaluator": "artifact",
                "evidenceRequirements": ["artifact://result"]
            }])
        );
        assert!(
            normalize_criteria(&json!([
                {"id":"same","label":"One","evaluator":"human"},
                {"id":" same ","label":"Two","evaluator":"human"}
            ]))
            .is_err()
        );
    }
}
