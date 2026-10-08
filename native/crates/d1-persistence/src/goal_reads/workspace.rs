//! Rust-owned Goal workspace projections.
//!
//! These views compose Goal rows with history, wakeups, proposals and linked
//! work. Keeping the selection and public mapping here prevents the signed
//! bridge from becoming a Node snapshot relay.
use super::{
    GoalReadError, GoalReadRequest, GoalReadView, activity_summary, evidence, history,
    normalize_legacy_read_json, public_goal, public_goal_text, row, row_sql, text, transaction,
};
use crate::StoreError;
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};

const CURRENT_PROGRESS_ACTIVITY_KINDS: &[&str] =
    &["progress", "evidence", "checkpoint", "closeout"];
const TERMINAL_RUN_STATUSES: &[&str] =
    &["succeeded", "completed", "failed", "cancelled", "timed_out"];
const GOAL_FACETS: &[&str] = &[
    "agent_advancing",
    "waiting_external",
    "waiting_focus",
    "needs_attention",
    "ready_for_acceptance",
    "closed",
];

#[derive(Clone)]
pub(super) struct GoalRow {
    pub(super) public: Value,
    pub(super) overrides: Option<String>,
}

#[derive(Clone)]
pub(super) struct ExternalFact {
    pub(super) id: String,
    pub(super) summary: String,
    pub(super) occurred_at: String,
    pub(super) source_id: String,
    pub(super) source_run_id: Option<String>,
    pub(super) run_status: Option<String>,
}

pub(super) struct WorkspaceData {
    pub(super) facet: String,
    pub(super) progress: Option<Value>,
    pub(super) pending_change: Option<Value>,
    pub(super) ready_result: Option<Value>,
    pub(super) accepted_result: Option<Value>,
    pub(super) change_rows: Vec<Value>,
    pub(super) result_rows: Vec<Value>,
    pub(super) external: Option<ExternalFact>,
    pub(super) wakeup_status: Option<String>,
    pub(super) wakeup_error: Option<String>,
}

pub(super) struct OpaqueJson {
    marker: String,
    paths: Vec<String>,
    raw: String,
}

pub(super) async fn read_workspace(
    pool: &PgPool,
    org: &str,
    input: &GoalReadRequest,
    verified_run_owner: Option<&str>,
) -> Result<String, GoalReadError> {
    let goal_id = input.goal_id.as_ref().map(|id| id.to_ascii_lowercase());
    if let Some(id) = goal_id.as_deref() {
        transaction::uuid(id)?;
    }
    match input.view {
        GoalReadView::WorkspaceCards if goal_id.is_none() => (),
        GoalReadView::Assigned if goal_id.is_none() => validate_assigned(input)?,
        GoalReadView::Workspace | GoalReadView::AgentContext | GoalReadView::Timeline
            if goal_id.is_some() =>
        {
            ()
        }
        _ => return Err(StoreError::InvalidInput.into()),
    }
    if (!matches!(input.view, GoalReadView::Timeline) && input.cursor.is_some())
        || (!matches!(input.view, GoalReadView::Timeline | GoalReadView::Assigned)
            && input.limit.is_some())
    {
        return Err(StoreError::InvalidInput.into());
    }

    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    let sql = format!(
        "{} WHERE t.org_id=$1::uuid AND ($2::uuid IS NULL OR t.id=$2::uuid) ORDER BY t.created_at",
        row_sql(
            "goals",
            &[
                "created_at",
                "updated_at",
                "action_deadline",
                "evaluation_deadline",
            ]
        )
    );
    let rows = sqlx::query(&sql)
        .bind(org)
        .bind(&goal_id)
        .fetch_all(&mut *tx)
        .await?;
    let mut goals = Vec::with_capacity(rows.len());
    for raw in rows {
        goals.push(GoalRow {
            public: row(&raw.try_get::<String, _>("value")?)?,
            overrides: raw.try_get("overrides")?,
        });
    }
    if goal_id.is_some() && goals.is_empty() {
        return Err(StoreError::NotFound.into());
    }

    let mut opaque = Vec::<OpaqueJson>::new();
    let mut response = match input.view {
        GoalReadView::WorkspaceCards => {
            let mut cards = Vec::with_capacity(goals.len());
            for goal in &goals {
                cards.push(workspace_card(&mut tx, org, goal, verified_run_owner).await?);
            }
            Value::Array(cards)
        }
        GoalReadView::Assigned => {
            let agent_id = input.agent_id.as_deref().ok_or(StoreError::InvalidInput)?;
            let lifecycle = input.lifecycle.as_deref().unwrap_or("active");
            let focus = input.focus;
            let facet = input.facet.as_deref();
            let limit = assigned_limit(input.limit.as_deref())?;
            let mut cards = Vec::new();
            for goal in &goals {
                if text(&goal.public, "ownerAgentId") != agent_id
                    || (lifecycle != "all" && text(&goal.public, "lifecycle") != lifecycle)
                    || focus.is_some_and(|value| goal.public["focus"] != value)
                {
                    continue;
                }
                let card = workspace_card(&mut tx, org, goal, verified_run_owner).await?;
                if facet.is_none_or(|expected| card["facet"] == expected) {
                    cards.push(card);
                }
            }
            let count = cards.len();
            cards.truncate(limit);
            json!({
                "goals": cards,
                "count": count,
                "filters": {
                    "lifecycle": lifecycle,
                    "focus": focus,
                    "facet": facet,
                    "limit": limit,
                }
            })
        }
        GoalReadView::Workspace => {
            let goal = &goals[0];
            workspace_summary(&mut tx, org, goal, &mut opaque, verified_run_owner).await?
        }
        GoalReadView::AgentContext => {
            let goal = &goals[0];
            let raw = context::goal_context_raw(&mut tx, org, &goal.public).await?;
            let mut workspace =
                workspace_summary(&mut tx, org, goal, &mut opaque, verified_run_owner).await?;
            if let Some(marker) = workspace["goal"]["ownerAgentRuntimeOverrides"].as_str() {
                opaque.retain(|registered| registered.marker != marker);
            }
            workspace["goal"]["ownerAgentRuntimeOverrides"] = Value::Null;
            let context = context::agent_context(
                &mut tx,
                org,
                goal,
                &raw,
                &workspace,
                &mut opaque,
                input.agent_id.as_deref(),
            )
            .await?;
            context
        }
        GoalReadView::Timeline => {
            timeline::timeline(
                &mut tx,
                org,
                &goals[0].public,
                input,
                &mut opaque,
                verified_run_owner,
            )
            .await?
        }
        _ => return Err(StoreError::InvalidInput.into()),
    };
    tx.commit().await?;

    let mut final_opaque = Vec::with_capacity(opaque.len());
    let mut candidate_index = 0usize;
    for entry in &opaque {
        let paths = entry
            .paths
            .iter()
            .filter(|path| {
                response.pointer(path).and_then(Value::as_str) == Some(entry.marker.as_str())
            })
            .cloned()
            .collect::<Vec<_>>();
        if paths.is_empty() {
            // Cursor pages fetch `limit + 1` Runs before the final merged sort.
            // A look-ahead Run is intentionally absent from the response.
            continue;
        }
        loop {
            let candidate = format!("__RUDDER_RAW_GOAL_JSON_{candidate_index}__");
            candidate_index += 1;
            let current =
                serde_json::to_string(&response).map_err(|_| StoreError::InvalidReceipt)?;
            if current.contains(&candidate)
                || opaque.iter().any(|item| item.raw.contains(&candidate))
                || entry.raw.contains(&candidate)
            {
                continue;
            }
            for path in &paths {
                if let Some(slot) = response.pointer_mut(path) {
                    *slot = json!(candidate);
                }
            }
            final_opaque.push((candidate, entry.raw.clone()));
            break;
        }
    }
    let mut serialized =
        serde_json::to_string(&response).map_err(|_| StoreError::InvalidReceipt)?;
    for (marker, raw) in final_opaque {
        let marker = serde_json::to_string(&marker).map_err(|_| StoreError::InvalidReceipt)?;
        let normalized =
            normalize_legacy_read_json(&raw).map_err(|_| StoreError::InvalidReceipt)?;
        // These final tokens were checked against every normal response value,
        // object key, and raw payload before insertion. Text splicing therefore
        // targets only a registered JSON field while preserving deep payloads.
        serialized = serialized.replace(&marker, &normalized);
    }
    Ok(serialized)
}

fn validate_assigned(input: &GoalReadRequest) -> Result<(), GoalReadError> {
    let Some(agent_id) = input.agent_id.as_deref() else {
        return Err(StoreError::InvalidInput.into());
    };
    transaction::uuid(&agent_id.to_ascii_lowercase())?;
    if !matches!(
        input.lifecycle.as_deref(),
        Some("draft" | "active" | "closed" | "all")
    ) || input.cursor.is_some()
    {
        return Err(StoreError::InvalidInput.into());
    }
    if input
        .facet
        .as_deref()
        .is_some_and(|facet| !GOAL_FACETS.contains(&facet))
    {
        return Err(StoreError::InvalidInput.into());
    }
    let _ = assigned_limit(input.limit.as_deref())?;
    Ok(())
}

fn assigned_limit(raw: Option<&str>) -> Result<usize, GoalReadError> {
    let Some(raw) = raw else {
        return Err(StoreError::InvalidInput.into());
    };
    let trimmed = raw.trim_matches(char::is_whitespace);
    let value = trimmed.parse::<f64>().ok();
    value
        .filter(|number| {
            number.is_finite() && number.fract() == 0.0 && *number >= 1.0 && *number <= 100.0
        })
        .map(|number| number as usize)
        .ok_or_else(|| StoreError::InvalidInput.into())
}

async fn workspace_card(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    goal: &GoalRow,
    verified_run_owner: Option<&str>,
) -> Result<Value, GoalReadError> {
    let data = workspace_data(tx, org, goal, WorkspaceSelection::Card, verified_run_owner).await?;
    let id = text(&goal.public, "id");
    let owner_id = goal.public["ownerAgentId"].as_str();
    let owner_name = if let Some(owner_id) = owner_id {
        sqlx::query_scalar::<_, String>(
            "SELECT name FROM agents WHERE org_id=$1::uuid AND id=$2::uuid",
        )
        .bind(org)
        .bind(owner_id)
        .fetch_optional(&mut **tx)
        .await?
    } else {
        None
    };
    let current_progress = data
        .progress
        .as_ref()
        .map(activity_summary)
        .unwrap_or_else(|| "No evidence-backed progress has been recorded yet.".to_owned());
    let attention_reason = card_attention_reason(goal, &data);
    Ok(json!({
        "id": id,
        "orgId": goal.public["orgId"],
        "title": goal.public["title"],
        "lifecycle": goal.public["lifecycle"],
        "status": goal.public["status"],
        "facet": data.facet,
        "ownerAgentId": goal.public["ownerAgentId"],
        "ownerName": owner_name,
        "currentProgress": current_progress,
        "progressSummary": current_progress,
        "nextAction": goal.public["continuationSummary"].as_str().map(public_goal_text),
        "nextStepSummary": goal.public["continuationSummary"].as_str()
            .map(public_goal_text)
            .unwrap_or_else(|| "No next step has been recorded.".to_owned()),
        "targetTime": goal.public["evaluationDeadline"].as_str().or(goal.public["actionDeadline"].as_str()),
        "attentionReason": attention_reason,
        "focus": goal.public["focus"],
        "updatedAt": goal.public["updatedAt"],
    }))
}

fn card_attention_reason(goal: &GoalRow, data: &WorkspaceData) -> Option<String> {
    if text(&goal.public, "lifecycle") == "closed" {
        return None;
    }
    if let Some(result) = &data.ready_result {
        return Some(public_goal_text(&format!(
            "Review the proposed Goal result: {}",
            public_outcome(result["preflight"]["outcome"].as_str().unwrap_or_default())
        )));
    }
    if let Some(change) = &data.pending_change {
        return Some(public_goal_text(&text(change, "rationale")));
    }
    if text(&goal.public, "lifecycle") == "draft" {
        if let Some(question) = goal.public["alignmentQuestion"].as_str() {
            return Some(public_goal_text(question));
        }
    }
    wakeup_attention_reason(data.wakeup_status.as_deref(), data.wakeup_error.as_deref())
        .or_else(|| {
            data.external
                .as_ref()
                .and_then(|fact| run_attention_reason(fact.run_status.as_deref()))
        })
        .map(|reason| public_goal_text(reason))
}

async fn workspace_summary(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    goal: &GoalRow,
    opaque: &mut Vec<OpaqueJson>,
    verified_run_owner: Option<&str>,
) -> Result<Value, GoalReadError> {
    let data = workspace_data(
        tx,
        org,
        goal,
        WorkspaceSelection::Detail,
        verified_run_owner,
    )
    .await?;
    let id = text(&goal.public, "id");
    let url_key: Option<String> =
        sqlx::query_scalar("SELECT url_key FROM organizations WHERE id=$1::uuid")
            .bind(org)
            .fetch_optional(&mut **tx)
            .await?;
    let history_input = GoalReadRequest {
        view: GoalReadView::History,
        goal_id: Some(id),
        cursor: None,
        limit: None,
        agent_id: None,
        lifecycle: None,
        focus: None,
        facet: None,
    };
    let timeline = history(tx, org, &text(&goal.public, "id"), &history_input).await?;
    let current_progress = if let Some(activity) = &data.progress {
        let accepted = data.accepted_result.as_ref();
        json!({
            "summary": accepted.map(|proposal| public_outcome(proposal["preflight"]["outcome"].as_str().unwrap_or_default()).to_owned())
                .unwrap_or_else(|| activity_summary(activity)),
            "sourceActivityId": activity["id"],
            "evidence": evidence(&activity["evidenceRefs"], activity["submittedByAgentId"].as_str(), url_key.as_deref()),
        })
    } else {
        json!({
            "summary": "No evidence-backed progress has been recorded yet.",
            "sourceActivityId": null,
            "evidence": [],
        })
    };
    let ready_result = data.ready_result.as_ref();
    let pending_change = data.pending_change.as_ref();
    let attention = if text(&goal.public, "lifecycle") == "closed" {
        Value::Null
    } else if let Some(result) = ready_result {
        json!({
            "kind": "result_proposal",
            "reason": "Review the proposed Goal result and decide whether it is sufficient.",
            "sourceId": result["id"],
        })
    } else if let Some(change) = pending_change {
        json!({"kind":"change_proposal","reason":public_goal_text(&text(change,"rationale")),"sourceId":change["id"]})
    } else if text(&goal.public, "lifecycle") == "draft"
        && goal.public["alignmentQuestion"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
    {
        json!({"kind":"alignment_question","reason":public_goal_text(goal.public["alignmentQuestion"].as_str().unwrap()),"sourceId":goal.public["id"]})
    } else if let Some(reason) =
        wakeup_attention_reason(data.wakeup_status.as_deref(), data.wakeup_error.as_deref())
    {
        json!({"kind":"owner_blocked","reason":reason,"sourceId":data.wakeup_status})
    } else if let Some(reason) = data
        .external
        .as_ref()
        .and_then(|fact| run_attention_reason(fact.run_status.as_deref()))
    {
        json!({"kind":"owner_blocked","reason":reason,"sourceId":data.external.as_ref().and_then(|fact| if fact.run_status.is_some() { fact.source_run_id.as_deref() } else { Some(fact.source_id.as_str()) })})
    } else {
        Value::Null
    };
    let next_step = if ready_result.is_some() {
        json!({"summary":"Review the proposed result above.","wakeCondition":null})
    } else if pending_change.is_some() {
        json!({"summary":"Review the proposed Goal update above.","wakeCondition":null})
    } else if goal.public["continuationSummary"]
        .as_str()
        .is_some_and(|s| !s.is_empty())
        && goal.public["continuationKind"].as_str().is_some()
    {
        json!({
            "summary": goal.public["continuationSummary"].as_str().map(public_goal_text),
            "wakeCondition": goal.public["wakeCondition"].as_str().map(public_goal_text),
        })
    } else {
        Value::Null
    };
    let agent_action = if ready_result.is_some() {
        Value::Null
    } else if let Some(fact) = &data.external {
        let mut action = json!({"summary":fact.summary,"sourceIds":[fact.source_id]});
        if let Some(status) = &fact.run_status {
            action["status"] = json!(status);
        }
        action
    } else {
        Value::Null
    };
    let mut public_goal = public_goal(&goal.public);
    // Runtime overrides are retained for the complete workspace response just
    // as in the established publicGoalView mapping.
    let overrides = goal.overrides.as_deref().unwrap_or("null");
    let marker = fresh_marker(opaque, Some(overrides));
    public_goal["ownerAgentRuntimeOverrides"] = json!(marker);
    opaque.push(OpaqueJson {
        marker,
        paths: vec!["/goal/ownerAgentRuntimeOverrides".to_owned()],
        raw: overrides.to_owned(),
    });
    let mut result_proposals = Vec::with_capacity(data.result_rows.len());
    for proposal in &data.result_rows {
        result_proposals.push(proposals::public_result_proposal(
            proposal,
            url_key.as_deref(),
        ));
    }
    let mut change_proposals = Vec::with_capacity(data.change_rows.len());
    for proposal in &data.change_rows {
        change_proposals.push(proposals::public_change_proposal(
            proposal,
            url_key.as_deref(),
        ));
    }
    Ok(json!({
        "goal": public_goal,
        "facet": data.facet,
        "currentGoal": {
            "summary": goal.public["outcomeStatement"].as_str().map(public_goal_text)
                .unwrap_or_else(|| public_goal_text(goal.public["title"].as_str().unwrap_or_default())),
            "updatedFromEvidence": data.progress.is_some(),
        },
        "currentProgress": current_progress,
        "agentAction": agent_action,
        "nextStep": next_step,
        "attention": attention,
        "timeline": timeline["items"],
        "timelineNextCursor": timeline["nextCursor"],
        "changeProposals": change_proposals,
        "resultProposals": result_proposals,
    }))
}

#[derive(Clone, Copy)]
enum WorkspaceSelection {
    Card,
    Detail,
}

async fn workspace_data(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    goal: &GoalRow,
    selection: WorkspaceSelection,
    verified_run_owner: Option<&str>,
) -> Result<WorkspaceData, GoalReadError> {
    let id = text(&goal.public, "id");
    let change_rows =
        proposals::fetch_change_proposals(tx, org, &id, "status='pending'", false).await?;
    let result_rows = proposals::fetch_result_proposals(
        tx,
        org,
        &id,
        "status IN ('ready','accepted')",
        matches!(selection, WorkspaceSelection::Detail),
    )
    .await?;
    let progress = proposals::fetch_progress(tx, org, &id).await?;
    let (wakeup_status, wakeup_error) = proposals::fetch_wakeup_attention(tx, org, &id).await?;
    let external = external::latest_external_fact(
        tx,
        org,
        goal,
        match selection {
            WorkspaceSelection::Card => None,
            WorkspaceSelection::Detail => progress.as_ref().and_then(|p| p["runRef"].as_str()),
        },
        verified_run_owner,
    )
    .await?;
    let pending_change = change_rows.first().cloned();
    let ready_result = result_rows
        .iter()
        .find(|row| row["status"] == "ready")
        .cloned();
    let accepted_result = result_rows
        .iter()
        .find(|row| row["status"] == "accepted")
        .cloned();
    let facet = facet_for(
        goal,
        pending_change.as_ref(),
        ready_result.as_ref(),
        wakeup_status.as_deref(),
        external.as_ref(),
    );
    Ok(WorkspaceData {
        facet,
        progress,
        pending_change,
        ready_result,
        accepted_result,
        change_rows,
        result_rows,
        external,
        wakeup_status,
        wakeup_error,
    })
}

fn facet_for(
    goal: &GoalRow,
    pending_change: Option<&Value>,
    ready_result: Option<&Value>,
    wakeup_status: Option<&str>,
    external: Option<&ExternalFact>,
) -> String {
    let lifecycle = text(&goal.public, "lifecycle");
    if lifecycle == "closed" {
        return "closed".to_owned();
    }
    if lifecycle == "draft" {
        return "needs_attention".to_owned();
    }
    if ready_result.is_some() {
        return "ready_for_acceptance".to_owned();
    }
    if pending_change.is_some() {
        return "needs_attention".to_owned();
    }
    if wakeup_status == Some("deferred_goal_focus") {
        return "waiting_focus".to_owned();
    }
    if matches!(
        wakeup_status,
        Some("deferred_goal_blocked" | "deferred_agent_paused")
    ) {
        return "needs_attention".to_owned();
    }
    if external
        .and_then(|fact| run_attention_reason(fact.run_status.as_deref()))
        .is_some()
    {
        return "needs_attention".to_owned();
    }
    if goal.public["continuationKind"] == "wait" {
        return "waiting_external".to_owned();
    }
    "agent_advancing".to_owned()
}

fn run_attention_reason(status: Option<&str>) -> Option<&'static str> {
    match status {
        Some("failed") => Some(
            "The Owner Agent could not complete its latest action. Decide whether to retry or adjust the Goal.",
        ),
        Some("cancelled" | "canceled") => Some(
            "The Owner Agent stopped its latest action. Decide whether to retry or adjust the Goal.",
        ),
        Some("timed_out" | "timeout") => Some(
            "The Owner Agent's latest action timed out. Decide whether to retry or adjust the Goal.",
        ),
        _ => None,
    }
}

fn wakeup_attention_reason(status: Option<&str>, error: Option<&str>) -> Option<&'static str> {
    if status == Some("deferred_agent_paused") {
        return Some("The Owner Agent is paused. Resume it to continue this Goal.");
    }
    if status != Some("deferred_goal_blocked") {
        return None;
    }
    Some(match error {
        Some("heartbeat.wakeOnDemand.disabled") => {
            "The Owner Agent is not accepting on-demand work. Update the Agent or choose another Owner."
        }
        Some("agent.unavailable") => {
            "The Owner Agent is unavailable. Make it available or choose another Owner."
        }
        Some("budget.blocked") => {
            "The Owner Agent is blocked by a budget limit. Resolve the budget decision to continue."
        }
        _ => {
            "The Owner Agent cannot start this work yet. Resolve its blocking condition to continue."
        }
    })
}

pub(super) fn public_outcome(outcome: &str) -> &'static str {
    match outcome {
        "achieved" => "Goal achieved",
        "not_achieved" => "Goal not achieved",
        "maintained" => "Goal maintained",
        "breached" => "Goal condition breached",
        "completed_with_result" => "Goal completed with a measured result",
        "decided" => "Goal completed with a decision",
        _ => "Result needs more evidence",
    }
}

fn fresh_marker(opaque: &[OpaqueJson], upcoming_raw: Option<&str>) -> String {
    let mut index = opaque.len();
    loop {
        let marker = format!("__RUDDER_OPAQUE_GOAL_JSON_{index}__");
        if opaque
            .iter()
            .all(|entry| entry.marker != marker && !entry.raw.contains(&marker))
            && !upcoming_raw.is_some_and(|raw| raw.contains(&marker))
        {
            return marker;
        }
        index += 1;
    }
}

fn set_raw(
    object: &mut Value,
    key: &str,
    raw: Option<&str>,
    path: String,
    opaque: &mut Vec<OpaqueJson>,
) -> Result<(), GoalReadError> {
    let Some(raw) = raw else {
        object[key] = Value::Null;
        return Ok(());
    };
    let marker = fresh_marker(opaque, Some(raw));
    object[key] = json!(marker);
    opaque.push(OpaqueJson {
        marker,
        paths: if path.is_empty() {
            Vec::new()
        } else {
            vec![path]
        },
        raw: raw.to_owned(),
    });
    Ok(())
}

mod context;
mod external;
mod proposals;
mod timeline;
