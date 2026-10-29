use super::{AgentRunContextHost, ContextError, text};
use rudder_d1_persistence::agent_run_context::AgentRunResources;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// A selection is not a provision receipt. The worker must realize requested
/// isolation/services and persist their identities before provider launch.
pub(crate) struct AgentWorkspacePreparation {
    pub cwd: PathBuf,
    pub source: String,
    pub mode: String,
    pub project_id: Option<String>,
    pub workspace_id: Option<String>,
    pub execution_workspace_id: Option<String>,
    pub repo_url: Option<String>,
    pub repo_ref: Option<String>,
    pub strategy: Value,
    pub issue_settings: Value,
    pub runtime_service_intents: Vec<Value>,
    pub workspace_hints: Vec<Value>,
}

pub(super) fn apply_policy(
    config: &mut Value,
    resources: &AgentRunResources,
    agent_id: &str,
) -> String {
    let issue = resources.issue.as_ref().unwrap_or(&Value::Null);
    let policy = resources
        .project
        .as_ref()
        .map(|p| &p["executionWorkspacePolicy"])
        .unwrap_or(&Value::Null);
    let settings = &issue["executionWorkspaceSettings"];
    let overrides = if text(issue, "assigneeAgentId") == Some(agent_id) {
        &issue["assigneeAgentRuntimeOverrides"]
    } else if resources.issue.is_none() {
        resources
            .goal
            .as_ref()
            .filter(|g| text(g, "ownerAgentId") == Some(agent_id))
            .map(|g| &g["ownerAgentRuntimeOverrides"])
            .unwrap_or(&Value::Null)
    } else {
        &Value::Null
    };
    let mode = text(settings, "mode")
        .filter(|mode| !matches!(*mode, "inherit" | "reuse_existing"))
        .map(normalize_mode)
        .unwrap_or_else(|| {
            if policy["enabled"] == true {
                match text(policy, "defaultMode") {
                    Some("isolated_workspace" | "isolated") => "isolated_workspace",
                    Some("operator_branch") => "operator_branch",
                    Some("adapter_default") => "agent_default",
                    _ => "shared_workspace",
                }
            } else if overrides["useProjectWorkspace"] == false {
                "agent_default"
            } else {
                "shared_workspace"
            }
        });
    let control = policy["enabled"] == true
        || settings["mode"].is_string()
        || settings["workspaceStrategy"].is_object()
        || settings["workspaceRuntime"].is_object()
        || overrides["useProjectWorkspace"] == false;
    if let Some(config) = config.as_object_mut() {
        if control {
            if mode == "isolated_workspace" {
                let strategy = settings
                    .get("workspaceStrategy")
                    .filter(|v| v.is_object())
                    .or_else(|| policy.get("workspaceStrategy").filter(|v| v.is_object()))
                    .or_else(|| config.get("workspaceStrategy").filter(|v| v.is_object()))
                    .cloned()
                    .unwrap_or_else(|| json!({"type":"git_worktree"}));
                config.insert("workspaceStrategy".into(), strategy);
            } else {
                config.remove("workspaceStrategy");
            }
            if mode == "agent_default" {
                config.remove("workspaceRuntime");
            } else if let Some(runtime) = settings
                .get("workspaceRuntime")
                .filter(|v| v.is_object())
                .or_else(|| policy.get("workspaceRuntime").filter(|v| v.is_object()))
            {
                config.insert("workspaceRuntime".into(), runtime.clone());
            }
        }
        if let Some(overrides) = overrides
            .get("agentRuntimeConfig")
            .and_then(Value::as_object)
        {
            config.extend(overrides.clone());
        }
    }
    mode.into()
}
fn normalize_mode(mode: &str) -> &str {
    match mode {
        "project_primary" => "shared_workspace",
        "isolated" => "isolated_workspace",
        _ => mode,
    }
}

#[allow(clippy::too_many_arguments)] // Select from the existing trusted workspace and session facts without a second wrapper.
pub(super) fn select(
    resources: &AgentRunResources,
    context: &Value,
    session: Option<&Value>,
    config: &Value,
    host: &AgentRunContextHost,
    agent_home: &Path,
    organization_root: &Path,
    mode: String,
) -> Result<AgentWorkspacePreparation, ContextError> {
    let issue = resources.issue.as_ref().unwrap_or(&Value::Null);
    let project_id = resources
        .project
        .as_ref()
        .and_then(|project| text(project, "id"))
        .map(str::to_owned);
    let preferred =
        text(issue, "projectWorkspaceId").or_else(|| text(context, "projectWorkspaceId"));
    let mut rows = if mode != "agent_default" {
        resources.project_workspaces.clone()
    } else {
        Vec::new()
    };
    if let Some(index) = rows.iter().position(|row| text(row, "id") == preferred) {
        let selected = rows.remove(index);
        rows.insert(0, selected);
    }
    let workspace_hints = rows.iter().map(|row|json!({"workspaceId":row["id"],"cwd":row["cwd"],"repoUrl":row["repoUrl"],"repoRef":row["repoRef"]})).collect();
    let mut warnings = Vec::new();
    let mut selected = None;
    if let Some(preferred) = preferred
        && !rows.iter().any(|row| text(row, "id") == Some(preferred))
        && !rows.is_empty()
    {
        warnings.push(format!(
            "Selected project workspace \"{preferred}\" is not available on this project."
        ));
    }
    for row in &rows {
        if let Some(cwd) = text(row, "cwd").filter(|cwd| *cwd != "/__paperclip_repo_only__") {
            if Path::new(cwd).is_dir() {
                selected = Some((PathBuf::from(cwd), row));
                break;
            }
            warnings.push(format!(
                "Project working directory path \"{cwd}\" is not available yet."
            ));
        }
    }
    let (mut cwd, source, workspace_id, repo_url, repo_ref) = if let Some((cwd, row)) = selected {
        (
            cwd,
            "project_primary",
            text(row, "id"),
            text(row, "repoUrl"),
            text(row, "repoRef"),
        )
    } else if mode != "agent_default" && project_id.is_some() {
        let row = rows.first().unwrap_or(&Value::Null);
        (
            organization_root.to_path_buf(),
            "project_primary",
            text(row, "id"),
            text(row, "repoUrl"),
            text(row, "repoRef"),
        )
    } else if let Some(session) =
        session.filter(|s| text(s, "cwd").is_some_and(|cwd| Path::new(cwd).is_dir()))
    {
        (
            PathBuf::from(text(session, "cwd").unwrap()),
            "task_session",
            text(session, "workspaceId"),
            text(session, "repoUrl"),
            text(session, "repoRef"),
        )
    } else {
        if let Some(saved) = session.and_then(|s| text(s, "cwd")) {
            warnings.push(format!("Saved session working directory \"{saved}\" is not available. Run will start in canonical agent directory \"{}\".",agent_home.display()));
        }
        (agent_home.to_path_buf(), "agent_home", None, None, None)
    };
    // Adapter configured cwd takes precedence only over canonical Agent home.
    // Project/session selections remain authoritative as in all local adapters.
    if source == "agent_home"
        && let Some(configured) = text(config, "cwd")
    {
        cwd = expand(configured, &host.operator_home, &host.process_cwd);
    }
    if !cwd.is_absolute() {
        return Err(ContextError::Invalid(
            "Resolved Agent working directory must be absolute",
        ));
    }
    fs::create_dir_all(&cwd)?;
    Ok(AgentWorkspacePreparation {
        cwd,
        source: source.into(),
        mode,
        project_id,
        workspace_id: workspace_id.map(str::to_owned),
        execution_workspace_id: text(issue, "executionWorkspaceId").map(str::to_owned),
        repo_url: repo_url.map(str::to_owned),
        repo_ref: repo_ref.map(str::to_owned),
        strategy: config["workspaceStrategy"].clone(),
        issue_settings: issue["executionWorkspaceSettings"].clone(),
        runtime_service_intents: config["workspaceRuntime"]["services"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|v| v.is_object())
            .cloned()
            .collect(),
        workspace_hints,
    })
}
fn expand(value: &str, home: &Path, cwd: &Path) -> PathBuf {
    if value == "~" {
        home.to_path_buf()
    } else if let Some(tail) = value.strip_prefix("~/") {
        home.join(tail)
    } else {
        let path = PathBuf::from(value);
        if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_agent_default_clears_workspace_runtime_before_issue_override() {
        let resources = AgentRunResources {
            issue: Some(
                json!({"assigneeAgentId":"a","executionWorkspaceSettings":{"mode":"agent_default"},"assigneeAgentRuntimeOverrides":{"agentRuntimeConfig":{"model":"override"}}}),
            ),
            project: None,
            goal: None,
            project_workspaces: vec![],
            project_resources: vec![],
            skills: vec![],
            enabled_skill_keys: Default::default(),
            managed_mcp_bindings: vec![],
            browser_settings: json!({}),
            general_settings: json!({}),
        };
        let mut config = json!({"workspaceRuntime":{"services":[{}]},"model":"original"});
        assert_eq!(apply_policy(&mut config, &resources, "a"), "agent_default");
        assert!(config.get("workspaceRuntime").is_none());
        assert_eq!(config["model"], "override");
    }
}
