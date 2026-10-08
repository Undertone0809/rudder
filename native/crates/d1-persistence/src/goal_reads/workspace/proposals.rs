//! Safe Goal proposal projections used by the workspace views.
use super::super::parse_legacy_read_json;
use super::super::{GoalReadError, evidence, public_goal_text};
use super::super::{row, row_sql};
use super::{CURRENT_PROGRESS_ACTIVITY_KINDS, public_outcome};
use crate::StoreError;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};

fn array_strings_sql(expression: &str) -> String {
    format!(
        "(SELECT COALESCE(jsonb_agg(e.value),'[]'::jsonb) FROM jsonb_array_elements(CASE WHEN jsonb_typeof({expression})='array' THEN {expression} ELSE '[]'::jsonb END) e WHERE jsonb_typeof(e.value)='string')"
    )
}

fn contract_summary_sql(expression: &str) -> String {
    let authorities = format!(
        "(SELECT COALESCE(jsonb_object_agg(a.key,a.value),'{{}}'::jsonb) FROM jsonb_each(CASE WHEN jsonb_typeof({expression}->'humanAuthorities')='object' THEN {expression}->'humanAuthorities' ELSE '{{}}'::jsonb END) a WHERE a.value='true'::jsonb OR a.value='\"board_human\"'::jsonb)"
    );
    let authority_order = format!(
        "(SELECT COALESCE(jsonb_agg(jsonb_build_array(a.key,a.value) ORDER BY length(a.key),a.key COLLATE \"C\"),'[]'::jsonb) FROM jsonb_each(CASE WHEN jsonb_typeof({expression}->'humanAuthorities')='object' THEN {expression}->'humanAuthorities' ELSE '{{}}'::jsonb END) a WHERE a.value='true'::jsonb OR a.value='\"board_human\"'::jsonb)"
    );
    format!(
        "jsonb_build_object(\
          'outcomeStatement',CASE WHEN jsonb_typeof({expression}->'outcomeStatement')='string' THEN {expression}->'outcomeStatement' ELSE NULL END,\
          'criteria',(SELECT COALESCE(jsonb_agg(jsonb_build_object('label',c.value->'label')),'[]'::jsonb) FROM jsonb_array_elements(CASE WHEN jsonb_typeof({expression}->'criteria')='array' THEN {expression}->'criteria' ELSE '[]'::jsonb END) c WHERE jsonb_typeof(c.value->'label')='string'),\
          'actionDeadline',CASE WHEN jsonb_typeof({expression}->'actionDeadline')='string' THEN {expression}->'actionDeadline' ELSE NULL END,\
          'evaluationDeadline',CASE WHEN jsonb_typeof({expression}->'evaluationDeadline')='string' THEN {expression}->'evaluationDeadline' ELSE NULL END,\
          'autonomyEnvelope',jsonb_build_object('allowed',{},'requiresHumanApproval',{}),\
          'humanAuthorities',{},\
          'humanAuthoritiesOrder',{},\
          'evaluationPolicy',jsonb_build_object('terminalEvidenceRequired',({expression}->'evaluationPolicy'->'terminalEvidenceRequired'='true'::jsonb),'humanAcceptanceRequired',({expression}->'evaluationPolicy'->'humanAcceptanceRequired'='true'::jsonb))\
        )",
        array_strings_sql(&format!("{expression}->'autonomyEnvelope'->'allowed'")),
        array_strings_sql(&format!(
            "{expression}->'autonomyEnvelope'->'requiresHumanApproval'"
        )),
        authorities,
        authority_order,
    )
}

pub(super) async fn fetch_change_proposals(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    goal_id: &str,
    status_clause: &str,
    descending: bool,
) -> Result<Vec<Value>, GoalReadError> {
    let before = contract_summary_sql("t.before_contract");
    let after = contract_summary_sql("t.after_contract");
    let order = if descending { "DESC" } else { "ASC" };
    let sql = format!(
        "SELECT jsonb_build_object('id',t.id,'approvalId',t.approval_id,'status',t.status,'rationale',t.rationale,'proposedByAgentId',t.proposed_by_agent_id,'evidenceRefs',{},'beforeSummary',{},'afterSummary',{})::text FROM goal_change_proposals t WHERE t.org_id=$1::uuid AND t.goal_id=$2::uuid AND {} ORDER BY t.created_at {}",
        array_strings_sql("t.evidence_refs"),
        before,
        after,
        status_clause,
        order
    );
    sqlx::query_scalar::<_, String>(&sql)
        .bind(org)
        .bind(goal_id)
        .fetch_all(&mut **tx)
        .await?
        .iter()
        .map(|raw| parse_legacy_read_json(raw).map_err(|_| StoreError::InvalidReceipt.into()))
        .collect()
}

pub(super) async fn fetch_result_proposals(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    goal_id: &str,
    status_clause: &str,
    descending: bool,
) -> Result<Vec<Value>, GoalReadError> {
    let order = if descending { "DESC" } else { "ASC" };
    let criteria = "(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',c.value->'id','status',c.value->'status','missingEvidenceCount',CASE WHEN jsonb_typeof(c.value->'missingEvidence')='array' THEN jsonb_array_length(c.value->'missingEvidence') ELSE 0 END)),'[]'::jsonb) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.preflight->'criteria')='array' THEN t.preflight->'criteria' ELSE '[]'::jsonb END) c WHERE jsonb_typeof(c.value->'id')='string')";
    let sql = format!(
        "SELECT jsonb_build_object('id',t.id,'status',t.status,'riskSummary',t.risk_summary,'proposedByAgentId',t.proposed_by_agent_id,'candidate',jsonb_build_object('evidenceRefs',{},'resultValue',CASE WHEN jsonb_typeof(t.candidate->'resultValue') IN ('string','number','boolean') THEN t.candidate->'resultValue' ELSE NULL END,'decision',CASE WHEN jsonb_typeof(t.candidate->'decision')='string' THEN t.candidate->'decision' ELSE NULL END),'preflight',jsonb_build_object('outcome',CASE WHEN jsonb_typeof(t.preflight->'outcome')='string' THEN t.preflight->'outcome' ELSE NULL END,'criteria',{},'resultValue',CASE WHEN jsonb_typeof(t.preflight->'resultValue') IN ('string','number','boolean') THEN t.preflight->'resultValue' ELSE NULL END,'decision',CASE WHEN jsonb_typeof(t.preflight->'decision')='string' THEN t.preflight->'decision' ELSE NULL END))::text FROM goal_result_proposals t WHERE t.org_id=$1::uuid AND t.goal_id=$2::uuid AND {} ORDER BY t.created_at {}",
        array_strings_sql("t.candidate->'evidenceRefs'"),
        criteria,
        status_clause,
        order
    );
    sqlx::query_scalar::<_, String>(&sql)
        .bind(org)
        .bind(goal_id)
        .fetch_all(&mut **tx)
        .await?
        .iter()
        .map(|raw| parse_legacy_read_json(raw).map_err(|_| StoreError::InvalidReceipt.into()))
        .collect()
}

pub(super) async fn fetch_progress(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    goal_id: &str,
) -> Result<Option<Value>, GoalReadError> {
    let kinds = CURRENT_PROGRESS_ACTIVITY_KINDS
        .iter()
        .map(|kind| format!("'{}'", kind))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "{} WHERE t.org_id=$1::uuid AND t.goal_id=$2::uuid AND t.activity_kind IN ({kinds}) AND (t.run_ref IS NOT NULL OR t.idempotency_key LIKE 'goal-result-evidence:%') AND jsonb_array_length(t.evidence_refs)>0 ORDER BY t.occurred_at DESC,t.created_at DESC LIMIT 1",
        row_sql("goal_activities", &["created_at", "occurred_at"])
    );
    sqlx::query_scalar::<_, String>(&sql)
        .bind(org)
        .bind(goal_id)
        .fetch_optional(&mut **tx)
        .await?
        .map(|raw| row(&raw).map_err(Into::into))
        .transpose()
}

pub(super) async fn fetch_wakeup_attention(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    goal_id: &str,
) -> Result<(Option<String>, Option<String>), GoalReadError> {
    let row = sqlx::query(
        "SELECT status,error FROM agent_wakeup_requests WHERE org_id=$1::uuid AND payload->>'goalId'=$2 AND status IN ('deferred_goal_focus','deferred_goal_blocked','deferred_agent_paused') AND run_id IS NULL ORDER BY requested_at DESC LIMIT 1",
    )
    .bind(org)
    .bind(goal_id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(match row {
        Some(row) => (row.try_get("status")?, row.try_get("error")?),
        None => (None, None),
    })
}

pub(super) fn public_change_proposal(proposal: &Value, org_key: Option<&str>) -> Value {
    json!({
        "id": proposal["id"],
        "approvalId": proposal["approvalId"],
        "status": proposal["status"],
        "rationale": public_goal_text(proposal["rationale"].as_str().unwrap_or_default()),
        "evidence": evidence(&proposal["evidenceRefs"], proposal["proposedByAgentId"].as_str(), org_key),
        "beforeSummary": public_contract_summary(&proposal["beforeSummary"]),
        "afterSummary": public_contract_summary(&proposal["afterSummary"]),
    })
}

fn public_contract_summary(record: &Value) -> Value {
    let outcome = record["outcomeStatement"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .map(public_goal_text);
    let criteria = record["criteria"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|criterion| {
            criterion["label"]
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .map(|label| json!({"label":public_goal_text(label)}))
        })
        .collect::<Vec<_>>();
    let target_time = record["evaluationDeadline"]
        .as_str()
        .or(record["actionDeadline"].as_str());
    let allowed = record["autonomyEnvelope"]["allowed"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(public_goal_token)
        .collect::<Vec<_>>();
    let approvals = record["autonomyEnvelope"]["requiresHumanApproval"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(public_goal_token)
        .collect::<Vec<_>>();
    let decisions = record["humanAuthoritiesOrder"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let key = entry[0].as_str()?;
            let value = &entry[1];
            ((value == &json!(true)) || value == "board_human").then(|| public_goal_token(key))
        })
        .collect::<Vec<_>>();
    let mut result = serde_json::Map::new();
    if let Some(outcome) = outcome {
        result.insert("outcomeStatement".to_owned(), json!(outcome));
    }
    if !criteria.is_empty() {
        result.insert("criteria".to_owned(), json!(criteria));
    }
    if let Some(target_time) = target_time {
        result.insert("targetTime".to_owned(), json!(target_time));
    }
    let boundary = [
        (!allowed.is_empty()).then(|| format!("The Agent may handle {}.", allowed.join(", "))),
        (!approvals.is_empty())
            .then(|| format!("You will be asked before {}.", approvals.join(", "))),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ");
    if !boundary.is_empty() {
        result.insert("boundarySummary".to_owned(), json!(boundary));
    }
    if !decisions.is_empty() {
        result.insert(
            "approvalSummary".to_owned(),
            json!(format!("You decide {}.", decisions.join(", "))),
        );
    }
    let evidence_required = record["evaluationPolicy"]["terminalEvidenceRequired"] == true;
    let acceptance_required = record["evaluationPolicy"]["humanAcceptanceRequired"] == true;
    let completion = match (evidence_required, acceptance_required) {
        (true, true) => Some("Supporting work is shown, and you accept the result."),
        (true, false) => Some("Supporting work is shown before the result is considered ready."),
        (false, true) => Some("You accept the result when it is ready."),
        _ => None,
    };
    if let Some(completion) = completion {
        result.insert("completionSummary".to_owned(), json!(completion));
    }
    Value::Object(result)
}

fn public_goal_token(value: &str) -> String {
    match value {
        "bounded_reversible_work" => "bounded, reversible work".to_owned(),
        "external_or_irreversible_action" => "external or irreversible actions".to_owned(),
        "external_publication" | "externalPublication" => "publishing externally".to_owned(),
        "authority_expansion" => "expanding access".to_owned(),
        "acceptance" => "accepting the result".to_owned(),
        "consequentialChanges" => "consequential changes".to_owned(),
        value => {
            let mut out = String::new();
            let mut previous_lower = false;
            for ch in value.chars() {
                if ch == '_' || ch == '-' {
                    if !out.ends_with(' ') {
                        out.push(' ');
                    }
                    previous_lower = false;
                } else {
                    if previous_lower && ch.is_ascii_uppercase() {
                        out.push(' ');
                    }
                    out.extend(ch.to_lowercase());
                    previous_lower = ch.is_ascii_lowercase();
                }
            }
            out.trim().to_owned()
        }
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    js_string(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

pub(super) fn public_result_proposal(proposal: &Value, org_key: Option<&str>) -> Value {
    let candidate = &proposal["candidate"];
    let preflight = &proposal["preflight"];
    let outcome = preflight["outcome"].as_str().unwrap_or("inconclusive");
    let result_value = if !preflight["resultValue"].is_null() {
        &preflight["resultValue"]
    } else {
        &candidate["resultValue"]
    };
    let decision = preflight["decision"]
        .as_str()
        .or(candidate["decision"].as_str());
    let outcome_label = if outcome == "completed_with_result" && !result_value.is_null() {
        format!("Completed with result: {}", js_string(result_value))
    } else if outcome == "decided" && decision.is_some() {
        format!("Decision reached: {}", decision.unwrap())
    } else {
        public_outcome(outcome).to_owned()
    };
    let criteria = preflight["criteria"].as_array().into_iter().flatten().filter_map(|criterion| {
        let id = criterion["id"].as_str()?;
        Some(json!({"id":id,"status":criterion["status"].as_str().unwrap_or("unknown"),"missingEvidenceCount":criterion["missingEvidenceCount"].as_u64().unwrap_or(0)}))
    }).collect::<Vec<_>>();
    json!({
        "id": proposal["id"],
        "status": proposal["status"],
        "outcome": outcome,
        "outcomeLabel": outcome_label,
        "criteria": criteria,
        "evidence": evidence(&candidate["evidenceRefs"], proposal["proposedByAgentId"].as_str(), org_key),
        "riskSummary": proposal["riskSummary"].as_str().map(public_goal_text),
    })
}
