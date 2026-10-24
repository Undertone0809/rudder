use super::*;

#[tokio::test(flavor = "multi_thread")]
async fn first_claim_refuses_preassigned_model_without_partial_claim() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    let (actor, run, attempt) = prepare(&database, &host).await;
    let mut tx = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE heartbeat_run_attempts SET model='vendor/preassigned' WHERE id=$1::uuid")
        .bind(&attempt)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_conflict(claim(&database.pool, &actor, ORG, &run, &attempt, host.context()).await);
    let state: (bool, bool, Option<String>, i64) = sqlx::query_as(
        "SELECT r.native_admission_hold,g.native_admission_hold,g.control_owner_token,
        (SELECT count(*) FROM run_runtime_spans WHERE run_id=r.id)
        FROM heartbeat_runs r JOIN chat_generations g ON g.id=r.chat_generation_id WHERE r.id=$1::uuid")
        .bind(&run).fetch_one(&database.pool).await.unwrap();
    assert_eq!(state, (false, false, None, 0));
}

#[tokio::test(flavor = "multi_thread")]
async fn first_claim_is_org_scoped_distinct_and_never_adopts_an_existing_owner() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    let (actor, run_id, attempt_id) = prepare(&database, &host).await;
    let claimed = claim(
        &database.pool,
        &actor,
        ORG,
        &run_id,
        &attempt_id,
        host.context(),
    )
    .await
    .expect("claim first owner");
    assert_eq!(claimed.config.identity.agent_id, CEO);
    assert_eq!(claimed.config.identity.host_id, host.context().host_id());
    assert_eq!(claimed.config.identity.runtime_type, "codex_local");
    assert_eq!(claimed.config.model.as_deref(), Some("gpt-5.6-luna"));
    assert_eq!(claimed.config.cwd, host.cwd);
    assert_eq!(claimed.config.executable, host.executable);
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    assert_eq!(
        claimed.config.instruction_content.as_deref(),
        Some("isolated test instructions")
    );
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    assert!(claimed.config.instruction_content.is_none());
    assert!(
        claimed
            .config
            .identity
            .instructions_revision
            .starts_with("sha256:")
    );
    let fence = claimed.fence;
    let identity = fence.identity();
    assert_eq!(identity.run_id, run_id);
    assert_eq!(identity.attempt_id, attempt_id);
    assert_eq!(identity.generation_attempt_epoch, 1);
    assert_eq!(identity.run_attempt_epoch, 1);
    assert_eq!(identity.connection_epoch, 1);
    assert_ne!(
        fence.generation_control_owner_token(),
        fence.run_execution_owner_token()
    );
    let debug = format!("{fence:?}");
    assert!(!debug.contains(fence.generation_control_owner_token()));
    assert!(!debug.contains(fence.run_execution_owner_token()));

    let holds: (bool, bool, String, Option<String>) = sqlx::query_as(
        "SELECT g.native_admission_hold, r.native_admission_hold, g.control_state, g.control_owner_token
         FROM chat_generations g JOIN heartbeat_runs r
           ON r.org_id=g.org_id AND r.chat_generation_id=g.id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read first claim");
    assert_eq!(
        (holds.0, holds.1, holds.2.as_str()),
        (true, true, "unregistered")
    );
    assert_eq!(
        holds.3.as_deref(),
        Some(fence.generation_control_owner_token())
    );

    assert_conflict(
        claim(
            &database.pool,
            &actor,
            ORG,
            &run_id,
            &attempt_id,
            host.context(),
        )
        .await,
    );
    let foreign_actor = verified_actor(OTHER, USER, "foreign");
    assert!(matches!(
        claim(
            &database.pool,
            &foreign_actor,
            ORG,
            &run_id,
            &attempt_id,
            host.context(),
        )
        .await,
        Err(Error::Http(403, _))
    ));

    let before: (i64, i64) = sqlx::query_as(
        "SELECT floor(extract(epoch FROM g.control_lease_expires_at) * 1000)::bigint,
                floor(extract(epoch FROM r.execution_lease_expires_at) * 1000)::bigint
         FROM chat_generations g JOIN heartbeat_runs r
           ON r.org_id=g.org_id AND r.chat_generation_id=g.id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read claim leases");
    let renewed = renew_lease(&database.pool, &actor, &fence)
        .await
        .expect("renew both live leases");
    assert!(renewed.generation_expires_at_unix_ms() > before.0);
    assert!(renewed.run_expires_at_unix_ms() > before.1);
    let audit_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid
         AND action='runtime.native_chat.execution_claimed' AND entity_id=$2",
    )
    .bind(ORG)
    .bind(identity.generation_id)
    .fetch_one(&database.pool)
    .await
    .expect("read claim activity audit");
    assert_eq!(audit_count, 1, "duplicate claim must not duplicate audit");
}

#[tokio::test(flavor = "multi_thread")]
async fn unsupported_config_changed_after_admission_leaves_claim_unmodified() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    let (actor, run_id, attempt_id) = prepare(&database, &host).await;

    let secret = "changed-config-test-secret";
    sqlx::query(
        "UPDATE agents SET agent_runtime_config=$1::jsonb
         WHERE org_id=$2::uuid AND id=$3::uuid",
    )
    .bind(json!({"env":{"TOKEN":secret},"search":false}).to_string())
    .bind(ORG)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("change persisted runtime config after Run admission");

    match claim(
        &database.pool,
        &actor,
        ORG,
        &run_id,
        &attempt_id,
        host.context(),
    )
    .await
    {
        Err(Error::Http(409, message)) => assert!(!message.contains(secret)),
        Err(Error::Http(status, _)) => panic!("expected config conflict, got HTTP {status}"),
        Err(Error::Database(error)) => {
            panic!("expected config conflict, got database error: {error}")
        }
        Ok(_) => panic!("unsupported changed runtime config was claimed"),
    }

    let state: (bool, bool, Option<String>, bool) = sqlx::query_as(
        "SELECT g.native_admission_hold, r.native_admission_hold,
                g.control_owner_token, g.control_lease_expires_at IS NOT NULL
         FROM chat_generations g JOIN heartbeat_runs r
           ON r.org_id=g.org_id AND r.chat_generation_id=g.id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read claim state after rejected config");
    assert_eq!(state, (false, false, None, false));

    let audit_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log
         WHERE org_id=$1::uuid AND action='runtime.native_chat.execution_claimed'
           AND entity_id=(SELECT chat_generation_id::text FROM heartbeat_runs
                          WHERE org_id=$1::uuid AND id=$2::uuid)",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read audit after rejected config");
    assert_eq!(
        audit_count, 0,
        "rejected config must not create claim audit"
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn hermes_adapter_events_and_tools_are_fenced_from_admission_through_claim() {
    let database = Database::start().await;
    let host = HermesExecutionHost::new();
    let (actor, run_id, attempt_id) =
        prepare_hermes(&database, &host, CHAT, "hermes-revision-a").await;
    let admitted_revision: String = sqlx::query_scalar(
        "SELECT context_snapshot->>'hermesInstructionAdapterRevision'
         FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read immutable Hermes adapter revision");
    assert!(admitted_revision.starts_with("hermes-instruction-v1:"));

    // These two source files are intentionally excluded from the persisted
    // six-file segment binding, but included in the exact launch revision.
    host.change_event_and_tool_sources();
    let changed = claim(
        &database.pool,
        &actor,
        ORG,
        &run_id,
        &attempt_id,
        host.context(),
    )
    .await;
    match changed {
        Err(Error::Http(409, message)) => {
            assert!(message.contains("retry this message as a new turn"));
        }
        Err(Error::Http(status, _)) => panic!("expected adapter conflict, got HTTP {status}"),
        Err(Error::Database(error)) => panic!("expected adapter conflict, got {error}"),
        Ok(_) => panic!("changed Hermes event/tool source was claimed"),
    }
    let rejected_state: (bool, bool, Option<String>, i64) = sqlx::query_as(
        "SELECT r.native_admission_hold,g.native_admission_hold,g.control_owner_token,
         (SELECT count(*) FROM run_runtime_spans WHERE run_id=r.id)
         FROM heartbeat_runs r JOIN chat_generations g ON g.id=r.chat_generation_id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read state after adapter mismatch");
    assert_eq!(rejected_state, (false, false, None, 0));

    // A fresh Run admitted against the changed files captures their new full
    // revision and remains claimable, proving the failure was the admission
    // fence rather than a permanent rejection of the updated adapter.
    let fresh_database = Database::start().await;
    let (fresh_actor, fresh_run_id, fresh_attempt_id) = prepare_hermes(
        &fresh_database,
        &host,
        "21000000-0000-4000-8000-000000000202",
        "hermes-revision-b",
    )
    .await;
    let fresh_revision: String = sqlx::query_scalar(
        "SELECT context_snapshot->>'hermesInstructionAdapterRevision'
         FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&fresh_run_id)
    .fetch_one(&fresh_database.pool)
    .await
    .expect("read fresh Hermes adapter revision");
    assert_ne!(fresh_revision, admitted_revision);
    let claimed = claim(
        &fresh_database.pool,
        &fresh_actor,
        ORG,
        &fresh_run_id,
        &fresh_attempt_id,
        host.context(),
    )
    .await
    .expect("fresh admission must accept the current Hermes adapter");
    assert_eq!(claimed.config.identity.runtime_type, "hermes_local");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn legacy_pending_hermes_run_without_adapter_revision_fails_closed() {
    let database = Database::start().await;
    let host = HermesExecutionHost::new();
    let (actor, run_id, attempt_id) =
        prepare_hermes(&database, &host, CHAT, "hermes-revision-missing").await;
    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin legacy fixture update");
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test',true)")
        .execute(&mut *tx)
        .await
        .expect("mark legacy fixture transaction");
    sqlx::query(
        "UPDATE heartbeat_runs
         SET context_snapshot=context_snapshot-'hermesInstructionAdapterRevision'
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .execute(&mut *tx)
    .await
    .expect("model a pending Run admitted before revision pinning");
    tx.commit().await.expect("commit legacy fixture");

    match claim(
        &database.pool,
        &actor,
        ORG,
        &run_id,
        &attempt_id,
        host.context(),
    )
    .await
    {
        Err(Error::Http(409, message)) => {
            assert!(message.contains("retry this message as a new turn"));
        }
        Err(Error::Http(status, _)) => {
            panic!("expected legacy revision conflict, got HTTP {status}")
        }
        Err(Error::Database(error)) => panic!("expected legacy revision conflict, got {error}"),
        Ok(_) => panic!("pending Hermes Run without a pinned revision was claimed"),
    }
    let state: (bool, bool, Option<String>, i64) = sqlx::query_as(
        "SELECT r.native_admission_hold,g.native_admission_hold,g.control_owner_token,
         (SELECT count(*) FROM run_runtime_spans WHERE run_id=r.id)
         FROM heartbeat_runs r JOIN chat_generations g ON g.id=r.chat_generation_id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read state after legacy revision rejection");
    assert_eq!(state, (false, false, None, 0));
}

#[cfg(unix)]
struct HermesExecutionHost {
    _root: TempDir,
    context: LocalHostContext,
    events_source: PathBuf,
    tools_source: PathBuf,
}

#[cfg(unix)]
impl HermesExecutionHost {
    fn new() -> Self {
        const WRAPPER: &str = "#!/bin/sh\n'''exec' \"$(dirname -- \"$(realpath -- \"$0\")\")\"/'python3' \"$0\" \"$@\"\n' '''\n# -*- coding: utf-8 -*-\nimport sys\nfrom hermes_cli.main import main\nif __name__ == \"__main__\":\n";

        let root = tempfile::tempdir().expect("create isolated Hermes host tree");
        let instance = root.path().join("instance");
        let workspace_home = root.path().join("workspaces");
        let previous_documents = root.path().join("previous-documents");
        let managed_profiles = root.path().join("managed-profiles");
        let profile_home = root.path().join("hermes-profiles");
        let operator_home = root.path().join("operator-home");
        let codex_executable = root.path().join("bin/codex");
        let hermes_root = root.path().join("hermes-install");
        let hermes_bin = hermes_root.join("venv/bin");
        let hermes_executable = hermes_bin.join("hermes");
        let python_executable = hermes_bin.join("python3");
        for directory in [
            &instance,
            &workspace_home,
            &previous_documents,
            &managed_profiles,
            &profile_home,
            &operator_home,
            codex_executable.parent().expect("Codex bin directory"),
            &hermes_bin,
            &hermes_root.join("hermes_cli"),
            &hermes_root.join("acp_adapter"),
            &hermes_root.join("agent"),
            &workspace_home.join("100000000000/workspaces/agents/hermes-agent"),
        ] {
            fs::create_dir_all(directory).expect("create fixture directory");
        }
        fs::write(&codex_executable, b"fake codex executable").expect("write Codex fixture");
        fs::write(&hermes_executable, WRAPPER).expect("write Hermes launcher fixture");
        fs::write(&python_executable, b"fake Python executable").expect("write Python fixture");
        let events_source = hermes_root.join("acp_adapter/events.py");
        let tools_source = hermes_root.join("acp_adapter/tools.py");
        for (path, contents) in [
            (&hermes_root.join("hermes_bootstrap.py"), "bootstrap\n"),
            (
                &hermes_root.join("hermes_cli/__init__.py"),
                "__version__ = \"0.21.0\"\n",
            ),
            (&hermes_root.join("acp_adapter/entry.py"), "entry\n"),
            (&events_source, "event formatter v1\n"),
            (&tools_source, "tool formatter v1\n"),
            (&hermes_root.join("acp_adapter/session.py"), "session\n"),
            (&hermes_root.join("agent/agent_init.py"), "agent init\n"),
            (
                &hermes_root.join("agent/chat_completion_helpers.py"),
                "completion\n",
            ),
        ] {
            fs::write(path, contents).expect("write Hermes source fixture");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for executable in [&codex_executable, &hermes_executable, &python_executable] {
                fs::set_permissions(executable, fs::Permissions::from_mode(0o755))
                    .expect("mark executable fixture");
            }
        }
        let codex_executable = codex_executable
            .canonicalize()
            .expect("canonical Codex fixture");
        let context = LocalHostContext::from_rust_host(
            "hermes-revision-test-host".into(),
            instance,
            workspace_home,
            previous_documents,
            false,
            managed_profiles,
            operator_home,
            codex_executable,
        )
        .expect("construct trusted host context")
        .with_executable_search_path(
            std::env::join_paths([PathBuf::from("/usr/bin"), PathBuf::from("/bin")])
                .expect("trusted search path")
                .to_string_lossy()
                .into_owned(),
        )
        .expect("trust Hermes executable search path")
        .with_hermes_runtime(hermes_executable, profile_home)
        .expect("attach trusted Hermes installation");
        Self {
            _root: root,
            context,
            events_source,
            tools_source,
        }
    }

    fn context(&self) -> &LocalHostContext {
        &self.context
    }

    fn change_event_and_tool_sources(&self) {
        fs::write(&self.events_source, "event formatter v2\n")
            .expect("change Hermes event formatter fixture");
        fs::write(&self.tools_source, "tool formatter v2\n")
            .expect("change Hermes tool formatter fixture");
    }
}

#[cfg(unix)]
async fn prepare_hermes(
    database: &Database,
    host: &HermesExecutionHost,
    conversation_id: &str,
    mutation_id: &str,
) -> (VerifiedActor, String, String) {
    sqlx::query(
        "INSERT INTO organization_memberships(org_id, principal_type, principal_id, membership_role, status)
         VALUES ($1::uuid, 'user', $2, 'member', 'active')",
    )
    .bind(ORG)
    .bind(USER)
    .execute(&database.pool)
    .await
    .expect("seed Hermes test membership");
    sqlx::query(
        "UPDATE agents SET agent_runtime_type='hermes_local', status='idle',
           workspace_key='hermes-agent', agent_runtime_config=$1::jsonb
         WHERE org_id=$2::uuid AND id=$3::uuid",
    )
    .bind(json!({"profileId":"default","model":"gpt-5.6-luna"}).to_string())
    .bind(ORG)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("persist Hermes runtime fixture");
    sqlx::query(
        "INSERT INTO chat_conversations
           (id, org_id, title, conversation_kind, created_by_user_id, status, preferred_agent_id)
         VALUES ($1::uuid, $2::uuid, 'Hermes revision fixture', 'chat', $3, 'active', $4::uuid)",
    )
    .bind(conversation_id)
    .bind(ORG)
    .bind(USER)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("seed Hermes ordinary Chat conversation");

    let actor = verified_actor(ORG, USER, mutation_id);
    let admission: AdmissionRequest = serde_json::from_value(json!({
        "operation":"submit_native_chat_turn",
        "conversationId":conversation_id,
        "clientMutationId":mutation_id,
        "body":"verify the Hermes launch revision fence",
    }))
    .expect("valid Hermes admission request");
    let receipt = execute(&database.pool, &actor, ORG, &admission, host.context())
        .await
        .expect("admit Hermes Native Chat turn");
    (
        actor,
        receipt["runId"].as_str().unwrap().to_owned(),
        receipt["attemptId"].as_str().unwrap().to_owned(),
    )
}
