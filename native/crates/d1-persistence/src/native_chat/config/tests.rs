use super::runtime;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use super::{LocalHostContext, resolve_codex_config};
use crate::runtime_bindings::Error;
use serde_json::{Value, json};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::fs;
use std::path::Path;

#[allow(dead_code)]
#[path = "../../../tests/support/mod.rs"]
mod support;

fn fixture_operator_home() -> &'static Path {
    #[cfg(windows)]
    {
        Path::new(r"C:\operator")
    }
    #[cfg(not(windows))]
    {
        Path::new("/operator")
    }
}

fn fixture_absolute_path(tail: &str) -> String {
    #[cfg(windows)]
    {
        format!(r"C:\{tail}")
    }
    #[cfg(not(windows))]
    {
        format!("/{tail}")
    }
}

fn parsed(
    config: Value,
    model: Option<String>,
    effort: Option<String>,
    plan: bool,
) -> runtime::RuntimeSettings {
    match runtime::parse_agent_config(config, model, effort, plan, fixture_operator_home()) {
        Ok(settings) => settings,
        Err(_) => panic!("valid Codex runtime settings were rejected"),
    }
}

fn assert_http_error<T>(result: std::result::Result<T, Error>, status: u16, secret: Option<&str>) {
    match result {
        Err(Error::Http(actual, message)) => {
            assert_eq!(actual, status);
            if let Some(secret) = secret {
                assert!(!message.contains(secret));
            }
        }
        _ => panic!("expected a Native Chat configuration error"),
    }
}

#[test]
fn parser_preserves_persisted_model_and_chat_overrides_with_safe_defaults() {
    let config = json!({
        "model": "gpt-5.6-sol",
        "modelReasoningEffort": "high",
        "search": false,
        "dangerouslyBypassApprovalsAndSandbox": false,
        "planMode": false,
    });
    let settings = parsed(
        config,
        Some("vendor/custom-text-model".into()),
        Some("ultra".into()),
        false,
    );
    assert_eq!(settings.model.as_deref(), Some("vendor/custom-text-model"));
    assert_eq!(settings.effort.as_deref(), Some("ultra"));
    assert!(!settings.plan_mode);
    assert!(!settings.search_enabled);
    assert!(settings.count_subscription_usage_as_cost);

    let defaults = parsed(json!({"search": false}), None, None, false);
    assert_eq!(defaults.model.as_deref(), Some("gpt-5.6-luna"));
    assert_eq!(defaults.effort.as_deref(), Some("medium"));
    assert!(!defaults.plan_mode);

    let exact_model = parsed(
        json!({"model":" vendor/custom-text-model ","search":false}),
        None,
        None,
        false,
    );
    assert_eq!(
        exact_model.model.as_deref(),
        Some(" vendor/custom-text-model ")
    );
}

#[test]
fn parser_preserves_subscription_usage_billing_preference() {
    let disabled = parsed(
        json!({"countSubscriptionUsageAsCost": false}),
        None,
        None,
        false,
    );
    assert!(!disabled.count_subscription_usage_as_cost);

    let invalid = runtime::parse_agent_config(
        json!({"countSubscriptionUsageAsCost": "yes"}),
        None,
        None,
        false,
        fixture_operator_home(),
    );
    assert_http_error(invalid, 409, None);
}

#[test]
fn parser_inherits_native_codex_profile_defaults_without_overriding_explicit_choices() {
    let inherited = runtime::parse_agent_config_with_profile_defaults(
        json!({}),
        None,
        None,
        false,
        fixture_operator_home(),
        true,
    )
    .expect("native profile defaults remain authoritative when no override exists");
    assert_eq!(inherited.model, None);
    assert_eq!(inherited.effort, None);

    let configured = runtime::parse_agent_config_with_profile_defaults(
        json!({"model":"profile-agent-model","modelReasoningEffort":"xhigh"}),
        None,
        None,
        false,
        fixture_operator_home(),
        true,
    )
    .expect("explicit Agent choices override the profile");
    assert_eq!(configured.model.as_deref(), Some("profile-agent-model"));
    assert_eq!(configured.effort.as_deref(), Some("xhigh"));

    let chat_override = runtime::parse_agent_config_with_profile_defaults(
        json!({"model":"profile-agent-model","modelReasoningEffort":"xhigh"}),
        Some("chat-model".into()),
        Some("high".into()),
        false,
        fixture_operator_home(),
        true,
    )
    .expect("explicit Chat choices retain their established precedence");
    assert_eq!(chat_override.model.as_deref(), Some("chat-model"));
    assert_eq!(chat_override.effort.as_deref(), Some("high"));
}

#[test]
fn parser_excludes_legacy_heartbeat_scheduler_policy_from_direct_chat_identity() {
    let defaults = parsed(json!({}), None, None, false);
    let with_heartbeat = parsed(
        json!({
            "heartbeat": {
                "enabled": true,
                "intervalSec": 300,
                "cooldownSec": 10,
                "maxConcurrentRuns": 2,
                "preflightEnabled": true,
                "wakeOnDemand": true,
            }
        }),
        None,
        None,
        false,
    );

    assert_eq!(with_heartbeat.model, defaults.model);
    assert_eq!(with_heartbeat.effort, defaults.effort);
    assert_eq!(
        with_heartbeat.capability_revision_input, defaults.capability_revision_input,
        "heartbeat scheduling policy must not change a direct Chat request identity"
    );

    assert_http_error(
        runtime::parse_agent_config(
            json!({"heartbeat": "not-an-object"}),
            None,
            None,
            false,
            fixture_operator_home(),
        ),
        409,
        None,
    );
}

#[test]
fn native_profile_parser_preserves_supported_selected_agent_codex_settings() {
    let instructions_root = fixture_absolute_path("workspace/agent/instructions");
    let instructions_file = Path::new(&instructions_root)
        .join("INSTRUCTIONS.md")
        .to_string_lossy()
        .into_owned();
    let settings = runtime::parse_agent_config_with_profile_defaults(
        json!({
            "model": "gpt-6-luna",
            "modelReasoningEffort": "xhigh",
            "modelFallbacks": [],
            "timeoutSec": 0,
            "graceSec": 20,
            "search": true,
            "dangerouslyBypassApprovalsAndSandbox": true,
            "instructionsBundleMode": "external",
            "instructionsRootPath": instructions_root,
            "instructionsEntryFile": "AGENTS.md",
            "instructionsFilePath": instructions_file,
            "heartbeat": {"enabled": true}
        }),
        None,
        None,
        false,
        fixture_operator_home(),
        true,
    )
    .expect("supported Agent settings for the installed native Codex profile");

    assert_eq!(settings.model.as_deref(), Some("gpt-6-luna"));
    assert_eq!(settings.effort.as_deref(), Some("xhigh"));
    assert!(settings.search_enabled);
    assert!(settings.bypass_approvals_and_sandbox);
    assert_eq!(settings.capability_revision_input["searchEnabled"], true);
    assert_eq!(
        settings.capability_revision_input["bypassApprovalsAndSandbox"],
        true
    );
}

#[test]
fn native_profile_parser_fails_closed_on_unsupported_codex_agent_settings() {
    for config in [
        json!({"modelFallbacks":[{"agentRuntimeType":"claude_local","model":"x"}]}),
        json!({"timeoutSec":30}),
        json!({"timeoutSec":"0"}),
    ] {
        assert_http_error(
            runtime::parse_agent_config_with_profile_defaults(
                config,
                None,
                None,
                false,
                fixture_operator_home(),
                true,
            ),
            409,
            None,
        );
    }

    assert_http_error(
        runtime::parse_agent_config_with_profile_defaults(
            json!({"dangerouslyBypassApprovalsAndSandbox":true}),
            None,
            None,
            false,
            fixture_operator_home(),
            false,
        ),
        409,
        None,
    );
    assert_http_error(
        runtime::parse_agent_config_with_profile_defaults(
            json!({"search":true}),
            None,
            None,
            false,
            fixture_operator_home(),
            false,
        ),
        409,
        None,
    );
}

#[test]
fn native_profile_parser_rejects_nonempty_model_fallbacks() {
    for config in [
        json!({"modelFallbacks":[{"agentRuntimeType":"codex_local","model":"gpt-5.6-luna"}]}),
        json!({"modelFallbacks":null}),
        json!({"modelFallbacks":"none"}),
    ] {
        assert_http_error(
            runtime::parse_agent_config_with_profile_defaults(
                config,
                None,
                None,
                false,
                fixture_operator_home(),
                true,
            ),
            409,
            None,
        );
    }
}

#[test]
fn parser_rejects_plan_mode_until_native_protocol_mapping_is_verified() {
    for config in [json!({}), json!({"planMode": true})] {
        assert_http_error(
            runtime::parse_agent_config(config, None, None, true, fixture_operator_home()),
            409,
            None,
        );
    }
}

#[test]
fn parser_rejects_invalid_effort_and_non_text_or_unbounded_model_values() {
    for config in [
        json!({"search":false,"modelReasoningEffort":"thinking"}),
        json!({"search":false,"model":"  \n ","modelReasoningEffort":"high"}),
        json!({"search":false,"model":"x".repeat(257)}),
    ] {
        let result =
            runtime::parse_agent_config(config, None, None, false, fixture_operator_home());
        assert_http_error(result, 409, None);
    }
}

#[test]
fn parser_fails_closed_on_secret_refs_capabilities_and_unknown_policy() {
    let secret = "do-not-expose-this-secret";
    for (config, expected_secret) in [
        (json!({"env":{"TOKEN":secret}}), Some(secret)),
        (json!({"skills":["writing"]}), None),
        (json!({"mcpServers":{"private":{"command":"tool"}}}), None),
        (json!({"search":true}), None),
        (json!({"browser":{"enabled":true}}), None),
        (json!({"dangerouslyBypassApprovalsAndSandbox":true}), None),
        (
            json!({"dangerouslyBypassApprovalsAndSandbox":"false"}),
            None,
        ),
        (json!({"approvalPolicy":"never"}), None),
        (json!({"workspacePolicy":{"type":"git_worktree"}}), None),
        (json!({"instructionIncludes":["extra.md"]}), None),
        (json!({"unrecognizedSetting":"value"}), None),
        (json!({"promptTemplate":"private prompt"}), None),
    ] {
        let result =
            runtime::parse_agent_config(config, None, None, false, fixture_operator_home());
        assert_http_error(result, 409, expected_secret);
    }

    let no_secrets = parsed(
        json!({"env":null,"environment":{},"search":false}),
        None,
        None,
        false,
    );
    assert!(!no_secrets.search_enabled);
}

#[test]
fn parser_rejects_instruction_path_values_that_the_legacy_resolver_would_fallback() {
    for config in [
        json!({"search":false,"instructionsBundleMode":"typo"}),
        json!({"search":false,"instructionsEntryFile":"../outside.md"}),
        json!({"search":false,"instructionsEntryFile":"folder\\..\\outside.md"}),
        json!({"search":false,"instructionsFilePath":"legacy.md"}),
    ] {
        let result =
            runtime::parse_agent_config(config, None, None, false, fixture_operator_home());
        assert_http_error(result, 409, None);
    }
}

#[tokio::test]
#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn resolver_uses_locked_chat_agent_exact_issue_workspace_and_read_only_managed_profile() {
    use support::{CEO, Database, ORG, PROJECT};

    const CHAT: &str = "21000000-0000-4000-8000-000000000201";
    const ISSUE: &str = "22000000-0000-4000-8000-000000000201";
    const WORKSPACE: &str = "23000000-0000-4000-8000-000000000201";
    let database = Database::start().await;
    let temp = tempfile::tempdir().expect("isolated Native Chat host tree");
    let instance = temp.path().join("instance");
    let workspace_home = temp.path().join("workspaces");
    let previous_documents = temp.path().join("previous-documents");
    let profiles = temp.path().join("managed-profiles");
    let operator_home = temp.path().join("operator-home");
    let executable = temp.path().join("bin/codex");
    let issue_cwd = temp.path().join("project/repo");
    let agent_cwd = temp.path().join("agent-default");
    for directory in [
        &instance,
        &workspace_home,
        &profiles,
        &operator_home,
        executable.parent().expect("binary directory"),
        &issue_cwd,
        &agent_cwd,
    ] {
        fs::create_dir_all(directory).expect("create isolated host directory");
    }
    fs::write(&executable, b"test executable placeholder").expect("create placeholder executable");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755))
            .expect("mark placeholder executable");
    }
    let instance = instance.canonicalize().expect("canonical instance root");
    let workspace_home = workspace_home
        .canonicalize()
        .expect("canonical workspace home");
    let profiles = profiles.canonicalize().expect("canonical profile root");
    let operator_home = operator_home
        .canonicalize()
        .expect("canonical operator home");
    let executable = executable.canonicalize().expect("canonical executable");
    let issue_cwd = issue_cwd.canonicalize().expect("canonical issue workspace");
    let agent_cwd = agent_cwd.canonicalize().expect("canonical Agent cwd");
    let issue_cwd_text = issue_cwd.to_string_lossy().into_owned();

    let instruction_root = workspace_home
        .join("100000000000")
        .join("workspaces/agents/codex-agent/instructions");
    fs::create_dir_all(&instruction_root).expect("create managed Agent instruction bundle");
    fs::write(
        instruction_root.join("SOUL.md"),
        "private instruction marker  \n",
    )
    .expect("seed managed instruction");
    let profile_home = profiles.join(ORG).join(CEO).join("work");
    fs::create_dir_all(&profile_home).expect("create empty managed profile home");

    let host = LocalHostContext::from_rust_host(
        "test-host".into(),
        instance.clone(),
        workspace_home,
        previous_documents,
        false,
        profiles,
        operator_home.clone(),
        executable.clone(),
    )
    .expect("construct trusted isolated host context");

    let config = json!({
        "model": "gpt-5.6-luna",
        "modelReasoningEffort": "high",
        "profileId": "work",
        "command": executable.to_string_lossy(),
        "cwd": agent_cwd.to_string_lossy(),
        "instructionsBundleMode": "managed",
        "search": false,
        "dangerouslyBypassApprovalsAndSandbox": false,
    });
    sqlx::query(
        "UPDATE agents SET agent_runtime_type='codex_local', status='idle',
           workspace_key='codex-agent', agent_runtime_config=$1::jsonb
         WHERE org_id=$2::uuid AND id=$3::uuid",
    )
    .bind(config.to_string())
    .bind(ORG)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("seed Codex persisted Agent configuration");
    sqlx::query(
        "INSERT INTO project_workspaces
           (id, org_id, project_id, name, source_type, cwd, is_primary)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Chat workspace', 'local_path', $4, true)",
    )
    .bind(WORKSPACE)
    .bind(ORG)
    .bind(PROJECT)
    .bind(&issue_cwd_text)
    .execute(&database.pool)
    .await
    .expect("seed exact project workspace");
    sqlx::query(
        "INSERT INTO issues (id, org_id, project_id, project_workspace_id, title)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'Chat context issue')",
    )
    .bind(ISSUE)
    .bind(ORG)
    .bind(PROJECT)
    .bind(WORKSPACE)
    .execute(&database.pool)
    .await
    .expect("seed issue workspace identity");
    sqlx::query(
        "INSERT INTO chat_conversations
           (id, org_id, title, conversation_kind, created_by_user_id, status,
            preferred_agent_id, primary_issue_id, model_override, effort_override, plan_mode)
         VALUES ($1::uuid, $2::uuid, 'Config test', 'chat', 'config-test', 'active',
            $3::uuid, $4::uuid, 'vendor/custom-text-model', 'ultra', false)",
    )
    .bind(CHAT)
    .bind(ORG)
    .bind(CEO)
    .bind(ISSUE)
    .execute(&database.pool)
    .await
    .expect("seed Chat conversation and persisted overrides");

    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin config resolution");
    let resolved = resolve_codex_config(&mut tx, ORG, CHAT, &host)
        .await
        .expect("resolve trusted Codex runtime config");
    tx.commit().await.expect("commit read-only resolution tx");
    assert_eq!(resolved.identity.agent_id, CEO);
    assert_eq!(resolved.identity.runtime_type, "codex_local");
    assert_eq!(resolved.identity.host_id, "test-host");
    assert_eq!(
        resolved.identity.profile_id,
        format!("managed-codex:{CEO}:work")
    );
    assert_eq!(
        resolved.identity.workspace_binding_id.as_deref(),
        Some(WORKSPACE)
    );
    assert_eq!(resolved.cwd, issue_cwd);
    assert_eq!(resolved.executable, executable);
    assert_eq!(resolved.model.as_deref(), Some("vendor/custom-text-model"));
    assert_eq!(resolved.reasoning_effort.as_deref(), Some("ultra"));
    assert!(!resolved.plan_mode);
    assert!(!resolved.search_enabled);
    assert_eq!(
        resolved.profile.home,
        profile_home.canonicalize().expect("profile path")
    );
    assert_eq!(
        resolved.instruction_source_path.as_deref(),
        Some(instruction_root.as_path())
    );
    assert_eq!(resolved.instruction_entry_file, "SOUL.md");
    assert_eq!(
        resolved.instruction_content.as_deref(),
        Some("private instruction marker")
    );
    assert!(
        resolved
            .identity
            .instructions_revision
            .starts_with("sha256:")
    );
    assert!(
        !resolved
            .identity
            .instructions_revision
            .contains("private instruction marker")
    );
    assert_eq!(
        fs::read_dir(&instruction_root)
            .expect("read managed instructions")
            .count(),
        1,
        "resolution must not create or migrate instruction files"
    );

    // Native profile mode binds the already-provisioned per-Agent Codex home
    // without creating it, copying auth, or falling back to the synthetic
    // fixture profile. The profile config affects the opaque capability
    // revision but its content is never returned.
    let native_host_without_path = host.clone().with_native_codex_profile();
    let native_home = instance
        .join("organizations/100000000000/codex-home/agents")
        .join(CEO);
    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin missing trusted PATH resolution");
    let missing_path = resolve_codex_config(&mut tx, ORG, CHAT, &native_host_without_path).await;
    assert_http_error(missing_path, 409, None);
    tx.rollback()
        .await
        .expect("rollback missing trusted PATH resolution");

    let native_host = host
        .clone()
        .with_native_codex_profile()
        .with_executable_search_path("/opt/homebrew/bin:/usr/bin:/bin".into())
        .expect("bind trusted executable search path");
    assert!(
        host.clone()
            .with_executable_search_path("relative/path:/bin".into())
            .is_err(),
        "trusted executable search path must not contain relative entries"
    );
    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin missing native profile resolution");
    let missing_profile = resolve_codex_config(&mut tx, ORG, CHAT, &native_host).await;
    assert_http_error(missing_profile, 409, None);
    tx.rollback()
        .await
        .expect("rollback missing native profile resolution");
    assert!(!native_home.exists(), "resolver must not create a profile");

    fs::create_dir_all(&native_home).expect("create test-owned existing Codex home");
    fs::write(
        native_home.join("config.toml"),
        "approval_policy = \"on-request\"\nsandbox_mode = \"read-only\"\n[features]\nplugins = true\n[mcp_servers.local_tools]\ncommand = \"/opt/tools/mcp-server\"\n",
    )
    .expect("write test-owned selected Codex config");
    sqlx::query(
        "UPDATE agents SET agent_runtime_config=$1::jsonb WHERE org_id=$2::uuid AND id=$3::uuid",
    )
    .bind(
        json!({
            "heartbeat": {
                "enabled": true,
                "intervalSec": 300,
                "maxConcurrentRuns": 2,
                "preflightEnabled": true,
                "wakeOnDemand": true,
            }
        })
        .to_string(),
    )
    .bind(ORG)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("seed scheduler-only Agent settings");
    sqlx::query("UPDATE chat_conversations SET model_override=NULL, effort_override=NULL WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(ORG)
        .bind(CHAT)
        .execute(&database.pool)
        .await
        .expect("remove explicit Chat model and effort for profile inheritance");
    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin native profile resolution");
    let native = resolve_codex_config(&mut tx, ORG, CHAT, &native_host)
        .await
        .expect("resolve selected native Codex profile");
    tx.commit().await.expect("commit native profile resolution");
    assert!(native.profile.native_managed);
    assert_eq!(native.profile.home, native_home.canonicalize().unwrap());
    assert_eq!(
        native.model, None,
        "no synthetic model may override the selected profile"
    );
    assert_eq!(
        native.reasoning_effort, None,
        "no synthetic effort may override the selected profile"
    );
    assert_eq!(native.operator_home, operator_home);
    assert_eq!(
        native.executable_search_path,
        "/opt/homebrew/bin:/usr/bin:/bin"
    );
    assert!(!native.identity.capability_revision.contains("mcp-server"));
    let native_profile_revision = native.identity.capability_revision;

    fs::write(
        native_home.join("config.toml"),
        "approval_policy = \"never\"\nsandbox_mode = \"danger-full-access\"\n[features]\nplugins = true\n[mcp_servers.local_tools]\ncommand = \"/opt/tools/mcp-server\"\n",
    )
    .expect("seed test-owned selected Codex policy and extensions");
    let selected_agent_settings = json!({
        "model": "gpt-6-luna",
        "modelReasoningEffort": "xhigh",
        "modelFallbacks": [],
        "timeoutSec": 0,
        "graceSec": 20,
        "search": true,
        "dangerouslyBypassApprovalsAndSandbox": true,
        "instructionsBundleMode": "managed",
        "heartbeat": {"enabled": true},
    });
    sqlx::query(
        "UPDATE agents SET agent_runtime_config=$1::jsonb WHERE org_id=$2::uuid AND id=$3::uuid",
    )
    .bind(selected_agent_settings.to_string())
    .bind(ORG)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("seed supported selected Codex Agent settings");
    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin configured native profile resolution");
    let configured_native = resolve_codex_config(&mut tx, ORG, CHAT, &native_host)
        .await
        .expect("resolve supported selected Agent settings");
    tx.commit()
        .await
        .expect("commit configured native profile resolution");
    assert_eq!(configured_native.model.as_deref(), Some("gpt-6-luna"));
    assert_eq!(configured_native.reasoning_effort.as_deref(), Some("xhigh"));
    assert!(configured_native.search_enabled);
    assert!(configured_native.bypass_approvals_and_sandbox);
    assert_ne!(
        configured_native.identity.capability_revision, native_profile_revision,
        "explicit profile and Agent policy must be bound into runtime identity"
    );

    fs::write(
        native_home.join("config.toml"),
        "approval_policy = \"on-request\"\nsandbox_mode = \"read-only\"\n[features]\nplugins = true\n",
    )
    .expect("update test-owned selected Codex config");
    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin changed native profile resolution");
    let changed_native = resolve_codex_config(&mut tx, ORG, CHAT, &native_host)
        .await
        .expect("resolve changed selected native Codex profile");
    tx.commit()
        .await
        .expect("commit changed native profile resolution");
    assert_ne!(
        changed_native.identity.capability_revision, native_profile_revision,
        "selected Codex config changes must alter the effective capability revision"
    );

    // An explicit operator profile uses its existing native credentials in
    // place; neither absence nor selection can provision/copy authentication.
    let operator_profile = operator_home.join(".codex");
    fs::create_dir(&operator_profile).expect("create test-owned operator profile");
    fs::write(
        operator_profile.join("config.toml"),
        "approval_policy = \"on-request\"\nsandbox_mode = \"read-only\"\n",
    )
    .unwrap();
    let auth_marker = b"test-owned native auth marker, never a real credential";
    fs::write(operator_profile.join("auth.json"), auth_marker).unwrap();
    sqlx::query("UPDATE agents SET agent_runtime_config='{\"profileId\":\"operator-default\"}'::jsonb WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(ORG).bind(CEO).execute(&database.pool).await.unwrap();
    let mut tx = database.pool.begin().await.unwrap();
    assert_http_error(
        resolve_codex_config(&mut tx, ORG, CHAT, &native_host).await,
        409,
        None,
    );
    tx.rollback().await.unwrap();
    let operator_host = native_host
        .clone()
        .with_operator_codex_profile(operator_profile.clone())
        .unwrap();
    let mut tx = database.pool.begin().await.unwrap();
    let operator_native = resolve_codex_config(&mut tx, ORG, CHAT, &operator_host)
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    assert_eq!(
        operator_native.profile.home,
        operator_profile.canonicalize().unwrap()
    );
    assert_eq!(
        operator_native.identity.profile_id,
        format!("managed-codex:{CEO}:operator-default")
    );
    assert_ne!(
        operator_native.identity.capability_revision,
        changed_native.identity.capability_revision
    );
    assert_eq!(
        fs::read(operator_profile.join("auth.json")).unwrap(),
        auth_marker
    );
    assert!(
        !native_home.join("auth.json").exists(),
        "operator auth must not be copied into the Agent profile"
    );
    sqlx::query("UPDATE agents SET agent_runtime_config='{\"profileId\":\"unknown-native\"}'::jsonb WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(ORG).bind(CEO).execute(&database.pool).await.unwrap();
    let mut tx = database.pool.begin().await.unwrap();
    assert_http_error(
        resolve_codex_config(&mut tx, ORG, CHAT, &operator_host).await,
        409,
        None,
    );
    tx.rollback().await.unwrap();

    sqlx::query(
        "UPDATE agents SET agent_runtime_config=$1::jsonb WHERE org_id=$2::uuid AND id=$3::uuid",
    )
    .bind(config.to_string())
    .bind(ORG)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("restore explicit Agent settings for remaining resolver assertions");
    sqlx::query("UPDATE chat_conversations SET model_override='vendor/custom-text-model', effort_override='ultra' WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(ORG)
        .bind(CHAT)
        .execute(&database.pool)
        .await
        .expect("restore explicit Chat overrides");

    let before_revision = resolved.identity.instructions_revision.clone();
    fs::write(
        instruction_root.join("SOUL.md"),
        "updated private instruction marker",
    )
    .expect("update managed instruction");
    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin changed instruction resolution");
    let changed = resolve_codex_config(&mut tx, ORG, CHAT, &host)
        .await
        .expect("resolve changed instruction revision");
    tx.commit().await.expect("commit changed resolution tx");
    assert_ne!(changed.identity.instructions_revision, before_revision);

    let literal_entry = "Use {{ context.rudderResourcesPrompt }} as a literal example.\n!include relative-instructions.md";
    fs::write(instruction_root.join("SOUL.md"), literal_entry)
        .expect("seed literal instruction examples");
    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin literal instruction resolution");
    let literal = resolve_codex_config(&mut tx, ORG, CHAT, &host)
        .await
        .expect("instruction text retains legacy raw-text behavior");
    assert_eq!(literal.instruction_content.as_deref(), Some(literal_entry));
    tx.rollback()
        .await
        .expect("rollback literal instruction transaction");
    let unicode_entry = "你好，Codex 🌱\n";
    fs::write(instruction_root.join("SOUL.md"), unicode_entry)
        .expect("seed valid UTF-8 selected instruction");
    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin valid UTF-8 instruction resolution");
    let unicode = resolve_codex_config(&mut tx, ORG, CHAT, &host)
        .await
        .expect("selected UTF-8 instruction resolves");
    assert_eq!(
        unicode.instruction_content.as_deref(),
        Some("你好，Codex 🌱")
    );
    tx.rollback()
        .await
        .expect("rollback valid UTF-8 instruction transaction");
    fs::write(
        instruction_root.join("SOUL.md"),
        "updated private instruction marker",
    )
    .expect("restore valid instruction entry");
    fs::write(instruction_root.join("SOUL.md"), [0xff, 0xfe])
        .expect("seed non-UTF-8 instruction entry");
    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin rejected non-UTF-8 instruction resolution");
    let rejected = resolve_codex_config(&mut tx, ORG, CHAT, &host).await;
    assert_http_error(rejected, 409, None);
    tx.rollback()
        .await
        .expect("rollback rejected non-UTF-8 instruction transaction");
    fs::write(
        instruction_root.join("SOUL.md"),
        "updated private instruction marker",
    )
    .expect("restore valid instruction entry after UTF-8 test");

    let oversized = instruction_root.join("oversized-sparse.md");
    let oversized_file = fs::File::create(&oversized).expect("create sparse instruction file");
    oversized_file
        .set_len(1_048_577)
        .expect("extend sparse instruction file beyond limit");
    drop(oversized_file);
    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin oversized sparse bundle resolution");
    let rejected = resolve_codex_config(&mut tx, ORG, CHAT, &host).await;
    assert_http_error(rejected, 409, None);
    tx.rollback()
        .await
        .expect("rollback oversized sparse bundle resolution");
    fs::remove_file(&oversized).expect("remove sparse instruction file");

    let outside = temp.path().join("outside-instruction.md");
    fs::write(&outside, "outside content must not be read").expect("write outside target");
    let symlink = instruction_root.join("linked.md");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, &symlink).expect("create bundle symlink");
    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin symlink bundle resolution");
    let rejected = resolve_codex_config(&mut tx, ORG, CHAT, &host).await;
    assert_http_error(rejected, 409, None);
    tx.rollback()
        .await
        .expect("rollback symlink bundle resolution");
    fs::remove_file(&symlink).expect("remove bundle symlink");

    // The selected entry is one entry; adding the cap number of child
    // directories exceeds the aggregate entry cap.
    for index in 0..4_096 {
        fs::create_dir(instruction_root.join(format!("entry-dir-{index}")))
            .expect("create counted directory entry");
    }
    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin excessive directory-entry bundle resolution");
    let rejected = resolve_codex_config(&mut tx, ORG, CHAT, &host).await;
    assert_http_error(rejected, 409, None);
    tx.rollback()
        .await
        .expect("rollback excessive directory-entry bundle resolution");
    for index in 0..4_096 {
        fs::remove_dir(instruction_root.join(format!("entry-dir-{index}")))
            .expect("remove counted directory entry");
    }

    sqlx::query("UPDATE agents SET agent_runtime_config=$1::jsonb WHERE id=$2::uuid")
        .bind(json!({"env":{"TOKEN":"test-secret-value"},"search":false}).to_string())
        .bind(CEO)
        .execute(&database.pool)
        .await
        .expect("seed unsupported Secret reference");
    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin rejected config resolution");
    let rejected = resolve_codex_config(&mut tx, ORG, CHAT, &host).await;
    assert_http_error(rejected, 409, Some("test-secret-value"));
    tx.rollback()
        .await
        .expect("rollback rejected read transaction");

    sqlx::query("UPDATE projects SET execution_workspace_policy=$1::jsonb WHERE id=$2::uuid")
        .bind(json!({"mode":"isolated"}).to_string())
        .bind(PROJECT)
        .execute(&database.pool)
        .await
        .expect("seed unsupported project workspace policy");
    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin rejected workspace policy resolution");
    let rejected = resolve_codex_config(&mut tx, ORG, CHAT, &host).await;
    assert_http_error(rejected, 409, None);
}
