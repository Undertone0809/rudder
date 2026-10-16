use super::{Result, auth::Tx, http};

/// Read-only admission preflight for active hard-stop `billed_cents` policies.
/// Settlement and ongoing hard-stop enforcement remain future work.
pub(super) async fn ensure_not_blocked(
    tx: &mut Tx<'_>,
    organization_id: &str,
    agent_id: &str,
) -> Result<()> {
    let org_status: String =
        sqlx::query_scalar("SELECT status FROM organizations WHERE id=$1::uuid")
            .bind(organization_id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(|| http(404, "Organization not found"))?;
    if org_status == "paused" {
        return Err(http(
            409,
            "Organization is paused and cannot start new work",
        ));
    }

    let agent_status: String =
        sqlx::query_scalar("SELECT status FROM agents WHERE org_id=$1::uuid AND id=$2::uuid")
            .bind(organization_id)
            .bind(agent_id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(|| http(404, "Agent not found"))?;
    if matches!(
        agent_status.as_str(),
        "paused" | "terminated" | "pending_approval"
    ) {
        return Err(http(409, "Agent is not available for Chat"));
    }

    let policies = sqlx::query(
        "SELECT scope_type, scope_id::text AS scope_id, window_kind, amount
         FROM budget_policies
         WHERE org_id=$1::uuid AND is_active=true AND metric='billed_cents'
           AND hard_stop_enabled=true AND amount > 0
           AND ((scope_type='organization' AND scope_id=$1::uuid)
             OR (scope_type='agent' AND scope_id=$2::uuid))
         ORDER BY CASE scope_type WHEN 'organization' THEN 0 ELSE 1 END,
                  scope_id, window_kind",
    )
    .bind(organization_id)
    .bind(agent_id)
    .fetch_all(&mut **tx)
    .await?;

    // The admission transaction may have waited on the conversation row lock.
    // Capture the policy window clock after that fence instead of using
    // transaction_timestamp()/now(), which are fixed when the transaction began.
    let checked_at: String = sqlx::query_scalar("SELECT statement_timestamp()::text")
        .fetch_one(&mut **tx)
        .await?;

    for policy in policies {
        let scope_type: String = sqlx::Row::try_get(&policy, "scope_type")?;
        let window_kind: String = sqlx::Row::try_get(&policy, "window_kind")?;
        let amount: i32 = sqlx::Row::try_get(&policy, "amount")?;
        let agent_filter = if scope_type == "agent" {
            " AND agent_id=$2::uuid"
        } else {
            ""
        };
        let month_clock_parameter = if scope_type == "agent" { "$3" } else { "$2" };
        let window_filter = match window_kind.as_str() {
            // The existing TS hard-stop sum applies no timestamp predicate to
            // lifetime policies, despite resolveWindow returning display bounds.
            "lifetime" => String::new(),
            "calendar_month_utc" => {
                // Bind one post-lock timestamp for every policy checked during
                // this admission, preserving the UTC half-open calendar month.
                format!(
                    " AND occurred_at >= date_trunc('month', {month_clock_parameter}::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND occurred_at < (date_trunc('month', {month_clock_parameter}::timestamptz AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC'"
                )
            }
            // `budget_policies.window_kind` has no DB CHECK. Do not silently
            // skip malformed active hard stops; require config repair first.
            _ => {
                return Err(http(
                    409,
                    "Active budget hard-stop policy has an unsupported window kind",
                ));
            }
        };
        let query = format!(
            "SELECT COALESCE(sum(cost_cents), 0)::bigint FROM cost_events WHERE org_id=$1::uuid{agent_filter}{window_filter}"
        );
        let mut query = sqlx::query_scalar::<_, i64>(&query).bind(organization_id);
        if scope_type == "agent" {
            query = query.bind(agent_id);
        }
        if window_kind == "calendar_month_utc" {
            query = query.bind(&checked_at);
        }
        let observed = query.fetch_one(&mut **tx).await?;
        if observed >= i64::from(amount) {
            return Err(http(
                409,
                if scope_type == "organization" {
                    "Organization budget hard-stop has been reached"
                } else {
                    "Agent budget hard-stop has been reached"
                },
            ));
        }
    }
    Ok(())
}
