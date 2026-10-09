//! Agent directory, configuration, keys and runtime-state authority. The signed wrapper
//! carries authenticated ingress facts; SQL determines all effective authority.
mod common;
mod constants;
mod json_boundary;
mod reads;
mod redaction;
mod validation;
mod writes;
use common::*;
use rudder_auth_core::VerifiedActor;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgPool;

#[derive(Debug, thiserror::Error)]
pub enum AgentCoreError {
    #[error("{1}")]
    Http(u16, String, Option<Value>),
    #[error("Agent database operation failed")]
    Database(#[from] sqlx::Error),
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCoreRequest {
    pub operation: String,
    pub org_id: Option<String>,
    pub id: Option<String>,
    pub revision_id: Option<String>,
    pub key_id: Option<String>,
    #[serde(default)]
    pub query: Value,
    #[serde(default)]
    pub input: Value,
    #[serde(skip)]
    input_missing: bool,
    pub actor_run_id: Option<String>,
    #[serde(default)]
    pub local_implicit: bool,
    #[serde(default)]
    pub resolve_only: bool,
    #[serde(default)]
    pub organization_agents_root: String,
    #[serde(default)]
    pub home_directory: String,
    #[serde(default)]
    pub process_working_directory: String,
    #[serde(default)]
    pub canonical_locale: String,
}
impl AgentCoreRequest {
    pub fn parse(body: &[u8]) -> std::result::Result<Self, serde_json::Error> {
        json_boundary::stack(|| {
            let raw = std::str::from_utf8(body)
                .map_err(<serde_json::Error as serde::de::Error>::custom)?;
            let mut value = json_boundary::parse(raw)?;
            let missing = value.get("input").is_none();
            let input = value
                .as_object_mut()
                .and_then(|v| v.remove("input"))
                .unwrap_or(Value::Null);
            let query = value
                .as_object_mut()
                .and_then(|v| v.remove("query"))
                .unwrap_or(Value::Null);
            let mut request: Self = serde_json::from_value(value)?;
            request.input = input;
            request.query = query;
            request.input_missing = missing;
            Ok(request)
        })
    }
}
impl Drop for AgentCoreRequest {
    fn drop(&mut self) {
        json_boundary::stack(|| {
            drop(std::mem::take(&mut self.input));
            drop(std::mem::take(&mut self.query));
        });
    }
}
fn board(actor: &VerifiedActor) -> Result<()> {
    if actor.actor().kind == "user" {
        Ok(())
    } else {
        Err(http(403, "Board access required"))
    }
}
fn early_authorization(actor: &VerifiedActor, r: &AgentCoreRequest) -> Result<()> {
    match r.operation.as_str() {
        "inbox" if actor.actor().kind != "agent" => Err(http(401, "Agent authentication required")),
        "keys"
        | "key-create"
        | "key-revoke"
        | "runtime-state"
        | "task-sessions"
        | "reset-session"
        | "scheduler-heartbeats" => board(actor),
        _ => {
            if matches!(actor.actor().kind.as_str(), "user" | "agent") {
                Ok(())
            } else {
                Err(http(401, "Unauthorized"))
            }
        }
    }
}
/// Validation and static error precedence are available before persistence.
/// Shortname references defer validation because Express param middleware used
/// to run first; UUID routes retain validation-before-auth semantics.
pub fn admit_agent(actor: &VerifiedActor, r: &AgentCoreRequest) -> Result<()> {
    json_boundary::stack(|| admit_inner(actor, r))
}
fn admit_inner(actor: &VerifiedActor, r: &AgentCoreRequest) -> Result<()> {
    if ![
        "list",
        "configurations",
        "name-suggestion",
        "inbox",
        "configuration",
        "revisions",
        "revision",
        "rollback",
        "keys",
        "key-create",
        "key-revoke",
        "runtime-state",
        "reset-session",
        "task-sessions",
        "scheduler-heartbeats",
    ]
    .contains(&r.operation.as_str())
    {
        return Err(http(400, "Invalid Agent command"));
    }
    if r.id.as_deref().is_none_or(uuid_like) {
        validation::validate(&r.operation, (!r.input_missing).then_some(&r.input))?;
        early_authorization(actor, r)?;
    }
    Ok(())
}
pub async fn execute_agent(
    pool: &PgPool,
    actor: &VerifiedActor,
    r: &AgentCoreRequest,
) -> Result<(u16, String)> {
    json_boundary::run(async{
        admit_agent(actor,r)?;
        let mut tx=pool.begin().await?;
        let admin=actor.actor().kind=="user"&&sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM instance_user_roles WHERE user_id=$1 AND role='instance_admin')").bind(&actor.actor().id).fetch_one(&mut *tx).await?;
        if actor.actor().kind=="user" { authorize_user(&mut tx,&Context{org:"",actor,request:r,admin}).await?; }
        if r.operation=="scheduler-heartbeats"{
            let ctx=Context{org:"",actor,request:r,admin};let body=reads::scheduler(&mut tx,&ctx).await?;tx.commit().await?;return Ok((200,body.to_string()));
        }
        let id=resolve_id(&mut tx,actor,r,admin).await?;
        let input=validation::validate(&r.operation,(!r.input_missing).then_some(&r.input))?;
        early_authorization(actor,r)?;
        let current=if let Some(id)=&id{stored(&mut tx,id).await?}else{None};
        if id.is_some()&&current.is_none()&&!matches!(r.operation.as_str(),"keys"|"key-revoke"){return Err(http(404,"Agent not found"));}
        let org=if let Some(row)=&current{text(row,"orgId").to_owned()}else if let Some(org)=&r.org_id{org.clone()}else if r.operation=="key-revoke"{
            sqlx::query_scalar::<_,String>("SELECT org_id::text FROM agent_api_keys WHERE id=$1::uuid AND agent_id=$2::uuid").bind(r.key_id.as_deref()).bind(id.as_deref()).fetch_optional(&mut *tx).await?.ok_or_else(||http(404,"Key not found"))?
        }else if r.operation=="keys"{tx.commit().await?;return Ok((200,"[]".into()))}else{return Err(http(404,"Agent not found"))};
        let ctx=Context{org:&org,actor,request:r,admin};authorize_org(&mut tx,&ctx).await?;
        if r.resolve_only{tx.commit().await?;return Ok((200,json!({"orgId":org,"id":id}).to_string()))}
        let op=r.operation.as_str();let is_write=matches!(op,"key-create"|"key-revoke"|"rollback"|"reset-session");
        if is_write{
            // Match runtime admission lock order: Issues, Agents, organization.
            sqlx::query("SELECT id FROM issues WHERE org_id=$1::uuid ORDER BY id FOR UPDATE").bind(&org).execute(&mut *tx).await?;
            sqlx::query("SELECT id FROM agents WHERE org_id=$1::uuid ORDER BY id FOR UPDATE").bind(&org).execute(&mut *tx).await?;
            let fence=sqlx::query_scalar::<_,i64>("SELECT mutation_version FROM organization_mutation_state WHERE org_id=$1::uuid FOR UPDATE").bind(&org).fetch_optional(&mut *tx).await?;
            if fence.is_none(){return Err(http(409,"Organization mutation authority is not provisioned"))}
            // The pre-lock row is never authority for concurrent transitions.
            let current=if let Some(id)=&id{stored(&mut tx,id).await?}else{None};
            let current=if op!="key-revoke"{if let Some(row)=current{Some(reads::ensure_workspace_key(&mut tx,&ctx,row).await?)}else{None}}else{current};
            if id.is_some()&&current.is_none(){return Err(http(404,"Agent not found"))}
            authorize_org(&mut tx,&ctx).await?;
            let body=writes::execute(&mut tx,&ctx,op,current.as_ref(),&input).await?;
            sqlx::query("UPDATE organization_mutation_state SET mutation_version=mutation_version+1,updated_at=now() WHERE org_id=$1::uuid").bind(&org).execute(&mut *tx).await?;
            tx.commit().await?;return Ok((if op=="key-create"{201}else{200},body.to_string()));
        }
        let row=current.unwrap_or(Value::Null);
        let row=if !row.is_null()&&!matches!(op,"keys"|"inbox"){reads::ensure_workspace_key(&mut tx,&ctx,row).await?}else{row};
        let body=match op{
            "list"|"configurations"=>reads::list(&mut tx,&ctx,op=="configurations").await?,
            "name-suggestion"=>{require_configs(&mut tx,&ctx).await?;json!({"name":writes::suggest_name(&mut tx,&org).await?})},
            "configuration"=>{require_configs(&mut tx,&ctx).await?;reads::configuration(&reads::public_row(&mut tx,row,true,false).await?)},
            "revisions"|"revision"=>reads::revisions(&mut tx,&ctx,text(&row,"id"),if op=="revision"{r.revision_id.as_deref()}else{None}).await?,
            "keys"=>{let rows=sqlx::query_scalar::<_,String>("SELECT jsonb_build_object('id',id,'name',name,'created_at',created_at,'revoked_at',revoked_at)::text FROM agent_api_keys WHERE org_id=$1::uuid AND agent_id=$2::uuid").bind(&org).bind(id.as_deref()).fetch_all(&mut *tx).await?;json!(rows.iter().map(|v|decode(v)).collect::<Result<Vec<_>>>()?)},
            "runtime-state"=>reads::runtime_state(&mut tx,&ctx,&row).await?,
            "task-sessions"=>json!(reads::task_sessions(&mut tx,&ctx,text(&row,"id"),false).await?),
            "inbox"=>reads::inbox(&mut tx,&ctx).await?,
            _=>return Err(http(400,"Invalid Agent command")),
        };
        tx.commit().await?;Ok((200,body.to_string()))
    }).await
}
async fn resolve_id(
    tx: &mut Tx<'_>,
    actor: &VerifiedActor,
    r: &AgentCoreRequest,
    admin: bool,
) -> Result<Option<String>> {
    if r.operation == "inbox" {
        return Ok(Some(actor.actor().id.clone()));
    }
    let Some(raw) = r.id.as_deref() else {
        return Ok(None);
    };
    let raw = js_trim(raw);
    if uuid_like(raw) {
        return Ok(Some(raw.to_owned()));
    }
    let org = if let Some(s) = r.query["orgId"].as_str().filter(|s| !js_trim(s).is_empty()) {
        js_trim(s).to_owned()
    } else if actor.actor().kind == "agent" {
        sqlx::query_scalar::<_, String>("SELECT org_id::text FROM agents WHERE id::text=$1")
            .bind(&actor.actor().id)
            .fetch_optional(&mut **tx)
            .await?
            .unwrap_or_default()
    } else {
        return Err(http(
            422,
            "Agent shortname lookup requires orgId query parameter",
        ));
    };
    if org.is_empty() {
        return Err(http(
            422,
            "Agent shortname lookup requires orgId query parameter",
        ));
    }
    let ctx = Context {
        org: &org,
        actor,
        request: r,
        admin,
    };
    authorize_org(tx, &ctx).await?;
    let rows = sqlx::query_scalar::<_, String>(
        "SELECT to_jsonb(a)::text FROM agents a WHERE org_id=$1::uuid AND status<>'terminated'",
    )
    .bind(&org)
    .fetch_all(&mut **tx)
    .await?;
    let typed = regex_lite::Regex::new(r"(?i)^agt_([a-f0-9]{8,32})$")
        .expect("typed ref")
        .captures(raw)
        .map(|c| c[1].to_ascii_lowercase());
    let key = slug(raw);
    let mut found = Vec::new();
    for value in rows {
        let row = decode(&value)?;
        if hidden(&row) {
            continue;
        }
        let matches = if let Some(prefix) = &typed {
            text(&row, "id").replace('-', "").starts_with(prefix)
        } else {
            !key.is_empty() && slug(text(&row, "name")) == key
        };
        if matches {
            found.push(text(&row, "id").to_owned())
        }
    }
    match found.as_slice() {
        [id] => Ok(Some(id.clone())),
        [] => Err(http(404, "Agent not found")),
        _ => Err(http(
            409,
            "Agent shortname is ambiguous in this organization. Use the agent ID.",
        )),
    }
}
