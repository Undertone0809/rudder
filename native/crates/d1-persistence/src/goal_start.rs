//! Goal Start preview compilation and atomic persistence.
//!
//! This module owns the Goal contract and its durable wakeup intent. A
//! separate runtime owner consumes the queued `agent_wakeup_requests` row and
//! materializes a run; Goal Start never creates or dispatches a heartbeat run.

use crate::{
    StoreError, activity,
    agent_core::{NativeAgentAccess, NativeAgentAuthorizer},
    goal_writes::{
        GoalWriteContext, activate_goal_start, canonical_uuid, create, lock_goal,
        lock_organization, public_goal, require_board,
    },
};
use icu_collator::{Collator, options::CollatorOptions};
use regex_lite::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row, Transaction};
use std::collections::HashSet;
use thiserror::Error;
use time::{
    Date, OffsetDateTime, PrimitiveDateTime, Time, UtcOffset,
    format_description::{self, well_known::Rfc3339},
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalStartPreviewInput {
    pub title: String,
    pub context: Option<String>,
    pub owner_agent_id: Option<String>,
    /// Zod's `z.coerce.date()` accepts date-only strings, RFC3339 strings, and
    /// epoch-millisecond JSON numbers. Normalize before packet compilation.
    pub target_time: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalStartInput {
    pub request_key: String,
    pub packet_hash: String,
    pub packet: Value,
    #[serde(default)]
    pub allow_capability_mismatch: bool,
    pub draft_goal_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalStartDispatch {
    pub owner_agent_id: String,
    pub wakeup_request_id: String,
    pub source: &'static str,
    pub trigger_detail: &'static str,
    pub reason: &'static str,
    pub payload: Value,
    pub context_snapshot: Value,
    pub requested_by_actor_type: String,
    pub requested_by_actor_id: Option<String>,
    pub idempotency_key: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalStartResult {
    pub goal: Value,
    pub replayed: bool,
    pub dispatch: GoalStartDispatch,
}

#[derive(Debug, Error)]
pub enum GoalStartError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("{0}")]
    Conflict(&'static str),
    #[error("{message}")]
    Unprocessable {
        message: &'static str,
        details: Option<Value>,
    },
    #[error("Goal Start database operation failed")]
    Database(#[from] sqlx::Error),
}

impl GoalStartError {
    fn unprocessable(message: &'static str) -> Self {
        Self::Unprocessable {
            message,
            details: None,
        }
    }
}

#[derive(Clone, Debug)]
struct GoalStartOwner {
    id: String,
    status: String,
    role: Option<String>,
    title: Option<String>,
    capabilities: Option<String>,
}

const DEFERRED_WAKE_CONTEXT_KEY: &str = "_paperclipWakeContext";
const OUTCOME_REQUIRED_MESSAGE: &str = "Describe the result or decision someone should be able to verify. Include what changes and, when useful, a measure or deadline.";
const OUTCOME_REQUIRED_QUESTION: &str =
    "What observable result or decision should this Goal produce, and how will we know it worked?";
const OWNER_REQUIRED_MESSAGE: &str =
    "Select an available Agent from this organization to own and start the Goal.";
const OWNER_REQUIRED_QUESTION: &str =
    "Which available same-organization Agent should own and advance this Goal?";

/// Compile the same preview packet used by Goal Start, using only an owner
/// selected from the requested organization.
pub async fn compile_goal_start_preview(
    pool: &PgPool,
    organization_id: &str,
    input: &GoalStartPreviewInput,
) -> Result<Value, GoalStartError> {
    let org = canonical_uuid(organization_id)?;
    let target_time = input
        .target_time
        .as_ref()
        .map(normalize_target_time)
        .transpose()?;
    let normalized = GoalStartPreviewInput {
        title: input.title.trim().to_owned(),
        context: input.context.as_deref().map(str::trim).map(str::to_owned),
        owner_agent_id: input
            .owner_agent_id
            .as_deref()
            .map(canonical_uuid)
            .transpose()?,
        target_time: target_time.map(Value::String),
    };
    if !has_concrete_goal_outcome(&normalized) {
        return Ok(outcome_blocker());
    }
    let owner = if let Some(owner_id) = normalized.owner_agent_id.as_deref() {
        let owner_id = canonical_uuid(owner_id)?;
        read_start_owner(pool, &org, &owner_id).await?
    } else {
        None
    };
    compile_preview(&normalized, owner.as_ref())
}

/// Apply a board-authored Goal Start with the request record, activation,
/// assignment, first plan/activity, activity audit/outbox, and durable wakeup
/// intent in one organization-serialized transaction.
pub async fn apply_goal_start(
    pool: &PgPool,
    authorizer: &dyn NativeAgentAuthorizer,
    context: GoalWriteContext<'_>,
    input: &GoalStartInput,
) -> Result<GoalStartResult, GoalStartError> {
    let org = canonical_uuid(context.organization_id)?;
    require_board(&context)?;
    let request_key = input.request_key.trim();
    if request_key.is_empty() {
        return Err(StoreError::InvalidInput.into());
    }
    if input.packet_hash.len() != 64
        || !input
            .packet_hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(StoreError::InvalidInput.into());
    }
    let (normalized_packet, packet) = normalize_packet(&input.packet)?;
    let computed_hash = stable_goal_hash(&normalized_packet)?;
    if computed_hash != input.packet_hash {
        return Err(GoalStartError::Conflict(
            "Goal Start packet hash does not match the submitted packet",
        ));
    }
    let mut tx = pool.begin().await?;
    let result = async {
        lock_organization(&mut tx, &org).await?;
        match authorizer.revalidate(&mut tx, &org).await? {
            NativeAgentAccess::Authorized => {}
            NativeAgentAccess::Unauthorized => return Err(StoreError::PublicIdentityUnauthorized.into()),
            NativeAgentAccess::Forbidden => return Err(StoreError::PublicIdentityForbidden.into()),
        }
        require_board(&context)?;

        if let Some(replay) = read_start_request(&mut tx, &org, request_key).await? {
            return replay_start(
                &mut tx,
                &org,
                &context,
                &normalized_packet,
                &input.packet_hash,
                replay,
            )
                .await;
        }

        let owner = read_start_owner_tx(&mut tx, &org, &packet.owner_agent_id).await?;
        let Some(owner) = owner else {
            return Err(GoalStartError::unprocessable(
                "Goal owner must belong to the same organization",
            ));
        };
        if matches!(owner.status.as_str(), "terminated" | "pending_approval") {
            return Err(GoalStartError::Unprocessable {
                message: "Goal owner must be invokable",
                details: Some(json!({"status": owner.status})),
            });
        }
        let preview_input = GoalStartPreviewInput {
            title: packet.title.clone(),
            context: packet.description.clone(),
            owner_agent_id: Some(packet.owner_agent_id.clone()),
            target_time: packet.activation["evaluationDeadline"]
                .as_str()
                .map(|value| Value::String(value.to_owned())),
        };
        if !owner_can_advance_goal(&owner, &preview_input) && !input.allow_capability_mismatch {
            return Err(GoalStartError::unprocessable(
                "Goal owner capabilities no longer match the Goal; confirm the warning before starting",
            ));
        }

        let request_id: String = sqlx::query_scalar(
            "INSERT INTO goal_start_requests (org_id,request_key,packet_hash,packet,draft_goal_id,status) VALUES ($1::uuid,$2,$3,$4::jsonb,$5::uuid,'pending') ON CONFLICT (org_id,request_key) DO NOTHING RETURNING id::text",
        )
        .bind(&org)
        .bind(request_key)
        .bind(&input.packet_hash)
        .bind(normalized_packet.to_string())
        .bind(input.draft_goal_id.as_deref())
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(GoalStartError::Conflict(
            "Goal Start request key was reused with a different packet hash",
        ))?;

        let goal_id = if let Some(draft_id) = input.draft_goal_id.as_deref() {
            let draft_id = canonical_uuid(draft_id)?;
            let draft = sqlx::query("SELECT id::text FROM goals WHERE org_id=$1::uuid AND id=$2::uuid AND lifecycle='draft' FOR UPDATE")
                .bind(&org).bind(&draft_id).fetch_optional(&mut *tx).await?;
            if draft.is_none() {
                return Err(GoalStartError::Conflict(
                    "Reusable Goal Draft was not found in this organization",
                ));
            }
            let updated = sqlx::query(
                "UPDATE goals SET title=$3,description=$4,alignment_question=NULL,updated_at=now() WHERE org_id=$1::uuid AND id=$2::uuid AND lifecycle='draft'",
            )
            .bind(&org)
            .bind(&draft_id)
            .bind(&packet.title)
            .bind(packet.description.as_deref())
            .execute(&mut *tx)
            .await?;
            if updated.rows_affected() != 1 {
                return Err(GoalStartError::Conflict(
                    "Goal Draft changed before start; reload and retry",
                ));
            }
            draft_id
        } else {
            let draft_input = json!({
                "title": &packet.title,
                "description": &packet.description,
                "alignmentQuestion": null,
            });
            create(&mut tx, &context, &org, &draft_input).await?
        };
        let current = lock_goal(&mut tx, &org, &goal_id).await?;
        activate_goal_start(
            &mut tx,
            &context,
            &org,
            &goal_id,
            &current,
            &packet.activation,
            &request_id,
            &packet.owner_agent_id,
        )
        .await?;
        let completed = sqlx::query(
            "UPDATE goal_start_requests SET goal_id=$2::uuid,status='completed',completed_at=now(),updated_at=now() WHERE org_id=$1::uuid AND id=$3::uuid AND status='pending'",
        )
        .bind(&org)
        .bind(&goal_id)
        .bind(&request_id)
        .execute(&mut *tx)
        .await?;
        if completed.rows_affected() != 1 {
            return Err(GoalStartError::Conflict(
                "Goal Start request could not be completed",
            ));
        }
        log_started_activity(&mut tx, &context, &org, &goal_id, &packet.owner_agent_id, &input.packet_hash, request_key).await?;
        let dispatch = ensure_goal_wakeup_intent(
            &mut tx,
            &org,
            &goal_id,
            &request_id,
            &packet.owner_agent_id,
            &context,
        )
        .await?;
        let goal = public_goal(&mut tx, &org, &goal_id, false).await?;
        Ok(GoalStartResult {
            goal,
            replayed: false,
            dispatch,
        })
    }
    .await;
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

#[derive(Clone, Debug)]
struct ValidatedStartPacket {
    title: String,
    description: Option<String>,
    owner_agent_id: String,
    activation: Value,
}

fn normalize_packet(packet: &Value) -> Result<(Value, ValidatedStartPacket), GoalStartError> {
    let object = packet.as_object().ok_or(StoreError::InvalidInput)?;
    reject_unknown_keys(
        object,
        &[
            "version",
            "title",
            "description",
            "ownerAgentId",
            "activation",
        ],
    )?;
    if object.get("version").and_then(Value::as_f64) != Some(1.0) {
        return Err(StoreError::InvalidInput.into());
    }
    let title = required_trimmed_string(object.get("title"))?;
    let description = match object.get("description") {
        Some(Value::Null) => None,
        Some(Value::String(value)) => Some(value.clone()),
        _ => return Err(StoreError::InvalidInput.into()),
    };
    let owner_input = required_string(object.get("ownerAgentId"))?;
    let owner_agent_id = goal_start_uuid(owner_input)?;
    let raw_activation = object
        .get("activation")
        .and_then(Value::as_object)
        .ok_or(StoreError::InvalidInput)?;

    // `activateGoalSchema` strips unknown object keys and materializes its
    // record/array defaults. Preserve those parsed values for hashing and
    // storage instead of hashing raw input while mutating different values.
    let confirmed = raw_activation.get("confirmed") == Some(&Value::Bool(true));
    if !confirmed {
        return Err(StoreError::InvalidInput.into());
    }
    let activation_owner_input = required_string(raw_activation.get("ownerAgentId"))?;
    let _activation_owner = goal_start_uuid(activation_owner_input)?;
    if activation_owner_input != owner_input {
        return Err(StoreError::InvalidInput.into());
    }
    let outcome = required_trimmed_string(raw_activation.get("outcomeStatement"))?;
    let objective_mode = required_enum_value(
        raw_activation.get("objectiveMode"),
        &["target", "maximize", "maintain", "decide"],
    )?;
    let criteria_value = raw_activation
        .get("criteria")
        .and_then(Value::as_array)
        .filter(|criteria| !criteria.is_empty())
        .ok_or(StoreError::InvalidInput)?;
    let mut criteria = Vec::with_capacity(criteria_value.len());
    let mut criterion_ids = HashSet::new();
    for value in criteria_value {
        let criterion = value.as_object().ok_or(StoreError::InvalidInput)?;
        let id = required_trimmed_string(criterion.get("id"))?;
        if !criterion_ids.insert(id.clone()) {
            return Err(StoreError::InvalidInput.into());
        }
        let label = required_trimmed_string(criterion.get("label"))?;
        let evaluator = required_enum_value(
            criterion.get("evaluator"),
            &["artifact", "metric", "policy", "human"],
        )?;
        let mut normalized = json!({"id": id, "label": label, "evaluator": evaluator});
        if let Some(refs) = criterion.get("evidenceRequirements") {
            let refs = refs.as_array().ok_or(StoreError::InvalidInput)?;
            let refs = refs
                .iter()
                .map(|reference| {
                    let reference = required_trimmed_string(Some(reference))?;
                    if !evidence_reference_is_valid(&reference) {
                        return Err(StoreError::InvalidInput.into());
                    }
                    Ok(Value::String(reference))
                })
                .collect::<Result<Vec<_>, GoalStartError>>()?;
            normalized["evidenceRequirements"] = Value::Array(refs);
        }
        criteria.push(normalized);
    }

    let autonomy_envelope = optional_json_record(raw_activation.get("autonomyEnvelope"))?;
    let human_authorities = optional_json_record(raw_activation.get("humanAuthorities"))?;
    let evaluation_policy = optional_json_record(raw_activation.get("evaluationPolicy"))?;
    let action_deadline = optional_goal_date(raw_activation.get("actionDeadline"))?;
    let evaluation_deadline = optional_goal_date(raw_activation.get("evaluationDeadline"))?;
    if let (Some(Value::String(action)), Some(Value::String(evaluation))) =
        (&action_deadline, &evaluation_deadline)
        && OffsetDateTime::parse(evaluation, &Rfc3339).map_err(|_| StoreError::InvalidInput)?
            < OffsetDateTime::parse(action, &Rfc3339).map_err(|_| StoreError::InvalidInput)?
    {
        return Err(StoreError::InvalidInput.into());
    }

    let raw_continuation = raw_activation
        .get("initialContinuation")
        .and_then(Value::as_object)
        .ok_or(StoreError::InvalidInput)?;
    let continuation_kind = required_enum_value(
        raw_continuation.get("kind"),
        &["commitment", "wait", "decision", "verification"],
    )?;
    let continuation_summary = required_trimmed_string(raw_continuation.get("summary"))?;
    let mut continuation = json!({"kind": continuation_kind, "summary": continuation_summary});
    if let Some(wake_condition) = raw_continuation.get("wakeCondition") {
        continuation["wakeCondition"] = match wake_condition {
            Value::Null => Value::Null,
            Value::String(value) => {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    return Err(StoreError::InvalidInput.into());
                }
                Value::String(trimmed.to_owned())
            }
            _ => return Err(StoreError::InvalidInput.into()),
        };
    }

    let raw_plan = raw_activation
        .get("initialPlan")
        .and_then(Value::as_object)
        .ok_or(StoreError::InvalidInput)?;
    let plan_summary = required_trimmed_string(raw_plan.get("summary"))?;
    let plan = json!({
        "summary": plan_summary,
        "hypotheses": array_or_empty(raw_plan.get("hypotheses"))?,
        "selectedPaths": array_or_empty(raw_plan.get("selectedPaths"))?,
        "rejectedPaths": array_or_empty(raw_plan.get("rejectedPaths"))?,
        "sequencing": array_or_empty(raw_plan.get("sequencing"))?,
        "budgetAllocations": optional_json_record(raw_plan.get("budgetAllocations"))?,
        "invalidationConditions": array_or_empty(raw_plan.get("invalidationConditions"))?,
    });
    // Retain the object as parsed by Zod: unknown keys in nested objects are
    // stripped, and optional plan collections are present with defaults.
    let mut activation = json!({
        "confirmed": true,
        "ownerAgentId": activation_owner_input,
        "outcomeStatement": outcome,
        "objectiveMode": objective_mode,
        "criteria": criteria,
        "autonomyEnvelope": autonomy_envelope,
        "humanAuthorities": human_authorities,
        "evaluationPolicy": evaluation_policy,
        "initialContinuation": continuation,
        "initialPlan": plan,
    });
    if let Some(deadline) = action_deadline {
        activation["actionDeadline"] = deadline;
    }
    if let Some(deadline) = evaluation_deadline {
        activation["evaluationDeadline"] = deadline;
    }
    let normalized_packet = json!({
        "version": 1,
        "title": title,
        "description": description,
        "ownerAgentId": owner_input,
        "activation": activation,
    });
    let validated = ValidatedStartPacket {
        title,
        description,
        owner_agent_id,
        activation: activation.clone(),
    };
    Ok((normalized_packet, validated))
}

fn reject_unknown_keys(
    object: &serde_json::Map<String, Value>,
    allowed: &[&str],
) -> Result<(), StoreError> {
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(StoreError::InvalidInput);
    }
    Ok(())
}

fn required_string(value: Option<&Value>) -> Result<&str, StoreError> {
    value
        .and_then(Value::as_str)
        .ok_or(StoreError::InvalidInput)
}

fn required_trimmed_string(value: Option<&Value>) -> Result<String, StoreError> {
    let value = required_string(value)?.trim();
    if value.is_empty() {
        return Err(StoreError::InvalidInput);
    }
    Ok(value.to_owned())
}

fn required_enum_value(value: Option<&Value>, choices: &[&str]) -> Result<String, StoreError> {
    let value = required_string(value)?;
    if choices.contains(&value) {
        Ok(value.to_owned())
    } else {
        Err(StoreError::InvalidInput)
    }
}

fn goal_start_uuid(value: &str) -> Result<String, StoreError> {
    let canonical = canonical_uuid(value)?;
    let bytes = canonical.as_bytes();
    if !matches!(bytes[14], b'1'..=b'8') || !matches!(bytes[19], b'8'..=b'b') {
        return Err(StoreError::InvalidInput);
    }
    Ok(canonical)
}

fn optional_json_record(value: Option<&Value>) -> Result<Value, StoreError> {
    match value {
        None => Ok(json!({})),
        Some(Value::Object(object)) => Ok(Value::Object(object.clone())),
        _ => Err(StoreError::InvalidInput),
    }
}

fn array_or_empty(value: Option<&Value>) -> Result<Value, StoreError> {
    match value {
        None => Ok(json!([])),
        Some(Value::Array(array)) => Ok(Value::Array(array.clone())),
        _ => Err(StoreError::InvalidInput),
    }
}

fn evidence_reference_is_valid(value: &str) -> bool {
    Regex::new(r"(?i)^[a-z][a-z0-9+.-]*:[^\s]+$")
        .expect("constant evidence reference regex")
        .is_match(value)
}

fn optional_goal_date(value: Option<&Value>) -> Result<Option<Value>, StoreError> {
    match value {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(Value::Null)),
        Some(value) => normalize_target_time(value).map(|value| Some(Value::String(value))),
    }
}

#[derive(Clone, Debug)]
struct StoredStartRequest {
    id: String,
    packet_hash: String,
    packet: Value,
    status: String,
    goal_id: Option<String>,
}

async fn read_start_request(
    tx: &mut Transaction<'_, sqlx::Postgres>,
    org: &str,
    request_key: &str,
) -> Result<Option<StoredStartRequest>, sqlx::Error> {
    let row = sqlx::query("SELECT id::text,packet_hash,packet,status,goal_id::text FROM goal_start_requests WHERE org_id=$1::uuid AND request_key=$2")
        .bind(org).bind(request_key).fetch_optional(&mut **tx).await?;
    row.map(|row| {
        Ok(StoredStartRequest {
            id: row.try_get("id")?,
            packet_hash: row.try_get("packet_hash")?,
            packet: row.try_get("packet")?,
            status: row.try_get("status")?,
            goal_id: row.try_get("goal_id")?,
        })
    })
    .transpose()
}

async fn replay_start(
    tx: &mut Transaction<'_, sqlx::Postgres>,
    org: &str,
    context: &GoalWriteContext<'_>,
    packet: &Value,
    packet_hash: &str,
    replay: StoredStartRequest,
) -> Result<GoalStartResult, GoalStartError> {
    if replay.packet_hash != packet_hash {
        return Err(GoalStartError::Conflict(
            "Goal Start request key was reused with a different packet hash",
        ));
    }
    if stable_goal_hash(&replay.packet)? != stable_goal_hash(packet)? {
        return Err(GoalStartError::Conflict(
            "Goal Start request packet does not match the original request",
        ));
    }
    if replay.status != "completed" || replay.goal_id.is_none() {
        return Err(GoalStartError::Conflict(
            "Goal Start request has not completed",
        ));
    }
    let goal_id = replay
        .goal_id
        .as_deref()
        .expect("checked completed Goal Start");
    let goal = sqlx::query(
        "SELECT id::text,owner_agent_id::text FROM goals WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(org)
    .bind(goal_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(GoalStartError::Conflict(
        "Completed Goal Start request has no Goal",
    ))?;
    let owner_agent_id: Option<String> = goal.try_get("owner_agent_id")?;
    let owner_agent_id =
        owner_agent_id.ok_or(GoalStartError::Conflict("Goal has no Owner Agent to wake"))?;
    let dispatch =
        ensure_goal_wakeup_intent(tx, org, goal_id, &replay.id, &owner_agent_id, context).await?;
    Ok(GoalStartResult {
        goal: public_goal(tx, org, goal_id, false).await?,
        replayed: true,
        dispatch,
    })
}

async fn ensure_goal_wakeup_intent(
    tx: &mut Transaction<'_, sqlx::Postgres>,
    org: &str,
    goal_id: &str,
    request_id: &str,
    owner_agent_id: &str,
    context: &GoalWriteContext<'_>,
) -> Result<GoalStartDispatch, GoalStartError> {
    let goal = sqlx::query("SELECT id::text,title,description,outcome_statement,objective_mode,contract_revision,criteria,autonomy_envelope,human_authorities,evaluation_policy,to_char(action_deadline AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS action_deadline,to_char(evaluation_deadline AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS evaluation_deadline,continuation_kind,continuation_summary,wake_condition FROM goals WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(org).bind(goal_id).fetch_optional(&mut **tx).await?.ok_or(StoreError::NotFound)?;
    let plan = sqlx::query("SELECT revision,summary,hypotheses,selected_paths,rejected_paths,sequencing,budget_allocations,invalidation_conditions FROM goal_plans WHERE org_id=$1::uuid AND goal_id=$2::uuid AND revision=(SELECT plan_revision FROM goals WHERE org_id=$1::uuid AND id=$2::uuid)")
        .bind(org).bind(goal_id).fetch_optional(&mut **tx).await?.ok_or(StoreError::NotFound)?;
    let latest_checkpoint = sqlx::query("SELECT id::text,summary,evidence_refs,plan_revision_before,plan_revision_after,continuation_wakeup_request_id::text,continuation_kind,continuation_summary,wake_condition FROM goal_checkpoints WHERE org_id=$1::uuid AND goal_id=$2::uuid ORDER BY created_at DESC LIMIT 1")
        .bind(org).bind(goal_id).fetch_optional(&mut **tx).await?;

    let task_key = format!("goal:{goal_id}:goal_started:{request_id}");
    let idempotency_key = format!("goal-start:{request_id}");
    let payload = json!({
        "event": "goal_started",
        "goalId": goal_id,
        "taskKey": task_key,
        "goalStartRequestId": request_id,
    });
    let goal_checkpoint = if let Some(checkpoint) = latest_checkpoint {
        Some(json!({
            "id": checkpoint.try_get::<String, _>("id")?,
            "summary": checkpoint.try_get::<String, _>("summary")?,
            "evidenceRefs": checkpoint.try_get::<Value, _>("evidence_refs")?,
            "planRevisionBefore": checkpoint.try_get::<i32, _>("plan_revision_before")?,
            "planRevisionAfter": checkpoint.try_get::<i32, _>("plan_revision_after")?,
            "continuationWakeupRequestId": checkpoint.try_get::<Option<String>, _>("continuation_wakeup_request_id")?,
            "continuation": {
                "kind": checkpoint.try_get::<String, _>("continuation_kind")?,
                "summary": checkpoint.try_get::<String, _>("continuation_summary")?,
                "wakeCondition": checkpoint.try_get::<Option<String>, _>("wake_condition")?,
            },
        }))
    } else {
        None
    };
    let mut context_snapshot = json!({
        "goalId": goal_id,
        "taskKey": task_key,
        "goal": {
            "id": goal.try_get::<String, _>("id")?,
            "title": goal.try_get::<String, _>("title")?,
            "description": goal.try_get::<Option<String>, _>("description")?,
            "outcomeStatement": goal.try_get::<Option<String>, _>("outcome_statement")?,
            "objectiveMode": goal.try_get::<Option<String>, _>("objective_mode")?,
            "contractRevision": goal.try_get::<i32, _>("contract_revision")?,
            "criteria": goal.try_get::<Value, _>("criteria")?,
            "autonomyEnvelope": goal.try_get::<Value, _>("autonomy_envelope")?,
            "humanAuthorities": goal.try_get::<Value, _>("human_authorities")?,
            "evaluationPolicy": goal.try_get::<Value, _>("evaluation_policy")?,
            "actionDeadline": goal.try_get::<Option<String>, _>("action_deadline")?,
            "evaluationDeadline": goal.try_get::<Option<String>, _>("evaluation_deadline")?,
        },
        "goalPlan": {
            "revision": plan.try_get::<i32, _>("revision")?,
            "summary": plan.try_get::<String, _>("summary")?,
            "hypotheses": plan.try_get::<Value, _>("hypotheses")?,
            "selectedPaths": plan.try_get::<Value, _>("selected_paths")?,
            "rejectedPaths": plan.try_get::<Value, _>("rejected_paths")?,
            "sequencing": plan.try_get::<Value, _>("sequencing")?,
            "budgetAllocations": plan.try_get::<Value, _>("budget_allocations")?,
            "invalidationConditions": plan.try_get::<Value, _>("invalidation_conditions")?,
        },
        "goalContinuation": {
            "kind": goal.try_get::<Option<String>, _>("continuation_kind")?,
            "summary": goal.try_get::<Option<String>, _>("continuation_summary")?,
            "wakeCondition": goal.try_get::<Option<String>, _>("wake_condition")?,
        },
    });
    if let Some(checkpoint) = goal_checkpoint {
        context_snapshot["goalCheckpoint"] = checkpoint;
    }
    let stored_payload = {
        let mut stored = payload.as_object().cloned().unwrap_or_default();
        stored.insert(
            DEFERRED_WAKE_CONTEXT_KEY.to_owned(),
            context_snapshot.clone(),
        );
        Value::Object(stored)
    };
    let actor_type = if matches!(context.actor_kind, "user" | "agent" | "system") {
        context.actor_kind
    } else {
        return Err(StoreError::Unauthorized.into());
    };
    let inserted = sqlx::query_scalar::<_, String>("INSERT INTO agent_wakeup_requests (org_id,agent_id,source,trigger_detail,reason,payload,status,requested_by_actor_type,requested_by_actor_id,idempotency_key) VALUES ($1::uuid,$2::uuid,'on_demand','system','goal_started',$3::jsonb,'queued',$4,$5,$6) ON CONFLICT (org_id,agent_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id::text")
        .bind(org).bind(owner_agent_id).bind(stored_payload.to_string()).bind(actor_type).bind(context.actor_id).bind(&idempotency_key)
        .fetch_optional(&mut **tx).await?;
    let (wakeup_id, requested_by_actor_type, requested_by_actor_id) = if let Some(id) = inserted {
        (id, actor_type.to_owned(), Some(context.actor_id.to_owned()))
    } else {
        let existing = sqlx::query("SELECT id::text,payload,requested_by_actor_type,requested_by_actor_id FROM agent_wakeup_requests WHERE org_id=$1::uuid AND agent_id=$2::uuid AND idempotency_key=$3")
            .bind(org).bind(owner_agent_id).bind(&idempotency_key).fetch_optional(&mut **tx).await?.ok_or(GoalStartError::Conflict("Goal Owner wakeup could not be queued"))?;
        let persisted_payload: Value = existing.try_get("payload")?;
        let mut raw_payload = persisted_payload.as_object().cloned().unwrap_or_default();
        raw_payload.remove(DEFERRED_WAKE_CONTEXT_KEY);
        if stable_goal_hash(&Value::Object(raw_payload))? != stable_goal_hash(&payload)? {
            return Err(GoalStartError::Conflict(
                "Goal Owner wakeup key was reused with a different payload",
            ));
        }
        let actor_type: Option<String> = existing.try_get("requested_by_actor_type")?;
        let actor_type = match actor_type.as_deref() {
            Some("user" | "agent" | "system") => actor_type.expect("matched actor type"),
            _ => "system".to_owned(),
        };
        (
            existing.try_get("id")?,
            actor_type,
            existing.try_get("requested_by_actor_id")?,
        )
    };
    Ok(GoalStartDispatch {
        owner_agent_id: owner_agent_id.to_owned(),
        wakeup_request_id: wakeup_id,
        source: "on_demand",
        trigger_detail: "system",
        reason: "goal_started",
        payload,
        context_snapshot,
        requested_by_actor_type,
        requested_by_actor_id,
        idempotency_key,
    })
}

async fn log_started_activity(
    tx: &mut Transaction<'_, sqlx::Postgres>,
    context: &GoalWriteContext<'_>,
    org: &str,
    goal_id: &str,
    owner_agent_id: &str,
    packet_hash: &str,
    request_key: &str,
) -> Result<(), GoalStartError> {
    let actor_type = match context.actor_kind {
        "user" => "user",
        "agent" => "agent",
        "system" => "system",
        _ => return Err(StoreError::Unauthorized.into()),
    };
    let details = json!({"ownerAgentId": owner_agent_id, "packetHash": packet_hash});
    activity::write_activity_idempotent(
        tx,
        activity::ActivityWrite {
            org,
            audit: &activity::ActivityActor {
                actor_type,
                actor_id: context.actor_id.to_owned(),
                run_id: context.run_id.map(str::to_owned),
            },
            action: "goal.started",
            entity_type: "goal",
            entity_id: goal_id,
            details: Some(&details),
            options: activity::ActivityOptions {
                agent_id: context.actor_agent_id,
                bind_run: false,
                ..Default::default()
            },
        },
        &format!("goal-start:{request_key}"),
    )
    .await?;
    Ok(())
}

async fn read_start_owner(
    pool: &PgPool,
    org: &str,
    owner_id: &str,
) -> Result<Option<GoalStartOwner>, sqlx::Error> {
    let row = sqlx::query("SELECT id::text,status,role,title,capabilities FROM agents WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(org).bind(owner_id).fetch_optional(pool).await?;
    row.map(owner_from_row).transpose()
}

async fn read_start_owner_tx(
    tx: &mut Transaction<'_, sqlx::Postgres>,
    org: &str,
    owner_id: &str,
) -> Result<Option<GoalStartOwner>, sqlx::Error> {
    let row = sqlx::query("SELECT id::text,status,role,title,capabilities FROM agents WHERE org_id=$1::uuid AND id=$2::uuid FOR KEY SHARE")
        .bind(org).bind(owner_id).fetch_optional(&mut **tx).await?;
    row.map(owner_from_row).transpose()
}

fn owner_from_row(row: sqlx::postgres::PgRow) -> Result<GoalStartOwner, sqlx::Error> {
    Ok(GoalStartOwner {
        id: row.try_get("id")?,
        status: row.try_get("status")?,
        role: row.try_get("role")?,
        title: row.try_get("title")?,
        capabilities: row.try_get("capabilities")?,
    })
}

fn compile_preview(
    input: &GoalStartPreviewInput,
    owner: Option<&GoalStartOwner>,
) -> Result<Value, GoalStartError> {
    let title = input.title.trim();
    if !has_concrete_goal_outcome(input) {
        return Ok(outcome_blocker());
    }
    let Some(owner) = owner.filter(|owner| {
        Some(owner.id.as_str()) == input.owner_agent_id.as_deref()
            && !matches!(owner.status.as_str(), "terminated" | "pending_approval")
    }) else {
        return Ok(json!({
            "valid": false,
            "packetHash": null,
            "packet": null,
            "review": null,
            "blockers": [{"code":"owner_required","field":"ownerAgentId","message":OWNER_REQUIRED_MESSAGE}],
            "alignmentQuestion": OWNER_REQUIRED_QUESTION,
            "warning": null,
        }));
    };
    let mode = goal_mode(input);
    let context = input
        .context
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let success = if let Some(context) = context {
        format!("We will know it worked when {title} and this context is satisfied: {context}")
    } else {
        match mode.as_str() {
            "decide" => format!("A documented decision resolves: {title}"),
            "maximize" => format!("Progress is measured toward: {title}"),
            "maintain" => format!("The condition remains true: {title}"),
            _ => format!("A reviewable result shows that {title}"),
        }
    };
    let first_action = match mode.as_str() {
        "decide" => {
            "Gather the decision inputs and return with a clear recommendation and tradeoffs."
        }
        "maximize" => "Establish the current baseline and take the first measurable action.",
        "maintain" => "Confirm the current baseline and monitor the first material risk.",
        _ => "Inspect the available context and produce the first bounded, reviewable artifact.",
    };
    let evaluator = match mode.as_str() {
        "decide" => "human",
        "maximize" => "metric",
        "maintain" => "policy",
        _ => "artifact",
    };
    let description = context.map(str::to_owned);
    let activation = json!({
        "confirmed": true,
        "ownerAgentId": owner.id,
        "outcomeStatement": title,
        "objectiveMode": mode,
        "criteria": [{"id":"primary-outcome","label":success,"evaluator":evaluator}],
        "autonomyEnvelope": {
            "allowed": ["bounded_reversible_work"],
            "requiresHumanApproval": ["external_or_irreversible_action", "authority_expansion"],
        },
        "humanAuthorities": {"acceptance":"board_human","consequentialChanges":"board_human"},
        "evaluationPolicy": {"terminalEvidenceRequired":true,"humanAcceptanceRequired":true},
        "actionDeadline": null,
        "evaluationDeadline": input.target_time,
        "initialPlan": {
            "summary": first_action,
            "hypotheses": [],
            "selectedPaths": [],
            "rejectedPaths": [],
            "sequencing": [],
            "budgetAllocations": {},
            "invalidationConditions": [],
        },
        "initialContinuation": {"kind":"commitment","summary":first_action},
    });
    let packet = json!({
        "version": 1,
        "title": title,
        "description": description,
        "ownerAgentId": owner.id,
        "activation": activation,
    });
    let packet_hash = stable_goal_hash(&packet)?;
    let warning = (!owner_can_advance_goal(owner, input)).then_some(
        "This Agent may not be the best match for this Goal. You selected this Agent, so you can still start it or choose another Agent.",
    );
    Ok(json!({
        "valid": true,
        "packetHash": packet_hash,
        "packet": packet,
        "review": {
            "outcome": title,
            "success": success,
            "boundary": "The Owner may perform bounded, reversible work; consequential or irreversible actions require human approval.",
            "firstAction": first_action,
            "ownerAgentId": owner.id,
            "targetTime": input.target_time,
        },
        "blockers": [],
        "alignmentQuestion": null,
        "warning": warning,
    }))
}

fn outcome_blocker() -> Value {
    json!({
        "valid": false,
        "packetHash": null,
        "packet": null,
        "review": null,
        "blockers": [{"code":"outcome_required","field":"goal","message":OUTCOME_REQUIRED_MESSAGE}],
        "alignmentQuestion": OUTCOME_REQUIRED_QUESTION,
        "warning": null,
    })
}

fn goal_mode(input: &GoalStartPreviewInput) -> String {
    let title = input.title.trim();
    if let Some(mode) = mode_in_text(title) {
        return mode.to_owned();
    }
    if has_outcome_pattern(title) {
        return "target".to_owned();
    }
    if let Some(mode) = mode_in_text(input.context.as_deref().unwrap_or_default().trim()) {
        return mode.to_owned();
    }
    "target".to_owned()
}

fn mode_in_text(text: &str) -> Option<&'static str> {
    if word_match(
        text,
        &["choose", "select", "decide", "recommend", "approve"],
    ) || ["选择", "决定", "推荐", "批准"]
        .iter()
        .any(|needle| text.contains(needle))
    {
        Some("decide")
    } else if word_match(
        text,
        &["maintain", "keep", "sustain", "preserve", "prevent"],
    ) || ["保持", "维持", "防止", "确保持续"]
        .iter()
        .any(|needle| text.contains(needle))
    {
        Some("maintain")
    } else if word_match(
        text,
        &[
            "increase",
            "reduce",
            "decrease",
            "grow",
            "improve by",
            "maximize",
            "maximise",
            "minimize",
            "minimise",
        ],
    ) || ["提升", "增加", "降低", "减少", "增长", "最大化", "最小化"]
        .iter()
        .any(|needle| text.contains(needle))
    {
        Some("maximize")
    } else {
        None
    }
}

fn has_concrete_goal_outcome(input: &GoalStartPreviewInput) -> bool {
    let title = input.title.trim();
    if title.encode_utf16().count() < 8 {
        return false;
    }
    let combined = format!(
        "{title} {}",
        input.context.as_deref().unwrap_or_default().trim()
    );
    has_outcome_pattern(&combined)
        || meaningful_tokens(&combined).len() >= 4
        || has_six_han_chars(&combined)
}

fn has_outcome_pattern(text: &str) -> bool {
    word_match(
        text,
        &[
            "ship",
            "publish",
            "launch",
            "deliver",
            "create",
            "created",
            "creation",
            "build",
            "complete",
            "completed",
            "completion",
            "finish",
            "deploy",
            "release",
            "migrate",
            "implement",
            "fix",
            "resolve",
            "remove",
            "establish",
            "achieve",
            "reach",
            "increase",
            "reduce",
            "decrease",
            "grow",
            "choose",
            "select",
            "decide",
            "approve",
            "pass",
            "verify",
            "maintain",
            "keep",
            "sustain",
            "recommend",
            "submit",
        ],
    ) || [
        "发布", "上线", "交付", "创建", "构建", "完成", "部署", "发版", "迁移", "实现", "修复",
        "解决", "删除", "建立", "达到", "提升", "增加", "降低", "减少", "增长", "选择", "决定",
        "批准", "通过", "验证", "保持", "维持", "产出", "提交",
    ]
    .iter()
    .any(|needle| text.contains(needle))
        || numeric_measurement(text)
}

fn numeric_measurement(text: &str) -> bool {
    let numeric = regex_lite::Regex::new(r"(?i)([0-9]{1,3}(,[0-9]{3})+|[0-9]+(\.[0-9]+)?)\s*(%|percent|x|[kmb]|倍|个|项|天|周|月|年)|([$€£¥￥]\s*\d)")
        .expect("constant Goal measurement regex");
    numeric.is_match(text)
}

fn meaningful_tokens(value: &str) -> HashSet<String> {
    let lower = value.to_lowercase();
    let characters = lower.chars().collect::<Vec<_>>();
    let mut tokens = HashSet::new();
    let mut index = 0;
    while index < characters.len() {
        if characters[index].is_ascii_alphanumeric() {
            let start = index;
            while index < characters.len() && characters[index].is_ascii_alphanumeric() {
                index += 1;
            }
            insert_meaningful_token(&mut tokens, characters[start..index].iter().collect());
            continue;
        }
        if is_han(characters[index]) {
            let start = index;
            while index < characters.len() && is_han(characters[index]) {
                index += 1;
            }
            if index - start >= 2 {
                insert_meaningful_token(&mut tokens, characters[start..index].iter().collect());
            }
            continue;
        }
        index += 1;
    }
    tokens
}

fn insert_meaningful_token(tokens: &mut HashSet<String>, mut token: String) {
    for suffix in ["ing", "ed", "es", "s"] {
        if token.ends_with(suffix) {
            token.truncate(token.len() - suffix.len());
            break;
        }
    }
    if token.chars().count() >= 3 && !capability_stop_word(&token) {
        tokens.insert(token);
    }
}

fn capability_stop_word(token: &str) -> bool {
    matches!(
        token,
        "about"
            | "after"
            | "agent"
            | "and"
            | "are"
            | "available"
            | "before"
            | "bounded"
            | "can"
            | "context"
            | "external"
            | "first"
            | "for"
            | "from"
            | "goal"
            | "have"
            | "into"
            | "must"
            | "not"
            | "produce"
            | "result"
            | "should"
            | "that"
            | "the"
            | "their"
            | "this"
            | "through"
            | "user"
            | "will"
            | "with"
            | "work"
    )
}

fn is_han(character: char) -> bool {
    matches!(character as u32,
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF |
        0x20000..=0x2A6DF | 0x2A700..=0x2B73F | 0x2B740..=0x2B81F |
        0x2B820..=0x2CEAF | 0x2CEB0..=0x2EBEF | 0x2F800..=0x2FA1F |
        0x30000..=0x3134F | 0x31350..=0x323AF)
}

fn has_six_han_chars(value: &str) -> bool {
    let mut run = 0;
    value.chars().any(|character| {
        if is_han(character) {
            run += 1;
            run >= 6
        } else {
            run = 0;
            false
        }
    })
}

fn owner_can_advance_goal(owner: &GoalStartOwner, input: &GoalStartPreviewInput) -> bool {
    let capabilities = owner.capabilities.as_deref().unwrap_or_default().trim();
    if capabilities.is_empty() {
        return false;
    }
    let descriptor = [
        owner.role.as_deref(),
        owner.title.as_deref(),
        Some(capabilities),
    ]
    .into_iter()
    .flatten()
    .filter(|value| !value.is_empty())
    .collect::<Vec<_>>()
    .join(" ");
    if broad_capability_match(&descriptor) {
        return true;
    }
    let goal_tokens = meaningful_tokens(&format!(
        "{} {}",
        input.title,
        input.context.as_deref().unwrap_or_default()
    ));
    let capability_tokens = meaningful_tokens(&descriptor);
    if goal_tokens.intersection(&capability_tokens).count() >= 2 {
        return true;
    }
    let goal_text = format!(
        "{} {}",
        input.title,
        input.context.as_deref().unwrap_or_default()
    );
    [
        (
            (&[
                "api",
                "app",
                "build",
                "code",
                "deploy",
                "engineer",
                "implement",
                "release",
                "software",
                "system",
                "test",
                "ui",
                "workspace",
            ][..]),
            (&[
                "engineer",
                "software",
                "code",
                "develop",
                "build",
                "deploy",
                "test",
                "technical",
                "product",
            ][..]),
            &["代码", "工程", "开发", "部署", "测试", "系统", "界面"][..],
            &["工程", "开发", "代码", "部署", "测试", "技术", "产品"][..],
        ),
        (
            (&[
                "analyze",
                "analyse",
                "research",
                "study",
                "report",
                "investigate",
            ][..]),
            (&["analyst", "analysis", "research", "data", "strategy"][..]),
            &["分析", "研究", "调研", "报告"][..],
            &["分析", "研究", "数据", "策略"][..],
        ),
        (
            (&[
                "article",
                "content",
                "copy",
                "marketing",
                "publish",
                "write",
            ][..]),
            (&[
                "content",
                "copy",
                "marketing",
                "publish",
                "writer",
                "writing",
            ][..]),
            &["文章", "内容", "文案", "营销", "发布", "写作"][..],
            &["内容", "文案", "营销", "发布", "写作"][..],
        ),
        (
            (&["design", "ux", "ui", "prototype"][..]),
            (&["design", "designer", "ux", "ui", "product"][..]),
            &["设计", "原型", "界面"][..],
            &["设计", "产品", "界面"][..],
        ),
        (
            (&["budget", "finance", "invoice", "pricing", "revenue"][..]),
            (&[
                "finance",
                "financial",
                "invoice",
                "pricing",
                "revenue",
                "accounting",
            ][..]),
            &["预算", "财务", "发票", "定价", "收入"][..],
            &["财务", "定价", "收入", "会计"][..],
        ),
    ]
    .iter()
    .any(|(goal_terms, capability_terms, goal_han, capability_han)| {
        (word_match(&goal_text, goal_terms)
            || goal_han.iter().any(|needle| goal_text.contains(needle)))
            && (word_match(&descriptor, capability_terms)
                || capability_han
                    .iter()
                    .any(|needle| descriptor.contains(needle)))
    })
}

fn broad_capability_match(descriptor: &str) -> bool {
    let lower = descriptor.to_lowercase();
    let general = Regex::new(r"\bgeneral[- ]purpose\b|\bend[- ]to[- ]end\b")
        .expect("constant broad capability regex");
    if general.is_match(&lower)
        || ["通用", "端到端"]
            .iter()
            .any(|needle| descriptor.contains(needle))
    {
        return true;
    }
    let tokens = ascii_words(&lower);
    (tokens.iter().any(|token| token.starts_with("plan"))
        && tokens.iter().any(|token| token.starts_with("execut")))
        || (lower.contains("规划") && lower.contains("执行"))
}

fn word_match(value: &str, words: &[&str]) -> bool {
    let tokens = ascii_words(value);
    words.iter().any(|word| {
        if word.contains(' ') {
            value.to_lowercase().contains(&word.to_lowercase())
        } else {
            tokens.contains(&word.to_ascii_lowercase())
        }
    })
}

fn ascii_words(value: &str) -> HashSet<String> {
    value
        .to_ascii_lowercase()
        .split(|character: char| !(character.is_ascii_alphanumeric() || character == '_'))
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect()
}

fn normalize_target_time(value: &Value) -> Result<String, StoreError> {
    let parsed = match value {
        Value::String(value) => parse_goal_date_string(value)?,
        Value::Number(value) => {
            let milliseconds = value.as_f64().ok_or(StoreError::InvalidInput)?.trunc();
            if !milliseconds.is_finite() || milliseconds.abs() > 8_640_000_000_000_000.0 {
                return Err(StoreError::InvalidInput);
            }
            OffsetDateTime::from_unix_timestamp_nanos((milliseconds as i128) * 1_000_000)
                .map_err(|_| StoreError::InvalidInput)?
        }
        _ => return Err(StoreError::InvalidInput),
    };
    Ok(js_datetime(parsed))
}

fn parse_goal_date_string(value: &str) -> Result<OffsetDateTime, StoreError> {
    if value.len() == 10
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
    {
        let format = format_description::parse_borrowed::<2>("[year]-[month]-[day]")
            .map_err(|_| StoreError::InvalidInput)?;
        let date = Date::parse(value, &format).map_err(|_| StoreError::InvalidInput)?;
        return Ok(PrimitiveDateTime::new(date, Time::MIDNIGHT).assume_utc());
    }
    OffsetDateTime::parse(value, &Rfc3339).map_err(|_| StoreError::InvalidInput)
}

fn js_datetime(value: OffsetDateTime) -> String {
    let value = value.to_offset(UtcOffset::UTC);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        value.year(),
        u8::from(value.month()),
        value.day(),
        value.hour(),
        value.minute(),
        value.second(),
        value.nanosecond() / 1_000_000,
    )
}

fn stable_goal_hash(value: &Value) -> Result<String, StoreError> {
    let locale = "en-US"
        .parse::<icu_locale_core::Locale>()
        .map_err(|_| StoreError::InvalidInput)?;
    let collator = Collator::try_new(locale.into(), CollatorOptions::default())
        .map_err(|_| StoreError::InvalidInput)?;
    let canonical = canonical_json(value, &collator)?;
    let digest = Sha256::digest(canonical.as_bytes());
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn canonical_json(
    value: &Value,
    collator: &icu_collator::CollatorBorrowed<'_>,
) -> Result<String, StoreError> {
    match value {
        Value::Object(object) => {
            let mut entries = object.iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| collator.compare(left, right));
            let mut output = String::from("{");
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key).map_err(|_| StoreError::InvalidInput)?);
                output.push(':');
                output.push_str(&canonical_json(value, collator)?);
            }
            output.push('}');
            Ok(output)
        }
        Value::Array(values) => {
            let mut output = String::from("[");
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&canonical_json(value, collator)?);
            }
            output.push(']');
            Ok(output)
        }
        _ => serde_json::to_string(value).map_err(|_| StoreError::InvalidInput),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capable_owner() -> GoalStartOwner {
        GoalStartOwner {
            id: "55555555-5555-4555-8555-555555555555".to_owned(),
            status: "idle".to_owned(),
            role: Some("engineer".to_owned()),
            title: None,
            capabilities: Some(
                "Plan and execute end-to-end software releases with verifiable evidence."
                    .to_owned(),
            ),
        }
    }

    #[test]
    fn preview_hash_matches_the_existing_typescript_packet_fixture() {
        let owner = capable_owner();
        let input = GoalStartPreviewInput {
            title: "Publish a verified Goal Workspace release candidate".to_owned(),
            context: Some("Keep the result inspectable.".to_owned()),
            owner_agent_id: Some(owner.id.clone()),
            target_time: Some(json!("2026-08-20T10:00:00.000Z")),
        };
        let preview = compile_preview(&input, Some(&owner)).unwrap();

        let typescript_fixture: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/goal-start-preview-typescript.json"
        ))
        .unwrap();
        assert_eq!(preview, typescript_fixture);
    }

    #[test]
    fn start_packet_matches_zod_trimming_defaults_and_unknown_key_behavior() {
        let oracle: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/goal-start-packet-normalization-typescript.json"
        ))
        .unwrap();
        let (oracle_packet, _) = normalize_packet(&oracle["input"]).unwrap();
        assert_eq!(oracle_packet, oracle["packet"]);
        assert_eq!(
            stable_goal_hash(&oracle_packet).unwrap(),
            oracle["packetHash"]
        );

        let fixture: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/goal-start-preview-typescript.json"
        ))
        .unwrap();
        let mut raw = fixture["packet"].clone();
        raw["title"] = json!("  Publish a verified Goal Workspace release candidate  ");
        raw["activation"]["outcomeStatement"] =
            json!("  Publish a verified Goal Workspace release candidate  ");
        raw["activation"]["unknownActivationField"] = json!("discarded by z.object");
        raw["activation"]["criteria"][0]["id"] = json!(" primary-outcome ");
        raw["activation"]["criteria"][0]["label"] = json!(" normalized criterion ");
        raw["activation"]["criteria"][0]["unknownCriterionField"] = json!(true);
        raw["activation"]["initialPlan"]["summary"] = json!(" normalized plan ");
        raw["activation"]["initialPlan"]["unknownPlanField"] = json!(true);
        raw["activation"]["initialContinuation"]["summary"] = json!(" normalized continuation ");

        let raw_hash = stable_goal_hash(&raw).unwrap();
        let (normalized, validated) = normalize_packet(&raw).unwrap();
        assert_ne!(stable_goal_hash(&normalized).unwrap(), raw_hash);
        assert_eq!(
            normalized["title"],
            "Publish a verified Goal Workspace release candidate"
        );
        assert_eq!(
            normalized["activation"]["criteria"][0]["id"],
            "primary-outcome"
        );
        assert_eq!(
            normalized["activation"]["criteria"][0]["label"],
            "normalized criterion"
        );
        assert_eq!(
            normalized["activation"]["initialPlan"]["summary"],
            "normalized plan"
        );
        assert_eq!(
            normalized["activation"]["initialContinuation"]["summary"],
            "normalized continuation"
        );
        assert!(
            normalized["activation"]
                .get("unknownActivationField")
                .is_none()
        );
        assert!(
            normalized["activation"]["criteria"][0]
                .get("unknownCriterionField")
                .is_none()
        );
        assert!(
            normalized["activation"]["initialPlan"]
                .get("unknownPlanField")
                .is_none()
        );
        assert_eq!(
            normalized["activation"]["initialPlan"]["hypotheses"],
            json!([])
        );
        assert_eq!(validated.title, normalized["title"]);
        assert_eq!(validated.activation, normalized["activation"]);

        raw["unknownPacketField"] = json!(true);
        assert!(normalize_packet(&raw).is_err());
    }

    #[test]
    fn target_time_coercion_matches_zod_date_only_and_epoch_milliseconds() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/goal-start-date-coercion-typescript.json"
        ))
        .unwrap();
        let owner = capable_owner();
        let common = GoalStartPreviewInput {
            title: "把已验证的发布结果交付给客户".to_owned(),
            context: Some("面向中国用户，记录可验证证据。".to_owned()),
            owner_agent_id: Some(owner.id.clone()),
            target_time: None,
        };
        for (input_value, fixture_key) in [
            (json!("2026-10-25"), "dateOnly"),
            (json!(1_792_886_400_000_i64), "epochMillis"),
        ] {
            let normalized_time = normalize_target_time(&input_value).unwrap();
            let mut input = common.clone();
            input.target_time = Some(Value::String(normalized_time));
            assert_eq!(
                compile_preview(&input, Some(&owner)).unwrap(),
                fixture[fixture_key]
            );
        }
    }

    #[test]
    fn preview_keeps_ambiguous_outcomes_and_unavailable_owners_in_alignment() {
        let owner = capable_owner();
        let ambiguous = GoalStartPreviewInput {
            title: "Explore pricing options".to_owned(),
            context: None,
            owner_agent_id: Some(owner.id.clone()),
            target_time: None,
        };
        let preview = compile_preview(&ambiguous, Some(&owner)).unwrap();
        assert_eq!(preview["valid"], false);
        assert_eq!(preview["blockers"][0]["code"], "outcome_required");

        let clear = GoalStartPreviewInput {
            title: "Publish a verified release candidate".to_owned(),
            context: None,
            owner_agent_id: None,
            target_time: None,
        };
        let preview = compile_preview(&clear, None).unwrap();
        assert_eq!(preview["valid"], false);
        assert_eq!(preview["blockers"][0]["code"], "owner_required");
    }

    #[test]
    fn preview_preserves_mode_precedence_and_capability_warning() {
        let mut owner = capable_owner();
        let input = GoalStartPreviewInput {
            title: "Decide which pricing model to launch".to_owned(),
            context: Some("Maintain the customer budget.".to_owned()),
            owner_agent_id: Some(owner.id.clone()),
            target_time: None,
        };
        owner.capabilities = Some("Write and edit marketing articles.".to_owned());
        let preview = compile_preview(&input, Some(&owner)).unwrap();
        assert_eq!(preview["packet"]["activation"]["objectiveMode"], "decide");
        assert_eq!(
            preview["packet"]["activation"]["criteria"][0]["evaluator"],
            "human"
        );
        assert_eq!(preview["warning"].is_string(), true);
    }
}
