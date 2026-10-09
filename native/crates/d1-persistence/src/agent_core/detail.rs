//! Complete Agent access and capability projections from persisted authority.
use super::{common::*, reads};
use serde_json::{Value, json};

async fn access(tx: &mut Tx<'_>, row: &Value) -> Result<Value> {
    let org = text(row, "orgId");
    let id = text(row, "id");
    let membership = sqlx::query_scalar::<_, String>("SELECT to_jsonb(m)::text FROM organization_memberships m WHERE org_id=$1::uuid AND principal_type='agent' AND principal_id=$2")
        .bind(org).bind(id).fetch_optional(&mut **tx).await?.map(|raw|decode(&raw)).transpose()?.unwrap_or(Value::Null);
    let grants = if membership.is_null() {
        Vec::new()
    } else {
        sqlx::query_scalar::<_,String>("SELECT to_jsonb(g)::text FROM principal_permission_grants g WHERE org_id=$1::uuid AND principal_type='agent' AND principal_id=$2 ORDER BY permission_key")
            .bind(org).bind(id).fetch_all(&mut **tx).await?.iter().map(|raw|decode(raw)).collect::<Result<Vec<_>>>()?
    };
    // This response reports the legacy Agent access projection, including
    // suspended memberships. Effective request admission separately requires
    // an active principal and credential in common::authorize_org.
    let source = if text(row, "role") == "ceo" {
        "ceo_role"
    } else if can_create(row) {
        "agent_creator"
    } else if grants
        .iter()
        .any(|grant| grant["permissionKey"] == "tasks:assign")
    {
        "explicit_grant"
    } else {
        "none"
    };
    Ok(
        json!({"canAssignTasks":source!="none","taskAssignSource":source,"membership":membership,"grants":grants}),
    )
}

async fn integrations(tx: &mut Tx<'_>, org: &str, id: &str) -> Result<Value> {
    let rows = sqlx::query_scalar::<_,String>("SELECT to_jsonb(i)::text FROM agent_integrations i WHERE org_id=$1::uuid AND agent_id=$2::uuid ORDER BY updated_at DESC")
        .bind(org).bind(id).fetch_all(&mut **tx).await?;
    let mut output = Vec::new();
    for raw in rows {
        let mut row = decode(&raw)?;
        let secret = row
            .as_object_mut()
            .expect("integration row")
            .remove("appCredentialSecretId");
        row["hasCredentialSecret"] = json!(
            secret
                .as_ref()
                .is_some_and(|value| value.as_str().is_some_and(|s| !s.is_empty()))
        );
        row["settings"] = super::validation::integration_settings(&row["settings"])?;
        output.push(row);
    }
    Ok(json!(output))
}

fn browser_enabled(value: &Value) -> bool {
    // instanceBrowserSettingsSchema is strict. Any invalid property makes the
    // entire persisted object fall back to enabled=true, as the Node service.
    let Some(object) = value.as_object() else {
        return true;
    };
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "enabled" | "openLinksIn"))
        || object.get("enabled").is_some_and(|v| !v.is_boolean())
        || object
            .get("openLinksIn")
            .is_some_and(|v| !matches!(v.as_str(), Some("built_in" | "default_browser")))
    {
        return true;
    }
    object
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

async fn tools(tx: &mut Tx<'_>, ctx: &Context<'_>, row: &Value) -> Result<Value> {
    sqlx::query("INSERT INTO instance_settings(singleton_key,browser,general,notifications) VALUES('default','{}','{}','{}') ON CONFLICT(singleton_key) DO NOTHING")
        .execute(&mut **tx).await?;
    let raw = sqlx::query_scalar::<_, String>(
        "SELECT browser::text FROM instance_settings WHERE singleton_key='default'",
    )
    .fetch_one(&mut **tx)
    .await?;
    let settings =
        super::json_boundary::parse(&raw).map_err(|_| http(500, "Internal server error"))?;
    let available = ctx.request.deployment_mode == "local_trusted"
        && browser_enabled(&settings)
        && matches!(
            text(row, "agentRuntimeType"),
            "claude_local" | "codex_local" | "opencode_local" | "pi_local"
        );
    let names: Vec<String> =
        serde_json::from_str(include_str!("detail-tools.json")).expect("tool constants");
    let (browser, core): (Vec<_>, Vec<_>) = names
        .into_iter()
        .partition(|name| name.starts_with("rudder_browser_"));
    let browser = if available { browser } else { Vec::new() };
    Ok(json!([
        {"id":"rudder-tools","displayName":"Rudder MCP tools","kind":"rudder_mcp","status":"available","scope":"runtime","serverName":"rudder-tools","contract":"agent-v1","toolCount":core.len(),"tools":core,"authMode":"runtime_managed","cliFallbackAvailable":true},
        {"id":"rudder-browser","displayName":"Rudder Browser","kind":"rudder_browser_mcp","status":if available{"available"}else{"disabled"},"scope":"runtime","serverName":"rudder-browser","contract":"browser-v1","toolCount":browser.len(),"tools":browser,"authMode":"runtime_managed","cliFallbackAvailable":false}
    ]))
}

pub(super) async fn build(
    tx: &mut Tx<'_>,
    ctx: &Context<'_>,
    mut row: Value,
    restricted: bool,
) -> Result<Value> {
    let access = access(tx, &row).await?;
    let integrations = if restricted {
        Value::Null
    } else {
        integrations(tx, ctx.org, text(&row, "id")).await?
    };
    let tools = if restricted {
        Value::Null
    } else {
        tools(tx, ctx, &row).await?
    };
    let library = if restricted {
        Value::Null
    } else {
        super::instructions::library_path(tx, ctx, &row).await?
    };
    // buildAgentDetail uses redactEventPayload(value ?? {}) ?? {}; its falsy
    // primitive inputs become an empty configuration, while other opaque JSON
    // roots retain their original values. Keep this specific to these routes.
    for field in ["agentRuntimeConfig", "runtimeConfig"] {
        let value = &row[field];
        if value.is_null()
            || value == &Value::Bool(false)
            || value.as_f64() == Some(0.0)
            || value.as_str() == Some("")
        {
            row[field] = json!({});
        }
    }
    let mut output = reads::public_row(tx, row, true, restricted).await?;
    output["access"] = access;
    output["instructionsLibraryPath"] = library;
    if !restricted {
        output["integrations"] = integrations;
        output["rudderTools"] = tools;
    }
    Ok(output)
}

/// Caller holds organization Agent rows and the mutation fence. Admission is
/// rechecked after those locks, including current CEO role and API key state.
pub(super) async fn update_permissions(
    tx: &mut Tx<'_>,
    ctx: &Context<'_>,
    row: &Value,
    input: &Value,
) -> Result<Value> {
    if let Some(actor) = ctx.agent() {
        let actor = stored(tx, actor)
            .await?
            .ok_or_else(|| http(403, "Forbidden"))?;
        if text(&actor, "orgId") != ctx.org {
            return Err(http(403, "Forbidden"));
        }
        if text(&actor, "role") != "ceo" {
            return Err(http(403, "Only CEO can manage permissions"));
        }
    }
    let id = text(row, "id");
    let mut next = permissions(&row["permissions"]);
    next["canCreateAgents"] = input["canCreateAgents"].clone();
    if let Some(value) = input.get("canManageSkills") {
        next["canManageSkills"] = value.clone();
    }
    let row = update(
        tx,
        ctx.org,
        id,
        &json!({"permissions":next,"updatedAt":now()}),
    )
    .await?;
    let assign = text(&row, "role") == "ceo"
        || row["permissions"]["canCreateAgents"] == true
        || input["canAssignTasks"] == true;
    sqlx::query("INSERT INTO organization_memberships(org_id,principal_type,principal_id,membership_role,status) VALUES($1::uuid,'agent',$2,'member','active') ON CONFLICT(org_id,principal_type,principal_id) DO UPDATE SET membership_role='member',status='active',updated_at=now() WHERE organization_memberships.membership_role IS DISTINCT FROM 'member' OR organization_memberships.status<>'active'")
        .bind(ctx.org).bind(id).execute(&mut **tx).await?;
    if assign {
        sqlx::query("INSERT INTO principal_permission_grants(org_id,principal_type,principal_id,permission_key,scope,granted_by_user_id) VALUES($1::uuid,'agent',$2,'tasks:assign',NULL,$3) ON CONFLICT(org_id,principal_type,principal_id,permission_key) DO UPDATE SET scope=NULL,granted_by_user_id=excluded.granted_by_user_id,updated_at=now()")
            .bind(ctx.org).bind(id).bind(ctx.user()).execute(&mut **tx).await?;
    } else {
        sqlx::query("DELETE FROM principal_permission_grants WHERE org_id=$1::uuid AND principal_type='agent' AND principal_id=$2 AND permission_key='tasks:assign'")
            .bind(ctx.org).bind(id).execute(&mut **tx).await?;
    }
    activity(tx,ctx,"agent.permissions_updated",id,Some(&json!({"canCreateAgents":next["canCreateAgents"],"canManageSkills":next["canManageSkills"],"canAssignTasks":assign}))).await?;
    build(tx, ctx, row, false).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_defaults_and_tool_names_match_public_shared_source() {
        let corpus: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/agent-detail-zod-boundary.json"
        ))
        .unwrap();
        for case in corpus["browser"].as_array().unwrap() {
            assert_eq!(
                json!(browser_enabled(&case["input"])),
                case["enabled"],
                "{}",
                case["input"]
            );
        }
        assert_eq!(
            serde_json::from_str::<Value>(include_str!("detail-tools.json")).unwrap(),
            corpus["tools"]
        );
    }
}
