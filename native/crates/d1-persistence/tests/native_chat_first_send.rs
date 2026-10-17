#[allow(dead_code)]
#[path = "support/mod.rs"]
mod support;

use rudder_auth_core::{
    ActorEnvelope, ActorIdentity, NonceReplayGuard, RequestContext, VerifiedActor,
};
use rudder_d1_persistence::native_chat::config::LocalHostContext;
use rudder_d1_persistence::native_chat::execution::{
    CheckpointTransition, advance_checkpoint, load_submission, validate_submission_source,
};
use rudder_d1_persistence::native_chat::{
    Error, FirstSendRequest, Request, execute_first_send, lookup_submission,
};
use rudder_runtime_core::native_chat::NativeChatProtocolPhase as Phase;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{fs, path::PathBuf, sync::OnceLock};
use support::{CEO, Database, ORG, OTHER};
use tempfile::TempDir;

const USER: &str = "native-first-send-owner";
const FOREIGN_AGENT: &str = "50000000-0000-4000-8000-000000000091";
const TERMINATED_AGENT: &str = "50000000-0000-4000-8000-000000000092";
const SECRET: &[u8] = b"native-first-send-test-key";

struct Host {
    _root: TempDir,
    context: LocalHostContext,
    executable: PathBuf,
    cwd: PathBuf,
}

impl Host {
    fn new() -> Self {
        let root = tempfile::tempdir().expect("create first-send host fixture");
        let instance = root.path().join("instance");
        let workspace_home = root.path().join("workspaces");
        let profiles = root.path().join("profiles");
        let operator_home = root.path().join("operator-home");
        let previous_documents = root.path().join("previous-documents");
        let executable = root.path().join("bin/codex");
        let cwd = root.path().join("workspace");
        let profile = profiles.join(ORG).join(CEO).join("default");
        for path in [
            &instance,
            &workspace_home,
            &profiles,
            &operator_home,
            &previous_documents,
            executable.parent().unwrap(),
            &cwd,
            &profile,
        ] {
            fs::create_dir_all(path).expect("create isolated host path");
        }
        fs::write(&executable, b"test-only Codex executable").expect("write executable fixture");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o755))
                .expect("mark executable fixture");
        }
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            let org_key = ORG
                .chars()
                .filter(|character| *character != '-')
                .take(12)
                .collect::<String>();
            let instructions = workspace_home
                .join(org_key)
                .join("workspaces/agents/codex-agent/instructions");
            fs::create_dir_all(&instructions).expect("create instruction fixture");
            fs::write(instructions.join("SOUL.md"), "first-send fixture\n")
                .expect("write instruction fixture");
        }
        let executable = executable
            .canonicalize()
            .expect("canonical executable fixture");
        let cwd = cwd.canonicalize().expect("canonical workspace fixture");
        let context = LocalHostContext::from_rust_host(
            "first-send-test-host".into(),
            instance,
            workspace_home,
            previous_documents,
            false,
            profiles,
            operator_home,
            executable.clone(),
        )
        .expect("construct Rust host context");
        Self {
            _root: root,
            context,
            executable,
            cwd,
        }
    }

    fn agent_config(&self) -> Value {
        json!({
            "command": self.executable.to_string_lossy(),
            "cwd": self.cwd.to_string_lossy(),
            "profileId": "default",
            "instructionsBundleMode": "managed",
            "search": false,
        })
    }
}

fn host() -> &'static Host {
    static HOST: OnceLock<Host> = OnceLock::new();
    HOST.get_or_init(Host::new)
}

fn actor(nonce: &str) -> VerifiedActor {
    actor_as(nonce, USER, ORG)
}

fn actor_as(nonce: &str, user_id: &str, organization_id: &str) -> VerifiedActor {
    let identity = ActorIdentity::new("user", user_id).expect("valid fixture actor");
    let path = format!("/internal/orgs/{organization_id}/chat/native-first-send");
    let body = b"{}";
    let request_id = format!("first-send-{nonce}");
    ActorEnvelope::new(
        identity.clone(),
        organization_id,
        "test-session",
        1,
        "rudder-server-foundation",
        "POST",
        &path,
        "chat.native_first_send",
        body,
        &request_id,
        nonce,
        1_000,
        1_100,
    )
    .expect("create envelope")
    .sign(SECRET)
    .expect("sign envelope")
    .verify_to_actor(
        SECRET,
        &RequestContext::new(
            &identity,
            organization_id,
            "test-session",
            1,
            "rudder-server-foundation",
            "POST",
            &path,
            "chat.native_first_send",
            body,
            &request_id,
            1_050,
        ),
        &mut NonceReplayGuard::new(),
    )
    .expect("verify actor envelope")
}

fn first_send(
    mutation: &str,
    body: &str,
    preferred_agent_id: Option<&str>,
    model_override: Option<&str>,
    effort_override: Option<&str>,
) -> FirstSendRequest {
    first_send_options(FirstSendOptions {
        mutation,
        body,
        preferred_agent_id,
        model_override,
        effort_override,
        issue_creation_mode: None,
        plan_mode: None,
        title: None,
    })
}

struct FirstSendOptions<'a> {
    mutation: &'a str,
    body: &'a str,
    preferred_agent_id: Option<&'a str>,
    model_override: Option<&'a str>,
    effort_override: Option<&'a str>,
    issue_creation_mode: Option<&'a str>,
    plan_mode: Option<bool>,
    title: Option<&'a str>,
}

fn first_send_options(options: FirstSendOptions<'_>) -> FirstSendRequest {
    let FirstSendOptions {
        mutation,
        body,
        preferred_agent_id,
        model_override,
        effort_override,
        issue_creation_mode,
        plan_mode,
        title,
    } = options;
    let mut value = json!({
        "clientMutationId": mutation,
        "body": body,
    });
    if let Some(agent) = preferred_agent_id {
        value["preferredAgentId"] = json!(agent);
    }
    if let Some(model) = model_override {
        value["modelOverride"] = json!(model);
    }
    if let Some(effort) = effort_override {
        value["effortOverride"] = json!(effort);
    }
    if let Some(mode) = issue_creation_mode {
        value["issueCreationMode"] = json!(mode);
    }
    if let Some(plan_mode) = plan_mode {
        value["planMode"] = json!(plan_mode);
    }
    if let Some(title) = title {
        value["title"] = json!(title);
    }
    serde_json::from_value(value).expect("valid first-send command")
}

async fn prepare(database: &Database) {
    sqlx::query(
        "INSERT INTO \"user\"(id,name,email,created_at,updated_at)
         VALUES ($1,'First-send fixture','native-chat-first-send@example.test',now(),now())",
    )
    .bind(USER)
    .execute(&database.pool)
    .await
    .expect("seed persisted user required by claimed execution principal");
    sqlx::query(
        "INSERT INTO organization_memberships(org_id, principal_type, principal_id, membership_role, status)
         VALUES ($1::uuid, 'user', $2, 'member', 'active')",
    )
    .bind(ORG)
    .bind(USER)
    .execute(&database.pool)
    .await
    .expect("seed organization membership");
    sqlx::query(
        "UPDATE agents SET agent_runtime_type='codex_local', status='idle', workspace_key='codex-agent',
                agent_runtime_config=$1::jsonb WHERE org_id=$2::uuid AND id=$3::uuid",
    )
    .bind(host().agent_config().to_string())
    .bind(ORG)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("configure persisted Codex Agent");
    sqlx::query(
        "INSERT INTO agents (id,org_id,name,role,status,agent_runtime_type)
         VALUES ($1::uuid,$2::uuid,'Foreign Agent','general','idle','codex_local')",
    )
    .bind(FOREIGN_AGENT)
    .bind(OTHER)
    .execute(&database.pool)
    .await
    .expect("seed foreign Agent");
    sqlx::query(
        "INSERT INTO agents (id,org_id,name,role,status,agent_runtime_type)
         VALUES ($1::uuid,$2::uuid,'Terminated Agent','general','terminated','codex_local')",
    )
    .bind(TERMINATED_AGENT)
    .bind(ORG)
    .execute(&database.pool)
    .await
    .expect("seed terminated Agent");
}

async fn run(
    pool: &PgPool,
    actor: &VerifiedActor,
    request: &FirstSendRequest,
) -> Result<Value, Error> {
    execute_first_send(pool, actor, ORG, request, &host().context).await
}

async fn counts(pool: &PgPool, mutation: &str) -> (i64, i64, i64, i64, i64, i64) {
    counts_for(pool, USER, mutation).await
}

async fn counts_for(
    pool: &PgPool,
    user_id: &str,
    mutation: &str,
) -> (i64, i64, i64, i64, i64, i64) {
    sqlx::query_as(
        "SELECT
           (SELECT count(*) FROM chat_conversations WHERE org_id=$1::uuid AND created_by_user_id=$2 AND initial_client_mutation_id=$3),
           (SELECT count(*) FROM chat_messages m JOIN chat_conversations c ON c.org_id=m.org_id AND c.id=m.conversation_id WHERE c.org_id=$1::uuid AND c.created_by_user_id=$2 AND c.initial_client_mutation_id=$3),
           (SELECT count(*) FROM chat_generations g JOIN chat_conversations c ON c.org_id=g.org_id AND c.id=g.conversation_id WHERE c.org_id=$1::uuid AND c.created_by_user_id=$2 AND c.initial_client_mutation_id=$3 AND g.execution_authority='native_rust'),
           (SELECT count(*) FROM heartbeat_runs r JOIN chat_conversations c ON c.org_id=r.org_id AND c.id=r.chat_conversation_id WHERE c.org_id=$1::uuid AND c.created_by_user_id=$2 AND c.initial_client_mutation_id=$3 AND r.execution_authority='native_rust'),
           (SELECT count(*) FROM heartbeat_run_attempts a JOIN heartbeat_runs r ON r.org_id=a.org_id AND r.id=a.run_id JOIN chat_conversations c ON c.org_id=r.org_id AND c.id=r.chat_conversation_id WHERE c.org_id=$1::uuid AND c.created_by_user_id=$2 AND c.initial_client_mutation_id=$3 AND r.execution_authority='native_rust'),
           (SELECT count(*) FROM activity_log a WHERE a.org_id=$1::uuid AND a.action='chat.message_added'
             AND a.entity_id IN (SELECT id::text FROM chat_conversations c
               WHERE c.org_id=$1::uuid AND c.created_by_user_id=$2 AND c.initial_client_mutation_id=$3))",
    )
    .bind(ORG)
    .bind(user_id)
    .bind(mutation)
    .fetch_one(pool)
    .await
    .expect("count first-send effects")
}

#[tokio::test(flavor = "multi_thread")]
async fn first_send_creates_one_conversation_and_exact_retry_keeps_original_agent_and_run() {
    let database = Database::start().await;
    prepare(&database).await;
    let first_actor = actor("first-owner-1");
    let request = first_send("first-mutation-1", "  first question  ", None, None, None);
    let accepted = run(&database.pool, &first_actor, &request)
        .await
        .expect("first turn atomically admitted");
    assert_eq!(accepted["executionAuthority"], "native_rust");
    assert_eq!(accepted["idempotentReplay"], false);
    assert_eq!(
        counts(&database.pool, "first-mutation-1").await,
        (1, 1, 1, 1, 1, 1)
    );

    let conversation_id = accepted["conversationId"].as_str().unwrap();
    let persisted: (String, String, String, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT preferred_agent_id::text, title, initial_client_mutation_id,
                model_override, effort_override
         FROM chat_conversations WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(conversation_id)
    .fetch_one(&database.pool)
    .await
    .expect("read created conversation");
    assert_eq!(
        persisted,
        (
            CEO.to_owned(),
            "first question".into(),
            "first-mutation-1".into(),
            None,
            None
        )
    );

    // The execution source contract keeps its ordinary body fingerprint. The
    // separate initial-draft proof binds first-send settings without changing
    // what execution and generic message reconciliation validate.
    let body_fingerprint: String = sqlx::query_scalar(
        "SELECT client_mutation_fingerprint FROM chat_messages
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(accepted["userMessageId"].as_str().unwrap())
    .fetch_one(&database.pool)
    .await
    .expect("read canonical source fingerprint");
    assert!(body_fingerprint.starts_with("native-chat-v1:"));
    let run_context: Value = sqlx::query_scalar(
        "SELECT context_snapshot FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(accepted["runId"].as_str().unwrap())
    .fetch_one(&database.pool)
    .await
    .expect("read admitted run context");
    assert_eq!(run_context["inputFingerprint"], body_fingerprint);
    assert!(
        run_context["nativeChatInitialDraft"]["fingerprint"]
            .as_str()
            .is_some_and(|value| value.starts_with("native-chat-first-v1:"))
    );

    // Exact retry uses the immutable first-draft proof and committed Run; it
    // never re-resolves mutable Agent or Conversation settings.
    sqlx::query(
        "UPDATE agents SET agent_runtime_config='{}'::jsonb WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("change config after admission");
    sqlx::query(
        "UPDATE chat_conversations
         SET title='changed after admission', model_override='changed-model',
             effort_override='low', issue_creation_mode='auto_create'
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(conversation_id)
    .execute(&database.pool)
    .await
    .expect("change mutable conversation display settings after admission");
    let retry = run(&database.pool, &actor("first-owner-2"), &request)
        .await
        .expect("exact retry returns original receipt");
    for field in [
        "conversationId",
        "userMessageId",
        "generationId",
        "runId",
        "attemptId",
    ] {
        assert_eq!(accepted[field], retry[field]);
    }
    assert_eq!(retry["idempotentReplay"], true);
    assert_eq!(
        counts(&database.pool, "first-mutation-1").await,
        (1, 1, 1, 1, 1, 1)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn first_send_body_fingerprint_reconciles_and_execution_loads_original_input() {
    let database = Database::start().await;
    prepare(&database).await;
    let actor = actor("first-owner-execution");
    let request = first_send(
        "first-mutation-execution",
        "the exact first input",
        None,
        None,
        None,
    );
    let accepted = run(&database.pool, &actor, &request)
        .await
        .expect("admit first Chat input");
    let conversation_id = accepted["conversationId"].as_str().unwrap();

    // Existing-chat reconciliation sees the same source message fingerprint
    // used by ordinary turns, while the first-send operation keeps its richer
    // immutable draft match private in the Run context snapshot.
    let reconcile: Request = serde_json::from_value(json!({
        "operation": "submit_native_chat_turn",
        "conversationId": conversation_id,
        "clientMutationId": "first-mutation-execution",
        "body": "the exact first input",
    }))
    .expect("build ordinary exact-retry request");
    let replay = lookup_submission(&database.pool, &actor, ORG, &reconcile)
        .await
        .expect("reconcile first-send body using normal source identity")
        .expect("first-send has durable receipt");
    assert_eq!(replay["conversationId"], accepted["conversationId"]);
    assert_eq!(replay["userMessageId"], accepted["userMessageId"]);
    assert_eq!(replay["generationId"], accepted["generationId"]);
    assert_eq!(replay["runId"], accepted["runId"]);
    assert_eq!(replay["idempotentReplay"], true);

    let claimed = rudder_d1_persistence::native_chat::execution::claim(
        &database.pool,
        &actor,
        ORG,
        accepted["runId"].as_str().unwrap(),
        accepted["attemptId"].as_str().unwrap(),
        &host().context,
    )
    .await
    .expect("claim first-send Run through the real execution authority");
    let (execution_actor, fence, _config, _launch_permit) = claimed.into_execution_parts();
    validate_submission_source(&database.pool, &execution_actor, &fence)
        .await
        .expect("execution source validator accepts ordinary body fingerprint");
    advance_checkpoint(
        &database.pool,
        &execution_actor,
        &fence,
        Phase::NoThreadRequest,
        0,
        CheckpointTransition::PrepareThreadStart,
    )
    .await
    .expect("persist pre-Thread checkpoint");
    advance_checkpoint(
        &database.pool,
        &execution_actor,
        &fence,
        Phase::ThreadStartIndeterminate,
        1,
        CheckpointTransition::RecordThread {
            thread_id: "first-send-execution-thread".into(),
        },
    )
    .await
    .expect("bind exact Thread checkpoint");
    advance_checkpoint(
        &database.pool,
        &execution_actor,
        &fence,
        Phase::ThreadKnown,
        2,
        CheckpointTransition::PrepareInput,
    )
    .await
    .expect("prepare one-time input submission");
    let input = load_submission(&database.pool, &execution_actor, &fence)
        .await
        .expect("load first-send text under claimed execution fence");
    assert_eq!(input.body(), "the exact first input");
    assert_eq!(
        input.message_id(),
        accepted["userMessageId"].as_str().unwrap()
    );
}

async fn wait_for_target_advisory_wait(pool: &PgPool) {
    for _ in 0..300 {
        let waiting: bool = sqlx::query_scalar(
            "SELECT EXISTS(
               SELECT 1 FROM pg_stat_activity
               WHERE datname=current_database() AND wait_event_type='Lock'
                 AND query ILIKE '%pg_advisory_xact_lock%'
             )",
        )
        .fetch_one(pool)
        .await
        .expect("inspect first-send target-lock wait");
        if waiting {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for first-send retry target lock");
}

#[tokio::test(flavor = "multi_thread")]
async fn first_send_rechecks_membership_after_waiting_for_existing_target_lock() {
    let database = Database::start().await;
    prepare(&database).await;
    let actor = actor("first-owner-target-lock-revocation");
    let request = first_send(
        "first-mutation-target-lock-revocation",
        "stable first input",
        None,
        None,
        None,
    );
    let accepted = run(&database.pool, &actor, &request)
        .await
        .expect("admit initial first-send receipt");
    let conversation_id = accepted["conversationId"].as_str().unwrap();

    // Hold the same serialization lock used by admission while the retry has
    // completed its non-locking preauthorization. Revocation then wins before
    // the target wait ends; full auth must run only after that wait.
    let mut blocker = database.pool.begin().await.expect("begin target blocker");
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!(
            "runtime-binding:target:chat_conversation:{ORG}:{conversation_id}"
        ))
        .execute(&mut *blocker)
        .await
        .expect("hold Native Chat target lock");
    let pool = database.pool.clone();
    let retry_actor = actor.clone();
    let retry_request = request.clone();
    let retry = tokio::spawn(async move { run(&pool, &retry_actor, &retry_request).await });
    wait_for_target_advisory_wait(&database.pool).await;
    sqlx::query(
        "UPDATE organization_memberships SET status='inactive'
         WHERE org_id=$1::uuid AND principal_type='user' AND principal_id=$2",
    )
    .bind(ORG)
    .bind(USER)
    .execute(&database.pool)
    .await
    .expect("revoke membership while retry waits for target");
    blocker.commit().await.expect("release target lock");

    assert!(matches!(
        retry.await.expect("join first-send retry"),
        Err(Error::Http(403, _))
    ));
    assert_eq!(
        counts(&database.pool, "first-mutation-target-lock-revocation").await,
        (1, 1, 1, 1, 1, 1),
        "authorization failure cannot add or rewrite any first-send effects"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn first_send_changed_draft_or_invalid_agent_fails_without_writes() {
    let database = Database::start().await;
    prepare(&database).await;
    let actor = actor("first-owner-invalid");

    for (mutation, request) in [
        (
            "invalid-foreign",
            first_send("invalid-foreign", "hello", Some(FOREIGN_AGENT), None, None),
        ),
        (
            "invalid-unknown",
            first_send(
                "invalid-unknown",
                "hello",
                Some("50000000-0000-4000-8000-000000000099"),
                None,
                None,
            ),
        ),
        (
            "invalid-terminated",
            first_send(
                "invalid-terminated",
                "hello",
                Some(TERMINATED_AGENT),
                None,
                None,
            ),
        ),
    ] {
        assert!(matches!(
            run(&database.pool, &actor, &request).await,
            Err(Error::Http(422, _))
        ));
        assert_eq!(counts(&database.pool, mutation).await, (0, 0, 0, 0, 0, 0));
    }

    let unsupported_plan = first_send_options(FirstSendOptions {
        mutation: "unsupported-plan",
        body: "hello",
        preferred_agent_id: None,
        model_override: None,
        effort_override: None,
        issue_creation_mode: None,
        plan_mode: Some(true),
        title: None,
    });
    assert!(matches!(
        run(&database.pool, &actor, &unsupported_plan).await,
        Err(Error::Http(422, _))
    ));
    assert_eq!(
        counts(&database.pool, "unsupported-plan").await,
        (0, 0, 0, 0, 0, 0)
    );

    let invalid_issue_mode = first_send_options(FirstSendOptions {
        mutation: "invalid-issue-mode",
        body: "hello",
        preferred_agent_id: None,
        model_override: None,
        effort_override: None,
        issue_creation_mode: Some("custom_mode"),
        plan_mode: None,
        title: None,
    });
    assert!(matches!(
        run(&database.pool, &actor, &invalid_issue_mode).await,
        Err(Error::Http(400, _))
    ));
    assert_eq!(
        counts(&database.pool, "invalid-issue-mode").await,
        (0, 0, 0, 0, 0, 0)
    );

    let no_membership_user = actor_as("no-membership", "user-without-membership", ORG);
    assert!(matches!(
        run(
            &database.pool,
            &no_membership_user,
            &first_send("no-membership", "must not persist", None, None, None)
        )
        .await,
        Err(Error::Http(403, _))
    ));
    assert_eq!(
        counts_for(&database.pool, "user-without-membership", "no-membership").await,
        (0, 0, 0, 0, 0, 0)
    );

    let original = first_send("changed-draft", "original", None, None, None);
    let accepted = run(&database.pool, &actor, &original)
        .await
        .expect("accept original");
    for changed in [
        first_send("changed-draft", "changed body", None, None, None),
        first_send(
            "changed-draft",
            "original",
            Some(TERMINATED_AGENT),
            None,
            None,
        ),
        first_send("changed-draft", "original", None, Some("gpt-custom"), None),
    ] {
        assert!(matches!(
            run(&database.pool, &actor, &changed).await,
            Err(Error::Http(409, _))
        ));
    }
    assert_eq!(
        counts(&database.pool, "changed-draft").await,
        (1, 1, 1, 1, 1, 1)
    );
    assert_eq!(accepted["idempotentReplay"], false);
}

#[tokio::test(flavor = "multi_thread")]
async fn first_send_preserves_supported_initial_settings_and_replays_them_exactly() {
    let database = Database::start().await;
    prepare(&database).await;
    let first_settings_actor = actor("first-settings");
    let request = first_send_options(FirstSendOptions {
        mutation: "first-settings-mutation",
        body: "hello with settings",
        preferred_agent_id: Some(CEO),
        model_override: Some("provider/custom-model"),
        effort_override: Some("high"),
        issue_creation_mode: Some("auto_create"),
        plan_mode: Some(false),
        title: Some("Initial title"),
    });
    let accepted = run(&database.pool, &first_settings_actor, &request)
        .await
        .expect("supported initial settings admitted");
    let persisted: (String, Option<String>, Option<String>, String, bool) = sqlx::query_as(
        "SELECT title, model_override, effort_override, issue_creation_mode, plan_mode
         FROM chat_conversations WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(accepted["conversationId"].as_str().unwrap())
    .fetch_one(&database.pool)
    .await
    .expect("read persisted initial settings");
    assert_eq!(
        persisted,
        (
            "Initial title".into(),
            Some("provider/custom-model".into()),
            Some("high".into()),
            "auto_create".into(),
            false,
        )
    );
    let retry = run(&database.pool, &actor("first-settings-retry"), &request)
        .await
        .expect("exact initial settings retry");
    assert_eq!(retry["idempotentReplay"], true);
    assert_eq!(retry["runId"], accepted["runId"]);
    assert!(matches!(
        run(
            &database.pool,
            &actor("first-settings-conflict"),
            &first_send_options(FirstSendOptions {
                mutation: "first-settings-mutation",
                body: "hello with settings",
                preferred_agent_id: Some(CEO),
                model_override: Some("provider/custom-model"),
                effort_override: Some("high"),
                issue_creation_mode: Some("manual_approval"),
                plan_mode: Some(false),
                title: Some("Initial title"),
            })
        )
        .await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(
        counts(&database.pool, "first-settings-mutation").await,
        (1, 1, 1, 1, 1, 1)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn first_send_budget_hard_stop_rolls_back_the_new_conversation_and_activity() {
    let database = Database::start().await;
    prepare(&database).await;
    sqlx::query(
        "INSERT INTO budget_policies
           (org_id, scope_type, scope_id, metric, window_kind, amount, hard_stop_enabled, is_active)
         VALUES ($1::uuid, 'organization', $1::uuid, 'billed_cents', 'lifetime', 1, true, true)",
    )
    .bind(ORG)
    .execute(&database.pool)
    .await
    .expect("seed first-send hard stop");
    sqlx::query(
        "INSERT INTO cost_events (org_id, agent_id, provider, model, cost_cents, occurred_at)
         VALUES ($1::uuid, $2::uuid, 'test', 'test', 1, now())",
    )
    .bind(ORG)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("seed cost at hard stop");

    let error = run(
        &database.pool,
        &actor("first-send-budget-stop"),
        &first_send("first-send-budget-stop", "must roll back", None, None, None),
    )
    .await;
    assert!(matches!(error, Err(Error::Http(409, _))));
    assert_eq!(
        counts(&database.pool, "first-send-budget-stop").await,
        (0, 0, 0, 0, 0, 0)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn first_send_serializes_concurrent_duplicate_and_rolls_back_conversation_on_late_failure() {
    let database = Database::start().await;
    prepare(&database).await;
    let request = first_send("concurrent-first", "hello once", None, None, None);
    let actor_a = actor("concurrent-a");
    let actor_b = actor("concurrent-b");
    let (left, right) = tokio::join!(
        run(&database.pool, &actor_a, &request),
        run(&database.pool, &actor_b, &request),
    );
    let left = left.expect("first concurrent request");
    let right = right.expect("second concurrent request");
    assert_eq!(left["conversationId"], right["conversationId"]);
    assert_eq!(left["runId"], right["runId"]);
    assert_ne!(left["idempotentReplay"], right["idempotentReplay"]);
    assert_eq!(
        counts(&database.pool, "concurrent-first").await,
        (1, 1, 1, 1, 1, 1)
    );

    database
        .sql(
            "CREATE FUNCTION fail_first_send_activity() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN
               IF NEW.action='chat.message_added' THEN RAISE EXCEPTION 'synthetic first-send activity failure'; END IF;
               RETURN NEW;
             END; $$;
             CREATE TRIGGER fail_first_send_activity_trigger BEFORE INSERT ON activity_log
             FOR EACH ROW EXECUTE FUNCTION fail_first_send_activity();",
        )
        .await;
    let failure = run(
        &database.pool,
        &actor("first-send-rollback"),
        &first_send("rollback-first", "rollback all", None, None, None),
    )
    .await;
    assert!(matches!(failure, Err(Error::Database(_))));
    database
        .sql("DROP TRIGGER fail_first_send_activity_trigger ON activity_log; DROP FUNCTION fail_first_send_activity();")
        .await;
    assert_eq!(
        counts(&database.pool, "rollback-first").await,
        (0, 0, 0, 0, 0, 0)
    );
    let binding_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM runtime_bindings WHERE org_id=$1::uuid AND target_id IN
           (SELECT id::text FROM chat_conversations WHERE org_id=$1::uuid AND initial_client_mutation_id='rollback-first')",
    )
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .expect("count rolled-back bindings");
    assert_eq!(binding_count, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn first_send_never_claims_legacy_initial_key_without_native_receipt() {
    let database = Database::start().await;
    prepare(&database).await;
    let actor = actor("legacy-first-key");
    database
        .sql(&format!(
            "INSERT INTO chat_conversations(org_id,id,title,conversation_kind,created_by_user_id,preferred_agent_id,initial_client_mutation_id)
             VALUES ('{ORG}'::uuid,'21000000-0000-4000-8000-000000000991'::uuid,'Legacy','chat','{USER}','{CEO}'::uuid,'legacy-first-key')
             ; INSERT INTO chat_messages(org_id,conversation_id,role,kind,status,body)
             VALUES ('{ORG}'::uuid,'21000000-0000-4000-8000-000000000991'::uuid,'user','message','completed','legacy body');"
        ))
        .await;
    let before: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM chat_conversations WHERE org_id=$1::uuid AND initial_client_mutation_id='legacy-first-key'),
                (SELECT count(*) FROM chat_messages WHERE org_id=$1::uuid AND conversation_id='21000000-0000-4000-8000-000000000991'::uuid)",
    )
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .expect("count legacy initial key");
    assert_eq!(before, (1, 1));
    assert!(matches!(
        run(
            &database.pool,
            &actor,
            &first_send("legacy-first-key", "legacy body", None, None, None)
        )
        .await,
        Err(Error::Http(409, _))
    ));
    let after: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM chat_conversations WHERE org_id=$1::uuid AND initial_client_mutation_id='legacy-first-key'),
                (SELECT count(*) FROM chat_messages WHERE org_id=$1::uuid AND conversation_id='21000000-0000-4000-8000-000000000991'::uuid)",
    )
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .expect("count after rejected legacy collision");
    assert_eq!(after, before);
}
