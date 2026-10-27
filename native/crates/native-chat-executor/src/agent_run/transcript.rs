//! Detached TranscriptEntry wire shapes from agent-runtime-utils/types.ts.
//! The durable output owner supplies observation timestamps as bytes arrive.
use serde_json::{Value, json};

fn text(value: &Value) -> String {
    if let Some(value) = value.as_str() {
        return value.into();
    }
    if let Some(parts) = value.as_array() {
        return parts
            .iter()
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
    }
    for key in [
        "message", "error", "detail", "text", "content", "output", "result", "code",
    ] {
        if let Some(value) = value.get(key) {
            let value = text(value);
            if !value.is_empty() {
                return value;
            }
        }
    }
    if value.is_null() {
        String::new()
    } else {
        value.to_string()
    }
}
fn number(value: &Value, keys: &[&str]) -> i64 {
    super::projection::token_count(
        keys.iter()
            .find_map(|key| value[*key].as_f64())
            .unwrap_or_default(),
    )
}
fn simple(kind: &str, ts: &str, text: String) -> Value {
    json!({"kind":kind,"ts":ts,"text":text})
}
fn blocks(message: &Value, ts: &str, user: bool) -> Vec<Value> {
    let mut entries = Vec::new();
    if let Some(value) = message.as_str().filter(|value| !value.is_empty()) {
        entries.push(simple(
            if user { "user" } else { "assistant" },
            ts,
            value.into(),
        ));
        return entries;
    }
    for block in message["content"].as_array().into_iter().flatten() {
        match block["type"].as_str().unwrap_or("") {
            "text"|"output_text" => {let value=text(&block["text"]);if !value.is_empty() {entries.push(simple(if user {"user"}else{"assistant"},ts,value));}},
            "thinking"=>{let value=text(&block["thinking"]);if !value.is_empty() {entries.push(simple("thinking",ts,value));}},
            "tool_use"|"tool_call"=>entries.push(json!({"kind":"tool_call","ts":ts,"name":block["name"].as_str().unwrap_or("unknown"),"toolUseId":block.get("id").or_else(||block.get("tool_use_id")),"input":block.get("input").cloned().unwrap_or_else(||json!({}))})),
            "tool_result"=>entries.push(json!({"kind":"tool_result","ts":ts,"toolUseId":block["tool_use_id"].as_str().unwrap_or(""),"content":text(&block["content"]),"isError":block["is_error"]==true})),
            _=>(),
        }
    }
    if entries.is_empty()
        && !user
        && let Some(value) = message["text"].as_str().filter(|value| !value.is_empty())
    {
        entries.push(simple("assistant", ts, value.into()));
    }
    entries
}
fn result(
    ts: &str,
    value: String,
    usage: &Value,
    cost: f64,
    subtype: &str,
    error: bool,
    errors: Vec<String>,
) -> Value {
    json!({"kind":"result","ts":ts,"text":value,"inputTokens":number(usage,&["input_tokens","inputTokens","input"]),"outputTokens":number(usage,&["output_tokens","outputTokens","output"]),"cachedTokens":number(usage,&["cached_input_tokens","cachedInputTokens","cache_read_input_tokens","cacheRead"])+number(usage,&["cache_creation_input_tokens"]),"costUsd":cost,"subtype":subtype,"isError":error,"errors":errors})
}

/// Parse one stdout line with the same detached assistant/tool/result shapes
/// consumed by Node's automation terminal effect and the Run transcript UI.
pub fn parse_agent_stdout_line(runtime: &str, line: &str, ts: &str) -> Vec<Value> {
    let trimmed = line.trim();
    let normalized = if runtime == "cursor" {
        trimmed
            .strip_prefix("stdout")
            .or_else(|| trimmed.strip_prefix("stderr"))
            .map(|line| line.trim_start_matches([' ', ':', '=']))
            .unwrap_or(trimmed)
    } else {
        trimmed
    };
    match serde_json::from_str::<Value>(normalized) {
        Ok(event) if event.is_object() => parse_agent_provider_event(runtime, &event, ts),
        _ => vec![simple("stdout", ts, line.into())],
    }
}

/// Native Gateway events already arrive as JSON rather than log-prefixed
/// strings. Preserve their provider event while projecting the same roles.
pub fn parse_agent_provider_event(runtime: &str, event: &Value, ts: &str) -> Vec<Value> {
    let ts = event["ts"].as_str().unwrap_or(ts);
    let kind = event["type"].as_str().unwrap_or("");
    match runtime {
        "claude_local" | "cursor" => match kind {
            "system" if event["subtype"] == "init" => vec![
                json!({"kind":"init","ts":ts,"model":event["model"].as_str().unwrap_or("unknown"),"sessionId":event["session_id"].as_str().unwrap_or("")}),
            ],
            "assistant" => blocks(&event["message"], ts, false),
            "user" => blocks(&event["message"], ts, true),
            "result" => vec![result(
                ts,
                text(&event["result"]),
                &event["usage"],
                event["total_cost_usd"]
                    .as_f64()
                    .or_else(|| event["cost_usd"].as_f64())
                    .unwrap_or_default(),
                event["subtype"].as_str().unwrap_or(""),
                event["is_error"] == true,
                event["errors"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(text)
                    .filter(|value| !value.is_empty())
                    .collect(),
            )],
            "error" => vec![simple("stderr", ts, text(event))],
            _ => vec![simple("stdout", ts, event.to_string())],
        },
        "codex_local" => match kind {
            "thread.started" => vec![
                json!({"kind":"init","ts":ts,"model":event["model"].as_str().unwrap_or("codex"),"sessionId":event["thread_id"].as_str().unwrap_or("")}),
            ],
            "turn.started" => vec![simple("system", ts, "turn started".into())],
            "item.started" | "item.completed" => {
                let item = &event["item"];
                let completed = kind == "item.completed";
                let id = item["id"].as_str().unwrap_or("unknown");
                match item["type"].as_str().unwrap_or("") {
                    "agent_message" | "reasoning" => {
                        let value = text(&item["text"]);
                        if value.is_empty() {
                            return Vec::new();
                        }
                        let mut entry = simple(
                            if item["type"] == "reasoning" {
                                "thinking"
                            } else {
                                "assistant"
                            },
                            ts,
                            value,
                        );
                        if item["delta"] == true {
                            entry["delta"] = json!(true);
                        }
                        if let Some(phase) = item["phase"]
                            .as_str()
                            .filter(|value| ["commentary", "final_answer"].contains(value))
                        {
                            entry["phase"] = json!(phase);
                        }
                        if let Some(id) = item["id"].as_str().filter(|value| !value.is_empty()) {
                            entry["segmentId"] = json!(id);
                        }
                        vec![entry]
                    }
                    "command_execution" if !completed => vec![
                        json!({"kind":"tool_call","ts":ts,"name":"command_execution","toolUseId":id,"input":{"id":id,"command":item["command"],"cwd":item["cwd"]}}),
                    ],
                    "command_execution" => {
                        let mut lines = Vec::new();
                        if let Some(command) = item["command"].as_str().filter(|v| !v.is_empty()) {
                            lines.push(format!("command: {command}"));
                        }
                        if let Some(status) = item["status"].as_str().filter(|v| !v.is_empty()) {
                            lines.push(format!("status: {status}"));
                        }
                        if let Some(code) = item["exit_code"].as_i64() {
                            lines.push(format!("exit_code: {code}"));
                        }
                        if let Some(output) =
                            item["aggregated_output"].as_str().filter(|v| !v.is_empty())
                        {
                            lines.push(String::new());
                            lines.push(output.trim_end().into());
                        }
                        vec![
                            json!({"kind":"tool_result","ts":ts,"toolUseId":id,"content":lines.join("\n"),"isError":item["exit_code"].as_i64().is_some_and(|code|code!=0)||matches!(item["status"].as_str(),Some("failed"|"errored"|"error"|"cancelled"))}),
                        ]
                    }
                    "mcp_tool_call" | "tool_call" | "function_call" | "web_search" | "tool_use"
                        if !completed =>
                    {
                        vec![
                            json!({"kind":"tool_call","ts":ts,"name":item["tool"].as_str().or_else(||item["name"].as_str()).unwrap_or(item["type"].as_str().unwrap_or("unknown")),"toolUseId":id,"input":item.get("arguments").or_else(||item.get("input")).cloned().unwrap_or_else(||json!({}))}),
                        ]
                    }
                    "mcp_tool_call" | "tool_call" | "function_call" | "web_search"
                    | "tool_result" => vec![
                        json!({"kind":"tool_result","ts":ts,"toolUseId":id,"content":text(item.get("result").or_else(||item.get("output")).or_else(||item.get("content")).unwrap_or(item)),"isError":item["is_error"]==true||matches!(item["status"].as_str(),Some("failed"|"error"|"errored"))}),
                    ],
                    "todo_list" => {
                        let items = todo_items(&item["items"]);
                        if items.is_empty() {
                            Vec::new()
                        } else {
                            vec![json!({"kind":"todo_list","ts":ts,"todoListId":id,"items":items})]
                        }
                    }
                    "user_message" | "userMessage" => Vec::new(),
                    _ => vec![simple(
                        "system",
                        ts,
                        format!(
                            "item {}: {}",
                            if completed { "completed" } else { "started" },
                            item["type"].as_str().unwrap_or("unknown")
                        ),
                    )],
                }
            }
            "turn.completed" => vec![result(
                ts,
                text(&event["result"]),
                &event["usage"],
                event["total_cost_usd"].as_f64().unwrap_or_default(),
                event["subtype"].as_str().unwrap_or(""),
                event["is_error"] == true,
                event["errors"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(text)
                    .filter(|value| !value.is_empty())
                    .collect(),
            )],
            "turn.failed" => {
                let error = text(&event["error"]);
                if is_codex_closed_stdin_warning(&error) {
                    return Vec::new();
                }
                vec![result(
                    ts,
                    text(&event["result"]),
                    &event["usage"],
                    event["total_cost_usd"].as_f64().unwrap_or_default(),
                    event["subtype"].as_str().unwrap_or("turn.failed"),
                    true,
                    vec![error],
                )]
            }
            "error" => {
                let message = text(event);
                if is_codex_closed_stdin_warning(&message) {
                    Vec::new()
                } else {
                    vec![simple("stderr", ts, message)]
                }
            }
            _ => vec![simple("stdout", ts, event.to_string())],
        },
        "pi_local" => match kind {
            "response"
            | "extension_ui_request"
            | "extension_ui_response"
            | "extension_error"
            | "message_start"
            | "message_end"
            | "tool_execution_update" => Vec::new(),
            "agent_start" => vec![simple("system", ts, "Pi agent started".into())],
            "agent_end" => vec![simple("system", ts, "Pi agent finished".into())],
            "turn_start" => vec![simple("system", ts, "Turn started".into())],
            "message_update" if event["assistantMessageEvent"]["type"] == "text_delta" => vec![
                json!({"kind":"assistant","ts":ts,"text":event["assistantMessageEvent"]["delta"],"delta":true}),
            ],
            "turn_end" => {
                let mut entries = Vec::new();
                let value = text(&event["message"]["content"]);
                if !value.is_empty() {
                    entries.push(simple("assistant", ts, value));
                }
                for tool in event["toolResults"].as_array().into_iter().flatten() {
                    entries.push(json!({"kind":"tool_result","ts":ts,"toolUseId":tool["toolCallId"].as_str().unwrap_or("unknown"),"toolName":tool["toolName"].as_str().unwrap_or(""),"content":text(&tool["content"]),"isError":tool["isError"]==true}));
                }
                if entries.is_empty() {
                    entries.push(simple("system", ts, "Turn ended".into()));
                }
                entries
            }
            "tool_execution_start" => vec![
                json!({"kind":"tool_call","ts":ts,"name":event["toolName"].as_str().unwrap_or("unknown"),"toolUseId":event["toolCallId"],"input":event["args"]}),
            ],
            "tool_execution_end" => vec![
                json!({"kind":"tool_result","ts":ts,"toolUseId":event["toolCallId"].as_str().unwrap_or("unknown"),"toolName":event["toolName"].as_str().unwrap_or(""),"content":text(&event["result"]),"isError":event["isError"]==true}),
            ],
            _ => vec![simple("stdout", ts, event.to_string())],
        },
        "opencode_local" => match kind {
            "text" => vec![simple("assistant", ts, text(&event["part"]["text"]))],
            "reasoning" => vec![simple("thinking", ts, text(&event["part"]["text"]))],
            "tool_use" => {
                let part = &event["part"];
                let state = &part["state"];
                let id = part["callID"]
                    .as_str()
                    .or_else(|| part["id"].as_str())
                    .unwrap_or("unknown");
                let mut entries = vec![
                    json!({"kind":"tool_call","ts":ts,"name":part["tool"].as_str().unwrap_or("tool"),"toolUseId":id,"input":state.get("input").cloned().unwrap_or_else(||json!({}))}),
                ];
                if matches!(state["status"].as_str(), Some("completed" | "error")) {
                    entries.push(json!({"kind":"tool_result","ts":ts,"toolUseId":id,"content":format!("status: {}\n\n{}",state["status"].as_str().unwrap_or(""),text(state.get("output").or_else(||state.get("error")).unwrap_or(&Value::Null))),"isError":state["status"]=="error"}));
                }
                entries
            }
            "step_finish" => {
                let part = &event["part"];
                let reason = part["reason"].as_str().unwrap_or("step");
                let mut entry = result(
                    ts,
                    reason.into(),
                    &part["tokens"],
                    part["cost"].as_f64().unwrap_or_default(),
                    reason,
                    false,
                    Vec::new(),
                );
                entry["cachedTokens"] = json!(number(&part["tokens"]["cache"], &["read"]));
                entry["outputTokens"] = json!(
                    number(&part["tokens"], &["output"]) + number(&part["tokens"], &["reasoning"])
                );
                vec![entry]
            }
            "error" => vec![simple(
                "stderr",
                ts,
                text(
                    event
                        .get("error")
                        .or_else(|| event.get("message"))
                        .unwrap_or(event),
                ),
            )],
            _ => vec![simple("stdout", ts, event.to_string())],
        },
        "openclaw_gateway" => {
            let payload = &event["payload"];
            let data = &payload["data"];
            match payload["stream"].as_str().unwrap_or("") {
                "assistant" => {
                    if let Some(delta) = data["delta"].as_str().filter(|value| !value.is_empty()) {
                        vec![json!({"kind":"assistant","ts":ts,"text":delta,"delta":true})]
                    } else {
                        let value = text(&data["text"]);
                        if value.is_empty() {
                            Vec::new()
                        } else {
                            vec![simple("assistant", ts, value)]
                        }
                    }
                }
                "error" => vec![simple("stderr", ts, text(data))],
                "lifecycle"
                    if matches!(
                        data["phase"].as_str(),
                        Some("error" | "failed" | "cancelled")
                    ) =>
                {
                    vec![simple("stderr", ts, text(data))]
                }
                _ => Vec::new(),
            }
        }
        "hermes_gateway" => match event["event"].as_str().unwrap_or("") {
            "message.delta" => vec![
                json!({"kind":"assistant","ts":ts,"text":text(event.get("delta").or_else(||event.get("content")).unwrap_or(event)),"delta":true}),
            ],
            "tool.start" | "tool.call" => vec![
                json!({"kind":"tool_call","ts":ts,"name":event.get("tool").or_else(||event.get("name")),"toolUseId":event.get("tool_call_id").or_else(||event.get("call_id")),"input":event.get("input").or_else(||event.get("arguments"))}),
            ],
            "tool.result" | "tool.end" => vec![
                json!({"kind":"tool_result","ts":ts,"toolUseId":event.get("tool_call_id").or_else(||event.get("call_id")),"content":text(event.get("output").or_else(||event.get("content")).unwrap_or(event)),"isError":event["is_error"]==true}),
            ],
            _ => vec![simple(
                "system",
                ts,
                event["event"].as_str().unwrap_or("Gateway event").into(),
            )],
        },
        _ => vec![simple("stdout", ts, event.to_string())],
    }
}

fn todo_items(value: &Value) -> Vec<Value> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let text = ["text", "title", "content", "task"]
                .iter()
                .find_map(|key| item[*key].as_str().filter(|value| !value.trim().is_empty()))?;
            let status = item["status"]
                .as_str()
                .or_else(|| item["state"].as_str())
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
                .replace([' ', '-'], "_");
            let status = if ["completed", "complete", "done"].contains(&status.as_str())
                || item["completed"] == true
            {
                "completed"
            } else if ["in_progress", "running", "active", "current"].contains(&status.as_str())
                || item["in_progress"] == true
                || item["current"] == true
                || item["active"] == true
            {
                "in_progress"
            } else {
                "pending"
            };
            Some(json!({"text":text,"status":status}))
        })
        .collect()
}

pub(super) fn is_codex_closed_stdin_warning(value: &str) -> bool {
    regex::Regex::new(r"(?i)\bwrite_stdin\b[\s\S]*\bstdin is closed\b|\brerun exec_command with tty=true to keep stdin open\b").unwrap()
        .is_match(&value.split_whitespace().collect::<Vec<_>>().join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn automation_entries_keep_node_roles_tools_and_real_observation_time() {
        let ts = "2026-10-28T10:00:00.000Z";
        let entries = parse_agent_provider_event(
            "claude_local",
            &json!({"type":"assistant","message":{"content":[{"type":"text","text":"done"},{"type":"tool_use","id":"call","name":"read","input":{"path":"file"}}]}}),
            ts,
        );
        assert_eq!(entries[0]["kind"], "assistant");
        assert_eq!(entries[0]["ts"], ts);
        assert_eq!(entries[1]["kind"], "tool_call");
        assert_eq!(entries[1]["toolUseId"], "call");
        let entries = parse_agent_provider_event(
            "pi_local",
            &json!({"type":"tool_execution_end","toolCallId":"call","toolName":"read","result":{"content":[{"type":"text","text":"body"}]},"isError":false}),
            ts,
        );
        assert_eq!(entries[0]["kind"], "tool_result");
        assert_eq!(entries[0]["content"], "body");
        let entries = parse_agent_provider_event(
            "codex_local",
            &json!({"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":3,"output_tokens":5}}),
            ts,
        );
        assert_eq!(entries[0]["kind"], "result");
        assert_eq!(entries[0]["inputTokens"].as_i64(), Some(12));
    }
}
