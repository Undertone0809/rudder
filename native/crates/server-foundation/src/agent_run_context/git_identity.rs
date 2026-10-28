//! Existing isolated Git identity and credential-helper environment contract.
//! Only one invocation's config file is written; operator/global files are read.
use super::{AgentRunContextHost, ContextError, artifacts::InvocationArtifacts};
use std::{
    collections::BTreeMap,
    path::Path,
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
#[derive(Clone, Copy, PartialEq, Eq)]
enum Source {
    Repository,
    Environment,
    Global,
}
struct Identity {
    name: String,
    email: String,
    source: Source,
}
fn valid(name: &str, email: &str) -> bool {
    let email = email.trim();
    !name.trim().is_empty()
        && !email.to_ascii_lowercase().ends_with(".local")
        && !email.chars().any(|c| c.is_whitespace() || "<>".contains(c))
        && email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && !domain.contains('@')
                && domain
                    .split_once('.')
                    .is_some_and(|(a, b)| !a.is_empty() && !b.is_empty())
        })
}
fn pair(env: &BTreeMap<String, String>, name: &str, email: &str) -> Option<Identity> {
    let name = env.get(name)?.trim();
    let email = env.get(email)?.trim();
    valid(name, email).then(|| Identity {
        name: name.into(),
        email: email.into(),
        source: Source::Environment,
    })
}
fn read(cwd: &Path, env: &BTreeMap<String, String>, scope: &str, key: &str) -> Option<String> {
    let output = Command::new("git")
        .args(["config", scope, "--get", key])
        .current_dir(cwd)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    (!text.is_empty()).then_some(text)
}
fn configured(
    cwd: &Path,
    env: &BTreeMap<String, String>,
    scope: &str,
    source: Source,
) -> Option<Identity> {
    let name = read(cwd, env, scope, "user.name")?;
    let email = read(cwd, env, scope, "user.email")?;
    valid(&name, &email).then_some(Identity {
        name,
        email,
        source,
    })
}
fn policy(env: &mut BTreeMap<String, String>, repository: bool) {
    for (name, email) in [
        ("GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL"),
        ("GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"),
    ] {
        if repository || pair(env, name, email).is_none() {
            env.remove(name);
            env.remove(email);
        }
    }
}
fn quoted(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
            .replace('\t', "\\t")
    )
}
fn append(env: &mut BTreeMap<String, String>, key: &str, value: &str) {
    // Match parseInt's numeric prefix used by the existing helper.
    let count = env
        .get("GIT_CONFIG_COUNT")
        .and_then(|v| v.trim().split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| (*v as u64) <= 9_007_199_254_740_991)
        .unwrap_or(0);
    env.insert(format!("GIT_CONFIG_KEY_{count}"), key.into());
    env.insert(format!("GIT_CONFIG_VALUE_{count}"), value.into());
    env.insert("GIT_CONFIG_COUNT".into(), (count + 1).to_string());
}
pub(super) async fn prepare(
    host: &AgentRunContextHost,
    cwd: &Path,
    artifacts: &InvocationArtifacts,
    env: &mut BTreeMap<String, String>,
    cancelled: &Arc<AtomicBool>,
) -> Result<(), ContextError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(ContextError::Cancelled);
    }
    let mut source_env = host.environment.clone();
    source_env.insert(
        "HOME".into(),
        host.operator_home.to_string_lossy().into_owned(),
    );
    source_env.insert(
        "USERPROFILE".into(),
        host.operator_home.to_string_lossy().into_owned(),
    );
    let cwd = cwd.to_path_buf();
    let identity = tokio::task::spawn_blocking(move || {
        configured(&cwd, &source_env, "--local", Source::Repository)
            .or_else(|| pair(&source_env, "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL"))
            .or_else(|| pair(&source_env, "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"))
            .or_else(|| configured(&cwd, &source_env, "--global", Source::Global))
    })
    .await
    .map_err(|_| ContextError::Invalid("Git identity preparation owner stopped"))?;
    if cancelled.load(Ordering::Acquire) {
        return Err(ContextError::Cancelled);
    }
    let mut content = "[user]\n\tuseConfigOnly = true\n".to_owned();
    if let Some(identity) = identity.as_ref().filter(|v| v.source == Source::Global) {
        content.push_str(&format!(
            "\tname = {}\n\temail = {}\n",
            quoted(&identity.name),
            quoted(&identity.email)
        ));
    }
    let path = artifacts.write("gitconfig", &content)?;
    env.insert(
        "GIT_CONFIG_GLOBAL".into(),
        path.to_string_lossy().into_owned(),
    );
    policy(
        env,
        identity.is_some_and(|v| v.source == Source::Repository),
    );
    append(env, "credential.helper", "");
    append(env, "credential.helper", "!gh auth git-credential");
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repository_identity_clears_env_overrides_and_invalid_pairs_never_guess_identity() {
        let mut env = BTreeMap::from([
            ("GIT_AUTHOR_NAME".into(), "Synthetic".into()),
            ("GIT_AUTHOR_EMAIL".into(), "synthetic@host.local".into()),
        ]);
        policy(&mut env, false);
        assert!(!env.contains_key("GIT_AUTHOR_NAME"));
        env.insert("GIT_AUTHOR_NAME".into(), "Synthetic".into());
        env.insert("GIT_AUTHOR_EMAIL".into(), "synthetic@example.test".into());
        policy(&mut env, true);
        assert!(!env.contains_key("GIT_AUTHOR_NAME"));
        assert!(valid("Synthetic", "synthetic@example.test"));
    }
}

pub(super) async fn apply_repository_policy(
    host: &AgentRunContextHost,
    cwd: &Path,
    env: &mut BTreeMap<String, String>,
) -> Result<(), ContextError> {
    let cwd = cwd.to_path_buf();
    let source_env = host.environment.clone();
    let repository = tokio::task::spawn_blocking(move || {
        configured(&cwd, &source_env, "--local", Source::Repository).is_some()
    })
    .await
    .map_err(|_| ContextError::Invalid("Repository identity preparation owner stopped"))?;
    policy(env, repository);
    Ok(())
}
