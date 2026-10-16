use super::{LocalHostContext, resolve_codex_config, runtime};
use crate::runtime_bindings::Error;
use serde_json::{Value, json};
use std::{fs, path::Path};

#[allow(dead_code)]
#[path = "../../../tests/support/mod.rs"]
mod support;

fn parsed(
    config: Value,
    model: Option<String>,
    effort: Option<String>,
    plan: bool,
) -> runtime::RuntimeSettings {
    match runtime::parse_agent_config(config, model, effort, plan, Path::new("/operator")) {
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
        "planMode": true,
    });
    let settings = parsed(
        config,
        Some("vendor/custom-text-model".into()),
        Some("ultra".into()),
        true,
    );
    assert_eq!(settings.model.as_deref(), Some("vendor/custom-text-model"));
    assert_eq!(settings.effort.as_deref(), Some("ultra"));
    assert!(settings.plan_mode);
    assert!(!settings.search_enabled);

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
fn parser_rejects_invalid_effort_and_non_text_or_unbounded_model_values() {
    for config in [
        json!({"search":false,"modelReasoningEffort":"thinking"}),
        json!({"search":false,"model":"  \n ","modelReasoningEffort":"high"}),
        json!({"search":false,"model":"x".repeat(257)}),
    ] {
        let result = runtime::parse_agent_config(config, None, None, false, Path::new("/operator"));
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
        let result = runtime::parse_agent_config(config, None, None, false, Path::new("/operator"));
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
        let result = runtime::parse_agent_config(config, None, None, false, Path::new("/operator"));
        assert_http_error(result, 409, None);
    }
}

#[tokio::test]
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
        instance,
        workspace_home,
        previous_documents,
        false,
        profiles,
        operator_home,
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
            $3::uuid, $4::uuid, 'vendor/custom-text-model', 'ultra', true)",
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
    assert!(resolved.plan_mode);
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
