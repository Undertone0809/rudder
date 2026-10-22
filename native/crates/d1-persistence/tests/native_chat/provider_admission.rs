use super::*;
use rudder_runtime_core::native_chat::{
    ClaudeSessionSelector, CursorSessionSelector, NativeChatProtocolCheckpoint,
    NativeChatProtocolPhase, OpenCodeSessionSelector, PiSessionSelector,
};
use serde_json::Value;
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use tempfile::TempDir;

const PROFILE: &str = "admission-profile";
const PI_SESSION: &str = "pi-admission-session";
const PI_LEAF: &str = "a1b2c3d4";
const PI_NEXT_LEAF: &str = "d4c3b2a1";

#[tokio::test(flavor = "multi_thread")]
async fn native_first_input_requires_its_provider_checkpoint_and_one_use_permit() {
    use rudder_d1_persistence::native_chat::execution::{
        self, CheckpointTransition as T, EffectDispatch,
    };
    let database = Database::start().await;
    prepare(&database).await;
    sqlx::query("INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES($1,'Native input fixture','native-input@example.test',now(),now())")
        .bind(USER).execute(&database.pool).await.unwrap();
    let host = ProviderHost::new();
    let actor = verified_actor(USER, "provider-input-order");
    for (index, provider) in [Provider::Claude, Provider::Cursor, Provider::OpenCode]
        .into_iter()
        .enumerate()
    {
        let chat = format!("21000000-0000-4000-8000-0000000009{:02}", index);
        seed_chat(&database.pool, &chat).await;
        configure_agent(&database.pool, CEO, provider, "provider-admission-ceo").await;
        let admitted = admit(
            &database.pool,
            &actor,
            &host,
            &chat,
            &format!("input-order-{index}"),
        )
        .await
        .unwrap();
        let rows = run_rows(&database.pool, &admitted).await;
        let claimed = execution::claim(
            &database.pool,
            &actor,
            ORG,
            &rows.run_id,
            &rows.attempt_id,
            &host.context,
        )
        .await
        .unwrap();
        let (principal, fence, _, _launch) = claimed.into_execution_parts();
        match execution::load_submission(&database.pool, &principal, &fence).await {
            Err(Error::Http(409, _)) => {}
            Err(error) => panic!("unexpected pre-session load denial: {error}"),
            Ok(_) => panic!("ordinary load must remain closed before a native session"),
        }
        if matches!(provider, Provider::Claude) {
            let effect =
                execution::prepare_claude_combined_input(&database.pool, &principal, &fence)
                    .await
                    .unwrap();
            let sent = effect
                .dispatch(|payload| match payload {
                    EffectDispatch::SubmitClaudeCombinedInput {
                        session_id: None,
                        body,
                        ..
                    } => body == "fixture-only admission input",
                    _ => false,
                })
                .unwrap();
            assert!(sent);
            assert!(
                matches!(
                    execution::prepare_claude_combined_input(&database.pool, &principal, &fence)
                        .await,
                    Err(Error::Http(409, _))
                ),
                "reading a pending combined checkpoint cannot recreate a send permit"
            );
            let snapshot = execution::current_checkpoint(&database.pool, &principal, &fence)
                .await
                .unwrap();
            assert_eq!(
                snapshot.phase,
                NativeChatProtocolPhase::ThreadStartIndeterminate
            );
            assert!(
                snapshot.claude_session.is_none(),
                "no generated ID becomes a provider session"
            );
            continue;
        }
        let start = match provider {
            Provider::Cursor => T::PrepareCursorSessionStart,
            _ => T::PrepareOpenCodeSessionStart,
        };
        let mut receipt = execution::advance_checkpoint(
            &database.pool,
            &principal,
            &fence,
            NativeChatProtocolPhase::NoThreadRequest,
            0,
            start,
        )
        .await
        .unwrap();
        let effect = execution::authorize_effect(
            &database.pool,
            &principal,
            receipt.take_effect_permit().unwrap(),
            None,
        )
        .await
        .unwrap();
        assert!(
            effect
                .dispatch(|payload| matches!(
                    payload,
                    EffectDispatch::StartCursorSession | EffectDispatch::StartOpenCodeSession
                ))
                .unwrap()
        );
        let record = match provider {
            Provider::Cursor => T::RecordCursorSession {
                session_id: provider.session_id().into(),
            },
            _ => T::RecordOpenCodeSession {
                session_id: provider.session_id().into(),
            },
        };
        let recorded = execution::advance_checkpoint(
            &database.pool,
            &principal,
            &fence,
            receipt.snapshot().phase,
            receipt.snapshot().revision,
            record,
        )
        .await
        .unwrap();
        let segment: (String, Option<String>) =
            sqlx::query_as("SELECT state,native_session_id FROM native_segments WHERE id=$1::uuid")
                .bind(&rows.segment_id)
                .fetch_one(&database.pool)
                .await
                .unwrap();
        assert_eq!(segment, ("open".into(), Some(provider.session_id().into())));
        let prepared = execution::advance_checkpoint(
            &database.pool,
            &principal,
            &fence,
            recorded.snapshot().phase,
            recorded.snapshot().revision,
            T::PrepareInput,
        )
        .await
        .unwrap();
        let input = execution::load_submission(&database.pool, &principal, &fence)
            .await
            .unwrap();
        let mark = match provider {
            Provider::Cursor => T::MarkCursorInputIndeterminate {
                request_id: "request-one".into(),
            },
            _ => T::MarkOpenCodeInputIndeterminate {
                request_id: "msg_request_one".into(),
            },
        };
        let mut marked = execution::advance_checkpoint(
            &database.pool,
            &principal,
            &fence,
            prepared.snapshot().phase,
            prepared.snapshot().revision,
            mark,
        )
        .await
        .unwrap();
        let effect = execution::authorize_effect(
            &database.pool,
            &principal,
            marked.take_effect_permit().unwrap(),
            Some(input),
        )
        .await
        .unwrap();
        assert!(
            effect
                .dispatch(|payload| match payload {
                    EffectDispatch::SubmitCursorInput {
                        session_id, body, ..
                    }
                    | EffectDispatch::SubmitOpenCodeInput {
                        session_id, body, ..
                    } =>
                        session_id == provider.session_id()
                            && body == "fixture-only admission input",
                    _ => false,
                })
                .unwrap()
        );
        assert!(matches!(
            execution::load_submission(&database.pool, &principal, &fence).await,
            Err(Error::Http(409, _))
        ));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_between_native_session_response_and_record_cannot_submit_input() {
    use rudder_d1_persistence::native_chat::{
        control::{self, StopRequest},
        execution::{self, CheckpointTransition as T},
    };
    use sha2::{Digest, Sha256};
    let database = Database::start().await;
    prepare(&database).await;
    sqlx::query("INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES($1,'Native input fixture','native-input@example.test',now(),now())")
        .bind(USER).execute(&database.pool).await.unwrap();
    let host = ProviderHost::new();
    let actor = verified_actor(USER, "provider-stop-before-record");
    let chat = "21000000-0000-4000-8000-000000000910";
    seed_chat(&database.pool, chat).await;
    configure_agent(
        &database.pool,
        CEO,
        Provider::Cursor,
        "provider-admission-ceo",
    )
    .await;
    let admitted = admit(&database.pool, &actor, &host, chat, "stop-before-record")
        .await
        .unwrap();
    let rows = run_rows(&database.pool, &admitted).await;
    let claimed = execution::claim(
        &database.pool,
        &actor,
        ORG,
        &rows.run_id,
        &rows.attempt_id,
        &host.context,
    )
    .await
    .unwrap();
    let (principal, fence, _, _launch) = claimed.into_execution_parts();
    let receipt = execution::advance_checkpoint(
        &database.pool,
        &principal,
        &fence,
        NativeChatProtocolPhase::NoThreadRequest,
        0,
        T::PrepareCursorSessionStart,
    )
    .await
    .unwrap();
    control::request_stop(
        &database.pool,
        &actor,
        &StopRequest {
            conversation_id: chat.into(),
            generation_id: rows.generation_id.clone(),
            control_action_id: unique_id("stop-before-record"),
            expected_attempt_epoch: 1,
            expected_control_version: 0,
            requested_render_seq: 0,
            requested_body_hash: format!("{:x}", Sha256::digest(b"")),
        },
    )
    .await
    .unwrap();
    assert!(matches!(
        execution::advance_checkpoint(
            &database.pool,
            &principal,
            &fence,
            receipt.snapshot().phase,
            receipt.snapshot().revision,
            T::RecordCursorSession {
                session_id: "actual-provider-session".into()
            }
        )
        .await,
        Err(Error::Http(409, _))
    ));
    assert!(
        execution::load_submission(&database.pool, &principal, &fence)
            .await
            .is_err()
    );
    let state: (bool, bool, Option<String>) = sqlx::query_as("SELECT r.native_admission_hold,g.native_admission_hold,s.native_session_id FROM heartbeat_runs r JOIN chat_generations g ON g.id=r.chat_generation_id JOIN native_segments s ON s.id=$2::uuid WHERE r.id=$1::uuid")
        .bind(&rows.run_id).bind(&rows.segment_id).fetch_one(&database.pool).await.unwrap();
    assert_eq!(
        state,
        (true, true, None),
        "ambiguous session start stays held and no prompt is authorized"
    );
}

#[derive(Clone, Copy)]
enum Provider {
    Claude,
    Cursor,
    OpenCode,
    Pi,
}

impl Provider {
    fn runtime(self) -> &'static str {
        match self {
            Self::Claude => "claude_local",
            Self::Cursor => "cursor",
            Self::OpenCode => "opencode_local",
            Self::Pi => "pi_local",
        }
    }

    fn checkpoint_provider(self) -> &'static str {
        match self {
            Self::Claude => "claude_local",
            Self::Cursor => "cursor_local",
            Self::OpenCode => "open_code_local",
            Self::Pi => "pi_local",
        }
    }

    fn profile_ref(self, agent: &str) -> String {
        match self {
            Self::Claude => format!("claude-local:{agent}:{PROFILE}"),
            Self::Cursor => format!("cursor-local:{agent}:{PROFILE}"),
            Self::OpenCode => format!("managed-opencode:{agent}:default"),
            Self::Pi => format!("managed-pi:{agent}:{PROFILE}"),
        }
    }

    fn session_id(self) -> &'static str {
        match self {
            Self::Claude => "7e5f5d5a-1e4a-4ce2-8e31-223344556677",
            Self::Cursor => "cursor-admission-session",
            Self::OpenCode => "ses_admission_session",
            Self::Pi => PI_SESSION,
        }
    }

    fn runtime_config(self) -> Value {
        match self {
            Self::Claude => json!({"profileId":PROFILE,"model":"fixture-model"}),
            Self::Cursor => json!({"profileId":PROFILE,"model":"fixture-model"}),
            Self::OpenCode => json!({
                "profileId":"default",
                "model":"fixture-provider/fixture-model"
            }),
            Self::Pi => json!({"profileId":PROFILE,"model":"fixture-provider/fixture-model"}),
        }
    }
}

struct ProviderHost {
    _root: TempDir,
    context: LocalHostContext,
    pi_session_file: PathBuf,
}

impl ProviderHost {
    fn new() -> Self {
        Self::with_opencode_owned(true)
    }

    fn with_opencode_owned(owned: bool) -> Self {
        let root = tempfile::tempdir().expect("create isolated provider admission host");
        let instance = root.path().join("instance");
        let workspace_home = root.path().join("workspaces");
        let previous_documents = root.path().join("previous-documents");
        let managed_profiles = root.path().join("managed-profiles");
        let operator_home = root.path().join("operator-home");
        let binaries = root.path().join("bin");
        let cwd = root.path().join("cwd");
        let claude_profiles = root.path().join("claude-profiles");
        let cursor_profiles = root.path().join("cursor-profiles");
        let pi_profiles = root.path().join("pi-profiles");
        let workspace_key = compact_org_key(ORG);
        let workspace_ceo = workspace_home
            .join(&workspace_key)
            .join("workspaces/agents/provider-admission-ceo");
        let workspace_other = workspace_home
            .join(&workspace_key)
            .join("workspaces/agents/provider-admission-other");
        let codex = binaries.join("codex");
        let claude = binaries.join("claude");
        let cursor = binaries.join("cursor-agent");
        let node = binaries.join("node");
        let pi_cli = binaries.join("pi-entry.cjs");

        for directory in [
            &instance,
            &workspace_ceo,
            &workspace_other,
            &previous_documents,
            &managed_profiles,
            &managed_profiles
                .join("opencode")
                .join(ORG)
                .join(CEO)
                .join("default"),
            &managed_profiles
                .join("opencode")
                .join(ORG)
                .join(WRONG_AGENT)
                .join("default"),
            &operator_home,
            &binaries,
            &cwd,
            &claude_profiles,
            &cursor_profiles,
            &pi_profiles,
            &claude_profiles
                .join("profiles")
                .join(PROFILE)
                .join(".claude"),
            &cursor_profiles
                .join("profiles")
                .join(PROFILE)
                .join(".cursor"),
            &pi_profiles
                .join(ORG)
                .join(CEO)
                .join(PROFILE)
                .join(".pi/agent"),
            &pi_profiles
                .join(ORG)
                .join(WRONG_AGENT)
                .join(PROFILE)
                .join(".pi/agent"),
        ] {
            fs::create_dir_all(directory).expect("create provider fixture directory");
        }
        for binary in [&codex, &claude, &cursor, &node, &pi_cli] {
            fs::write(binary, b"fixture executable; never launched")
                .expect("write inert provider fixture");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(binary, fs::Permissions::from_mode(0o755))
                    .expect("mark inert executable");
            }
        }

        let pi_session_file = pi_profiles
            .join(ORG)
            .join(CEO)
            .join(PROFILE)
            .join(".pi/sessions/provider-admission.jsonl");
        let context = LocalHostContext::from_rust_host(
            "provider-admission-test-host".into(),
            instance,
            workspace_home,
            previous_documents,
            false,
            managed_profiles,
            operator_home,
            codex,
        )
        .expect("construct trusted synthetic host")
        .with_executable_search_path("/usr/bin:/bin".into())
        .expect("bind trusted executable search path")
        .with_claude_runtime(claude, claude_profiles)
        .expect("attach inert Claude installation")
        .with_cursor_runtime(cursor, cursor_profiles)
        .expect("attach inert Cursor installation")
        .with_pi_runtime(node, pi_cli, pi_profiles)
        .expect("attach inert Pi installation")
        .with_opencode_runtime(
            url::Url::parse("http://127.0.0.1:48123/").expect("valid inert OpenCode endpoint"),
            None,
        )
        .expect("attach non-contacted OpenCode endpoint");
        let context = if owned {
            let executable = context.codex_executable().to_path_buf();
            context.with_opencode_executable(executable).unwrap()
        } else {
            context
        };

        Self {
            _root: root,
            context,
            pi_session_file,
        }
    }

    fn session_file(&self) -> String {
        self.pi_session_file.to_string_lossy().into_owned()
    }
}

fn compact_org_key(org: &str) -> String {
    org.chars()
        .filter(|character| *character != '-')
        .take(12)
        .collect::<String>()
        .to_ascii_lowercase()
}

fn unique_id(label: &str) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_OID,
        format!(
            "native-chat-provider-admission:{label}:{}",
            NEXT.fetch_add(1, Ordering::Relaxed)
        )
        .as_bytes(),
    )
    .to_string()
}

async fn configure_agent(pool: &PgPool, agent_id: &str, runtime: Provider, workspace_key: &str) {
    sqlx::query(
        "UPDATE agents SET agent_runtime_type=$1, status='idle', workspace_key=$2,
           agent_runtime_config=$3::jsonb WHERE org_id=$4::uuid AND id=$5::uuid",
    )
    .bind(runtime.runtime())
    .bind(workspace_key)
    .bind(runtime.runtime_config().to_string())
    .bind(ORG)
    .bind(agent_id)
    .execute(pool)
    .await
    .expect("select fixture Agent runtime");
}

async fn admit(
    pool: &PgPool,
    actor: &VerifiedActor,
    host: &ProviderHost,
    chat: &str,
    mutation: &str,
) -> Result<Value, Error> {
    execute_native(
        pool,
        actor,
        ORG,
        &request(chat, mutation, "fixture-only admission input"),
        &host.context,
    )
    .await
}

#[derive(Clone)]
struct RunRows {
    run_id: String,
    attempt_id: String,
    generation_id: String,
    segment_id: String,
}

async fn run_rows(pool: &PgPool, receipt: &Value) -> RunRows {
    let run_id = receipt["runId"].as_str().expect("Run id").to_owned();
    let attempt_id = receipt["attemptId"]
        .as_str()
        .expect("Attempt id")
        .to_owned();
    let (generation_id, segment_id): (String, String) = sqlx::query_as(
        "SELECT r.chat_generation_id::text, r.context_snapshot->>'nativeSegmentId'
         FROM heartbeat_runs r WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(pool)
    .await
    .expect("read admitted generation and segment ids");
    RunRows {
        run_id,
        attempt_id,
        generation_id,
        segment_id,
    }
}

fn pi_checkpoint(
    session_id: &str,
    session_file: &str,
    initial_leaf: Option<&str>,
    terminal: bool,
) -> Value {
    let selector = PiSessionSelector {
        session_id: session_id.to_owned(),
        session_file: session_file.to_owned(),
        leaf_id: initial_leaf.map(str::to_owned),
    };
    let checkpoint = NativeChatProtocolCheckpoint::new_pi_fresh_session()
        .expect("new typed Pi checkpoint")
        .prepare_thread_start(0)
        .expect("prepare Pi session effect")
        .record_pi_session(1, selector)
        .expect("record typed Pi session selector")
        .prepare_input(2)
        .expect("prepare Pi prompt effect")
        .mark_input_indeterminate(3)
        .expect("mark fixture Pi input indeterminate")
        .record_pi_turn_entry(4, session_id, "a1b2c3d4".into())
        .expect("record fixture Pi user entry")
        .record_pi_provider_terminal(5, session_id, "a1b2c3d4", PI_NEXT_LEAF.into())
        .expect("record typed Pi provider terminal");
    checkpoint_value(checkpoint, terminal)
}

fn pi_session_without_turn_checkpoint(session_file: &str) -> Value {
    let checkpoint = NativeChatProtocolCheckpoint::new_pi_fresh_session()
        .expect("new typed Pi checkpoint")
        .prepare_thread_start(0)
        .expect("prepare Pi session effect")
        .record_pi_session(
            1,
            PiSessionSelector {
                session_id: PI_SESSION.into(),
                session_file: session_file.into(),
                leaf_id: None,
            },
        )
        .expect("record valid Pi session before first prompt");
    serde_json::to_value(checkpoint).expect("serialize valid pre-prompt Pi checkpoint")
}

fn checkpoint_value(checkpoint: NativeChatProtocolCheckpoint, terminal: bool) -> Value {
    let mut value = serde_json::to_value(checkpoint).expect("serialize typed checkpoint");
    if terminal {
        value["phase"] = json!(NativeChatProtocolPhase::ExecutionTerminalCommitted.as_str());
        value["revision"] = json!(value["revision"].as_u64().expect("revision") + 1);
        let typed: NativeChatProtocolCheckpoint =
            serde_json::from_value(value).expect("deserialize terminal checkpoint");
        typed
            .validate()
            .expect("validate terminal checkpoint shape");
        serde_json::to_value(typed).expect("serialize terminal checkpoint")
    } else {
        value
    }
}

fn native_checkpoint(provider: Provider, session_id: &str, terminal: bool) -> Value {
    let checkpoint = match provider {
        Provider::Claude => NativeChatProtocolCheckpoint::new_claude_fresh_session()
            .expect("new Claude checkpoint")
            .prepare_thread_start(0)
            .expect("prepare Claude session")
            .record_claude_session(
                1,
                ClaudeSessionSelector::from_persisted(session_id).expect("Claude selector"),
            )
            .expect("record Claude selector")
            .prepare_input(2)
            .expect("prepare Claude prompt")
            .mark_claude_input_indeterminate(3, "request-claude".into())
            .expect("mark Claude input")
            .record_claude_turn(4)
            .expect("record Claude turn")
            .record_claude_provider_terminal(5, session_id, "request-claude")
            .expect("record Claude terminal"),
        Provider::Cursor => NativeChatProtocolCheckpoint::new_cursor_fresh_session()
            .expect("new Cursor checkpoint")
            .prepare_thread_start(0)
            .expect("prepare Cursor session")
            .record_cursor_session(
                1,
                CursorSessionSelector::from_persisted(session_id).expect("Cursor selector"),
            )
            .expect("record Cursor selector")
            .prepare_input(2)
            .expect("prepare Cursor prompt")
            .mark_cursor_input_indeterminate(3, "request-cursor".into())
            .expect("mark Cursor input")
            .record_cursor_turn(4)
            .expect("record Cursor turn")
            .record_cursor_provider_terminal(5, session_id, "request-cursor")
            .expect("record Cursor terminal"),
        Provider::OpenCode => NativeChatProtocolCheckpoint::new_opencode_fresh_session()
            .expect("new OpenCode checkpoint")
            .prepare_thread_start(0)
            .expect("prepare OpenCode session")
            .record_opencode_session(
                1,
                OpenCodeSessionSelector::from_persisted(session_id).expect("OpenCode selector"),
            )
            .expect("record OpenCode selector")
            .prepare_input(2)
            .expect("prepare OpenCode prompt")
            .mark_opencode_input_indeterminate(3, "request-opencode".into())
            .expect("mark OpenCode input")
            .record_opencode_turn(4)
            .expect("record OpenCode turn")
            .record_opencode_provider_terminal(5, session_id, "request-opencode")
            .expect("record OpenCode terminal"),
        Provider::Pi => unreachable!("Pi has a separate exact selector"),
    };
    checkpoint_value(checkpoint, terminal)
}

async fn complete_prior_run(
    pool: &PgPool,
    rows: &RunRows,
    checkpoint: Value,
    session_id: &str,
    pi_leaf: Option<&str>,
) {
    let mut tx = pool
        .begin()
        .await
        .expect("begin prior-run fixture transaction");
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:admission',true)")
        .execute(&mut *tx)
        .await
        .expect("mark isolated admission fixture transaction");
    sqlx::query(
        "UPDATE heartbeat_run_attempts SET status='succeeded', finished_at=clock_timestamp(),
           protocol_phase='execution_terminal_committed', checkpoint_json=$3::jsonb
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&rows.attempt_id)
    .bind(checkpoint.to_string())
    .execute(&mut *tx)
    .await
    .expect("persist typed terminal checkpoint fixture");
    sqlx::query(
        "UPDATE heartbeat_runs SET status='succeeded', finished_at=clock_timestamp(),
           updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&rows.run_id)
    .execute(&mut *tx)
    .await
    .expect("mark synthetic prior Run terminal");
    sqlx::query(
        "UPDATE chat_generations SET status='completed', completed_at=clock_timestamp(),
           updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&rows.generation_id)
    .execute(&mut *tx)
    .await
    .expect("mark synthetic prior Generation terminal");
    sqlx::query(
        "UPDATE native_segments SET state='open', native_session_id=$4, leaf_id=$5,
           updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND binding_id=(
           SELECT (context_snapshot->>'runtimeBindingId')::uuid FROM heartbeat_runs
           WHERE org_id=$1::uuid AND id=$2::uuid
         ) AND id=$3::uuid",
    )
    .bind(ORG)
    .bind(&rows.run_id)
    .bind(&rows.segment_id)
    .bind(session_id)
    .bind(pi_leaf)
    .execute(&mut *tx)
    .await
    .expect("open the exact synthetic provider session segment");
    tx.commit().await.expect("commit prior-run fixture");
}

async fn mark_run_complete_without_checkpoint(pool: &PgPool, rows: &RunRows) {
    let mut tx = pool.begin().await.expect("begin no-checkpoint fixture");
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:admission',true)")
        .execute(&mut *tx)
        .await
        .expect("mark fixture transaction");
    sqlx::query(
        "UPDATE heartbeat_run_attempts SET status='succeeded', finished_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&rows.attempt_id)
    .execute(&mut *tx)
    .await
    .expect("close missing-checkpoint Attempt fixture");
    sqlx::query(
        "UPDATE heartbeat_runs SET status='succeeded', finished_at=clock_timestamp(),
           updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&rows.run_id)
    .execute(&mut *tx)
    .await
    .expect("close missing-checkpoint Run fixture");
    sqlx::query(
        "UPDATE chat_generations SET status='completed', completed_at=clock_timestamp(),
           updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&rows.generation_id)
    .execute(&mut *tx)
    .await
    .expect("close missing-checkpoint Generation fixture");
    sqlx::query(
        "UPDATE native_segments SET state='open', native_session_id=$4, leaf_id=$5,
           updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND binding_id=(
           SELECT (context_snapshot->>'runtimeBindingId')::uuid FROM heartbeat_runs
           WHERE org_id=$1::uuid AND id=$2::uuid
         ) AND id=$3::uuid",
    )
    .bind(ORG)
    .bind(&rows.run_id)
    .bind(&rows.segment_id)
    .bind(PI_SESSION)
    .bind(PI_LEAF)
    .execute(&mut *tx)
    .await
    .expect("open Pi segment without eligible terminal checkpoint");
    tx.commit()
        .await
        .expect("commit missing-checkpoint fixture");
}

async fn mark_failed_before_pi_prompt(pool: &PgPool, rows: &RunRows, checkpoint: Value) {
    let mut tx = pool
        .begin()
        .await
        .expect("begin failed pre-prompt Pi fixture");
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:admission',true)")
        .execute(&mut *tx)
        .await
        .expect("mark pre-prompt Pi fixture transaction");
    sqlx::query(
        "UPDATE heartbeat_run_attempts SET status='failed', finished_at=clock_timestamp(),
           protocol_phase='thread_known', checkpoint_json=$3::jsonb
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&rows.attempt_id)
    .bind(checkpoint.to_string())
    .execute(&mut *tx)
    .await
    .expect("persist valid pre-prompt Pi checkpoint");
    sqlx::query(
        "UPDATE heartbeat_runs SET status='failed', finished_at=clock_timestamp(),
           native_admission_hold=false, updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&rows.run_id)
    .execute(&mut *tx)
    .await
    .expect("close failed pre-prompt Pi Run");
    sqlx::query(
        "UPDATE chat_generations SET status='failed', completed_at=clock_timestamp(),
           updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&rows.generation_id)
    .execute(&mut *tx)
    .await
    .expect("close failed pre-prompt Pi Generation");
    sqlx::query(
        "UPDATE native_segments SET state='open', native_session_id=$4, leaf_id=NULL,
           updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND binding_id=(
           SELECT (context_snapshot->>'runtimeBindingId')::uuid FROM heartbeat_runs
           WHERE org_id=$1::uuid AND id=$2::uuid
         ) AND id=$3::uuid",
    )
    .bind(ORG)
    .bind(&rows.run_id)
    .bind(&rows.segment_id)
    .bind(PI_SESSION)
    .execute(&mut *tx)
    .await
    .expect("keep exact Pi session open without an observed leaf");
    tx.commit()
        .await
        .expect("commit failed pre-prompt Pi fixture");
}

async fn set_pi_candidate(pool: &PgPool, rows: &RunRows, checkpoint: Value, phase: &str) {
    let mut tx = pool
        .begin()
        .await
        .expect("begin Pi selector fixture update");
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:admission',true)")
        .execute(&mut *tx)
        .await
        .expect("mark Pi selector fixture transaction");
    sqlx::query(
        "UPDATE heartbeat_run_attempts SET protocol_phase=$3, checkpoint_json=$4::jsonb
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&rows.attempt_id)
    .bind(phase)
    .bind(checkpoint.to_string())
    .execute(&mut *tx)
    .await
    .expect("persist candidate Pi checkpoint shape");
    tx.commit().await.expect("commit Pi selector fixture");
}

fn assert_conflict<T>(result: Result<T, Error>) {
    assert!(
        matches!(result, Err(Error::Http(409, _))),
        "expected a conflict for a non-exact Pi session checkpoint"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn opencode_operator_profile_requires_an_owned_calibrated_host_and_accepts_managed_instructions()
 {
    let database = Database::start().await;
    prepare(&database).await;
    let mut host = ProviderHost::with_opencode_owned(false);
    let actor = verified_actor(USER, "opencode-operator-profile");
    configure_agent(
        &database.pool,
        CEO,
        Provider::OpenCode,
        "provider-admission-ceo",
    )
    .await;
    let chat = unique_id("opencode-operator-profile");
    seed_chat(&database.pool, &chat).await;
    let instructions = host
        ._root
        .path()
        .join("workspaces")
        .join(compact_org_key(ORG))
        .join("workspaces/agents/provider-admission-ceo/instructions");
    fs::create_dir_all(&instructions).unwrap();
    fs::write(
        instructions.join("SOUL.md"),
        "Use the saved native system instructions.\n",
    )
    .unwrap();
    let mut config = json!({"profileId":"unknown-profile", "model":"fixture-provider/fixture-model",
        "command":"opencode", "timeoutSec":0, "graceSec":20,
        "instructionsBundleMode":"managed", "instructionsRootPath":instructions,
        "instructionsEntryFile":"SOUL.md", "instructionsFilePath":instructions.join("SOUL.md")});
    for (label, profile) in [
        ("url-only", "default"),
        ("unknown", "unknown-profile"),
        ("external-server", "operator-default"),
    ] {
        config["profileId"] = json!(profile);
        sqlx::query("UPDATE agents SET agent_runtime_config=$1::jsonb WHERE org_id=$2::uuid AND id=$3::uuid")
            .bind(config.to_string()).bind(ORG).bind(CEO).execute(&database.pool).await.unwrap();
        let before = row_counts(&database.pool, &chat).await;
        assert_conflict(admit(&database.pool, &actor, &host, &chat, label).await);
        assert_eq!(row_counts(&database.pool, &chat).await, before);
    }
    let executable = host.context.codex_executable().to_path_buf();
    host.context = host
        .context
        .with_opencode_executable(executable)
        .unwrap()
        .with_opencode_operator_profile_supported(false);
    let before = row_counts(&database.pool, &chat).await;
    assert_conflict(admit(&database.pool, &actor, &host, &chat, "custom-xdg").await);
    assert_eq!(row_counts(&database.pool, &chat).await, before);
    host.context = host.context.with_opencode_operator_profile_supported(true);
    fs::remove_dir(
        host._root
            .path()
            .join("managed-profiles/opencode")
            .join(ORG)
            .join(CEO)
            .join("default"),
    )
    .unwrap();
    for (field, value, label) in [
        ("command", json!("/untrusted/opencode"), "custom-command"),
        ("timeoutSec", json!(3601), "unbounded-timeout"),
        ("graceSec", json!(0), "zero-grace"),
        ("profileId", json!("default"), "unprovisioned-managed"),
        (
            "profileId",
            json!("unknown-profile"),
            "unknown-owned-profile",
        ),
    ] {
        let mut invalid_config = config.clone();
        invalid_config[field] = value;
        sqlx::query("UPDATE agents SET agent_runtime_config=$1::jsonb WHERE org_id=$2::uuid AND id=$3::uuid")
            .bind(invalid_config.to_string()).bind(ORG).bind(CEO).execute(&database.pool).await.unwrap();
        let before = row_counts(&database.pool, &chat).await;
        assert_conflict(admit(&database.pool, &actor, &host, &chat, label).await);
        assert_eq!(row_counts(&database.pool, &chat).await, before);
    }
    // Old local configurations without a selector retain native operator use.
    config.as_object_mut().unwrap().remove("profileId");
    sqlx::query(
        "UPDATE agents SET agent_runtime_config=$1::jsonb WHERE org_id=$2::uuid AND id=$3::uuid",
    )
    .bind(config.to_string())
    .bind(ORG)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .unwrap();
    // A newer operator database can accept session creation yet reject the
    // calibrated CLI's message INSERT. Reject that before any Rudder input or
    // execution state is committed, without migrating the native database.
    let native_directory = host
        ._root
        .path()
        .join("operator-home/.local/share/opencode");
    fs::create_dir_all(&native_directory).unwrap();
    let native_database = native_directory.join("opencode.db");
    let sqlite = rusqlite::Connection::open(&native_database).unwrap();
    sqlite
        .execute_batch(
            "CREATE TABLE session_message (
               id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
               time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
               data TEXT NOT NULL, seq INTEGER NOT NULL
             );
             CREATE TABLE permission (
               project_id TEXT PRIMARY KEY, time_created INTEGER NOT NULL,
               time_updated INTEGER NOT NULL, data TEXT NOT NULL
             );",
        )
        .unwrap();
    drop(sqlite);
    let native_before = fs::read(&native_database).unwrap();
    let before = row_counts(&database.pool, &chat).await;
    assert_conflict(
        admit(
            &database.pool,
            &actor,
            &host,
            &chat,
            "incompatible-native-db",
        )
        .await,
    );
    assert_eq!(row_counts(&database.pool, &chat).await, before);
    assert_eq!(fs::read(&native_database).unwrap(), native_before);
    // Dispose only this synthetic fixture before the existing fresh-profile
    // positive path. The product readiness check never removes a database.
    fs::remove_file(&native_database).unwrap();
    let admitted = admit(&database.pool, &actor, &host, &chat, "supported-operator")
        .await
        .unwrap();
    assert!(admitted.is_object());
    let profile: String = sqlx::query_scalar("SELECT profile_id FROM runtime_bindings WHERE org_id=$1::uuid AND conversation_id=$2::uuid")
        .bind(ORG).bind(&chat).fetch_one(&database.pool).await.unwrap();
    assert_eq!(profile, format!("operator-opencode:{CEO}:operator-default"));
}

#[tokio::test(flavor = "multi_thread")]
async fn fresh_and_resume_admission_preserve_provider_specific_session_selectors() {
    let database = Database::start().await;
    prepare(&database).await;
    let host = ProviderHost::new();
    let actor = verified_actor(USER, "provider-fresh-resume");
    let providers = [
        Provider::Claude,
        Provider::Cursor,
        Provider::OpenCode,
        Provider::Pi,
    ];

    for (index, provider) in providers.into_iter().enumerate() {
        let chat = format!("21000000-0000-4000-8000-0000000002{:02}", index + 1);
        seed_chat(&database.pool, &chat).await;
        configure_agent(&database.pool, CEO, provider, "provider-admission-ceo").await;
        let first = admit(
            &database.pool,
            &actor,
            &host,
            &chat,
            &format!("fresh-{index}"),
        )
        .await
        .expect("admit a fresh provider-specific turn");
        let first_rows = run_rows(&database.pool, &first).await;
        let (runtime_type, phase, checkpoint, profile_id, intent): (
            String,
            String,
            Value,
            String,
            Value,
        ) = sqlx::query_as(
            "SELECT a.runtime_type, a.protocol_phase, a.checkpoint_json,
                    b.profile_id, r.session_intent_json
             FROM heartbeat_run_attempts a
             JOIN heartbeat_runs r ON r.org_id=a.org_id AND r.id=a.run_id
             JOIN runtime_bindings b ON b.org_id=r.org_id
               AND b.conversation_id=r.chat_conversation_id
             WHERE a.org_id=$1::uuid AND a.id=$2::uuid",
        )
        .bind(ORG)
        .bind(&first_rows.attempt_id)
        .fetch_one(&database.pool)
        .await
        .expect("read fresh provider checkpoint and binding");
        assert_eq!(runtime_type, provider.runtime());
        assert_eq!(phase, "no_thread_request");
        assert_eq!(checkpoint["phase"], "no_thread_request");
        assert_eq!(checkpoint["provider"], provider.checkpoint_provider());
        assert_eq!(profile_id, provider.profile_ref(CEO));
        assert_eq!(intent["kind"], "fresh");
        assert_eq!(intent["reuseScope"], "none");
        assert_eq!(first["idempotentReplay"], false);

        let session_id = provider.session_id();
        let checkpoint = if matches!(provider, Provider::Pi) {
            pi_checkpoint(session_id, &host.session_file(), Some(PI_LEAF), true)
        } else {
            native_checkpoint(provider, session_id, true)
        };
        complete_prior_run(
            &database.pool,
            &first_rows,
            checkpoint,
            session_id,
            matches!(provider, Provider::Pi).then_some(PI_NEXT_LEAF),
        )
        .await;

        let second = admit(
            &database.pool,
            &actor,
            &host,
            &chat,
            &format!("resume-{index}"),
        )
        .await
        .expect("resume the exact open provider session");
        let second_rows = run_rows(&database.pool, &second).await;
        let (second_checkpoint, second_phase, intent, reuse_scope, session_before, profile_id): (
            Value,
            String,
            Value,
            String,
            Option<String>,
            String,
        ) = sqlx::query_as(
            "SELECT a.checkpoint_json, a.protocol_phase, r.session_intent_json,
                    r.session_reuse_scope, r.session_id_before, b.profile_id
             FROM heartbeat_run_attempts a
             JOIN heartbeat_runs r ON r.org_id=a.org_id AND r.id=a.run_id
             JOIN runtime_bindings b ON b.org_id=r.org_id
               AND b.conversation_id=r.chat_conversation_id
             WHERE a.org_id=$1::uuid AND a.id=$2::uuid",
        )
        .bind(ORG)
        .bind(&second_rows.attempt_id)
        .fetch_one(&database.pool)
        .await
        .expect("read resumed provider checkpoint and SessionIntent");
        assert_eq!(second_phase, "thread_known");
        assert_eq!(
            second_checkpoint["provider"],
            provider.checkpoint_provider()
        );
        assert_eq!(intent["kind"], "resume");
        assert_eq!(intent["reuseScope"], "explicit");
        assert_eq!(intent["sessionId"], session_id);
        assert_eq!(reuse_scope, "explicit");
        assert_eq!(session_before, None);
        assert_eq!(profile_id, provider.profile_ref(CEO));
        match provider {
            Provider::Claude => assert_eq!(second_checkpoint["claudeSession"], session_id),
            Provider::Cursor => assert_eq!(second_checkpoint["cursorSession"], session_id),
            Provider::OpenCode => assert_eq!(second_checkpoint["opencodeSession"], session_id),
            Provider::Pi => {
                assert_eq!(second_checkpoint["piSession"]["sessionId"], session_id);
                assert_eq!(
                    second_checkpoint["piSession"]["sessionFile"],
                    host.session_file()
                );
                assert_eq!(second_checkpoint["piSession"]["leafId"], PI_NEXT_LEAF);
            }
        }
        assert_eq!(
            row_counts(&database.pool, &chat).await,
            (2, 2, 2, 2, 2),
            "fresh and resumed admission create one source message/run each"
        );
    }
}

async fn insert_legacy_pi_candidate(
    pool: &PgPool,
    chat: &str,
    agent: &str,
    segment_id: &str,
    checkpoint: &Value,
) {
    let run_id = unique_id("legacy-pi-run");
    let attempt_id = unique_id("legacy-pi-attempt");
    let mut tx = pool.begin().await.expect("begin legacy candidate fixture");
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:admission',true)")
        .execute(&mut *tx)
        .await
        .expect("mark legacy candidate fixture");
    sqlx::query(
        "INSERT INTO heartbeat_runs
           (id,org_id,agent_id,status,chat_conversation_id,context_snapshot,
            scene,target_type,target_id,idempotency_key,session_intent_json,
            execution_authority,native_admission_hold)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'succeeded',$4::uuid,
            jsonb_build_object('nativeSegmentId',$5), 'chat','chat_conversation',$4,
            $6,'{\"kind\":\"resume\",\"reuseScope\":\"explicit\",\"sourceRunId\":null,\"sessionId\":null,\"sessionParams\":null}'::jsonb,
            'legacy_ts',false)",
    )
    .bind(&run_id)
    .bind(ORG)
    .bind(agent)
    .bind(chat)
    .bind(segment_id)
    .bind(format!("legacy-pi-candidate-{attempt_id}"))
    .execute(&mut *tx)
    .await
    .expect("insert valid non-native Run candidate");
    sqlx::query(
        "INSERT INTO heartbeat_run_attempts
           (id,org_id,run_id,agent_id,attempt_index,runtime_type,status,checkpoint_json)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,1,'pi_local','succeeded',$5::jsonb)",
    )
    .bind(attempt_id)
    .bind(ORG)
    .bind(run_id)
    .bind(agent)
    .bind(checkpoint.to_string())
    .execute(&mut *tx)
    .await
    .expect("insert legacy Attempt without an impossible native protocol phase");
    tx.commit().await.expect("commit legacy candidate fixture");
}

#[tokio::test(flavor = "multi_thread")]
async fn pi_resume_rejects_missing_foreign_and_malformed_session_checkpoint_candidates() {
    let database = Database::start().await;
    prepare(&database).await;
    let host = ProviderHost::new();
    let actor = verified_actor(USER, "provider-pi-selector-negative");
    configure_agent(&database.pool, CEO, Provider::Pi, "provider-admission-ceo").await;
    configure_agent(
        &database.pool,
        WRONG_AGENT,
        Provider::Pi,
        "provider-admission-other",
    )
    .await;

    let target_chat = unique_id("pi-target");
    seed_chat(&database.pool, &target_chat).await;
    let target_receipt = admit(
        &database.pool,
        &actor,
        &host,
        &target_chat,
        "pi-target-fresh",
    )
    .await
    .expect("admit Pi target Chat");
    let target_rows = run_rows(&database.pool, &target_receipt).await;
    mark_run_complete_without_checkpoint(&database.pool, &target_rows).await;
    let before = row_counts(&database.pool, &target_chat).await;

    // An otherwise matching terminal checkpoint on a different Segment (same
    // selected Agent) must not be treated as the current segment's selector.
    let foreign_segment_chat = unique_id("pi-foreign-segment-chat");
    seed_chat(&database.pool, &foreign_segment_chat).await;
    let foreign_segment_receipt = admit(
        &database.pool,
        &actor,
        &host,
        &foreign_segment_chat,
        "pi-foreign-segment",
    )
    .await
    .expect("admit foreign-segment Pi source");
    let foreign_segment_rows = run_rows(&database.pool, &foreign_segment_receipt).await;
    complete_prior_run(
        &database.pool,
        &foreign_segment_rows,
        pi_checkpoint(PI_SESSION, &host.session_file(), Some(PI_LEAF), true),
        PI_SESSION,
        Some(PI_NEXT_LEAF),
    )
    .await;

    // A terminal selector from a different Agent is also not a continuation
    // source even when it uses the same provider-local session id.
    let foreign_agent_chat = unique_id("pi-foreign-agent-chat");
    seed_chat_in_org(&database.pool, &foreign_agent_chat, ORG, Some(WRONG_AGENT)).await;
    let foreign_agent_receipt = admit(
        &database.pool,
        &actor,
        &host,
        &foreign_agent_chat,
        "pi-foreign-agent",
    )
    .await
    .expect("admit foreign-Agent Pi source");
    let foreign_agent_rows = run_rows(&database.pool, &foreign_agent_receipt).await;
    complete_prior_run(
        &database.pool,
        &foreign_agent_rows,
        pi_checkpoint(PI_SESSION, &host.session_file(), Some(PI_LEAF), true),
        PI_SESSION,
        Some(PI_NEXT_LEAF),
    )
    .await;

    // A valid legacy row can retain opaque checkpoint JSON but cannot claim a
    // Native protocol phase. It must not supply the selector for a native run.
    insert_legacy_pi_candidate(
        &database.pool,
        &target_chat,
        CEO,
        &target_rows.segment_id,
        &pi_checkpoint(PI_SESSION, &host.session_file(), Some(PI_LEAF), true),
    )
    .await;
    let missing_request = request(&target_chat, "pi-missing-exact-checkpoint", "continue Pi");
    assert_conflict(
        execute_native(&database.pool, &actor, ORG, &missing_request, &host.context).await,
    );
    assert_eq!(row_counts(&database.pool, &target_chat).await, before);

    // A legitimate crash after Pi created a session but before the first
    // prompt has a valid ThreadKnown checkpoint, an exact session ID, and no
    // leaf. Admission must not guess a continuation point from that state.
    let pre_prompt_chat = unique_id("pi-pre-prompt-without-leaf");
    seed_chat(&database.pool, &pre_prompt_chat).await;
    let pre_prompt_receipt = admit(
        &database.pool,
        &actor,
        &host,
        &pre_prompt_chat,
        "pi-pre-prompt-fresh",
    )
    .await
    .expect("admit pre-prompt Pi source");
    let pre_prompt_rows = run_rows(&database.pool, &pre_prompt_receipt).await;
    mark_failed_before_pi_prompt(
        &database.pool,
        &pre_prompt_rows,
        pi_session_without_turn_checkpoint(&host.session_file()),
    )
    .await;
    let pre_prompt_before = row_counts(&database.pool, &pre_prompt_chat).await;
    let pre_prompt_request = request(
        &pre_prompt_chat,
        "pi-pre-prompt-must-not-guess",
        "do not guess a Pi leaf",
    );
    assert_conflict(
        execute_native(
            &database.pool,
            &actor,
            ORG,
            &pre_prompt_request,
            &host.context,
        )
        .await,
    );
    assert_eq!(
        row_counts(&database.pool, &pre_prompt_chat).await,
        pre_prompt_before
    );

    // Candidate rows on the exact current Segment must still be terminal,
    // have the exact native_session_id, and carry a usable typed selector.
    let candidates = [
        (
            "nonterminal phase",
            pi_checkpoint(PI_SESSION, &host.session_file(), Some(PI_LEAF), false),
            NativeChatProtocolPhase::ProviderTerminalObserved.as_str(),
        ),
        (
            "mismatched session id",
            pi_checkpoint(
                "pi-foreign-session",
                &host.session_file(),
                Some(PI_LEAF),
                true,
            ),
            NativeChatProtocolPhase::ExecutionTerminalCommitted.as_str(),
        ),
    ];
    for (label, checkpoint, phase) in candidates {
        set_pi_candidate(&database.pool, &target_rows, checkpoint, phase).await;
        let rejected = request(
            &target_chat,
            &format!("pi-invalid-{label}"),
            "must not continue",
        );
        assert_conflict(
            execute_native(&database.pool, &actor, ORG, &rejected, &host.context).await,
        );
        assert_eq!(row_counts(&database.pool, &target_chat).await, before);
    }

    let mut missing_leaf = pi_checkpoint(PI_SESSION, &host.session_file(), Some(PI_LEAF), true);
    missing_leaf["piSession"]["leafId"] = Value::Null;
    set_pi_candidate(
        &database.pool,
        &target_rows,
        missing_leaf,
        NativeChatProtocolPhase::ExecutionTerminalCommitted.as_str(),
    )
    .await;
    let rejected = request(&target_chat, "pi-missing-leaf", "must not continue");
    assert_conflict(execute_native(&database.pool, &actor, ORG, &rejected, &host.context).await);
    assert_eq!(row_counts(&database.pool, &target_chat).await, before);

    let mut malformed = pi_checkpoint(PI_SESSION, &host.session_file(), Some(PI_LEAF), true);
    malformed["piSession"]["sessionFile"] = json!("");
    set_pi_candidate(
        &database.pool,
        &target_rows,
        malformed,
        NativeChatProtocolPhase::ExecutionTerminalCommitted.as_str(),
    )
    .await;
    let rejected = request(&target_chat, "pi-malformed-selector", "must not continue");
    assert_conflict(execute_native(&database.pool, &actor, ORG, &rejected, &host.context).await);
    assert_eq!(row_counts(&database.pool, &target_chat).await, before);

    let mut unknown_field = pi_checkpoint(PI_SESSION, &host.session_file(), Some(PI_LEAF), true);
    unknown_field["piSession"]["untrustedExtra"] = json!("ignored is unsafe");
    set_pi_candidate(
        &database.pool,
        &target_rows,
        unknown_field,
        NativeChatProtocolPhase::ExecutionTerminalCommitted.as_str(),
    )
    .await;
    let rejected = request(
        &target_chat,
        "pi-unknown-selector-field",
        "must not continue",
    );
    assert_conflict(execute_native(&database.pool, &actor, ORG, &rejected, &host.context).await);
    assert_eq!(row_counts(&database.pool, &target_chat).await, before);

    let unknown_runtime_chat = unique_id("unknown-runtime-chat");
    seed_chat(&database.pool, &unknown_runtime_chat).await;
    sqlx::query(
        "UPDATE agents SET agent_runtime_type='unknown_local', agent_runtime_config='{}'::jsonb
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("select unsupported runtime for negative admission");
    let before_unknown = row_counts(&database.pool, &unknown_runtime_chat).await;
    assert_conflict(
        execute_native(
            &database.pool,
            &actor,
            ORG,
            &request(&unknown_runtime_chat, "unknown-provider", "must not admit"),
            &host.context,
        )
        .await,
    );
    assert_eq!(
        row_counts(&database.pool, &unknown_runtime_chat).await,
        before_unknown
    );
}
