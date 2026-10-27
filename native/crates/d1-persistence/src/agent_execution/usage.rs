//! Existing heartbeat session-total delta projection. Raw provider totals stay
//! durable alongside the normalized per-Run counters used by the cost ledger.
use super::OwnedAgentRun;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};

pub(crate) async fn normalize(
    tx: &mut Transaction<'_, Postgres>,
    claim: &OwnedAgentRun,
    usage: &Value,
    result: &Value,
) -> Result<Value, sqlx::Error> {
    if !claim.is_generic() || !usage.is_object() {
        return Ok(usage.clone());
    }
    let mut projected = usage.clone();
    let session = result
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let previous = if let Some(session) = session {
        sqlx::query_scalar::<_,Option<Value>>("SELECT usage_json FROM heartbeat_runs WHERE org_id=$1::uuid AND agent_id=$2::uuid AND id<>$3::uuid AND session_id_after=$4 ORDER BY created_at DESC LIMIT 1")
            .bind(&claim.organization_id).bind(&claim.agent_id).bind(&claim.run_id).bind(session).fetch_optional(&mut **tx).await?.flatten()
    } else {
        None
    };
    let previous = previous.filter(|value| {
        [
            "rawInputTokens",
            "rawCachedInputTokens",
            "rawOutputTokens",
            "inputTokens",
            "cachedInputTokens",
            "outputTokens",
        ]
        .into_iter()
        .any(|key| number(value.get(key)) > 0)
    });
    for (key, raw_key) in [
        ("inputTokens", "rawInputTokens"),
        ("cachedInputTokens", "rawCachedInputTokens"),
        ("outputTokens", "rawOutputTokens"),
    ] {
        let raw = number(usage.get(raw_key).or_else(|| usage.get(key)));
        let before = previous
            .as_ref()
            .map(|previous| number(previous.get(raw_key).or_else(|| previous.get(key))));
        let normalized = before
            .map(|before| if raw >= before { raw - before } else { raw })
            .unwrap_or(raw);
        projected[key] = json!(normalized);
        projected[raw_key] = json!(raw);
    }
    if previous.is_some() {
        projected["usageSource"] = json!("session_delta");
    }
    if let Some(session) = session {
        projected["persistedSessionId"] = json!(session);
    }
    let scope: String = sqlx::query(
        "SELECT session_reuse_scope FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&claim.organization_id)
    .bind(&claim.run_id)
    .fetch_one(&mut **tx)
    .await?
    .try_get("session_reuse_scope")?;
    projected["sessionReused"] = json!(scope != "none");
    projected["taskSessionReused"] = json!(scope == "task");
    projected["freshSession"] = json!(scope == "none");
    projected["sessionReuseScope"] = json!(scope);
    Ok(projected)
}
fn number(value: Option<&Value>) -> i64 {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(|value| value.floor().clamp(0.0, i64::MAX as f64) as i64)
        .unwrap_or(0)
}
