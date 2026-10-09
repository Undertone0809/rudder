//! Agent transaction helpers. All SQL identifiers below are native constants.
use super::{AgentCoreError, AgentCoreRequest};
use rudder_auth_core::VerifiedActor;
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
pub(super) type Tx<'a> = Transaction<'a, Postgres>;
pub(super) type Result<T> = std::result::Result<T, AgentCoreError>;
pub(super) fn http(code: u16, message: impl Into<String>) -> AgentCoreError {
    AgentCoreError::Http(code, message.into(), None)
}
pub(super) fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
pub(super) struct Context<'a> {
    pub org: &'a str,
    pub actor: &'a VerifiedActor,
    pub request: &'a AgentCoreRequest,
    pub admin: bool,
}
impl Context<'_> {
    pub fn agent(&self) -> Option<&str> {
        (self.actor.actor().kind == "agent").then_some(self.actor.actor().id.as_str())
    }
    pub fn user(&self) -> Option<&str> {
        (self.actor.actor().kind == "user").then_some(self.actor.actor().id.as_str())
    }
    pub fn local(&self) -> bool {
        self.user() == Some("local-board")
            && self.actor.session_id() == "local-implicit"
            && self.request.local_implicit
    }
}
pub(super) fn now() -> String {
    timestamp(time::OffsetDateTime::now_utc())
}
fn timestamp(t: time::OffsetDateTime) -> String {
    let t = t.to_offset(time::UtcOffset::UTC);
    format!(
        "{}.{:03}Z",
        t.format(
            &time::format_description::parse_borrowed::<2>(
                "[year]-[month]-[day]T[hour]:[minute]:[second]"
            )
            .expect("constant format")
        )
        .expect("timestamp"),
        t.millisecond()
    )
}
pub(super) fn decode(raw: &str) -> Result<Value> {
    let value = super::json_boundary::parse(raw).map_err(|_| http(500, "Internal server error"))?;
    let mut result = serde_json::Map::new();
    for (key, value) in value
        .as_object()
        .ok_or_else(|| http(500, "Invalid database record"))?
    {
        let mut parts = key.split('_');
        let mut key = parts.next().unwrap_or("").to_owned();
        for part in parts {
            let mut chars = part.chars();
            if let Some(c) = chars.next() {
                key.extend(c.to_uppercase());
            }
            key.extend(chars);
        }
        let mut value = value.clone();
        if key.ends_with("At")
            && let Some(v) = value.as_str()
            && let Ok(t) =
                time::OffsetDateTime::parse(v, &time::format_description::well_known::Rfc3339)
        {
            value = json!(timestamp(t));
        }
        result.insert(key, value);
    }
    Ok(Value::Object(result))
}
fn column(key: &str) -> String {
    let mut result = String::new();
    for c in key.chars() {
        if c.is_ascii_uppercase() {
            result.push('_');
            result.push(c.to_ascii_lowercase())
        } else {
            result.push(c)
        }
    }
    result
}
pub(super) async fn insert(tx: &mut Tx<'_>, table: &'static str, record: &Value) -> Result<Value> {
    assert!(["agent_config_revisions", "agent_api_keys",].contains(&table));
    let record = record
        .as_object()
        .ok_or_else(|| http(500, "Invalid domain record"))?;
    let columns = record.keys().map(|k| column(k)).collect::<Vec<_>>();
    let object: Value = Value::Object(record.iter().map(|(k, v)| (column(k), v.clone())).collect());
    let sql = format!(
        "INSERT INTO {table} ({}) SELECT {} FROM jsonb_populate_record(NULL::{table},$1::jsonb) RETURNING to_jsonb({table})::text",
        columns.join(","),
        columns.join(",")
    );
    decode(
        &sqlx::query_scalar::<_, String>(&sql)
            .bind(object.to_string())
            .fetch_one(&mut **tx)
            .await?,
    )
}
pub(super) async fn update(tx: &mut Tx<'_>, org: &str, id: &str, patch: &Value) -> Result<Value> {
    let record = patch
        .as_object()
        .ok_or_else(|| http(500, "Invalid domain patch"))?;
    let columns = record.keys().map(|k| column(k)).collect::<Vec<_>>();
    let object: Value = Value::Object(record.iter().map(|(k, v)| (column(k), v.clone())).collect());
    let sql = format!(
        "UPDATE agents a SET {} FROM jsonb_populate_record(NULL::agents,$3::jsonb) p WHERE a.org_id=$1::uuid AND a.id=$2::uuid RETURNING to_jsonb(a)::text",
        columns
            .iter()
            .map(|c| format!("{c}=p.{c}"))
            .collect::<Vec<_>>()
            .join(",")
    );
    decode(
        &sqlx::query_scalar::<_, String>(&sql)
            .bind(org)
            .bind(id)
            .bind(object.to_string())
            .fetch_one(&mut **tx)
            .await?,
    )
}
pub(super) async fn stored(tx: &mut Tx<'_>, id: &str) -> Result<Option<Value>> {
    sqlx::query_scalar::<_, String>("SELECT to_jsonb(a)::text FROM agents a WHERE id=$1::uuid")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .map(|v| decode(&v))
        .transpose()
}
pub(super) fn js_trim(value: &str) -> &str {
    value.trim_matches(|c| matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}
pub(super) fn uuid_like(value: &str) -> bool {
    regex_lite::Regex::new(
        r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    )
    .expect("constant regex")
    .is_match(js_trim(value))
}
pub(super) fn slug(value: &str) -> String {
    let mut output = String::new();
    let mut delimiter = false;
    for ch in js_trim(value).to_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            if delimiter && !output.is_empty() {
                output.push('-')
            }
            output.push(ch);
            delimiter = false;
        } else {
            delimiter = true;
        }
    }
    output
}
pub(super) fn hidden(row: &Value) -> bool {
    row["metadata"]["hidden"] == true || row["metadata"]["systemManaged"] == "rudder_copilot"
}
pub(super) fn permissions(value: &Value) -> Value {
    json!({"canCreateAgents":value["canCreateAgents"].as_bool().unwrap_or(true),"canManageSkills":value["canManageSkills"].as_bool().unwrap_or(true)})
}
pub(super) fn can_create(row: &Value) -> bool {
    row["permissions"]["canCreateAgents"]
        .as_bool()
        .unwrap_or(true)
}
pub(super) async fn authorize_org(tx: &mut Tx<'_>, ctx: &Context<'_>) -> Result<()> {
    if let Some(id) = ctx.agent() {
        let authenticated = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM agents a WHERE a.id::text=$1 AND a.status NOT IN ('terminated','pending_approval') AND ($2::text IS NULL OR EXISTS(SELECT 1 FROM agent_api_keys k WHERE k.id::text=$2 AND k.agent_id=a.id AND k.org_id=a.org_id AND k.revoked_at IS NULL)))",
        ).bind(id).bind(ctx.actor.session_id().strip_prefix("agent-key:")).fetch_one(&mut **tx).await?;
        if !authenticated {
            return Err(http(401, "Agent authentication required"));
        }
        let allowed = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM agents WHERE id::text=$1 AND org_id::text=$2)",
        )
        .bind(id)
        .bind(ctx.org)
        .fetch_one(&mut **tx)
        .await?;
        return if allowed {
            Ok(())
        } else {
            Err(http(403, "Agent key cannot access another organization"))
        };
    }
    if ctx.user().is_none() {
        return Err(http(401, "Unauthorized"));
    }
    authorize_user(tx, ctx).await?;
    if ctx.local() || ctx.admin {
        return Ok(());
    }
    let allowed=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM organization_memberships WHERE org_id::text=$1 AND principal_type='user' AND principal_id=$2 AND status='active')").bind(ctx.org).bind(&ctx.actor.actor().id).fetch_one(&mut **tx).await?;
    if allowed {
        Ok(())
    } else {
        Err(http(403, "User does not have access to this organization"))
    }
}
/// Revalidate credential facts independently of organization permission checks.
pub(super) async fn authorize_user(tx: &mut Tx<'_>, ctx: &Context<'_>) -> Result<()> {
    if ctx.user().is_none() {
        return Err(http(403, "Board access required"));
    }
    if let Some(key) = ctx.actor.session_id().strip_prefix("board-key:") {
        let valid=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM board_api_keys WHERE id::text=$1 AND user_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()))").bind(key).bind(ctx.user()).fetch_one(&mut **tx).await?;
        if !valid {
            return Err(http(401, "Unauthorized"));
        }
    }
    Ok(())
}
pub(super) async fn has_grant(
    tx: &mut Tx<'_>,
    ctx: &Context<'_>,
    permission: &str,
) -> Result<bool> {
    Ok(sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM organization_memberships m JOIN principal_permission_grants g USING(org_id,principal_type,principal_id) WHERE m.org_id=$1::uuid AND m.principal_type=$2 AND m.principal_id=$3 AND m.status='active' AND g.permission_key=$4)").bind(ctx.org).bind(&ctx.actor.actor().kind).bind(&ctx.actor.actor().id).bind(permission).fetch_one(&mut **tx).await?)
}
pub(super) async fn can_read_configs(tx: &mut Tx<'_>, ctx: &Context<'_>) -> Result<bool> {
    if ctx.user().is_some() {
        return if ctx.local() || ctx.admin {
            Ok(true)
        } else {
            has_grant(tx, ctx, "agents:create").await
        };
    }
    let row = stored(
        tx,
        ctx.agent()
            .ok_or_else(|| http(403, "Agent authentication required"))?,
    )
    .await?
    .ok_or_else(|| http(403, "Agent key cannot access another organization"))?;
    if !can_create(&row) {
        return Ok(false);
    }
    Ok(has_grant(tx, ctx, "agents:create").await? || can_create(&row))
}
pub(super) async fn require_configs(tx: &mut Tx<'_>, ctx: &Context<'_>) -> Result<()> {
    if can_read_configs(tx, ctx).await? {
        Ok(())
    } else {
        Err(http(
            403,
            if ctx.user().is_some() {
                "Missing permission: agents:create"
            } else {
                "Missing permission: can create agents"
            },
        ))
    }
}
pub(super) async fn require_update(tx: &mut Tx<'_>, ctx: &Context<'_>, id: &str) -> Result<()> {
    if ctx.user().is_some() || ctx.agent() == Some(id) {
        return Ok(());
    }
    let row = stored(
        tx,
        ctx.agent()
            .ok_or_else(|| http(403, "Agent authentication required"))?,
    )
    .await?
    .ok_or_else(|| http(403, "Agent key cannot access another organization"))?;
    if can_create(&row)
        && (text(&row, "role") == "ceo"
            || has_grant(tx, ctx, "agents:create").await?
            || can_create(&row))
    {
        return Ok(());
    }
    Err(http(
        403,
        "Only CEO or agent creators can modify other agents",
    ))
}
pub(super) async fn activity(
    tx: &mut Tx<'_>,
    ctx: &Context<'_>,
    action: &str,
    id: &str,
    details: Option<&Value>,
) -> Result<()> {
    activity_effects(tx, ctx, action, id, details, None).await
}
pub(super) async fn activity_effects(
    tx: &mut Tx<'_>,
    ctx: &Context<'_>,
    action: &str,
    id: &str,
    details: Option<&Value>,
    effects: Option<&Value>,
) -> Result<()> {
    crate::activity::write_activity_options(
        tx,
        crate::activity::ActivityWrite {
            org: ctx.org,
            audit: &crate::activity::ActivityActor {
                actor_type: if ctx.agent().is_some() {
                    "agent"
                } else {
                    "user"
                },
                actor_id: ctx.actor.actor().id.clone(),
                run_id: ctx.request.actor_run_id.clone(),
            },
            action,
            entity_type: "agent",
            entity_id: id,
            details,
            options: crate::activity::ActivityOptions {
                agent_id: ctx.agent(),
                effects,
                bind_run: true,
            },
        },
    )
    .await?;
    Ok(())
}
