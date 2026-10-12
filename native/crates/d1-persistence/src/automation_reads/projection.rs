//! Fixed legacy projections used only by Automation GETs.
use crate::{
    StoreError,
    activity_reads::{JsString, details, encode_object, legacy_date_text, legacy_stamp, object},
};
use std::collections::BTreeMap;
pub(super) type Object = BTreeMap<JsString, String>;

pub(super) fn projection(table: &str, alias: &str) -> String {
    let fields: &[(&str, &str, bool)] = match table {
        "automations" => &[
            ("id", "id", false),
            ("orgId", "org_id", false),
            ("projectId", "project_id", false),
            ("goalId", "goal_id", false),
            ("parentIssueId", "parent_issue_id", false),
            ("title", "title", false),
            ("description", "description", false),
            ("assigneeAgentId", "assignee_agent_id", false),
            (
                "assigneeAgentRuntimeOverrides",
                "assignee_agent_runtime_overrides",
                false,
            ),
            ("outputMode", "output_mode", false),
            ("chatConversationId", "chat_conversation_id", false),
            ("notifyOnIssueCreated", "notify_on_issue_created", false),
            (
                "notifyOnIssueCreatedUserId",
                "notify_on_issue_created_user_id",
                false,
            ),
            ("priority", "priority", false),
            ("status", "status", false),
            ("concurrencyPolicy", "concurrency_policy", false),
            ("catchUpPolicy", "catch_up_policy", false),
            ("createdByAgentId", "created_by_agent_id", false),
            ("createdByUserId", "created_by_user_id", false),
            ("updatedByAgentId", "updated_by_agent_id", false),
            ("updatedByUserId", "updated_by_user_id", false),
            ("lastTriggeredAt", "last_triggered_at", true),
            ("lastEnqueuedAt", "last_enqueued_at", true),
            ("createdAt", "created_at", true),
            ("updatedAt", "updated_at", true),
        ],
        "automationTriggers" => &[
            ("id", "id", false),
            ("orgId", "org_id", false),
            ("automationId", "automation_id", false),
            ("kind", "kind", false),
            ("label", "label", false),
            ("enabled", "enabled", false),
            ("cronExpression", "cron_expression", false),
            ("timezone", "timezone", false),
            ("nextRunAt", "next_run_at", true),
            ("lastFiredAt", "last_fired_at", true),
            ("publicId", "public_id", false),
            ("secretId", "secret_id", false),
            ("signingMode", "signing_mode", false),
            ("replayWindowSec", "replay_window_sec", false),
            ("lastRotatedAt", "last_rotated_at", true),
            ("lastResult", "last_result", false),
            ("createdByAgentId", "created_by_agent_id", false),
            ("createdByUserId", "created_by_user_id", false),
            ("updatedByAgentId", "updated_by_agent_id", false),
            ("updatedByUserId", "updated_by_user_id", false),
            ("createdAt", "created_at", true),
            ("updatedAt", "updated_at", true),
        ],
        "automationRuns" => &[
            ("id", "id", false),
            ("orgId", "org_id", false),
            ("automationId", "automation_id", false),
            ("triggerId", "trigger_id", false),
            ("source", "source", false),
            ("status", "status", false),
            ("triggeredAt", "triggered_at", true),
            ("idempotencyKey", "idempotency_key", false),
            ("triggerPayload", "trigger_payload", false),
            ("linkedIssueId", "linked_issue_id", false),
            (
                "linkedChatConversationId",
                "linked_chat_conversation_id",
                false,
            ),
            ("startedChatMessageId", "started_chat_message_id", false),
            ("terminalChatMessageId", "terminal_chat_message_id", false),
            ("lastChatMessageId", "last_chat_message_id", false),
            ("coalescedIntoRunId", "coalesced_into_run_id", false),
            ("failureReason", "failure_reason", false),
            ("completedAt", "completed_at", true),
            ("createdAt", "created_at", true),
            ("updatedAt", "updated_at", true),
        ],
        "projects" => &[
            ("id", "id", false),
            ("orgId", "org_id", false),
            ("goalId", "goal_id", false),
            ("name", "name", false),
            ("description", "description", false),
            ("status", "status", false),
            ("leadAgentId", "lead_agent_id", false),
            ("targetDate", "target_date", false),
            ("color", "color", false),
            ("icon", "icon", false),
            ("pauseReason", "pause_reason", false),
            ("pausedAt", "paused_at", true),
            (
                "executionWorkspacePolicy",
                "execution_workspace_policy",
                false,
            ),
            ("archivedAt", "archived_at", true),
            ("createdAt", "created_at", true),
            ("updatedAt", "updated_at", true),
        ],
        "agents" => &[
            ("id", "id", false),
            ("orgId", "org_id", false),
            ("name", "name", false),
            ("workspaceKey", "workspace_key", false),
            ("role", "role", false),
            ("title", "title", false),
            ("icon", "icon", false),
            ("status", "status", false),
            ("readinessState", "readiness_state", false),
            ("readinessCheckedAt", "readiness_checked_at", true),
            ("readinessResultCode", "readiness_result_code", false),
            ("capabilities", "capabilities", false),
            ("agentRuntimeType", "agent_runtime_type", false),
            ("agentRuntimeConfig", "agent_runtime_config", false),
            ("runtimeConfig", "runtime_config", false),
            ("budgetMonthlyCents", "budget_monthly_cents", false),
            ("spentMonthlyCents", "spent_monthly_cents", false),
            ("pauseReason", "pause_reason", false),
            ("pausedAt", "paused_at", true),
            ("permissions", "permissions", false),
            ("lastHeartbeatAt", "last_heartbeat_at", true),
            ("metadata", "metadata", false),
            ("createdAt", "created_at", true),
            ("updatedAt", "updated_at", true),
        ],
        "issues" => &[
            ("id", "id", false),
            ("orgId", "org_id", false),
            ("projectId", "project_id", false),
            ("projectWorkspaceId", "project_workspace_id", false),
            ("goalId", "goal_id", false),
            ("parentId", "parent_id", false),
            ("title", "title", false),
            ("description", "description", false),
            ("status", "status", false),
            ("priority", "priority", false),
            ("boardOrder", "board_order", false),
            ("assigneeAgentId", "assignee_agent_id", false),
            ("assigneeUserId", "assignee_user_id", false),
            ("reviewerAgentId", "reviewer_agent_id", false),
            ("reviewerUserId", "reviewer_user_id", false),
            ("checkoutRunId", "checkout_run_id", false),
            ("executionRunId", "execution_run_id", false),
            ("executionAgentNameKey", "execution_agent_name_key", false),
            ("executionLockedAt", "execution_locked_at", true),
            ("createdByAgentId", "created_by_agent_id", false),
            ("createdByUserId", "created_by_user_id", false),
            ("issueNumber", "issue_number", false),
            ("identifier", "identifier", false),
            ("originKind", "origin_kind", false),
            ("originId", "origin_id", false),
            ("originRunId", "origin_run_id", false),
            ("requestDepth", "request_depth", false),
            ("billingCode", "billing_code", false),
            (
                "assigneeAgentRuntimeOverrides",
                "assignee_agent_runtime_overrides",
                false,
            ),
            ("executionWorkspaceId", "execution_workspace_id", false),
            (
                "executionWorkspacePreference",
                "execution_workspace_preference",
                false,
            ),
            (
                "executionWorkspaceSettings",
                "execution_workspace_settings",
                false,
            ),
            ("startedAt", "started_at", true),
            ("completedAt", "completed_at", true),
            ("cancelledAt", "cancelled_at", true),
            ("executionCancellationAt", "execution_cancellation_at", true),
            ("hiddenAt", "hidden_at", true),
            ("createdAt", "created_at", true),
            ("updatedAt", "updated_at", true),
        ],
        "labels" => &[
            ("id", "id", false),
            ("orgId", "org_id", false),
            ("name", "name", false),
            ("color", "color", false),
            ("createdAt", "created_at", true),
            ("updatedAt", "updated_at", true),
        ],
        _ => unreachable!("fixed Automation projection"),
    };
    let values = fields
        .iter()
        .map(|(key, column, date)| {
            let column = format!("{alias}.{column}");
            let value = if *date {
                legacy_date_text(&legacy_stamp(&column))
            } else {
                column
            };
            format!("'{key}',{value}")
        })
        .collect::<Vec<_>>();
    values
        .chunks(40)
        .map(|chunk| format!("jsonb_build_object({})", chunk.join(",")))
        .collect::<Vec<_>>()
        .join(" || ")
}

pub(super) fn record(table: &str, raw: &str) -> Result<Object, StoreError> {
    let fields: &[&str] = match table {
        "automations" => &["assigneeAgentRuntimeOverrides"],
        "automationRuns" => &["triggerPayload"],
        "projects" => &["executionWorkspacePolicy"],
        "agents" => &[
            "agentRuntimeConfig",
            "runtimeConfig",
            "permissions",
            "metadata",
        ],
        "issues" => &[
            "assigneeAgentRuntimeOverrides",
            "executionWorkspaceSettings",
        ],
        _ => &[],
    };
    let mut row = object(raw)?;
    for field in fields {
        if let Some(raw) = row.get_mut(&JsString::from(*field)) {
            *raw = details(Some(raw))?;
        }
    }
    Ok(row)
}
pub(super) fn text(row: &Object, key: &str) -> Result<Option<String>, StoreError> {
    match row.get(&JsString::from(key)).map(String::as_str) {
        None | Some("null") => Ok(None),
        Some(raw) => serde_json::from_str(raw)
            .map(Some)
            .map_err(|_| StoreError::InvalidReceipt),
    }
}
pub(super) fn array(rows: Vec<String>) -> String {
    format!("[{}]", rows.join(","))
}
pub(super) fn encode(row: Object) -> String {
    encode_object(row)
}
