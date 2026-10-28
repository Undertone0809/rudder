use super::*;
/// Existing cadence owner invokes this once per configured heartbeat interval.
/// Claim and durable run production commit together; rollback leaves it due.
pub async fn tick(pool: &PgPool, now_ms: i64, host: &Host<'_>) -> Result<u64> {
    let due=sqlx::query_as::<_,(String,String)>("SELECT t.id::text,t.automation_id::text FROM automation_triggers t JOIN automations a ON a.org_id=t.org_id AND a.id=t.automation_id WHERE t.kind='schedule' AND t.enabled AND a.status='active' AND t.next_run_at<=to_timestamp($1::double precision/1000) ORDER BY t.next_run_at,t.created_at")
        .bind(now_ms).fetch_all(pool).await?;
    let mut triggered = 0;
    for (trigger_id, automation_id) in due {
        let mut tx = pool.begin().await?;
        let Some(automation) =
            automation_management::projection::automation(&mut tx, &automation_id, true).await?
        else {
            continue;
        };
        let Some(trigger) =
            automation_management::projection::trigger(&mut tx, &trigger_id, true).await?
        else {
            continue;
        };
        if automation["status"] != "active"
            || trigger["enabled"] != true
            || trigger["kind"] != "schedule"
            || trigger["orgId"] != automation["orgId"]
        {
            continue;
        }
        let due_at=sqlx::query_scalar::<_,Option<i64>>("SELECT (extract(epoch FROM next_run_at)*1000)::bigint FROM automation_triggers WHERE id=$1::uuid AND next_run_at<=to_timestamp($2::double precision/1000)")
            .bind(&trigger_id).bind(now_ms).fetch_optional(&mut *tx).await?.flatten();
        let Some(due_at) = due_at else { continue };
        let (Some(cron), Some(zone)) =
            (text(&trigger, "cronExpression"), text(&trigger, "timezone"))
        else {
            continue;
        };
        let (count, next) = if automation["catchUpPolicy"] == "enqueue_missed_with_cap" {
            let mut cursor = Some(due_at);
            let mut count = 0;
            while cursor.is_some_and(|at| at <= now_ms) && count < 25 {
                count += 1;
                cursor = automation_management::schedule::next_tick(cron, zone, cursor.unwrap())?;
            }
            // Keep the first unconsumed occurrence, even when it is still due.
            // The next scheduler pass continues the backlog after this cap.
            (count, cursor)
        } else {
            (
                1,
                automation_management::schedule::next_tick(cron, zone, now_ms)?,
            )
        };
        let next = next
            .map(automation_management::schedule::stamp)
            .transpose()?;
        sqlx::query("UPDATE automation_triggers SET next_run_at=$2::timestamptz,updated_at=statement_timestamp() WHERE id=$1::uuid")
            .bind(&trigger_id).bind(next).execute(&mut *tx).await?;
        let org = text(&automation, "orgId").unwrap_or_default().to_owned();
        for _ in 0..count {
            let run = dispatch::dispatch(
                &mut tx,
                automation.clone(),
                Some(&trigger),
                "schedule",
                None,
                None,
                host,
            )
            .await?;
            dispatch::audit(&mut tx, &org, "system", "automation-scheduler", None, &run).await?;
            triggered += 1;
        }
        tx.commit().await?;
    }
    Ok(triggered)
}
