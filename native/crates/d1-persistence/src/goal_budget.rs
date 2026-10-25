//! Budget settlement effects for native Goal Runs.
//!
//! This ports the existing billed-cents policy behavior used by
//! `budgets.evaluateCostEvent`: organization and Agent scopes, UTC month or
//! lifetime windows, soft/hard incidents, hard-stop pause, audit, and owned
//! native Goal cancellation. Legacy process cancellation stays with its
//! existing owner and is not performed from this module.

use serde_json::json;
use sqlx::{Postgres, Row, Transaction};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum GoalBudgetError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    GoalRun(#[from] crate::goal_runs::GoalRunError),
    #[error(transparent)]
    NativeChat(#[from] crate::native_chat::Error),
}

#[derive(Clone, Debug)]
pub(crate) struct GoalCostEventRef<'a> {
    pub id: &'a str,
    pub org_id: &'a str,
    pub agent_id: &'a str,
}

#[derive(Clone, Debug)]
struct BudgetPolicy {
    id: String,
    scope_type: String,
    scope_id: String,
    metric: String,
    window_kind: String,
    amount: i32,
    warn_percent: i32,
    hard_stop_enabled: bool,
    notify_enabled: bool,
}

#[derive(Clone, Debug)]
struct Incident {
    id: String,
    approval_id: Option<String>,
    created: bool,
}

/// Evaluate one ledger event and write its budget marker in the caller's
/// transaction. The caller holds the organization budget/policy lock so that
/// the event and any concurrent policy change observe one serialized state.
pub(crate) async fn evaluate_cost_event(
    tx: &mut Transaction<'_, Postgres>,
    event: &GoalCostEventRef<'_>,
) -> Result<(), GoalBudgetError> {
    let policies = sqlx::query(
        "SELECT id::text AS id,scope_type,scope_id::text AS scope_id,metric,
                window_kind,amount,warn_percent,hard_stop_enabled,notify_enabled
         FROM budget_policies
         WHERE org_id=$1::uuid AND is_active=true
           AND scope_type IN ('organization','agent')
           AND ((scope_type='organization' AND scope_id=$1::uuid)
             OR (scope_type='agent' AND scope_id=$2::uuid))
         ORDER BY CASE scope_type WHEN 'organization' THEN 0 ELSE 1 END,id",
    )
    .bind(event.org_id)
    .bind(event.agent_id)
    .fetch_all(&mut **tx)
    .await?
    .into_iter()
    .map(|row| {
        Ok(BudgetPolicy {
            id: row.try_get("id")?,
            scope_type: row.try_get("scope_type")?,
            scope_id: row.try_get("scope_id")?,
            metric: row.try_get("metric")?,
            window_kind: row.try_get("window_kind")?,
            amount: row.try_get("amount")?,
            warn_percent: row.try_get("warn_percent")?,
            hard_stop_enabled: row.try_get("hard_stop_enabled")?,
            notify_enabled: row.try_get("notify_enabled")?,
        })
    })
    .collect::<Result<Vec<_>, sqlx::Error>>()?;

    for policy in policies {
        if policy.metric != "billed_cents" || policy.amount <= 0 {
            continue;
        }
        let (window_start, window_end) = policy_window(tx, &policy.window_kind).await?;
        let observed =
            observed_amount(tx, event.org_id, &policy, &window_start, &window_end).await?;
        let soft_threshold =
            ((f64::from(policy.amount) * f64::from(policy.warn_percent)) / 100.0).ceil() as i32;

        if policy.notify_enabled && observed >= soft_threshold {
            let incident = create_incident_if_needed(
                tx,
                event.org_id,
                &policy,
                "soft",
                observed,
                &window_start,
                &window_end,
            )
            .await?;
            if incident.created {
                log_budget_activity(tx, event, &policy, &incident, "soft", observed).await?;
            }
        }

        if policy.hard_stop_enabled && observed >= policy.amount {
            sqlx::query(
                "UPDATE budget_incidents SET status='resolved',resolved_at=statement_timestamp(),
                   updated_at=statement_timestamp()
                 WHERE policy_id=$1::uuid AND threshold_type='soft' AND status='open'",
            )
            .bind(&policy.id)
            .execute(&mut **tx)
            .await?;
            let incident = create_incident_if_needed(
                tx,
                event.org_id,
                &policy,
                "hard",
                observed,
                &window_start,
                &window_end,
            )
            .await?;
            pause_scope(tx, event.org_id, &policy).await?;
            cancel_pending_native_goal_wakeups(tx, event.org_id, &policy).await?;
            cancel_active_native_goal_runs(tx, event, &policy).await?;
            cancel_pending_legacy_wakeups(tx, event.org_id, &policy).await?;
            request_legacy_run_cancellation(tx, event.org_id, &policy).await?;
            request_native_chat_stops(tx, event.org_id, &policy).await?;
            if incident.created {
                log_budget_activity(tx, event, &policy, &incident, "hard", observed).await?;
            }
        }
    }

    sqlx::query(
        "UPDATE cost_events SET budget_evaluated_at=statement_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid AND budget_evaluated_at IS NULL",
    )
    .bind(event.org_id)
    .bind(event.id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn policy_window(
    tx: &mut Transaction<'_, Postgres>,
    window_kind: &str,
) -> Result<(String, String), GoalBudgetError> {
    let row = sqlx::query(
        "SELECT to_char(window_start AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS window_start,
                to_char(window_end AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS window_end
         FROM (SELECT CASE WHEN $1='lifetime'
                    THEN timestamptz '1970-01-01 00:00:00+00'
                    ELSE date_trunc('month',statement_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                  END AS window_start,
                  CASE WHEN $1='lifetime'
                    THEN timestamptz '9999-01-01 00:00:00+00'
                    ELSE (date_trunc('month',statement_timestamp() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC'
                  END AS window_end) bounds",
    )
    .bind(window_kind)
    .fetch_one(&mut **tx)
    .await?;
    Ok((row.try_get("window_start")?, row.try_get("window_end")?))
}

async fn observed_amount(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    policy: &BudgetPolicy,
    window_start: &str,
    window_end: &str,
) -> Result<i32, GoalBudgetError> {
    let amount = match (policy.scope_type.as_str(), policy.window_kind.as_str()) {
        ("agent", "lifetime") => {
            sqlx::query_scalar::<_, i32>(
                "SELECT COALESCE(sum(cost_cents),0)::int FROM cost_events WHERE org_id=$1::uuid AND agent_id=$2::uuid",
            )
            .bind(org_id)
            .bind(&policy.scope_id)
            .fetch_one(&mut **tx)
            .await?
        }
        ("agent", _) => {
            sqlx::query_scalar::<_, i32>(
                "SELECT COALESCE(sum(cost_cents),0)::int FROM cost_events
                 WHERE org_id=$1::uuid AND agent_id=$2::uuid
                   AND occurred_at >= $3::timestamptz AND occurred_at < $4::timestamptz",
            )
            .bind(org_id)
            .bind(&policy.scope_id)
            .bind(window_start)
            .bind(window_end)
            .fetch_one(&mut **tx)
            .await?
        }
        ("organization", "lifetime") => {
            sqlx::query_scalar::<_, i32>(
                "SELECT COALESCE(sum(cost_cents),0)::int FROM cost_events WHERE org_id=$1::uuid",
            )
            .bind(org_id)
            .fetch_one(&mut **tx)
            .await?
        }
        _ => {
            // Node's resolveWindow treats every non-lifetime value as the
            // current UTC calendar month. Preserve that existing behavior.
            sqlx::query_scalar::<_, i32>(
                "SELECT COALESCE(sum(cost_cents),0)::int FROM cost_events
                 WHERE org_id=$1::uuid AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz",
            )
            .bind(org_id)
            .bind(window_start)
            .bind(window_end)
            .fetch_one(&mut **tx)
            .await?
        }
    };
    Ok(amount)
}

async fn scope_name(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    policy: &BudgetPolicy,
) -> Result<String, GoalBudgetError> {
    let name = if policy.scope_type == "organization" {
        sqlx::query_scalar::<_, String>("SELECT name FROM organizations WHERE id=$1::uuid")
            .bind(org_id)
            .fetch_optional(&mut **tx)
            .await?
    } else {
        sqlx::query_scalar::<_, String>(
            "SELECT name FROM agents WHERE org_id=$1::uuid AND id=$2::uuid",
        )
        .bind(org_id)
        .bind(&policy.scope_id)
        .fetch_optional(&mut **tx)
        .await?
    };
    Ok(name.unwrap_or_else(|| policy.scope_type.clone()))
}

async fn create_incident_if_needed(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    policy: &BudgetPolicy,
    threshold_type: &str,
    observed: i32,
    window_start: &str,
    window_end: &str,
) -> Result<Incident, GoalBudgetError> {
    if let Some(existing) = sqlx::query(
        "SELECT id::text AS id,approval_id::text AS approval_id FROM budget_incidents
         WHERE policy_id=$1::uuid AND window_start=$2::timestamptz
           AND threshold_type=$3 AND status <> 'dismissed' LIMIT 1",
    )
    .bind(&policy.id)
    .bind(window_start)
    .bind(threshold_type)
    .fetch_optional(&mut **tx)
    .await?
    {
        return Ok(Incident {
            id: existing.try_get("id")?,
            approval_id: existing.try_get("approval_id")?,
            created: false,
        });
    }

    let inserted: Option<String> = sqlx::query_scalar(
        "INSERT INTO budget_incidents
           (org_id,policy_id,scope_type,scope_id,metric,window_kind,window_start,
            window_end,threshold_type,amount_limit,amount_observed,status)
         VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5,$6,$7::timestamptz,$8::timestamptz,
            $9,$10,$11,'open')
         ON CONFLICT (policy_id,window_start,threshold_type) WHERE status <> 'dismissed'
         DO NOTHING RETURNING id::text",
    )
    .bind(org_id)
    .bind(&policy.id)
    .bind(&policy.scope_type)
    .bind(&policy.scope_id)
    .bind(&policy.metric)
    .bind(&policy.window_kind)
    .bind(window_start)
    .bind(window_end)
    .bind(threshold_type)
    .bind(policy.amount)
    .bind(observed)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(incident_id) = inserted else {
        let existing = sqlx::query(
            "SELECT id::text AS id,approval_id::text AS approval_id FROM budget_incidents
             WHERE policy_id=$1::uuid AND window_start=$2::timestamptz
               AND threshold_type=$3 AND status <> 'dismissed' LIMIT 1",
        )
        .bind(&policy.id)
        .bind(window_start)
        .bind(threshold_type)
        .fetch_one(&mut **tx)
        .await?;
        return Ok(Incident {
            id: existing.try_get("id")?,
            approval_id: existing.try_get("approval_id")?,
            created: false,
        });
    };

    if threshold_type != "hard" {
        return Ok(Incident {
            id: incident_id,
            approval_id: None,
            created: true,
        });
    }

    let name = scope_name(tx, org_id, policy).await?;
    let payload = json!({
        "scopeType": policy.scope_type,
        "scopeId": policy.scope_id,
        "scopeName": if policy.scope_type == "organization" {
            name.clone()
        } else if name.trim().is_empty() {
            policy.scope_type.clone()
        } else {
            name.clone()
        },
        "metric": policy.metric,
        "windowKind": policy.window_kind,
        "thresholdType": threshold_type,
        "budgetAmount": policy.amount,
        "observedAmount": observed,
        "warnPercent": policy.warn_percent,
        "windowStart": window_start,
        "windowEnd": window_end,
        "policyId": policy.id,
        "guidance": "Raise the budget and resume the scope, or keep the scope paused.",
    });
    let approval_id: String = sqlx::query_scalar(
        "INSERT INTO approvals(org_id,type,requested_by_user_id,requested_by_agent_id,status,payload)
         VALUES($1::uuid,'budget_override_required',NULL,NULL,'pending',$2::jsonb)
         RETURNING id::text",
    )
    .bind(org_id)
    .bind(payload.to_string())
    .fetch_one(&mut **tx)
    .await?;
    sqlx::query("UPDATE budget_incidents SET approval_id=$2::uuid WHERE id=$1::uuid")
        .bind(&incident_id)
        .bind(&approval_id)
        .execute(&mut **tx)
        .await?;
    Ok(Incident {
        id: incident_id,
        approval_id: Some(approval_id),
        created: true,
    })
}

async fn pause_scope(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    policy: &BudgetPolicy,
) -> Result<(), GoalBudgetError> {
    match policy.scope_type.as_str() {
        "agent" => {
            sqlx::query(
                "UPDATE agents SET status='paused',pause_reason='budget',
                   paused_at=statement_timestamp(),updated_at=statement_timestamp()
                 WHERE org_id=$1::uuid AND id=$2::uuid
                   AND status IN ('active','idle','running','error')",
            )
            .bind(org_id)
            .bind(&policy.scope_id)
            .execute(&mut **tx)
            .await?;
        }
        "organization" => {
            sqlx::query(
                "UPDATE organizations SET status='paused',pause_reason='budget',
                   paused_at=statement_timestamp(),updated_at=statement_timestamp()
                 WHERE id=$1::uuid",
            )
            .bind(org_id)
            .execute(&mut **tx)
            .await?;
        }
        _ => {}
    }
    Ok(())
}

async fn cancel_pending_native_goal_wakeups(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    policy: &BudgetPolicy,
) -> Result<(), GoalBudgetError> {
    let agent_filter = (policy.scope_type == "agent")
        .then_some(" AND agent_id=$2::uuid")
        .unwrap_or("");
    let sql = format!(
        "UPDATE agent_wakeup_requests SET status='cancelled',finished_at=statement_timestamp(),
           error='Cancelled due to budget pause',updated_at=statement_timestamp()
         WHERE org_id=$1::uuid AND execution_authority='native_rust' AND run_id IS NULL
           AND status IN ('queued','deferred_issue_execution','deferred_agent_paused',
                          'deferred_goal_focus','deferred_goal_blocked'){agent_filter}"
    );
    let mut query = sqlx::query(&sql).bind(org_id);
    if policy.scope_type == "agent" {
        query = query.bind(&policy.scope_id);
    }
    query.execute(&mut **tx).await?;
    Ok(())
}

async fn cancel_active_native_goal_runs(
    tx: &mut Transaction<'_, Postgres>,
    event: &GoalCostEventRef<'_>,
    policy: &BudgetPolicy,
) -> Result<(), GoalBudgetError> {
    let agent_filter = (policy.scope_type == "agent")
        .then_some(" AND agent_id=$2::uuid")
        .unwrap_or("");
    let sql = format!(
        "SELECT id::text FROM heartbeat_runs WHERE org_id=$1::uuid
           AND execution_authority='native_rust' AND goal_id IS NOT NULL
           AND scene='heartbeat' AND target_type='wakeup_request' AND status='running'{agent_filter}
         ORDER BY created_at,id"
    );
    let mut query = sqlx::query_scalar::<_, String>(&sql).bind(event.org_id);
    if policy.scope_type == "agent" {
        query = query.bind(&policy.scope_id);
    }
    let run_ids = query.fetch_all(&mut **tx).await?;
    for run_id in run_ids {
        crate::goal_runs::request_cancel_in_transaction(
            tx,
            event.org_id,
            &run_id,
            "Cancelled due to budget pause",
        )
        .await?;
    }
    Ok(())
}

async fn cancel_pending_legacy_wakeups(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    policy: &BudgetPolicy,
) -> Result<(), GoalBudgetError> {
    let agent_filter = (policy.scope_type == "agent")
        .then_some(" AND agent_id=$2::uuid")
        .unwrap_or("");
    let sql = format!(
        "UPDATE agent_wakeup_requests SET status='cancelled',finished_at=statement_timestamp(),
           error='Cancelled due to budget pause',updated_at=statement_timestamp()
         WHERE org_id=$1::uuid AND execution_authority='legacy_ts' AND run_id IS NULL
           AND status IN ('queued','deferred_issue_execution'){agent_filter}"
    );
    let mut query = sqlx::query(&sql).bind(org_id);
    if policy.scope_type == "agent" {
        query = query.bind(&policy.scope_id);
    }
    query.execute(&mut **tx).await?;
    Ok(())
}

/// Persist a Rust-selected cancellation intent for legacy owners. Their
/// existing renewal/cleanup path owns process termination and terminal state;
/// this transaction never clears their lease or claims cleanup proof.
async fn request_legacy_run_cancellation(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    policy: &BudgetPolicy,
) -> Result<(), GoalBudgetError> {
    let agent_filter = (policy.scope_type == "agent")
        .then_some(" AND agent_id=$2::uuid")
        .unwrap_or("");
    let sql = format!(
        "UPDATE heartbeat_runs SET error='Cancelled due to budget pause',
           error_code='cancel_requested',updated_at=statement_timestamp()
         WHERE org_id=$1::uuid AND execution_authority='legacy_ts'
           AND status IN ('queued','running') AND error_code IS DISTINCT FROM 'cancel_requested'
           {agent_filter}"
    );
    let mut query = sqlx::query(&sql).bind(org_id);
    if policy.scope_type == "agent" {
        query = query.bind(&policy.scope_id);
    }
    query.execute(&mut **tx).await?;
    Ok(())
}

async fn request_native_chat_stops(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    policy: &BudgetPolicy,
) -> Result<(), GoalBudgetError> {
    let agent_filter = (policy.scope_type == "agent")
        .then_some(" AND agent_id=$2::uuid")
        .unwrap_or("");
    let sql = format!(
        "SELECT id::text FROM heartbeat_runs WHERE org_id=$1::uuid
           AND execution_authority='native_rust' AND chat_generation_id IS NOT NULL
           AND scene='chat' AND target_type='chat_conversation' AND status='running'{agent_filter}
         ORDER BY chat_conversation_id,id"
    );
    let mut query = sqlx::query_scalar::<_, String>(&sql).bind(org_id);
    if policy.scope_type == "agent" {
        query = query.bind(&policy.scope_id);
    }
    let run_ids = query.fetch_all(&mut **tx).await?;
    for run_id in run_ids {
        crate::native_chat::control::request_budget_stop_in_transaction(tx, org_id, &run_id)
            .await?;
    }
    Ok(())
}

async fn log_budget_activity(
    tx: &mut Transaction<'_, Postgres>,
    event: &GoalCostEventRef<'_>,
    policy: &BudgetPolicy,
    incident: &Incident,
    threshold_type: &str,
    observed: i32,
) -> Result<(), GoalBudgetError> {
    let scope_type = &policy.scope_type;
    let scope_id = &policy.scope_id;
    let details = if threshold_type == "hard" {
        json!({
            "scopeType": scope_type,
            "scopeId": scope_id,
            "amountObserved": observed,
            "amountLimit": policy.amount,
            "approvalId": incident.approval_id,
        })
    } else {
        json!({
            "scopeType": scope_type,
            "scopeId": scope_id,
            "amountObserved": observed,
            "amountLimit": policy.amount,
        })
    };
    let action = if threshold_type == "hard" {
        "budget.hard_threshold_crossed"
    } else {
        "budget.soft_threshold_crossed"
    };
    sqlx::query(
        "INSERT INTO activity_log
           (org_id,actor_type,actor_id,action,entity_type,entity_id,agent_id,run_id,details,idempotency_key)
         VALUES($1::uuid,'system','budget_service',$2,'budget_incident',$3,$4::uuid,NULL,$5::jsonb,$6)
         ON CONFLICT (org_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING",
    )
    .bind(event.org_id)
    .bind(action)
    .bind(&incident.id)
    .bind((policy.scope_type == "agent").then_some(policy.scope_id.as_str()))
    .bind(details.to_string())
    .bind(format!("goal-budget:{}:{}:{}", event.id, policy.id, threshold_type))
    .execute(&mut **tx)
    .await?;
    Ok(())
}
