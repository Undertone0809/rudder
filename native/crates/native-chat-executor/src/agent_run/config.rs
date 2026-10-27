//! Agent CLI contracts sourced from packages/agent-runtimes/*/server/execute.
//! This resolver deliberately does not call or relax Native Chat's parser.
use super::{AgentRunRequest, session};
use rudder_d1_persistence::agent_execution::AgentRunClaim;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};

pub struct AgentProcessLaunch {
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    pub stdin: Option<String>,
    pub timeout: Option<Duration>,
    pub grace: Duration,
    pub resumed_session: Option<String>,
}
pub(super) fn string<'a>(value: &'a Value, key: &str, fallback: &'a str) -> &'a str {
    value[key].as_str().unwrap_or(fallback)
}
pub(super) fn nonempty<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value[key].as_str().map(str::trim).filter(|s| !s.is_empty())
}
fn strings(value: &Value, key: &str) -> Vec<String> {
    value[key]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}
pub(super) fn duration(value: &Value, key: &str, fallback: f64) -> Option<Duration> {
    let seconds = value[key]
        .as_f64()
        .filter(|v| v.is_finite())
        .unwrap_or(fallback);
    (seconds > 0.0)
        .then(|| Duration::try_from_secs_f64(seconds).ok())
        .flatten()
}
fn option(args: &mut Vec<String>, flag: &str, value: Option<&str>) {
    if let Some(value) = value.filter(|v| !v.is_empty()) {
        args.extend([flag.into(), value.into()]);
    }
}
fn executable(command: &str, cwd: &Path, env: &BTreeMap<String, String>) -> Result<String, String> {
    if command.is_empty() {
        return Err("Process adapter missing command".into());
    }
    let path = Path::new(command);
    if path.is_absolute() {
        return Ok(command.into());
    }
    if path.components().count() > 1 {
        return Ok(cwd.join(path).to_string_lossy().into_owned());
    }
    for root in std::env::split_paths(env.get("PATH").map(String::as_str).unwrap_or("")) {
        let candidate = root.join(command);
        if candidate.is_file() {
            return Ok(candidate.to_string_lossy().into_owned());
        }
        #[cfg(windows)]
        {
            let candidate = candidate.with_extension("exe");
            if candidate.is_file() {
                return Ok(candidate.to_string_lossy().into_owned());
            }
        }
    }
    Err(format!("Runtime command is unavailable: {command}"))
}

pub fn resolve_agent_process(
    claim: &AgentRunClaim,
    request: &AgentRunRequest,
) -> Result<AgentProcessLaunch, String> {
    resolve(
        &claim.runtime_type,
        &claim.agent_id,
        claim.session_params_before.as_ref(),
        claim.session_id_before.as_deref(),
        request,
    )
}

fn resolve(
    runtime: &str,
    agent_id: &str,
    session_params: Option<&Value>,
    display: Option<&str>,
    request: &AgentRunRequest,
) -> Result<AgentProcessLaunch, String> {
    let config = &request.config;
    let cwd = nonempty(config, "cwd")
        .map(PathBuf::from)
        .unwrap_or_else(|| request.cwd.clone());
    let cwd = if cwd.is_absolute() {
        cwd
    } else {
        request.cwd.join(cwd)
    };
    let mut env = request.env.clone();
    for (key, value) in config["env"].as_object().into_iter().flatten() {
        if let Some(value) = value.as_str() {
            env.insert(key.clone(), value.into());
        }
    }
    let resume = session::resumable(runtime, session_params, display, &cwd);
    let mut extra = strings(config, "extraArgs");
    if extra.is_empty() {
        extra = strings(config, "args");
    }
    let mut args = Vec::new();
    let mut stdin = Some(request.prompt.clone());
    let command = match runtime {
        "claude_local" => {
            args.extend(
                [
                    "--print",
                    "-",
                    "--output-format",
                    "stream-json",
                    "--verbose",
                ]
                .map(str::to_owned),
            );
            option(&mut args, "--resume", resume.as_deref());
            if config["dangerouslySkipPermissions"] == true {
                args.push("--dangerously-skip-permissions".into());
            } else {
                option(
                    &mut args,
                    "--permission-mode",
                    Some(
                        nonempty(config, "permissionMode")
                            .filter(|v| {
                                ["acceptEdits", "auto", "default", "dontAsk", "plan"].contains(v)
                            })
                            .unwrap_or("auto"),
                    ),
                );
            }
            if config["chrome"] == true {
                args.push("--chrome".into());
            }
            option(&mut args, "--model", nonempty(config, "model"));
            option(&mut args, "--effort", nonempty(config, "effort"));
            if let Some(turns) = config["maxTurnsPerRun"].as_u64().filter(|v| *v > 0) {
                args.extend(["--max-turns".into(), turns.to_string()]);
            }
            option(
                &mut args,
                "--append-system-prompt-file",
                nonempty(config, "instructionsFilePath"),
            );
            // Materialized Agent settings/MCP files are supplied by Foundation;
            // unlike Chat mode these are existing managed Agent capabilities.
            option(&mut args, "--settings", nonempty(config, "settingsPath"));
            option(&mut args, "--mcp-config", nonempty(config, "mcpConfigPath"));
            args.append(&mut extra);
            args.extend(request.managed_args.iter().cloned());
            string(config, "command", "claude")
        }
        "codex_local" => {
            args.extend(["exec", "--json", "--disable", "plugins"].map(str::to_owned));
            if config["search"] == true {
                args.insert(0, "--search".into());
            }
            if config["dangerouslyBypassApprovalsAndSandbox"]
                .as_bool()
                .unwrap_or(config["dangerouslyBypassSandbox"] == true)
            {
                args.push("--dangerously-bypass-approvals-and-sandbox".into());
            }
            option(
                &mut args,
                "--model",
                Some(nonempty(config, "model").unwrap_or("gpt-5.6-luna")),
            );
            let effort = nonempty(config, "modelReasoningEffort")
                .or_else(|| nonempty(config, "reasoningEffort"))
                .unwrap_or("medium");
            args.extend([
                "-c".into(),
                format!(
                    "model_reasoning_effort={}",
                    serde_json::to_string(effort).unwrap()
                ),
            ]);
            args.push("--skip-git-repo-check".into());
            args.append(&mut extra);
            args.extend(request.managed_args.iter().cloned());
            args.extend(["-c".into(), "skills.bundled.enabled=false".into()]);
            if let Some(id) = resume.as_deref() {
                args.extend(["resume".into(), id.into()]);
            }
            args.push("-".into());
            string(config, "command", "codex")
        }
        "cursor" => {
            args.extend([
                "-p".into(),
                "--output-format".into(),
                "stream-json".into(),
                "--workspace".into(),
                cwd.to_string_lossy().into_owned(),
            ]);
            option(&mut args, "--resume", resume.as_deref());
            let model = cursor_model(config);
            option(&mut args, "--model", Some(&model));
            let mode = nonempty(config, "mode")
                .map(str::to_ascii_lowercase)
                .filter(|value| ["plan", "ask"].contains(&value.as_str()));
            option(&mut args, "--mode", mode.as_deref());
            if !extra.iter().any(|v| {
                matches!(v.as_str(), "--trust" | "--yolo" | "-f") || v.starts_with("--trust=")
            }) {
                args.push("--yolo".into());
            }
            args.append(&mut extra);
            args.extend(request.managed_args.iter().cloned());
            string(config, "command", "cursor-agent")
        }
        "opencode_local" => {
            args.extend([
                "run".into(),
                "--pure".into(),
                "--format".into(),
                "json".into(),
                "--dir".into(),
                cwd.to_string_lossy().into_owned(),
            ]);
            if request.context["chatMode"] != true
                && let Some(path) = nonempty(config, "rudderPromptFilePath")
            {
                args.push("Follow the attached Rudder runtime prompt file exactly.".into());
                option(&mut args, "--file", Some(path));
                stdin = None;
            }
            option(&mut args, "--session", resume.as_deref());
            option(&mut args, "--model", nonempty(config, "model"));
            option(&mut args, "--variant", nonempty(config, "variant"));
            if config["dangerouslySkipPermissions"] == true {
                args.push("--dangerously-skip-permissions".into());
            }
            args.append(&mut extra);
            args.extend(request.managed_args.iter().cloned());
            string(config, "command", "opencode")
        }
        "pi_local" => {
            args.extend(["--print", "--mode", "json"].map(str::to_owned));
            option(
                &mut args,
                "--append-system-prompt",
                nonempty(config, "rudderSystemPrompt"),
            );
            let model = nonempty(config, "model").unwrap_or("");
            let (provider, model) = model
                .split_once('/')
                .map_or((None, model), |(provider, model)| (Some(provider), model));
            option(&mut args, "--provider", provider);
            option(&mut args, "--model", Some(model));
            option(&mut args, "--thinking", nonempty(config, "thinking"));
            let session_path = resume.clone().unwrap_or_else(|| {
                request
                    .runtime_root
                    .join("pi-sessions")
                    .join(format!("{}-{agent_id}.jsonl", uuid::Uuid::new_v4()))
                    .to_string_lossy()
                    .into_owned()
            });
            if let Some(parent) = Path::new(&session_path).parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|_| "Pi sessions directory is unavailable")?;
            }
            if !Path::new(&session_path).exists() {
                std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&session_path)
                    .map_err(|_| "Pi session file is unavailable")?;
            }
            option(&mut args, "--session", Some(&session_path));
            args.push("--no-skills".into());
            option(&mut args, "--skill", nonempty(config, "skillsDir"));
            args.append(&mut extra);
            args.extend(request.managed_args.iter().cloned());
            args.push(request.prompt.clone());
            stdin = None;
            env.insert("RUDDER_PI_SESSION_FILE".into(), session_path);
            string(config, "command", "pi")
        }
        "hermes_local" => {
            args.extend(["chat".into(), "-q".into(), request.prompt.clone()]);
            if config["quiet"] != false {
                args.push("-Q".into());
            }
            for (key, flag) in [
                ("model", "-m"),
                ("provider", "--provider"),
                ("toolsets", "-t"),
            ] {
                option(&mut args, flag, nonempty(config, key));
            }
            if nonempty(config, "toolsets").is_none() {
                let enabled = strings(config, "enabledToolsets").join(",");
                option(&mut args, "-t", Some(&enabled));
            }
            if let Some(turns) = config["maxTurnsPerRun"].as_u64().filter(|v| *v > 0) {
                args.extend(["--max-turns".into(), turns.to_string()]);
            }
            for (key, flag) in [
                ("worktreeMode", "-w"),
                ("checkpoints", "--checkpoints"),
                ("verbose", "-v"),
            ] {
                if config[key] == true {
                    args.push(flag.into());
                }
            }
            args.extend(["--source".into(), "tool".into(), "--yolo".into()]);
            if config["persistSession"] != false {
                option(&mut args, "--resume", resume.as_deref());
            }
            args.append(&mut extra);
            args.extend(request.managed_args.iter().cloned());
            stdin = None;
            string(config, "hermesCommand", "hermes")
        }
        // The registry historically maps unknown adapter names to process.
        _ => {
            args = strings(config, "args");
            if request.context["chatMode"] != true
                && request.context["scene"] != "delegation"
                && request.context["rudderScene"] != "delegation"
            {
                stdin = None;
            }
            string(config, "command", "")
        }
    };
    let executable = executable(command, &cwd, &env)?;
    let default_timeout = if runtime == "hermes_local" {
        1800.0
    } else {
        0.0
    };
    let default_grace = if ![
        "claude_local",
        "codex_local",
        "cursor",
        "opencode_local",
        "pi_local",
        "hermes_local",
    ]
    .contains(&runtime)
    {
        15.0
    } else if runtime == "hermes_local" {
        10.0
    } else {
        20.0
    };
    let timeout = if runtime == "hermes_local" && config["timeoutSec"].as_f64() == Some(0.0) {
        Some(Duration::from_secs(1800))
    } else {
        duration(config, "timeoutSec", default_timeout)
    };
    let grace = if runtime == "hermes_local" && config["graceSec"].as_f64() == Some(0.0) {
        Duration::from_secs(10)
    } else {
        duration(config, "graceSec", default_grace).unwrap_or(Duration::ZERO)
    };
    Ok(AgentProcessLaunch {
        executable,
        args,
        cwd,
        env,
        stdin,
        timeout,
        grace,
        resumed_session: resume,
    })
}

fn cursor_model(config: &Value) -> String {
    let model = nonempty(config, "model").unwrap_or("auto");
    let (base, parameters) = model.split_once('[').map_or((model, ""), |(base, rest)| {
        (base, rest.strip_suffix(']').unwrap_or(""))
    });
    let mut parameters: Vec<String> = parameters
        .split(',')
        .map(str::trim)
        .filter(|v| {
            !v.is_empty()
                && !v
                    .split_once('=')
                    .is_some_and(|(key, _)| key.trim().eq_ignore_ascii_case("effort"))
        })
        .map(str::to_owned)
        .collect();
    if let Some(effort) = nonempty(config, "effort")
        .map(str::to_ascii_lowercase)
        .filter(|v| v != "auto")
    {
        parameters.push(format!("effort={effort}"));
    }
    if parameters.is_empty() {
        base.into()
    } else {
        format!("{base}[{}]", parameters.join(","))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, atomic::AtomicBool};
    fn request(config: Value, cwd: &Path) -> AgentRunRequest {
        AgentRunRequest {
            prompt: "trusted heartbeat".into(),
            context: json!({}),
            config,
            cwd: cwd.into(),
            process_host: "/bin/true".into(),
            runtime_root: cwd.join("runtime"),
            managed_args: Vec::new(),
            output: None,
            env: BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }
    #[test]
    fn each_local_runtime_uses_its_real_cli_and_opaque_session_contract() {
        let root = tempfile::tempdir().unwrap();
        let raw = json!({"sessionId":"opaque-provider-session","cwd":root.path()});
        for (runtime, flag) in [
            ("claude_local", "--resume"),
            ("codex_local", "resume"),
            ("cursor", "--resume"),
            ("opencode_local", "--session"),
            ("hermes_local", "--resume"),
        ] {
            let req = request(
                json!({"command":"/bin/true","hermesCommand":"/bin/true","model":"provider/model","extraArgs":["--fixture"]}),
                root.path(),
            );
            let launch = resolve(runtime, "agent", Some(&raw), None, &req).unwrap();
            assert!(
                launch
                    .args
                    .windows(2)
                    .any(|pair| pair == [flag, "opaque-provider-session"]),
                "{runtime}"
            );
            assert!(
                launch.args.iter().any(|arg| arg == "--fixture"),
                "{runtime}"
            );
        }
        let req = request(
            json!({"command":"/bin/true","model":"provider/model"}),
            root.path(),
        );
        let pi = resolve("pi_local", "agent", None, None, &req).unwrap();
        let session = pi.env.get("RUDDER_PI_SESSION_FILE").unwrap();
        assert!(Path::new(session).is_file());
        assert!(
            pi.args
                .windows(2)
                .any(|pair| pair == ["--session", session])
        );
        assert!(
            pi.args
                .windows(2)
                .any(|pair| pair == ["--provider", "provider"])
        );
        assert_eq!(pi.stdin, None);
        let req = request(
            json!({"command":"/bin/true","rudderSystemPrompt":"trusted system","rudderPromptFilePath":"/tmp/private-prompt"}),
            root.path(),
        );
        let pi = resolve("pi_local", "agent", None, None, &req).unwrap();
        assert!(
            pi.args
                .windows(2)
                .any(|pair| pair == ["--append-system-prompt", "trusted system"])
        );
        let opencode = resolve("opencode_local", "agent", None, None, &req).unwrap();
        assert!(
            opencode
                .args
                .windows(2)
                .any(|pair| pair == ["--file", "/tmp/private-prompt"])
        );
        assert_eq!(opencode.stdin, None);
        let cursor = resolve("cursor", "agent", None, None, &req).unwrap();
        assert!(!cursor.args.iter().any(|arg| arg == "--file"));
    }
    #[test]
    fn agent_configuration_keeps_existing_bypass_custom_args_and_process_fallback() {
        let root = tempfile::tempdir().unwrap();
        let req = request(
            json!({"command":"/bin/true","dangerouslySkipPermissions":true,"extraArgs":["--settings","custom.json"]}),
            root.path(),
        );
        let claude = resolve("claude_local", "agent", None, None, &req).unwrap();
        assert!(
            claude
                .args
                .iter()
                .any(|arg| arg == "--dangerously-skip-permissions")
        );
        assert!(
            claude
                .args
                .windows(2)
                .any(|pair| pair == ["--settings", "custom.json"])
        );
        let req = request(
            json!({"command":"/bin/true","args":["existing","arguments"]}),
            root.path(),
        );
        let unknown = resolve("third_party_legacy_runtime", "agent", None, None, &req).unwrap();
        assert_eq!(unknown.args, ["existing", "arguments"]);
        assert_eq!(unknown.stdin, None);
        assert_eq!(unknown.grace, Duration::from_secs(15));
        let req = request(
            json!({"hermesCommand":"/bin/true","timeoutSec":0,"graceSec":0,"enabledToolsets":["terminal","file"]}),
            root.path(),
        );
        let hermes = resolve("hermes_local", "agent", None, None, &req).unwrap();
        assert_eq!(hermes.timeout, Some(Duration::from_secs(1800)));
        assert_eq!(hermes.grace, Duration::from_secs(10));
        assert!(
            hermes
                .args
                .windows(2)
                .any(|pair| pair == ["-t", "terminal,file"])
        );
    }
    #[test]
    fn session_saved_for_another_workspace_is_not_resumed() {
        let root = tempfile::tempdir().unwrap();
        let req = request(json!({"command":"/bin/true"}), root.path());
        let launch = resolve(
            "codex_local",
            "agent",
            Some(&json!({"sessionId":"old","cwd":root.path().join("different")})),
            Some("old"),
            &req,
        )
        .unwrap();
        assert_eq!(launch.resumed_session, None);
        assert!(!launch.args.iter().any(|arg| arg == "resume"));
    }
    #[test]
    fn cursor_effort_replaces_only_existing_effort_parameter() {
        assert_eq!(
            cursor_model(&json!({"model":"model[fast=true,effort=low]","effort":"HIGH"})),
            "model[fast=true,effort=high]"
        );
    }
}
