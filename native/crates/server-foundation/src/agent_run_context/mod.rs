//! Materialized context for generic persisted Agent Runs. This module owns no
//! Run lifecycle, database mutation, launch permit or settlement authority.
//! Source contract: Node `agent-run-context.ts`, `heartbeat.execute.ts` and the
//! provider adapters. Prepared files live until the worker drops the invocation
//! after executor cleanup and durable terminal settlement.
mod artifacts;
mod gateways;
mod git_identity;
mod hermes_local;
mod invocation;
mod operation_log;
mod pi_models;
mod profiles;
mod prompts;
mod realization;
mod services;
mod skill_boundaries;
mod skills;
mod workspace;

use crate::{
    goal_run_context::prepare_instruction_runtime_context,
    native_agent_jwt::{NativeAgentJwtConfig, sign_local_agent_jwt},
};
use artifacts::InvocationArtifacts;
use rudder_d1_persistence::{
    agent_core::{self, OrganizationWorkspaceHost},
    agent_execution::AgentRunClaim,
    agent_run_context::{load_agent_run_resources, resolve_agent_run_config},
    goal_run_resources::load_agent_startup_resources,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};
pub(crate) use workspace::AgentWorkspacePreparation;

/// Installation facts supplied by the host, never deserialized from a wakeup.
pub(crate) struct AgentRunContextHost {
    pub deployment_mode: String,
    /// Raw operator environment supplied by the trusted installation host.
    /// Runtime-specific filtering and managed overrides are applied below.
    pub environment: BTreeMap<String, String>,
    pub desktop_brokers: std::sync::Arc<crate::desktop_broker::DesktopBrokers>,
    pub workspace: OrganizationWorkspaceHost,
    pub operator_home: PathBuf,
    pub process_cwd: PathBuf,
    pub executable_search_path: String,
    pub runtime_root: PathBuf,
    pub rudder_cli: PathBuf,
    pub process_host: PathBuf,
    pub api_url: String,
    pub bundled_skills_root: Option<PathBuf>,
}

/// Deliberately no Debug/Serialize: env/config can contain resolved secrets.
pub(crate) struct PreparedAgentInvocation {
    pub prompt: String,
    pub context: Value,
    pub config: Value,
    pub attempt_config_template: Value,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    pub secret_keys: BTreeSet<String>,
    pub managed_args: Vec<String>,
    pub runtime_skills: Vec<Value>,
    _artifacts: InvocationArtifacts,
    service_lease: services::RuntimeServiceLease,
}

#[derive(Clone)]
pub(super) struct ContextLogSink {
    sender:
        Option<tokio::sync::mpsc::Sender<rudder_native_chat_executor::agent_run::AgentRunOutput>>,
    ordinal: std::sync::Arc<std::sync::atomic::AtomicU64>,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    censor_username: bool,
}
impl ContextLogSink {
    pub fn blocking_log(&self, source: &str, stream: &str, chunk: &str) {
        let chunk = rudder_d1_persistence::agent_run_context::redact_context_log(
            chunk,
            self.censor_username,
        );
        if let Some(sender) = self.sender.as_ref() {
            let event = rudder_native_chat_executor::agent_run::AgentRunOutput::Event {
                offset: self
                    .ordinal
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                event: json!({"type":"rudder.context.log","source":source,"stream":stream,"chunk":chunk}),
            };
            if sender.blocking_send(event).is_err() {
                self.cancelled
                    .store(true, std::sync::atomic::Ordering::Release);
            }
        }
    }
    pub async fn log(&self, source: &str, stream: &str, chunk: &str) {
        let chunk = rudder_d1_persistence::agent_run_context::redact_context_log(
            chunk,
            self.censor_username,
        );
        if let Some(sender) = self.sender.as_ref() {
            let event = rudder_native_chat_executor::agent_run::AgentRunOutput::Event {
                offset: self
                    .ordinal
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                event: json!({"type":"rudder.context.log","source":source,"stream":stream,"chunk":chunk}),
            };
            if sender.send(event).await.is_err() {
                self.cancelled
                    .store(true, std::sync::atomic::Ordering::Release);
            }
        }
    }
}

impl PreparedAgentInvocation {
    /// Call immediately before the SDK may consume its one-use launch permit.
    /// A worker interruption thereafter must leave files for exact recovery.
    pub fn mark_provider_launch_possible(&mut self) {
        self._artifacts.mark_provider_launch_possible();
    }
    pub async fn finish(
        &mut self,
        pool: &PgPool,
        claim: &AgentRunClaim,
        proof: &rudder_native_chat_executor::agent_run::AgentRunCleanupProof,
    ) -> Result<(), ContextError> {
        let matches = match proof {
            rudder_native_chat_executor::agent_run::AgentRunCleanupProof::Process(proof) => {
                claim.owned.matches_process_cleanup(proof)
            }
            rudder_native_chat_executor::agent_run::AgentRunCleanupProof::Request(proof) => {
                proof.matches(&claim.owned)
            }
        };
        if !matches {
            return Err(ContextError::Invalid(
                "Agent context cleanup proof does not match its Run/Attempt",
            ));
        }
        self.service_lease.release(pool).await?;
        self._artifacts.cleanup_confirmed();
        Ok(())
    }
    /// SDK rejected input while its exact one-use launch permit remained
    /// unspent. Validate durable no-process state before releasing context.
    pub async fn abort_unlaunched(
        &mut self,
        pool: &PgPool,
        claim: &AgentRunClaim,
    ) -> Result<(), ContextError> {
        if !claim.owned.launch_permit_unspent() {
            return Err(ContextError::Invalid("Agent launch permit was consumed"));
        }
        rudder_d1_persistence::agent_run_context::assert_unlaunched_context_owner(pool, claim)
            .await?;
        self.service_lease.release(pool).await?;
        self._artifacts.cleanup_confirmed();
        Ok(())
    }
    /// Only valid before provider launch; service startup can already have
    /// happened while preparing and must be joined even on a rejected config.
    pub async fn abort_before_provider(&mut self, pool: &PgPool) -> Result<(), ContextError> {
        if self._artifacts.may_have_launched() {
            return Err(ContextError::Invalid(
                "Agent provider cleanup proof is required before releasing context",
            ));
        }
        self.service_lease.release(pool).await?;
        self._artifacts.cleanup_confirmed();
        Ok(())
    }
}

pub(crate) async fn finish_persisted_agent_run_context(
    pool: &PgPool,
    org: &str,
    run: &str,
    runtime_root: &Path,
) -> Result<(), ContextError> {
    services::finish_persisted(pool, org, run, runtime_root).await?;
    for attempt in
        rudder_d1_persistence::agent_run_context::releasable_context_attempts(pool, org, run)
            .await?
    {
        let directory = runtime_root.join("agent-context").join(run).join(attempt);
        match fs::remove_dir_all(directory) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum ContextError {
    #[error("{0}")]
    Invalid(&'static str),
    #[error("Agent Run context preparation was cancelled")]
    Cancelled,
    #[error("Workspace command failed: {0}")]
    Command(String),
    #[error("Agent workspace preparation could not be persisted")]
    Workspace(#[from] rudder_d1_persistence::agent_run_workspace::AgentRunWorkspaceError),
    #[error("Agent runtime context storage is unavailable")]
    Storage(#[from] std::io::Error),
    #[error("Agent runtime context database read failed")]
    Database(#[from] rudder_d1_persistence::StoreError),
}

pub(crate) async fn prepare_agent_run_invocation(
    pool: &PgPool,
    claim: &AgentRunClaim,
    host: &AgentRunContextHost,
    identity: &NativeAgentJwtConfig,
    cancelled: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    output: Option<
        tokio::sync::mpsc::Sender<rudder_native_chat_executor::agent_run::AgentRunOutput>,
    >,
) -> Result<PreparedAgentInvocation, ContextError> {
    if !claim.agent_context.is_object()
        || !claim.context_snapshot.is_object()
        || !host.operator_home.is_absolute()
        || !host.process_cwd.is_absolute()
        || !host.runtime_root.is_absolute()
        || !host.rudder_cli.is_absolute()
        || !host.process_host.is_absolute()
    {
        return Err(ContextError::Invalid("Invalid trusted Agent Run context"));
    }
    if cancelled.load(std::sync::atomic::Ordering::Acquire) {
        return Err(ContextError::Cancelled);
    }
    let mut output = ContextLogSink {
        sender: output,
        ordinal: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
        cancelled: std::sync::Arc::clone(cancelled),
        censor_username: false,
    };
    let bundled = skills::bundled_catalog(host)?;
    rudder_d1_persistence::agent_run_context::reconcile_agent_run_skills(pool, claim, &bundled)
        .await?;
    let mut resources = load_agent_run_resources(
        pool,
        &claim.organization_id,
        &claim.agent_id,
        &claim.context_snapshot,
    )
    .await?;
    output.censor_username = resources.general_settings["censorUsernameInLogs"] == true;
    resources.managed_mcp_bindings =
        rudder_d1_persistence::managed_mcp_runtime::resolve_runtime_bindings(
            pool,
            &claim.organization_id,
            &claim.agent_id,
        )
        .await
        .map_err(|_| ContextError::Invalid("Managed MCP policy could not be prepared"))?;
    rudder_d1_persistence::agent_run_context::persist_prepared_policy(
        pool,
        claim,
        &resources.managed_mcp_bindings,
    )
    .await?;
    let mut config = rudder_d1_persistence::agent_run_context::materialize_agent_run_instructions(
        pool,
        claim,
        &host.workspace,
        &host.operator_home,
        &host.process_cwd,
    )
    .await?;
    if !config.is_object() {
        config = json!({});
    }
    let mode = workspace::apply_policy(&mut config, &resources, &claim.agent_id);
    let attempt_config_template = config.clone();
    if let Some(effective) = claim.effective_attempt_config.as_ref() {
        config = effective.clone();
    } else if claim.model_attempt_index > 0 {
        let primary = text(&claim.agent_context, "agentRuntimeType").unwrap_or(&claim.runtime_type);
        let attempts = rudder_d1_persistence::agent_execution::model_attempts::build(
            &attempt_config_template,
            primary,
        );
        config = attempts
            .into_iter()
            .find(|attempt| attempt.index == claim.model_attempt_index)
            .ok_or(ContextError::Invalid(
                "Persisted model attempt configuration is unavailable",
            ))?
            .config;
    }
    let resolved = resolve_agent_run_config(pool, &claim.organization_id, &config).await?;
    config = resolved.config;
    let service_config = config.clone();
    let configured_cwd = config.get("cwd").cloned();
    let mut agent = claim.agent_context.clone();
    agent["id"] = json!(claim.agent_id);
    agent["orgId"] = json!(claim.organization_id);
    agent["name"] = json!(claim.agent_name);
    agent["agentRuntimeType"] = json!(claim.runtime_type);
    let mut instruction_agent = agent.clone();
    instruction_agent["agentRuntimeConfig"] = config.clone();
    let organization_root = agent_core::ensure_organization_workspace_layout(
        &host.workspace,
        &host.process_cwd,
        &claim.organization_id,
    )?;
    let initial_instructions = agent_core::resolve_agent_runtime_instructions(
        &host.workspace,
        &claim.organization_id,
        &instruction_agent,
        &host.operator_home,
        &host.process_cwd,
    )?;
    let agent_home = initial_instructions.agent_home;
    for directory in ["instructions", "memory", "life", "skills"] {
        fs::create_dir_all(agent_home.join(directory))?;
    }
    let normalized_session = claim.session_params_before.as_ref().and_then(|raw| {
        rudder_native_chat_executor::agent_run::normalize_agent_session(&claim.runtime_type, raw)
    });
    let mut workspace = workspace::select(
        &resources,
        &claim.context_snapshot,
        normalized_session.as_ref(),
        &config,
        host,
        &agent_home,
        &organization_root,
        mode,
    )?;
    let realized = realization::realize(
        pool,
        claim,
        &mut workspace,
        &resources,
        &config,
        host,
        cancelled,
        &resolved.secret_keys,
    )
    .await?;
    // The adapter must use the selected project/session directory; user config
    // cwd only wins over Agent home, already handled by workspace selection.
    let workspace_aware = matches!(
        claim.runtime_type.as_str(),
        "claude_local" | "codex_local" | "cursor" | "opencode_local" | "pi_local"
    );
    let invocation_cwd = if workspace_aware {
        workspace.cwd.clone()
    } else {
        let configured = configured_cwd
            .as_ref()
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .or_else(|| text(&config, "workspaceDir"));
        configured
            .map(|value| realization::resolve_path(value, &host.process_cwd, &host.operator_home))
            .unwrap_or_else(|| host.process_cwd.clone())
    };
    config["cwd"] = json!(invocation_cwd);
    instruction_agent["agentRuntimeConfig"] = config.clone();
    let instructions = agent_core::resolve_agent_runtime_instructions(
        &host.workspace,
        &claim.organization_id,
        &instruction_agent,
        &host.operator_home,
        &workspace.cwd,
    )?;
    let mut startup_scope = claim.context_snapshot.clone();
    if let Some(issue) = resources.issue.as_ref() {
        startup_scope["projectId"] = issue["projectId"].clone();
    }
    let recent = load_agent_startup_resources(
        pool,
        &claim.organization_id,
        &claim.agent_id,
        &agent_home.join("memory"),
        &startup_scope,
    )
    .await?;
    let project_prompt = project_resources_prompt(&resources.project_resources);
    let resources_prompt = [
        project_prompt.as_str(),
        recent.org_resources_prompt.as_str(),
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n");
    let mut context = claim.context_snapshot.clone();
    if let Some(issue) = resources.issue.as_ref() {
        // Rich persisted Issue wake fields stay present; fresh workspace and
        // current assignee override facts are never taken from public JSON.
        context["issueId"] = issue["id"].clone();
        if !context["issue"].is_object() {
            context["issue"] = issue.clone();
        }
    }
    let scene = resolve_scene(claim, &context).to_owned();
    context["scene"] = json!(scene);
    context["rudderScene"] = json!(scene);
    if text(&context, "wakeReason").is_none() {
        context["wakeReason"] = json!(claim.reason.as_deref().unwrap_or("manual"));
    }
    if text(&context, "wakeSource").is_none() {
        context["wakeSource"] = json!(claim.invocation_source);
    }
    if text(&context, "wakeTriggerDetail").is_none() {
        context["wakeTriggerDetail"] = json!(claim.trigger_detail);
    }
    let (library_path, library_root) = project_library(&resources.project, &organization_root)?;
    context["rudderWorkspace"] = json!({"cwd":workspace.cwd,"source":workspace.source,"mode":workspace.mode,
        "strategy":workspace.strategy.get("type"),"projectId":workspace.project_id,"workspaceId":workspace.workspace_id,
        "repoUrl":workspace.repo_url,"repoRef":workspace.repo_ref,"branchName":realized.branch_name,"worktreePath":realized.worktree_path,
        "executionWorkspaceCwd":workspace.cwd,"executionWorkspaceSource":workspace.source,
        "agentHome":agent_home,"agentRoot":agent_home,"instructionsDir":agent_home.join("instructions"),
        "memoryDir":agent_home.join("memory"),"lifeDir":agent_home.join("life"),"agentSkillsDir":agent_home.join("skills"),
        "orgWorkspaceRoot":organization_root,"orgAgentsDir":organization_root.join("agents"),"orgSkillsDir":organization_root.join("skills"),
        "projectLibraryRoot":library_root,"projectLibraryRelativePath":library_path,
        "resourcesPrompt":resources_prompt,"orgResourcesPrompt":resources_prompt});
    context["rudderResourcesPrompt"] = json!(resources_prompt);
    context["rudderResources"] = json!(resources.project_resources);
    context["rudderProjectResources"] = context["rudderResources"].clone();
    context["rudderOrganizationResources"] = json!([]);
    context["rudderOrgNotes"] = json!("");
    context["rudderWorkspaces"] = json!(workspace.workspace_hints);
    context["rudderRuntimeServiceIntents"] = json!(workspace.runtime_service_intents);
    context["rudderStartupContext"] = recent.startup_context.clone();
    context["rudderStartupContextMetrics"] = recent.startup_context["metrics"].clone();
    context["managedMcpPolicySnapshot"] = json!(resources.managed_mcp_bindings);
    if !resources.managed_mcp_bindings.is_empty()
        && !matches!(
            claim.runtime_type.as_str(),
            "claude_local" | "codex_local" | "opencode_local" | "pi_local"
        )
    {
        context["rudderManagedMcpAvailability"] = json!({"available":false,"reason":"runtime_transport_unsupported","bindingCount":resources.managed_mcp_bindings.len()});
        output.log("mcp","stderr","[rudder] This runtime transport does not expose managed MCP tools; its frozen binding policy is retained.\n").await;
    }
    // These capability flags use the native public brokers and Rust MCP CLI.
    // Availability follows the existing per-runtime Desktop contract.
    let browser_requested = host.deployment_mode == "local_trusted"
        && resources.browser_settings["enabled"] != false
        && matches!(
            claim.runtime_type.as_str(),
            "claude_local" | "codex_local" | "opencode_local" | "pi_local"
        );
    let computer_requested = host.deployment_mode == "local_trusted"
        && resources.general_settings["experimentalComputerUseEnabled"] == true
        && claim.runtime_type == "codex_local"
        && host.desktop_brokers.computer.is_available();
    config["rudderBrowserEnabled"] = json!(browser_requested);
    config["rudderComputerEnabled"] = json!(computer_requested);
    let artifacts =
        InvocationArtifacts::create(&host.runtime_root, &claim.run_id, &claim.attempt_id)?;
    skills::restore_selected_packages(
        pool,
        claim,
        &mut resources,
        &organization_root,
        &artifacts,
        cancelled,
        &output,
    )
    .await?;
    let mut skills = artifacts::realize_skills(
        &resources,
        &config,
        &claim.runtime_type,
        &agent_home,
        &organization_root,
        host,
        &artifacts,
    )?;
    for warning in &skills.warnings {
        output.log("skills", "stderr", warning).await;
    }
    skills.prompt = skill_boundaries::render(&claim.runtime_type, &skills.entries)?;
    config["rudderRuntimeSkills"] = json!(skills.entries);
    config["paperclipRuntimeSkills"] = config["rudderRuntimeSkills"].clone();
    let desired = skills
        .entries
        .iter()
        .map(|entry| entry["key"].clone())
        .collect::<Vec<_>>();
    config["rudderSkillSync"] = json!({"desiredSkills":desired});
    config["paperclipSkillSync"] = config["rudderSkillSync"].clone();
    let (_prompt_context, mut instruction_sections) =
        prepare_instruction_runtime_context(context.clone());
    if !skills.prompt.is_empty() {
        instruction_sections.push(skills.prompt.clone());
    }
    let include_heartbeat = scene == "heartbeat"
        && !matches!(
            text(&context, "wakeReason"),
            Some("issue_commented" | "issue_comment_mentioned" | "issue_reopened_via_comment")
        );
    let instruction_text = rudder_native_chat_executor::compose_agent_instruction_context(
        instructions.entry_content.as_deref(),
        instructions.source_path.as_deref(),
        &instructions.entry_file,
        &instructions.sibling_content,
        &instruction_sections,
        include_heartbeat,
    )
    .map_err(|_| ContextError::Invalid("Agent instruction context could not be composed"))?;
    let instructions_path = artifacts.write("agent-instructions.md", &instruction_text)?;
    let mut env = host.environment.clone();
    // First-party runtime identity always wins over a persisted env binding.
    for (key, value) in config["env"].as_object().into_iter().flatten() {
        if let Some(value) = value.as_str() {
            env.insert(key.clone(), value.into());
        }
    }
    env.insert("PATH".into(), host.executable_search_path.clone());
    if let Some(parent) = host.rudder_cli.parent() {
        let mut paths = vec![parent.to_path_buf()];
        paths.extend(std::env::split_paths(&host.executable_search_path));
        env.insert(
            "PATH".into(),
            std::env::join_paths(paths)
                .map_err(|_| ContextError::Invalid("Invalid trusted executable search path"))?
                .to_string_lossy()
                .into_owned(),
        );
    }
    install_environment(
        &mut env,
        claim,
        &context,
        host,
        &agent_home,
        &artifacts.root,
    );
    if !matches!(
        claim.runtime_type.as_str(),
        "claude_local"
            | "codex_local"
            | "cursor"
            | "opencode_local"
            | "pi_local"
            | "hermes_local"
            | "http"
            | "openclaw_gateway"
            | "hermes_gateway"
    ) {
        // The existing process/unknown adapter applies configured env last.
        for (key, value) in config["env"].as_object().into_iter().flatten() {
            if let Some(value) = value.as_str() {
                env.insert(key.clone(), value.into());
            }
        }
    }
    let mut secret_keys = resolved.secret_keys;
    if matches!(
        claim.runtime_type.as_str(),
        "claude_local" | "codex_local" | "cursor" | "opencode_local" | "pi_local"
    ) {
        let api_key = sign_local_agent_jwt(
            &claim.agent_id,
            &claim.organization_id,
            &claim.runtime_type,
            &claim.run_id,
            identity,
        )
        .ok_or(ContextError::Invalid(
            "Local Agent JWT signing is unavailable",
        ))?;
        env.insert("RUDDER_API_KEY".into(), api_key);
        secret_keys.insert("RUDDER_API_KEY".into());
    }
    if claim.runtime_type == "claude_local" {
        let settings = fs::read(host.operator_home.join(".claude/settings.json"))
            .ok()
            .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok());
        if let Some(settings) = settings {
            for (key, value) in settings["env"].as_object().into_iter().flatten() {
                if (key.starts_with("ANTHROPIC_") || key.starts_with("DEEPSEEK_"))
                    && value.as_str().is_some_and(|v| !v.trim().is_empty())
                {
                    env.entry(key.clone())
                        .or_insert_with(|| value.as_str().unwrap().into());
                    secret_keys.insert(key.clone());
                }
            }
        }
    }
    let profile_root = profiles::prepare(
        &claim.runtime_type,
        &claim.organization_id,
        &claim.agent_id,
        &config,
        host,
    )?;
    if matches!(
        claim.runtime_type.as_str(),
        "claude_local" | "codex_local" | "cursor" | "opencode_local" | "pi_local"
    ) {
        git_identity::prepare(host, &invocation_cwd, &artifacts, &mut env, cancelled).await?;
    }
    let mut provider_bindings = resources.managed_mcp_bindings.clone();
    if claim.runtime_type == "pi_local" {
        let identity = rudder_d1_persistence::managed_mcp_runtime::Identity {
            organization_id: claim.organization_id.clone(),
            agent_id: claim.agent_id.clone(),
            run_id: claim.run_id.clone(),
        };
        let mut admitted = Vec::new();
        for mut binding in provider_bindings {
            let binding_id = text(&binding, "bindingId")
                .ok_or(ContextError::Invalid("Invalid managed MCP binding"))?;
            match rudder_d1_persistence::managed_mcp_runtime::list_tools(
                pool,
                &identity,
                binding_id,
                host.deployment_mode == "local_trusted",
            )
            .await
            {
                Ok(tools) => {
                    binding["tools"] = json!(tools);
                    admitted.push(binding);
                }
                Err(_) if binding["required"] == true => {
                    return Err(ContextError::Invalid(
                        "Required managed MCP tool inventory could not be prepared",
                    ));
                }
                Err(_) => {
                    output
                        .log(
                            "mcp",
                            "stderr",
                            "[rudder] Optional managed MCP inventory is unavailable\n",
                        )
                        .await
                }
            }
        }
        provider_bindings = admitted;
    }
    let managed_args = artifacts::provision_core_mcp(
        &claim.runtime_type,
        &mut config,
        &mut env,
        host,
        &artifacts,
        &skills,
        &instructions_path,
        &profile_root,
        &provider_bindings,
    )?;
    if claim.runtime_type == "pi_local" {
        config["rudderSystemPrompt"] = json!(instruction_text);
    }
    let mut prompt = invocation::compose(
        claim,
        &config,
        &context,
        &agent,
        &instruction_text,
        &env,
        &invocation_cwd,
    );
    if claim.runtime_type == "hermes_local" {
        let (legacy, _) = hermes_local::prepare(claim, &mut config, host, &mut env);
        prompt = legacy;
    }
    gateways::prepare(
        &claim.runtime_type,
        claim,
        &context,
        &mut config,
        &env,
        &skills.prompt,
        &mut prompt,
    )?;
    // Remove protected effective bindings from config.env: the SDK merges it
    // again, so it must not override host identity or the isolated provider home.
    if let Some(config_env) = config.get_mut("env").and_then(Value::as_object_mut) {
        for (key, value) in &env {
            if config_env.contains_key(key) {
                config_env.insert(key.clone(), json!(value));
            }
        }
    }
    let service_lease = services::acquire(
        pool,
        claim,
        &workspace,
        &realized,
        resources.issue.as_ref().unwrap_or(&Value::Null),
        &service_config,
        host,
        cancelled,
        &output,
        &secret_keys,
    )
    .await?;
    context["executionWorkspaceId"] = json!(workspace.execution_workspace_id);
    context["rudderRuntimeServices"] = json!(service_lease.references);
    context["rudderRuntimePrimaryUrl"] = service_lease
        .references
        .iter()
        .find_map(|service| text(service, "url"))
        .map_or(Value::Null, |url| json!(url));
    if !service_lease.references.is_empty() {
        env.insert(
            "RUDDER_RUNTIME_SERVICES_JSON".into(),
            json!(service_lease.references).to_string(),
        );
    }
    if let Some(url) = text(&context, "rudderRuntimePrimaryUrl") {
        env.insert("RUDDER_RUNTIME_PRIMARY_URL".into(), url.into());
    }
    if claim.issue_id.is_some()
        && (realized.created
            || service_lease
                .references
                .iter()
                .any(|service| service["reused"] != true))
    {
        let mut lines = vec![
            "## Workspace Ready".to_owned(),
            String::new(),
            format!("- Strategy: `{}`", realized.strategy),
        ];
        if let Some(branch) = realized.branch_name.as_deref() {
            lines.push(format!("- Branch: `{branch}`"));
        }
        lines.push(format!("- CWD: `{}`", workspace.cwd.display()));
        for service in &service_lease.references {
            lines.push(format!(
                "- Service: {}: {}{}",
                text(service, "serviceName").unwrap_or("service"),
                text(service, "url").unwrap_or("running"),
                if service["reused"] == true {
                    " (reused)"
                } else {
                    ""
                }
            ));
        }
        if rudder_d1_persistence::agent_run_workspace::record_ready_comment(
            pool,
            claim,
            &lines.join("\n"),
        )
        .await
        .is_err()
        {
            output
                .log(
                    "workspace",
                    "stderr",
                    "[rudder] Failed to post workspace-ready comment\n",
                )
                .await;
        }
    }
    let mut prompt = invocation::compose(
        claim,
        &config,
        &context,
        &agent,
        &instruction_text,
        &env,
        &invocation_cwd,
    );
    if claim.runtime_type == "hermes_local" {
        let (legacy, _) = hermes_local::prepare(claim, &mut config, host, &mut env);
        prompt = legacy;
    }
    if let Err(error) = gateways::prepare(
        &claim.runtime_type,
        claim,
        &context,
        &mut config,
        &env,
        &skills.prompt,
        &mut prompt,
    ) {
        let mut service_lease = service_lease;
        service_lease.release(pool).await?;
        return Err(error);
    }
    if claim.runtime_type == "opencode_local" {
        match artifacts.write("rudder-prompt.md", &prompt) {
            Ok(path) => config["rudderPromptFilePath"] = json!(path),
            Err(error) => {
                let mut service_lease = service_lease;
                service_lease.release(pool).await?;
                return Err(error);
            }
        }
    }
    Ok(PreparedAgentInvocation {
        prompt,
        context,
        config,
        attempt_config_template,
        cwd: invocation_cwd,
        env,
        secret_keys,
        managed_args,
        runtime_skills: skills.entries,
        _artifacts: artifacts,
        service_lease,
    })
}

pub(super) fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn resolve_scene<'a>(claim: &AgentRunClaim, context: &'a Value) -> &'a str {
    if let Some(scene) = text(context, "scene").or_else(|| text(context, "rudderScene")) {
        return scene;
    }
    if claim.invocation_source == "chat" || context["conversationId"].is_string() {
        "chat"
    } else if claim.invocation_source == "review" {
        "review"
    } else if claim.invocation_source == "delegation" {
        "delegation"
    } else if claim.invocation_source == "timer" {
        "heartbeat"
    } else if context["automationRunId"].is_string() || claim.invocation_source == "automation" {
        "automation"
    } else if claim.issue_id.is_some() {
        "issue"
    } else {
        "heartbeat"
    }
}
fn install_environment(
    env: &mut BTreeMap<String, String>,
    claim: &AgentRunClaim,
    context: &Value,
    host: &AgentRunContextHost,
    agent_home: &Path,
    tmp: &Path,
) {
    for (key, value) in [
        ("HOME", host.operator_home.to_string_lossy().into_owned()),
        (
            "USERPROFILE",
            host.operator_home.to_string_lossy().into_owned(),
        ),
        ("AGENT_HOME", agent_home.to_string_lossy().into_owned()),
        (
            "RUDDER_AGENT_ROOT",
            agent_home.to_string_lossy().into_owned(),
        ),
        (
            "RUDDER_OPERATOR_HOME",
            host.operator_home.to_string_lossy().into_owned(),
        ),
        ("RUDDER_RUNTIME_TMPDIR", tmp.to_string_lossy().into_owned()),
        ("RUDDER_AGENT_ID", claim.agent_id.clone()),
        ("RUDDER_ORG_ID", claim.organization_id.clone()),
        ("RUDDER_RUN_ID", claim.run_id.clone()),
        ("RUDDER_API_URL", host.api_url.clone()),
    ] {
        env.insert(key.into(), value);
    }
    for (key, field) in [
        ("RUDDER_TASK_ID", "issueId"),
        ("RUDDER_WAKE_REASON", "wakeReason"),
        ("RUDDER_WAKE_COMMENT_ID", "wakeCommentId"),
        ("RUDDER_APPROVAL_ID", "approvalId"),
        ("RUDDER_APPROVAL_STATUS", "approvalStatus"),
        ("RUDDER_DELEGATION_TASK", "delegationTask"),
    ] {
        let value = if field == "issueId" {
            text(context, "taskId").or_else(|| text(context, "issueId"))
        } else if field == "wakeCommentId" {
            text(context, "wakeCommentId").or_else(|| text(context, "commentId"))
        } else {
            text(context, field)
        };
        if let Some(value) = value {
            env.insert(key.into(), value.into());
        } else {
            env.remove(key);
        }
    }
    for (key, field) in [
        ("RUDDER_WORKSPACE_CWD", "cwd"),
        ("RUDDER_WORKSPACE_SOURCE", "source"),
        ("RUDDER_WORKSPACE_STRATEGY", "strategy"),
        ("RUDDER_WORKSPACE_ID", "workspaceId"),
        ("RUDDER_WORKSPACE_REPO_URL", "repoUrl"),
        ("RUDDER_WORKSPACE_REPO_REF", "repoRef"),
        ("RUDDER_AGENT_INSTRUCTIONS_DIR", "instructionsDir"),
        ("RUDDER_AGENT_MEMORY_DIR", "memoryDir"),
        ("RUDDER_AGENT_SKILLS_DIR", "agentSkillsDir"),
        ("RUDDER_ORG_WORKSPACE_ROOT", "orgWorkspaceRoot"),
        ("RUDDER_ORG_SKILLS_DIR", "orgSkillsDir"),
        ("RUDDER_PROJECT_LIBRARY_ROOT", "projectLibraryRoot"),
        ("RUDDER_PROJECT_LIBRARY_PATH", "projectLibraryRelativePath"),
    ] {
        if let Some(value) = text(&context["rudderWorkspace"], field) {
            env.insert(key.into(), value.into());
        } else {
            env.remove(key);
        }
    }
    for (key, field) in [
        ("RUDDER_WORKSPACES_JSON", "rudderWorkspaces"),
        (
            "RUDDER_RUNTIME_SERVICE_INTENTS_JSON",
            "rudderRuntimeServiceIntents",
        ),
    ] {
        if let Some(values) = context[field].as_array().filter(|v| !v.is_empty()) {
            env.insert(key.into(), json!(values).to_string());
        } else {
            env.remove(key);
        }
    }
    env.remove("RUDDER_LINKED_ISSUE_IDS");
    if let Some(ids) = context["issueIds"].as_array() {
        let ids = ids
            .iter()
            .filter_map(Value::as_str)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>();
        if !ids.is_empty() {
            env.insert("RUDDER_LINKED_ISSUE_IDS".into(), ids.join(","));
        }
    }
}

fn project_library(
    project: &Option<Value>,
    organization_root: &Path,
) -> Result<(Option<String>, Option<PathBuf>), ContextError> {
    let Some(project) = project else {
        return Ok((None, None));
    };
    let Some(id) = text(project, "id") else {
        return Ok((None, None));
    };
    let layout = rudder_d1_persistence::project_library::ensure_existing_project_library(
        organization_root,
        id,
        text(project, "name").unwrap_or_default(),
        text(project, "urlKey").unwrap_or_default(),
    )
    .map_err(|_| ContextError::Invalid("Project Library could not be prepared"))?;
    Ok((
        Some(layout.relative_path.to_string_lossy().replace('\\', "/")),
        Some(layout.root),
    ))
}

fn project_resources_prompt(resources: &[Value]) -> String {
    if resources.is_empty() {
        return String::new();
    }
    let cell = |value: &Value| {
        value
            .as_str()
            .unwrap_or("empty")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .replace('|', "\\|")
    };
    let mut lines = vec![
        "| Priority | Role | Name | Source | Kind | Locator | Description | Project note |"
            .to_owned(),
        "| --- | --- | --- | --- | --- | --- | --- | --- |".to_owned(),
    ];
    for attachment in resources {
        let resource = &attachment["resource"];
        lines.push(format!(
            "| {} | {} | {} | {} | {} | `{}` | {} | {} |",
            if attachment["isPrimary"] == true {
                "Primary"
            } else {
                ""
            },
            cell(&attachment["role"]),
            cell(&resource["name"]),
            cell(&resource["sourceType"]),
            cell(&resource["kind"]).replace('_', " "),
            cell(&resource["locator"]),
            cell(&resource["description"]),
            cell(&attachment["note"])
        ));
    }
    for attachment in resources
        .iter()
        .filter(|a| text(&a["resource"], "sourceType") == Some("library"))
    {
        let resource = &attachment["resource"];
        let locator = text(resource, "locator").unwrap_or_default();
        lines.push(format!("- {}: library path `library:{locator}`; local file path in local trusted runs `$RUDDER_ORG_WORKSPACE_ROOT/{locator}`; cite using `rudder library file ref \"{locator}\" --json` and the returned `markdownLink`.",cell(&resource["name"])));
    }
    format!(
        "<project_context_resources>\n{}\n</project_context_resources>",
        lines.join("\n")
    )
}

#[cfg(test)]
mod tests;
