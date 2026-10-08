//! Derived linked-work facts for Goal facets and attention.
use super::super::{GoalReadError, parse_legacy_read_json, public_goal_text, text};
use super::{ExternalFact, GoalRow, TERMINAL_RUN_STATUSES};
use regex_lite::Regex;
use sqlx::{Postgres, Row, Transaction};

pub(super) async fn latest_external_fact(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    goal: &GoalRow,
    preferred_run_id: Option<&str>,
    verified_run_owner: Option<&str>,
) -> Result<Option<ExternalFact>, GoalReadError> {
    let id = text(&goal.public, "id");
    let mut related = Vec::new();
    for row in sqlx::query(
        "SELECT id::text AS id,identifier,title,status,COALESCE(execution_run_id,checkout_run_id)::text AS run_id,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS occurred_at FROM issues WHERE org_id=$1::uuid AND goal_id=$2::uuid",
    )
    .bind(org)
    .bind(&id)
    .fetch_all(&mut **tx)
    .await?
    {
        let issue_id: String = row.try_get("id")?;
        let identifier: Option<String> = row.try_get("identifier")?;
        let title: String = row.try_get("title")?;
        let status: String = row.try_get("status")?;
        related.push(ExternalFact {
            id: format!("work-status:issue:{issue_id}"),
            summary: format!("Issue {} is {}.", identifier.unwrap_or(title), status),
            occurred_at: row.try_get("occurred_at")?,
            source_id: issue_id,
            source_run_id: row.try_get("run_id")?,
            run_status: None,
        });
    }
    for row in sqlx::query(
        "SELECT p.id::text AS id,p.name,p.status,to_char(p.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS occurred_at FROM projects p LEFT JOIN project_goals pg ON pg.project_id=p.id AND pg.org_id=p.org_id WHERE p.org_id=$1::uuid AND (p.goal_id=$2::uuid OR pg.goal_id=$2::uuid)",
    )
    .bind(org)
    .bind(&id)
    .fetch_all(&mut **tx)
    .await?
    {
        let project_id: String = row.try_get("id")?;
        let name: String = row.try_get("name")?;
        let status: String = row.try_get("status")?;
        related.push(ExternalFact {
            id: format!("work-status:project:{project_id}"),
            summary: format!("Project {name} is {status}."),
            occurred_at: row.try_get("occurred_at")?,
            source_id: project_id,
            source_run_id: None,
            run_status: None,
        });
    }
    let runs = if let Some(owner) = goal.public["ownerAgentId"].as_str() {
        let mut runs = Vec::new();
        let summary_sql = run_summary_candidate_sql("r.result_summary_json")
            .replace("@status", "r.status")
            .replace("@result", "r.result_json")
            .replace("@error", "r.error");
        let visibility = crate::run_visibility::predicate("r", 4);
        let sql = format!(
            "SELECT r.id::text AS id,r.status,r.error,({summary_sql}) AS summary,to_char(r.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS occurred_at FROM heartbeat_runs r WHERE r.org_id=$1::uuid AND r.agent_id=$2::uuid AND r.goal_id=$3::uuid AND ({visibility})"
        );
        for row in sqlx::query(&sql)
            .bind(org)
            .bind(owner)
            .bind(&id)
            .bind(verified_run_owner)
            .fetch_all(&mut **tx)
            .await?
        {
            let run_id: String = row.try_get("id")?;
            let status: String = row.try_get("status")?;
            let summary: Option<String> = row.try_get("summary")?;
            let error: Option<String> = row.try_get("error")?;
            runs.push(ExternalFact {
                id: format!("work-status:run:{run_id}"),
                summary: public_run_summary(&status, summary.as_deref(), error.as_deref()),
                occurred_at: row.try_get("occurred_at")?,
                source_id: run_id.clone(),
                source_run_id: Some(run_id),
                run_status: Some(status),
            });
        }
        runs
    } else {
        Vec::new()
    };

    let active = runs
        .iter()
        .filter(|fact| {
            fact.run_status
                .as_deref()
                .is_some_and(|status| !TERMINAL_RUN_STATUSES.contains(&status))
        })
        .max_by(|left, right| fact_order(left, right));
    if let Some(active) = active {
        return Ok(Some(active.clone()));
    }
    let mut terminal = runs
        .iter()
        .filter(|fact| {
            fact.run_status
                .as_deref()
                .is_some_and(|status| TERMINAL_RUN_STATUSES.contains(&status))
        })
        .collect::<Vec<_>>();
    terminal.sort_by(|left, right| fact_order(right, left));
    if let Some(latest) = terminal.first().copied() {
        let preferred = preferred_run_id.and_then(|preferred| {
            terminal
                .iter()
                .find(|fact| fact.source_run_id.as_deref() == Some(preferred))
                .copied()
        });
        if let Some(preferred) = preferred {
            let latest_needs_attention = matches!(
                latest.run_status.as_deref(),
                Some("failed" | "cancelled" | "canceled" | "timed_out" | "timeout")
            );
            if !latest_needs_attention || fact_order(preferred, latest) != std::cmp::Ordering::Less
            {
                return Ok(Some(preferred.clone()));
            }
        }
        return Ok(Some(latest.clone()));
    }
    if let Some(preferred) = preferred_run_id.and_then(|preferred| {
        runs.iter()
            .find(|fact| fact.source_run_id.as_deref() == Some(preferred))
    }) {
        return Ok(Some(preferred.clone()));
    }
    let mut facts = if related.is_empty() { runs } else { related };
    facts.sort_by(|left, right| fact_order(right, left));
    Ok(facts.into_iter().next())
}

fn fact_order(left: &ExternalFact, right: &ExternalFact) -> std::cmp::Ordering {
    left.occurred_at
        .cmp(&right.occurred_at)
        .then_with(|| left.id.cmp(&right.id))
}

fn run_summary_candidate_sql(object: &str) -> String {
    let candidates = [
        "summary",
        "result",
        "message",
        "userMessage",
        "body",
        "error",
    ];
    let mut values = Vec::new();
    for key in candidates {
        values.push(format!("CASE WHEN jsonb_typeof({object}->'{key}')='string' AND btrim({object}->>'{key}')<>'' THEN btrim({object}->>'{key}') END"));
    }
    for key in candidates {
        values.push(format!("CASE WHEN jsonb_typeof(@result->'{key}')='string' AND btrim(@result->>'{key}')<>'' THEN btrim(@result->>'{key}') END"));
    }
    values.push("NULLIF(btrim(@error),'')".to_owned());
    format!(
        "COALESCE({},format('Agent run %s is %s.',id::text,@status))",
        values.join(",")
    )
}

fn public_run_summary(status: &str, raw: Option<&str>, error: Option<&str>) -> String {
    let mut summary = raw
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| error.map(str::trim).filter(|value| !value.is_empty()))
        .unwrap_or_else(|| return_run_default(status))
        .to_owned();
    let envelope =
        Regex::new(r"(?i)__RUDDER_RESULT_[a-z0-9-]+__").expect("constant run summary regex");
    if let Some(found) = envelope.find(&summary) {
        let payload = summary[found.end()..].trim();
        if let Ok(value) = parse_legacy_read_json(payload) {
            if let Some(body) = value["body"]
                .as_str()
                .filter(|body| !body.trim().is_empty())
            {
                summary = body.to_owned();
            } else {
                summary = summary[..found.start()].trim().to_owned();
            }
        } else {
            summary = summary[..found.start()].trim().to_owned();
        }
        if summary.is_empty() {
            summary = return_run_default(status).to_owned();
        }
    }
    if summary_is_technical(&summary) {
        return generic_run_summary(status);
    }
    let internal = Regex::new(r"(?i)^Agent run\s+[\w-]+\s+is\s+[^:]+(?::\s*(.+))?$")
        .expect("constant internal run regex");
    if let Some(capture) = internal.captures(&summary) {
        if let Some(detail) = capture
            .get(1)
            .map(|item| item.as_str().trim())
            .filter(|value| !value.is_empty())
            && matches!(status, "succeeded" | "completed")
        {
            return public_goal_text(detail);
        }
        return generic_run_summary(status);
    }
    let summary = public_goal_text(&summary);
    let after = Regex::new(r"(?i)^Agent run\s+[\w-]+\s+is\s+[^:]+:\s*(.+)$")
        .expect("constant internal run regex");
    if let Some(detail) = after
        .captures(&summary)
        .and_then(|capture| capture.get(1))
        .map(|item| item.as_str().trim())
        .filter(|value| !value.is_empty())
    {
        return detail.to_owned();
    }
    if !Regex::new(r"(?i)\bagent\s+run\b")
        .unwrap()
        .is_match(&summary)
    {
        return summary;
    }
    generic_run_summary(status)
}

fn return_run_default(status: &str) -> &'static str {
    match status {
        "queued" | "pending" | "running" | "started" => "The Agent is working on this Goal.",
        "succeeded" | "completed" => "The Agent completed its latest action.",
        "failed" => "The Agent could not complete its latest action.",
        "cancelled" | "canceled" => "The Agent stopped its latest action.",
        "timed_out" | "timeout" => "The Agent's latest action needs attention.",
        _ => "The Agent has a new update on this Goal.",
    }
}

fn generic_run_summary(status: &str) -> String {
    return_run_default(status).to_owned()
}

fn summary_is_technical(summary: &str) -> bool {
    [
        r"(?i)(?:failed query|stack trace|traceback|drizzlequeryerror|connection ended|node_modules|\b(?:ECONN|ENOTFOUND|ETIMEDOUT)\b)",
        r"(?i)(?:^|\s)(?:error|exception):",
        r"(?i)\bat\s+[\w./-]+:\d+(?::\d+)?",
        r"(?i)(?:process adapter|missing command|adapter failure)",
    ]
    .iter()
    .any(|pattern| Regex::new(pattern).unwrap().is_match(summary))
}
