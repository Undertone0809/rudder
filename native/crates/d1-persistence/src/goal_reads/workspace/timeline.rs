//! Merged Goal history and Agent Run timeline projection.
use super::super::{
    GoalReadError, GoalReadRequest, GoalReadView, decode_cursor, history, history_limit,
    parse_legacy_read_json, text,
};
use super::{OpaqueJson, set_raw};
use crate::StoreError;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TimelineCursor {
    version: u8,
    created_at: String,
    kind: String,
    id: String,
}

pub(super) async fn timeline(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    goal: &Value,
    input: &GoalReadRequest,
    opaque: &mut Vec<OpaqueJson>,
    verified_run_owner: Option<&str>,
) -> Result<Value, GoalReadError> {
    let goal_id = text(goal, "id");
    let cursor = decode_cursor(input.cursor.as_deref())?;
    let limit = match history_limit(input.limit.as_deref()) {
        Ok(limit) => limit,
        Err(_) => return Err(GoalReadError::TimelineLimit),
    };
    let history_request = GoalReadRequest {
        view: GoalReadView::History,
        goal_id: Some(goal_id.clone()),
        cursor: input.cursor.clone(),
        limit: input.limit.clone(),
        agent_id: None,
        lifecycle: None,
        focus: None,
        facet: None,
    };
    let history_page = history(tx, org, &goal_id, &history_request)
        .await
        .map_err(|error| {
            if matches!(error, GoalReadError::Limit) {
                GoalReadError::TimelineLimit
            } else {
                error
            }
        })?;
    let mut run_items = Vec::new();
    let run_sql = run_timeline_sql();
    for raw in sqlx::query(&run_sql)
        .bind(org)
        .bind(&goal_id)
        .bind(verified_run_owner)
        .bind(cursor.as_ref().map(|cursor| cursor.created_at.as_str()))
        .bind(cursor.as_ref().map(|cursor| cursor.kind.as_str()))
        .bind(cursor.as_ref().map(|cursor| cursor.id.as_str()))
        .bind(limit + 1)
        .fetch_all(&mut **tx)
        .await?
    {
        let mut run = parse_legacy_read_json(&raw.try_get::<String, _>("value")?)
            .map_err(|_| StoreError::InvalidReceipt)?;
        let hints = parse_legacy_read_json(&raw.try_get::<String, _>("hints")?)
            .map_err(|_| StoreError::InvalidReceipt)?;
        add_run_origin(&mut run, &hints);
        for (key, column) in [
            ("usageJson", "usage_json"),
            ("resultJson", "result_json"),
            ("recoveryCheckpoint", "recovery_checkpoint"),
            ("contextSnapshot", "context_snapshot"),
        ] {
            let raw_value: Option<String> = raw.try_get(column)?;
            set_raw(&mut run, key, raw_value.as_deref(), String::new(), opaque)?;
        }
        run_items.push(json!({"source":"agent-run","item":run}));
    }
    let mut items = history_page["items"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|item| json!({"source":"goal-history","item":item}))
        .collect::<Vec<_>>();
    items.extend(run_items);
    items.sort_by(|left, right| {
        let left_item = &left["item"];
        let right_item = &right["item"];
        let left_kind = if left["source"] == "agent-run" {
            "agent_run"
        } else {
            left_item["kind"].as_str().unwrap_or_default()
        };
        let right_kind = if right["source"] == "agent-run" {
            "agent_run"
        } else {
            right_item["kind"].as_str().unwrap_or_default()
        };
        right_item["createdAt"]
            .as_str()
            .unwrap_or_default()
            .cmp(left_item["createdAt"].as_str().unwrap_or_default())
            .then_with(|| left_kind.cmp(right_kind))
            .then_with(|| {
                left_item["id"]
                    .as_str()
                    .unwrap_or_default()
                    .cmp(right_item["id"].as_str().unwrap_or_default())
            })
    });
    let live_visibility = crate::run_visibility::predicate("r", 3);
    let has_live_runs: bool = sqlx::query_scalar(&format!(
        "SELECT EXISTS(SELECT 1 FROM heartbeat_runs r WHERE r.org_id=$1::uuid AND r.goal_id=$2::uuid AND r.status IN ('queued','running') AND ({live_visibility}))"
    ))
    .bind(org)
    .bind(&goal_id)
    .bind(verified_run_owner)
    .fetch_one(&mut **tx)
    .await?;
    let more = history_page["nextCursor"].is_string() || items.len() > limit as usize;
    items.truncate(limit as usize);
    for (index, item) in items.iter().enumerate() {
        if item["source"] != "agent-run" {
            continue;
        }
        for key in [
            "usageJson",
            "resultJson",
            "recoveryCheckpoint",
            "contextSnapshot",
        ] {
            if let Some(marker) = item["item"][key].as_str()
                && let Some(entry) = opaque.iter_mut().find(|entry| entry.marker == marker)
            {
                let path = format!("/items/{index}/item/{key}");
                if !entry.paths.contains(&path) {
                    entry.paths.push(path);
                }
            }
        }
    }
    let next_cursor = if more {
        items.last().and_then(|item| {
            let history_item = &item["item"];
            let kind = if item["source"] == "agent-run" {
                "agent_run"
            } else {
                history_item["kind"].as_str()?
            };
            Some(
                URL_SAFE_NO_PAD.encode(
                    serde_json::to_vec(&TimelineCursor {
                        version: 1,
                        created_at: history_item["createdAt"].as_str()?.to_owned(),
                        kind: kind.to_owned(),
                        id: history_item["id"].as_str()?.to_owned(),
                    })
                    .expect("timeline cursor serialization"),
                ),
            )
        })
    } else {
        None
    };
    Ok(json!({"items":items,"nextCursor":next_cursor,"hasLiveRuns":has_live_runs}))
}

fn run_timeline_sql() -> String {
    let dates = [
        ("startedAt", "started_at"),
        ("finishedAt", "finished_at"),
        ("processStartedAt", "process_started_at"),
        ("networkWaitStartedAt", "network_wait_started_at"),
        ("networkWaitNextRetryAt", "network_wait_next_retry_at"),
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
    ];
    let mut entries = vec![
        "'id',t.id::text".to_owned(),
        "'shortRef','run_'||substring(replace(t.id::text,'-','') from 1 for 8)".to_owned(),
        "'orgId',t.org_id::text".to_owned(),
        "'agentId',t.agent_id::text".to_owned(),
        "'invocationSource',t.invocation_source".to_owned(),
        "'triggerDetail',t.trigger_detail".to_owned(),
        "'status',t.status".to_owned(),
        "'executionPhase',t.running_substate".to_owned(),
        "'error',t.error".to_owned(),
        "'wakeupRequestId',t.wakeup_request_id::text".to_owned(),
        "'sourceRunId',t.source_run_id::text".to_owned(),
        "'exitCode',t.exit_code".to_owned(),
        "'signal',t.signal".to_owned(),
        "'sessionIdBefore',t.session_id_before".to_owned(),
        "'sessionIdAfter',t.session_id_after".to_owned(),
        "'sessionReuseScope',t.session_reuse_scope".to_owned(),
        "'logStore',t.log_store".to_owned(),
        "'logRef',t.log_ref".to_owned(),
        "'logBytes',t.log_bytes".to_owned(),
        "'logSha256',t.log_sha256".to_owned(),
        "'logCompressed',t.log_compressed".to_owned(),
        "'stdoutExcerpt',t.stdout_excerpt".to_owned(),
        "'stderrExcerpt',t.stderr_excerpt".to_owned(),
        "'errorCode',t.error_code".to_owned(),
        "'externalRunId',t.external_run_id".to_owned(),
        "'chatConversationId',t.chat_conversation_id::text".to_owned(),
        "'goalId',t.goal_id::text".to_owned(),
        "'processPid',t.process_pid".to_owned(),
        "'networkWaitAttemptCount',t.network_wait_attempt_count".to_owned(),
        "'networkWaitDurationMs',t.network_wait_duration_ms".to_owned(),
        "'retryOfRunId',t.retry_of_run_id::text".to_owned(),
        "'processLossRetryCount',t.process_loss_retry_count".to_owned(),
    ];
    for (output, input) in dates {
        entries.push(format!("'{output}',CASE WHEN t.{input} IS NULL THEN NULL ELSE to_char(t.{input} AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') END"));
    }
    let common_private = "ARRAY['resumeSessionParams','resumeSessionDisplayId','forceFreshSession','sessionResumeSuppressed']::text[]";
    let delegated_private = "ARRAY['resumeSessionParams','resumeSessionDisplayId','forceFreshSession','sessionResumeSuppressed','delegationTask','sourceAgentId','targetAgentId','taskKey']::text[]";
    let context = format!(
        "CASE WHEN t.context_snapshot IS NULL THEN NULL WHEN jsonb_typeof(t.context_snapshot)='object' AND (t.context_snapshot->>'scene'='delegation' OR t.context_snapshot->>'rudderScene'='delegation') THEN (t.context_snapshot - {delegated_private})::text WHEN jsonb_typeof(t.context_snapshot)='object' THEN (t.context_snapshot - {common_private})::text ELSE t.context_snapshot::text END"
    );
    let json_string = |key: &str| {
        format!(
            "CASE WHEN jsonb_typeof(t.context_snapshot->'{key}')='string' THEN t.context_snapshot->>'{key}' ELSE NULL END"
        )
    };
    let hints = format!(
        "jsonb_build_object('scene',{},'rudderScene',{},'conversationId',{},'messageId',{},'assistantMessageId',{},'userMessageId',{},'triggerKind',{},'commentId',{},'wakeSource',{},'wakeReason',{},'targetType',{},'targetId',{},'issueId',{},'automationRunId',{},'automationId',{},'wakeupRequestId',{},'sourceRunId',{})",
        json_string("scene"),
        json_string("rudderScene"),
        json_string("conversationId"),
        json_string("messageId"),
        json_string("assistantMessageId"),
        json_string("userMessageId"),
        json_string("triggerKind"),
        json_string("commentId"),
        json_string("wakeSource"),
        json_string("wakeReason"),
        json_string("targetType"),
        json_string("targetId"),
        json_string("issueId"),
        json_string("automationRunId"),
        json_string("automationId"),
        json_string("wakeupRequestId"),
        json_string("sourceRunId")
    );
    let visibility = crate::run_visibility::predicate("t", 3);
    let cursor_condition = "($4::timestamptz IS NULL OR t.created_at < $4::timestamptz OR (t.created_at=$4::timestamptz AND ($5::text < 'agent_run' OR ($5='agent_run' AND t.id::text > $6::text))))";
    format!(
        "SELECT jsonb_build_object({},'usageJson',NULL,'resultJson',NULL,'recoveryCheckpoint',NULL,'contextSnapshot',NULL)::text AS value,{hints}::text AS hints,t.usage_json::text AS usage_json,t.result_json::text AS result_json,t.recovery_checkpoint::text AS recovery_checkpoint,{context} AS context_snapshot FROM heartbeat_runs t WHERE t.org_id=$1::uuid AND t.goal_id=$2::uuid AND ({visibility}) AND {cursor_condition} ORDER BY t.created_at DESC,t.id ASC LIMIT $7",
        entries.join(",")
    )
}

fn add_run_origin(run: &mut Value, hints: &Value) {
    let string = |key: &str| {
        hints[key]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned)
    };
    let is_scene = |value: Option<&str>| {
        matches!(
            value,
            Some("issue" | "chat" | "automation" | "review" | "heartbeat" | "delegation")
        )
    };
    let is_target = |value: Option<&str>| {
        matches!(
            value,
            Some(
                "issue"
                    | "chat_conversation"
                    | "chat_message"
                    | "automation_run"
                    | "wakeup_request"
                    | "manual"
            )
        )
    };
    let invocation = run["invocationSource"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let trigger_detail = run["triggerDetail"].as_str().map(str::to_owned);
    let persisted_conversation = run["chatConversationId"].as_str().map(str::to_owned);
    let conversation = persisted_conversation.or_else(|| string("conversationId"));
    let scene = if is_scene(string("scene").as_deref()) {
        string("scene")
    } else if is_scene(string("rudderScene").as_deref()) {
        string("rudderScene")
    } else if invocation == "chat" || conversation.is_some() {
        Some("chat".to_owned())
    } else if invocation == "review" {
        Some("review".to_owned())
    } else if invocation == "delegation" {
        Some("delegation".to_owned())
    } else if invocation == "timer" {
        Some("heartbeat".to_owned())
    } else if string("automationRunId").is_some() {
        Some("automation".to_owned())
    } else if string("issueId").is_some() {
        Some("issue".to_owned())
    } else if invocation == "automation" {
        Some("automation".to_owned())
    } else {
        Some("heartbeat".to_owned())
    };
    let target_type = if is_target(string("targetType").as_deref()) {
        string("targetType")
    } else if conversation.is_some() {
        Some("chat_conversation".to_owned())
    } else if string("automationRunId").is_some() {
        Some("automation_run".to_owned())
    } else if string("issueId").is_some() {
        Some("issue".to_owned())
    } else {
        Some("wakeup_request".to_owned())
    };
    let target_type_ref = target_type.as_deref();
    let target_id = string("targetId")
        .or_else(|| {
            if target_type_ref == Some("chat_conversation") {
                conversation.clone()
            } else {
                None
            }
        })
        .or_else(|| {
            if target_type_ref == Some("chat_message") {
                string("messageId")
                    .or_else(|| string("assistantMessageId"))
                    .or_else(|| string("userMessageId"))
            } else {
                None
            }
        })
        .or_else(|| {
            if target_type_ref == Some("automation_run") {
                string("automationRunId")
            } else {
                None
            }
        })
        .or_else(|| {
            if target_type_ref == Some("issue") {
                string("issueId")
            } else {
                None
            }
        })
        .or_else(|| {
            if target_type_ref == Some("wakeup_request") {
                run["wakeupRequestId"]
                    .as_str()
                    .map(str::to_owned)
                    .or_else(|| string("wakeupRequestId"))
            } else {
                None
            }
        });
    let trigger_kind = if let Some(value) = string("triggerKind") {
        value
    } else if string("commentId").is_some()
        || string("wakeSource").as_deref() == Some("issue.comment")
        || matches!(
            string("wakeReason").as_deref(),
            Some("issue_commented" | "issue_comment_mentioned")
        )
    {
        "issue_comment".to_owned()
    } else if invocation == "review" {
        "review_routing".to_owned()
    } else if invocation == "timer" {
        "timer".to_owned()
    } else if invocation == "on_demand" && trigger_detail.as_deref() == Some("manual") {
        "manual".to_owned()
    } else {
        trigger_detail.unwrap_or(invocation)
    };
    let message_id = string("messageId")
        .or_else(|| string("assistantMessageId"))
        .or_else(|| string("userMessageId"));
    let issue_id = string("issueId").or_else(|| {
        if target_type_ref == Some("issue") {
            target_id.clone()
        } else {
            None
        }
    });
    let automation_run_id = string("automationRunId");
    let automation_id = string("automationId");
    let wakeup = run["wakeupRequestId"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| string("wakeupRequestId"));
    let source_run = run["sourceRunId"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| string("sourceRunId"));
    run["scene"] = json!(scene);
    run["triggerKind"] = json!(trigger_kind);
    run["targetType"] = json!(target_type);
    run["targetId"] = json!(target_id);
    run["conversationId"] = json!(conversation);
    run["messageId"] = json!(message_id);
    run["issueId"] = json!(issue_id);
    run["automationRunId"] = json!(automation_run_id);
    run["automationId"] = json!(automation_id);
    run["wakeupRequestId"] = json!(wakeup);
    run["sourceRunId"] = json!(source_run);
}
