//! Existing generic heartbeat invocation block contract. The Node API accepts
//! Issue/project context but checks only organization and Agent billed cents.

use sqlx::{Postgres, Row, Transaction};

#[derive(Clone, Debug)]
pub(crate) struct InvocationBlock {
    pub scope_type: &'static str,
    pub scope_id: String,
    pub reason: &'static str,
}

pub(crate) async fn invocation_block(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    agent_id: &str,
    agent_status: &str,
    agent_pause_reason: Option<&str>,
) -> Result<Option<InvocationBlock>, sqlx::Error> {
    if !crate::goal_runs::goal_invocation_budget_blocked(
        tx,
        org,
        agent_id,
        agent_status,
        agent_pause_reason,
    )
    .await?
    {
        return Ok(None);
    }
    let organization =
        sqlx::query("SELECT status,pause_reason FROM organizations WHERE id=$1::uuid")
            .bind(org)
            .fetch_one(&mut **tx)
            .await?;
    let status: String = organization.try_get("status")?;
    let pause_reason: Option<String> = organization.try_get("pause_reason")?;
    if status == "paused" {
        return Ok(Some(InvocationBlock {
            scope_type: "organization",
            scope_id: org.into(),
            reason: if pause_reason.as_deref() == Some("budget") {
                "Organization is paused because its budget hard-stop was reached."
            } else {
                "Organization is paused and cannot start new work."
            },
        }));
    }
    let exceeded=sqlx::query_scalar::<_,String>(
        "SELECT p.scope_type FROM budget_policies p
         WHERE p.org_id=$1::uuid AND p.is_active=true AND p.metric='billed_cents'
           AND p.hard_stop_enabled=true AND p.amount>0
           AND ((p.scope_type='organization' AND p.scope_id=$1::uuid) OR (p.scope_type='agent' AND p.scope_id=$2::uuid))
           AND COALESCE((SELECT sum(c.cost_cents)::bigint FROM cost_events c
             WHERE c.org_id=p.org_id AND (p.scope_type<>'agent' OR c.agent_id=$2::uuid)
               AND (p.window_kind<>'calendar_month_utc' OR
                 (c.occurred_at >= date_trunc('month',statement_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                  AND c.occurred_at < (date_trunc('month',statement_timestamp() AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC'))),0)>=p.amount
         ORDER BY CASE p.scope_type WHEN 'organization' THEN 0 ELSE 1 END LIMIT 1",
    ).bind(org).bind(agent_id).fetch_optional(&mut **tx).await?;
    if exceeded.as_deref() == Some("organization") {
        return Ok(Some(InvocationBlock {
            scope_type: "organization",
            scope_id: org.into(),
            reason: "Organization cannot start new work because its budget hard-stop is exceeded.",
        }));
    }
    if agent_status == "paused" && agent_pause_reason == Some("budget") {
        return Ok(Some(InvocationBlock {
            scope_type: "agent",
            scope_id: agent_id.into(),
            reason: "Agent is paused because its budget hard-stop was reached.",
        }));
    }
    Ok(exceeded.map(|_| InvocationBlock {
        scope_type: "agent",
        scope_id: agent_id.into(),
        reason: "Agent cannot start because its budget hard-stop is still exceeded.",
    }))
}
