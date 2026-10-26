//! Transactional side effects for terminal automation execution Issues.
//!
//! Node currently finalizes the automation run after the Issue transaction
//! commits. Keeping this work in the caller's transaction makes the Issue,
//! automation run, chat event, activity, and local analytics record move
//! together.

use crate::{
    StoreError,
    activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_options},
};
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

/// Finalize an automation run when its execution Issue moves to a terminal
/// status. Other Issues and nonterminal transitions have no effect.
pub async fn sync_issue_status(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    issue: &Value,
) -> Result<(), StoreError> {
    let Some(status) = string_field(issue, "status", "status") else {
        return Ok(());
    };
    if !matches!(status, "done" | "blocked" | "cancelled")
        || string_field(issue, "originKind", "origin_kind") != Some("automation_execution")
    {
        return Ok(());
    }
    let Some(run_id) = string_field(issue, "originRunId", "origin_run_id") else {
        return Ok(());
    };

    let completed = status == "done";
    let failure_reason = (!completed).then(|| format!("Execution issue moved to {status}"));
    let run = sqlx::query(
        "UPDATE automation_runs
         SET status=$3,
             failure_reason=CASE WHEN $3='failed' THEN $4 ELSE failure_reason END,
             completed_at=now(),updated_at=now()
         WHERE id=$1::uuid AND org_id=$2::uuid
         RETURNING source,trigger_id::text AS trigger_id,
                   trigger_payload,linked_chat_conversation_id::text AS linked_chat_conversation_id",
    )
    .bind(run_id)
    .bind(org_id)
    .bind(if completed { "completed" } else { "failed" })
    .bind(failure_reason.as_deref())
    .fetch_optional(&mut **tx)
    .await?;
    let Some(run) = run else {
        return Ok(());
    };

    // The legacy finalizer updates completed runs without adding a chat event.
    if completed {
        return Ok(());
    }

    let Some(automation_id) = string_field(issue, "originId", "origin_id") else {
        return Ok(());
    };
    let automation = sqlx::query(
        "SELECT id::text AS id,title,description,project_id::text AS project_id,
                assignee_agent_id::text AS assignee_agent_id,
                assignee_agent_runtime_overrides,output_mode
         FROM automations WHERE id=$1::uuid AND org_id=$2::uuid",
    )
    .bind(automation_id)
    .bind(org_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(automation) = automation else {
        return Ok(());
    };
    if automation.try_get::<String, _>("output_mode")? != "chat_output" {
        return Ok(());
    }

    let automation_id: String = automation.try_get("id")?;
    let automation_title: String = automation.try_get("title")?;
    let description: Option<String> = automation.try_get("description")?;
    let project_id: Option<String> = automation.try_get("project_id")?;
    let assignee_agent_id: String = automation.try_get("assignee_agent_id")?;
    let runtime_overrides: Option<Value> =
        automation.try_get("assignee_agent_runtime_overrides")?;
    let source: String = run.try_get("source")?;
    let trigger_id: Option<String> = run.try_get("trigger_id")?;
    let trigger_payload: Option<Value> = run.try_get("trigger_payload")?;
    let Some(issue_id) = string_field(issue, "id", "id") else {
        return Ok(());
    };
    let failure_reason = failure_reason.as_deref().unwrap_or_default();

    let conversation_id: Option<String> = run.try_get("linked_chat_conversation_id")?;
    let conversation_id = match conversation_id {
        Some(id) => {
            sqlx::query_scalar::<_, String>(
                "SELECT id::text FROM chat_conversations WHERE id=$1::uuid AND org_id=$2::uuid",
            )
            .bind(id)
            .bind(org_id)
            .fetch_optional(&mut **tx)
            .await?
        }
        None => Some(
            create_automation_run_chat(
                tx,
                org_id,
                &automation_id,
                run_id,
                &automation_title,
                description.as_deref(),
                project_id.as_deref(),
                &assignee_agent_id,
                runtime_overrides.as_ref(),
                &source,
                trigger_id.as_deref(),
                trigger_payload.as_ref(),
            )
            .await?,
        ),
    };
    let Some(conversation_id) = conversation_id else {
        return Ok(());
    };

    let occurred_at = sqlx::query_scalar::<_, String>(
        r#"SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')"#,
    )
    .fetch_one(&mut **tx)
    .await?;
    let event_body = format!("{automation_title} failed: {failure_reason}");
    let event_payload = json!({
        "eventType": "automation_run_failed",
        "automationId": automation_id,
        "automationTitle": automation_title,
        "runId": run_id,
        "issueId": issue_id,
        "triggerId": trigger_id,
        "source": source,
        "status": "failed",
        "failureReason": failure_reason,
        "occurredAt": occurred_at,
        "links": {
            "automation": format!("/automations/{automation_id}"),
            "issue": format!("/issues/{issue_id}"),
        },
    });
    let message = sqlx::query(
        r#"INSERT INTO chat_messages
           (org_id,conversation_id,role,kind,status,body,structured_payload,created_at,updated_at)
         VALUES ($1::uuid,$2::uuid,'system','system_event','completed',$3,$4::jsonb,
                 $5::timestamptz,$5::timestamptz)
         RETURNING id::text AS id,
                   to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at"#,
    )
    .bind(org_id)
    .bind(&conversation_id)
    .bind(&event_body)
    .bind(event_payload.to_string())
    .bind(&occurred_at)
    .fetch_one(&mut **tx)
    .await?;
    let message_id: String = message.try_get("id")?;
    let created_at: String = message.try_get("created_at")?;
    sqlx::query(
        "UPDATE chat_conversations SET last_message_at=$3::timestamptz,updated_at=$3::timestamptz
         WHERE id=$1::uuid AND org_id=$2::uuid",
    )
    .bind(&conversation_id)
    .bind(org_id)
    .bind(created_at)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "UPDATE automation_runs
         SET linked_chat_conversation_id=$3::uuid,terminal_chat_message_id=$4::uuid,
             last_chat_message_id=$4::uuid,updated_at=clock_timestamp()
         WHERE id=$1::uuid AND org_id=$2::uuid",
    )
    .bind(run_id)
    .bind(org_id)
    .bind(&conversation_id)
    .bind(&message_id)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn create_automation_run_chat(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    automation_id: &str,
    run_id: &str,
    automation_title: &str,
    description: Option<&str>,
    project_id: Option<&str>,
    assignee_agent_id: &str,
    runtime_overrides: Option<&Value>,
    source: &str,
    trigger_id: Option<&str>,
    trigger_payload: Option<&Value>,
) -> Result<String, StoreError> {
    let runtime_type = sqlx::query_scalar::<_, String>(
        "SELECT agent_runtime_type FROM agents WHERE id=$1::uuid AND org_id=$2::uuid",
    )
    .bind(assignee_agent_id)
    .bind(org_id)
    .fetch_optional(&mut **tx)
    .await?;
    let runtime_config = runtime_overrides
        .and_then(|value| value.get("agentRuntimeConfig"))
        .and_then(Value::as_object);
    let model = runtime_config
        .and_then(|config| config.get("model"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let effort = runtime_type
        .as_deref()
        .and_then(|runtime_type| effort_from_config(runtime_type, runtime_config));
    let conversation_id = Uuid::new_v4().to_string();
    let now = sqlx::query_scalar::<_, String>(
        r#"SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')"#,
    )
    .fetch_one(&mut **tx)
    .await?;
    let description = description.unwrap_or_default().trim();
    let title = automation_title.trim();
    let base = if description.is_empty() {
        title
    } else {
        description
    };
    let prompt = automation_chat_prompt(base, automation_title, source, trigger_payload);
    let conversation_title = if title.is_empty() { "New chat" } else { title };
    sqlx::query(
        "INSERT INTO chat_conversations
           (id,org_id,title,summary,preferred_agent_id,model_override,effort_override,
            issue_creation_mode,plan_mode,created_by_user_id,created_at,last_message_at,updated_at)
         VALUES ($1::uuid,$2::uuid,$3,NULL,$4::uuid,$5,$6,'manual_approval',false,NULL,
                 $7::timestamptz,$7::timestamptz,$7::timestamptz)",
    )
    .bind(&conversation_id)
    .bind(org_id)
    .bind(conversation_title)
    .bind(assignee_agent_id)
    .bind(model)
    .bind(effort.as_deref())
    .bind(&now)
    .execute(&mut **tx)
    .await?;

    if let Some(project_id) = project_id {
        sqlx::query(
            "INSERT INTO chat_context_links (org_id,conversation_id,entity_type,entity_id)
             VALUES ($1::uuid,$2::uuid,'project',$3) ON CONFLICT DO NOTHING",
        )
        .bind(org_id)
        .bind(&conversation_id)
        .bind(project_id)
        .execute(&mut **tx)
        .await?;
    }

    let payload = automation_run_input_payload(
        automation_id,
        automation_title,
        run_id,
        &conversation_id,
        source,
        trigger_id,
    );
    let message_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO chat_messages
           (id,org_id,conversation_id,role,kind,status,body,structured_payload,chat_turn_id,turn_variant,
            created_at,updated_at)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'user','message','completed',$4,$5::jsonb,$6::uuid,0,
                 $7::timestamptz,$7::timestamptz)",
    )
    .bind(&message_id)
    .bind(org_id)
    .bind(&conversation_id)
    .bind(&prompt)
    .bind(payload.to_string())
    .bind(Uuid::new_v4().to_string())
    .bind(&now)
    .execute(&mut **tx)
    .await?;

    write_product_analytics_chat_created(tx, org_id, &conversation_id, &now).await?;
    let activity_actor = ActivityActor {
        actor_type: "system",
        actor_id: "automation-chat-output".to_owned(),
        run_id: None,
    };
    let model_value = model.map(str::to_owned);
    let context_link_count = if project_id.is_some() { 1 } else { 0 };
    let created_details = json!({
        "title": conversation_title,
        "contextLinkCount": context_link_count,
        "modelOverride": model_value,
        "effortOverride": effort,
    });
    write_activity_options(
        tx,
        ActivityWrite {
            org: org_id,
            audit: &activity_actor,
            action: "chat.created",
            entity_type: "chat",
            entity_id: &conversation_id,
            details: Some(&created_details),
            options: ActivityOptions {
                agent_id: Some(assignee_agent_id),
                ..ActivityOptions::default()
            },
        },
    )
    .await?;
    let message_added_details = json!({
        "messageId": message_id,
        "role": "user",
        "kind": "message",
        "status": "completed",
        "preview": js_slice(&prompt, 280),
    });
    write_activity_options(
        tx,
        ActivityWrite {
            org: org_id,
            audit: &activity_actor,
            action: "chat.message_added",
            entity_type: "chat",
            entity_id: &conversation_id,
            details: Some(&message_added_details),
            options: ActivityOptions {
                agent_id: Some(assignee_agent_id),
                ..ActivityOptions::default()
            },
        },
    )
    .await?;
    sqlx::query(
        "UPDATE automation_runs
         SET linked_chat_conversation_id=$3::uuid,started_chat_message_id=$4::uuid,
             last_chat_message_id=$4::uuid,updated_at=now()
         WHERE id=$1::uuid AND org_id=$2::uuid",
    )
    .bind(run_id)
    .bind(org_id)
    .bind(&conversation_id)
    .bind(&message_id)
    .execute(&mut **tx)
    .await?;
    Ok(conversation_id)
}

fn effort_from_config(
    runtime_type: &str,
    config: Option<&serde_json::Map<String, Value>>,
) -> Option<String> {
    let keys: &[&str] = match runtime_type {
        "codex_local" => &["modelReasoningEffort", "reasoningEffort"],
        "cursor" => &["effort"],
        "opencode_local" => &["variant"],
        "pi_local" => &["thinking"],
        _ => &["effort"],
    };
    keys.iter().find_map(|key| {
        config
            .and_then(|value| value.get(*key))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    })
}

fn automation_chat_prompt(
    base: &str,
    automation_title: &str,
    source: &str,
    trigger_payload: Option<&Value>,
) -> String {
    let mut context = vec![
        format!("Automation: {automation_title}"),
        format!("Trigger source: {source}"),
    ];
    if let Some(payload) =
        trigger_payload.filter(|value| value.as_object().is_some_and(|object| !object.is_empty()))
    {
        context.push(format!(
            "Trigger payload: {}",
            serde_json::to_string(payload).unwrap_or_else(|_| "{}".to_owned())
        ));
    }
    format!("{base}\n\n{}", context.join("\n"))
        .trim()
        .to_owned()
}

fn automation_run_input_payload(
    automation_id: &str,
    automation_title: &str,
    run_id: &str,
    conversation_id: &str,
    source: &str,
    trigger_id: Option<&str>,
) -> Value {
    json!({
        "eventType": "automation_run_input",
        "automationChatRun": {
            "automationId": automation_id,
            "automationTitle": automation_title,
            "runId": run_id,
            "links": {
                "automation": format!("/automations/{automation_id}"),
                "chat": format!("/messenger/chat/{conversation_id}"),
            },
            "status": "running",
            "source": source,
            "triggerId": trigger_id,
        },
        "guidance": {
            "intent": "execute_existing_automation",
            "mayCreateAutomation": false,
        },
    })
}

fn string_field<'a>(value: &'a Value, camel: &str, snake: &str) -> Option<&'a str> {
    value
        .get(camel)
        .or_else(|| value.get(snake))
        .and_then(Value::as_str)
}

fn js_slice(value: &str, end: usize) -> String {
    let units: Vec<u16> = value.encode_utf16().take(end).collect();
    String::from_utf16_lossy(&units)
}

async fn write_product_analytics_chat_created(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    conversation_id: &str,
    occurred_at: &str,
) -> Result<(), StoreError> {
    let installation = sqlx::query(
        "SELECT installation_id,mode,state FROM product_analytics_installations
         ORDER BY created_at ASC LIMIT 1",
    )
    .fetch_optional(&mut **tx)
    .await?;
    let installation = installation
        .map(|row| {
            Ok::<_, sqlx::Error>((
                row.try_get::<String, _>("installation_id")?,
                row.try_get::<String, _>("mode")?,
                row.try_get::<Value, _>("state")?,
            ))
        })
        .transpose()?;
    let installation_id = installation.as_ref().map(|(id, _, _)| id.as_str());
    let environment = if std::env::var("NODE_ENV").is_ok_and(|value| value == "production") {
        "production"
    } else {
        "development"
    };
    let event_id = sqlx::query_scalar::<_, String>(
        "INSERT INTO product_analytics_events
           (org_id,installation_id,event_name,occurred_at,source_transition,confidence,
            actor_type,actor_id,local_user_id,environment,app_version,release_channel,
            deployment_mode,origin,work_surface,work_id,entity_type,entity_id,dedupe_key,properties)
         VALUES ($1::uuid,$2,'chat_created',$3::timestamptz,'chat.automation.create','exact',
            'automation','automation-chat-output',NULL,$4,'unknown','stable','self_hosted',
            'automation','chat',$5,'chat',$5,'chat_created:'||$5,
            jsonb_build_object('creation_path','automation','initial_role','user','plan_mode',false))
         ON CONFLICT (dedupe_key) DO NOTHING RETURNING id::text",
    )
    .bind(org_id)
    .bind(installation_id)
    .bind(occurred_at)
    .bind(environment)
    .bind(conversation_id)
    .fetch_optional(&mut **tx)
    .await?;
    let (Some(event_id), Some((installation_id, mode, state))) = (event_id, installation) else {
        return Ok(());
    };
    if environment != "production" || mode == "off" {
        return Ok(());
    }

    let backlog = sqlx::query(
        "SELECT count(*)::bigint AS count,
                COALESCE(sum(length(events.properties::text)),0)::bigint AS bytes
         FROM product_analytics_outbox outbox
         JOIN product_analytics_events events ON events.id=outbox.event_id
         WHERE outbox.installation_id=$1
           AND outbox.state IN ('pending','claimed','retry_wait')",
    )
    .bind(&installation_id)
    .fetch_one(&mut **tx)
    .await?;
    let backlog_count: i64 = backlog.try_get("count")?;
    let backlog_bytes: i64 = backlog.try_get("bytes")?;
    if backlog_count >= 10_000 || backlog_bytes >= 32 * 1024 * 1024 {
        let mut state = state;
        if !state.is_object() {
            state = json!({});
        }
        state["coverageGap"] = json!(true);
        sqlx::query(
            "UPDATE product_analytics_installations SET state=$2::jsonb,updated_at=now()
             WHERE installation_id=$1",
        )
        .bind(&installation_id)
        .bind(state)
        .execute(&mut **tx)
        .await?;
        return Ok(());
    }
    let scope = if mode == "account_linked" {
        "account_linked_user"
    } else {
        "anonymous_installation"
    };
    let consent = sqlx::query(
        "SELECT policy_version,consent_epoch FROM product_analytics_consent_ledger
         WHERE installation_id=$1 AND scope=$2 AND decision='granted' AND local_user_id IS NULL
         ORDER BY consent_epoch DESC LIMIT 1",
    )
    .bind(&installation_id)
    .bind(scope)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some(consent) = consent {
        sqlx::query(
            "INSERT INTO product_analytics_outbox
               (event_id,installation_id,delivery_mode,consent_scope,consented_local_user_id,
                consent_version,consent_epoch)
             VALUES ($1::uuid,$2,$3,$4,NULL,$5,$6) ON CONFLICT DO NOTHING",
        )
        .bind(event_id)
        .bind(installation_id)
        .bind(mode)
        .bind(scope)
        .bind(consent.try_get::<String, _>("policy_version")?)
        .bind(consent.try_get::<i32, _>("consent_epoch")?)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}
