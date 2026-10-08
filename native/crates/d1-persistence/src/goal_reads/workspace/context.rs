//! Runtime-only Goal context composition and opaque nested JSON handling.
use super::super::{
    GoalReadError, parse_legacy_read_json, pick, public_goal, public_goal_text, text,
};
use super::{GoalRow, OpaqueJson, set_raw};
use crate::StoreError;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};

#[derive(Clone)]
pub(super) struct GoalContextRaw {
    objective_mode: String,
    contract_revision: i32,
    criteria: String,
    autonomy_envelope: String,
    human_authorities: String,
    evaluation_policy: String,
    continuation_kind: Option<String>,
}

pub(super) async fn goal_context_raw(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    goal: &Value,
) -> Result<GoalContextRaw, GoalReadError> {
    let row = sqlx::query(
        "SELECT objective_mode,contract_revision,criteria::text AS criteria,autonomy_envelope::text AS autonomy_envelope,human_authorities::text AS human_authorities,evaluation_policy::text AS evaluation_policy,continuation_kind FROM goals WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(org)
    .bind(text(goal, "id"))
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(StoreError::NotFound)?;
    Ok(GoalContextRaw {
        objective_mode: row.try_get("objective_mode")?,
        contract_revision: row.try_get("contract_revision")?,
        criteria: row.try_get("criteria")?,
        autonomy_envelope: row.try_get("autonomy_envelope")?,
        human_authorities: row.try_get("human_authorities")?,
        evaluation_policy: row.try_get("evaluation_policy")?,
        continuation_kind: row.try_get("continuation_kind")?,
    })
}

pub(super) async fn agent_context(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    goal: &GoalRow,
    raw: &GoalContextRaw,
    workspace: &Value,
    opaque: &mut Vec<OpaqueJson>,
    actor_agent_id: Option<&str>,
) -> Result<Value, GoalReadError> {
    let owner = goal.public["ownerAgentId"].as_str();
    if owner.is_none() || owner != actor_agent_id {
        return Err(StoreError::InvalidInput.into());
    }
    let goal_id = text(&goal.public, "id");
    let plan_revision = {
        let revision: Option<i32> = sqlx::query_scalar(
            "SELECT plan_revision FROM goals WHERE org_id=$1::uuid AND id=$2::uuid",
        )
        .bind(org)
        .bind(&goal_id)
        .fetch_optional(&mut **tx)
        .await?;
        revision.unwrap_or(0)
    };
    let plan = if plan_revision > 0 {
        sqlx::query(
            "SELECT revision,summary,hypotheses::text AS hypotheses,selected_paths::text AS selected_paths,rejected_paths::text AS rejected_paths,sequencing::text AS sequencing,budget_allocations::text AS budget_allocations,invalidation_conditions::text AS invalidation_conditions FROM goal_plans WHERE org_id=$1::uuid AND goal_id=$2::uuid AND revision=$3 LIMIT 1",
        )
        .bind(org)
        .bind(&goal_id)
        .bind(plan_revision)
        .fetch_optional(&mut **tx)
        .await?
    } else {
        None
    };
    let plan_value = if let Some(plan) = plan {
        let mut result = json!({
            "revision": plan.try_get::<i32,_>("revision")?,
            "summary": plan.try_get::<String,_>("summary")?,
        });
        for (field, raw_field) in [
            ("hypotheses", "hypotheses"),
            ("selectedPaths", "selected_paths"),
            ("rejectedPaths", "rejected_paths"),
            ("sequencing", "sequencing"),
            ("budgetAllocations", "budget_allocations"),
            ("invalidationConditions", "invalidation_conditions"),
        ] {
            let raw_json: Option<String> = plan.try_get(raw_field)?;
            set_raw(
                &mut result,
                field,
                raw_json.as_deref(),
                format!("/plan/{field}"),
                opaque,
            )?;
        }
        result
    } else {
        Value::Null
    };
    let checkpoints = sqlx::query(
        "SELECT id::text AS id,org_id::text AS org_id,goal_id::text AS goal_id,run_id::text AS run_id,owner_agent_id::text AS owner_agent_id,submitted_by_agent_id::text AS submitted_by_agent_id,input_hash,idempotency_key,summary,evidence_refs::text AS evidence_refs,plan_payload::text AS plan_payload,plan_revision_before,plan_revision_after,continuation_kind,continuation_summary,wake_condition,continuation_wakeup_request_id::text AS continuation_wakeup_request_id,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at FROM goal_checkpoints WHERE org_id=$1::uuid AND goal_id=$2::uuid ORDER BY created_at DESC LIMIT 3",
    )
    .bind(org)
    .bind(&goal_id)
    .fetch_all(&mut **tx)
    .await?;
    let mut recent_checkpoints = Vec::with_capacity(checkpoints.len());
    for checkpoint in checkpoints {
        let mut value = json!({
            "id": checkpoint.try_get::<String,_>("id")?,
            "orgId": checkpoint.try_get::<String,_>("org_id")?,
            "goalId": checkpoint.try_get::<String,_>("goal_id")?,
            "runId": checkpoint.try_get::<String,_>("run_id")?,
            "ownerAgentId": checkpoint.try_get::<String,_>("owner_agent_id")?,
            "submittedByAgentId": checkpoint.try_get::<String,_>("submitted_by_agent_id")?,
            "inputHash": checkpoint.try_get::<String,_>("input_hash")?,
            "idempotencyKey": checkpoint.try_get::<String,_>("idempotency_key")?,
            "summary": public_goal_text(&checkpoint.try_get::<String,_>("summary")?),
            "planRevisionBefore": checkpoint.try_get::<i32,_>("plan_revision_before")?,
            "planRevisionAfter": checkpoint.try_get::<i32,_>("plan_revision_after")?,
            "continuation": {
                "kind": checkpoint.try_get::<String,_>("continuation_kind")?,
                "summary": public_goal_text(&checkpoint.try_get::<String,_>("continuation_summary")?),
                "wakeCondition": checkpoint.try_get::<Option<String>,_>("wake_condition")?,
            },
            "continuationWakeupRequestId": checkpoint.try_get::<Option<String>,_>("continuation_wakeup_request_id")?,
            "createdAt": checkpoint.try_get::<String,_>("created_at")?,
        });
        let checkpoint_index = recent_checkpoints.len();
        let evidence_raw: Option<String> = checkpoint.try_get("evidence_refs")?;
        set_raw(
            &mut value,
            "evidenceRefs",
            evidence_raw.as_deref(),
            format!("/recentCheckpoints/{checkpoint_index}/evidenceRefs"),
            opaque,
        )?;
        let plan_payload: Option<String> = checkpoint.try_get("plan_payload")?;
        set_raw(
            &mut value,
            "planPayload",
            plan_payload.as_deref(),
            format!("/recentCheckpoints/{checkpoint_index}/planPayload"),
            opaque,
        )?;
        recent_checkpoints.push(value);
    }
    if let Some(latest) = recent_checkpoints.first() {
        for key in ["evidenceRefs", "planPayload"] {
            if let Some(marker) = latest[key].as_str()
                && let Some(entry) = opaque.iter_mut().find(|entry| entry.marker == marker)
            {
                entry.paths.push(format!("/latestCheckpoint/{key}"));
            }
        }
    }
    let pending_wake = pending_continuation_wake(tx, org, &goal_id, opaque).await?;
    let lifecycle = text(&goal.public, "lifecycle");
    let goal_public = pick(
        &public_goal(&goal.public),
        &[
            "id",
            "orgId",
            "title",
            "description",
            "lifecycle",
            "status",
            "ownerAgentId",
            "focus",
            "closeReason",
            "createdAt",
            "updatedAt",
        ],
    );
    let mut contract = json!({
        "revision": raw.contract_revision,
        "outcomeStatement": goal.public["outcomeStatement"],
        "objectiveMode": raw.objective_mode,
        "actionDeadline": goal.public["actionDeadline"],
        "evaluationDeadline": goal.public["evaluationDeadline"],
    });
    set_raw(
        &mut contract,
        "criteria",
        Some(&raw.criteria),
        "/contract/criteria".to_owned(),
        opaque,
    )?;
    set_raw(
        &mut contract,
        "autonomyEnvelope",
        Some(&raw.autonomy_envelope),
        "/contract/autonomyEnvelope".to_owned(),
        opaque,
    )?;
    set_raw(
        &mut contract,
        "humanAuthorities",
        Some(&raw.human_authorities),
        "/contract/humanAuthorities".to_owned(),
        opaque,
    )?;
    set_raw(
        &mut contract,
        "evaluationPolicy",
        Some(&raw.evaluation_policy),
        "/contract/evaluationPolicy".to_owned(),
        opaque,
    )?;
    let continuation = if let Some(kind) = raw.continuation_kind.as_deref() {
        json!({
            "kind": kind,
            "summary": goal.public["continuationSummary"].as_str().unwrap_or_default(),
            "wakeCondition": goal.public["wakeCondition"],
        })
    } else {
        Value::Null
    };
    let state = pick(
        workspace,
        &[
            "facet",
            "currentProgress",
            "agentAction",
            "nextStep",
            "attention",
        ],
    );
    let pending = json!({
        "changeProposals": workspace["changeProposals"],
        "resultProposals": workspace["resultProposals"],
    });
    let recent_history = workspace["timeline"]
        .as_array()
        .into_iter()
        .flatten()
        .take(20)
        .cloned()
        .collect::<Vec<_>>();
    Ok(json!({
        "goal": goal_public,
        "contract": contract,
        "plan": plan_value,
        "continuation": continuation,
        "latestCheckpoint": recent_checkpoints.first(),
        "recentCheckpoints": recent_checkpoints,
        "pendingContinuationWake": pending_wake,
        "state": state,
        "pending": pending,
        "recentHistory": recent_history,
        "allowedActions": {
            "reportProgress": lifecycle == "active",
            "proposeChange": lifecycle == "active",
            "proposeResult": lifecycle == "active",
        },
    }))
}

async fn pending_continuation_wake(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    goal_id: &str,
    opaque: &mut Vec<OpaqueJson>,
) -> Result<Value, GoalReadError> {
    let row = sqlx::query(
        "SELECT id::text AS id,status,CASE WHEN jsonb_typeof(payload->'planRevision')='number' THEN payload->'planRevision' ELSE 'null'::jsonb END::text AS plan_revision,CASE WHEN jsonb_typeof(payload->'checkpointId')='string' THEN payload->'checkpointId' ELSE 'null'::jsonb END::text AS checkpoint_id,CASE WHEN jsonb_typeof(payload->'continuation')='object' THEN (payload->'continuation')::text ELSE '{}' END AS continuation FROM agent_wakeup_requests WHERE org_id=$1::uuid AND payload->>'goalId'=$2 AND reason='goal_continuation' AND status IN ('queued','deferred_goal_focus','deferred_agent_paused','deferred_goal_blocked') AND run_id IS NULL ORDER BY requested_at DESC LIMIT 1",
    )
    .bind(org)
    .bind(goal_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(row) = row else {
        return Ok(Value::Null);
    };
    let mut value = json!({
        "id": row.try_get::<String,_>("id")?,
        "status": row.try_get::<String,_>("status")?,
        "planRevision": parse_legacy_read_json(&row.try_get::<String,_>("plan_revision")?).map_err(|_| StoreError::InvalidReceipt)?,
        "checkpointId": parse_legacy_read_json(&row.try_get::<String,_>("checkpoint_id")?).map_err(|_| StoreError::InvalidReceipt)?,
    });
    let continuation = row.try_get::<String, _>("continuation")?;
    set_raw(
        &mut value,
        "continuation",
        Some(&continuation),
        "/pendingContinuationWake/continuation".to_owned(),
        opaque,
    )?;
    Ok(value)
}
