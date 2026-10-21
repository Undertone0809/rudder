use super::*;
use serde_json::Value;
use std::{fs, path::PathBuf};
use tempfile::TempDir;

const CHAT_CLAUDE_MANAGED: &str = "21000000-0000-4000-8000-000000000201";
const CHAT_CLAUDE_MISSING: &str = "21000000-0000-4000-8000-000000000202";
const CHAT_CLAUDE_SYMLINK: &str = "21000000-0000-4000-8000-000000000203";
const CHAT_CLAUDE_OPERATOR_DARK: &str = "21000000-0000-4000-8000-000000000204";
const CHAT_CLAUDE_OPERATOR_LIGHT: &str = "21000000-0000-4000-8000-000000000205";
const CHAT_CLAUDE_BYPASS: &str = "21000000-0000-4000-8000-000000000211";
const CHAT_CURSOR_MANAGED: &str = "21000000-0000-4000-8000-000000000206";
const CHAT_CURSOR_MISSING: &str = "21000000-0000-4000-8000-000000000207";
const CHAT_CURSOR_SYMLINK: &str = "21000000-0000-4000-8000-000000000208";
const CHAT_CURSOR_OPERATOR_DARK: &str = "21000000-0000-4000-8000-000000000209";
const CHAT_CURSOR_OPERATOR_LIGHT: &str = "21000000-0000-4000-8000-000000000210";
const CHAT_CURSOR_COMMAND: &str = "21000000-0000-4000-8000-000000000212";
const CHAT_CURSOR_INSTRUCTIONS: &str = "21000000-0000-4000-8000-000000000216";
const CHAT_CURSOR_BAD_MODEL: &str = "21000000-0000-4000-8000-000000000217";
const CHAT_PI_MANAGED: &str = "21000000-0000-4000-8000-000000000213";
const CHAT_PI_OPERATOR_DARK: &str = "21000000-0000-4000-8000-000000000214";
const CHAT_PI_OPERATOR_LIGHT: &str = "21000000-0000-4000-8000-000000000215";
const OPERATOR_PROFILE: &str = "operator-default";
const WORKSPACE_KEY: &str = "operator-profile-ceo";

#[derive(Clone, Copy)]
enum Provider {
    Claude,
    Cursor,
}

impl Provider {
    fn runtime_type(self) -> &'static str {
        match self {
            Self::Claude => "claude_local",
            Self::Cursor => "cursor",
        }
    }

    fn binding_prefix(self) -> &'static str {
        match self {
            Self::Claude => "claude-local",
            Self::Cursor => "cursor-local",
        }
    }

    fn runtime_config(self, profile_id: &str) -> Value {
        match self {
            Self::Claude => json!({
                "profileId":profile_id,
                "command":"claude",
                "model":"fixture-model",
                "permissionMode":"auto",
                "dangerouslySkipPermissions":false,
                "maxTurnsPerRun":300,
                "timeoutSec":0,
                "graceSec":15
            }),
            Self::Cursor => json!({
                "profileId":profile_id,
                "command":"cursor-agent",
                "model":"auto",
                "timeoutSec":0,
                "graceSec":15
            }),
        }
    }
}

struct OperatorProfileHost {
    _root: TempDir,
    context: LocalHostContext,
    operator_home: PathBuf,
    claude_managed_home: PathBuf,
    cursor_managed_home: PathBuf,
    pi_profiles_root: PathBuf,
    instructions: PathBuf,
}

impl OperatorProfileHost {
    fn new() -> Self {
        let root = tempfile::tempdir().expect("create isolated operator profile host");
        let instance = root.path().join("instance");
        let workspace_home = root.path().join("workspaces");
        let previous_documents = root.path().join("previous-documents");
        let managed_profiles = root.path().join("managed-profiles");
        let operator_home = root.path().join("operator-home");
        let binaries = root.path().join("bin");
        let cwd = workspace_home
            .join(compact_org_key(ORG))
            .join("workspaces/agents")
            .join(WORKSPACE_KEY);
        let claude_profiles = root.path().join("claude-profiles");
        let cursor_profiles = root.path().join("cursor-profiles");
        let pi_profiles = root.path().join("pi-profiles");
        let claude = binaries.join("claude");
        let cursor = binaries.join("cursor-agent");
        let node = binaries.join("node");
        let pi_cli = binaries.join("pi-entry.mjs");
        let codex = binaries.join("codex");
        let claude_managed_home = claude_profiles.clone();
        let cursor_managed_home = cursor_profiles.clone();
        let instructions = cwd.join("instructions");

        for directory in [
            &instance,
            &workspace_home,
            &previous_documents,
            &managed_profiles,
            &operator_home,
            &binaries,
            &cwd,
            &instructions,
            &claude_profiles.join(".claude"),
            &cursor_profiles.join(".cursor"),
            &operator_home.join(".pi/agent"),
            &pi_profiles,
            &pi_profiles.join("operator-sessions"),
            &pi_profiles.join(ORG).join(CEO).join("default/.pi/agent"),
        ] {
            fs::create_dir_all(directory).expect("create isolated operator profile fixture");
        }
        for binary in [&claude, &cursor, &node, &pi_cli, &codex] {
            fs::write(binary, b"fixture executable; never launched")
                .expect("write inert provider executable fixture");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(binary, fs::Permissions::from_mode(0o755))
                    .expect("mark inert provider executable");
            }
        }

        let context = LocalHostContext::from_rust_host(
            "operator-profile-test-host".into(),
            instance,
            workspace_home,
            previous_documents,
            false,
            managed_profiles,
            operator_home.clone(),
            codex,
        )
        .expect("construct synthetic trusted host")
        .with_executable_search_path("/usr/bin:/bin".into())
        .expect("bind trusted executable search path")
        .with_claude_runtime(claude, claude_profiles)
        .expect("attach inert Claude installation")
        .with_cursor_runtime(cursor, cursor_profiles)
        .expect("attach inert Cursor installation")
        .with_pi_runtime(node, pi_cli, pi_profiles.clone())
        .expect("attach inert Pi installation");

        Self {
            _root: root,
            context,
            operator_home,
            claude_managed_home,
            cursor_managed_home,
            pi_profiles_root: pi_profiles,
            instructions,
        }
    }

    fn managed_home(&self, provider: Provider) -> &PathBuf {
        match provider {
            Provider::Claude => &self.claude_managed_home,
            Provider::Cursor => &self.cursor_managed_home,
        }
    }

    fn operator_config_dir(&self, provider: Provider) -> PathBuf {
        self.operator_home.join(match provider {
            Provider::Claude => ".claude",
            Provider::Cursor => ".cursor",
        })
    }

    fn settings_file(&self, provider: Provider) -> PathBuf {
        self.operator_config_dir(provider).join("settings.json")
    }

    fn pi_agent_dir(&self) -> PathBuf {
        self.operator_home.join(".pi/agent")
    }
}

fn compact_org_key(org: &str) -> String {
    org.chars()
        .filter(|character| *character != '-')
        .take(12)
        .collect::<String>()
        .to_ascii_lowercase()
}

async fn configure_provider(pool: &PgPool, provider: Provider, profile_id: &str) {
    configure_provider_config(pool, provider, provider.runtime_config(profile_id)).await;
}

async fn configure_provider_config(pool: &PgPool, provider: Provider, config: Value) {
    sqlx::query(
        "UPDATE agents SET agent_runtime_type=$1, status='idle', workspace_key=$2,
           agent_runtime_config=$3::jsonb WHERE org_id=$4::uuid AND id=$5::uuid",
    )
    .bind(provider.runtime_type())
    .bind(WORKSPACE_KEY)
    .bind(config.to_string())
    .bind(ORG)
    .bind(CEO)
    .execute(pool)
    .await
    .expect("select fixture provider and profile");
}

async fn configure_pi(pool: &PgPool, config: Value) {
    sqlx::query(
        "UPDATE agents SET agent_runtime_type='pi_local', status='idle', workspace_key=$1,
           agent_runtime_config=$2::jsonb WHERE org_id=$3::uuid AND id=$4::uuid",
    )
    .bind(WORKSPACE_KEY)
    .bind(config.to_string())
    .bind(ORG)
    .bind(CEO)
    .execute(pool)
    .await
    .expect("select fixture Pi profile");
}

fn pi_runtime_config(profile_id: &str) -> Value {
    json!({
        "profileId":profile_id,
        "command":"pi",
        "model":"fixture-provider/fixture-model",
        "timeoutSec":0,
        "graceSec":20
    })
}

async fn admit(
    pool: &PgPool,
    actor: &VerifiedActor,
    host: &OperatorProfileHost,
    chat: &str,
    mutation: &str,
) -> Result<Value, Error> {
    execute_native(
        pool,
        actor,
        ORG,
        &request(chat, mutation, "synthetic profile admission input"),
        &host.context,
    )
    .await
}

async fn binding_identity(pool: &PgPool, chat: &str) -> (String, String) {
    sqlx::query_as(
        "SELECT profile_id, capability_revision FROM runtime_bindings
         WHERE org_id=$1::uuid AND conversation_id=$2::uuid",
    )
    .bind(ORG)
    .bind(chat)
    .fetch_one(pool)
    .await
    .expect("read runtime binding identity")
}

async fn effect_counts(pool: &PgPool, chat: &str) -> (i64, i64, i64, i64, i64) {
    sqlx::query_as(
        "SELECT
           (SELECT count(*) FROM chat_messages WHERE org_id=$1::uuid AND conversation_id=$2::uuid),
           (SELECT count(*) FROM chat_generations WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND execution_authority='native_rust'),
           (SELECT count(*) FROM heartbeat_runs WHERE org_id=$1::uuid AND chat_conversation_id=$2::uuid AND execution_authority='native_rust'),
           (SELECT count(*) FROM heartbeat_run_attempts a JOIN heartbeat_runs r ON r.org_id=a.org_id AND r.id=a.run_id WHERE r.org_id=$1::uuid AND r.chat_conversation_id=$2::uuid AND r.execution_authority='native_rust'),
           (SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_type='chat' AND entity_id=$2::text AND action='chat.message_added')",
    )
    .bind(ORG)
    .bind(chat)
    .fetch_one(pool)
    .await
    .expect("count Native Chat admission effects")
}

fn assert_conflict<T>(result: Result<T, Error>) {
    assert!(
        matches!(result, Err(Error::Http(409, _))),
        "an unavailable or unsafe operator profile must reject admission"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn provider_operator_profiles_are_explicit_and_defaults_remain_managed() {
    let database = Database::start().await;
    prepare(&database).await;
    let host = OperatorProfileHost::new();
    let actor = verified_actor(USER, "native-operator-profile-selection");

    for (provider, managed_chat, missing_chat, dark_chat, light_chat) in [
        (
            Provider::Claude,
            CHAT_CLAUDE_MANAGED,
            CHAT_CLAUDE_MISSING,
            CHAT_CLAUDE_OPERATOR_DARK,
            CHAT_CLAUDE_OPERATOR_LIGHT,
        ),
        (
            Provider::Cursor,
            CHAT_CURSOR_MANAGED,
            CHAT_CURSOR_MISSING,
            CHAT_CURSOR_OPERATOR_DARK,
            CHAT_CURSOR_OPERATOR_LIGHT,
        ),
    ] {
        // The legacy managed profile remains selected by default and resolves
        // from the trusted Rust-owned profile root, not the operator home.
        seed_chat(&database.pool, managed_chat).await;
        configure_provider(&database.pool, provider, "default").await;
        admit(
            &database.pool,
            &actor,
            &host,
            managed_chat,
            &format!("managed-{}", provider.runtime_type()),
        )
        .await
        .expect("default managed profile remains admissible");
        let (managed_binding, _) = binding_identity(&database.pool, managed_chat).await;
        assert_eq!(
            managed_binding,
            format!("{}:{CEO}:default", provider.binding_prefix())
        );
        assert!(
            host.managed_home(provider)
                .join(match provider {
                    Provider::Claude => ".claude",
                    Provider::Cursor => ".cursor",
                })
                .is_dir()
        );

        let unsafe_chat = match provider {
            Provider::Claude => CHAT_CLAUDE_BYPASS,
            Provider::Cursor => CHAT_CURSOR_COMMAND,
        };
        let mut unsafe_config = provider.runtime_config(OPERATOR_PROFILE);
        match provider {
            Provider::Claude => unsafe_config["dangerouslySkipPermissions"] = json!(true),
            Provider::Cursor => unsafe_config["command"] = json!("/tmp/untrusted-cursor-agent"),
        }
        configure_provider_config(&database.pool, provider, unsafe_config).await;
        seed_chat(&database.pool, unsafe_chat).await;
        let unsafe_result = admit(
            &database.pool,
            &actor,
            &host,
            unsafe_chat,
            &format!("unsafe-{}", provider.runtime_type()),
        )
        .await;
        assert_conflict(unsafe_result);
        assert_eq!(
            effect_counts(&database.pool, unsafe_chat).await,
            (0, 0, 0, 0, 0)
        );

        // Operator profile selection fails closed before any admission rows
        // are written when the provider's real config directory is absent.
        configure_provider(&database.pool, provider, OPERATOR_PROFILE).await;
        seed_chat(&database.pool, missing_chat).await;
        assert_eq!(
            effect_counts(&database.pool, missing_chat).await,
            (0, 0, 0, 0, 0)
        );
        let missing = admit(
            &database.pool,
            &actor,
            &host,
            missing_chat,
            &format!("missing-{}", provider.runtime_type()),
        )
        .await;
        assert_conflict(missing);
        assert_eq!(
            effect_counts(&database.pool, missing_chat).await,
            (0, 0, 0, 0, 0)
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let config_dir = host.operator_config_dir(provider);
            let redirected = host
                ._root
                .path()
                .join(format!("redirected-{}", provider.runtime_type()));
            fs::create_dir_all(&redirected).expect("create symlink target fixture");
            symlink(&redirected, &config_dir).expect("create rejected provider directory link");
            let symlink_chat = match provider {
                Provider::Claude => CHAT_CLAUDE_SYMLINK,
                Provider::Cursor => CHAT_CURSOR_SYMLINK,
            };
            seed_chat(&database.pool, symlink_chat).await;
            let linked = admit(
                &database.pool,
                &actor,
                &host,
                symlink_chat,
                &format!("symlink-{}", provider.runtime_type()),
            )
            .await;
            assert_conflict(linked);
            assert_eq!(
                effect_counts(&database.pool, symlink_chat).await,
                (0, 0, 0, 0, 0)
            );
            fs::remove_file(&config_dir).expect("remove synthetic symlink");
        }

        let config_dir = host.operator_config_dir(provider);
        fs::create_dir_all(&config_dir).expect("create real operator provider directory");
        let settings = host.settings_file(provider);
        let dark_settings = r#"{"appearance":"dark","syntheticFixture":true}"#;
        fs::write(&settings, dark_settings).expect("write synthetic operator settings");
        seed_chat(&database.pool, dark_chat).await;
        admit(
            &database.pool,
            &actor,
            &host,
            dark_chat,
            &format!("operator-dark-{}", provider.runtime_type()),
        )
        .await
        .expect("admit explicit operator profile");
        let (operator_binding, dark_revision) = binding_identity(&database.pool, dark_chat).await;
        assert_eq!(
            operator_binding,
            format!("{}:{CEO}:{OPERATOR_PROFILE}", provider.binding_prefix())
        );

        if matches!(provider, Provider::Cursor) {
            let mut explicit_model = provider.runtime_config(OPERATOR_PROFILE);
            explicit_model["model"] = json!("gpt-5.3-codex");
            explicit_model["effort"] = json!("high");
            configure_provider_config(&database.pool, provider, explicit_model).await;
        }

        let light_settings = r#"{"appearance":"light","syntheticFixture":true}"#;
        fs::write(&settings, light_settings).expect("change only synthetic profile settings");
        seed_chat(&database.pool, light_chat).await;
        admit(
            &database.pool,
            &actor,
            &host,
            light_chat,
            &format!("operator-light-{}", provider.runtime_type()),
        )
        .await
        .expect("admit again after operator settings change");
        let (light_binding, light_revision) = binding_identity(&database.pool, light_chat).await;
        assert_eq!(light_binding, operator_binding);
        assert_ne!(
            dark_revision, light_revision,
            "the selected operator profile settings must affect its persisted revision"
        );
        assert_eq!(
            fs::read_to_string(settings).unwrap(),
            light_settings,
            "admission must leave operator-owned settings untouched"
        );
    }

    // Cursor ACP has no proven Rudder instruction transfer mechanism. Do not
    // silently admit a nonempty Agent instruction bundle that execution would
    // ignore; rejection must happen before the user message or run is stored.
    fs::write(
        host.instructions.join("SOUL.md"),
        "synthetic cursor instruction\n",
    )
    .expect("write synthetic Cursor Agent instruction");
    configure_provider_config(
        &database.pool,
        Provider::Cursor,
        Provider::Cursor.runtime_config(OPERATOR_PROFILE),
    )
    .await;
    seed_chat(&database.pool, CHAT_CURSOR_INSTRUCTIONS).await;
    let instruction_result = admit(
        &database.pool,
        &actor,
        &host,
        CHAT_CURSOR_INSTRUCTIONS,
        "cursor-nonempty-instructions",
    )
    .await;
    assert!(matches!(
        instruction_result,
        Err(Error::Http(409, message)) if message.contains("instructions cannot be applied")
    ));
    assert_eq!(
        effect_counts(&database.pool, CHAT_CURSOR_INSTRUCTIONS).await,
        (0, 0, 0, 0, 0)
    );

    let mut malformed_model = Provider::Cursor.runtime_config(OPERATOR_PROFILE);
    malformed_model["model"] = json!("gpt-5.3-codex[");
    configure_provider_config(&database.pool, Provider::Cursor, malformed_model).await;
    seed_chat(&database.pool, CHAT_CURSOR_BAD_MODEL).await;
    let malformed_result = admit(
        &database.pool,
        &actor,
        &host,
        CHAT_CURSOR_BAD_MODEL,
        "cursor-malformed-model-selector",
    )
    .await;
    assert_conflict(malformed_result);
    assert_eq!(
        effect_counts(&database.pool, CHAT_CURSOR_BAD_MODEL).await,
        (0, 0, 0, 0, 0)
    );

    // The normal Pi-local UI defaults select the installed `pi` command,
    // disable the outer timeout with zero, and keep the host cleanup grace.
    // Admission resolves the explicit operator profile in place while the
    // legacy/default managed profile remains a separate binding.
    let pi_managed_home = host.pi_profiles_root.join(ORG).join(CEO).join("default");
    fs::create_dir_all(pi_managed_home.join(".pi/agent"))
        .expect("create synthetic managed Pi profile");
    seed_chat(&database.pool, CHAT_PI_MANAGED).await;
    configure_pi(&database.pool, pi_runtime_config("default")).await;
    admit(
        &database.pool,
        &actor,
        &host,
        CHAT_PI_MANAGED,
        "managed-pi-ui-defaults",
    )
    .await
    .expect("default managed Pi profile remains admissible");
    let (managed_pi_binding, _) = binding_identity(&database.pool, CHAT_PI_MANAGED).await;
    assert_eq!(managed_pi_binding, format!("managed-pi:{CEO}:default"));

    configure_pi(&database.pool, pi_runtime_config(OPERATOR_PROFILE)).await;
    let pi_agent_dir = host.pi_agent_dir();
    let pi_settings = pi_agent_dir.join("settings.json");
    let dark_settings = r#"{"theme":"dark","syntheticFixture":true}"#;
    fs::write(&pi_settings, dark_settings).expect("write synthetic operator Pi settings");
    seed_chat(&database.pool, CHAT_PI_OPERATOR_DARK).await;
    admit(
        &database.pool,
        &actor,
        &host,
        CHAT_PI_OPERATOR_DARK,
        "operator-pi-dark",
    )
    .await
    .expect("admit explicit operator Pi profile");
    let (operator_pi_binding, dark_pi_revision) =
        binding_identity(&database.pool, CHAT_PI_OPERATOR_DARK).await;
    assert_eq!(
        operator_pi_binding,
        format!("operator-pi:{CEO}:{OPERATOR_PROFILE}")
    );

    let light_settings = r#"{"theme":"light","syntheticFixture":true}"#;
    fs::write(&pi_settings, light_settings).expect("change synthetic operator Pi settings");
    seed_chat(&database.pool, CHAT_PI_OPERATOR_LIGHT).await;
    admit(
        &database.pool,
        &actor,
        &host,
        CHAT_PI_OPERATOR_LIGHT,
        "operator-pi-light",
    )
    .await
    .expect("admit operator Pi profile after settings change");
    let (light_pi_binding, light_pi_revision) =
        binding_identity(&database.pool, CHAT_PI_OPERATOR_LIGHT).await;
    assert_eq!(light_pi_binding, operator_pi_binding);
    assert_ne!(dark_pi_revision, light_pi_revision);
    assert_eq!(fs::read_to_string(pi_settings).unwrap(), light_settings);
}
