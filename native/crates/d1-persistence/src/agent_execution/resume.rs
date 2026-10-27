//! Resume selection from the target Agent's own durable Run and task session.
//! Provider-specific session codecs remain the executor's normalization boundary.

use super::{AgentExecutionError, context};
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

pub(crate) async fn hydrate_explicit_resume(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    agent_id: &str,
    runtime_type: &str,
    payload: &Value,
    snapshot: &mut Value,
) -> Result<(), AgentExecutionError> {
    let Some(source_id) = context::nonempty(payload.get("resumeFromRunId")) else {
        return Ok(());
    };
    // Existing Node semantics ignore a missing or foreign source, preserving
    // the target Agent's own default selection rather than borrowing context.
    let Ok(source_id) = Uuid::parse_str(&source_id) else {
        return Ok(());
    };
    let source=sqlx::query("SELECT id::text AS id,context_snapshot,session_id_before,session_id_after,session_params_before_json,session_params_after_json FROM heartbeat_runs WHERE org_id=$1::uuid AND agent_id=$2::uuid AND id=$3::uuid")
        .bind(org).bind(agent_id).bind(source_id.to_string()).fetch_optional(&mut **tx).await?;
    let Some(source) = source else {
        return Ok(());
    };
    let source_id: String = source.try_get("id")?;
    let source_context = source
        .try_get::<Option<Value>, _>("context_snapshot")?
        .unwrap_or_else(|| json!({}));
    let before: Option<Value> = source.try_get("session_params_before_json")?;
    let after: Option<Value> = source.try_get("session_params_after_json")?;
    let before_id: Option<String> = source.try_get("session_id_before")?;
    let after_id: Option<String> = source.try_get("session_id_after")?;
    let cleared = after_id.is_none()
        && after
            .as_ref()
            .and_then(Value::as_object)
            .is_some_and(|fields| fields.is_empty());
    let has_after = after_id
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty())
        || object_params(after.as_ref()).is_some();
    let suppression = if cleared {
        Some(json!({"kind":"source_session_cleared","sourceRunId":source_id}))
    } else if !has_after {
        context::suppression(&source_context)
    } else {
        None
    };
    let key = context::task_key(&source_context, &Value::Null)
        .or_else(|| context::task_key(snapshot, payload));
    if let Some(suppression) = suppression {
        snapshot
            .as_object_mut()
            .expect("admission validated context")
            .remove("resumeSessionDisplayId");
        snapshot
            .as_object_mut()
            .expect("admission validated context")
            .remove("resumeSessionParams");
        snapshot["sessionReuseSuppression"] = suppression;
    } else {
        let after_params = object_params(after.as_ref());
        let before_params = object_params(before.as_ref());
        let context_params = object_params(source_context.get("resumeSessionParams"));
        let preferred_id = if after_params.is_some() {
            after_id.clone()
        } else if before_params.is_some() {
            before_id.clone()
        } else if context_params.is_some() {
            context::nonempty(source_context.get("resumeSessionDisplayId"))
        } else {
            after_id
                .or(before_id)
                .or_else(|| context::nonempty(source_context.get("resumeSessionDisplayId")))
        };
        let source_params = after_params.or(before_params).or(context_params);
        let desired_id = preferred_id
            .or_else(|| {
                source_params
                    .as_ref()
                    .and_then(|value| context::nonempty(value.get("sessionId")))
            })
            .map(truncate_display);
        let task = if let Some(key) = key.as_deref() {
            sqlx::query("SELECT session_params_json,session_display_id,last_run_id::text AS last_run_id FROM agent_task_sessions WHERE org_id=$1::uuid AND agent_id=$2::uuid AND agent_runtime_type=$3 AND task_key=$4")
            .bind(org).bind(agent_id).bind(runtime_type).bind(key).fetch_optional(&mut **tx).await?
        } else {
            None
        };
        let task_params = task
            .as_ref()
            .and_then(|row| {
                row.try_get::<Option<Value>, _>("session_params_json")
                    .ok()
                    .flatten()
            })
            .filter(|value| value.as_object().is_some_and(|fields| !fields.is_empty()));
        let task_id = task
            .as_ref()
            .and_then(|row| {
                row.try_get::<Option<String>, _>("session_display_id")
                    .ok()
                    .flatten()
            })
            .or_else(|| {
                task_params
                    .as_ref()
                    .and_then(|value| context::nonempty(value.get("sessionId")))
            })
            .map(truncate_display);
        let can_reuse = task.as_ref().is_some_and(|row| {
            row.try_get::<Option<String>, _>("last_run_id")
                .ok()
                .flatten()
                .as_deref()
                == Some(source_id.as_str())
                || (desired_id.is_some() && task_id == desired_id)
        });
        let params = source_params
            .or_else(|| if can_reuse { task_params } else { None })
            .or_else(|| desired_id.as_ref().map(|id| json!({"sessionId":id})));
        let display = desired_id.or_else(|| if can_reuse { task_id } else { None });
        if params.is_none() && display.is_none() {
            return Ok(());
        }
        if let Some(params) = params {
            snapshot["resumeSessionParams"] = params;
        }
        if let Some(display) = display {
            snapshot["resumeSessionDisplayId"] = json!(display);
        }
    }
    snapshot["resumeFromRunId"] = json!(source_id);
    for (field, value) in [
        ("issueId", context::nonempty(source_context.get("issueId"))),
        (
            "taskId",
            context::nonempty(source_context.get("taskId"))
                .or_else(|| context::nonempty(source_context.get("issueId"))),
        ),
        ("taskKey", key),
    ] {
        if context::nonempty(snapshot.get(field)).is_none() {
            if let Some(value) = value {
                snapshot[field] = json!(value);
            }
        }
    }
    Ok(())
}

pub(crate) fn object_params(value: Option<&Value>) -> Option<Value> {
    value
        .filter(|value| value.as_object().is_some_and(|fields| !fields.is_empty()))
        .cloned()
}

pub(crate) fn truncate_display(value: String) -> String {
    value.chars().take(240).collect()
}
