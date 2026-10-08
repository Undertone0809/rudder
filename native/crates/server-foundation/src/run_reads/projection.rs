use super::{Surface, redaction::js_trim};
use rudder_d1_persistence::legacy_read_json::parse_legacy_read_json;
use serde_json::{Value, json};

fn timestamp(column: &str) -> String {
    format!("to_char({column} AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')")
}
fn object(fields: Vec<(&str, String)>) -> String {
    format!(
        "jsonb_build_object({})",
        fields
            .into_iter()
            .map(|(name, value)| format!("'{name}', {value}"))
            .collect::<Vec<_>>()
            .join(",")
    )
}

pub(super) fn run_projection(list: bool, surface: Surface) -> String {
    // This allowlist is deliberately built in SQL, before any JSON decoder.
    // Historical private fields may contain JSON much deeper than 512 levels.
    let fields = [
        ("id", "id"),
        ("orgId", "org_id"),
        ("agentId", "agent_id"),
        ("invocationSource", "invocation_source"),
        ("triggerDetail", "trigger_detail"),
        ("status", "status"),
        ("executionPhase", "running_substate"),
        ("error", "error"),
        ("wakeupRequestId", "wakeup_request_id"),
        ("sourceRunId", "source_run_id"),
        ("exitCode", "exit_code"),
        ("signal", "signal"),
        ("usageJson", "usage_json"),
        ("sessionIdBefore", "session_id_before"),
        ("sessionIdAfter", "session_id_after"),
        ("sessionReuseScope", "session_reuse_scope"),
        ("logStore", "log_store"),
        ("logRef", "log_ref"),
        ("logBytes", "log_bytes"),
        ("logSha256", "log_sha256"),
        ("logCompressed", "log_compressed"),
        ("stdoutExcerpt", "stdout_excerpt"),
        ("stderrExcerpt", "stderr_excerpt"),
        ("errorCode", "error_code"),
        ("externalRunId", "external_run_id"),
        ("chatConversationId", "chat_conversation_id"),
        ("goalId", "goal_id"),
        ("processPid", "process_pid"),
        ("networkWaitAttemptCount", "network_wait_attempt_count"),
        ("networkWaitDurationMs", "network_wait_duration_ms"),
        ("recoveryCheckpoint", "recovery_checkpoint"),
        ("retryOfRunId", "retry_of_run_id"),
        ("processLossRetryCount", "process_loss_retry_count"),
    ];
    let mut out = Vec::new();
    for (key, col) in fields {
        if matches!(surface, Surface::Agent) && matches!(key, "sourceRunId" | "wakeupRequestId") {
            continue;
        }
        out.push((
            key,
            if list && matches!(key, "stdoutExcerpt" | "stderrExcerpt") {
                "NULL".into()
            } else {
                format!("r.{col}")
            },
        ));
    }
    out.push((
        "shortRef",
        "'run_' || left(replace(r.id::text,'-',''),8)".into(),
    ));
    for (key, col) in [
        ("startedAt", "started_at"),
        ("finishedAt", "finished_at"),
        ("processStartedAt", "process_started_at"),
        ("networkWaitStartedAt", "network_wait_started_at"),
        ("networkWaitNextRetryAt", "network_wait_next_retry_at"),
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
    ] {
        out.push((key, timestamp(&format!("r.{col}"))));
    }
    if !list {
        out.push(("resultJson", "r.result_json".into()));
    }
    out.push(("contextSnapshot",r#"(CASE
 WHEN r.context_snapshot IS NULL OR r.context_snapshot IN ('null'::jsonb,'false'::jsonb,'""'::jsonb) THEN NULL
 WHEN jsonb_typeof(r.context_snapshot)='object' THEN r.context_snapshot
 WHEN jsonb_typeof(r.context_snapshot)='array' THEN coalesce((SELECT jsonb_object_agg((n-1)::text,v) FROM jsonb_array_elements(r.context_snapshot) WITH ORDINALITY c(v,n)),'{}'::jsonb)
 ELSE '{}'::jsonb END) - ARRAY['resumeSessionParams','resumeSessionDisplayId','forceFreshSession','sessionResumeSuppressed']::text[]
 - CASE WHEN r.context_snapshot->>'scene'='delegation' OR r.context_snapshot->>'rudderScene'='delegation'
 THEN ARRAY['delegationTask','sourceAgentId','targetAgentId','taskKey']::text[] ELSE ARRAY[]::text[] END"#.into()));
    format!(
        "({}) - CASE WHEN jsonb_typeof(r.context_snapshot)='number' OR (jsonb_typeof(r.context_snapshot)='string' AND r.context_snapshot <> '\"\"'::jsonb) THEN ARRAY['contextSnapshot']::text[] ELSE ARRAY[]::text[] END",
        object(out)
    )
}

/// JSONB numeric precision exceeds JavaScript Number. Decide truthiness from
/// the original scalar's f64 value, before final JSON normalization (Infinity
/// is truthy), without PostgreSQL float casts that can throw on under/overflow.
pub(super) fn public_number_context(
    value: &str,
) -> Result<&'static str, std::num::ParseFloatError> {
    Ok(if value.parse::<f64>()? == 0.0 {
        "null"
    } else {
        "{}"
    })
}

pub(super) fn public_string_context(value: &str) -> String {
    format!(
        "{{{}}}",
        value
            .encode_utf16()
            .enumerate()
            .map(|(index, unit)| {
                let encoded = if let Some(character) = char::from_u32(u32::from(unit)) {
                    serde_json::to_string(&character.to_string()).expect("JSON character")
                } else {
                    format!("\"\\u{unit:04x}\"")
                };
                format!("\"{index}\":{encoded}")
            })
            .collect::<Vec<_>>()
            .join(",")
    )
}

pub(super) fn origin_projection() -> String {
    let mut fields = vec![
        ("invocationSource", "to_jsonb(r.invocation_source)".into()),
        ("triggerDetail", "to_jsonb(r.trigger_detail)".into()),
        (
            "wakeupRequestId",
            "to_jsonb(r.wakeup_request_id::text)".into(),
        ),
        ("sourceRunId", "to_jsonb(r.source_run_id::text)".into()),
        (
            "chatConversationId",
            "to_jsonb(r.chat_conversation_id::text)".into(),
        ),
    ];
    for key in [
        "scene",
        "rudderScene",
        "conversationId",
        "messageId",
        "assistantMessageId",
        "userMessageId",
        "issueId",
        "automationRunId",
        "automationId",
        "targetType",
        "targetId",
        "triggerKind",
        "wakeReason",
        "wakeSource",
        "commentId",
        "wakeupRequestId",
        "sourceRunId",
    ] {
        // Prefix context keys to retain persisted-vs-context precedence.
        let sql = format!(
            "CASE WHEN jsonb_typeof(r.context_snapshot->'{key}')='string' THEN r.context_snapshot->'{key}' ELSE NULL END"
        );
        // The object is small and shallow even when the original context is huge.
        let name = match key {
            "wakeupRequestId" => "contextWakeupRequestId",
            "sourceRunId" => "contextSourceRunId",
            other => other,
        };
        fields.push((name, sql));
    }
    object(fields)
}
fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key)?.as_str().filter(|s| !js_trim(s).is_empty())
}
fn raw_text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key)?.as_str()
}
pub(super) fn origin(raw: &str) -> Result<Value, serde_json::Error> {
    let v: Value = serde_json::from_str(raw)?;
    let source = raw_text(&v, "invocationSource").unwrap_or("");
    let conversation = raw_text(&v, "chatConversationId").or_else(|| text(&v, "conversationId"));
    let message = text(&v, "messageId")
        .or_else(|| text(&v, "assistantMessageId"))
        .or_else(|| text(&v, "userMessageId"));
    let wakeup = raw_text(&v, "wakeupRequestId").or_else(|| text(&v, "contextWakeupRequestId"));
    let source_run = raw_text(&v, "sourceRunId").or_else(|| text(&v, "contextSourceRunId"));
    let scenes = [
        "issue",
        "chat",
        "automation",
        "review",
        "heartbeat",
        "delegation",
    ];
    let scene = text(&v, "scene")
        .filter(|s| scenes.contains(s))
        .or_else(|| text(&v, "rudderScene").filter(|s| scenes.contains(s)))
        .unwrap_or_else(|| {
            if source == "chat" || conversation.is_some() {
                "chat"
            } else if source == "review" {
                "review"
            } else if source == "delegation" {
                "delegation"
            } else if source == "timer" {
                "heartbeat"
            } else if text(&v, "automationRunId").is_some() {
                "automation"
            } else if text(&v, "issueId").is_some() {
                "issue"
            } else if source == "automation" {
                "automation"
            } else {
                "heartbeat"
            }
        });
    let targets = [
        "issue",
        "chat_conversation",
        "chat_message",
        "automation_run",
        "wakeup_request",
        "manual",
    ];
    let target_type = text(&v, "targetType")
        .filter(|s| targets.contains(s))
        .unwrap_or_else(|| {
            if conversation.is_some() {
                "chat_conversation"
            } else if text(&v, "automationRunId").is_some() {
                "automation_run"
            } else if text(&v, "issueId").is_some() {
                "issue"
            } else {
                "wakeup_request"
            }
        });
    let target_id = text(&v, "targetId").or_else(|| match target_type {
        "chat_conversation" => conversation,
        "chat_message" => message,
        "automation_run" => text(&v, "automationRunId"),
        "issue" => text(&v, "issueId"),
        "wakeup_request" => wakeup,
        _ => None,
    });
    let trigger = text(&v, "triggerKind").unwrap_or_else(|| {
        if text(&v, "commentId").is_some()
            || text(&v, "wakeSource") == Some("issue.comment")
            || matches!(
                text(&v, "wakeReason"),
                Some("issue_commented" | "issue_comment_mentioned")
            )
        {
            "issue_comment"
        } else if source == "review" {
            "review_routing"
        } else if source == "timer" {
            "timer"
        } else if source == "on_demand" && raw_text(&v, "triggerDetail") == Some("manual") {
            "manual"
        } else {
            raw_text(&v, "triggerDetail").unwrap_or(source)
        }
    });
    Ok(
        json!({"scene":scene,"triggerKind":trigger,"targetType":target_type,"targetId":target_id,"conversationId":conversation,"messageId":message,"issueId":text(&v,"issueId").or(if target_type=="issue"{target_id}else{None}),"automationRunId":text(&v,"automationRunId"),"automationId":text(&v,"automationId"),"wakeupRequestId":wakeup,"sourceRunId":source_run}),
    )
}

pub(super) fn summary_projection() -> String {
    let mut fields = Vec::new();
    for key in [
        "summary",
        "result",
        "message",
        "error",
        "userMessage",
        "body",
        "stdout",
        "provider",
        "biller",
        "model",
        "billingType",
        "total_cost_usd",
        "cost_usd",
        "costUsd",
    ] {
        fields.push((key,format!("CASE WHEN jsonb_typeof(r.result_summary_json->'{key}') IN ('string','number') THEN r.result_summary_json->'{key}' END")));
    }
    object(fields)
}
fn truncate_json(s: &str) -> String {
    let mut units: Vec<u16> = s.encode_utf16().take(500).collect();
    let lone = units
        .last()
        .copied()
        .filter(|unit| (0xd800..=0xdbff).contains(unit));
    if lone.is_some() {
        units.pop();
    }
    let mut encoded =
        serde_json::to_string(&String::from_utf16(&units).expect("complete UTF-16 prefix"))
            .expect("string encoding");
    if let Some(unit) = lone {
        encoded.pop();
        encoded.push_str(&format!("\\u{unit:04x}\""));
    }
    encoded
}
fn raw_field<'a>(fields: &[(super::redaction::JsString, &'a str)], key: &str) -> &'a str {
    fields
        .iter()
        .rev()
        .find(|(name, _)| name.eq_str(key))
        .map(|(_, raw)| *raw)
        .unwrap_or("null")
}
fn raw_string(raw: &str) -> Option<String> {
    serde_json::from_str::<String>(raw)
        .ok()
        .map(|s| js_trim(&s).to_owned())
        .filter(|s| !s.is_empty())
}
fn collect_message(raw: &str) -> Vec<String> {
    if let Some(s) = raw_string(raw) {
        return vec![s];
    }
    let Ok(fields) = super::redaction::object_fields(raw) else {
        return vec![];
    };
    let mut lines = Vec::new();
    if let Some(s) = raw_string(raw_field(&fields, "text")) {
        lines.push(s);
    }
    if let Ok(parts) = super::redaction::array_values(raw_field(&fields, "content")) {
        for part in parts {
            let Ok(part) = super::redaction::object_fields(part) else {
                continue;
            };
            if matches!(
                raw_string(raw_field(&part, "type")).as_deref(),
                Some("output_text" | "text" | "content")
            ) && let Some(s) = raw_string(raw_field(&part, "text"))
                .or_else(|| raw_string(raw_field(&part, "content")))
            {
                lines.push(s);
            }
        }
    }
    lines
}
fn extract_stdout(s: &str) -> Option<String> {
    let mut messages = Vec::new();
    let mut terminal = String::new();
    // Only the shallow fields that participate in summary selection are decoded.
    // The opaque transcript can contain deeply nested unrelated provider data.
    for line in s.split('\n') {
        let Ok(event) = super::redaction::object_fields(js_trim(line)) else {
            continue;
        };
        match raw_string(raw_field(&event, "type")).as_deref() {
            Some("assistant" | "turn_end") => {
                messages.extend(collect_message(raw_field(&event, "message")))
            }
            Some("item.completed") => {
                if let Ok(item) = super::redaction::object_fields(raw_field(&event, "item"))
                    && raw_string(raw_field(&item, "type")).as_deref() == Some("agent_message")
                    && let Some(s) = raw_string(raw_field(&item, "text"))
                {
                    messages.push(s);
                }
            }
            Some("agent_end") => {
                if let Ok(entries) = super::redaction::array_values(raw_field(&event, "messages")) {
                    for message in entries.iter().rev() {
                        let Ok(message) = super::redaction::object_fields(message) else {
                            continue;
                        };
                        if raw_string(raw_field(&message, "role")).as_deref() == Some("assistant") {
                            let content =
                                collect_message(raw_field(&message, "content")).join("\n\n");
                            let content = js_trim(&content).to_owned();
                            if !content.is_empty() {
                                messages.push(content);
                                break;
                            }
                        }
                    }
                }
            }
            Some("result") => {
                if let Some(s) = raw_string(raw_field(&event, "result"))
                    .or_else(|| raw_string(raw_field(&event, "text")))
                    .or_else(|| raw_string(raw_field(&event, "response")))
                {
                    terminal = s;
                }
            }
            _ => (),
        }
    }
    let joined = if terminal.is_empty() {
        js_trim(&messages.join("\n\n")).to_owned()
    } else {
        terminal
    };
    if joined.is_empty() {
        None
    } else {
        Some(joined)
    }
}
fn numeric_string(value: &str) -> Option<f64> {
    let trimmed = js_trim(value);
    if value.encode_utf16().count() > 64 || trimmed.is_empty() {
        return None;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = trimmed.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return None;
            }
            return u128::from_str_radix(digits, radix)
                .ok()
                .map(|n| n as f64)
                .or_else(|| {
                    Some(digits.chars().fold(0.0, |n, c| {
                        n * radix as f64 + c.to_digit(radix).unwrap() as f64
                    }))
                });
        }
    }
    trimmed.parse().ok()
}
pub(super) fn summarize(raw: &str) -> Result<String, serde_json::Error> {
    let v = parse_legacy_read_json(raw)?;
    let mut out = std::collections::BTreeMap::<&str, String>::new();
    for key in ["summary", "result", "message", "error", "userMessage"] {
        if let Some(s) = raw_text(&v, key) {
            out.insert(key, truncate_json(s));
        }
    }
    let has_text = |m: &std::collections::BTreeMap<&str, String>| {
        ["summary", "result", "message"]
            .iter()
            .any(|key| m.get(key).is_some_and(|value| value != "\"\""))
    };
    if !has_text(&out)
        && let Some(s) = raw_text(&v, "body").filter(|s| !s.is_empty())
    {
        out.insert("result", truncate_json(s));
    }
    for key in ["total_cost_usd", "cost_usd", "costUsd"] {
        let number = v[key]
            .as_f64()
            .or_else(|| v[key].as_str().and_then(numeric_string));
        if let Some(n) = number.filter(|n| n.is_finite()) {
            out.insert(key, json!(n).to_string());
        }
    }
    for key in ["provider", "biller", "model", "billingType"] {
        if let Some(s) = raw_text(&v, key) {
            out.insert(key, truncate_json(s));
        }
    }
    if !has_text(&out)
        && let Some(s) = raw_text(&v, "stdout").and_then(extract_stdout)
    {
        out.insert("result", truncate_json(&s));
    }
    Ok(if out.is_empty() {
        "null".into()
    } else {
        format!(
            "{{{}}}",
            out.into_iter()
                .map(|(k, v)| format!("\"{k}\":{v}"))
                .collect::<Vec<_>>()
                .join(",")
        )
    })
}
fn fallback(key: &str) -> &str {
    let key = js_trim(key);
    key.split('/')
        .rfind(|s| !s.is_empty())
        .or_else(|| key.split(':').rfind(|s| !s.is_empty()))
        .unwrap_or(key)
}
pub(super) fn add_skills(summary: &mut String, rows: &[String]) -> Result<(), serde_json::Error> {
    let mut skills: Vec<(String, String)> = Vec::new();
    for row in rows {
        let v: Value = serde_json::from_str(row)?;
        let read = |key| text(&v, key).map(js_trim);
        let Some(key) = read("key")
            .or_else(|| read("runtimeName"))
            .or_else(|| read("name"))
        else {
            continue;
        };
        let label = read("runtimeName")
            .or_else(|| read("name"))
            .unwrap_or_else(|| fallback(key));
        if let Some((_, existing)) = skills.iter_mut().find(|(k, _)| k == key) {
            if existing == fallback(key) && label != fallback(key) {
                *existing = label.to_owned();
            }
        } else {
            skills.push((key.to_owned(), label.to_owned()));
        }
    }
    if skills.is_empty() {
        return Ok(());
    }
    if summary == "null" {
        *summary = "{}".into();
    }
    let keys: Vec<_> = skills.iter().map(|(key, _)| key).collect();
    let payload: Vec<_> = skills
        .iter()
        .map(|(key, label)| json!({"key":key,"runtimeName":label,"name":label}))
        .collect();
    append_fields(
        summary,
        &json!({"usedSkillCount":skills.len(),"usedSkillKeys":keys,"usedSkills":payload,"skillEvidenceType":"used","skillEvidenceCount":skills.len(),"skillEvidenceKeys":keys,"skillEvidenceSkills":payload}),
    );
    Ok(())
}
pub(super) fn append_raw_fields(raw: &mut String, other: &str) {
    if other.len() > 2 {
        raw.pop();
        if raw.len() > 1 {
            raw.push(',');
        }
        raw.push_str(&other[1..]);
    }
}
pub(super) fn append_fields(raw: &mut String, other: &Value) {
    append_raw_fields(raw, &other.to_string());
}

pub(super) fn event_projection() -> String {
    let mut out = Vec::new();
    for (key, col) in [
        ("id", "id"),
        ("orgId", "org_id"),
        ("runId", "run_id"),
        ("agentId", "agent_id"),
        ("seq", "seq"),
        ("eventType", "event_type"),
        ("stream", "stream"),
        ("level", "level"),
        ("color", "color"),
        ("message", "message"),
        ("payload", "payload"),
        ("idempotencyKey", "idempotency_key"),
    ] {
        out.push((key, format!("e.{col}")));
    }
    out.push(("createdAt", timestamp("e.created_at")));
    object(out)
}
pub(super) fn workspace_projection() -> String {
    let mut out = Vec::new();
    for (key, col) in [
        ("id", "id"),
        ("orgId", "org_id"),
        ("runWorkspaceId", "execution_workspace_id"),
        ("executionWorkspaceId", "execution_workspace_id"),
        ("heartbeatRunId", "heartbeat_run_id"),
        ("phase", "phase"),
        ("command", "command"),
        ("cwd", "cwd"),
        ("status", "status"),
        ("exitCode", "exit_code"),
        ("logStore", "log_store"),
        ("logRef", "log_ref"),
        ("logBytes", "log_bytes"),
        ("logSha256", "log_sha256"),
        ("logCompressed", "log_compressed"),
        ("stdoutExcerpt", "stdout_excerpt"),
        ("stderrExcerpt", "stderr_excerpt"),
        ("metadata", "metadata"),
    ] {
        out.push((key, format!("w.{col}")));
    }
    for (key, col) in [
        ("startedAt", "started_at"),
        ("finishedAt", "finished_at"),
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
    ] {
        out.push((key, timestamp(&format!("w.{col}"))));
    }
    object(out)
}

#[cfg(test)]
mod tests {
    use super::public_number_context;

    #[test]
    fn numeric_context_uses_js_truthiness_without_postgres_float_casts() {
        for number in [
            "0", "-0", "0.0000", "1e-400", "-1e-400", "2e-324", "-2e-324",
        ] {
            assert_eq!(public_number_context(number).unwrap(), "null", "{number}");
        }
        for number in ["1", "-1", "5e-324", "-5e-324", "1e400", "-1e400"] {
            assert_eq!(public_number_context(number).unwrap(), "{}", "{number}");
        }
        assert!(public_number_context("not-a-number").is_err());
    }
}
