use super::{common::*, constants::*, reads, redaction};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
pub(super) fn random_hex(bytes: usize) -> Result<String> {
    let mut output = vec![0_u8; bytes];
    getrandom::getrandom(&mut output).map_err(|_| http(503, "Secure randomness is unavailable"))?;
    Ok(output.iter().map(|b| format!("{b:02x}")).collect())
}
pub(super) async fn suggest_name(tx: &mut Tx<'_>, org: &str) -> Result<String> {
    let rows = sqlx::query_scalar::<_, String>(
        "SELECT name FROM agents WHERE org_id=$1::uuid AND status<>'terminated'",
    )
    .bind(org)
    .fetch_all(&mut **tx)
    .await?;
    let used = rows
        .iter()
        .map(|n| slug(n))
        .collect::<std::collections::BTreeSet<_>>();
    let available = AGENT_NAME_POOL
        .iter()
        .copied()
        .filter(|n| !used.contains(&slug(n)))
        .collect::<Vec<_>>();
    let pool = if available.is_empty() {
        AGENT_NAME_POOL
    } else {
        &available
    };
    let mut bytes = [0; 8];
    getrandom::getrandom(&mut bytes).map_err(|_| http(503, "Secure randomness is unavailable"))?;
    let base = pool[(u64::from_le_bytes(bytes) % (pool.len() as u64)) as usize];
    if !used.contains(&slug(base)) {
        return Ok(base.into());
    }
    for n in 2..=100 {
        let v = format!("{base} {n}");
        if !used.contains(&slug(&v)) {
            return Ok(v);
        }
    }
    Ok(format!(
        "{base} {}",
        time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000
    ))
}
pub(super) async fn execute(
    tx: &mut Tx<'_>,
    ctx: &Context<'_>,
    op: &str,
    current: Option<&Value>,
    input: &Value,
) -> Result<Value> {
    let row = current.ok_or_else(|| http(404, "Agent not found"))?;
    let id = text(row, "id");
    match op {
        "permissions" => super::detail::update_permissions(tx, ctx, row, input).await,
        "key-create" => {
            if row["status"] == "pending_approval" {
                return Err(http(409, "Cannot create keys for pending approval agents"));
            }
            if row["status"] == "terminated" {
                return Err(http(409, "Cannot create keys for terminated agents"));
            }
            let token = format!("pcp_{}", random_hex(24)?);
            let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
            let key = insert(
                tx,
                "agent_api_keys",
                &json!({"orgId":ctx.org,"agentId":id,"name":input["name"],"keyHash":hash}),
            )
            .await?;
            activity(
                tx,
                ctx,
                "agent.key_created",
                id,
                Some(&json!({"keyId":key["id"],"name":key["name"]})),
            )
            .await?;
            Ok(
                json!({"id":key["id"],"name":key["name"],"token":token,"createdAt":key["createdAt"]}),
            )
        }
        "key-revoke" => {
            let changed=sqlx::query("UPDATE agent_api_keys SET revoked_at=now() WHERE org_id=$1::uuid AND agent_id=$2::uuid AND id=$3::uuid").bind(ctx.org).bind(id).bind(ctx.request.key_id.as_deref()).execute(&mut **tx).await?.rows_affected();
            if changed == 0 {
                return Err(http(404, "Key not found"));
            }
            Ok(json!({"ok":true}))
        }
        "reset-session" => {
            reads::ensure_state(tx, ctx, row).await?;
            let key = input["taskKey"]
                .as_str()
                .map(js_trim)
                .filter(|s| !s.is_empty());
            let cleared=sqlx::query("DELETE FROM agent_task_sessions WHERE org_id=$1::uuid AND agent_id=$2::uuid AND ($3::text IS NULL OR (task_key=$3 AND agent_runtime_type=$4))").bind(ctx.org).bind(id).bind(key).bind(text(row,"agentRuntimeType")).execute(&mut **tx).await?.rows_affected();
            let mut state=decode(&sqlx::query_scalar::<_,String>("UPDATE agent_runtime_state SET session_id=NULL,last_error=NULL,state_json=CASE WHEN $3::text IS NULL THEN '{}'::jsonb ELSE state_json END,updated_at=now() WHERE org_id=$1::uuid AND agent_id=$2::uuid RETURNING to_jsonb(agent_runtime_state)::text").bind(ctx.org).bind(id).bind(key).fetch_one(&mut **tx).await?)?;
            reads::protect_runtime_state(tx, ctx, &mut state).await?;
            state["sessionDisplayId"] = Value::Null;
            state["sessionParamsJson"] = Value::Null;
            state["clearedTaskSessions"] = json!(cleared);
            activity(
                tx,
                ctx,
                "agent.runtime_session_reset",
                id,
                Some(&json!({"taskKey":key})),
            )
            .await?;
            Ok(state)
        }
        "rollback" => rollback(tx, ctx, row).await,
        _ => Err(http(400, "Invalid Agent command")),
    }
}
const REVISION_FIELDS: &[&str] = &[
    "name",
    "role",
    "title",
    "capabilities",
    "agentRuntimeType",
    "agentRuntimeConfig",
    "runtimeConfig",
    "budgetMonthlyCents",
    "metadata",
];
fn snapshot(row: &Value) -> Value {
    let mut output = json!({});
    for key in REVISION_FIELDS {
        output[key] =
            if ["agentRuntimeConfig", "runtimeConfig"].contains(key) && !row[key].is_object() {
                json!({})
            } else if ["agentRuntimeConfig", "runtimeConfig", "metadata"].contains(key) {
                redaction::sanitize(&row[key])
            } else {
                row[key].clone()
            };
    }
    output
}
async fn rollback(tx: &mut Tx<'_>, ctx: &Context<'_>, row: &Value) -> Result<Value> {
    let id = text(row, "id");
    require_update(tx, ctx, id).await?;
    let mut patch = {
        let raw=sqlx::query_scalar::<_,String>("SELECT after_config::text FROM agent_config_revisions WHERE org_id=$1::uuid AND agent_id=$2::uuid AND id=$3::uuid").bind(ctx.org).bind(id).bind(ctx.request.revision_id.as_deref()).fetch_optional(&mut **tx).await?.ok_or_else(||http(404,"Revision not found"))?;
        let snapshot = super::json_boundary::parse(&raw)
            .map_err(|_| http(422, "Invalid revision snapshot"))?;
        if redaction::contains_marker(&snapshot) {
            return Err(http(
                422,
                "Cannot roll back a revision that contains redacted secret values",
            ));
        }
        if !snapshot.is_object() {
            return Err(http(422, "Invalid revision snapshot"));
        }
        for k in ["name", "role", "agentRuntimeType"] {
            if snapshot[k].as_str().is_none_or(str::is_empty) {
                return Err(http(422, format!("Invalid revision snapshot: {k}")));
            }
        }
        if snapshot["budgetMonthlyCents"].as_f64().is_none() {
            return Err(http(422, "Invalid revision snapshot: budgetMonthlyCents"));
        }
        let mut patch = json!({});
        for key in REVISION_FIELDS {
            patch[key] = snapshot[key].clone();
        }
        patch["budgetMonthlyCents"] = json!(
            snapshot["budgetMonthlyCents"]
                .as_f64()
                .unwrap_or(0.0)
                .floor()
                .max(0.0) as i64
        );
        for key in ["title", "capabilities"] {
            if !patch[key].is_string() {
                patch[key] = Value::Null
            }
        }
        for key in ["agentRuntimeConfig", "runtimeConfig"] {
            if !patch[key].is_object() {
                patch[key] = json!({})
            }
        }
        if !patch["metadata"].is_object() {
            patch["metadata"] = Value::Null
        }
        patch
    };
    if let Some(name) = patch["name"].as_str()
        && slug(name) != slug(text(row, "name"))
    {
        let names=sqlx::query_scalar::<_,String>("SELECT name FROM agents WHERE org_id=$1::uuid AND id<>$2::uuid AND status<>'terminated'").bind(ctx.org).bind(id).fetch_all(&mut **tx).await?;
        let key = slug(name);
        if !key.is_empty() && names.iter().any(|n| slug(n) == key) {
            return Err(http(
                409,
                format!("Agent shortname '{key}' is already in use in this organization"),
            ));
        }
    }
    let before = snapshot(row);
    patch["updatedAt"] = json!(now());
    let updated = update(tx, ctx.org, id, &patch).await?;
    {
        let after = snapshot(&updated);
        let changed = REVISION_FIELDS
            .iter()
            .filter(|k| before[k] != after[k])
            .copied()
            .collect::<Vec<_>>();
        if !changed.is_empty() {
            insert(tx,"agent_config_revisions",&json!({"orgId":ctx.org,"agentId":id,"createdByAgentId":ctx.agent(),"createdByUserId":ctx.user(),"source":"rollback","rolledBackFromRevisionId":ctx.request.revision_id.as_deref(),"changedKeys":changed,"beforeConfig":before,"afterConfig":after})).await?;
        }
    }
    activity(
        tx,
        ctx,
        "agent.config_rolled_back",
        id,
        Some(&json!({"revisionId":ctx.request.revision_id})),
    )
    .await?;
    reads::public_row(tx, updated, false, false).await
}
