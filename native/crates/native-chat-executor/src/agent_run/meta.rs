//! Emit the one resolved invocation before its one-use launch is consumed.
use super::{AgentProcessLaunch, AgentRunOutput, AgentRunRequest};
use serde_json::{Value, json};
use std::time::Duration;

pub(super) async fn emit(
    runtime: &str,
    request: &AgentRunRequest,
    launch: Option<&AgentProcessLaunch>,
) -> Result<(), String> {
    let Some(output) = &request.output else {
        return Ok(());
    };
    let metadata = metadata(runtime, request, launch);
    tokio::time::timeout(
        Duration::from_secs(5),
        output.send(AgentRunOutput::InvocationMeta { metadata }),
    )
    .await
    .map_err(|_| "Run invocation metadata persistence timed out".to_owned())?
    .map_err(|_| "Run invocation metadata persistence channel closed".to_owned())
}
fn metadata(
    runtime: &str,
    request: &AgentRunRequest,
    launch: Option<&AgentProcessLaunch>,
) -> Value {
    let sensitive =
        regex::Regex::new(r"(?i)key|token|secret|password|passwd|authorization|cookie").unwrap();
    let env = launch
        .map(|launch| &launch.env)
        .unwrap_or(&request.env)
        .iter()
        .map(|(key, value)| {
            (
                key.clone(),
                json!(if sensitive.is_match(key) {
                    "***REDACTED***"
                } else {
                    value.as_str()
                }),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    let (command, args, cwd) = if let Some(launch) = launch {
        let args = launch
            .args
            .iter()
            .map(|arg| {
                if matches!(runtime, "pi_local" | "hermes_local") && arg == &request.prompt {
                    format!("<prompt {} chars>", request.prompt.encode_utf16().count())
                } else {
                    arg.clone()
                }
            })
            .collect::<Vec<_>>();
        (launch.executable.clone(), args, launch.cwd.clone())
    } else {
        let command = if runtime == "hermes_gateway" {
            "hermes-api"
        } else {
            "openclaw-gateway"
        };
        (
            command.into(),
            vec![request.config["url"].as_str().unwrap_or("").into()],
            request.cwd.clone(),
        )
    };
    json!({"agentRuntimeType":runtime,"command":command,"commandArgs":args,"cwd":cwd,"env":env,"prompt":request.prompt,"promptMetrics":{"promptChars":request.prompt.encode_utf16().count()},"context":request.context})
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::BTreeMap,
        sync::{Arc, atomic::AtomicBool},
    };
    #[test]
    fn invocation_metadata_masks_provider_keys_and_positional_prompts() {
        let request = AgentRunRequest {
            prompt: "trusted prompt".into(),
            context: json!({}),
            config: json!({}),
            cwd: "/tmp/agent".into(),
            process_host: "/bin/true".into(),
            runtime_root: "/tmp/agent/runtime".into(),
            env: BTreeMap::new(),
            managed_args: Vec::new(),
            output: None,
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        let launch = AgentProcessLaunch {
            executable: "/bin/pi".into(),
            args: vec!["--print".into(), request.prompt.clone()],
            cwd: request.cwd.clone(),
            env: BTreeMap::from([
                ("OPENAI_API_KEY".into(), "secret-value".into()),
                ("PATH".into(), "/bin".into()),
            ]),
            stdin: None,
            timeout: None,
            grace: Duration::ZERO,
            resumed_session: None,
        };
        let metadata = metadata("pi_local", &request, Some(&launch));
        assert_eq!(metadata["env"]["OPENAI_API_KEY"], "***REDACTED***");
        assert_eq!(metadata["env"]["PATH"], "/bin");
        assert_eq!(metadata["commandArgs"][1], "<prompt 14 chars>");
    }
}
