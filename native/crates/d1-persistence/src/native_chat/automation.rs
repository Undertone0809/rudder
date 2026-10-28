//! Trusted Automation producer into the existing Chat transaction and worker.
//! None of these capabilities can be deserialized from a public request.
use super::{NativeChatActor, Result, admission, config::LocalHostContext, http, validation};
use crate::{
    activity::{self, ActivityActor, ActivityOptions, ActivityWrite},
    automation_execution::LockedAutomationDispatch,
};
use rudder_auth_core::ActorIdentity;
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

pub struct AutomationChatActor {
    actor: ActorIdentity,
    organization: String,
    automation_run: String,
}
impl NativeChatActor for AutomationChatActor {
    fn actor(&self) -> &ActorIdentity {
        &self.actor
    }
    fn organization_id(&self) -> &str {
        &self.organization
    }
    fn session_id(&self) -> &str {
        &self.automation_run
    }
}
/// Returned only from a persisted Automation/Generation/Run identity join.
/// Existing D1 claim still owns lease and one-use launch-permit admission.
pub struct AutomationChatJob {
    actor: AutomationChatActor,
    run: String,
    attempt: String,
}
impl AutomationChatJob {
    pub fn into_parts(self) -> (AutomationChatActor, String, String) {
        (self.actor, self.run, self.attempt)
    }
}
pub(crate) async fn admit(
    tx: &mut Transaction<'_, Postgres>,
    producer: &LockedAutomationDispatch,
    host: &LocalHostContext,
) -> Result<Value> {
    let automation = producer.automation();
    let org = producer.org();
    let assignee = automation["assigneeAgentId"]
        .as_str()
        .ok_or_else(|| http(404, "Assigned agent not found"))?;
    let runtime: String = sqlx::query_scalar(
        "SELECT agent_runtime_type FROM agents WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(org)
    .bind(assignee)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(404, "Assigned agent not found"))?;
    let config = &automation["assigneeAgentRuntimeOverrides"]["agentRuntimeConfig"];
    let nonempty = |v: &Value| {
        v.as_str()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    let effort_key = match runtime.as_str() {
        "codex_local" => "modelReasoningEffort",
        "opencode_local" => "variant",
        "pi_local" => "thinking",
        _ => "effort",
    };
    let effort = nonempty(&config[effort_key]).or_else(|| {
        (runtime == "codex_local")
            .then(|| nonempty(&config["reasoningEffort"]))
            .flatten()
    });
    let conversation = Uuid::new_v4().to_string();
    let title = automation["title"]
        .as_str()
        .filter(|v| !v.is_empty())
        .unwrap_or("New chat");
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:automation',true)")
        .execute(&mut **tx)
        .await?;
    sqlx::query("INSERT INTO chat_conversations(id,org_id,title,summary,preferred_agent_id,model_override,effort_override,issue_creation_mode,plan_mode,created_by_user_id) VALUES($1::uuid,$2::uuid,$3,NULL,$4::uuid,$5,$6,'manual_approval',false,NULL)")
        .bind(&conversation).bind(org).bind(title).bind(assignee).bind(nonempty(&config["model"])).bind(&effort).execute(&mut **tx).await?;
    if let Some(project) = automation["projectId"].as_str() {
        sqlx::query("INSERT INTO chat_context_links(org_id,conversation_id,entity_type,entity_id,metadata) SELECT $1::uuid,$2::uuid,'project',p.id::text,NULL FROM projects p WHERE p.org_id=$1::uuid AND p.id=$3::uuid")
            .bind(org).bind(&conversation).bind(project).execute(&mut **tx).await?;
    }
    let base = automation["description"]
        .as_str()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(title.trim());
    let mut prompt = format!(
        "{base}\n\nAutomation: {title}\nTrigger source: {}",
        producer.source()
    );
    if producer
        .payload()
        .as_object()
        .is_some_and(|v| !v.is_empty())
    {
        prompt.push_str(&format!("\nTrigger payload: {}", producer.payload()));
    }
    let actor = AutomationChatActor {
        actor: ActorIdentity {
            kind: "agent".into(),
            id: assignee.into(),
        },
        organization: org.into(),
        automation_run: format!("automation:{}", producer.run_id()),
    };
    let mutation = format!("automation:{}", producer.run_id());
    let fingerprint = validation::fingerprint(&prompt);
    let receipt = admission::submit_into_transaction(
        tx,
        &actor,
        admission::AdmissionInput {
            organization_id: org,
            conversation_id: &conversation,
            client_mutation_id: &mutation,
            body: &prompt,
            fingerprint: &fingerprint,
            initial_draft_snapshot: None,
            message_activity: false,
            host,
        },
    )
    .await?;
    sqlx::query("UPDATE heartbeat_runs SET context_snapshot=context_snapshot||$3::jsonb WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(org).bind(receipt["runId"].as_str())
        .bind(json!({"automationId":automation["id"],"automationRunId":producer.run_id(),"triggerId":producer.trigger_id(),"source":producer.source(),"automationInput":producer.payload()}))
        .execute(&mut **tx).await?;
    let message = receipt["userMessageId"]
        .as_str()
        .ok_or_else(|| http(500, "Automation Chat source receipt is incomplete"))?;
    // Ordinary Native Chat freezes a plain source message. Automation origin
    // remains in the immutable Run context; typed source/result projection is
    // a separate compatibility requirement, never a relaxation of public input.
    sqlx::query("UPDATE chat_messages SET chat_turn_id=COALESCE(chat_turn_id,gen_random_uuid()) WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(org).bind(message).execute(&mut **tx).await?;
    sqlx::query("UPDATE automation_runs SET linked_chat_conversation_id=$3::uuid,started_chat_message_id=$4::uuid,last_chat_message_id=$4::uuid,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(org).bind(producer.run_id()).bind(&conversation).bind(message).execute(&mut **tx).await?;
    let audit = ActivityActor {
        actor_type: "system",
        actor_id: "automation-chat-output".into(),
        run_id: None,
    };
    for (action, details) in [
        (
            "chat.created",
            json!({"title":title,"contextLinkCount":usize::from(automation["projectId"].is_string()),"modelOverride":nonempty(&config["model"]),"effortOverride":effort}),
        ),
        (
            "chat.message_added",
            json!({"messageId":message,"role":"user","kind":"message","status":"completed","preview":prompt.chars().take(280).collect::<String>()}),
        ),
    ] {
        activity::write_activity_options(
            tx,
            ActivityWrite {
                org,
                audit: &audit,
                action,
                entity_type: "chat",
                entity_id: &conversation,
                details: Some(&details),
                options: ActivityOptions {
                    agent_id: Some(assignee),
                    ..ActivityOptions::default()
                },
            },
        )
        .await?;
    }
    let created_at: String = sqlx::query_scalar(
        "SELECT created_at::text FROM chat_conversations WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(org)
    .bind(&conversation)
    .fetch_one(&mut **tx)
    .await?;
    crate::product_analytics::write_product_analytics_event(tx,crate::product_analytics::ProductAnalyticsEvent{
        org_id:Some(org),event_name:"chat_created",occurred_at:None,source_transition:"chat.automation.create",confidence:"exact",actor_type:"automation",actor_id:Some("automation-chat-output"),entity_type:Some("chat"),entity_id:Some(&conversation),work_surface:Some("chat"),work_id:Some(&conversation),work_cycle_id:None,root_run_id:None,run_id:None,completion_revision:None,origin:"automation",dedupe_key:&format!("chat_created:{conversation}"),properties:&json!({"creation_path":"automation","initial_role":"user","plan_mode":false}),
    }).await.map_err(|error|match error{crate::StoreError::Database(error)=>super::Error::Database(error),_=>http(500,"Automation Chat analytics could not be recorded")})?;

    Ok(receipt)
}

pub async fn list_automation_jobs(pool: &PgPool) -> Result<Vec<AutomationChatJob>> {
    let rows=sqlx::query("SELECT ar.org_id::text,h.id::text AS run_id,a.id::text AS attempt_id,h.agent_id::text,ar.id::text AS automation_run_id FROM automation_runs ar JOIN automations d ON d.org_id=ar.org_id AND d.id=ar.automation_id JOIN chat_generations g ON g.org_id=ar.org_id AND g.conversation_id=ar.linked_chat_conversation_id AND g.source_message_id=ar.started_chat_message_id JOIN heartbeat_runs h ON h.org_id=g.org_id AND h.chat_generation_id=g.id JOIN heartbeat_run_attempts a ON a.org_id=h.org_id AND a.run_id=h.id WHERE ar.status='running' AND d.output_mode='chat_output' AND h.context_snapshot->>'automationRunId'=ar.id::text AND h.context_snapshot->>'automationId'=d.id::text AND g.execution_authority='native_rust' AND g.status='starting' AND g.control_owner_token IS NULL AND g.control_lease_expires_at IS NULL AND g.control_state='unregistered' AND h.status='running' AND a.status='started' AND a.generation_attempt_epoch=g.attempt_epoch ORDER BY ar.created_at LIMIT 64")
        .fetch_all(pool).await?;
    rows.into_iter()
        .map(|row| {
            let organization: String = row.try_get("org_id")?;
            let agent: String = row.try_get("agent_id")?;
            let automation: String = row.try_get("automation_run_id")?;
            Ok(AutomationChatJob {
                actor: AutomationChatActor {
                    actor: ActorIdentity {
                        kind: "agent".into(),
                        id: agent,
                    },
                    organization,
                    automation_run: format!("automation:{automation}"),
                },
                run: row.try_get("run_id")?,
                attempt: row.try_get("attempt_id")?,
            })
        })
        .collect()
}
