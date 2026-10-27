//! The existing ephemeral Product Intelligence flow, limited to group titles.
//! Profile/secret selection is native; no Agent/Run or private Node callback.
use super::{groups, protocol::AuditContext, store::*};
use rudder_d1_persistence::{
    agent_core::NativeAgentAuthorizer,
    messenger_reads::mutation_snapshot,
    organization_catalog_reads::{
        self, OrganizationCatalogReadInput, OrganizationCatalogReadOperation,
    },
};
use rudder_native_chat_executor::{
    HostPaths,
    messenger_title::{self, Request},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
pub(super) type Failure = (u16, String);
fn failure(message: &str) -> Failure {
    (422, message.into())
}
fn storage(_: impl std::fmt::Debug) -> Failure {
    (500, "Internal server error".into())
}
fn state_failure(error: Error) -> Failure {
    match error {
        Error::Http(status, message) => (status, message.into()),
        Error::Secrets(rudder_d1_persistence::secrets::SecretsError::Http(status, message)) => {
            (status, message)
        }
        other => storage(other),
    }
}
fn js_space(ch: char) -> bool {
    matches!(ch,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn trim(s: &str) -> &str {
    s.trim_matches(js_space)
}
fn slice(s: &str, count: usize) -> String {
    String::from_utf16_lossy(&s.encode_utf16().take(count).collect::<Vec<_>>())
}
pub(super) fn prompt(titles: &[String]) -> String {
    let source = titles
        .iter()
        .enumerate()
        .map(|(i, s)| format!("{}. {}", i + 1, s))
        .collect::<Vec<_>>()
        .join("\n");
    let source = source
        .split(js_space)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let source = if source.encode_utf16().count() > 1600 {
        format!(
            "{}\n\n[Input truncated for title generation.]",
            slice(&source, 1600)
        )
    } else {
        source
    };
    format!(
        "Generate a concise title for this Messenger group.\nRules:\n- Return only the title text.\n- No quotes, markdown, emoji, or trailing punctuation.\n- Maximum 80 characters.\n\nMessenger item titles:\n{source}"
    )
}
pub(super) fn sanitize(raw: &str) -> Option<String> {
    let raw = if let Some(s) = raw.strip_prefix("```") {
        let end = s
            .find(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .unwrap_or(s.len());
        s[end..].trim_start_matches(js_space)
    } else {
        raw
    };
    let raw = raw
        .trim_end_matches(js_space)
        .strip_suffix("```")
        .unwrap_or(raw);
    let raw = trim(raw)
        .trim_start_matches('#')
        .trim_start_matches(js_space);
    let raw = raw
        .strip_prefix(['-', '*'])
        .unwrap_or(raw)
        .trim_start_matches(js_space);
    let raw = raw
        .split(js_space)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let raw = trim(raw.trim_matches(['"', '\'', '`']));
    let raw = trim(raw.trim_end_matches(['.', '!', '?', ':', ';']));
    (!raw.is_empty()).then(|| trim(&slice(raw, 80)).to_owned())
}
/// Configuration sanitization is the literal Product Intelligence allow-by-
/// exclusion list. Fallback nested configs are sanitized by the same rule.
fn sanitize_config(value: &Value) -> Value {
    const KEYS: &[&str] = &[
        "promptTemplate",
        "bootstrapPromptTemplate",
        "instructionsFilePath",
        "instructionsRootPath",
        "instructionsEntryFile",
        "instructionsBundleMode",
        "agentsMdPath",
        "rudderBrowserEnabled",
        "rudderBrowserCapability",
        "rudderSkillSync",
        "paperclipSkillSync",
        "rudderRuntimeSkills",
        "paperclipRuntimeSkills",
        "workspaceStrategy",
        "workspaceRuntime",
        "cwd",
    ];
    let mut map = value.as_object().cloned().unwrap_or_default();
    map.retain(|k, _| !KEYS.contains(&k.as_str()));
    if let Some(fallbacks) = map.get_mut("modelFallbacks").and_then(Value::as_array_mut) {
        for fallback in fallbacks {
            if let Some(config) = fallback.get_mut("config").filter(|v| v.is_object()) {
                *config = sanitize_config(config);
            }
        }
    }
    json!(map)
}
fn model(v: &Value) -> Option<&str> {
    v.as_str().map(trim).filter(|v| !v.is_empty())
}
pub(super) fn attempts(runtime: &str, config: &Value) -> Vec<(String, Value)> {
    let mut out = vec![(runtime.into(), config.clone())];
    let mut seen = HashSet::new();
    if let Some(m) = model(&config["model"]) {
        seen.insert((runtime.to_owned(), m.to_owned()));
    }
    if let Some(fallbacks) = config["modelFallbacks"].as_array() {
        for fallback in fallbacks {
            let rt = model(&fallback["agentRuntimeType"]).unwrap_or(runtime);
            let Some(m) = model(fallback.get("model").unwrap_or(fallback)) else {
                continue;
            };
            if !seen.insert((rt.into(), m.into())) {
                continue;
            }
            let mut next = if rt == runtime {
                config.as_object().cloned().unwrap_or_default()
            } else {
                serde_json::Map::new()
            };
            next.remove("modelFallbacks");
            if let Some(fields) = fallback.as_object() {
                for (k, v) in fields.iter().filter(|(k, _)| {
                    !["agentRuntimeType", "model", "modelFallbacks", "config"].contains(&k.as_str())
                }) {
                    next.insert(k.clone(), v.clone());
                }
                if let Some(nested) = fields.get("config").and_then(Value::as_object) {
                    for (k, v) in nested.iter().filter(|(k, _)| {
                        !["agentRuntimeType", "model", "modelFallbacks", "config"]
                            .contains(&k.as_str())
                    }) {
                        next.insert(k.clone(), v.clone());
                    }
                }
            }
            next.insert("model".into(), json!(m));
            out.push((rt.into(), json!(next)));
        }
    }
    out
}
fn resolve_config<'a>(
    tx: &'a mut Tx<'_>,
    org: &'a str,
    value: &'a Value,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + 'a>> {
    Box::pin(async move {
        let mut map = value.as_object().cloned().unwrap_or_default();
        if map.contains_key("env") {
            let mut env = serde_json::Map::new();
            if let Some(bindings) = map["env"].as_object() {
                for (key, binding) in bindings {
                    if key.is_empty()
                        || !key.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
                        || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                    {
                        return Err(Error::Http(422, "Invalid environment variable name"));
                    }
                    let v = if let Some(v) = binding.as_str() {
                        v.to_owned()
                    } else if binding["type"] == "plain" {
                        binding["value"]
                            .as_str()
                            .ok_or(Error::Http(422, "Invalid environment binding"))?
                            .into()
                    } else if binding["type"] == "secret_ref" {
                        rudder_d1_persistence::secrets::resolve_product_intelligence_secret_reference(
                            tx, org, binding,
                        )
                        .await?
                    } else {
                        return Err(Error::Http(422, "Invalid environment binding"));
                    };
                    env.insert(key.clone(), json!(v));
                }
            }
            map.insert("env".into(), json!(env));
        }
        if let Some(fallbacks) = map.get_mut("modelFallbacks").and_then(Value::as_array_mut) {
            for fallback in fallbacks {
                if let Some(nested) = fallback.get_mut("config").filter(|v| v.is_object()) {
                    *nested = resolve_config(tx, org, nested).await?;
                }
            }
        }
        Ok(json!(map))
    })
}
fn installed_process_host() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let parent = executable.parent()?;
    let parent = if parent.file_name().is_some_and(|name| name == "deps") {
        parent.parent()?
    } else {
        parent
    };
    let candidate = parent.join(if cfg!(windows) {
        "rudder-process-host.exe"
    } else {
        "rudder-process-host"
    });
    candidate
        .is_file()
        .then(|| candidate.canonicalize().ok())
        .flatten()
}
pub(super) async fn generate(
    pool: &sqlx::PgPool,
    scope: &Scope<'_>,
    keys: Option<&[String]>,
    group: Option<&str>,
    auth: &dyn NativeAgentAuthorizer,
    paths: Option<&HostPaths>,
    cancelled: Arc<AtomicBool>,
) -> std::result::Result<Option<String>, Failure> {
    let mut tx = pool.begin().await.map_err(storage)?;
    revalidate(&mut tx, scope, Some(auth))
        .await
        .map_err(state_failure)?;
    let keys = if let Some(group) = group {
        groups::find(&mut tx, scope, group)
            .await
            .map_err(|e| match e {
                Error::Http(s, m) => (s, m.into()),
                other => storage(other),
            })?;
        sqlx::query_scalar::<_,String>("SELECT thread_key FROM messenger_custom_group_entries WHERE org_id=$1::uuid AND user_id=$2 AND group_id=$3::uuid ORDER BY sort_order,created_at").bind(scope.org).bind(scope.user).bind(group).fetch_all(&mut *tx).await.map_err(storage)?
    } else {
        keys.unwrap_or_default().to_vec()
    };
    let keys = super::group_operations::unique(&keys);
    let summaries =
        mutation_snapshot::items(&mut tx, scope.org, scope.user, &locale(), Some(&keys))
            .await
            .map_err(storage)?;
    let mut titles = Vec::new();
    for key in &keys {
        let title = if let Some(id) = key.strip_prefix("saved-view:") {
            super::saved_views::find(&mut tx, scope, id)
                .await
                .map_err(storage)?
                .and_then(|v| v["title"].as_str().map(str::to_owned))
        } else {
            summaries
                .iter()
                .find(|v| field(v, "threadKey") == key)
                .and_then(|v| v["title"].as_str())
                .map(str::to_owned)
        };
        if let Some(title) = title.filter(|v| !trim(v).is_empty()) {
            titles.push(trim(&title).to_owned());
        }
    }
    tx.commit().await.map_err(storage)?;
    if titles.is_empty() {
        return Ok(None);
    }
    let profile = organization_catalog_reads::read_organization_catalog_public(
        pool,
        scope.org,
        &OrganizationCatalogReadInput {
            operation: OrganizationCatalogReadOperation::IntelligenceProfiles,
            legacy_date_timezone: None,
        },
        auth,
    )
    .await
    .map_err(|error| match error {
        organization_catalog_reads::OrganizationCatalogReadError::Unauthorized => {
            (401, "Unauthorized".into())
        }
        organization_catalog_reads::OrganizationCatalogReadError::Forbidden => {
            (403, "User does not have access to this organization".into())
        }
        other => storage(other),
    })?;
    let profile: Value = serde_json::from_str(&profile).map_err(storage)?;
    let profile = &profile[0];
    if profile.is_null() {
        return Err(failure("Default Intelligence is not configured"));
    }
    match profile["status"].as_str() {
        Some("disabled") => return Err(failure("Default Intelligence is disabled")),
        Some("configured") => (),
        _ => return Err(failure("Default Intelligence is invalid")),
    }
    let runtime = profile["agentRuntimeType"].as_str().unwrap_or("");
    if !matches!(
        runtime,
        "process"
            | "http"
            | "codex_local"
            | "claude_local"
            | "cursor"
            | "pi_local"
            | "opencode_local"
            | "hermes_local"
            | "hermes_gateway"
            | "openclaw_gateway"
    ) {
        return Err(failure("Default Intelligence provider is not available"));
    }
    let mut tx = pool.begin().await.map_err(storage)?;
    revalidate(&mut tx, scope, Some(auth))
        .await
        .map_err(state_failure)?;
    let config = resolve_config(&mut tx, scope.org, &profile["agentRuntimeConfig"])
        .await
        .map_err(state_failure)?;
    tx.commit().await.map_err(storage)?;
    let config = sanitize_config(&config);
    let attempts = attempts(runtime, &config);
    let workspace = messenger_title::Workspace::create().map_err(storage)?;
    let owned = workspace.path().to_path_buf();
    let mut env = BTreeMap::new();
    for key in [
        "HOME",
        "USERPROFILE",
        "PATH",
        "USER",
        "LOGNAME",
        "USERNAME",
        "SYSTEMROOT",
        "SystemRoot",
        "TEMP",
        "TMP",
        "TMPDIR",
    ] {
        if let Ok(value) = std::env::var(key) {
            env.insert(key.into(), value);
        }
    }
    // No backend database/auth secrets are inherited by provider children.
    env.insert(
        "RUDDER_AGENT_ID".into(),
        "product-intelligence-default".into(),
    );
    env.insert("RUDDER_ORG_ID".into(), scope.org.into());
    let fallback_host = HostPaths {
        process_host: installed_process_host().unwrap_or_default(),
        runtime_root: owned.clone(),
        isolated_home: owned.clone(),
    };
    let paths = paths.unwrap_or(&fallback_host);
    let request = Request {
        workspace_guard: workspace,
        org_id: scope.org.into(),
        run_id: format!("product-intelligence-{}", uuid::Uuid::new_v4()),
        prompt: prompt(&titles),
        cwd: owned.clone(),
        process_host: paths.process_host.clone(),
        runtime_root: paths.runtime_root.clone(),
        env,
        cancelled,
    };
    let mut auth_failed = HashSet::new();
    let mut last_error = None;
    for (runtime, config) in attempts {
        let scope = if runtime == "codex_local" {
            format!("{runtime}:{}", config["env"])
        } else {
            runtime.clone()
        };
        if auth_failed.contains(&scope) {
            continue;
        }
        if request.cancelled.load(Ordering::Acquire) {
            return Err((499, "Messenger title execution cancelled".into()));
        }
        match messenger_title::execute(&runtime, &config, &request).await {
            Ok(output) => {
                if output.auth_failure {
                    auth_failed.insert(scope);
                }
                if output.success || output.suspended {
                    return Ok(if output.success {
                        sanitize(&output.text)
                    } else {
                        None
                    });
                }
            }
            Err(messenger_title::Error::Cleanup) => {
                return Err((
                    500,
                    "Messenger title provider cleanup was not proven".into(),
                ));
            }
            Err(messenger_title::Error::Cancelled) => {
                return Err((499, "Messenger title execution cancelled".into()));
            }
            Err(error) => last_error = Some(error),
        }
    }
    if last_error.is_some() {
        Err((500, "Default Intelligence execution failed".into()))
    } else {
        Ok(None)
    }
}
pub(super) fn host_audit() -> AuditContext {
    let mut user_names = Vec::new();
    for key in ["USER", "LOGNAME", "USERNAME", "RUDDER_NATIVE_HOST_USERNAME"] {
        if let Ok(value) = std::env::var(key) {
            if !trim(&value).is_empty() && !user_names.contains(&value) {
                user_names.push(value);
            }
        }
    }
    let mut home_dirs = Vec::new();
    for key in ["HOME", "USERPROFILE", "RUDDER_NATIVE_HOST_HOME_DIRECTORY"] {
        if let Ok(value) = std::env::var(key) {
            if !trim(&value).is_empty() && !home_dirs.contains(&value) {
                home_dirs.push(value);
            }
        }
    }
    for name in &user_names {
        home_dirs.extend([
            format!("/Users/{name}"),
            format!("/home/{name}"),
            format!("C:\\Users\\{name}"),
        ]);
    }
    AuditContext {
        user_names,
        home_dirs,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prompt_and_sanitize() {
        assert!(prompt(&["A".into(), "B".into()]).ends_with("1. A 2. B"));
        assert_eq!(
            sanitize("```text\n# \"Release work!\"\n```"),
            Some("Release work".into())
        );
    }
    #[test]
    fn fallback_config_is_runtime_scoped() {
        let v = json!({"model":"a","env":{"A":"base"},"modelFallbacks":["a","b",{"agentRuntimeType":"claude_local","model":"c","config":{"effort":"high"}}]});
        let a = attempts("codex_local", &v);
        assert_eq!(a.len(), 3);
        assert_eq!(a[1].1["env"]["A"], "base");
        assert!(a[2].1.get("env").is_none());
        assert_eq!(a[2].1["effort"], "high");
    }
}
