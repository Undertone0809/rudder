//! Runtime-neutral wake and session lineage semantics shared by admission and
//! queued claims. These are ports of heartbeat.sessions.ts, not provider codecs.

use serde_json::{Value, json};

pub(crate) fn nonempty(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

pub(crate) fn task_key(context: &Value, payload: &Value) -> Option<String> {
    [
        context.get("taskKey"),
        context.get("taskId"),
        context.get("issueId"),
        payload.get("taskKey"),
        payload.get("taskId"),
        payload.get("issueId"),
    ]
    .into_iter()
    .find_map(nonempty)
}

pub(crate) fn suppression(context: &Value) -> Option<Value> {
    let persisted = &context["sessionReuseSuppression"];
    match persisted["kind"].as_str() {
        Some("source_session_cleared") => {
            if let Some(source_run_id) = nonempty(persisted.get("sourceRunId"))
                .or_else(|| nonempty(context.get("resumeFromRunId")))
            {
                return Some(json!({"kind":"source_session_cleared","sourceRunId":source_run_id}));
            }
        }
        Some("force_fresh") => return Some(json!({"kind":"force_fresh"})),
        _ => {}
    }
    if context["sessionResumeSuppressed"] == true
        && let Some(source_run_id) = nonempty(context.get("resumeFromRunId"))
    {
        return Some(json!({"kind":"source_session_cleared","sourceRunId":source_run_id}));
    }
    (context["forceFreshSession"] == true).then(|| json!({"kind":"force_fresh"}))
}

pub(crate) fn normalize_suppression(context: &mut Value) {
    let selected = suppression(context);
    if let Some(fields) = context.as_object_mut() {
        fields.remove("forceFreshSession");
        fields.remove("sessionResumeSuppressed");
        if let Some(selected) = selected {
            fields.insert("sessionReuseSuppression".into(), selected);
        } else {
            fields.remove("sessionReuseSuppression");
        }
    }
}

pub(crate) fn enrich_wake_context(
    mut context: Value,
    payload: &Value,
    source: &str,
    trigger_detail: Option<&str>,
    reason: Option<&str>,
) -> Value {
    if !context.is_object() {
        context = json!({});
    }
    let task_key = task_key(&context, payload);
    let issue_id = nonempty(payload.get("issueId"));
    let comment_id = nonempty(payload.get("commentId"));
    let wake_comment_id = nonempty(context.get("wakeCommentId"))
        .or_else(|| nonempty(context.get("commentId")))
        .or_else(|| comment_id.clone());
    for (key, value) in [
        ("wakeReason", reason.map(str::to_owned)),
        ("issueId", issue_id.clone()),
        ("taskId", issue_id),
        ("taskKey", task_key),
        ("commentId", comment_id),
        ("wakeCommentId", wake_comment_id),
        ("wakeSource", Some(source.to_owned())),
        ("wakeTriggerDetail", trigger_detail.map(str::to_owned)),
    ] {
        if nonempty(context.get(key)).is_none()
            && let Some(value) = value
        {
            context[key] = Value::String(value);
        }
    }
    normalize_suppression(&mut context);
    context
}

pub(crate) fn merge_coalesced_context(existing: &Value, incoming: &Value) -> Value {
    let existing_suppression = suppression(existing);
    let incoming_suppression = suppression(incoming);
    let mut merged = existing.as_object().cloned().unwrap_or_default();
    merged.extend(incoming.as_object().cloned().unwrap_or_default());
    let selected = if existing_suppression
        .as_ref()
        .is_some_and(|value| value["kind"] == "source_session_cleared")
    {
        existing_suppression
    } else if incoming_suppression
        .as_ref()
        .is_some_and(|value| value["kind"] == "source_session_cleared")
    {
        incoming_suppression
    } else {
        existing_suppression.or(incoming_suppression)
    };
    merged.remove("forceFreshSession");
    merged.remove("sessionResumeSuppressed");
    if let Some(selected) = selected {
        merged.insert("sessionReuseSuppression".into(), selected);
    } else {
        merged.remove("sessionReuseSuppression");
    }
    let comment_id =
        nonempty(incoming.get("wakeCommentId")).or_else(|| nonempty(incoming.get("commentId")));
    if let Some(comment_id) = comment_id {
        merged.insert("commentId".into(), json!(comment_id));
        merged.insert("wakeCommentId".into(), json!(comment_id));
    }
    Value::Object(merged)
}

pub(crate) fn reset_task_session(context: &Value) -> bool {
    suppression(context).is_some()
        || nonempty(context.get("wakeReason")).as_deref() == Some("issue_assigned")
}

pub(crate) struct SessionLineage {
    pub reuse_scope: &'static str,
    pub params: Option<Value>,
    pub display_id: Option<String>,
}

pub(crate) fn select_session(
    force_fresh: bool,
    explicit_params: Option<Value>,
    explicit_display_id: Option<String>,
    task_params: Option<Value>,
    task_display_id: Option<String>,
) -> SessionLineage {
    let (reuse_scope, params, display_id) = if force_fresh {
        ("none", None, None)
    } else if explicit_params.is_some() || explicit_display_id.is_some() {
        ("explicit", explicit_params, explicit_display_id)
    } else if task_params.is_some() || task_display_id.is_some() {
        ("task", task_params, task_display_id)
    } else {
        ("none", None, None)
    };
    SessionLineage {
        reuse_scope,
        params: params.or_else(|| display_id.as_ref().map(|id| json!({"sessionId":id}))),
        display_id,
    }
}

pub(crate) fn comment_mention(reason: Option<&str>, context: &Value, payload: &Value) -> bool {
    let deferred = &payload["_paperclipWakeContext"];
    if [
        reason.map(str::to_owned),
        nonempty(context.get("wakeReason")),
        nonempty(deferred.get("wakeReason")),
        nonempty(payload.get("wakeReason")),
    ]
    .into_iter()
    .flatten()
    .any(|value| {
        matches!(
            value.as_str(),
            "issue_comment_mentioned" | "issue_comment_steer"
        )
    }) {
        return true;
    }
    let source = nonempty(context.get("wakeSource"))
        .or_else(|| nonempty(deferred.get("wakeSource")))
        .or_else(|| nonempty(payload.get("wakeSource")));
    let comment = nonempty(context.get("wakeCommentId"))
        .or_else(|| nonempty(deferred.get("wakeCommentId")))
        .or_else(|| nonempty(context.get("commentId")))
        .or_else(|| nonempty(deferred.get("commentId")))
        .or_else(|| nonempty(payload.get("commentId")));
    source.as_deref() == Some("comment.mention") && comment.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_suppression_wins_over_explicit_and_task_lineage() {
        let selected = select_session(
            true,
            Some(json!({"sessionId":"explicit"})),
            Some("explicit".into()),
            Some(json!({"sessionId":"task"})),
            Some("task".into()),
        );
        assert_eq!(selected.reuse_scope, "none");
        assert!(selected.params.is_none());
        assert!(selected.display_id.is_none());
    }

    #[test]
    fn cleared_source_session_cannot_be_undone_by_coalescing() {
        let existing = json!({"sessionReuseSuppression":{"kind":"source_session_cleared","sourceRunId":"old"}});
        let merged = merge_coalesced_context(
            &existing,
            &json!({"forceFreshSession":true,"commentId":"new"}),
        );
        assert_eq!(
            merged["sessionReuseSuppression"],
            existing["sessionReuseSuppression"]
        );
        assert_eq!(merged["wakeCommentId"], "new");
        assert!(merged.get("forceFreshSession").is_none());
    }

    #[test]
    fn wake_enrichment_preserves_existing_scope_and_hydrates_payload_ids() {
        let context = enrich_wake_context(
            json!({"taskKey":"explicit"}),
            &json!({"issueId":"issue","commentId":"comment"}),
            "on_demand",
            Some("manual"),
            Some("comment"),
        );
        assert_eq!(context["taskKey"], "explicit");
        assert_eq!(context["taskId"], "issue");
        assert_eq!(context["wakeCommentId"], "comment");
    }
}
