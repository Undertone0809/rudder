use serde_json::{Value, json};

fn first<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|key| {
        value[*key]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    })
}

/// Match each registered Agent adapter's persisted session codec. Keep opaque
/// IDs opaque; Native Chat's UUID/path validation does not apply to Agent Runs.
pub fn normalize_agent_session(runtime: &str, raw: &Value) -> Option<Value> {
    if !raw.is_object() {
        return None;
    }
    let aliases: &[&str] = match runtime {
        "pi_local" => &["sessionId", "session_id", "session"],
        "opencode_local" => &["sessionId", "session_id", "sessionID"],
        "hermes_gateway" => &["hermesSessionId", "sessionId", "session_id"],
        _ => &["sessionId", "session_id"],
    };
    let id = first(raw, aliases)?;
    let mut normalized = json!({"sessionId":id});
    for (target, aliases) in [
        ("cwd", &["cwd", "workdir", "folder"][..]),
        ("workspaceId", &["workspaceId", "workspace_id"][..]),
        ("repoUrl", &["repoUrl", "repo_url"][..]),
        ("repoRef", &["repoRef", "repo_ref"][..]),
    ] {
        if runtime == "hermes_local" || runtime == "pi_local" && target != "cwd" {
            continue;
        }
        if let Some(value) = first(raw, aliases) {
            normalized[target] = json!(value);
        }
    }
    if runtime == "hermes_gateway" {
        normalized["hermesSessionId"] = json!(id);
    }
    Some(normalized)
}

pub fn agent_session_for_workspace(
    runtime: &str,
    raw: Option<&Value>,
    display: Option<&str>,
    cwd: &std::path::Path,
) -> Option<String> {
    let normalized = raw.and_then(|raw| normalize_agent_session(runtime, raw));
    if let Some(saved) = normalized.as_ref().and_then(|v| v["cwd"].as_str()) {
        let saved = lexical_absolute(std::path::Path::new(saved));
        let current = lexical_absolute(cwd);
        if saved != current {
            return None;
        }
    }
    normalized
        .as_ref()
        .and_then(|v| v["sessionId"].as_str())
        .or(display)
        .map(str::to_owned)
        .filter(|s| !s.trim().is_empty())
}
pub(super) use agent_session_for_workspace as resumable;

fn lexical_absolute(path: &std::path::Path) -> std::path::PathBuf {
    use std::path::Component;
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut result = std::path::PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => (),
            Component::ParentDir => {
                result.pop();
            }
            component => result.push(component.as_os_str()),
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_session_aliases_remain_opaque_and_keep_workspace_lineage() {
        let raw = json!({"sessionID":"opaque session /42", "folder":"/tmp/agent", "repo_url":"https://example.invalid/repo"});
        let normalized = normalize_agent_session("opencode_local", &raw).unwrap();
        assert_eq!(normalized["sessionId"], "opaque session /42");
        assert_eq!(normalized["cwd"], "/tmp/agent");
        assert_eq!(normalized["repoUrl"], "https://example.invalid/repo");
        assert!(normalize_agent_session("codex_local", &raw).is_none());
        #[cfg(unix)]
        {
            let root = tempfile::tempdir().unwrap();
            let actual = root.path().join("actual");
            let alias = root.path().join("alias");
            std::fs::create_dir(&actual).unwrap();
            std::os::unix::fs::symlink(&actual, &alias).unwrap();
            assert!(
                agent_session_for_workspace(
                    "codex_local",
                    Some(&json!({"sessionId":"opaque","cwd":actual})),
                    None,
                    &alias
                )
                .is_none(),
                "Node compares lexical paths rather than following symlinks"
            );
            assert_eq!(
                agent_session_for_workspace(
                    "hermes_local",
                    Some(&json!({"sessionId":"opaque","cwd":actual})),
                    None,
                    &alias
                )
                .as_deref(),
                Some("opaque"),
                "Hermes external codec retains only sessionId"
            );
        }
    }
}
