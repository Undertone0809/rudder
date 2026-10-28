//! Timer-only admission checks from heartbeat.recovery.ts / heartbeat.wakeup.ts.
//! Issue visibility/reviewer policy and wake materialization keep their existing
//! Rust owners; this module only evaluates or selects native recovery work.
use super::{AgentExecutionError, context, http};
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use std::collections::BTreeMap;

#[derive(Debug, PartialEq)]
pub(crate) struct TimerPreflight {
    pub should_run: bool,
    pub reason: Option<String>,
    pub skip_reason: Option<String>,
    pub diagnostics: Value,
}

/// `preflightEnabled ?? timerPreflightEnabled`, then the existing boolean-only
/// config coercion. An invalid non-null primary value does not select the alias.
pub(crate) fn enabled(runtime_config: &Value) -> bool {
    let heartbeat = &runtime_config["heartbeat"];
    heartbeat
        .get("preflightEnabled")
        .filter(|value| !value.is_null())
        .or_else(|| heartbeat.get("timerPreflightEnabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn decide(assignee: bool, reviewer: bool, pending_statuses: &[String]) -> TimerPreflight {
    if assignee || reviewer {
        return TimerPreflight {
            should_run: true,
            reason: Some(
                if assignee {
                    "assignee_issue"
                } else {
                    "reviewer_issue"
                }
                .into(),
            ),
            skip_reason: None,
            diagnostics: Value::Null,
        };
    }
    let pending = !pending_statuses.is_empty();
    let mut counts = BTreeMap::<&str, usize>::new();
    for status in pending_statuses {
        *counts.entry(status).or_default() += 1;
    }
    TimerPreflight {
        should_run: false,
        reason: None,
        skip_reason: Some(
            if pending {
                "heartbeat.preflight.pending_wakeup_request"
            } else {
                "heartbeat.preflight.no_actionable_work"
            }
            .into(),
        ),
        diagnostics: if pending {
            json!({"pendingWakeupCount":pending_statuses.len(),"pendingWakeupStatuses":counts})
        } else {
            Value::Null
        },
    }
}

fn issue_read_error(error: crate::issue_core_reads::IssueCoreReadError) -> AgentExecutionError {
    match error {
        crate::issue_core_reads::IssueCoreReadError::Database(error) => error.into(),
        _ => http(500, "Timer preflight Issue read failed"),
    }
}

/// Caller applies this only to an enabled timer with no explicit Issue, after
/// pending recovery. Reuse the exact public Issue collection filter owner:
/// hidden rows cannot wake an Agent whose inbox then shows no work, and a
/// reviewer's confirmed blocked decision stays suppressed until material work.
pub(crate) async fn evaluate(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    agent_id: &str,
    runtime_config: &Value,
) -> Result<TimerPreflight, AgentExecutionError> {
    if !enabled(runtime_config) {
        return Ok(TimerPreflight {
            should_run: true,
            reason: None,
            skip_reason: None,
            diagnostics: Value::Null,
        });
    }
    // Include both owners in diagnostics: a legacy wake remains legacy-owned,
    // but it is still pending work and must prevent a duplicate generic timer.
    let pending_statuses = sqlx::query_scalar::<_, String>(
        "SELECT status FROM agent_wakeup_requests WHERE org_id=$1::uuid AND agent_id=$2::uuid AND status IN ('queued','deferred_issue_execution') AND run_id IS NULL AND requested_at<=statement_timestamp() LIMIT 100",
    ).bind(org).bind(agent_id).fetch_all(&mut **tx).await?;
    let assignee = crate::issue_core_reads::read_issue_collection(
        tx, org, &json!({"assigneeAgentId":agent_id,"includeAutomationExecutions":true,"status":"todo,in_progress,blocked"}), None,
    ).await.map_err(issue_read_error)?;
    if assignee.as_array().is_some_and(|issues| !issues.is_empty()) {
        return Ok(decide(true, false, &pending_statuses));
    }
    let reviewer = crate::issue_core_reads::read_issue_collection(
        tx, org, &json!({"reviewerAgentId":agent_id,"includeAutomationExecutions":true,"status":"in_review,blocked","excludeReviewerRecordedBlockedDecision":true}), None,
    ).await.map_err(issue_read_error)?;
    Ok(decide(
        false,
        reviewer.as_array().is_some_and(|issues| !issues.is_empty()),
        &pending_statuses,
    ))
}

#[derive(Debug, PartialEq)]
pub(crate) enum TimerRecoveryDisposition {
    /// A previous enqueue created a Run but did not restore the wake pointer.
    Relink {
        run_id: String,
    },
    Fail {
        error: String,
    },
    Skip {
        reason: String,
    },
    WaitForIssueExecution,
    Resume,
}

pub(crate) struct PendingTimerWakeup {
    pub wakeup_request_id: String,
    pub original_status: String,
    pub source: String,
    pub trigger_detail: Option<String>,
    pub reason: Option<String>,
    pub payload: Value,
    pub context_snapshot: Value,
    pub issue_id: Option<String>,
    pub idempotency_key: Option<String>,
    pub requested_by_actor_type: Option<String>,
    pub requested_by_actor_id: Option<String>,
    pub disposition: TimerRecoveryDisposition,
}

fn split_deferred(payload: &Value) -> (Value, Value) {
    let mut payload = payload.as_object().cloned().unwrap_or_default();
    let context = payload
        .remove("_paperclipWakeContext")
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    (Value::Object(payload), context)
}

fn issue_disposition(
    status: &str,
    issue_id: Option<&str>,
    issue: Option<&Value>,
    mention: bool,
) -> TimerRecoveryDisposition {
    if status == "deferred_issue_execution" && issue_id.is_none() {
        return TimerRecoveryDisposition::Fail {
            error: "Deferred issue wake could not be recovered: missing issueId".into(),
        };
    }
    if issue_id.is_none() {
        return TimerRecoveryDisposition::Resume;
    }
    let Some(issue) = issue else {
        return TimerRecoveryDisposition::Skip {
            reason: "issue_execution_issue_not_found".into(),
        };
    };
    if matches!(issue["status"].as_str(), Some("done" | "cancelled")) && !mention {
        return TimerRecoveryDisposition::Skip {
            reason: "issue_execution_issue_not_actionable".into(),
        };
    }
    if issue["liveExecution"] == true {
        TimerRecoveryDisposition::WaitForIssueExecution
    } else {
        TimerRecoveryDisposition::Resume
    }
}

/// Ordered recovery facts for the existing pending materializer, not a second
/// enqueue implementation. No Issue/Agent/wake row lock is taken here. Callers
/// revalidate the same native wake/status/run pointer in the existing recovery
/// transaction (Issue before Agent), before applying any returned disposition.
/// Legacy-owned wakes are deliberately left for the draining legacy owner.
pub(crate) async fn recovery_candidates(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    agent_id: &str,
) -> Result<Vec<PendingTimerWakeup>, AgentExecutionError> {
    let rows=sqlx::query_scalar::<_,Value>("SELECT to_jsonb(w) FROM agent_wakeup_requests w WHERE org_id=$1::uuid AND agent_id=$2::uuid AND execution_authority='native_rust' AND NOT COALESCE((reason='goal_started' AND payload->>'event'='goal_started' AND payload->>'taskKey' LIKE 'goal:%:goal_started:%' AND payload->>'_rudderExecutionProducer' IS NULL),false) AND status IN ('queued','deferred_issue_execution') AND run_id IS NULL AND requested_at<=statement_timestamp() ORDER BY requested_at ASC LIMIT 25")
        .bind(org).bind(agent_id).fetch_all(&mut **tx).await?;
    let mut candidates = Vec::with_capacity(rows.len());
    for row in rows {
        let wakeup_id = context::nonempty(row.get("id"))
            .ok_or_else(|| http(500, "Pending timer wake identity is unavailable"))?;
        let status = context::nonempty(row.get("status")).unwrap_or_default();
        let linked=sqlx::query_scalar::<_,String>("SELECT id::text FROM heartbeat_runs WHERE wakeup_request_id=$1::uuid AND org_id=$2::uuid AND agent_id=$3::uuid AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1")
            .bind(&wakeup_id).bind(org).bind(agent_id).fetch_optional(&mut **tx).await?;
        let (payload, snapshot) = split_deferred(&row["payload"]);
        // Node's recovery gives explicit payload scope precedence over its
        // deferred context; pending.rs must consume the same choice.
        let issue_id = context::nonempty(payload.get("issueId"))
            .or_else(|| context::nonempty(snapshot.get("issueId")));
        let reason = context::nonempty(row.get("reason"));
        let disposition = if let Some(run_id) = linked {
            TimerRecoveryDisposition::Relink { run_id }
        } else {
            let issue = if let Some(issue_id) = issue_id.as_deref() {
                sqlx::query_scalar::<_,Value>("SELECT jsonb_build_object('status',i.status,'liveExecution',EXISTS(SELECT 1 FROM heartbeat_runs r WHERE r.org_id=i.org_id AND r.id=i.execution_run_id AND (r.status IN ('queued','running') OR r.terminal_effects_pending=true))) FROM issues i WHERE i.org_id=$1::uuid AND i.id=$2::uuid")
                .bind(org).bind(issue_id).fetch_optional(&mut **tx).await?
            } else {
                None
            };
            issue_disposition(
                &status,
                issue_id.as_deref(),
                issue.as_ref(),
                context::comment_mention(reason.as_deref(), &snapshot, &payload),
            )
        };
        candidates.push(PendingTimerWakeup {
            wakeup_request_id: wakeup_id,
            original_status: status,
            source: context::nonempty(row.get("source")).unwrap_or_else(|| "on_demand".into()),
            trigger_detail: context::nonempty(row.get("trigger_detail")),
            reason,
            payload,
            context_snapshot: snapshot,
            issue_id,
            idempotency_key: context::nonempty(row.get("idempotency_key")),
            requested_by_actor_type: context::nonempty(row.get("requested_by_actor_type")),
            requested_by_actor_id: context::nonempty(row.get("requested_by_actor_id")),
            disposition,
        });
    }
    Ok(candidates)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preflight_alias_uses_nullish_then_boolean_rules() {
        assert!(enabled(&json!({})));
        assert!(!enabled(
            &json!({"heartbeat":{"timerPreflightEnabled":false}})
        ));
        assert!(!enabled(
            &json!({"heartbeat":{"preflightEnabled":null,"timerPreflightEnabled":false}})
        ));
        assert!(enabled(
            &json!({"heartbeat":{"preflightEnabled":"false","timerPreflightEnabled":false}})
        ));
        assert!(!enabled(
            &json!({"heartbeat":{"preflightEnabled":false,"timerPreflightEnabled":true}})
        ));
    }
    #[test]
    fn actionable_issues_precede_pending_diagnostics() {
        let pending = vec!["queued".into()];
        assert_eq!(
            decide(true, true, &pending).reason.as_deref(),
            Some("assignee_issue")
        );
        assert_eq!(
            decide(false, true, &pending).reason.as_deref(),
            Some("reviewer_issue")
        );
    }
    #[test]
    fn pending_counts_keep_statuses_and_empty_work_is_distinct() {
        let result = decide(
            false,
            false,
            &[
                "queued".into(),
                "deferred_issue_execution".into(),
                "queued".into(),
            ],
        );
        assert_eq!(
            result.skip_reason.as_deref(),
            Some("heartbeat.preflight.pending_wakeup_request")
        );
        assert_eq!(
            result.diagnostics,
            json!({"pendingWakeupCount":3,"pendingWakeupStatuses":{"queued":2,"deferred_issue_execution":1}})
        );
        assert_eq!(
            decide(false, false, &[]).skip_reason.as_deref(),
            Some("heartbeat.preflight.no_actionable_work")
        );
    }
    #[test]
    fn deferred_context_is_not_forwarded_as_tool_payload() {
        let (payload, context) = split_deferred(
            &json!({"issueId":"payload-scope","_paperclipWakeContext":{"issueId":"deferred-scope"}}),
        );
        assert_eq!(payload, json!({"issueId":"payload-scope"}));
        assert_eq!(context, json!({"issueId":"deferred-scope"}));
    }
    #[test]
    fn pending_issue_recovery_preserves_mentions_and_live_effects() {
        assert_eq!(
            issue_disposition("deferred_issue_execution", None, None, false),
            TimerRecoveryDisposition::Fail {
                error: "Deferred issue wake could not be recovered: missing issueId".into()
            }
        );
        assert_eq!(
            issue_disposition("queued", Some("id"), None, false),
            TimerRecoveryDisposition::Skip {
                reason: "issue_execution_issue_not_found".into()
            }
        );
        assert_eq!(
            issue_disposition("queued", Some("id"), Some(&json!({"status":"done"})), false),
            TimerRecoveryDisposition::Skip {
                reason: "issue_execution_issue_not_actionable".into()
            }
        );
        assert_eq!(
            issue_disposition(
                "queued",
                Some("id"),
                Some(&json!({"status":"done","liveExecution":false})),
                true
            ),
            TimerRecoveryDisposition::Resume
        );
        assert_eq!(
            issue_disposition(
                "queued",
                Some("id"),
                Some(&json!({"status":"todo","liveExecution":true})),
                false
            ),
            TimerRecoveryDisposition::WaitForIssueExecution
        );
    }
}
