//! Existing noninteractive local-provider CLI shapes for ephemeral titles.
//! The owned native process host supplies disconnect, timeout and cleanup.
use super::{Error, Output, Request, timeout};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};
#[path = "process.rs"]
mod process;
#[path = "projection.rs"]
mod projection;
fn string<'a>(config: &'a Value, key: &str, default: &'a str) -> &'a str {
    config[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(default)
}
fn nonblank<'a>(config: &'a Value, key: &str) -> Option<&'a str> {
    config[key]
        .as_str()
        .map(str::trim)
        .filter(|v| !v.is_empty())
}
fn cursor_model(config: &Value) -> String {
    let model = string(config, "model", "auto").trim();
    if model.is_empty() {
        return String::new();
    }
    let (base, raw) = model.split_once('[').map_or((model, ""), |(base, rest)| {
        (base, rest.strip_suffix(']').unwrap_or(""))
    });
    let mut parameters = raw
        .split(',')
        .map(str::trim)
        .filter(|v| {
            !v.is_empty()
                && !v
                    .split_once('=')
                    .is_some_and(|(key, _)| key.trim().eq_ignore_ascii_case("effort"))
        })
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if let Some(effort) = nonblank(config, "effort")
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
fn args(config: &Value, key: &str) -> Vec<String> {
    config[key]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
fn executable(command: &str, cwd: &Path, env: &BTreeMap<String, String>) -> Result<String, Error> {
    let command = Path::new(command);
    if command.is_absolute() {
        return Ok(command.to_string_lossy().into());
    }
    if command.components().count() > 1 {
        return Ok(cwd.join(command).to_string_lossy().into());
    }
    let search = env.get("PATH").map(String::as_str).unwrap_or("");
    for root in std::env::split_paths(search) {
        let path = root.join(command);
        if path.is_file() {
            return Ok(path.to_string_lossy().into());
        }
        #[cfg(windows)]
        {
            let path = path.with_extension("exe");
            if path.is_file() {
                return Ok(path.to_string_lossy().into());
            }
        }
    }
    Err(Error::Failed(
        "Default Intelligence provider is not available".into(),
    ))
}
pub(super) async fn execute(
    runtime: &str,
    config: &Value,
    request: &Request,
) -> Result<Output, Error> {
    if runtime == "http" {
        return http(config, request).await;
    }
    let mut env = request.env.clone();
    if let Some(bindings) = config["env"].as_object() {
        for (k, v) in bindings {
            if let Some(v) = v.as_str() {
                env.insert(k.clone(), v.into());
            }
        }
    }
    let mut extra = args(config, "extraArgs");
    if extra.is_empty() {
        extra = args(config, "args");
    }
    let (command, mut argv, stdin, cwd) = match runtime {
        "process" => (
            string(config, "command", "").to_owned(),
            args(config, "args"),
            Some(request.prompt.clone()),
            PathBuf::from(
                std::env::var("RUDDER_NATIVE_HOST_PROCESS_WORKING_DIRECTORY")
                    .unwrap_or_else(|_| request.cwd.to_string_lossy().into()),
            ),
        ),
        "codex_local" => {
            let mut a = vec![
                "exec".into(),
                "--json".into(),
                "--disable".into(),
                "plugins".into(),
                "--skip-git-repo-check".into(),
            ];
            if config["search"] == true {
                a.insert(0, "--search".into());
            }
            if config["dangerouslyBypassApprovalsAndSandbox"]
                .as_bool()
                .unwrap_or(config["dangerouslyBypassSandbox"] == true)
            {
                a.push("--dangerously-bypass-approvals-and-sandbox".into());
            }
            a.extend([
                "--model".into(),
                nonblank(config, "model").unwrap_or("gpt-5.6-luna").into(),
            ]);
            let effort = nonblank(config, "modelReasoningEffort")
                .or_else(|| nonblank(config, "reasoningEffort"))
                .unwrap_or("medium");
            a.extend([
                "-c".into(),
                format!(
                    "model_reasoning_effort={}",
                    serde_json::to_string(effort).unwrap()
                ),
            ]);
            a.append(&mut extra);
            a.extend([
                "-c".into(),
                "skills.bundled.enabled=false".into(),
                "-".into(),
            ]);
            (
                string(config, "command", "codex").into(),
                a,
                Some(request.prompt.clone()),
                request.cwd.clone(),
            )
        }
        "claude_local" => {
            let mut a = vec![
                "--print".into(),
                "-".into(),
                "--output-format".into(),
                "stream-json".into(),
                "--verbose".into(),
            ];
            if config["dangerouslySkipPermissions"] == true {
                a.push("--dangerously-skip-permissions".into());
            } else {
                a.extend([
                    "--permission-mode".into(),
                    nonblank(config, "permissionMode")
                        .filter(|v| {
                            ["acceptEdits", "auto", "default", "dontAsk", "plan"].contains(v)
                        })
                        .unwrap_or("auto")
                        .into(),
                ]);
            }
            if config["chrome"] == true {
                a.push("--chrome".into());
            }
            for (key, flag) in [("model", "--model"), ("effort", "--effort")] {
                if let Some(v) = config[key].as_str() {
                    a.extend([flag.into(), v.into()]);
                }
            }
            if let Some(max) = config["maxTurnsPerRun"].as_u64().filter(|v| *v > 0) {
                a.extend(["--max-turns".into(), max.to_string()]);
            }
            a.append(&mut extra);
            (
                string(config, "command", "claude").into(),
                a,
                Some(request.prompt.clone()),
                request.cwd.clone(),
            )
        }
        "cursor" => {
            let mut a = vec![
                "-p".into(),
                "--output-format".into(),
                "stream-json".into(),
                "--workspace".into(),
                request.cwd.to_string_lossy().into(),
            ];
            let model = cursor_model(config);
            if !model.is_empty() {
                a.extend(["--model".into(), model]);
            }
            let mode = string(config, "mode", "").trim().to_ascii_lowercase();
            if ["plan", "ask"].contains(&mode.as_str()) {
                a.extend(["--mode".into(), mode]);
            }
            if !extra.iter().any(|v| {
                matches!(v.as_str(), "--trust" | "--yolo" | "-f") || v.starts_with("--trust=")
            }) {
                a.push("--yolo".into());
            }
            a.append(&mut extra);
            (
                string(config, "command", "cursor-agent").into(),
                a,
                Some(request.prompt.clone()),
                request.cwd.clone(),
            )
        }
        "pi_local" => {
            let mut a = vec![
                "--print".into(),
                "--mode".into(),
                "json".into(),
                "--no-skills".into(),
            ];
            let model = string(config, "model", "").trim();
            let (provider, model) = model
                .split_once('/')
                .map_or((None, model), |(provider, model)| {
                    (Some(provider.trim()), model.trim())
                });
            if let Some(provider) = provider.filter(|v| !v.is_empty()) {
                a.extend(["--provider".into(), provider.into()]);
            }
            if !model.is_empty() {
                a.extend(["--model".into(), model.into()]);
            }
            if let Some(thinking) = nonblank(config, "thinking") {
                a.extend(["--thinking".into(), thinking.into()]);
            }
            a.append(&mut extra);
            a.push(request.prompt.clone());
            (
                string(config, "command", "pi").into(),
                a,
                None,
                request.cwd.clone(),
            )
        }
        "opencode_local" => {
            let mut a = vec![
                "run".into(),
                "--pure".into(),
                "--format".into(),
                "json".into(),
                "--dir".into(),
                request.cwd.to_string_lossy().into(),
            ];
            for (key, flag) in [("model", "--model"), ("variant", "--variant")] {
                if let Some(v) = config[key].as_str() {
                    a.extend([flag.into(), v.into()]);
                }
            }
            if config["dangerouslySkipPermissions"] == true {
                a.push("--dangerously-skip-permissions".into());
            }
            a.append(&mut extra);
            (
                string(config, "command", "opencode").into(),
                a,
                Some(request.prompt.clone()),
                request.cwd.clone(),
            )
        }
        "hermes_local" => {
            let mut a = vec!["chat".into(), "-q".into(), request.prompt.clone()];
            if config["quiet"] != false {
                a.push("-Q".into());
            }
            for (key, flag) in [
                ("model", "-m"),
                ("provider", "--provider"),
                ("toolsets", "-t"),
            ] {
                if let Some(v) = config[key].as_str() {
                    a.extend([flag.into(), v.into()]);
                }
            }
            if let Some(max) = config["maxTurnsPerRun"].as_u64().filter(|v| *v > 0) {
                a.extend(["--max-turns".into(), max.to_string()]);
            }
            a.extend(["--source".into(), "tool".into(), "--yolo".into()]);
            a.append(&mut extra);
            (
                string(config, "hermesCommand", "hermes").into(),
                a,
                None,
                request.cwd.clone(),
            )
        }
        _ => {
            return Err(Error::Failed(
                "Default Intelligence provider is not available".into(),
            ));
        }
    };
    if command.is_empty() {
        return Err(Error::Failed("Process adapter missing command".into()));
    }
    let command = executable(&command, &cwd, &env)?;
    let timeout = timeout(config);
    let grace = Duration::from_secs_f64(
        config["graceSec"]
            .as_f64()
            .filter(|v| v.is_finite() && *v >= 0.0)
            .unwrap_or(15.0),
    );
    let owned = Request {
        workspace_guard: request.workspace_guard.clone(),
        org_id: request.org_id.clone(),
        run_id: request.run_id.clone(),
        prompt: request.prompt.clone(),
        cwd: request.cwd.clone(),
        process_host: request.process_host.clone(),
        runtime_root: request.runtime_root.clone(),
        env: request.env.clone(),
        cancelled: request.cancelled.clone(),
    };
    let runtime = runtime.to_owned();
    tokio::task::spawn_blocking(move || {
        let capture = process::run(
            &owned,
            command,
            std::mem::take(&mut argv),
            &cwd,
            env,
            stdin,
            timeout,
            grace,
        )?;
        Ok(projection::parse(
            &runtime,
            &capture.stdout,
            &capture.stderr,
            capture.success,
        ))
    })
    .await
    .map_err(|_| Error::Failed("Title process worker interrupted".into()))?
}
async fn http(config: &Value, request: &Request) -> Result<Output, Error> {
    let client = reqwest::Client::new();
    let method = string(config, "method", "POST")
        .parse()
        .map_err(|_| Error::Failed("HTTP adapter method is invalid".into()))?;
    let mut body = config["payloadTemplate"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    body.insert(
        "agentId".into(),
        Value::String("product-intelligence-default".into()),
    );
    body.insert("runId".into(), Value::String(request.run_id.clone()));
    body.insert("context".into(),serde_json::json!({"rudderScene":"product_intelligence","chatMode":true,"chatPrompt":request.prompt,"productIntelligence":{"purpose":"default","feature":"messenger_group_title"},"rudderWorkspace":{"source":"product_intelligence","strategy":"none","cwd":request.cwd,"agentHome":request.cwd}}));
    let mut call = client
        .request(method, string(config, "url", ""))
        .json(&body);
    if let Some(headers) = config["headers"].as_object() {
        for (k, v) in headers {
            if let Some(v) = v.as_str() {
                call = call.header(k, v);
            }
        }
    }
    if let Some(ms) = config["timeoutMs"]
        .as_f64()
        .filter(|v| v.is_finite() && *v > 0.0)
    {
        call = call.timeout(Duration::from_secs_f64(ms / 1000.0));
    }
    let response = call.send().await.map_err(|error| {
        Error::Failed(
            if error.is_timeout() {
                "HTTP request timed out"
            } else if error.is_connect() {
                "HTTP connection failed"
            } else {
                "HTTP invoke failed"
            }
            .into(),
        )
    })?;
    if !response.status().is_success() {
        return Err(Error::Failed(format!(
            "HTTP invoke failed with status {}",
            response.status().as_u16()
        )));
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        Error::Failed(
            if error.is_timeout() {
                "HTTP request timed out"
            } else {
                "HTTP stream disconnected"
            }
            .into(),
        )
    })? {
        if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
            return Err(Error::Failed(
                "HTTP runtime response exceeded 4194304 bytes".into(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let text = String::from_utf8_lossy(&bytes);
    let parsed = serde_json::from_str::<Value>(&text).ok();
    let output = if let Some(v) = parsed.filter(Value::is_object) {
        ["text", "message", "content", "summary"]
            .iter()
            .find_map(|k| {
                v[k].as_str()
                    .filter(|s| !s.trim().is_empty())
                    .map(|s| s.trim().to_owned())
            })
            .unwrap_or_default()
    } else {
        text.trim().into()
    };
    Ok(Output::success(output))
}

pub(super) fn network(evidence: &str, tools: bool) -> bool {
    projection::network(evidence, tools)
}

#[cfg(test)]
mod config_tests {
    use super::*;
    #[test]
    fn cursor_model_keeps_other_parameters_and_replaces_effort() {
        assert_eq!(cursor_model(&serde_json::json!({})), "auto");
        assert_eq!(
            cursor_model(
                &serde_json::json!({"model":" model[effort=low,fast=true] ","effort":" HIGH "})
            ),
            "model[fast=true,effort=high]"
        );
        assert_eq!(
            cursor_model(&serde_json::json!({"model":"model[effort=low]","effort":"auto"})),
            "model"
        );
    }
}
