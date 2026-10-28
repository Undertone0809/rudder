mod support;
use rudder_d1_persistence::{
    agent_core::{NativeAgentAccess, NativeAgentAuthorizer},
    agent_execution,
    automation_execution::{self, Host},
    automation_management::Actor,
    native_chat::{self, config::LocalHostContext},
};
use serde_json::{Value, json};
use sqlx::PgConnection;
use std::{future::Future, pin::Pin};
use support::{Database, ORG};

struct Authorized;
impl NativeAgentAuthorizer for Authorized {
    fn revalidate<'a>(
        &'a self,
        _: &'a mut PgConnection,
        org: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<NativeAgentAccess, sqlx::Error>> + Send + 'a>> {
        Box::pin(std::future::ready(Ok(if org == ORG {
            NativeAgentAccess::Authorized
        } else {
            NativeAgentAccess::Forbidden
        })))
    }
}
fn actor() -> Actor<'static> {
    Actor {
        kind: "user",
        id: "synthetic-automation-board",
        run_id: None,
        local_implicit: true,
    }
}
async fn definition(db: &Database, runtime: &str, mode: &str) -> (String, String) {
    let agent = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO agents(id,org_id,name,role,status,agent_runtime_type,agent_runtime_config) VALUES($1::uuid,$2::uuid,'Automation fixture','general','idle',$3,$4::jsonb)")
        .bind(&agent).bind(ORG).bind(runtime).bind(json!({"command":"/bin/true"})).execute(&db.pool).await.unwrap();
    let id=sqlx::query_scalar::<_,String>("INSERT INTO automations(org_id,title,description,assignee_agent_id,output_mode,status,concurrency_policy,catch_up_policy) VALUES($1::uuid,'Synthetic automation','Complete fixture work',$2::uuid,$3,'active','coalesce_if_active','skip_missed') RETURNING id::text")
        .bind(ORG).bind(&agent).bind(mode).fetch_one(&db.pool).await.unwrap();
    (id, agent)
}
#[tokio::test]
async fn track_issue_run_is_atomic_idempotent_scoped_and_reuses_generic_all_ten_runtimes() {
    let db = Database::start().await;
    let host = Host { chat: None };
    for runtime in [
        "claude_local",
        "codex_local",
        "cursor",
        "opencode_local",
        "pi_local",
        "hermes_local",
        "process",
        "http",
        "openclaw_gateway",
        "hermes_gateway",
    ] {
        let (automation, agent) = definition(&db, runtime, "track_issue").await;
        let input = json!({"idempotencyKey":"same-delivery","payload":{"fixture":true}});
        let (left, right) = tokio::join!(
            automation_execution::run_manual(
                &db.pool,
                &Authorized,
                actor(),
                &automation,
                &input,
                &host
            ),
            automation_execution::run_manual(
                &db.pool,
                &Authorized,
                actor(),
                &automation,
                &input,
                &host
            )
        );
        let left = left.unwrap();
        let right = right.unwrap();
        assert_eq!(left["id"], right["id"]);
        assert_eq!(left["status"], "issue_created");
        let issue = left["linkedIssueId"].as_str().unwrap();
        let run:String=sqlx::query_scalar("SELECT run_id::text FROM agent_wakeup_requests WHERE org_id=$1::uuid AND agent_id=$2::uuid")
            .bind(ORG).bind(&agent).fetch_one(&db.pool).await.unwrap();
        let claim = agent_execution::claim_queued_run(&db.pool, ORG, &run)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(claim.runtime_type, runtime);
        assert_eq!(claim.issue_id.as_deref(), Some(issue));
        let coalesced = automation_execution::run_manual(
            &db.pool,
            &Authorized,
            actor(),
            &automation,
            &json!({}),
            &host,
        )
        .await
        .unwrap();
        assert_eq!(coalesced["status"], "coalesced");
        assert_eq!(coalesced["linkedIssueId"], left["linkedIssueId"]);
        let counts:(i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM issues WHERE org_id=$1::uuid AND origin_id=$2),(SELECT count(*) FROM automation_runs WHERE org_id=$1::uuid AND automation_id=$2::uuid)")
            .bind(ORG).bind(&automation).fetch_one(&db.pool).await.unwrap();
        assert_eq!(counts, (1, 2));
    }
    let (automation, agent) = definition(&db, "process", "track_issue").await;
    let denied = Actor {
        kind: "agent",
        id: support::CEO,
        run_id: None,
        local_implicit: false,
    };
    assert!(
        automation_execution::run_manual(
            &db.pool,
            &Authorized,
            denied,
            &automation,
            &json!({}),
            &host
        )
        .await
        .is_err()
    );
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM automation_runs WHERE automation_id=$1::uuid")
            .bind(&automation)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
    assert_ne!(agent, support::CEO);
}
#[tokio::test]
async fn schedule_claim_and_admission_commit_once_and_catch_up_uses_existing_cap() {
    let db = Database::start().await;
    let host = Host { chat: None };
    let (automation, _) = definition(&db, "process", "track_issue").await;
    let _trigger:String=sqlx::query_scalar("INSERT INTO automation_triggers(org_id,automation_id,kind,enabled,cron_expression,timezone,next_run_at) VALUES($1::uuid,$2::uuid,'schedule',true,'* * * * *','UTC',statement_timestamp()-interval '1 minute') RETURNING id::text")
        .bind(ORG).bind(&automation).fetch_one(&db.pool).await.unwrap();
    let now: i64 =
        sqlx::query_scalar("SELECT (extract(epoch FROM statement_timestamp())*1000)::bigint")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    let (left, right) = tokio::join!(
        automation_execution::tick(&db.pool, now, &host),
        automation_execution::tick(&db.pool, now, &host)
    );
    assert_eq!(left.unwrap() + right.unwrap(), 1);
    assert_eq!(
        automation_execution::tick(&db.pool, now, &host)
            .await
            .unwrap(),
        0,
        "skip_missed advances beyond now after its one dispatch"
    );
    let now = now / 60_000 * 60_000;
    for overdue in [3_i64, 25, 30] {
        let (automation, _) = definition(&db, "process", "track_issue").await;
        sqlx::query("UPDATE automations SET concurrency_policy='always_enqueue',catch_up_policy='enqueue_missed_with_cap' WHERE id=$1::uuid")
            .bind(&automation).execute(&db.pool).await.unwrap();
        let due_at = now - (overdue - 1) * 60_000;
        let trigger: String = sqlx::query_scalar("INSERT INTO automation_triggers(org_id,automation_id,kind,enabled,cron_expression,timezone,next_run_at) VALUES($1::uuid,$2::uuid,'schedule',true,'* * * * *','UTC',to_timestamp($3::double precision/1000)) RETURNING id::text")
            .bind(ORG).bind(&automation).bind(due_at).fetch_one(&db.pool).await.unwrap();
        let first = overdue.min(25);
        assert_eq!(
            automation_execution::tick(&db.pool, now, &host)
                .await
                .unwrap(),
            first as u64
        );
        let cursor: i64 = sqlx::query_scalar("SELECT (extract(epoch FROM next_run_at)*1000)::bigint FROM automation_triggers WHERE id=$1::uuid")
            .bind(&trigger).fetch_one(&db.pool).await.unwrap();
        assert_eq!(cursor, due_at + first * 60_000);
        assert_eq!(cursor <= now, overdue > 25);
        assert_eq!(
            automation_execution::tick(&db.pool, now, &host)
                .await
                .unwrap(),
            (overdue - first) as u64,
            "the second pass consumes only the overdue occurrences beyond the cap"
        );
        let cursor: i64 = sqlx::query_scalar("SELECT (extract(epoch FROM next_run_at)*1000)::bigint FROM automation_triggers WHERE id=$1::uuid")
            .bind(&trigger).fetch_one(&db.pool).await.unwrap();
        assert_eq!(cursor, now + 60_000);
        assert_eq!(
            automation_execution::tick(&db.pool, now, &host)
                .await
                .unwrap(),
            0,
            "consumed occurrences must not dispatch again"
        );
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM automation_runs WHERE automation_id=$1::uuid")
                .bind(&automation)
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(count, overdue);
    }
}
#[tokio::test]
async fn failed_issue_admission_retains_only_failed_automation_receipt() {
    let db = Database::start().await;
    let host = Host { chat: None };
    let (automation, _) = definition(&db, "process", "track_issue").await;
    db.sql("CREATE FUNCTION reject_automation_issue_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.origin_kind='automation_execution' THEN RAISE EXCEPTION 'synthetic automation issue failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_automation_issue_fixture BEFORE INSERT ON issues FOR EACH ROW EXECUTE FUNCTION reject_automation_issue_fixture();").await;
    let run = automation_execution::run_manual(
        &db.pool,
        &Authorized,
        actor(),
        &automation,
        &json!({}),
        &host,
    )
    .await
    .unwrap();
    assert_eq!(run["status"], "failed");
    assert!(run["completedAt"].is_string());
    assert!(run["linkedIssueId"].is_null());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM issues WHERE origin_id=$1")
        .bind(&automation)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM agent_wakeup_requests WHERE payload->>'issueId' IN (SELECT id::text FROM issues WHERE origin_id=$1)").bind(&automation).fetch_one(&db.pool).await.unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn chat_output_creates_a_real_native_generation_without_an_issue_and_recovers_only_unclaimed_jobs()
 {
    let db = Database::start().await;
    let (automation, agent) = definition(&db, "codex_local", "chat_output").await;
    let root = tempfile::tempdir().unwrap();
    let instance = root.path().join("instance");
    let workspace = root.path().join("workspaces");
    let profiles = root.path().join("profiles");
    let operator = root.path().join("operator");
    let previous = root.path().join("previous");
    let cwd = root.path().join("cwd");
    let executable = root.path().join("codex-fixture");
    for path in [&instance, &workspace, &profiles, &operator, &previous, &cwd] {
        std::fs::create_dir_all(path).unwrap();
    }
    std::fs::create_dir_all(profiles.join(ORG).join(&agent).join("default")).unwrap();
    let org_key = ORG.replace('-', "").chars().take(12).collect::<String>();
    let instructions = workspace
        .join(org_key)
        .join("workspaces/agents/automation-fixture/instructions");
    std::fs::create_dir_all(&instructions).unwrap();
    std::fs::write(
        instructions.join("SOUL.md"),
        "Synthetic Automation Chat instructions\n",
    )
    .unwrap();
    std::fs::write(
        &executable,
        "test-only executable; never launched by this admission fixture",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let context = LocalHostContext::from_rust_host(
        "automation-chat-fixture".into(),
        instance,
        workspace,
        previous,
        false,
        profiles,
        operator,
        executable.clone(),
    )
    .unwrap();
    sqlx::query("UPDATE agents SET agent_runtime_config=$2::jsonb WHERE id=$1::uuid")
        .bind(&agent).bind(json!({"command":executable,"cwd":cwd,"profileId":"default","instructionsBundleMode":"managed","search":false})).execute(&db.pool).await.unwrap();
    sqlx::query("UPDATE automations SET project_id=$2::uuid WHERE id=$1::uuid")
        .bind(&automation)
        .bind(support::PROJECT)
        .execute(&db.pool)
        .await
        .unwrap();
    let host = Host {
        chat: Some(&context),
    };
    let run = automation_execution::run_manual(
        &db.pool,
        &Authorized,
        actor(),
        &automation,
        &json!({"payload":{"fixture":true}}),
        &host,
    )
    .await
    .unwrap();
    assert_eq!(run["status"], "running", "{run}");
    assert!(run["linkedIssueId"].is_null());
    assert!(run["linkedChatConversationId"].is_string());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM issues WHERE origin_id=$1")
        .bind(&automation)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let origin:Value=sqlx::query_scalar("SELECT h.context_snapshot FROM heartbeat_runs h JOIN chat_generations g ON g.org_id=h.org_id AND g.id=h.chat_generation_id WHERE g.source_message_id=$1::uuid")
        .bind(run["startedChatMessageId"].as_str()).fetch_one(&db.pool).await.unwrap();
    assert_eq!(origin["automationRunId"], run["id"]);
    assert_eq!(origin["automationId"], automation);
    let jobs = native_chat::list_automation_jobs(&db.pool).await.unwrap();
    assert_eq!(jobs.len(), 1);
    let (principal, native_run, attempt) = jobs.into_iter().next().unwrap().into_parts();
    let claim =
        native_chat::execution::claim(&db.pool, &principal, ORG, &native_run, &attempt, &context)
            .await
            .unwrap();
    assert_eq!(claim.fence.identity().run_id, native_run);
    assert!(
        native_chat::list_automation_jobs(&db.pool)
            .await
            .unwrap()
            .is_empty()
    );
    // Merely claiming, or the absence of an in-memory Job, is no terminal proof.
    assert_eq!(
        automation_execution::reconcile_chat_runs(&db.pool)
            .await
            .unwrap(),
        0
    );
    let state: String = sqlx::query_scalar("SELECT status FROM automation_runs WHERE id=$1::uuid")
        .bind(run["id"].as_str())
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(state, "running");
}
