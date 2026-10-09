use super::{common::*, redaction};
use serde_json::{Value, json};

pub(super) async fn public_row(
    tx: &mut Tx<'_>,
    mut row: Value,
    spend: bool,
    restricted: bool,
) -> Result<Value> {
    let id = text(&row, "id").to_owned();
    if spend {
        row["spentMonthlyCents"]=json!(sqlx::query_scalar::<_,i64>("SELECT coalesce(sum(cost_cents),0)::bigint FROM cost_events WHERE org_id=$1::uuid AND agent_id=$2::uuid AND occurred_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND occurred_at<(date_trunc('month',now() AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC'").bind(text(&row,"orgId")).bind(&id).fetch_one(&mut **tx).await?);
    }
    row["permissions"] = permissions(&row["permissions"]);
    row["shortRef"] = json!(format!(
        "agt_{}",
        id.replace('-', "").chars().take(8).collect::<String>()
    ));
    let slug = slug(text(&row, "name"));
    row["urlKey"] = json!(if slug.is_empty() { id } else { slug });
    row.as_object_mut()
        .expect("agent row")
        .remove("workspaceKey");
    for key in ["agentRuntimeConfig", "runtimeConfig"] {
        row[key] = if restricted {
            json!({})
        } else {
            redaction::config(&row[key])
        };
    }
    Ok(row)
}
pub(super) fn configuration(row: &Value) -> Value {
    let mut result = serde_json::Map::new();
    for key in [
        "id",
        "orgId",
        "name",
        "role",
        "title",
        "status",
        "agentRuntimeType",
        "agentRuntimeConfig",
        "runtimeConfig",
        "permissions",
        "updatedAt",
    ] {
        result.insert(key.into(), row[key].clone());
    }
    Value::Object(result)
}
pub(super) fn workspace_key(row: &Value) -> String {
    let existing = js_trim(text(row, "workspaceKey"));
    if !existing.is_empty() {
        return existing.to_owned();
    }
    let slug = slug(text(row, "name"));
    format!(
        "{}--{}",
        if slug.is_empty() { "agent" } else { &slug },
        text(row, "id")
            .replace('-', "")
            .chars()
            .take(8)
            .collect::<String>()
    )
}
pub(super) async fn ensure_workspace_key(
    tx: &mut Tx<'_>,
    ctx: &Context<'_>,
    row: Value,
) -> Result<Value> {
    // The legacy service persists a derived key only for SQL NULL. Blank
    // stored strings are returned unchanged by its conditional UPDATE.
    if !row["workspaceKey"].is_null() {
        return Ok(row);
    }
    let rows = sqlx::query_scalar::<_, String>(
        "SELECT to_jsonb(a)::text FROM agents a WHERE org_id=$1::uuid ORDER BY id FOR UPDATE",
    )
    .bind(ctx.org)
    .fetch_all(&mut **tx)
    .await?;
    let mut keys = std::collections::BTreeSet::new();
    for raw in rows {
        let agent = decode(&raw)?;
        if agent["id"] == row["id"] && !agent["workspaceKey"].is_null() {
            return Ok(agent);
        }
        if agent["id"] != row["id"] {
            keys.insert(js_trim(text(&agent, "workspaceKey")).to_owned());
        }
    }
    let root = std::path::Path::new(&ctx.request.organization_agents_root);
    let mut preferred = None;
    for field in [
        "instructionsRootPath",
        "instructionsFilePath",
        "agentsMdPath",
    ] {
        let raw = js_trim(text(&row["agentRuntimeConfig"], field));
        if raw.is_empty() || ctx.request.organization_agents_root.is_empty() {
            continue;
        }
        let raw = if let Some(tail) = raw.strip_prefix("~/") {
            std::path::Path::new(&ctx.request.home_directory).join(tail)
        } else {
            std::path::PathBuf::from(raw)
        };
        let raw = if raw.is_absolute() {
            raw
        } else {
            std::path::Path::new(&ctx.request.process_working_directory).join(raw)
        };
        let mut normalized = std::path::PathBuf::new();
        for component in raw.components() {
            match component {
                std::path::Component::ParentDir => {
                    normalized.pop();
                }
                std::path::Component::CurDir => {}
                component => normalized.push(component.as_os_str()),
            }
        }
        if let Ok(relative) = normalized.strip_prefix(root) {
            let parts = relative
                .iter()
                .filter_map(|p| p.to_str())
                .collect::<Vec<_>>();
            if let Some(index) = parts.iter().position(|p| *p == "instructions")
                && index > 0
            {
                preferred = Some(js_trim(parts[index - 1]).to_owned());
                break;
            }
        }
    }
    let key = if let Some(key) = preferred.filter(|k| !k.is_empty() && !keys.contains(k)) {
        key
    } else {
        let base = workspace_key(&row);
        let id = text(&row, "id").replace('-', "");
        let name = slug(text(&row, "name"));
        let name = if name.is_empty() { "agent" } else { &name };
        let mut key = base;
        for length in (8..=id.len()).step_by(4) {
            key = format!("{name}--{}", &id[..length]);
            if !keys.contains(&key) {
                break;
            }
        }
        if keys.contains(&key) {
            return Err(http(
                500,
                "Unable to allocate unique workspace key for agent",
            ));
        }
        key
    };
    update(
        tx,
        ctx.org,
        text(&row, "id"),
        &json!({"workspaceKey":key,"updatedAt":now()}),
    )
    .await
}
pub(super) async fn list(tx: &mut Tx<'_>, ctx: &Context<'_>, configs: bool) -> Result<Value> {
    if configs {
        require_configs(tx, ctx).await?;
    }
    let rows = sqlx::query_scalar::<_, String>(
        "SELECT to_jsonb(a)::text FROM agents a WHERE org_id=$1::uuid AND status<>'terminated'",
    )
    .bind(ctx.org)
    .fetch_all(&mut **tx)
    .await?;
    let restricted = ctx.agent().is_some() && !can_read_configs(tx, ctx).await?;
    let mut output = Vec::new();
    for raw in rows {
        let row = decode(&raw)?;
        if hidden(&row) {
            continue;
        }
        let row = public_row(tx, row, true, restricted).await?;
        output.push(if configs { configuration(&row) } else { row });
    }
    Ok(json!(output))
}
pub(super) async fn revisions(
    tx: &mut Tx<'_>,
    ctx: &Context<'_>,
    id: &str,
    revision: Option<&str>,
) -> Result<Value> {
    require_configs(tx, ctx).await?;
    let rows=sqlx::query_scalar::<_,String>("SELECT to_jsonb(r)::text FROM agent_config_revisions r WHERE org_id=$1::uuid AND agent_id=$2::uuid AND ($3::uuid IS NULL OR id=$3::uuid) ORDER BY created_at DESC").bind(ctx.org).bind(id).bind(revision).fetch_all(&mut **tx).await?;
    let mut output = Vec::new();
    for raw in rows {
        let mut row = decode(&raw)?;
        for key in ["beforeConfig", "afterConfig"] {
            if !row[key].is_object() {
                row[key] = json!({});
                continue;
            }
            let mut snapshot = row[key].clone();
            for f in ["agentRuntimeConfig", "runtimeConfig"] {
                snapshot[f] =
                    redaction::sanitize(if snapshot[f].is_object() || snapshot[f].is_array() {
                        &snapshot[f]
                    } else {
                        &Value::Null
                    });
                if snapshot[f].is_null() {
                    snapshot[f] = json!({});
                }
            }
            snapshot["metadata"] =
                redaction::sanitize(snapshot.get("metadata").unwrap_or(&Value::Null));
            row[key] = snapshot;
        }
        output.push(row);
    }
    if revision.is_some() {
        output
            .into_iter()
            .next()
            .ok_or_else(|| http(404, "Revision not found"))
    } else {
        Ok(json!(output))
    }
}
pub(super) async fn ensure_state(
    tx: &mut Tx<'_>,
    ctx: &Context<'_>,
    agent: &Value,
) -> Result<Value> {
    sqlx::query("INSERT INTO agent_runtime_state(org_id,agent_id,agent_runtime_type) VALUES($1::uuid,$2::uuid,$3) ON CONFLICT(agent_id) DO NOTHING").bind(ctx.org).bind(text(agent,"id")).bind(text(agent,"agentRuntimeType")).execute(&mut **tx).await?;
    decode(&sqlx::query_scalar::<_,String>("SELECT to_jsonb(s)::text FROM agent_runtime_state s WHERE org_id=$1::uuid AND agent_id=$2::uuid").bind(ctx.org).bind(text(agent,"id")).fetch_one(&mut **tx).await?)
}
pub(super) async fn task_sessions(
    tx: &mut Tx<'_>,
    ctx: &Context<'_>,
    id: &str,
    latest: bool,
) -> Result<Vec<Value>> {
    let visibility = crate::run_visibility::predicate("r", 3);
    let sql = format!(
        "SELECT to_jsonb(s)::text FROM agent_task_sessions s WHERE s.org_id=$1::uuid AND s.agent_id=$2::uuid AND (s.last_run_id IS NULL OR EXISTS(SELECT 1 FROM heartbeat_runs r WHERE r.org_id=s.org_id AND r.id=s.last_run_id AND ({visibility}))) ORDER BY s.updated_at DESC,s.created_at DESC{}",
        if latest { " LIMIT 1" } else { "" }
    );
    sqlx::query_scalar::<_, String>(&sql)
        .bind(ctx.org)
        .bind(id)
        .bind(ctx.user())
        .fetch_all(&mut **tx)
        .await?
        .iter()
        .map(|raw| {
            let mut row = decode(raw)?;
            if !latest {
                row["sessionParamsJson"] = redaction::sanitize(&row["sessionParamsJson"]);
            }
            Ok(row)
        })
        .collect()
}
pub(super) async fn runtime_state(
    tx: &mut Tx<'_>,
    ctx: &Context<'_>,
    agent: &Value,
) -> Result<Value> {
    let mut row = ensure_state(tx, ctx, agent).await?;
    protect_runtime_state(tx, ctx, &mut row).await?;
    let latest = task_sessions(tx, ctx, text(agent, "id"), true)
        .await?
        .into_iter()
        .next();
    row["sessionDisplayId"] = latest
        .as_ref()
        .map(|s| s["sessionDisplayId"].clone())
        .filter(|v| !v.is_null())
        .unwrap_or_else(|| row["sessionId"].clone());
    row["sessionParamsJson"] = latest
        .as_ref()
        .map(|s| s["sessionParamsJson"].clone())
        .unwrap_or(Value::Null);
    Ok(row)
}
pub(super) async fn protect_runtime_state(
    tx: &mut Tx<'_>,
    ctx: &Context<'_>,
    row: &mut Value,
) -> Result<()> {
    if let Some(run) = row["lastRunId"].as_str() {
        let predicate = crate::run_visibility::predicate("r", 3);
        let sql = format!(
            "SELECT EXISTS(SELECT 1 FROM heartbeat_runs r WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND ({predicate}))"
        );
        let visible = sqlx::query_scalar::<_, bool>(&sql)
            .bind(ctx.org)
            .bind(run)
            .bind(ctx.user())
            .fetch_one(&mut **tx)
            .await?;
        if !visible {
            for key in ["lastRunId", "lastRunStatus", "lastError", "sessionId"] {
                row[key] = Value::Null;
            }
            row["stateJson"] = json!({});
        }
    }
    Ok(())
}
pub(super) fn boolean_like(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(b) => Some(*b),
        Value::Number(n) if n.as_f64() == Some(1.0) => Some(true),
        Value::Number(n) if n.as_f64() == Some(0.0) => Some(false),
        Value::String(s) => match js_trim(s).to_lowercase().as_str() {
            "true" | "1" | "yes" | "on" => Some(true),
            "false" | "0" | "no" | "off" => Some(false),
            _ => None,
        },
        _ => None,
    }
}
fn radix_number(digits: &str, radix: u32) -> Option<f64> {
    if digits.is_empty() {
        return None;
    }
    // All accepted radices are powers of two. Keep the first 53 significant
    // bits and round once, ties to even, as JavaScript Number does. Repeated
    // floating-point multiplication would round a long integer multiple times.
    let width = radix.ilog2();
    let mut significant = 0_usize;
    let mut mantissa = 0_u64;
    let mut guard = false;
    let mut sticky = false;
    for digit in digits.chars() {
        let digit = digit.to_digit(radix)?;
        for shift in (0..width).rev() {
            let bit = (digit >> shift) & 1;
            if significant == 0 && bit == 0 {
                continue;
            }
            significant += 1;
            match significant {
                1..=53 => mantissa = (mantissa << 1) | u64::from(bit),
                54 => guard = bit != 0,
                _ => sticky |= bit != 0,
            }
        }
    }
    if significant > 1024 {
        return None;
    }
    if guard && (sticky || mantissa & 1 != 0) {
        mantissa += 1;
    }
    Some((mantissa as f64) * 2_f64.powi(significant.saturating_sub(53) as i32))
}
fn number_like(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => {
            let s = js_trim(s);
            if s.is_empty() {
                Some(0.0)
            } else if let Some((digits, radix)) = [
                ("0x", 16),
                ("0X", 16),
                ("0b", 2),
                ("0B", 2),
                ("0o", 8),
                ("0O", 8),
            ]
            .iter()
            .find_map(|(prefix, radix)| s.strip_prefix(prefix).map(|digits| (digits, *radix)))
            {
                radix_number(digits, radix)
            } else {
                s.parse::<f64>().ok()
            }
        }
        _ => None,
    }
    .filter(|n| n.is_finite())
}
pub(super) async fn scheduler(tx: &mut Tx<'_>, ctx: &Context<'_>) -> Result<Value> {
    authorize_user(tx, ctx).await?;
    if !ctx.local() && !ctx.admin {
        return Err(http(403, "Instance admin access required"));
    }
    let rows=sqlx::query_scalar::<_,String>("SELECT (to_jsonb(a)||jsonb_build_object('organization_name',o.name,'organization_issue_prefix',o.issue_prefix))::text FROM agents a JOIN organizations o ON o.id=a.org_id WHERE a.status NOT IN ('paused','terminated','pending_approval') ORDER BY o.name,a.name").fetch_all(&mut **tx).await?;
    let mut output = Vec::new();
    for raw in rows {
        let row = decode(&raw)?;
        if hidden(&row) {
            continue;
        }
        let heartbeat = &row["runtimeConfig"]["heartbeat"];
        let enabled = boolean_like(&heartbeat["enabled"]).unwrap_or(true);
        let interval = number_like(&heartbeat["intervalSec"])
            .unwrap_or(0.0)
            .max(0.0);
        let url_key = {
            let v = slug(text(&row, "name"));
            if v.is_empty() {
                text(&row, "id").to_owned()
            } else {
                v
            }
        };
        output.push(json!({"id":row["id"],"orgId":row["orgId"],"organizationName":row["organizationName"],"organizationIssuePrefix":row["organizationIssuePrefix"],"agentName":row["name"],"agentUrlKey":url_key,"role":row["role"],"title":row["title"],"status":row["status"],"agentRuntimeType":row["agentRuntimeType"],"intervalSec":interval,"heartbeatEnabled":enabled,"schedulerActive":enabled&&interval>0.0,"lastHeartbeatAt":row["lastHeartbeatAt"]}));
    }
    let locale = ctx
        .request
        .canonical_locale
        .parse::<icu_locale_core::Locale>()
        .unwrap_or_else(|_| "en".parse().expect("constant locale"));
    let collator = icu_collator::Collator::try_new(
        locale.into(),
        icu_collator::options::CollatorOptions::default(),
    )
    .map_err(|_| http(500, "Internal server error"))?;
    output.sort_by(|a, b| {
        b["schedulerActive"]
            .as_bool()
            .cmp(&a["schedulerActive"].as_bool())
            .then_with(|| {
                collator.compare(text(a, "organizationName"), text(b, "organizationName"))
            })
            .then_with(|| collator.compare(text(a, "agentName"), text(b, "agentName")))
    });
    Ok(json!(output))
}
pub(super) async fn inbox(tx: &mut Tx<'_>, ctx: &Context<'_>) -> Result<Value> {
    let id = ctx
        .agent()
        .ok_or_else(|| http(401, "Agent authentication required"))?;
    let query = r#"SELECT to_jsonb(i)::text FROM issues i WHERE i.org_id=$1::uuid AND (
       (i.assignee_agent_id=$2::uuid AND i.status IN ('todo','in_progress','blocked')) OR
       (i.reviewer_agent_id=$2::uuid AND i.status IN ('in_review','blocked') AND NOT (
        i.status='blocked' AND EXISTS(SELECT 1 FROM activity_log confirmed WHERE confirmed.org_id=i.org_id AND confirmed.entity_type='issue' AND confirmed.entity_id=i.id::text
        AND confirmed.action='issue.review_decision_recorded' AND confirmed.actor_type='agent' AND confirmed.actor_id=$2::text AND confirmed.details->>'decision'='blocked'
        AND confirmed.created_at>=coalesce((SELECT max(material.created_at) FROM activity_log material WHERE material.org_id=i.org_id AND material.entity_type='issue' AND material.entity_id=i.id::text AND (
         (material.action='issue.updated' AND jsonb_typeof(material.details)='object' AND EXISTS(SELECT 1 FROM jsonb_object_keys(material.details) k WHERE k NOT IN ('description','title','identifier','issueIdentifier','_previous','_references','source','reopened','reopenedFrom','normalizedFromStatus','normalizedReason')))
         OR (material.action='issue.comment_added' AND NOT (material.actor_type='agent' AND material.actor_id=$2::text))
        )),to_timestamp(0)))))
      ) ORDER BY CASE i.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 9 END,i.updated_at ASC"#;
    let rows = sqlx::query_scalar::<_, String>(query)
        .bind(ctx.org)
        .bind(id)
        .fetch_all(&mut **tx)
        .await?;
    let mut output = Vec::new();
    for raw in rows {
        let row = decode(&raw)?;
        let reviewer =
            row["reviewerAgentId"] == id && matches!(text(&row, "status"), "in_review" | "blocked");
        // Re-evaluate reviewer exclusion when the assignee branch retained the row.
        let reviewer = if reviewer && row["status"] == "blocked" {
            let q=query.replace("(i.assignee_agent_id=$2::uuid AND i.status IN ('todo','in_progress','blocked')) OR", "false OR").replace("SELECT to_jsonb(i)::text", "SELECT i.id::text");
            sqlx::query_scalar::<_, String>(&q)
                .bind(ctx.org)
                .bind(id)
                .fetch_all(&mut **tx)
                .await?
                .contains(&text(&row, "id").to_owned())
        } else {
            reviewer
        };
        let visibility = crate::run_visibility::predicate("r", 3);
        let q = format!(
            "SELECT jsonb_build_object('id',r.id,'status',r.status,'agent_id',r.agent_id,'invocation_source',r.invocation_source,'trigger_detail',r.trigger_detail,'started_at',r.started_at,'finished_at',r.finished_at,'created_at',r.created_at)::text FROM heartbeat_runs r WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND (r.status IN ('queued','running') OR r.terminal_effects_pending) AND ({visibility})"
        );
        let active = sqlx::query_scalar::<_, String>(&q)
            .bind(ctx.org)
            .bind(row["executionRunId"].as_str())
            .bind(ctx.user())
            .fetch_optional(&mut **tx)
            .await?
            .map(|v| decode(&v))
            .transpose()?
            .unwrap_or(Value::Null);
        let mut item = json!({});
        for key in [
            "id",
            "identifier",
            "title",
            "status",
            "priority",
            "projectId",
            "goalId",
            "parentId",
            "updatedAt",
        ] {
            item[key] = row[key].clone();
        }
        item["relationship"] = json!(if reviewer { "reviewer" } else { "assignee" });
        item["activeRun"] = active;
        output.push(item);
    }
    Ok(json!(output))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scheduler_numbers_use_one_correctly_rounded_conversion() {
        for (input, expected) in [
            (
                "0x2aa8dc666f6f8d84d9215056a88a2352207464bf9252285a",
                Some(1.0460106681225364e57),
            ),
            ("0x20000000000001", Some(9007199254740992.0)),
            ("0x20000000000003", Some(9007199254740996.0)),
            ("0b111100", Some(60.0)),
            ("0o74", Some(60.0)),
            ("0x", None),
            ("0b2", None),
            ("\u{feff} 60 \u{feff}", Some(60.0)),
            ("\u{0085}60", None),
        ] {
            assert_eq!(number_like(&json!(input)), expected, "{input}");
        }
        assert_eq!(number_like(&json!(format!("0x{}", "f".repeat(256)))), None);
    }
}
