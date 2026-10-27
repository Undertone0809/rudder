//! Prompt selection mirrors `server-utils.prompts.ts`. Literal snapshots are
//! captured from that source; render/reference semantics reuse Goal's helper.
use super::text;
use crate::goal_run_context::{build_goal_started_prompt_template, render_template};
use serde_json::{Value, json};
use std::sync::OnceLock;

fn template(name: &str) -> &'static str {
    static TEMPLATES: OnceLock<Value> = OnceLock::new();
    TEMPLATES.get_or_init(|| {
        serde_json::from_str(include_str!("templates.json")).expect("captured prompt templates")
    })[name]
        .as_str()
        .expect("captured prompt template exists")
}

pub(super) fn render(config: &Value, context: &Value, agent: &Value, run_id: &str) -> String {
    let reason = text(context, "wakeReason").unwrap_or_default();
    let source = text(context, "wakeSource").unwrap_or_default();
    let configured = text(config, "promptTemplate");
    let reviewer = text(context, "role") == Some("reviewer") || source == "review";
    let recovery = context["recovery"]["originalRunId"].is_string()
        || matches!(reason, "process_lost_retry" | "retry_failed_run");
    let mention = source == "comment.mention" || reason == "issue_comment_mentioned";
    let relationship_rail = if mention {
        match text(context, "relationship") {
            Some("assignee") => Some(template("ISSUE_ASSIGNEE_EXPLICIT_WORK_RAIL")),
            Some("reviewer") => Some(template("ISSUE_REVIEWER_EXPLICIT_WORK_RAIL")),
            _ => None,
        }
    } else {
        None
    };
    let delegation =
        text(context, "scene").or_else(|| text(context, "rudderScene")) == Some("delegation");
    let issue = context["issue"].is_object();
    let assignee = !reviewer
        && ((recovery && issue)
            || matches!(
                reason,
                "issue_passive_followup" | "issue_changes_requested" | "issue_assigned"
            )
            || source == "assignment"
            || (relationship_rail.is_none() && (mention || comment_reason(reason))));
    let creation = text(&context["agentIssueCreationRequest"], "id").is_some_and(|id| {
        text(context, "targetType") == Some("agent_issue_creation")
            && text(context, "targetId") == Some(id)
            && text(context, "agentIssueCreationRequestId") == Some(id)
    });
    let goal_kind = goal_kind(context);
    let goal_template = goal_kind.map(|kind| {
        if kind == "goal_started" {
            return build_goal_started_prompt_template(context);
        }
        let name = match kind {
            "goal_feedback" => "GOAL_FEEDBACK_PROMPT_TEMPLATE",
            "goal_change_decided" => "GOAL_CHANGE_DECIDED_PROMPT_TEMPLATE",
            _ => "GOAL_CONTINUATION_PROMPT_TEMPLATE",
        };
        hydrate_goal_template(template(name), context)
    });
    let selected = if creation {
        template("AGENT_ISSUE_CREATION_PROMPT_TEMPLATE").to_owned()
    } else if let Some(custom) = configured {
        let rail = if delegation {
            Some(template("DELEGATION_PROMPT_TEMPLATE").to_owned())
        } else if let Some(goal) = goal_template.as_ref() {
            Some(goal.clone())
        } else if let Some(rail) = relationship_rail {
            Some(rail.to_owned())
        } else if assignee {
            Some(template("ISSUE_ASSIGNEE_EXECUTION_RAIL").to_owned())
        } else {
            None
        };
        match rail {
            Some(rail) if !custom.contains(&rail) => format!("{custom}\n\n{rail}"),
            _ => custom.to_owned(),
        }
    } else if let Some(goal) = goal_template {
        goal
    } else if delegation {
        template("DELEGATION_PROMPT_TEMPLATE").to_owned()
    } else if recovery {
        template(if !issue {
            "RECOVERY_PROMPT_TEMPLATE"
        } else if reviewer {
            "ISSUE_REVIEW_RECOVERY_PROMPT_TEMPLATE"
        } else {
            "ISSUE_RECOVERY_PROMPT_TEMPLATE"
        })
        .to_owned()
    } else if reviewer {
        template("ISSUE_REVIEW_PROMPT_TEMPLATE").to_owned()
    } else if reason == "issue_passive_followup" {
        template("ISSUE_PASSIVE_FOLLOWUP_PROMPT_TEMPLATE").to_owned()
    } else if reason == "issue_changes_requested" {
        template("ISSUE_CHANGES_REQUESTED_PROMPT_TEMPLATE").to_owned()
    } else if source == "assignment" || reason == "issue_assigned" {
        template("ISSUE_ASSIGN_PROMPT_TEMPLATE").to_owned()
    } else if mention {
        format!(
            "{}\n{}",
            template("COMMENT_MENTION_PROMPT_TEMPLATE"),
            relationship_rail.unwrap_or_else(|| template("ISSUE_ASSIGNEE_EXECUTION_RAIL"))
        )
    } else if comment_reason(reason) {
        template("ISSUE_COMMENTED_PROMPT_TEMPLATE").to_owned()
    } else {
        template("DEFAULT_AGENT_PROMPT_TEMPLATE").to_owned()
    };
    let data = json!({"agentId":agent["id"],"orgId":agent["orgId"],"runId":run_id,
        "organization":{"id":agent["orgId"]},"agent":agent,
        "run":{"id":run_id,"source":source,"wakeReason":reason},"context":context,
        "issue":context["issue"],"comment":context["comment"],"wakeReason":reason,"wakeSource":source});
    render_template(&selected, &data)
}

pub(super) fn render_raw(template: &str, context: &Value, agent: &Value, run_id: &str) -> String {
    render_template(
        template,
        &json!({"agentId":agent["id"],"orgId":agent["orgId"],"runId":run_id,
        "organization":{"id":agent["orgId"]},"agent":agent,"run":{"id":run_id,"source":context["wakeSource"],"wakeReason":context["wakeReason"]},
        "context":context,"issue":context["issue"],"comment":context["comment"],"wakeReason":context["wakeReason"],"wakeSource":context["wakeSource"]}),
    )
}

fn comment_reason(reason: &str) -> bool {
    matches!(
        reason,
        "issue_commented" | "issue_comment_mentioned" | "issue_reopened_via_comment"
    )
}
fn goal_kind(context: &Value) -> Option<&'static str> {
    for record in [
        context,
        &context["wakeup"],
        &context["heartbeat"],
        &context["payload"],
        &context["wakePayload"],
        &context["wakeup"]["payload"],
        &context["heartbeat"]["payload"],
    ] {
        for key in [
            "wakeReason",
            "wakeSource",
            "wakeTriggerDetail",
            "triggerDetail",
            "reason",
            "event",
            "eventType",
            "type",
            "kind",
        ] {
            let value = text(record, key).unwrap_or_default().to_ascii_lowercase();
            let normalized: String = value
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
                .collect();
            for kind in [
                "goal_started",
                "goal_feedback",
                "goal_change_decided",
                "goal_continuation",
            ] {
                if normalized.contains(kind) {
                    return Some(kind);
                }
            }
        }
        for (key, kind) in [
            ("goalStarted", "goal_started"),
            ("goalFeedback", "goal_feedback"),
            ("goalChangeDecided", "goal_change_decided"),
            ("goalContinuation", "goal_continuation"),
        ] {
            if record[key] == true || record[kind] == true {
                return Some(kind);
            }
        }
    }
    None
}

fn hydrate_goal_template(template: &str, context: &Value) -> String {
    let mut template = template.to_owned();
    for (name, suffixes) in [
        ("goalTitle", &["title", "goalTitle"][..]),
        ("goalId", &["id", "goalId"][..]),
        (
            "goalOutcome",
            &[
                "outcomeStatement",
                "goalOutcome",
                "outcome",
                "currentGoal.summary",
                "currentContract.outcomeStatement",
                "contract.outcomeStatement",
            ][..],
        ),
        (
            "currentContract",
            &["currentContract", "goalContract", "contract"][..],
        ),
        ("currentPlan", &["goalPlan", "currentPlan", "plan"][..]),
        (
            "latestCheckpoint",
            &[
                "goalCheckpoint",
                "latestCheckpoint",
                "checkpoint",
                "checkpointFacts",
            ][..],
        ),
        (
            "continuation",
            &[
                "goalContinuation",
                "continuation",
                "currentContinuation",
                "nextStep",
            ][..],
        ),
        (
            "feedbackId",
            &["feedback.id", "goalFeedback.id", "feedbackId"][..],
        ),
        (
            "feedbackBody",
            &["feedback.body", "goalFeedback.body", "feedbackBody", "body"][..],
        ),
        (
            "decision",
            &["decision.decision", "goalDecision.decision"][..],
        ),
        (
            "decisionStatus",
            &["decision.status", "goalDecision.status"][..],
        ),
        ("decisionNote", &["decision.note", "goalDecision.note"][..]),
    ] {
        let mut replacement = None;
        'outer: for prefix in [
            "",
            "payload.",
            "wakePayload.",
            "wakeup.payload.",
            "heartbeat.payload.",
        ] {
            for suffix in suffixes {
                for path in [
                    format!("{prefix}goal.{suffix}"),
                    format!("{prefix}{suffix}"),
                ] {
                    let value = path
                        .split('.')
                        .try_fold(context, |value, key| value.get(key));
                    if value.is_some_and(|v| {
                        !v.is_null() && !v.as_str().is_some_and(|s| s.trim().is_empty())
                    }) {
                        replacement = Some(format!("{{{{context.{path}}}}}"));
                        break 'outer;
                    }
                }
            }
        }
        let fallback = if name == "goalTitle" {
            "Untitled Goal".to_owned()
        } else if name == "decisionNote" {
            "No decision note was provided.".to_owned()
        } else {
            format!(
                "Not provided in the wake context. If the Goal ID and `rudder_goal_context` are available, load managed Goal context once; otherwise report the missing {name} and request refreshed context."
            )
        };
        template = template.replace(
            &format!("{{{{context.goalRuntime.{name}}}}}"),
            &replacement.unwrap_or(fallback),
        );
    }
    template
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn issue_persona_keeps_assignee_checkout_rail() {
        let context = json!({"wakeReason":"issue_assigned","wakeSource":"assignment","issue":{"title":"Fix"}});
        let prompt = render(
            &json!({"promptTemplate":"Careful {{agent.name}}"}),
            &context,
            &json!({"id":"a","orgId":"o","name":"Builder"}),
            "run",
        );
        assert!(prompt.starts_with("Careful Builder\n\n"));
        assert!(prompt.contains("check out the assigned issue"));
    }
    #[test]
    fn explicit_assignee_mention_keeps_execution_lease() {
        let context = json!({"wakeReason":"issue_comment_mentioned","relationship":"assignee"});
        let prompt = render(&json!({}), &context, &json!({}), "run");
        assert!(prompt.contains("do not check out the issue"));
        assert!(!prompt.contains("check out the assigned issue"));
    }
}
