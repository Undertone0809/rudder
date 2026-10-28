//! Native managed MCP runtime authority. Every request intersects the frozen
//! Run policy with current binding/connection/tool state; outbound I/O stays in
//! Foundation and can begin only after this module records dispatch-start.
use crate::activity::{ActivityActor, write_activity};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::collections::BTreeSet;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Managed MCP request is not authorized")]
    Denied,
    #[error("Managed MCP runtime failed ({0})")]
    Runtime(&'static str),
    #[error("Managed MCP database operation failed")]
    Database(#[from] sqlx::Error),
}
pub struct Identity {
    pub organization_id: String,
    pub agent_id: String,
    pub run_id: String,
}

/// Config/secret references are trusted persisted facts, never client options.
/// No Serialize/Debug because subsequent credential material must stay private.
pub struct Access {
    pub binding_id: String,
    pub connection_id: String,
    pub provider: String,
    pub transport: String,
    pub connection_access: String,
    pub run_access: String,
    current_access: String,
    pub external_scope: Option<String>,
    pub safe_config: Value,
    pub startup_timeout_ms: u64,
    pub tool_timeout_ms: u64,
    credential_secret_id: Option<String>,
    allowed_names: BTreeSet<String>,
    enabled_ids: BTreeSet<String>,
}
pub struct PreparedCall {
    pub access: Access,
    pub external_tool_name: String,
    audit_id: String,
    identity: Identity,
}
pub struct OAuthCredential {
    pub grant_id: String,
    pub secret_id: String,
    pub latest_version: i32,
    pub material: Value,
    pub status_metadata: Value,
    pub authorizing_user_id: Option<String>,
}
pub struct Credentials {
    pub connection: Value,
    pub oauth: Option<OAuthCredential>,
}
pub struct RefreshLease {
    pub credential: OAuthCredential,
    pub nonce: String,
    pub timeout_ms: u64,
    pub authorization: Value,
    connection_id: String,
    organization_id: String,
}
pub enum RefreshClaim {
    Changed,
    Busy { wait_ms: u64, timeout_ms: u64 },
    Owned(Box<RefreshLease>),
}
pub enum RefreshOutcome<'a> {
    Success(&'a Value),
    InvalidGrant,
    Failed,
}
fn authorization_snapshot(connection: &Value, status: &Value) -> Result<Value, Error> {
    let saved = &status["authorization"];
    if txt(saved, "serverUrl").is_some_and(|v| !v.is_empty())
        && saved["accessMode"].is_string()
        && saved.get("scope").is_none_or(Value::is_string)
    {
        return Ok(saved.clone());
    }
    let mode = txt(connection, "access_mode").unwrap_or("provider_default");
    let provider = txt(connection, "provider").unwrap_or("");
    let mut url = url::Url::parse(match provider {
        "supabase" => "https://mcp.supabase.com/mcp",
        "linear" if mode == "read_only" => "https://mcp.linear.app/mcp/readonly",
        "linear" => "https://mcp.linear.app/mcp",
        "notion" => "https://mcp.notion.com/mcp",
        _ => return Err(Error::Denied),
    })
    .map_err(|_| Error::Denied)?;
    if provider == "supabase" {
        let mut query = url.query_pairs_mut();
        query.append_pair(
            "read_only",
            if mode == "read_only" { "true" } else { "false" },
        );
        if let Some(scope) = txt(connection, "external_scope") {
            query.append_pair("project_ref", scope);
        }
    }
    let mut value = json!({"serverUrl":url.as_str(),"accessMode":mode});
    if provider == "linear" && mode == "read_only" {
        value["scope"] = json!("read");
    }
    Ok(value)
}

fn txt<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value[key].as_str()
}
fn id(value: &str) -> Result<String, Error> {
    uuid::Uuid::parse_str(value)
        .map(|id| id.to_string())
        .map_err(|_| Error::Denied)
}
fn strings(value: &Value) -> BTreeSet<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}
fn effective_access(binding: &str, provider: &str, organization: &str) -> String {
    match (binding, provider, organization) {
        ("none", _, _) => "none",
        ("full", "custom", _) => "full",
        (_, "custom", _) => "none",
        ("provider_granted", "notion", _) => "provider_granted",
        (_, "notion", _) => "none",
        (_, _, "read_only") => "read_only",
        ("read_only", _, _) => "read_only",
        (binding, _, _) => binding,
    }
    .into()
}
fn intersect(current: &str, snapshot: &str) -> String {
    if current == "none" || snapshot == "none" {
        "none".into()
    } else if current == snapshot {
        current.into()
    } else if ["read_only", "read_write"].contains(&current)
        && ["read_only", "read_write"].contains(&snapshot)
    {
        "read_only".into()
    } else {
        "none".into()
    }
}
fn allowed(access: &Access, tool: &Value) -> bool {
    access.enabled_ids.contains(txt(tool, "id").unwrap_or(""))
        && access
            .allowed_names
            .contains(txt(tool, "rudder_tool_name").unwrap_or(""))
        && txt(tool, "status") == Some("active")
        && tool["enabled"] == true
        && tool["removed_at"].is_null()
        && capability_allowed(
            &access.current_access,
            txt(tool, "capability_class").unwrap_or("unknown"),
        )
}
fn capability_allowed(access: &str, class: &str) -> bool {
    match access {
        "full" => true,
        "none" => false,
        _ => {
            class == "read"
                || class == "normal_write" && ["read_write", "provider_granted"].contains(&access)
        }
    }
}

fn server_name(name: &str) -> String {
    let mut value = String::new();
    let mut separating = false;
    for ch in name.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || "_.-".contains(ch) {
            value.push(ch);
            separating = false;
        } else if !separating {
            value.push('-');
            separating = true;
        }
    }
    let value = value.trim_matches('-');
    let value = if value.is_empty() { "tool" } else { value };
    if value.len() <= 56 {
        return value.into();
    }
    let hash = Sha256::digest(value.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    format!("{}-{}", &value[..47], &hash[..8])
}
/// Native equivalent of resolveAgentRuntimeBindings. These provider-neutral
/// descriptors become the Run's frozen policy snapshot; no credentials or
/// upstream addresses are exposed to the Agent. Plugin disable and per-Agent
/// official-provider shadowing match the existing binding resolver.
pub async fn resolve_runtime_bindings(
    pool: &PgPool,
    organization_id: &str,
    agent_id: &str,
) -> Result<Vec<Value>, Error> {
    let org = id(organization_id)?;
    let agent = id(agent_id)?;
    let mut tx = pool.begin().await?;
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM agents WHERE org_id=$1::uuid AND id=$2::uuid)",
    )
    .bind(&org)
    .bind(&agent)
    .fetch_one(&mut *tx)
    .await?;
    if !exists {
        return Err(Error::Denied);
    }
    let rows=sqlx::query("SELECT to_jsonb(b) AS binding,to_jsonb(c) AS connection FROM agent_custom_integration_bindings b JOIN mcp_connections c ON c.id=b.connection_id AND c.org_id=b.org_id WHERE b.org_id=$1::uuid AND b.agent_id=$2::uuid AND b.status='active' AND (c.scope='organization' OR (c.scope='agent' AND c.owner_agent_id=$2::uuid)) AND (c.provider='custom' OR c.canonical_state='canonical') AND NOT EXISTS(SELECT 1 FROM plugin_component_links l JOIN installed_plugins p ON p.id=l.installed_plugin_id WHERE l.org_id=$1::uuid AND l.component_type='mcp' AND l.target_id=c.id AND (NOT p.enabled OR p.lifecycle_state<>'installed' OR l.status='disabled')) AND NOT(c.scope='organization' AND c.provider<>'custom' AND EXISTS(SELECT 1 FROM mcp_connections shadow WHERE shadow.org_id=$1::uuid AND shadow.scope='agent' AND shadow.owner_agent_id=$2::uuid AND shadow.canonical_state='canonical' AND shadow.status NOT IN ('disabled','revoked') AND shadow.provider=c.provider AND shadow.provider IN ('supabase','linear','notion','github'))) ORDER BY c.name")
        .bind(&org).bind(&agent).fetch_all(&mut *tx).await?;
    let connection_ids = rows
        .iter()
        .filter_map(|row| {
            row.try_get::<Value, _>("connection")
                .ok()
                .and_then(|v| txt(&v, "id").map(str::to_owned))
        })
        .collect::<Vec<_>>();
    let tools=sqlx::query_scalar::<_,Value>("SELECT to_jsonb(t) FROM custom_integration_tools t WHERE org_id=$1::uuid AND connection_id::text=ANY($2::text[])").bind(&org).bind(&connection_ids).fetch_all(&mut *tx).await?;
    let grants=sqlx::query_scalar::<_,Value>("SELECT to_jsonb(g) FROM mcp_oauth_grants g WHERE org_id=$1::uuid AND connection_id::text=ANY($2::text[]) AND status='active' AND credential_secret_id IS NOT NULL").bind(&org).bind(&connection_ids).fetch_all(&mut *tx).await?;
    let mut output = Vec::new();
    for row in rows {
        let binding: Value = row.try_get("binding")?;
        let connection: Value = row.try_get("connection")?;
        let connection_id = txt(&connection, "id").ok_or(Error::Denied)?;
        let provider = txt(&connection, "provider").unwrap_or("");
        let access = effective_access(
            txt(&binding, "access_mode").unwrap_or("none"),
            provider,
            txt(&connection, "access_mode").unwrap_or("provider_default"),
        );
        if access == "none"
            || connection["status"] != "active"
            || connection["enabled"] != true
            || connection["transport"] == "legacy_manual"
        {
            continue;
        }
        if provider == "github" && txt(&connection, "credential_secret_id").is_none() {
            continue;
        }
        if !["custom", "github"].contains(&provider)
            && !grants
                .iter()
                .any(|g| txt(g, "connection_id") == Some(connection_id))
        {
            continue;
        }
        let enabled = strings(&binding["enabled_tool_ids"]);
        let mut names = tools
            .iter()
            .filter(|tool| {
                txt(tool, "connection_id") == Some(connection_id)
                    && enabled.contains(txt(tool, "id").unwrap_or(""))
                    && tool["status"] == "active"
                    && tool["enabled"] == true
                    && tool["removed_at"].is_null()
                    && capability_allowed(
                        &access,
                        txt(tool, "capability_class").unwrap_or("unknown"),
                    )
            })
            .filter_map(|tool| txt(tool, "rudder_tool_name"))
            .collect::<Vec<_>>();
        names.sort();
        output.push(json!({"bindingId":binding["id"],"serverName":server_name(txt(&connection,"name").unwrap_or("tool")),"accessMode":access,"toolPolicy":{"mode":"allowlist","allowedToolNames":names},"required":connection["required"],"startupTimeoutMs":connection["startup_timeout_ms"],"toolTimeoutMs":connection["tool_timeout_ms"]}));
    }
    tx.commit().await?;
    Ok(output)
}

async fn runtime_access(
    tx: &mut Transaction<'_, Postgres>,
    identity: &Identity,
    binding_id: &str,
    local_trusted: bool,
    lock: bool,
) -> Result<Access, Error> {
    let org = id(&identity.organization_id)?;
    let agent = id(&identity.agent_id)?;
    let run = id(&identity.run_id)?;
    let binding_id = id(binding_id)?;
    let snapshot:Option<Value>=sqlx::query_scalar("SELECT context_snapshot FROM heartbeat_runs WHERE org_id=$1::uuid AND agent_id=$2::uuid AND id=$3::uuid AND status='running'")
        .bind(&org).bind(&agent).bind(&run).fetch_optional(&mut **tx).await?.flatten();
    let snapshot = snapshot.ok_or(Error::Denied)?;
    let sql = format!(
        "SELECT to_jsonb(b) AS binding,to_jsonb(c) AS connection FROM agent_custom_integration_bindings b JOIN mcp_connections c ON c.id=b.connection_id AND c.org_id=b.org_id WHERE b.id=$1::uuid AND b.org_id=$2::uuid AND b.agent_id=$3::uuid AND b.status='active' AND c.enabled AND c.status='active' AND (c.provider='custom' OR c.canonical_state='canonical'){}",
        if lock { " FOR SHARE OF c" } else { "" }
    );
    let row = sqlx::query(&sql)
        .bind(&binding_id)
        .bind(&org)
        .bind(&agent)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::Denied)?;
    let binding: Value = row.try_get("binding")?;
    let connection: Value = row.try_get("connection")?;
    let transport = txt(&connection, "transport").unwrap_or("");
    if !["stdio", "streamable_http"].contains(&transport) {
        return Err(Error::Denied);
    }
    let provider = txt(&connection, "provider").unwrap_or("");
    let connection_id = txt(&connection, "id").ok_or(Error::Denied)?;
    if !["custom", "github"].contains(&provider) {
        let _ = usable_grant(tx, &org, connection_id, local_trusted).await?;
    }
    let matches: Vec<_> = snapshot["managedMcpPolicySnapshot"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|value| txt(value, "bindingId") == Some(binding_id.as_str()))
        .collect();
    if matches.len() != 1 {
        return Err(Error::Denied);
    }
    let frozen = matches[0];
    let frozen_access = txt(frozen, "accessMode")
        .filter(|access| {
            [
                "none",
                "read_only",
                "read_write",
                "provider_granted",
                "full",
            ]
            .contains(access)
        })
        .ok_or(Error::Denied)?;
    let names = &frozen["toolPolicy"]["allowedToolNames"];
    if frozen["toolPolicy"]["mode"] != "allowlist"
        || !names
            .as_array()
            .is_some_and(|names| names.iter().all(Value::is_string))
    {
        return Err(Error::Denied);
    }
    let current = effective_access(
        txt(&binding, "access_mode").unwrap_or("none"),
        provider,
        txt(&connection, "access_mode").unwrap_or("provider_default"),
    );
    Ok(Access {
        binding_id,
        connection_id: connection_id.into(),
        provider: provider.into(),
        transport: transport.into(),
        connection_access: txt(&connection, "access_mode")
            .unwrap_or("provider_default")
            .into(),
        run_access: intersect(&current, frozen_access),
        current_access: current,
        external_scope: txt(&connection, "external_scope").map(str::to_owned),
        safe_config: connection["safe_config"].clone(),
        startup_timeout_ms: connection["startup_timeout_ms"].as_u64().unwrap_or(10000),
        tool_timeout_ms: connection["tool_timeout_ms"].as_u64().unwrap_or(60000),
        credential_secret_id: txt(&connection, "credential_secret_id").map(str::to_owned),
        allowed_names: strings(names),
        enabled_ids: strings(&binding["enabled_tool_ids"]),
    })
}

async fn commit_result<T>(
    tx: Transaction<'_, Postgres>,
    result: Result<T, Error>,
) -> Result<T, Error> {
    if matches!(result, Err(Error::Database(_))) {
        tx.rollback().await?;
    } else {
        tx.commit().await?;
    }
    result
}
pub async fn require_binding(
    pool: &PgPool,
    identity: &Identity,
    binding: &str,
    local_trusted: bool,
) -> Result<Access, Error> {
    let mut tx = pool.begin().await?;
    let result = runtime_access(&mut tx, identity, binding, local_trusted, true).await;
    commit_result(tx, result).await
}
pub async fn list_tools(
    pool: &PgPool,
    identity: &Identity,
    binding: &str,
    local_trusted: bool,
) -> Result<Vec<Value>, Error> {
    let mut tx = pool.begin().await?;
    let result=async {let access=runtime_access(&mut tx,identity,binding,local_trusted,true).await?;
        let rows=sqlx::query_scalar::<_,Value>("SELECT to_jsonb(t) FROM custom_integration_tools t WHERE org_id=$1::uuid AND connection_id=$2::uuid AND status='active' AND enabled ORDER BY rudder_tool_name")
            .bind(&identity.organization_id).bind(&access.connection_id).fetch_all(&mut *tx).await?;
        Ok(rows.into_iter().filter(|tool| allowed(&access, tool)).map(|tool| {
            let mut result=json!({"name":tool["rudder_tool_name"],"inputSchema":tool["input_schema"]});
            if let Some(value)=tool.get("description").filter(|value|!value.is_null()) {
                result["description"]=value.clone();
            }
            if let Some(value)=tool.get("output_schema").filter(|value|!value.is_null()) {
                result["outputSchema"]=value.clone();
            }
            result
        }).collect())
    }.await;
    commit_result(tx, result).await
}
pub async fn prepare_call(
    pool: &PgPool,
    identity: &Identity,
    binding: &str,
    name: &str,
    args: &Value,
    local_trusted: bool,
) -> Result<PreparedCall, Error> {
    if !args.is_object() {
        return Err(Error::Runtime("mcp_invalid_arguments"));
    }
    let mut tx = pool.begin().await?;
    let result=async {
        let initial=runtime_access(&mut tx,identity,binding,local_trusted,true).await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))").bind(format!("managed-mcp-binding:{}:{}:{}",identity.organization_id,identity.agent_id,initial.connection_id)).execute(&mut *tx).await?;
        let access=runtime_access(&mut tx,identity,binding,local_trusted,false).await?;
        let tool=sqlx::query_scalar::<_,Value>("SELECT to_jsonb(t) FROM custom_integration_tools t WHERE org_id=$1::uuid AND connection_id=$2::uuid AND rudder_tool_name=$3")
            .bind(&identity.organization_id).bind(&access.connection_id).bind(name).fetch_optional(&mut *tx).await?;
        if !tool.as_ref().is_some_and(|tool|allowed(&access,tool)){
            if let Some(tool)=&tool{
                sqlx::query("INSERT INTO custom_integration_tool_calls(org_id,connection_id,tool_id,agent_id,run_id,status,sanitized_input,redacted_dispatch_outcome,error_code,error_message,completed_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'blocked',$6::jsonb,'{\"status\":\"blocked\",\"errorCode\":\"mcp_tool_not_allowed\"}'::jsonb,'mcp_tool_not_allowed','Managed MCP tool is not enabled for this run',statement_timestamp())")
                    .bind(&identity.organization_id).bind(&access.connection_id).bind(txt(tool,"id")).bind(&identity.agent_id).bind(&identity.run_id).bind(redact_audit(args)).execute(&mut *tx).await?;
            }else{
                let hash=Sha256::digest(name.as_bytes()).iter().map(|byte|format!("{byte:02x}")).collect::<String>();
                write_activity(&mut tx,&identity.organization_id,&ActivityActor {actor_type:"agent",actor_id:identity.agent_id.clone(),run_id:Some(identity.run_id.clone())},"mcp_tool_call.blocked_unknown","mcp_agent_binding",&access.binding_id,Some(&json!({"reason":"unknown_tool","requestedToolSha256":hash}))).await?;
            }
            return Err(Error::Denied);
        }
        let tool=tool.expect("allowed persisted tool");
        let audit_id=sqlx::query_scalar::<_,String>("INSERT INTO custom_integration_tool_calls(org_id,connection_id,tool_id,agent_id,run_id,status,sanitized_input,redacted_dispatch_outcome) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'blocked',$6::jsonb,'{\"status\":\"started\"}'::jsonb) RETURNING id::text")
            .bind(&identity.organization_id).bind(&access.connection_id).bind(txt(&tool,"id")).bind(&identity.agent_id).bind(&identity.run_id).bind(redact_audit(args)).fetch_one(&mut *tx).await?;
        Ok(PreparedCall {access,external_tool_name:txt(&tool,"external_tool_name").ok_or(Error::Denied)?.into(),audit_id,identity:Identity{organization_id:identity.organization_id.clone(),agent_id:identity.agent_id.clone(),run_id:identity.run_id.clone()}})
    }.await;
    commit_result(tx, result).await
}
pub async fn finish_call(
    pool: &PgPool,
    call: &PreparedCall,
    result: Result<&Value, &str>,
) -> Result<(), Error> {
    let (status, value, outcome, code, message) = match result {
        Ok(value) => (
            "success",
            Some(redact_audit(value)),
            json!({"status":"success"}),
            None,
            None,
        ),
        Err(code) => (
            "error",
            None,
            json!({"status":"error","errorCode":code}),
            Some(code),
            Some(safe_error_message(code)),
        ),
    };
    sqlx::query("UPDATE custom_integration_tool_calls SET status=$4,sanitized_result=$5::jsonb,redacted_dispatch_outcome=$6::jsonb,error_code=$7,error_message=$8,completed_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND run_id=$3::uuid")
        .bind(&call.identity.organization_id).bind(&call.audit_id).bind(&call.identity.run_id).bind(status).bind(value).bind(outcome).bind(code).bind(message).execute(pool).await?;
    Ok(())
}
pub fn safe_error_message(code: &str) -> &'static str {
    match code {
        "mcp_tool_timeout" => "Managed MCP tool call timed out",
        "mcp_upstream_unauthorized" => "Managed MCP authorization was rejected",
        "mcp_upstream_rate_limited" => "Managed MCP upstream rate limit was reached",
        "mcp_result_too_large" => "Managed MCP tool result exceeds the output limit",
        _ => "Managed MCP tool call failed",
    }
}

async fn valid_authorizer(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    user: Option<&str>,
    local: bool,
) -> Result<bool, Error> {
    let Some(user) = user else {
        return Ok(local);
    };
    let member=sqlx::query("SELECT id FROM organization_memberships WHERE org_id=$1::uuid AND principal_type='user' AND principal_id=$2 AND status='active' AND membership_role='owner' FOR SHARE").bind(org).bind(user).fetch_optional(&mut **tx).await?;
    if member.is_some() {
        return Ok(true);
    }
    Ok(sqlx::query("SELECT user_id FROM instance_user_roles WHERE user_id=$1 AND role='instance_admin' FOR SHARE").bind(user).fetch_optional(&mut **tx).await?.is_some())
}
async fn usable_grant(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    connection: &str,
    local: bool,
) -> Result<Value, Error> {
    let grant=sqlx::query_scalar::<_,Value>("SELECT to_jsonb(g) FROM mcp_oauth_grants g WHERE org_id=$1::uuid AND connection_id=$2::uuid FOR UPDATE").bind(org).bind(connection).fetch_optional(&mut **tx).await?.ok_or(Error::Denied)?;
    if txt(&grant, "status") != Some("active") || txt(&grant, "credential_secret_id").is_none() {
        return Err(Error::Denied);
    }
    if !valid_authorizer(tx, org, txt(&grant, "authorizing_user_id"), local).await? {
        needs_reauth_tx(
            tx,
            org,
            connection,
            &grant,
            "authorizer_no_longer_authorized",
        )
        .await?;
        return Err(Error::Denied);
    }
    Ok(grant)
}
async fn needs_reauth_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    connection: &str,
    grant: &Value,
    reason: &str,
) -> Result<(), Error> {
    sqlx::query("UPDATE mcp_oauth_grants SET status='needs_reauth',status_metadata=$3::jsonb,credential_secret_id=NULL,refresh_lease_nonce=NULL,refresh_lease_expires_at=NULL,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND status='active'").bind(org).bind(txt(grant,"id")).bind(json!({"reason":reason})).execute(&mut **tx).await?;
    sqlx::query("UPDATE mcp_connections SET status='needs_reauth',enabled=false,disabled_at=statement_timestamp(),lifecycle_revision=lifecycle_revision+1,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid").bind(org).bind(connection).execute(&mut **tx).await?;
    if let Some(secret) = txt(grant, "credential_secret_id") {
        sqlx::query("DELETE FROM organization_secrets WHERE org_id=$1::uuid AND id=$2::uuid")
            .bind(org)
            .bind(secret)
            .execute(&mut **tx)
            .await?;
    }
    write_activity(
        tx,
        org,
        &ActivityActor {
            actor_type: if txt(grant, "authorizing_user_id").is_some() {
                "user"
            } else {
                "system"
            },
            actor_id: txt(grant, "authorizing_user_id").unwrap_or("system").into(),
            run_id: None,
        },
        "mcp_oauth.reauthorization_required",
        "mcp_connection",
        connection,
        Some(&json!({"reason":reason})),
    )
    .await?;
    Ok(())
}
async fn secret(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    secret_id: &str,
    purpose: Option<&str>,
) -> Result<(Value, i32), Error> {
    let row=sqlx::query("SELECT s.provider,s.purpose,s.latest_version,v.material,v.value_sha256,v.revoked_at IS NOT NULL AS revoked FROM organization_secrets s JOIN organization_secret_versions v ON v.secret_id=s.id AND v.version=s.latest_version WHERE s.org_id=$1::uuid AND s.id=$2::uuid FOR SHARE OF s,v")
        .bind(org).bind(secret_id).fetch_optional(&mut **tx).await?.ok_or(Error::Runtime("mcp_credentials_unavailable"))?;
    if row.try_get::<String, _>("provider")? != "local_encrypted"
        || row.try_get::<bool, _>("revoked")?
        || purpose.is_some_and(|purpose| {
            row.try_get::<String, _>("purpose").ok().as_deref() != Some(purpose)
        })
    {
        return Err(Error::Runtime("mcp_credentials_unavailable"));
    }
    let value = crate::secrets::decrypt_runtime_secret(
        &row.try_get("material")?,
        &row.try_get::<String, _>("value_sha256")?,
    )
    .ok_or(Error::Runtime("mcp_credentials_unavailable"))?;
    let value = serde_json::from_str::<Value>(&value)
        .ok()
        .filter(Value::is_object)
        .ok_or(Error::Runtime("mcp_credentials_unavailable"))?;
    Ok((value, row.try_get("latest_version")?))
}
pub async fn credentials(
    pool: &PgPool,
    identity: &Identity,
    access: &Access,
    local: bool,
) -> Result<Credentials, Error> {
    let mut tx = pool.begin().await?;
    let result = async {
        let current = runtime_access(&mut tx, identity, &access.binding_id, local, true).await?;
        if ["custom", "github"].contains(&current.provider.as_str()) {
            let material = if let Some(secret_id) = &current.credential_secret_id {
                secret(&mut tx, &identity.organization_id, secret_id, None)
                    .await?
                    .0
            } else {
                json!({})
            };
            Ok(Credentials {
                connection: material,
                oauth: None,
            })
        } else {
            let grant = usable_grant(
                &mut tx,
                &identity.organization_id,
                &current.connection_id,
                local,
            )
            .await?;
            let secret_id = txt(&grant, "credential_secret_id").ok_or(Error::Denied)?;
            let resolved = secret(
                &mut tx,
                &identity.organization_id,
                secret_id,
                Some("managed_mcp_oauth"),
            )
            .await;
            let (material, latest_version) = match resolved {
                Ok(value) => value,
                Err(Error::Runtime(_)) => {
                    needs_reauth_tx(
                        &mut tx,
                        &identity.organization_id,
                        &current.connection_id,
                        &grant,
                        "credential_unavailable",
                    )
                    .await?;
                    return Err(Error::Denied);
                }
                Err(error) => return Err(error),
            };
            Ok(Credentials {
                connection: json!({}),
                oauth: Some(OAuthCredential {
                    grant_id: txt(&grant, "id").ok_or(Error::Denied)?.into(),
                    secret_id: secret_id.into(),
                    latest_version,
                    material,
                    status_metadata: grant["status_metadata"].clone(),
                    authorizing_user_id: txt(&grant, "authorizing_user_id").map(str::to_owned),
                }),
            })
        }
    }
    .await;
    commit_result(tx, result).await
}

/// Existing refresh nonce/latestVersion fencing; no separate runtime lease.
pub async fn claim_refresh(
    pool: &PgPool,
    identity: &Identity,
    access: &Access,
    baseline: &OAuthCredential,
    local: bool,
) -> Result<RefreshClaim, Error> {
    let mut tx = pool.begin().await?;
    let result=async {
        let connection=sqlx::query_scalar::<_,Value>("SELECT to_jsonb(c) FROM mcp_connections c WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE").bind(&identity.organization_id).bind(&access.connection_id).fetch_optional(&mut *tx).await?.ok_or(Error::Denied)?;
        if connection["enabled"]!=true||connection["status"]!="active"{return Err(Error::Denied);}
        let grant=usable_grant(&mut tx,&identity.organization_id,&access.connection_id,local).await?;
        let secret_id=txt(&grant,"credential_secret_id").ok_or(Error::Denied)?;
        let (material,version)=match secret(&mut tx,&identity.organization_id,secret_id,Some("managed_mcp_oauth")).await{Ok(value)=>value,Err(Error::Runtime(_))=>{needs_reauth_tx(&mut tx,&identity.organization_id,&access.connection_id,&grant,"credential_unavailable").await?;return Err(Error::Denied);},Err(error)=>return Err(error)};
        if secret_id!=baseline.secret_id||version!=baseline.latest_version{return Ok(RefreshClaim::Changed);}
        let timeout=connection["tool_timeout_ms"].as_u64().unwrap_or(10000).min(10000);let authorization=authorization_snapshot(&connection,&grant["status_metadata"])?;
        if access.provider=="linear" && authorization["accessMode"].as_str().is_some_and(|mode|mode!=access.connection_access){needs_reauth_tx(&mut tx,&identity.organization_id,&access.connection_id,&grant,"authorization_resource_changed").await?;return Err(Error::Denied);}
        let leased:bool=sqlx::query_scalar("SELECT refresh_lease_nonce IS NOT NULL AND COALESCE(refresh_lease_expires_at>statement_timestamp(),false) FROM mcp_oauth_grants WHERE id=$1::uuid").bind(txt(&grant,"id")).fetch_one(&mut *tx).await?;
        if leased{return Ok(RefreshClaim::Busy {wait_ms:50,timeout_ms:timeout});}
        let nonce=uuid::Uuid::new_v4().to_string();
        sqlx::query("UPDATE mcp_oauth_grants SET refresh_lease_nonce=$2,refresh_lease_expires_at=statement_timestamp()+($3::bigint*interval '1 millisecond'),updated_at=statement_timestamp() WHERE id=$1::uuid")
            .bind(txt(&grant,"id")).bind(&nonce).bind((timeout+1000) as i64).execute(&mut *tx).await?;
        Ok(RefreshClaim::Owned(Box::new(RefreshLease {credential:OAuthCredential {grant_id:txt(&grant,"id").ok_or(Error::Denied)?.into(),secret_id:secret_id.into(),latest_version:version,material,status_metadata:grant["status_metadata"].clone(),authorizing_user_id:txt(&grant,"authorizing_user_id").map(str::to_owned)},nonce,timeout_ms:timeout,authorization,connection_id:access.connection_id.clone(),organization_id:identity.organization_id.clone()})))
    }.await;
    commit_result(tx, result).await
}
pub async fn finish_refresh(
    pool: &PgPool,
    lease: &RefreshLease,
    outcome: RefreshOutcome<'_>,
    local: bool,
) -> Result<bool, Error> {
    let prepared = match outcome {
        RefreshOutcome::Success(material) => Some(
            crate::secrets::encrypt_value(&material.to_string())
                .map_err(|_| Error::Runtime("mcp_oauth_refresh_failed"))?,
        ),
        _ => None,
    };
    let mut tx = pool.begin().await?;
    let result=async {
        let active:bool=sqlx::query_scalar("SELECT enabled AND status='active' FROM mcp_connections WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE").bind(&lease.organization_id).bind(&lease.connection_id).fetch_optional(&mut *tx).await?.unwrap_or(false);if !active{return Err(Error::Runtime("mcp_oauth_refresh_stale"));}
        let grant=usable_grant(&mut tx,&lease.organization_id,&lease.connection_id,local).await?;
        if txt(&grant,"id")!=Some(lease.credential.grant_id.as_str())||txt(&grant,"credential_secret_id")!=Some(lease.credential.secret_id.as_str())||txt(&grant,"refresh_lease_nonce")!=Some(lease.nonce.as_str()){return Err(Error::Runtime("mcp_oauth_refresh_stale"));}
        let (_,version)=secret(&mut tx,&lease.organization_id,&lease.credential.secret_id,Some("managed_mcp_oauth")).await?;
        if version!=lease.credential.latest_version {clear_refresh(&mut tx,lease).await?;return Err(Error::Runtime("mcp_oauth_refresh_stale"));}
        match outcome {
            RefreshOutcome::InvalidGrant=>{needs_reauth_tx(&mut tx,&lease.organization_id,&lease.connection_id,&grant,"invalid_grant").await?;Ok(false)},
            RefreshOutcome::Failed=>{clear_refresh(&mut tx,lease).await?;Err(Error::Runtime("mcp_oauth_refresh_failed"))},
            RefreshOutcome::Success(material)=>{
                let (encrypted,hash)=prepared.ok_or(Error::Runtime("mcp_oauth_refresh_failed"))?;let next=version+1;
                sqlx::query("INSERT INTO organization_secret_versions(secret_id,version,material,value_sha256,created_by_user_id) VALUES($1::uuid,$2,$3::jsonb,$4,$5)").bind(&lease.credential.secret_id).bind(next).bind(encrypted).bind(hash).bind(&lease.credential.authorizing_user_id).execute(&mut *tx).await?;
                let changed=sqlx::query("UPDATE organization_secrets SET latest_version=$3,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND latest_version=$4").bind(&lease.organization_id).bind(&lease.credential.secret_id).bind(next).bind(version).execute(&mut *tx).await?.rows_affected();if changed!=1{return Err(Error::Runtime("mcp_oauth_refresh_stale"));}
                let mut scopes=Vec::new();for scope in material["tokens"]["scope"].as_str().unwrap_or("").split_whitespace(){if !scopes.contains(&scope){scopes.push(scope);}}
                let expiry=material["tokens"]["expires_in"].as_f64().filter(|value|value.is_finite()).map(|value|(value.max(0.0)*1000.0) as i64);
                sqlx::query("UPDATE mcp_oauth_grants SET provider_scopes=$3::jsonb,expires_at=CASE WHEN $4::bigint IS NULL THEN NULL ELSE statement_timestamp()+($4::bigint*interval '1 millisecond') END,last_refreshed_at=statement_timestamp(),refresh_lease_nonce=NULL,refresh_lease_expires_at=NULL,status_metadata='{}'::jsonb,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND status='active' AND refresh_lease_nonce=$5")
                    .bind(&lease.organization_id).bind(&lease.credential.grant_id).bind(json!(scopes)).bind(expiry).bind(&lease.nonce).execute(&mut *tx).await?;
                write_activity(&mut tx,&lease.organization_id,&ActivityActor {actor_type:if lease.credential.authorizing_user_id.is_some(){"user"}else{"system"},actor_id:lease.credential.authorizing_user_id.clone().unwrap_or_else(||"system".into()),run_id:None},"mcp_oauth.token_refreshed","mcp_connection",&lease.connection_id,Some(&json!({"rotated":true}))).await?;Ok(true)
            }
        }
    }.await;
    commit_result(tx, result).await
}
async fn clear_refresh(
    tx: &mut Transaction<'_, Postgres>,
    lease: &RefreshLease,
) -> Result<(), Error> {
    sqlx::query("UPDATE mcp_oauth_grants SET refresh_lease_nonce=NULL,refresh_lease_expires_at=NULL,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND refresh_lease_nonce=$3").bind(&lease.organization_id).bind(&lease.credential.grant_id).bind(&lease.nonce).execute(&mut **tx).await?;
    Ok(())
}
pub async fn mark_needs_reauth(
    pool: &PgPool,
    identity: &Identity,
    access: &Access,
    reason: &str,
    local: bool,
) -> Result<(), Error> {
    let mut tx = pool.begin().await?;
    let result = async {
        sqlx::query(
            "SELECT id FROM mcp_connections WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE",
        )
        .bind(&identity.organization_id)
        .bind(&access.connection_id)
        .fetch_optional(&mut *tx)
        .await?;
        let grant = usable_grant(
            &mut tx,
            &identity.organization_id,
            &access.connection_id,
            local,
        )
        .await?;
        needs_reauth_tx(
            &mut tx,
            &identity.organization_id,
            &access.connection_id,
            &grant,
            reason,
        )
        .await
    }
    .await;
    commit_result(tx, result).await
}

/// Same bounded, secret-aware audit envelope as managed-runtime.ts. Raw inputs,
/// provider credentials and full upstream errors never enter audit rows.
pub fn redact_audit(value: &Value) -> Value {
    fn cut(value: &str, limit: usize) -> String {
        let mut used = 0;
        value
            .chars()
            .take_while(|ch| {
                used += ch.len_utf16();
                used <= limit
            })
            .collect()
    }
    fn sensitive(value: &str) -> bool {
        regex_lite::Regex::new(r"(?i)api[-_]?key|access[-_]?token|auth(?:[-_]?token)?|authorization|bearer|secret|passwd|password|credential|cookie|jwt|private[-_]?key|connectionstring|(?:^|[-_])token(?:$|[-_])").unwrap().is_match(value)
    }
    fn walk(value: &Value, nodes: &mut usize, depth: usize) -> Value {
        *nodes += 1;
        if *nodes > 2000 || depth >= 8 {
            return json!("[bounded value omitted]");
        }
        match value {
            Value::String(value) => {
                let token=regex_lite::Regex::new(r"(?i)^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$|\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]{4,}|^(?:sk-(?:proj-)?|gh[oprsu]_|github_pat_|xox[baprs]-|pat_|lin_api_|ntn_)[A-Za-z0-9_-]{12,}$|(?:^|[?&])(?:access_token|api_key|apikey|token|auth)=").unwrap().is_match(value);
                let entropy = value.len() >= 32
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"+/_=-".contains(&byte))
                    && value.bytes().any(|byte| byte.is_ascii_alphabetic())
                    && value.bytes().any(|byte| byte.is_ascii_digit());
                if token || entropy {
                    return json!("***REDACTED***");
                }
                let value =
                    regex_lite::Regex::new(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b")
                        .unwrap()
                        .replace_all(value, "***REDACTED***")
                        .to_string();
                let bounded = cut(&value, 2048);
                json!(if bounded.len() < value.len() {
                    format!("{bounded}…")
                } else {
                    bounded
                })
            }
            Value::Array(values) => {
                let mut result = values
                    .iter()
                    .take(50)
                    .map(|value| walk(value, nodes, depth + 1))
                    .collect::<Vec<_>>();
                if values.len() > 50 {
                    result.push(json!("[additional items omitted]"));
                }
                json!(result)
            }
            Value::Object(values) => {
                let mut result = serde_json::Map::new();
                for (key, value) in values.iter().take(100) {
                    let key_safe = cut(
                        &regex_lite::Regex::new(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b")
                            .unwrap()
                            .replace_all(key, "***REDACTED***"),
                        2048,
                    );
                    let mut selected = key_safe.clone();
                    let mut collision = 2;
                    while result.contains_key(&selected) {
                        let suffix = format!("#{collision}");
                        selected = format!("{}{}", cut(&key_safe, 2048 - suffix.len()), suffix);
                        collision += 1;
                    }
                    result.insert(
                        selected,
                        if sensitive(key) {
                            json!("***REDACTED***")
                        } else {
                            walk(value, nodes, depth + 1)
                        },
                    );
                }
                if values.len() > 100 {
                    result.insert("__truncatedKeys".into(), json!(true));
                }
                Value::Object(result)
            }
            value => value.clone(),
        }
    }
    let value = walk(value, &mut 0, 0);
    let record = if value.is_object() {
        value
    } else {
        json!({"value":value})
    };
    let raw = record.to_string();
    if raw.len() <= 24 * 1024 {
        return record;
    }
    let mut low = 0;
    let mut high = raw.chars().count();
    while low < high {
        let middle = (low + high).div_ceil(2);
        let preview = raw.chars().take(middle).collect::<String>();
        if json!({"truncated":true,"preview":preview})
            .to_string()
            .len()
            <= 24 * 1024
        {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    json!({"truncated":true,"preview":raw.chars().take(low).collect::<String>()})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn run_access_never_widens_a_frozen_snapshot() {
        assert_eq!(intersect("read_write", "read_only"), "read_only");
        assert_eq!(intersect("full", "read_only"), "none");
        assert_eq!(
            effective_access("full", "custom", "provider_default"),
            "full"
        );
        assert_eq!(
            effective_access("read_write", "notion", "provider_default"),
            "none"
        );
    }
    #[test]
    fn audit_redacts_credentials_addresses_and_bounded_nested_content() {
        let value = redact_audit(
            &json!({"access_token":"private","body":"contact person@example.com","tokenLike":"ghp_abcdefghijklmnopqrstuvwxyz","large":vec!["x";60]}),
        );
        assert_eq!(value["access_token"], "***REDACTED***");
        assert_eq!(value["tokenLike"], "***REDACTED***");
        assert!(!value.to_string().contains("person@example.com"));
        assert!(value.to_string().len() <= 24 * 1024);
    }
}
