//! Real host effects for the existing workspace policy. Preparation commands
//! are joined on cancellation; selecting a cwd is never a provision receipt.
use super::{AgentRunContextHost, AgentWorkspacePreparation, ContextError, text};
use crate::goal_run_context::render_template;
use rudder_d1_persistence::{
    agent_execution::AgentRunClaim, agent_run_context::AgentRunResources, agent_run_workspace,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

pub(super) struct RealizedWorkspace {
    pub branch_name: Option<String>,
    pub worktree_path: Option<PathBuf>,
    pub created: bool,
    pub strategy: String,
}
pub(super) async fn realize(
    pool: &PgPool,
    claim: &AgentRunClaim,
    workspace: &mut AgentWorkspacePreparation,
    resources: &AgentRunResources,
    config: &Value,
    host: &AgentRunContextHost,
    cancelled: &Arc<AtomicBool>,
    secret_keys: &BTreeSet<String>,
) -> Result<RealizedWorkspace, ContextError> {
    let censor_username = resources.general_settings["censorUsernameInLogs"] == true;
    let base = workspace.cwd.clone();
    let mut realized = RealizedWorkspace {
        branch_name: None,
        worktree_path: None,
        created: false,
        strategy: "project_primary".into(),
    };
    if text(&workspace.strategy, "type") == Some("git_worktree") {
        let repo = run_git(
            pool,
            claim,
            "worktree_prepare",
            &base,
            &["rev-parse", "--show-toplevel"],
            cancelled,
            secret_keys,
            config,
            host,
            censor_username,
        )
        .await?;
        let repo = PathBuf::from(repo.trim());
        let issue = resources.issue.as_ref().unwrap_or(&Value::Null);
        let identifier = text(issue, "identifier")
            .or_else(|| text(issue, "id"))
            .unwrap_or("issue");
        let slug = slug(text(issue, "title").unwrap_or(identifier), "issue");
        let data = json!({"issue":{"id":issue["id"],"identifier":issue["identifier"],"title":issue["title"]},
            "agent":{"id":claim.agent_id,"name":claim.agent_name},"project":{"id":workspace.project_id},"workspace":{"repoRef":workspace.repo_ref},"slug":slug});
        let branch = sanitize_branch(&render_template(
            text(&workspace.strategy, "branchTemplate").unwrap_or("{{issue.identifier}}-{{slug}}"),
            &data,
        ));
        let parent = text(&workspace.strategy, "worktreeParentDir")
            .map(|path| resolve_path(path, &repo, &host.operator_home))
            .unwrap_or_else(|| repo.join(".rudder/worktrees"));
        fs::create_dir_all(&parent)?;
        let path = parent.join(&branch);
        let base_ref = text(&workspace.strategy, "baseRef")
            .or(workspace.repo_ref.as_deref())
            .unwrap_or("HEAD");
        if path.is_dir() {
            run_git(
                pool,
                claim,
                "worktree_prepare",
                &path,
                &["rev-parse", "--git-dir"],
                cancelled,
                secret_keys,
                config,
                host,
                censor_username,
            )
            .await?;
        } else {
            let path_text = path.to_string_lossy();
            let first = run_git(
                pool,
                claim,
                "worktree_prepare",
                &repo,
                &["worktree", "add", "-b", &branch, &path_text, base_ref],
                cancelled,
                secret_keys,
                config,
                host,
                censor_username,
            )
            .await;
            match first {
                Ok(_) => realized.created = true,
                Err(ContextError::Command(ref error))
                    if error.to_ascii_lowercase().contains("already exists") =>
                {
                    run_git(
                        pool,
                        claim,
                        "worktree_prepare",
                        &repo,
                        &["worktree", "add", &path_text, &branch],
                        cancelled,
                        secret_keys,
                        config,
                        host,
                        censor_username,
                    )
                    .await?;
                    realized.created = true;
                }
                Err(error) => return Err(error),
            }
        }
        // Same repository-only identity policy as the Node provisioner; the
        // operator's global Git config is never modified.
        run_git(
            pool,
            claim,
            "workspace_provision",
            &path,
            &["config", "--local", "user.useConfigOnly", "true"],
            cancelled,
            secret_keys,
            config,
            host,
            censor_username,
        )
        .await?;
        if let Some(command) = text(&workspace.strategy, "provisionCommand") {
            let mut env = std::env::vars().collect::<BTreeMap<_, _>>();
            for (key, value) in [
                ("RUDDER_WORKSPACE_CWD", path.to_string_lossy().into_owned()),
                ("RUDDER_WORKSPACE_PATH", path.to_string_lossy().into_owned()),
                (
                    "RUDDER_WORKSPACE_WORKTREE_PATH",
                    path.to_string_lossy().into_owned(),
                ),
                ("RUDDER_WORKSPACE_BRANCH", branch.clone()),
                (
                    "RUDDER_WORKSPACE_BASE_CWD",
                    base.to_string_lossy().into_owned(),
                ),
                (
                    "RUDDER_WORKSPACE_REPO_ROOT",
                    repo.to_string_lossy().into_owned(),
                ),
                ("RUDDER_WORKSPACE_SOURCE", workspace.source.clone()),
                (
                    "RUDDER_WORKSPACE_REPO_REF",
                    workspace.repo_ref.clone().unwrap_or_default(),
                ),
                (
                    "RUDDER_WORKSPACE_REPO_URL",
                    workspace.repo_url.clone().unwrap_or_default(),
                ),
                ("RUDDER_WORKSPACE_CREATED", realized.created.to_string()),
                (
                    "RUDDER_PROJECT_ID",
                    workspace.project_id.clone().unwrap_or_default(),
                ),
                (
                    "RUDDER_PROJECT_WORKSPACE_ID",
                    workspace.workspace_id.clone().unwrap_or_default(),
                ),
                ("RUDDER_AGENT_ID", claim.agent_id.clone()),
                ("RUDDER_AGENT_NAME", claim.agent_name.clone()),
                ("RUDDER_ORG_ID", claim.organization_id.clone()),
                (
                    "RUDDER_ISSUE_ID",
                    text(issue, "id").unwrap_or_default().into(),
                ),
                (
                    "RUDDER_ISSUE_IDENTIFIER",
                    text(issue, "identifier").unwrap_or_default().into(),
                ),
                (
                    "RUDDER_ISSUE_TITLE",
                    text(issue, "title").unwrap_or_default().into(),
                ),
            ] {
                env.insert(key.into(), value);
            }
            super::git_identity::apply_repository_policy(&path, &mut env).await?;
            let shell = std::env::var("SHELL")
                .ok()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| "/bin/sh".into());
            run_operation(
                pool,
                claim,
                "workspace_provision",
                &path,
                &shell,
                &["-c", command],
                &env,
                cancelled,
                secret_keys,
                config,
                host,
                censor_username,
            )
            .await?;
        }
        workspace.cwd = path.clone();
        realized.branch_name = Some(branch);
        realized.worktree_path = Some(path);
        realized.strategy = "git_worktree".into();
    }
    let issue = resources.issue.as_ref().unwrap_or(&Value::Null);
    let projection = json!({"projectId":workspace.project_id,"workspaceId":workspace.workspace_id,"cwd":workspace.cwd,"source":workspace.source,
        "repoUrl":workspace.repo_url,"repoRef":workspace.repo_ref,"mode":workspace.mode,"strategy":realized.strategy,"branchName":realized.branch_name,
        "worktreePath":realized.worktree_path,"created":realized.created,"issueIdentifier":issue["identifier"],"issueSettings":workspace.issue_settings});
    match agent_run_workspace::persist_workspace(pool, claim, &projection).await {
        Ok(id) => workspace.execution_workspace_id = id,
        Err(error) => {
            if realized.created {
                if let Some(path) = realized.worktree_path.as_ref() {
                    let _ = run_git(
                        pool,
                        claim,
                        "worktree_cleanup",
                        &base,
                        &["worktree", "remove", "--force", &path.to_string_lossy()],
                        cancelled,
                        secret_keys,
                        config,
                        host,
                        censor_username,
                    )
                    .await;
                    if let Some(branch) = realized.branch_name.as_deref() {
                        let _ = run_git(
                            pool,
                            claim,
                            "worktree_cleanup",
                            &base,
                            &["branch", "-d", branch],
                            cancelled,
                            secret_keys,
                            config,
                            host,
                            censor_username,
                        )
                        .await;
                    }
                }
            }
            return Err(error.into());
        }
    }
    Ok(realized)
}

pub(super) async fn run_git(
    pool: &PgPool,
    claim: &AgentRunClaim,
    phase: &str,
    cwd: &Path,
    args: &[&str],
    cancelled: &Arc<AtomicBool>,
    secret_keys: &BTreeSet<String>,
    config: &Value,
    host: &AgentRunContextHost,
    censor_username: bool,
) -> Result<String, ContextError> {
    run_operation(
        pool,
        claim,
        phase,
        cwd,
        "git",
        args,
        &std::env::vars().collect(),
        cancelled,
        secret_keys,
        config,
        host,
        censor_username,
    )
    .await
}
#[allow(clippy::too_many_arguments)]
pub(super) async fn run_operation(
    pool: &PgPool,
    claim: &AgentRunClaim,
    phase: &str,
    cwd: &Path,
    executable: &str,
    args: &[&str],
    env: &BTreeMap<String, String>,
    cancelled: &Arc<AtomicBool>,
    secret_keys: &BTreeSet<String>,
    config: &Value,
    host: &AgentRunContextHost,
    censor_username: bool,
) -> Result<String, ContextError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(ContextError::Cancelled);
    }
    let display = std::iter::once(executable)
        .chain(args.iter().copied())
        .collect::<Vec<_>>()
        .join(" ");
    let operation = agent_run_workspace::begin_operation(
        pool,
        claim,
        phase,
        Some(&display),
        &cwd.to_string_lossy(),
        &json!({}),
    )
    .await?;
    let operation_log =
        super::operation_log::OperationLog::begin(host, &claim.organization_id, &operation)?;
    agent_run_workspace::attach_operation_log(pool, claim, &operation, &operation_log.reference)
        .await?;
    let command = executable.to_owned();
    let args = args.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let cwd = cwd.to_path_buf();
    let env = env.clone();
    let stop = Arc::clone(cancelled);
    let output = tokio::task::spawn_blocking(move || {
        let mut command = Command::new(command);
        command
            .args(args)
            .current_dir(cwd)
            .env_clear()
            .envs(env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn()?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let out = thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = stdout {
                let _ = pipe.read_to_end(&mut bytes);
            }
            bytes
        });
        let err = thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = stderr {
                let _ = pipe.read_to_end(&mut bytes);
            }
            bytes
        });
        let mut stopping = None;
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            if stop.load(Ordering::Acquire) {
                if stopping.is_none() {
                    terminate(&mut child, false);
                    stopping = Some(Instant::now());
                } else if stopping.is_some_and(|at| at.elapsed() > Duration::from_secs(2)) {
                    terminate(&mut child, true);
                }
            }
            thread::sleep(Duration::from_millis(50));
        };
        let stdout = String::from_utf8_lossy(&out.join().unwrap_or_default()).into_owned();
        let stderr = String::from_utf8_lossy(&err.join().unwrap_or_default()).into_owned();
        Ok::<_, std::io::Error>((status.code(), stdout, stderr))
    })
    .await
    .map_err(|_| ContextError::Invalid("Workspace command owner stopped"))?;
    let (code, stdout, stderr) = match output {
        Ok(output) => output,
        Err(error) => {
            let message = rudder_d1_persistence::agent_run_context::redact_context_log(
                &error.to_string(),
                censor_username,
            );
            let (bytes, sha) = operation_log.finish("", &message)?;
            agent_run_workspace::finish_operation(
                pool, claim, &operation, None, "", &message, bytes, &sha,
            )
            .await?;
            return Err(error.into());
        }
    };
    let redact = |mut value: String| {
        for key in secret_keys {
            if let Some(secret) = config["env"][key].as_str().filter(|s| !s.is_empty()) {
                value = value.replace(secret, "***REDACTED***");
            }
        }
        rudder_d1_persistence::agent_run_context::redact_context_log(&value, censor_username)
    };
    let safe_stdout = redact(stdout.clone());
    let safe_stderr = redact(stderr.clone());
    let (log_bytes, log_sha) = operation_log.finish(&safe_stdout, &safe_stderr)?;
    let excerpt = |text: &str| {
        text.chars()
            .rev()
            .take(4096)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>()
    };
    agent_run_workspace::finish_operation(
        pool,
        claim,
        &operation,
        code,
        &excerpt(&safe_stdout),
        &excerpt(&safe_stderr),
        log_bytes,
        &log_sha,
    )
    .await?;
    if cancelled.load(Ordering::Acquire) {
        return Err(ContextError::Cancelled);
    }
    if code != Some(0) {
        return Err(ContextError::Command(excerpt(&redact(
            if stderr.trim().is_empty() {
                stdout
            } else {
                stderr
            },
        ))));
    }
    Ok(stdout.trim().into())
}
pub(super) fn terminate(child: &mut std::process::Child, force: bool) {
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(
                -(child.id() as i32),
                if force { libc::SIGKILL } else { libc::SIGTERM },
            );
        }
    }
    #[cfg(not(unix))]
    {
        let _ = force;
        let _ = child.kill();
    }
}
pub(super) fn resolve_path(value: &str, base: &Path, home: &Path) -> PathBuf {
    if value == "~" {
        home.into()
    } else if let Some(value) = value.strip_prefix("~/") {
        home.join(value)
    } else {
        let path = PathBuf::from(value);
        if path.is_absolute() {
            path
        } else {
            base.join(path)
        }
    }
}
fn slug(value: &str, fallback: &str) -> String {
    let mut out = String::new();
    for character in value.trim().to_ascii_lowercase().chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '/' | '_' | '-') {
            out.push(character);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_matches(['-', '/']);
    if out.is_empty() {
        fallback.into()
    } else {
        out.into()
    }
}
fn sanitize_branch(value: &str) -> String {
    let mut out = String::new();
    for character in value.trim().chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '/' | '-') {
            out.push(character);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out
        .trim_matches(['-', '/', '.'])
        .chars()
        .take(120)
        .collect::<String>();
    if out.is_empty() {
        "rudder-work".into()
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn branch_and_slug_follow_legacy_workspace_rules() {
        assert_eq!(
            sanitize_branch("  /ISSUE-7: Fix release / "),
            "ISSUE-7-Fix-release"
        );
        assert_eq!(slug("Fix release — now", "issue"), "fix-release-now");
    }
}
