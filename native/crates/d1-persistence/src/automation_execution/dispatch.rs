use super::*;
use crate::activity::{self, ActivityActor, ActivityOptions, ActivityWrite};

pub(super) async fn dispatch(
    tx: &mut Tx<'_>,
    automation: Value,
    trigger: Option<&Value>,
    source: &str,
    payload: Option<&Value>,
    idempotency: Option<&str>,
    host: &Host<'_>,
) -> Result<Value> {
    let org = text(&automation, "orgId").unwrap_or_default().to_owned();
    let automation_id = text(&automation, "id").unwrap_or_default().to_owned();
    let trigger_id = trigger.and_then(|t| text(t, "id"));
    if let Some(key) = idempotency.filter(|key| !key.is_empty()) {
        let existing=sqlx::query_scalar::<_,String>("SELECT id::text FROM automation_runs WHERE org_id=$1::uuid AND automation_id=$2::uuid AND source=$3 AND trigger_id IS NOT DISTINCT FROM $4::uuid AND idempotency_key=$5 ORDER BY created_at DESC LIMIT 1")
            .bind(&org).bind(&automation_id).bind(source).bind(trigger_id).bind(key).fetch_optional(&mut **tx).await?;
        if let Some(existing) = existing {
            return project_run(tx, &org, &existing).await;
        }
    }
    let now = (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64;
    let run_id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO automation_runs(id,org_id,automation_id,trigger_id,source,status,triggered_at,idempotency_key,trigger_payload) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,'received',to_timestamp($6::double precision/1000),$7,$8::jsonb)")
        .bind(&run_id).bind(&org).bind(&automation_id).bind(trigger_id).bind(source).bind(now).bind(idempotency).bind(payload.filter(|v|!v.is_null())).execute(&mut **tx).await?;
    let producer = LockedAutomationDispatch {
        automation,
        run_id: run_id.clone(),
        source: source.into(),
        payload: payload.cloned().unwrap_or(Value::Null),
        trigger_id: trigger_id.map(str::to_owned),
    };
    let mode = text(&producer.automation, "outputMode").unwrap_or("chat_output");
    let concurrency =
        text(&producer.automation, "concurrencyPolicy").unwrap_or("coalesce_if_active");
    if mode == "chat_output" {
        // Match the existing stale legacy-chat timeout, while keeping native
        // generations with a durable execution owner/hold visible as live.
        sqlx::query("UPDATE automation_runs r SET status='failed',failure_reason='Automation chat run was interrupted before completion',completed_at=statement_timestamp(),updated_at=statement_timestamp() WHERE r.org_id=$1::uuid AND r.automation_id=$2::uuid AND r.id<>$3::uuid AND r.status IN ('received','running') AND r.updated_at<=statement_timestamp()-interval '30 minutes' AND NOT EXISTS(SELECT 1 FROM chat_generations g JOIN heartbeat_runs h ON h.org_id=g.org_id AND h.chat_generation_id=g.id WHERE g.org_id=r.org_id AND g.source_message_id=r.started_chat_message_id AND (h.status IN ('queued','running') OR g.native_admission_hold))")
            .bind(&org).bind(&automation_id).bind(&run_id).execute(&mut **tx).await?;
    }
    let active = if mode == "chat_output" {
        sqlx::query_as::<_,(String,Option<String>)>("SELECT id::text,linked_chat_conversation_id::text FROM automation_runs WHERE org_id=$1::uuid AND automation_id=$2::uuid AND id<>$3::uuid AND status IN ('received','running') ORDER BY updated_at DESC,created_at DESC LIMIT 1")
            .bind(&org).bind(&automation_id).bind(&run_id).fetch_optional(&mut **tx).await?
    } else {
        sqlx::query_as::<_,(String,Option<String>)>("SELECT COALESCE(i.origin_run_id,''),i.id::text FROM issues i WHERE i.org_id=$1::uuid AND i.origin_kind='automation_execution' AND i.origin_id=$2 AND i.status IN ('backlog','todo','in_progress','in_review','blocked') AND i.hidden_at IS NULL AND EXISTS(SELECT 1 FROM heartbeat_runs h WHERE h.org_id=i.org_id AND h.status IN ('queued','running') AND (h.id=i.execution_run_id OR h.context_snapshot->>'issueId'=i.id::text)) ORDER BY i.updated_at DESC,i.created_at DESC LIMIT 1")
            .bind(&org).bind(&automation_id).fetch_optional(&mut **tx).await?
    };
    let mut issue_id = None;
    let status = if let Some((active_run, linked)) =
        active.filter(|_| concurrency != "always_enqueue")
    {
        let status = if concurrency == "skip_if_active" {
            "skipped"
        } else {
            "coalesced"
        };
        let (issue, chat) = if mode == "chat_output" {
            (None, linked)
        } else {
            (linked, None)
        };
        sqlx::query("UPDATE automation_runs SET status=$3,linked_issue_id=$4::uuid,linked_chat_conversation_id=$5::uuid,coalesced_into_run_id=$6::uuid,completed_at=statement_timestamp(),updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
            .bind(&org).bind(&run_id).bind(status).bind(&issue).bind(chat).bind((!active_run.is_empty()).then_some(active_run)).execute(&mut **tx).await?;
        issue_id = issue;
        status
    } else {
        sqlx::query("SAVEPOINT automation_execution_dispatch")
            .execute(&mut **tx)
            .await?;
        let admitted = if mode == "chat_output" {
            match host.chat {
                Some(host) => crate::native_chat::admit_automation(tx, &producer, host)
                    .await
                    .map(|_| "running")
                    .map_err(|error| error.to_string()),
                None => Err("Native Chat runtime is unavailable".into()),
            }
        } else {
            match crate::issue_core_writes::create_automation_execution_issue(tx, &producer).await {
                Ok(issue) => {
                    issue_id = text(&issue, "id").map(str::to_owned);
                    Ok("issue_created")
                }
                Err(error) => Err(error.to_string()),
            }
        };
        match admitted {
            Ok(status) => {
                sqlx::query("RELEASE SAVEPOINT automation_execution_dispatch")
                    .execute(&mut **tx)
                    .await?;
                sqlx::query("UPDATE automation_runs SET status=$3,linked_issue_id=$4::uuid,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
                    .bind(&org).bind(&run_id).bind(status).bind(&issue_id).execute(&mut **tx).await?;
                status
            }
            Err(reason) => {
                sqlx::query("ROLLBACK TO SAVEPOINT automation_execution_dispatch")
                    .execute(&mut **tx)
                    .await?;
                sqlx::query("RELEASE SAVEPOINT automation_execution_dispatch")
                    .execute(&mut **tx)
                    .await?;
                sqlx::query("UPDATE automation_runs SET status='failed',failure_reason=$3,completed_at=statement_timestamp(),updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
                    .bind(&org).bind(&run_id).bind(reason).execute(&mut **tx).await?;
                "failed"
            }
        }
    };
    sqlx::query("UPDATE automations SET last_triggered_at=to_timestamp($3::double precision/1000),last_enqueued_at=CASE WHEN $4::uuid IS NULL THEN last_enqueued_at ELSE to_timestamp($3::double precision/1000) END,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(&org).bind(&automation_id).bind(now).bind(&issue_id).execute(&mut **tx).await?;
    if let Some(trigger) = trigger {
        let schedule = trigger["kind"] == "schedule";
        let next = if schedule {
            automation_management::schedule::next_tick(
                text(trigger, "cronExpression").unwrap_or_default(),
                text(trigger, "timezone").unwrap_or("UTC"),
                now,
            )?
            .map(automation_management::schedule::stamp)
            .transpose()?
        } else {
            None
        };
        let result = if status == "issue_created" {
            format!(
                "Created execution issue {}",
                issue_id.as_deref().unwrap_or_default()
            )
        } else {
            match status {
                "running" => "Started chat run",
                "coalesced" => "Coalesced into an existing live run",
                "skipped" => "Skipped because a live run already exists",
                "failed" => "Execution failed",
                other => other,
            }
            .into()
        };
        sqlx::query("UPDATE automation_triggers SET last_fired_at=to_timestamp($3::double precision/1000),last_result=$4,next_run_at=CASE WHEN $5 THEN $6::timestamptz ELSE next_run_at END,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
            .bind(&org).bind(trigger_id).bind(now).bind(result).bind(schedule).bind(next).execute(&mut **tx).await?;
    }
    if status == "issue_created" && producer.automation["notifyOnIssueCreated"] == true {
        if let (Some(user), Some(issue)) = (
            text(&producer.automation, "notifyOnIssueCreatedUserId"),
            issue_id.as_deref(),
        ) {
            write_event(tx,&org,"system","automation-issue-notifier",None,"automation.issue_created_notification","issue",issue,json!({"issueId":issue,"automationId":automation_id,"automationTitle":producer.automation["title"],"userId":user,"source":"automation.issue_created_notification"})).await?;
        }
    }
    project_run(tx, &org, &run_id).await
}

pub(super) async fn project_run(tx: &mut Tx<'_>, org: &str, run: &str) -> Result<Value> {
    let raw=sqlx::query_scalar::<_,Value>("SELECT to_jsonb(r)||jsonb_build_object('triggered_at',to_char(r.triggered_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),'completed_at',to_char(r.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),'created_at',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),'updated_at',to_char(r.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')) FROM automation_runs r WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(org).bind(run).fetch_one(&mut **tx).await?;
    Ok(Value::Object(
        raw.as_object()
            .unwrap()
            .iter()
            .map(|(key, value)| (automation_management::projection::camel(key), value.clone()))
            .collect(),
    ))
}

pub(super) async fn audit(
    tx: &mut Tx<'_>,
    org: &str,
    kind: &str,
    actor: &str,
    actor_run: Option<&str>,
    run: &Value,
) -> Result<()> {
    let mut details =
        json!({"automationId":run["automationId"],"source":run["source"],"status":run["status"]});
    if kind == "system" {
        details["triggerId"] = run["triggerId"].clone();
        details["outputMode"] = sqlx::query_scalar::<_, String>(
            "SELECT output_mode FROM automations WHERE org_id=$1::uuid AND id=$2::uuid",
        )
        .bind(org)
        .bind(run["automationId"].as_str())
        .fetch_one(&mut **tx)
        .await?
        .into();
    }
    write_event(
        tx,
        org,
        kind,
        actor,
        actor_run,
        "automation.run_triggered",
        "automation_run",
        text(run, "id").unwrap_or_default(),
        details,
    )
    .await
}

async fn write_event(
    tx: &mut Tx<'_>,
    org: &str,
    kind: &str,
    actor: &str,
    actor_run: Option<&str>,
    action: &str,
    entity: &str,
    id: &str,
    details: Value,
) -> Result<()> {
    activity::write_activity_options(
        tx,
        ActivityWrite {
            org,
            audit: &ActivityActor {
                actor_type: match kind {
                    "agent" => "agent",
                    "user" => "user",
                    _ => "system",
                },
                actor_id: actor.into(),
                run_id: actor_run.map(str::to_owned),
            },
            action,
            entity_type: entity,
            entity_id: id,
            details: Some(&details),
            options: ActivityOptions {
                agent_id: (kind == "agent").then_some(actor),
                ..ActivityOptions::default()
            },
        },
    )
    .await?;
    Ok(())
}
