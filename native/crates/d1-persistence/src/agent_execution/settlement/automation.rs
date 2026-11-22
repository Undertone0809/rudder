//! Existing automation Agent Run output -> Messenger result projection.
use super::TerminalRun;
use crate::{
    activity::{self, ActivityActor, ActivityOptions, ActivityWrite},
    agent_execution::{AgentExecutionError, context, http},
};
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

pub(super) async fn settle(
    tx: &mut Transaction<'_, Postgres>,
    run: &TerminalRun,
) -> Result<(), AgentExecutionError> {
    let Some(issue_id) = context::nonempty(run.context.get("issueId")) else {
        return Ok(());
    };
    let row=sqlx::query("SELECT i.id::text AS issue_id,a.id::text AS automation_id,a.title,a.project_id::text AS project_id,a.assignee_agent_id::text AS assignee_agent_id,r.id::text AS automation_run_id,r.linked_chat_conversation_id::text AS conversation_id FROM issues i JOIN automation_runs r ON r.org_id=i.org_id AND i.origin_run_id=r.id::text JOIN automations a ON a.org_id=r.org_id AND a.id=r.automation_id WHERE i.org_id=$1::uuid AND i.id=$2::uuid AND i.origin_kind='automation_execution' AND a.output_mode='chat_output'")
        .bind(&run.org).bind(&issue_id).fetch_optional(&mut **tx).await?;
    let Some(row) = row else {
        return Ok(());
    };
    let automation_id: String = row.try_get("automation_id")?;
    let automation_run_id: String = row.try_get("automation_run_id")?;
    let title: String = row.try_get("title")?;
    let assignee: String = row.try_get("assignee_agent_id")?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("automation-chat-output:{automation_run_id}"))
        .execute(&mut **tx)
        .await?;
    let conversation_id:Option<String>=sqlx::query_scalar("SELECT linked_chat_conversation_id::text FROM automation_runs WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE")
        .bind(&run.org).bind(&automation_run_id).fetch_one(&mut **tx).await?;
    let created = conversation_id.is_none();
    let conversation_id = conversation_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let timestamp: String = sqlx::query_scalar("SELECT statement_timestamp()::text")
        .fetch_one(&mut **tx)
        .await?;
    if created {
        sqlx::query("INSERT INTO chat_conversations(id,org_id,title,summary,preferred_agent_id,issue_creation_mode,plan_mode,created_by_user_id,created_at,last_message_at,updated_at) VALUES($1::uuid,$2::uuid,$3,NULL,$4::uuid,'manual_approval',false,NULL,$5::timestamptz,$5::timestamptz,$5::timestamptz)")
            .bind(&conversation_id).bind(&run.org).bind(if title.is_empty(){"New chat"}else{&title}).bind(&assignee).bind(&timestamp).execute(&mut **tx).await?;
        if let Some(project) = row.try_get::<Option<String>, _>("project_id")? {
            sqlx::query("INSERT INTO chat_context_links(org_id,conversation_id,entity_type,entity_id) VALUES($1::uuid,$2::uuid,'project',$3) ON CONFLICT DO NOTHING")
                .bind(&run.org).bind(&conversation_id).bind(project).execute(&mut **tx).await?;
        }
    }
    let existing=sqlx::query_scalar::<_,String>("SELECT id::text FROM chat_messages WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND role='assistant' AND structured_payload->>'eventType'='automation_run_result' AND structured_payload->>'runId'=$3 ORDER BY created_at,id LIMIT 1")
        .bind(&run.org).bind(&conversation_id).bind(&automation_run_id).fetch_optional(&mut **tx).await?;
    let message_id = if let Some(existing) = existing {
        existing
    } else {
        let id = Uuid::new_v4().to_string();
        let output = ["summary", "result", "message", "text"]
            .into_iter()
            .find_map(|key| context::nonempty(run.result.get(key)))
            .or_else(|| {
                run.error
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| {
                if matches!(run.status.as_str(), "failed" | "timed_out" | "cancelled") {
                    "Automation run failed before it produced a final response."
                } else {
                    "Automation run completed."
                }
                .into()
            });
        let status = if matches!(run.status.as_str(), "failed" | "timed_out" | "cancelled") {
            "failed"
        } else {
            "completed"
        };
        let payload = json!({"eventType":"automation_run_result","automationId":automation_id,"automationTitle":title,"runId":automation_run_id,"issueId":issue_id,"status":run.status,"links":{"automation":format!("/automations/{automation_id}"),"issue":format!("/issues/{issue_id}")}});
        sqlx::query("INSERT INTO chat_messages(id,org_id,conversation_id,role,kind,status,body,replying_agent_id,structured_payload,created_at,updated_at) VALUES($1::uuid,$2::uuid,$3::uuid,'assistant','message',$4,$5,$6::uuid,$7::jsonb,$8::timestamptz,$8::timestamptz)")
            .bind(&id).bind(&run.org).bind(&conversation_id).bind(status).bind(&output).bind(&assignee).bind(payload).bind(&timestamp).execute(&mut **tx).await?;
        if let Some(entries) = run.result.get("transcript").and_then(Value::as_array) {
            for (seq, entry) in entries.iter().enumerate() {
                let seq = i32::try_from(seq).map_err(|_| {
                    http(500, "Automation transcript exceeds storage sequence range")
                })?;
                sqlx::query("INSERT INTO chat_message_transcript_entries(org_id,message_id,entry_seq,payload) VALUES($1::uuid,$2::uuid,$3,$4::jsonb)")
                    .bind(&run.org).bind(&id).bind(seq).bind(entry).execute(&mut **tx).await?;
            }
        }
        if created {
            let actor = ActivityActor {
                actor_type: "system",
                actor_id: "automation-chat-output".into(),
                run_id: None,
            };
            let context_count = if row.try_get::<Option<String>, _>("project_id")?.is_some() {
                1
            } else {
                0
            };
            for (action, details) in [
                (
                    "chat.created",
                    json!({"title":if title.is_empty(){"New chat"}else{&title},"contextLinkCount":context_count,"modelOverride":null,"effortOverride":null}),
                ),
                (
                    "chat.message_added",
                    json!({"messageId":id,"role":"assistant","kind":"message","status":status,"preview":output.chars().take(280).collect::<String>()}),
                ),
            ] {
                activity::write_activity_options(
                    tx,
                    ActivityWrite {
                        org: &run.org,
                        audit: &actor,
                        action,
                        entity_type: "chat",
                        entity_id: &conversation_id,
                        details: Some(&details),
                        options: ActivityOptions {
                            agent_id: Some(&assignee),
                            ..ActivityOptions::default()
                        },
                    },
                )
                .await?;
            }
            crate::product_analytics::write_product_analytics_event(tx,crate::product_analytics::ProductAnalyticsEvent{org_id:Some(&run.org),event_name:"chat_created",occurred_at:Some(&timestamp),source_transition:"chat.automation.create",confidence:"exact",actor_type:"automation",actor_id:Some("automation-chat-output"),entity_type:Some("chat"),entity_id:Some(&conversation_id),work_surface:Some("chat"),work_id:Some(&conversation_id),work_cycle_id:None,root_run_id:None,run_id:None,completion_revision:None,origin:"automation",dedupe_key:&format!("chat_created:{conversation_id}"),properties:&json!({"creation_path":"automation","initial_role":"assistant","plan_mode":false})}).await.map_err(|error|match error{crate::StoreError::Database(error)=>error.into(),_=>http(500,"Automation Chat analytics could not be recorded")})?;
        }
        id
    };
    sqlx::query("UPDATE chat_conversations SET last_message_at=$3::timestamptz,updated_at=$3::timestamptz WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(&run.org).bind(&conversation_id).bind(&timestamp).execute(&mut **tx).await?;
    sqlx::query("UPDATE automation_runs SET linked_chat_conversation_id=$3::uuid,terminal_chat_message_id=$4::uuid,last_chat_message_id=$4::uuid,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(&run.org).bind(&automation_run_id).bind(&conversation_id).bind(&message_id).execute(&mut **tx).await?;
    Ok(())
}
