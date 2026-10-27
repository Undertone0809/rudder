//! Agent adapter terminal/session/usage projection. Raw protocol artifacts are
//! retained independently from the user-facing summary.
use super::{AgentProcessLaunch, AgentRunExecutionObservation, AgentRunExecutionState};
use serde_json::{Value, json};

fn text(value: &Value) -> String {
    if let Some(value) = value.as_str() {
        return value.to_owned();
    }
    if let Some(parts) = value.as_array() {
        return parts
            .iter()
            .filter(|v| matches!(v["type"].as_str(), Some("text" | "output_text")))
            .filter_map(|v| v["text"].as_str())
            .collect::<Vec<_>>()
            .join("");
    }
    [
        "message", "error", "detail", "result", "text", "code", "name",
    ]
    .iter()
    .find_map(|key| value.get(key).map(text).filter(|s| !s.is_empty()))
    .unwrap_or_default()
}
fn string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value[*key]
            .as_str()
            .filter(|v| !v.trim().is_empty())
            .map(str::to_owned)
    })
}
fn num(value: &Value, keys: &[&str]) -> f64 {
    keys.iter()
        .find_map(|key| value[*key].as_f64().filter(|v| v.is_finite()))
        .unwrap_or_default()
}

pub(super) fn parse(
    runtime: &str,
    config: &Value,
    launch: &AgentProcessLaunch,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    signal: Option<String>,
) -> AgentRunExecutionObservation {
    let mut messages = Vec::new();
    let mut events = Vec::new();
    let mut session = launch.resumed_session.clone();
    let mut terminal = false;
    let mut model_output = false;
    let mut tools = false;
    let mut error = None;
    let mut raw_result = Value::Null;
    let mut input = 0.0;
    let mut output = 0.0;
    let mut cached = 0.0;
    let mut cost = None;
    let mut model = config["model"]
        .as_str()
        .unwrap_or(if runtime == "codex_local" {
            "gpt-5.6-luna"
        } else {
            ""
        })
        .to_owned();
    for raw in stdout.lines() {
        let raw = raw.trim();
        let line = if runtime == "cursor" {
            raw.strip_prefix("stdout")
                .or_else(|| raw.strip_prefix("stderr"))
                .map(|v| v.trim_start_matches([' ', ':', '=']))
                .unwrap_or(raw)
        } else {
            raw
        };
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if !event.is_object() {
            continue;
        }
        let kind = event["type"].as_str().unwrap_or("");
        events.push(event.clone());
        tools |= matches!(
            kind,
            "tool_use" | "tool_execution_start" | "tool_execution_end"
        ) || matches!(
            event["item"]["type"].as_str(),
            Some(
                "command_execution"
                    | "mcp_tool_call"
                    | "tool_call"
                    | "function_call"
                    | "web_search"
            )
        );
        match runtime {
            "codex_local" => match kind {
                "thread.started" => {
                    session = string(&event, &["thread_id"]).or(session);
                }
                "item.completed" if event["item"]["type"] == "agent_message" => {
                    let value = text(&event["item"]["text"]);
                    if !value.is_empty() {
                        messages.push(value);
                        model_output = true;
                    }
                }
                "turn.completed" => {
                    terminal = true;
                    input = num(&event["usage"], &["input_tokens"]);
                    cached = num(&event["usage"], &["cached_input_tokens"]);
                    output = num(&event["usage"], &["output_tokens"]);
                    if messages.is_empty() {
                        let value = text(&event["result"]);
                        if !value.is_empty() {
                            messages.push(value);
                        }
                    }
                }
                "turn.failed" | "error" => {
                    terminal = true;
                    let value = text(event.get("error").unwrap_or(&event));
                    if !value.is_empty()
                        && !super::transcript::is_codex_closed_stdin_warning(&value)
                    {
                        error = Some(value);
                    }
                }
                _ => (),
            },
            "claude_local" | "cursor" => {
                session = string(&event, &["session_id", "sessionId", "sessionID"]).or(session);
                if kind == "system" && event["subtype"] == "init" {
                    if let Some(value) = event["model"].as_str() {
                        model = value.into();
                    }
                }
                if kind == "assistant" {
                    let message = &event["message"];
                    let value = if message.is_string() {
                        text(message)
                    } else {
                        let content = text(&message["content"]);
                        if content.is_empty() {
                            text(&message["text"])
                        } else {
                            content
                        }
                    };
                    if !value.is_empty() {
                        messages.push(value);
                        model_output = true;
                    }
                    tools |= message["content"].as_array().is_some_and(|parts| {
                        parts.iter().any(|v| {
                            matches!(
                                v["type"].as_str(),
                                Some(
                                    "tool_use"
                                        | "tool_result"
                                        | "server_tool_use"
                                        | "mcp_tool_use"
                                        | "tool_call"
                                        | "function_call"
                                )
                            )
                        })
                    });
                }
                if kind == "result" {
                    terminal = true;
                    let usage = &event["usage"];
                    let current_input = num(usage, &["input_tokens", "inputTokens"]);
                    let current_cached = if runtime == "claude_local" {
                        num(usage, &["cache_read_input_tokens"])
                            + num(usage, &["cache_creation_input_tokens"])
                    } else {
                        num(
                            usage,
                            &[
                                "cached_input_tokens",
                                "cachedInputTokens",
                                "cache_read_input_tokens",
                            ],
                        )
                    };
                    let current_output = num(usage, &["output_tokens", "outputTokens"]);
                    if runtime == "claude_local" {
                        input = current_input;
                        cached = current_cached;
                        output = current_output;
                    } else {
                        input += current_input;
                        cached += current_cached;
                        output += current_output;
                    }
                    if let Some(value) = ["total_cost_usd", "cost_usd", "cost"]
                        .iter()
                        .find_map(|key| event[*key].as_f64())
                    {
                        cost = Some(cost.unwrap_or(0.0) + value);
                    }
                    let result = text(&event["result"]);
                    if runtime == "claude_local" {
                        raw_result = event.clone();
                        if !result.is_empty() {
                            messages.clear();
                            messages.push(result.clone());
                        }
                    } else if messages.is_empty() && !result.is_empty() {
                        messages.push(result.clone());
                    }
                    if event["is_error"] == true
                        || event["subtype"]
                            .as_str()
                            .is_some_and(|v| v.starts_with("error"))
                    {
                        let detail = text(
                            event
                                .get("error")
                                .or_else(|| event.get("result"))
                                .unwrap_or(&event),
                        );
                        error = Some(if detail.is_empty() {
                            "Provider result reported failure".into()
                        } else {
                            detail
                        });
                    }
                }
                if kind == "error" || (kind == "system" && event["subtype"] == "error") {
                    error = Some(text(&event));
                }
                if runtime == "cursor" && kind == "text" {
                    let value = text(&event["part"]["text"]);
                    if !value.is_empty() {
                        messages.push(value);
                    }
                }
            }
            "opencode_local" => {
                session = string(&event, &["sessionID"]).or(session);
                if kind == "text" {
                    let value = text(&event["part"]["text"]);
                    let synthetic = event["part"]["synthetic"] == true
                        || event["part"]["metadata"]["compaction_continue"] == true
                        || value.starts_with("## Goal\n")
                            && value.contains("\n## Critical Context\n");
                    if !synthetic
                        && !value.trim_start().starts_with("<tool_call>")
                        && !value.is_empty()
                    {
                        messages.push(value);
                        model_output = true;
                    }
                }
                if kind == "step_finish" {
                    terminal |= event["part"]["reason"] == "stop";
                    tools |= event["part"]["reason"] == "tool-calls";
                    let tokens = &event["part"]["tokens"];
                    input += num(tokens, &["input"]);
                    cached += num(&tokens["cache"], &["read"]);
                    output += num(tokens, &["output"]) + num(tokens, &["reasoning"]);
                    cost = Some(cost.unwrap_or(0.0) + num(&event["part"], &["cost"]));
                }
                if kind == "error" {
                    error = Some(text(
                        event
                            .get("error")
                            .or_else(|| event.get("message"))
                            .unwrap_or(&event),
                    ));
                }
                if kind == "tool_use" && event["part"]["state"]["status"] == "error" {
                    error = Some(text(&event["part"]["state"]["error"]));
                }
            }
            "pi_local" => {
                if matches!(
                    kind,
                    "response"
                        | "extension_ui_request"
                        | "extension_ui_response"
                        | "extension_error"
                ) {
                    continue;
                }
                if kind == "turn_end" {
                    let message = &event["message"];
                    let value = text(&message["content"]);
                    if !value.is_empty() {
                        messages.clear();
                        messages.push(value);
                        model_output = true;
                    }
                    if message["stopReason"] == "error" {
                        error = Some(text(&message["errorMessage"]));
                    }
                    let usage = &message["usage"];
                    input += num(usage, &["input"]);
                    cached += num(usage, &["cacheRead"]);
                    output += num(usage, &["output"]);
                    cost = Some(cost.unwrap_or(0.0) + num(&usage["cost"], &["total"]));
                    tools |= event["toolResults"]
                        .as_array()
                        .is_some_and(|v| !v.is_empty());
                }
                if kind == "agent_end" {
                    terminal = true;
                    if let Some(last) = event["messages"]
                        .as_array()
                        .and_then(|v| v.last())
                        .filter(|v| v["role"] == "assistant")
                    {
                        let value = text(&last["content"]);
                        if !value.is_empty() {
                            messages.clear();
                            messages.push(value);
                            model_output = true;
                        }
                    }
                }
                if kind == "usage" {
                    let usage = &event["usage"];
                    input += num(usage, &["inputTokens", "input"]);
                    cached += num(usage, &["cachedInputTokens", "cacheRead"]);
                    output += num(usage, &["outputTokens", "output"]);
                    cost = Some(
                        cost.unwrap_or(0.0)
                            + usage["costUsd"]
                                .as_f64()
                                .unwrap_or_else(|| num(&usage["cost"], &["total"])),
                    );
                }
            }
            _ => (),
        }
    }
    if runtime == "pi_local" {
        session = launch
            .env
            .get("RUDDER_PI_SESSION_FILE")
            .cloned()
            .or(session);
    }
    if runtime == "hermes_local" {
        let expression = regex::Regex::new(
            r"(?im)^session_id:\s*(\S+)|session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)",
        )
        .unwrap();
        session = expression
            .captures(&stdout)
            .and_then(|capture| capture.get(1).or_else(|| capture.get(2)))
            .map(|v| v.as_str().to_owned())
            .or(session);
        messages = vec![
            stdout
                .lines()
                .filter(|v| !v.trim_start().starts_with("session_id:"))
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_owned(),
        ];
        terminal = true;
        if config["persistSession"] == false {
            session = None;
        }
        let combined = format!("{stdout}\n{stderr}");
        if let Some(capture) =
            regex::Regex::new(r"(?i)tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b")
                .unwrap()
                .captures(&combined)
        {
            input = capture
                .get(1)
                .and_then(|v| v.as_str().parse().ok())
                .unwrap_or_default();
            output = capture
                .get(2)
                .and_then(|v| v.as_str().parse().ok())
                .unwrap_or_default();
        }
        cost = regex::Regex::new(r"(?i)(?:cost|spent)[:\s]*\$?([\d.]+)")
            .unwrap()
            .captures(&combined)
            .and_then(|capture| capture.get(1))
            .and_then(|v| v.as_str().parse::<f64>().ok());
        let errors: Vec<_> = stderr
            .lines()
            .filter(|line| {
                regex::Regex::new(r"(?i)error|exception|traceback|failed")
                    .unwrap()
                    .is_match(line)
            })
            .filter(|line| {
                !regex::Regex::new(r"(?i)INFO|DEBUG|warn")
                    .unwrap()
                    .is_match(line)
            })
            .take(5)
            .collect();
        if !errors.is_empty() {
            error = Some(errors.join("\n"));
        }
    }
    let structured = matches!(
        runtime,
        "claude_local" | "codex_local" | "cursor" | "opencode_local" | "pi_local"
    );
    if !structured && runtime != "hermes_local" {
        messages = vec![stdout.trim().to_owned()];
        terminal = true;
    }
    let summary = messages.join("\n\n").trim().to_owned();
    let mut state = if exit_code == Some(0) && signal.is_none() && error.is_none() {
        AgentRunExecutionState::Succeeded
    } else {
        AgentRunExecutionState::Failed
    };
    // A killed provider or truncated JSON stream never turns partial text into
    // a successful Codex/Claude Run merely because the child exited zero.
    if matches!(runtime, "claude_local" | "codex_local") && !terminal {
        state = AgentRunExecutionState::Failed;
        error = Some("Runtime exited without a terminal provider result".into());
    }
    if runtime == "opencode_local" && summary.is_empty() && error.is_none() {
        state = AgentRunExecutionState::Failed;
        error = Some("OpenCode completed without a final text summary".into());
    }
    if state != AgentRunExecutionState::Succeeded && error.as_ref().is_none_or(|v| v.is_empty()) {
        error = Some(
            stderr
                .lines()
                .find(|v| !v.trim().is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    format!(
                        "Runtime process exited with code {}",
                        exit_code.unwrap_or(-1)
                    )
                }),
        );
    }
    let mut session_params = session
        .as_ref()
        .map(|id| json!({"sessionId":id,"cwd":launch.cwd}));
    if let Some(params) = session_params.as_mut() {
        for (key, context_key) in [
            ("workspaceId", "workspaceId"),
            ("repoUrl", "workspaceRepoUrl"),
            ("repoRef", "workspaceRepoRef"),
        ] {
            if let Some(value) = config[context_key].as_str().filter(|v| !v.is_empty()) {
                params[key] = json!(value);
            }
        }
    }
    let evidence = format!("{}\n{stdout}\n{stderr}", error.as_deref().unwrap_or(""));
    let unknown_session = launch.resumed_session.is_some() && regex::Regex::new(r"(?i)unknown\s+(?:session|thread|chat)|(?:session|thread|chat|conversation).*not\s+found|could\s+not\s+resume|missing rollout path|no rollout found|no conversation found|notfounderror|no session").unwrap().is_match(&evidence);
    let mut error_code = unknown_session.then(|| "runtime_session_unavailable".to_owned());
    let auth = regex::Regex::new(r"(?i)not\s+logged\s+in|please\s+(?:log\s+in|run.*login)|login\s+required|unauthorized|authentication\s+(?:failed|required)|invalid[_ -]?api[_ -]?key").unwrap().is_match(&evidence);
    let codex_provider_auth = runtime == "codex_local"
        && super::codex_failure::provider_auth_failure(&evidence).is_some();
    if state != AgentRunExecutionState::Succeeded
        && (codex_provider_auth || runtime != "codex_local" && auth)
    {
        error_code = Some(
            match runtime {
                "claude_local" => "claude_auth_required",
                "codex_local" => "codex_provider_auth_required",
                "pi_local" => "pi_auth_required",
                _ => "runtime_auth_required",
            }
            .into(),
        );
    }
    if runtime=="cursor" && state!=AgentRunExecutionState::Succeeded && regex::Regex::new(r"(?i)usage\s+limit|get\s+cursor\s+pro|quota|rate[-\s]?limit|too many requests|\b429\b|billing").unwrap().is_match(&evidence) {
        error_code=Some("cursor_quota_exhausted".into());
    }
    let provider = match runtime {
        "claude_local" => "anthropic",
        "codex_local" => "openai",
        "cursor" => super::billing::provider_from_model(&model).unwrap_or("unknown"),
        _ => model.split_once('/').map(|(p, _)| p).unwrap_or(""),
    };
    let network = if state == AgentRunExecutionState::Failed && !tools {
        network_suspension(
            &evidence,
            provider,
            &model,
            session.as_deref(),
            session_params.as_ref(),
            model_output,
            terminal,
        )
    } else {
        None
    };
    if network.is_some() {
        state = AgentRunExecutionState::Suspended;
        error_code = Some("provider_transport_unavailable".into());
    }
    let mut usage = if structured
        || runtime == "hermes_local" && (input != 0.0 || output != 0.0 || cost.is_some())
    {
        let (input, cached, output) =
            (token_count(input), token_count(cached), token_count(output));
        json!({"inputTokens":input,"cachedInputTokens":cached,"outputTokens":output,"rawInputTokens":input,"rawCachedInputTokens":cached,"rawOutputTokens":output,"provider":provider,"model":model,"billingType":"unknown"})
    } else {
        Value::Null
    };
    if runtime == "claude_local" {
        usage["billingType"] = json!(if launch
            .env
            .get("ANTHROPIC_API_KEY")
            .is_some_and(|v| !v.trim().is_empty())
        {
            "metered_api"
        } else {
            "subscription_included"
        });
        usage["rawUsage"] = raw_result["usage"].clone();
    }
    if let Some(cost) = cost.filter(|v| v.is_finite()) {
        usage["costUsd"] = json!(cost);
    }
    let mut result = json!({"stdout":stdout,"stderr":stderr,"summary":summary,"provider":provider,"model":model,"modelOutputObserved":model_output,"toolActivityObserved":tools,"terminalEventObserved":terminal});
    super::billing::apply(
        runtime,
        config,
        &launch.env,
        &model,
        provider,
        &mut usage,
        &mut result,
    );
    let max_turns = runtime == "claude_local"
        && (raw_result["subtype"] == "error_max_turns"
            || raw_result["stop_reason"] == "max_turns"
            || regex::Regex::new(r"(?i)max(?:imum)?\s+turns?")
                .unwrap()
                .is_match(raw_result["result"].as_str().unwrap_or("")));
    if !raw_result.is_null() {
        result["providerResult"] = raw_result;
    }
    if let Some(network) = network {
        result["networkSuspension"] = network;
    }
    if codex_provider_auth {
        result["providerFailure"] = json!({"classification":"authentication","retryable":false,"shortCircuited":false,"reason":"codex_provider_auth_required","readinessState":"failed"});
    }
    if let Some(id) = &session {
        result["sessionId"] = json!(id);
        result["sessionParamsAfter"] = session_params.clone().unwrap_or(Value::Null);
    }
    if unknown_session {
        result["sessionRecovery"] = json!({"kind":"missing_session","retryWithFreshSession":true});
    }
    if runtime == "cursor" && state != AgentRunExecutionState::Succeeded {
        session = None;
        session_params = None;
        if let Some(fields) = result.as_object_mut() {
            fields.remove("sessionId");
            fields.remove("sessionParamsAfter");
        }
    }
    AgentRunExecutionObservation {
        state,
        error_code,
        error,
        exit_code,
        signal,
        usage,
        result,
        session_id: session,
        session_params,
        clear_session: unknown_session || max_turns,
        stdout,
        stderr,
        events,
        cleanup_proof: None,
    }
}

pub(super) fn token_count(value: f64) -> i64 {
    if value.is_finite() {
        value.floor().max(0.0).min(i64::MAX as f64) as i64
    } else {
        0
    }
}

/// Exact conservative classifier policy from agent-runtime-utils/network-
/// suspension: credentials/quota/config/provider/tool failures stay terminal.
pub(super) fn network_suspension(
    evidence: &str,
    provider: &str,
    model: &str,
    session: Option<&str>,
    params: Option<&Value>,
    output: bool,
    terminal: bool,
) -> Option<Value> {
    let excluded = [
        r"(?i)\b(?:auth(?:entication)?|credential|login|logged\s+in|unauthori[sz]ed|invalid\s+(?:api[-_ ]?key|credential)|api[-_ ]?key|access\s+denied|401|403)\b",
        r"(?i)\b(?:quota|rate[-\s]?limit|too\s+many\s+requests|resource[_\s-]?exhausted|usage\s+limit|billing|429|402)\b",
        r"(?i)\b(?:invalid\s+(?:model|argument|request|parameter)|unknown\s+model|model\s+not\s+found|unsupported\s+model|bad\s+request|malformed|command\s+not\s+found|no\s+such\s+(?:file|directory)|permission\s+denied|400|404|405)\b",
        r"(?i)\b(?:5\d\d|internal\s+server\s+error|service\s+unavailable|provider\s+error)\b",
        r"(?i)\b(?:mcp|tool|function[_ -]?call|browser|shell|command)\b[\s\S]{0,100}\b(?:network|connect(?:ion)?|dns|socket|timeout|fetch|unreachable|reset|closed)\b|\b(?:network|connect(?:ion)?|dns|socket|timeout|fetch|unreachable|reset|closed)\b[\s\S]{0,100}\b(?:mcp|tool|function[_ -]?call|browser|shell|command)\b",
    ];
    if excluded
        .iter()
        .any(|p| regex::Regex::new(p).unwrap().is_match(evidence))
    {
        return None;
    }
    let transport = [
        ("dns", r"(?i)\b(?:enotfound|eai_again|err_name_not_resolved|name\s+resolution|getaddrinfo|dns\s+(?:lookup|failure|error))\b"),
        ("stream_disconnect", r"(?i)stream\s+(?:disconnected|closed)|connection\s+(?:reset|closed|aborted|dropped)|socket\s+(?:hang\s*up|closed|reset)|econnreset|econnaborted|broken\s+pipe|network\s+connection\s+(?:lost|closed)|fetch\s+failed"),
        ("timeout", r"(?i)\betimedout\b|\bconnect(?:ion)?\s+tim(?:e|ed)\s*out\b|\brequest\s+tim(?:e|ed)\s*out\b|network\s+timeout|deadline\s+exceeded"),
        ("connection", r"(?i)\beconnrefused\b|\bconnection\s+(?:refused|failed)\b|\bnetwork\s+unreachable\b|\bno\s+route\s+to\s+host\b|\btemporarily\s+unavailable\b"),
    ].iter().find_map(|(name, p)| regex::Regex::new(p).unwrap().is_match(evidence).then_some(*name))?;
    let phase = if output {
        "accepted"
    } else if terminal || session.is_some() {
        "indeterminate"
    } else {
        "pre_submission"
    };
    Some(
        json!({"kind":"network_unavailable","code":"provider_transport_unavailable","submissionPhase":phase,
        "continuation":if session.is_some() {"resume_same_session"} else if phase == "pre_submission" {"fresh_if_pristine"} else {"fail_closed"},
        "transport":transport,"provider":provider,"model":model,"sessionId":session,"sessionParams":params,
        "modelOutputObserved":output,"toolActivityObserved":false,"sideEffectRisk":if output || phase == "indeterminate" {"possible"} else {"none"},
        "message":evidence.lines().find(|v| !v.trim().is_empty()).unwrap_or("Provider transport unavailable"),"progress":{"modelOutputObserved":output,"toolActivityObserved":false}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeMap, time::Duration};
    fn launch() -> AgentProcessLaunch {
        AgentProcessLaunch {
            executable: "/bin/true".into(),
            args: Vec::new(),
            cwd: "/tmp/agent".into(),
            env: BTreeMap::new(),
            stdin: None,
            timeout: None,
            grace: Duration::ZERO,
            resumed_session: None,
        }
    }
    fn observed(
        runtime: &str,
        events: &[Value],
        stderr: &str,
        exit: i32,
    ) -> AgentRunExecutionObservation {
        parse(
            runtime,
            &json!({"model":"provider/model"}),
            &launch(),
            events
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
            stderr.into(),
            Some(exit),
            None,
        )
    }
    #[test]
    fn claude_preserves_terminal_result_usage_and_session() {
        let output = observed(
            "claude_local",
            &[
                json!({"type":"system","subtype":"init","session_id":"opaque","model":"claude-model"}),
                json!({"type":"result","result":"done","usage":{"input_tokens":12,"cache_read_input_tokens":3,"cache_creation_input_tokens":2,"output_tokens":7},"total_cost_usd":0.125}),
            ],
            "",
            0,
        );
        assert_eq!(output.state, AgentRunExecutionState::Succeeded);
        assert_eq!(output.session_id.as_deref(), Some("opaque"));
        assert_eq!(output.usage["cachedInputTokens"], 5.0);
        assert_eq!(output.usage["costUsd"], 0.125);
        assert_eq!(output.result["providerResult"]["result"], "done");
    }
    #[test]
    fn codex_partial_and_failed_streams_cannot_succeed_on_zero_exit() {
        let partial =
            json!({"type":"item.completed","item":{"type":"agent_message","text":"partial"}});
        assert_eq!(
            observed("codex_local", &[partial.clone()], "", 0).state,
            AgentRunExecutionState::Failed
        );
        let failed = observed(
            "codex_local",
            &[
                partial.clone(),
                json!({"type":"turn.failed","error":{"message":"provider rejected"}}),
            ],
            "",
            0,
        );
        assert_eq!(failed.state, AgentRunExecutionState::Failed);
        let complete = observed(
            "codex_local",
            &[
                json!({"type":"thread.started","thread_id":"thread"}),
                partial,
                json!({"type":"turn.completed","usage":{"input_tokens":4,"cached_input_tokens":2,"output_tokens":8}}),
            ],
            "",
            0,
        );
        assert_eq!(complete.state, AgentRunExecutionState::Succeeded);
        assert_eq!(complete.usage["outputTokens"], 8.0);
        assert_eq!(complete.session_id.as_deref(), Some("thread"));
    }
    #[test]
    fn pi_semantic_error_and_opencode_tool_error_are_terminal_failures() {
        let pi = observed(
            "pi_local",
            &[
                json!({"type":"turn_end","message":{"stopReason":"error","errorMessage":"credential missing","usage":{"input":3,"output":1}}}),
                json!({"type":"agent_end","messages":[]}),
            ],
            "",
            0,
        );
        assert_eq!(pi.state, AgentRunExecutionState::Failed);
        let opencode = observed(
            "opencode_local",
            &[
                json!({"type":"tool_use","part":{"state":{"status":"error","error":"tool network connection failed"}}}),
            ],
            "",
            0,
        );
        assert_eq!(opencode.state, AgentRunExecutionState::Failed);
        assert_eq!(opencode.result.get("networkSuspension"), None);
    }
    #[test]
    fn cursor_and_opencode_usage_keep_token_sources() {
        let cursor = observed(
            "cursor",
            &[
                json!({"type":"result","session_id":"cursor-session","result":"done","usage":{"inputTokens":5,"cachedInputTokens":2,"outputTokens":7},"cost_usd":0.2}),
            ],
            "",
            0,
        );
        assert_eq!(cursor.usage["inputTokens"], 5.0);
        assert_eq!(cursor.session_id.as_deref(), Some("cursor-session"));
        let opencode = observed(
            "opencode_local",
            &[
                json!({"type":"text","sessionID":"open-session","part":{"text":"done"}}),
                json!({"type":"step_finish","part":{"reason":"stop","tokens":{"input":4,"output":3,"reasoning":2,"cache":{"read":1}},"cost":0.1}}),
            ],
            "",
            0,
        );
        assert_eq!(opencode.state, AgentRunExecutionState::Succeeded);
        assert_eq!(opencode.usage["outputTokens"], 5.0);
    }
    #[test]
    fn provider_network_suspension_preserves_resume_and_side_effect_boundary() {
        let suspension = network_suspension(
            "stream disconnected",
            "openai",
            "model",
            Some("session"),
            None,
            true,
            false,
        )
        .unwrap();
        assert_eq!(suspension["continuation"], "resume_same_session");
        assert_eq!(suspension["submissionPhase"], "accepted");
        assert_eq!(suspension["sideEffectRisk"], "possible");
        for message in [
            "401 invalid api key connection failed",
            "quota exhausted network timeout",
            "provider error 503 connection failed",
            "MCP tool connection failed",
        ] {
            assert!(network_suspension(message, "", "", None, None, false, false).is_none());
        }
    }
    #[test]
    fn hermes_raw_mode_parses_session_usage_and_semantic_errors() {
        let output = parse(
            "hermes_local",
            &json!({}),
            &launch(),
            "done\nsession_id: hermes-session\n".into(),
            "tokens: 9 input 4 output\ncost: $0.25".into(),
            Some(0),
            None,
        );
        assert_eq!(output.session_id.as_deref(), Some("hermes-session"));
        assert_eq!(output.usage["inputTokens"], 9.0);
        assert_eq!(output.usage["costUsd"], 0.25);
        let output = parse(
            "hermes_local",
            &json!({}),
            &launch(),
            "partial".into(),
            "RuntimeError: failed".into(),
            Some(0),
            None,
        );
        assert_eq!(output.state, AgentRunExecutionState::Failed);
    }
}
