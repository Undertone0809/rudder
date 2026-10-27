//! Shared native heartbeat ledger receipt and idempotent settlement helpers.
//! Goal and generic execution retain one finalizer key and rollup writer.

use crate::goal_costs::GoalCostError;
use serde_json::Value;
use sqlx::{Postgres, Row, Transaction};

#[derive(Clone, Debug)]
pub(crate) struct RunCostReceipt {
    pub(crate) organization_id: String,
    pub(crate) agent_id: String,
    pub(crate) goal_id: Option<String>,
    pub(crate) issue_id: Option<String>,
    pub(crate) project_id: Option<String>,
    pub(crate) billing_code: Option<String>,
    pub(crate) session_id: Option<String>,
    pub(crate) run_id: String,
    pub(crate) status: String,
    pub(crate) error: Option<String>,
    pub(crate) usage: Value,
    pub(crate) ledger_usage: Option<Value>,
    pub(crate) result: Value,
}

#[derive(Clone, Debug)]
struct LedgerReceipt {
    inserted: bool,
    provider: String,
    biller: String,
    billing_type: String,
    model: String,
    input_tokens: i32,
    cached_input_tokens: i32,
    output_tokens: i32,
    cost_cents: i32,
}

/// One ledger implementation for Goal and generic Agent terminal effects.
/// The caller holds the existing organization/policy and Run/effect fences.
pub(crate) async fn settle_ledger(
    tx: &mut Transaction<'_, Postgres>,
    receipt: &RunCostReceipt,
) -> Result<(), GoalCostError> {
    let ledger = normalize_ledger_receipt(receipt)?;
    let event = if should_write_cost_event(&ledger) {
        let event = insert_cost_event(tx, receipt, &ledger).await?;
        if event.inserted {
            update_monthly_rollups(tx, receipt, &ledger).await?;
            update_spent_monthly(tx, receipt).await?;
        }
        Some(event)
    } else {
        None
    };
    update_agent_runtime_state(
        tx,
        receipt,
        &ledger,
        event.as_ref().is_some_and(|event| event.inserted),
    )
    .await
}

fn bounded_nonnegative_i32(value: Option<&Value>) -> Result<i32, GoalCostError> {
    let value = value.and_then(Value::as_i64).unwrap_or_default().max(0);
    i32::try_from(value).map_err(|_| GoalCostError::InvalidReceipt)
}

fn normalize_ledger_receipt(run: &RunCostReceipt) -> Result<LedgerReceipt, GoalCostError> {
    let usage = run.ledger_usage.as_ref().unwrap_or(&run.usage);
    let provider = run
        .result
        .get("provider")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("unknown")
        .trim()
        .to_owned();
    let biller = run
        .result
        .get("biller")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&provider)
        .trim()
        .to_owned();
    let raw_billing = usage
        .get("billingType")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let billing_type = match raw_billing.trim() {
        "api" | "metered_api" => "metered_api",
        "subscription" | "subscription_included" => "subscription_included",
        "subscription_overage" => "subscription_overage",
        "credits" => "credits",
        "fixed" => "fixed",
        _ => "unknown",
    }
    .to_owned();
    let cost_usd = usage
        .get("costUsd")
        .and_then(Value::as_f64)
        .or_else(|| {
            run.result
                .get("totalCostUsdMicros")
                .and_then(Value::as_u64)
                .map(|micros| micros as f64 / 1_000_000.0)
        })
        .unwrap_or_default();
    if !cost_usd.is_finite() {
        return Err(GoalCostError::InvalidReceipt);
    }
    let cost_cents = if billing_type == "subscription_included" {
        0
    } else {
        (cost_usd * 100.0).round().max(0.0) as i64
    };
    let cost_cents = i32::try_from(cost_cents).map_err(|_| GoalCostError::InvalidReceipt)?;
    let input_tokens =
        bounded_nonnegative_i32(usage.get("rawInputTokens").or(usage.get("inputTokens")))?;
    let cached_input_tokens = bounded_nonnegative_i32(
        usage
            .get("rawCachedInputTokens")
            .or(usage.get("cachedInputTokens")),
    )?;
    let output_tokens =
        bounded_nonnegative_i32(usage.get("rawOutputTokens").or(usage.get("outputTokens")))?;
    let model = run
        .result
        .get("model")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("unknown")
        .to_owned();
    Ok(LedgerReceipt {
        inserted: false,
        provider,
        biller,
        billing_type,
        model,
        input_tokens,
        cached_input_tokens,
        output_tokens,
        cost_cents,
    })
}

fn should_write_cost_event(ledger: &LedgerReceipt) -> bool {
    ledger.cost_cents > 0
        || ledger.input_tokens > 0
        || ledger.cached_input_tokens > 0
        || ledger.output_tokens > 0
}

async fn insert_cost_event(
    tx: &mut Transaction<'_, Postgres>,
    run: &RunCostReceipt,
    ledger: &LedgerReceipt,
) -> Result<LedgerReceipt, GoalCostError> {
    let idempotency_key = format!("heartbeat-run-finalizer:{}", run.run_id);
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("heartbeat-run-cost:{}", run.run_id))
        .execute(&mut **tx)
        .await?;

    // Match the existing Node finalizer's adoption behavior. Older run costs
    // could have been written without an idempotency key; adopt only an exact
    // Goal-scoped match so a retry does not charge the same result twice.
    let keyed_event_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM cost_events WHERE org_id=$1::uuid AND idempotency_key=$2)",
    )
    .bind(&run.organization_id)
    .bind(&idempotency_key)
    .fetch_one(&mut **tx)
    .await?;
    let legacy_id: Option<String> = if keyed_event_exists {
        None
    } else {
        sqlx::query_scalar(
            "SELECT id::text FROM cost_events
         WHERE org_id=$1::uuid AND heartbeat_run_id=$2::uuid
           AND idempotency_key IS NULL AND agent_id=$3::uuid
           AND issue_id IS NOT DISTINCT FROM $13::uuid AND project_id IS NOT DISTINCT FROM $14::uuid AND goal_id IS NOT DISTINCT FROM $4::uuid
           AND billing_code IS NOT DISTINCT FROM $15 AND provider=$5 AND biller=$6
           AND billing_type=$7 AND model=$8 AND input_tokens=$9
           AND cached_input_tokens=$10 AND output_tokens=$11 AND cost_cents=$12
         ORDER BY created_at DESC,id DESC LIMIT 1",
        )
        .bind(&run.organization_id)
        .bind(&run.run_id)
        .bind(&run.agent_id)
        .bind(&run.goal_id)
        .bind(&ledger.provider)
        .bind(&ledger.biller)
        .bind(&ledger.billing_type)
        .bind(&ledger.model)
        .bind(ledger.input_tokens)
        .bind(ledger.cached_input_tokens)
        .bind(ledger.output_tokens)
        .bind(ledger.cost_cents)
        .bind(&run.issue_id).bind(&run.project_id).bind(&run.billing_code)
        .fetch_optional(&mut **tx)
        .await?
    };
    if let Some(legacy_id) = legacy_id {
        let adopted: Option<bool> = sqlx::query_scalar(
            "UPDATE cost_events SET idempotency_key=$2
             WHERE org_id=$1::uuid AND id=$3::uuid AND idempotency_key IS NULL
             RETURNING true",
        )
        .bind(&run.organization_id)
        .bind(&idempotency_key)
        .bind(legacy_id)
        .fetch_optional(&mut **tx)
        .await?;
        if adopted.is_some() {
            let mut receipt = ledger.clone();
            receipt.inserted = false;
            return Ok(receipt);
        }
    }

    let inserted = sqlx::query_scalar::<_, String>(
        "INSERT INTO cost_events
           (org_id,agent_id,goal_id,heartbeat_run_id,idempotency_key,provider,biller,
            billing_type,model,input_tokens,cached_input_tokens,output_tokens,cost_cents,occurred_at,issue_id,project_id,billing_code)
         VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12,$13,statement_timestamp(),$14::uuid,$15::uuid,$16)
         ON CONFLICT (org_id,idempotency_key) DO NOTHING RETURNING id::text",
    )
    .bind(&run.organization_id)
    .bind(&run.agent_id)
    .bind(&run.goal_id)
    .bind(&run.run_id)
    .bind(&idempotency_key)
    .bind(&ledger.provider)
    .bind(&ledger.biller)
    .bind(&ledger.billing_type)
    .bind(&ledger.model)
    .bind(ledger.input_tokens)
    .bind(ledger.cached_input_tokens)
    .bind(ledger.output_tokens)
    .bind(ledger.cost_cents)
    .bind(&run.issue_id).bind(&run.project_id).bind(&run.billing_code)
    .fetch_optional(&mut **tx)
    .await?;
    let newly_inserted = inserted.is_some();
    if !newly_inserted {
        let existing = sqlx::query(
            "SELECT id::text AS id,agent_id::text AS agent_id,goal_id::text AS goal_id,
                    heartbeat_run_id::text AS run_id,issue_id::text AS issue_id,project_id::text AS project_id,billing_code,provider,biller,billing_type,model,
                    input_tokens,cached_input_tokens,output_tokens,cost_cents
             FROM cost_events WHERE org_id=$1::uuid AND idempotency_key=$2",
        )
        .bind(&run.organization_id)
        .bind(&idempotency_key)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(GoalCostError::IdempotencyConflict)?;
        let matches = existing.try_get::<String, _>("agent_id")? == run.agent_id
            && existing.try_get::<Option<String>, _>("goal_id")? == run.goal_id
            && existing.try_get::<Option<String>, _>("issue_id")? == run.issue_id
            && existing.try_get::<Option<String>, _>("project_id")? == run.project_id
            && existing.try_get::<Option<String>, _>("billing_code")? == run.billing_code
            && existing.try_get::<Option<String>, _>("run_id")?.as_deref() == Some(&run.run_id)
            && existing.try_get::<String, _>("provider")? == ledger.provider
            && existing.try_get::<String, _>("biller")? == ledger.biller
            && existing.try_get::<String, _>("billing_type")? == ledger.billing_type
            && existing.try_get::<String, _>("model")? == ledger.model
            && existing.try_get::<i32, _>("input_tokens")? == ledger.input_tokens
            && existing.try_get::<i32, _>("cached_input_tokens")? == ledger.cached_input_tokens
            && existing.try_get::<i32, _>("output_tokens")? == ledger.output_tokens
            && existing.try_get::<i32, _>("cost_cents")? == ledger.cost_cents;
        if !matches {
            return Err(GoalCostError::IdempotencyConflict);
        }
    }
    let mut receipt = ledger.clone();
    receipt.inserted = newly_inserted;
    Ok(receipt)
}

async fn update_monthly_rollups(
    tx: &mut Transaction<'_, Postgres>,
    run: &RunCostReceipt,
    ledger: &LedgerReceipt,
) -> Result<(), GoalCostError> {
    let window = sqlx::query(
        "SELECT to_char(date_trunc('month',statement_timestamp() AT TIME ZONE 'UTC'),
                        'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS month_start,
                to_char(date_trunc('month',statement_timestamp() AT TIME ZONE 'UTC') + interval '1 month',
                        'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS month_end",
    )
    .fetch_one(&mut **tx)
    .await?;
    let month_start: String = window.try_get("month_start")?;
    let month_end: String = window.try_get("month_end")?;
    for (scope_type, scope_id) in [
        ("agent", run.agent_id.as_str()),
        ("organization", run.organization_id.as_str()),
    ] {
        let inserted = sqlx::query_scalar::<_, String>(
            "INSERT INTO cost_monthly_spend_rollups
               (org_id,scope_type,scope_id,month_start,spend_cents)
             VALUES($1::uuid,$2,$3,$4::timestamptz,$5)
             ON CONFLICT (org_id,scope_type,scope_id,month_start) DO NOTHING
             RETURNING id::text",
        )
        .bind(&run.organization_id)
        .bind(scope_type)
        .bind(scope_id)
        .bind(&month_start)
        .bind(ledger.cost_cents)
        .fetch_optional(&mut **tx)
        .await?;
        if inserted.is_some() {
            sqlx::query(
                "UPDATE cost_monthly_spend_rollups r
                 SET spend_cents=(SELECT COALESCE(sum(c.cost_cents),0)::int FROM cost_events c
                   WHERE c.org_id=$1::uuid AND c.occurred_at >= $4::timestamptz
                     AND c.occurred_at < $5::timestamptz
                     AND ($2 <> 'agent' OR c.agent_id=$3::uuid)),updated_at=statement_timestamp()
                 WHERE r.org_id=$1::uuid AND r.scope_type=$2 AND r.scope_id=$3
                   AND r.month_start=$4::timestamptz",
            )
            .bind(&run.organization_id)
            .bind(scope_type)
            .bind(scope_id)
            .bind(&month_start)
            .bind(&month_end)
            .execute(&mut **tx)
            .await?;
        } else {
            sqlx::query(
                "UPDATE cost_monthly_spend_rollups SET spend_cents=spend_cents+$5,
                   updated_at=statement_timestamp()
                 WHERE org_id=$1::uuid AND scope_type=$2 AND scope_id=$3
                   AND month_start=$4::timestamptz",
            )
            .bind(&run.organization_id)
            .bind(scope_type)
            .bind(scope_id)
            .bind(&month_start)
            .bind(ledger.cost_cents)
            .execute(&mut **tx)
            .await?;
        }
    }
    Ok(())
}

async fn update_spent_monthly(
    tx: &mut Transaction<'_, Postgres>,
    run: &RunCostReceipt,
) -> Result<(), GoalCostError> {
    let totals = sqlx::query(
        "SELECT scope_type,scope_id,spend_cents FROM cost_monthly_spend_rollups
         WHERE org_id=$1::uuid AND month_start=date_trunc('month',statement_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
           AND ((scope_type='organization' AND scope_id=$1::text)
             OR (scope_type='agent' AND scope_id=$2::text))",
    )
    .bind(&run.organization_id)
    .bind(&run.agent_id)
    .fetch_all(&mut **tx)
    .await?;
    let mut agent_total = None;
    let mut org_total = None;
    for row in totals {
        let scope_type: String = row.try_get("scope_type")?;
        let scope_id: String = row.try_get("scope_id")?;
        let total: i32 = row.try_get("spend_cents")?;
        if scope_type == "agent" && scope_id == run.agent_id {
            agent_total = Some(total);
        } else if scope_type == "organization" && scope_id == run.organization_id {
            org_total = Some(total);
        }
    }
    let (Some(agent_total), Some(org_total)) = (agent_total, org_total) else {
        return Err(GoalCostError::InvalidReceipt);
    };
    sqlx::query("UPDATE agents SET spent_monthly_cents=$3,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(&run.organization_id)
        .bind(&run.agent_id)
        .bind(agent_total)
        .execute(&mut **tx)
        .await?;
    sqlx::query("UPDATE organizations SET spent_monthly_cents=$2,updated_at=statement_timestamp() WHERE id=$1::uuid")
        .bind(&run.organization_id)
        .bind(org_total)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn update_agent_runtime_state(
    tx: &mut Transaction<'_, Postgres>,
    run: &RunCostReceipt,
    ledger: &LedgerReceipt,
    inserted_event: bool,
) -> Result<(), GoalCostError> {
    let prompt_tokens = if ledger.provider.trim().eq_ignore_ascii_case("anthropic")
        || ledger.provider.trim().eq_ignore_ascii_case("claude")
    {
        i64::from(ledger.input_tokens).saturating_add(i64::from(ledger.cached_input_tokens))
    } else {
        i64::from(ledger.input_tokens)
    };
    let add_cost = if inserted_event {
        i64::from(ledger.cost_cents)
    } else {
        0
    };
    let add_input = if inserted_event { prompt_tokens } else { 0 };
    let add_cached = if inserted_event {
        i64::from(ledger.cached_input_tokens)
    } else {
        0
    };
    let add_output = if inserted_event {
        i64::from(ledger.output_tokens)
    } else {
        0
    };
    let session_id = run.session_id.as_deref();
    let latest_terminal_error = run.error.as_deref();
    sqlx::query(
        "INSERT INTO agent_runtime_state AS current
           (agent_id,org_id,agent_runtime_type,session_id,last_run_id,last_run_status,
            total_input_tokens,total_output_tokens,total_cached_input_tokens,total_cost_cents,
            last_error,created_at,updated_at)
         SELECT a.id,a.org_id,a.agent_runtime_type,$3,$4::uuid,$5,$6,$7,$8,$9,$10,
                statement_timestamp(),statement_timestamp()
         FROM agents a WHERE a.org_id=$1::uuid AND a.id=$2::uuid
         ON CONFLICT (agent_id) DO UPDATE SET
           agent_runtime_type=EXCLUDED.agent_runtime_type,
           session_id=CASE WHEN current.last_run_id IS NULL OR current.last_run_id=EXCLUDED.last_run_id
                 OR NOT EXISTS (SELECT 1 FROM heartbeat_runs previous_run
                   WHERE previous_run.id=current.last_run_id AND
                    (previous_run.created_at > (SELECT incoming.created_at FROM heartbeat_runs incoming WHERE incoming.id=EXCLUDED.last_run_id)
                     OR (previous_run.created_at=(SELECT incoming.created_at FROM heartbeat_runs incoming WHERE incoming.id=EXCLUDED.last_run_id)
                       AND previous_run.id > EXCLUDED.last_run_id)))
               THEN EXCLUDED.session_id ELSE current.session_id END,
           last_run_status=CASE WHEN current.last_run_id IS NULL OR current.last_run_id=EXCLUDED.last_run_id
                 OR NOT EXISTS (SELECT 1 FROM heartbeat_runs previous_run
                   WHERE previous_run.id=current.last_run_id AND
                    (previous_run.created_at > (SELECT incoming.created_at FROM heartbeat_runs incoming WHERE incoming.id=EXCLUDED.last_run_id)
                     OR (previous_run.created_at=(SELECT incoming.created_at FROM heartbeat_runs incoming WHERE incoming.id=EXCLUDED.last_run_id)
                       AND previous_run.id > EXCLUDED.last_run_id)))
               THEN EXCLUDED.last_run_status ELSE current.last_run_status END,
           last_error=CASE WHEN current.last_run_id IS NULL OR current.last_run_id=EXCLUDED.last_run_id
                 OR NOT EXISTS (SELECT 1 FROM heartbeat_runs previous_run
                   WHERE previous_run.id=current.last_run_id AND
                    (previous_run.created_at > (SELECT incoming.created_at FROM heartbeat_runs incoming WHERE incoming.id=EXCLUDED.last_run_id)
                     OR (previous_run.created_at=(SELECT incoming.created_at FROM heartbeat_runs incoming WHERE incoming.id=EXCLUDED.last_run_id)
                       AND previous_run.id > EXCLUDED.last_run_id)))
               THEN EXCLUDED.last_error ELSE current.last_error END,
           last_run_id=CASE WHEN current.last_run_id IS NULL OR current.last_run_id=EXCLUDED.last_run_id
                 OR NOT EXISTS (SELECT 1 FROM heartbeat_runs previous_run
                   WHERE previous_run.id=current.last_run_id AND
                    (previous_run.created_at > (SELECT incoming.created_at FROM heartbeat_runs incoming WHERE incoming.id=EXCLUDED.last_run_id)
                     OR (previous_run.created_at=(SELECT incoming.created_at FROM heartbeat_runs incoming WHERE incoming.id=EXCLUDED.last_run_id)
                       AND previous_run.id > EXCLUDED.last_run_id)))
               THEN EXCLUDED.last_run_id ELSE current.last_run_id END,
           total_input_tokens=current.total_input_tokens+EXCLUDED.total_input_tokens,
           total_output_tokens=current.total_output_tokens+EXCLUDED.total_output_tokens,
           total_cached_input_tokens=current.total_cached_input_tokens+EXCLUDED.total_cached_input_tokens,
           total_cost_cents=current.total_cost_cents+EXCLUDED.total_cost_cents,
           updated_at=statement_timestamp()",
    )
    .bind(&run.organization_id)
    .bind(&run.agent_id)
    .bind(session_id)
    .bind(&run.run_id)
    .bind(&run.status)
    .bind(add_input)
    .bind(add_output)
    .bind(add_cached)
    .bind(add_cost)
    .bind(latest_terminal_error)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
