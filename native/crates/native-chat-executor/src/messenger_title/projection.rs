//! Only terminal provider output can become a title. Usage and session state
//! are intentionally ephemeral and never create an Agent Run.
use super::Output;
use serde_json::Value;
fn text_content(value: &Value) -> String {
    if let Some(v) = value.as_str() {
        v.into()
    } else {
        value
            .as_array()
            .map(|parts| {
                parts
                    .iter()
                    .filter(|p| p["type"] == "text")
                    .filter_map(|p| p["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default()
    }
}
pub(super) fn parse(runtime: &str, stdout: &str, stderr: &str, process_ok: bool) -> Output {
    if matches!(runtime, "process" | "hermes_local") {
        let text = if runtime == "hermes_local" {
            stdout
                .lines()
                .filter(|line| {
                    !line.to_ascii_lowercase().contains("session_id:")
                        && !line.starts_with("Session ID:")
                })
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            stdout.into()
        };
        return if process_ok {
            Output::success(text)
        } else {
            Output::failed(text)
        };
    }
    let mut messages = Vec::new();
    let mut tools = false;
    let mut terminal = false;
    let mut failed = false;
    let mut result = String::new();
    for line in stdout.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let kind = v["type"].as_str().unwrap_or("");
        tools |= matches!(kind, "tool_use" | "tool_execution_start")
            || matches!(
                v["item"]["type"].as_str(),
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
                "item.completed" if v["item"]["type"] == "agent_message" => {
                    if let Some(text) = v["item"]["text"].as_str() {
                        messages.push(text.into());
                    }
                }
                "turn.completed" => {
                    terminal = true;
                    result = v["result"].as_str().unwrap_or("").into();
                }
                "turn.failed" | "error" => failed = true,
                _ => (),
            },
            "claude_local" | "cursor" => match kind {
                "assistant" => {
                    let text = text_content(&v["message"]["content"]);
                    if !text.is_empty() {
                        messages.push(text);
                    }
                }
                "result" => {
                    terminal = true;
                    failed = v["is_error"] == true
                        || v["subtype"]
                            .as_str()
                            .is_some_and(|s| s.starts_with("error"));
                    result = v["result"].as_str().unwrap_or("").into();
                }
                "error" => failed = true,
                _ => (),
            },
            "pi_local" => match kind {
                "agent_end" => {
                    terminal = true;
                    if let Some(last) = v["messages"]
                        .as_array()
                        .and_then(|m| m.last())
                        .filter(|m| m["role"] == "assistant")
                    {
                        result = text_content(&last["content"]);
                    }
                }
                "message_end" if v["message"]["role"] == "assistant" => {
                    let text = text_content(&v["message"]["content"]);
                    if !text.is_empty() {
                        messages.push(text);
                    }
                }
                "error" => failed = true,
                _ => (),
            },
            "opencode_local" => match kind {
                "text" => {
                    if let Some(text) = v["part"]["text"].as_str() {
                        messages.push(text.into());
                    }
                }
                "step_finish" => terminal = true,
                "error" => failed = true,
                _ => (),
            },
            _ => (),
        }
    }
    let text = if runtime == "pi_local" && !result.is_empty() {
        result
    } else if !messages.is_empty() {
        messages.join("\n\n").trim().into()
    } else {
        result.trim().into()
    };
    let mut out = if process_ok && (terminal || runtime == "cursor") && !failed {
        Output::success(text)
    } else {
        Output::failed(text)
    };
    if runtime == "codex_local" {
        let error = format!("{stdout}\n{stderr}").to_ascii_lowercase();
        out.auth_failure = error.contains("401")
            && (error.contains("unauthorized")
                || error.contains("invalid_api_key")
                || error.contains("authentication required"));
    }
    if !out.success {
        out.suspended = network(&format!("{stdout}\n{stderr}"), tools);
    }
    out
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terminal_output_only() {
        let partial = "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Draft\"}}\n";
        assert!(!parse("codex_local", partial, "", true).success);
        let full = format!("{partial}{{\"type\":\"turn.completed\"}}\n");
        let result = parse("codex_local", &full, "", true);
        assert!(result.success);
        assert_eq!(result.text, "Draft");
        assert!(!parse("codex_local", &full, "", false).success);
    }
}

/// Literal existing provider-transport classifier: auth, quota, config,
/// provider 5xx and tool failures remain ordinary terminal failures.
pub(super) fn network(evidence: &str, tools: bool) -> bool {
    use regex::Regex;
    use std::sync::LazyLock;
    static EXCLUDE: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        [
 r"(?i)\b(?:auth(?:entication)?|credential|login|logged\s+in|unauthori[sz]ed|invalid\s+(?:api[-_ ]?key|credential)|api[-_ ]?key|access\s+denied|401|403)\b",
 r"(?i)\b(?:quota|rate[-\s]?limit|too\s+many\s+requests|resource[_\s-]?exhausted|usage\s+limit|billing|429|402)\b",
 r"(?i)\b(?:invalid\s+(?:model|argument|request|parameter)|unknown\s+model|model\s+not\s+found|unsupported\s+model|bad\s+request|malformed|command\s+not\s+found|no\s+such\s+(?:file|directory)|permission\s+denied|400|404|405)\b",
 r"(?i)\b(?:5\d\d|internal\s+server\s+error|service\s+unavailable|provider\s+error)\b",
 r"(?i)\b(?:mcp|tool|function[_ -]?call|browser|shell|command)\b[\s\S]{0,100}\b(?:network|connect(?:ion)?|dns|socket|timeout|fetch|unreachable|reset|closed)\b|\b(?:network|connect(?:ion)?|dns|socket|timeout|fetch|unreachable|reset|closed)\b[\s\S]{0,100}\b(?:mcp|tool|function[_ -]?call|browser|shell|command)\b",
 ].iter().map(|s|Regex::new(s).expect("literal provider failure regex")).collect()
    });
    static NETWORK: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)\b(?:enotfound|eai_again|err_name_not_resolved|name\s+resolution|getaddrinfo|dns\s+(?:lookup|failure|error))\b|stream\s+(?:disconnected|closed)|connection\s+(?:reset|closed|aborted|dropped|refused|failed)|socket\s+(?:hang\s*up|closed|reset)|econnreset|econnaborted|broken\s+pipe|network\s+connection\s+(?:lost|closed)|fetch\s+failed|\betimedout\b|\bconnect(?:ion)?\s+tim(?:e|ed)\s*out\b|\brequest\s+tim(?:e|ed)\s*out\b|network\s+timeout|deadline\s+exceeded|\beconnrefused\b|\bnetwork\s+unreachable\b|\bno\s+route\s+to\s+host\b|\btemporarily\s+unavailable\b").expect("literal provider network regex")
    });
    !tools && !EXCLUDE.iter().any(|r| r.is_match(evidence)) && NETWORK.is_match(evidence)
}
