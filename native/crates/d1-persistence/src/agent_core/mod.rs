//! Agent directory, configuration, keys and runtime-state authority. The signed wrapper
//! carries authenticated ingress facts; SQL determines all effective authority.
mod common;
mod constants;
mod detail;
pub(crate) mod instructions;
mod intelligence;
mod intelligence_runtime;
mod json_boundary;
mod managed_mcp;
mod reads;
mod redaction;
mod skills;
mod updates;
mod validation;
mod writes;
use common::*;
use rudder_auth_core::VerifiedActor;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool};
use std::{collections::BTreeMap, future::Future, pin::Pin};

/// Trusted host paths and identity used by organization workspace operations.
/// The listener constructs these facts from its signed native host context.
#[derive(Clone, Debug)]
pub struct OrganizationWorkspaceHost {
    pub instance_root: String,
    pub workspace_home: String,
    pub previous_documents_root: String,
    pub friendly_workspace_home: bool,
    pub hostname: String,
}

impl OrganizationWorkspaceHost {
    fn instructions_host(&self) -> instructions::Host {
        instructions::Host {
            instance_root: self.instance_root.clone(),
            workspace_home: self.workspace_home.clone(),
            previous_documents_root: self.previous_documents_root.clone(),
            friendly_workspace_home: self.friendly_workspace_home,
            hostname: self.hostname.clone(),
        }
    }
}

/// Read-only instruction payload for an already claimed Agent Run. This is
/// deliberately not serializable: instruction text belongs in the provider
/// invocation, never in a persisted runtime configuration or diagnostic.
pub struct AgentRuntimeInstructions {
    pub agent_home: std::path::PathBuf,
    pub revision: String,
    pub source_path: Option<std::path::PathBuf>,
    pub entry_file: String,
    pub entry_content: Option<String>,
    pub sibling_content: Vec<(String, String)>,
}

/// Share the existing instruction storage/path checks with generic Runs.
/// This does not reconcile or rewrite a bundle, nor relax AgentCore access.
pub fn resolve_agent_runtime_instructions(
    host: &OrganizationWorkspaceHost,
    org_id: &str,
    agent: &Value,
    operator_home: &std::path::Path,
    cwd: &std::path::Path,
) -> std::io::Result<AgentRuntimeInstructions> {
    let instance = std::path::Path::new(&host.instance_root);
    let workspace = std::path::Path::new(&host.workspace_home);
    let previous = std::path::Path::new(&host.previous_documents_root);
    let agent_home = instructions::managed_agent_workspace_path(
        instance,
        workspace,
        previous,
        host.friendly_workspace_home,
        org_id,
        agent,
    )?;
    let value = instructions::resolve_readonly_for_runtime(
        instance,
        workspace,
        previous,
        host.friendly_workspace_home,
        org_id,
        agent,
        operator_home,
        cwd,
    )?;
    Ok(AgentRuntimeInstructions {
        agent_home,
        revision: value.revision,
        source_path: value.source_path,
        entry_file: value.entry_file,
        entry_content: value.entry_content,
        sibling_content: value.sibling_content,
    })
}

/// Resolve the configured organization workspace display root without
/// provisioning or migrating any filesystem state.
pub fn resolve_organization_workspace_root(
    host: &OrganizationWorkspaceHost,
    organization_id: &str,
) -> std::io::Result<std::path::PathBuf> {
    let host = host.instructions_host();
    instructions::resolve_workspace_root(
        &host.instance_root,
        &host.workspace_home,
        &host.previous_documents_root,
        host.friendly_workspace_home,
        &host.hostname,
        organization_id,
    )
}

/// Ensure the organization workspace layout from signed native host facts.
/// Agent instruction storage owns the map lock, identity checks, and legacy
/// migration semantics shared with existing workspace recovery.
pub fn ensure_organization_workspace_layout(
    host: &OrganizationWorkspaceHost,
    cwd: &std::path::Path,
    organization_id: &str,
) -> std::io::Result<std::path::PathBuf> {
    let host = host.instructions_host();
    instructions::ensure_workspace_layout(&host, organization_id, cwd)
}

/// Ensure a newly created organization's workspace while preserving the
/// friendly-name mapping used by the existing Agent workspace layout.
pub fn ensure_named_organization_workspace_layout(
    host: &OrganizationWorkspaceHost,
    cwd: &std::path::Path,
    organization_id: &str,
    organization_name: &str,
) -> std::io::Result<std::path::PathBuf> {
    let host = host.instructions_host();
    instructions::ensure_workspace_layout_for_organization(
        &host,
        organization_id,
        organization_name,
        cwd,
    )
}

/// Remove workspace storage owned by an organization after its database row
/// has been deleted. The shared workspace-map lock and marker checks remain
/// in the instruction storage implementation.
pub fn remove_organization_workspace_layout(
    host: &OrganizationWorkspaceHost,
    organization_id: &str,
) -> std::io::Result<()> {
    let host = host.instructions_host();
    instructions::remove_workspace_layout(&host, organization_id)
}

#[derive(Debug, thiserror::Error)]
pub enum AgentCoreError {
    #[error("{1}")]
    Http(u16, String, Option<Value>),
    #[error("Agent database operation failed")]
    Database(#[from] sqlx::Error),
}

/// Credential authority supplied by the trusted native ingress adapter. This
/// is separate from AgentCoreRequest, so client JSON cannot carry auth proof.
/// The check runs on AgentCore's transaction connection after mutation locks.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeAgentAccess {
    Authorized,
    Unauthorized,
    Forbidden,
}

pub trait NativeAgentAuthorizer: Send + Sync {
    fn revalidate<'a>(
        &'a self,
        connection: &'a mut PgConnection,
        org_id: &'a str,
    ) -> Pin<
        Box<dyn Future<Output = std::result::Result<NativeAgentAccess, sqlx::Error>> + Send + 'a>,
    >;
}

/// Parse public JSON through the same bounded, JavaScript-compatible parser
/// used by AgentCore commands. Public schemas that strip unknown fields can
/// then normalize the body before it is forwarded into a command envelope.
pub fn parse_public_json_value(raw: &str) -> std::result::Result<Value, serde_json::Error> {
    json_boundary::stack(|| json_boundary::parse(raw))
}

/// Apply an existing AgentCore input schema at the public transport boundary.
/// Taking ownership keeps deeply nested, schema-stripped values on the grown
/// stack while they are validated and dropped.
pub fn normalize_public_input(
    operation: &str,
    input: Value,
) -> std::result::Result<Value, AgentCoreError> {
    json_boundary::stack(|| validation::validate(operation, Some(&input)))
}

/// Normalize the public `POST /api/orgs/:orgId/agents` schema into the
/// private AgentCore create contract. Public callers never control the
/// internal `nodeOwned` preparation object.
pub fn normalize_public_agent_create_input(
    input: Option<Value>,
) -> std::result::Result<Value, AgentCoreError> {
    json_boundary::stack(|| validation::normalize_public_agent_create(input))
}

#[derive(Clone, Deserialize)]
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
    #[serde(default)]
    pub deployment_mode: String,
    pub instructions_host: Option<instructions::Host>,
}

/// The normalized Agent create contract shared by the public Rust ingress and
/// the private compatibility bridge. Public callers are expanded by the Rust
/// ingress before this strict internal shape is parsed.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCreateRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub role: String,
    pub title: Option<String>,
    pub capabilities: Option<String>,
    pub agent_runtime_type: String,
    pub agent_runtime_config: Value,
    pub runtime_config: Value,
    pub budget_monthly_cents: i64,
    pub permissions: AgentCreatePermissions,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
    /// Canonical or human-facing skill references requested for the new
    /// agent. Bundled references are validated but never persisted because
    /// bundled Rudder skills are always enabled at runtime.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub desired_skills: Vec<String>,
    /// Trusted route preparation. Public clients cannot submit this field;
    /// Rust ingress creates it after validating public Agent-create input.
    /// The private bridge may still provide prepared Node-owned compatibility
    /// data while its public cohort remains on the legacy route.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_owned: Option<AgentCreateNodeOwned>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCreatePermissions {
    pub can_create_agents: bool,
    pub can_manage_skills: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCreateNodeOwned {
    /// The Node secrets service's persisted representation. Values are plain
    /// bindings or organization secret references; provider material is never
    /// carried over the AgentCreate boundary.
    pub normalized_agent_runtime_config: Value,
    /// Original validated adapter config used only by the first-Agent
    /// intelligence probe. Persistence still uses the stripped normalized
    /// config above; this transient copy preserves probe inputs such as cwd.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_probe_config: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions_bundle: Option<AgentCreateInstructionsBundle>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intelligence_defaults: Option<AgentCreateIntelligenceDefaults>,
    /// A public create request's first-Agent seeding choice. The public
    /// ingress constructs this flag; it never accepts a caller-prepared
    /// runtime verification result.
    #[serde(default, skip_serializing_if = "is_false")]
    pub seed_intelligence_defaults: bool,
}

fn is_false(value: &bool) -> bool {
    !value
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCreateIntelligenceDefaults {
    #[serde(default = "default_seed_intelligence_defaults")]
    pub seed: bool,
    #[serde(default = "default_intelligence_profile_status")]
    pub status: String,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub last_verified_at: Option<String>,
}

fn default_seed_intelligence_defaults() -> bool {
    true
}
fn default_intelligence_profile_status() -> String {
    "disabled".to_owned()
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCreateInstructionsBundle {
    pub entry_file: String,
    pub files: BTreeMap<String, String>,
    #[serde(default)]
    pub clear_legacy_prompt_template: bool,
}

impl AgentCreateRequest {
    pub fn parse(value: &Value) -> std::result::Result<Self, AgentCoreError> {
        validation::parse_create(value)
    }
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

    /// Run the existing static request validation before authorization when
    /// the legacy route did so. Short-name references defer this until route
    /// resolution, matching the normal AgentCore admission path.
    pub fn validate_static_input(&self) -> std::result::Result<(), AgentCoreError> {
        if self.id.as_deref().is_none_or(uuid_like) {
            validation::validate(
                &self.operation,
                (!self.input_missing).then_some(&self.input),
            )?;
        }
        Ok(())
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
        "inbox" | "me" if actor.actor().kind != "agent" => {
            Err(http(401, "Agent authentication required"))
        }
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
        "create",
        "update",
        "list",
        "detail",
        "me",
        "permissions",
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
        "instructions-path-get",
        "instructions-path-patch",
        "instructions-bundle-get",
        "instructions-bundle-patch",
        "instructions-file-get",
        "instructions-file-put",
        "instructions-file-delete",
    ]
    .contains(&r.operation.as_str())
    {
        return Err(http(400, "Invalid Agent command"));
    }
    if r.id.as_deref().is_none_or(uuid_like) {
        r.validate_static_input()?;
        early_authorization(actor, r)?;
    }
    Ok(())
}
pub async fn execute_agent(
    pool: &PgPool,
    actor: &VerifiedActor,
    r: &AgentCoreRequest,
) -> Result<(u16, String)> {
    execute_agent_inner(pool, actor, r, None, false).await
}

/// Execute a command admitted by native public ingress. The typed credential
/// proof is not part of request JSON and is revalidated within AgentCore's
/// transaction. Private bridge requests retain the existing API above.
pub async fn execute_agent_with_native_auth(
    pool: &PgPool,
    actor: &VerifiedActor,
    r: &AgentCoreRequest,
    native_auth: &dyn NativeAgentAuthorizer,
) -> Result<(u16, String)> {
    execute_agent_inner(pool, actor, r, Some(native_auth), false).await
}

/// Execute a create selected by the public Rust ingress. This explicit
/// authority entry point runs the same transactional AgentCore implementation
/// while enabling its Rust-owned create effects without relying on the old
/// private-bridge pilot gates.
pub async fn execute_public_agent_create_with_native_auth(
    pool: &PgPool,
    actor: &VerifiedActor,
    r: &AgentCoreRequest,
    native_auth: &dyn NativeAgentAuthorizer,
) -> Result<(u16, String)> {
    if r.operation != "create" {
        return Err(common::http(400, "Invalid Agent command"));
    }
    if let Some(prepared) = prepare_public_agent_seed(pool, actor, r, native_auth).await? {
        return execute_agent_inner(pool, actor, &prepared, Some(native_auth), true).await;
    }
    execute_agent_inner(pool, actor, r, Some(native_auth), true).await
}

/// Run the optional first-Agent intelligence preflight in a short authorized
/// read phase. Resolve organization-owned secret references before closing
/// that transaction, then run adapter probes without holding the Agent/issue
/// mutation locks. The create transaction rechecks authorization, first-Agent
/// ownership, and profile existence before applying the prepared result.
async fn prepare_public_agent_seed(
    pool: &PgPool,
    actor: &VerifiedActor,
    r: &AgentCoreRequest,
    native_auth: &dyn NativeAgentAuthorizer,
) -> Result<Option<AgentCoreRequest>> {
    let mut input = validation::validate("create", Some(&r.input))?;
    let mut create = AgentCreateRequest::parse(&input)?;
    let seed = create
        .node_owned
        .as_ref()
        .is_some_and(|node| node.seed_intelligence_defaults);
    if !seed {
        return Ok(None);
    }

    let mut tx = pool.begin().await?;
    let admin = actor.actor().kind == "user"
        && sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM instance_user_roles WHERE user_id=$1 AND role='instance_admin')",
        )
        .bind(&actor.actor().id)
        .fetch_one(&mut *tx)
        .await?;
    if actor.actor().kind == "user" {
        authorize_user(
            &mut tx,
            &Context {
                org: "",
                actor,
                request: r,
                admin,
            },
        )
        .await?;
    }
    let id = resolve_id(&mut tx, actor, r, admin).await?;
    if id.is_some() {
        return Err(common::http(400, "Invalid Agent command"));
    }
    let org = r
        .org_id
        .as_deref()
        .ok_or_else(|| common::http(404, "Agent not found"))?;
    let ctx = Context {
        org,
        actor,
        request: r,
        admin,
    };
    authorize_org(&mut tx, &ctx).await?;
    require_create(&mut tx, &ctx).await?;
    revalidate_native_auth(Some(native_auth), &mut tx, org).await?;

    let mut config_source = create
        .node_owned
        .as_ref()
        .and_then(|node| node.runtime_probe_config.clone())
        .or_else(|| {
            create
                .node_owned
                .as_ref()
                .map(|node| node.normalized_agent_runtime_config.clone())
        })
        .unwrap_or_else(|| create.agent_runtime_config.clone());
    validation::apply_create_defaults(&create.agent_runtime_type, &mut config_source, true)?;
    let normalized_runtime_config =
        validation::normalize_runtime_config(&mut tx, org, &config_source).await?;
    let preparation = intelligence::prepare_public_seed(
        &mut tx,
        org,
        &create.agent_runtime_type,
        &normalized_runtime_config,
    )
    .await?;
    tx.commit().await?;

    if let Some(node) = create.node_owned.as_mut() {
        node.seed_intelligence_defaults = false;
        node.intelligence_defaults = intelligence::finish_public_seed(preparation).await?;
    }
    let Some(Value::Object(node)) = input.get_mut("nodeOwned") else {
        return Err(common::http(
            500,
            "Agent create seed preparation is unavailable",
        ));
    };
    node.insert("seedIntelligenceDefaults".to_owned(), Value::Bool(false));
    node.remove("intelligenceDefaults");
    if let Some(defaults) = create
        .node_owned
        .as_ref()
        .and_then(|node| node.intelligence_defaults.as_ref())
    {
        node.insert(
            "intelligenceDefaults".to_owned(),
            serde_json::to_value(defaults)
                .map_err(|_| common::http(500, "Internal server error"))?,
        );
    }

    let mut prepared = r.clone();
    prepared.input = input;
    Ok(Some(prepared))
}

/// Check whether an already authenticated browser user may inspect Agent
/// runtime configuration in an organization. Public ingress performs the
/// browser credential and organization-scope checks first; this function
/// applies AgentCore's shared config-read permission rule in a read-only
/// transaction for flows that do not have an Agent ID yet.
pub async fn browser_user_can_read_configs(
    pool: &PgPool,
    organization_id: &str,
    user_id: &str,
    local_implicit: bool,
) -> Result<bool> {
    let mut tx = pool.begin().await?;
    let organization_exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM organizations WHERE id=$1::uuid)",
    )
    .bind(organization_id)
    .fetch_one(&mut *tx)
    .await?;
    if !organization_exists {
        tx.commit().await?;
        return Ok(false);
    }
    let admin = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
           SELECT 1 FROM instance_user_roles
           WHERE user_id=$1 AND role='instance_admin'
         )",
    )
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await?;
    let allowed =
        common::can_user_read_configs(&mut tx, organization_id, user_id, local_implicit, admin)
            .await?;
    tx.commit().await?;
    Ok(allowed)
}

async fn execute_agent_inner(
    pool: &PgPool,
    actor: &VerifiedActor,
    r: &AgentCoreRequest,
    native_auth: Option<&dyn NativeAgentAuthorizer>,
    public_agent_create: bool,
) -> Result<(u16, String)> {
    json_boundary::run(async{
        admit_agent(actor,r)?;
        if r.operation == "create" && !public_agent_create && !agent_create_feature_enabled() {
            return Err(http(404, "Rust Agent create authority is disabled"));
        }
        let mut tx=pool.begin().await?;
        let admin=actor.actor().kind=="user"&&sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM instance_user_roles WHERE user_id=$1 AND role='instance_admin')").bind(&actor.actor().id).fetch_one(&mut *tx).await?;
        if actor.actor().kind=="user" { authorize_user(&mut tx,&Context{org:"",actor,request:r,admin}).await?; }
        if r.operation=="scheduler-heartbeats"{
            let ctx=Context{org:"",actor,request:r,admin};let body=reads::scheduler(&mut tx,&ctx).await?;tx.commit().await?;return Ok((200,body.to_string()));
        }
        let id=resolve_id(&mut tx,actor,r,admin).await?;
        let input=validation::validate(&r.operation,(!r.input_missing).then_some(&r.input))?;
        if r.operation == "create"
            && intelligence::requested(&AgentCreateRequest::parse(&input)?)
            && !public_agent_create
            && !intelligence::feature_enabled()
        {
            return Err(http(404, "Rust Agent intelligence/avatar authority is disabled"));
        }
        early_authorization(actor,r)?;
        let current=if let Some(id)=&id{stored(&mut tx,id).await?}else{None};
        if id.is_some()&&current.is_none()&&!matches!(r.operation.as_str(),"keys"|"key-revoke"){return Err(http(404,"Agent not found"));}
        let org=if let Some(row)=&current{text(row,"orgId").to_owned()}else if let Some(org)=&r.org_id{org.clone()}else if r.operation=="key-revoke"{
            sqlx::query_scalar::<_,String>("SELECT org_id::text FROM agent_api_keys WHERE id=$1::uuid AND agent_id=$2::uuid").bind(r.key_id.as_deref()).bind(id.as_deref()).fetch_optional(&mut *tx).await?.ok_or_else(||http(404,"Key not found"))?
        }else if r.operation=="keys"{tx.commit().await?;return Ok((200,"[]".into()))}else{return Err(http(404,"Agent not found"))};
        let ctx=Context{org:&org,actor,request:r,admin};authorize_org(&mut tx,&ctx).await?;
        if r.resolve_only{
            // Native public adapters may need the resolved organization to
            // derive trusted filesystem placement before the final command.
            // Recheck current credentials in this read transaction as well.
            revalidate_native_auth(native_auth, &mut tx, &org).await?;
            tx.commit().await?;return Ok((200,json!({"orgId":org,"id":id}).to_string()))
        }
        let op=r.operation.as_str();let is_write=matches!(op,"create"|"update"|"key-create"|"key-revoke"|"rollback"|"reset-session"|"permissions"|"instructions-path-patch"|"instructions-bundle-patch"|"instructions-file-put"|"instructions-file-delete");
        if is_write{
            // Match runtime admission lock order: Issues, Agents, organization.
            sqlx::query("SELECT id FROM issues WHERE org_id=$1::uuid ORDER BY id FOR UPDATE").bind(&org).execute(&mut *tx).await?;
            sqlx::query("SELECT id FROM agents WHERE org_id=$1::uuid ORDER BY id FOR UPDATE").bind(&org).execute(&mut *tx).await?;
            let fence=sqlx::query_scalar::<_,i64>("SELECT mutation_version FROM organization_mutation_state WHERE org_id=$1::uuid FOR UPDATE").bind(&org).fetch_optional(&mut *tx).await?;
            if fence.is_none(){return Err(http(409,"Organization mutation authority is not provisioned"))}
            // Recheck the credential after all awaited mutation locks, before
            // any helper can write rows or touch the host filesystem. This is
            // especially important for permissions, whose detail projection
            // can resolve host-backed instructions state.
            revalidate_native_auth(native_auth, &mut tx, &org).await?;
            // The pre-lock row is never authority for concurrent transitions.
            let current=if let Some(id)=&id{stored(&mut tx,id).await?}else{None};
            let current=if !matches!(op,"key-revoke"|"update"){if let Some(row)=current{Some(reads::ensure_workspace_key(&mut tx,&ctx,row).await?)}else{None}}else{current};
            if id.is_some()&&current.is_none(){return Err(http(404,"Agent not found"))}
            let fresh_admin=if op=="permissions" && ctx.user().is_some(){sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM instance_user_roles WHERE user_id=$1 AND role='instance_admin')").bind(ctx.user()).fetch_one(&mut *tx).await?}else{ctx.admin};
            let ctx=Context{admin:fresh_admin,..ctx};
            authorize_org(&mut tx,&ctx).await?;
            if op == "create" && public_agent_create {
                require_create(&mut tx, &ctx).await?;
            }
            let body=writes::execute(&mut tx,&ctx,op,current.as_ref(),&input,native_auth,public_agent_create).await?;
            sqlx::query("UPDATE organization_mutation_state SET mutation_version=mutation_version+1,updated_at=now() WHERE org_id=$1::uuid").bind(&org).execute(&mut *tx).await?;
            tx.commit().await?;
            if op == "create" {
                // The Agent row and bundle outbox are committed already. A
                // projection failure here must not become an ambiguous create
                // error that invites duplicate Agent creation. The durable row
                // remains available to the authorized detail-read reconciler;
                // first-send resolution continues to fail closed until then.
                if let (Some(agent_id), Some(_host)) =
                    (body["id"].as_str(), r.instructions_host.as_ref())
                    && instructions::provision_created_agent_after_commit(
                        pool,
                        actor,
                        r,
                        &org,
                        agent_id,
                        native_auth,
                    )
                    .await
                    .is_err()
                    {
                    // The create is already committed, so returning an
                    // error could cause a duplicate retry. Pending bundle
                    // filesystem failures are durably marked `repair` by
                    // library_path; transient authority/database failures
                    // leave the outbox available to an authorized detail
                    // read. Keep the failure observable without logging
                    // host paths or instruction contents.
                    tracing::warn!("created Agent workspace provisioning did not complete; durable recovery remains available");
                }
            } else if matches!(op,"instructions-bundle-patch"|"instructions-file-put"|"instructions-file-delete") {
                instructions::replay_after_commit(pool, actor, r, &org, id.as_deref().unwrap_or_default(), native_auth).await?;
            }
            return Ok((if matches!(op,"create"|"key-create"){201}else{200},body.to_string()));
        }
        if matches!(op,"detail"|"me") {
            sqlx::query("SELECT id FROM agents WHERE org_id=$1::uuid ORDER BY id FOR UPDATE").bind(&org).execute(&mut *tx).await?;
            // Detail can wait behind another Agent transaction, and even a
            // restricted projection may allocate a workspace key. Revalidate
            // the original native credential before either projection path.
            revalidate_native_auth(native_auth, &mut tx, &org).await?;
            let current=stored(&mut tx,id.as_deref().unwrap_or("")).await?.ok_or_else(||http(404,"Agent not found"))?;
            let admin=ctx.user().is_some()&&sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM instance_user_roles WHERE user_id=$1 AND role='instance_admin')").bind(ctx.user()).fetch_one(&mut *tx).await?;
            let ctx=Context{admin,..ctx};authorize_org(&mut tx,&ctx).await?;
            let restricted=ctx.agent().is_some() && ctx.agent()!=id.as_deref() && !can_read_configs(&mut tx,&ctx).await?;
            let row=reads::ensure_workspace_key(&mut tx,&ctx,current).await?;
            let body=detail::build(&mut tx,&ctx,row,restricted,native_auth).await?;tx.commit().await?;return Ok((200,body.to_string()));
        }
        revalidate_native_auth(native_auth, &mut tx, &org).await?;
        let row=current.unwrap_or(Value::Null);
        let row=if !row.is_null()&&!matches!(op,"keys"|"inbox"){reads::ensure_workspace_key(&mut tx,&ctx,row).await?}else{row};
        let body=match op{
            "instructions-path-get"|"instructions-bundle-get"|"instructions-file-get" => instructions::read_operation(&mut tx,&ctx,&row,op,&input,native_auth).await?,
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

async fn revalidate_native_auth(
    native_auth: Option<&dyn NativeAgentAuthorizer>,
    tx: &mut common::Tx<'_>,
    org_id: &str,
) -> Result<()> {
    let Some(native_auth) = native_auth else {
        return Ok(());
    };
    match native_auth.revalidate(tx, org_id).await? {
        NativeAgentAccess::Authorized => Ok(()),
        NativeAgentAccess::Unauthorized => Err(common::http(401, "Unauthorized")),
        NativeAgentAccess::Forbidden => Err(common::http(403, "Forbidden")),
    }
}

fn agent_create_feature_enabled() -> bool {
    std::env::var("RUDDER_AGENT_CREATE_RUST_ENABLED")
        .ok()
        .is_some_and(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            )
        })
}

async fn resolve_id(
    tx: &mut Tx<'_>,
    actor: &VerifiedActor,
    r: &AgentCoreRequest,
    admin: bool,
) -> Result<Option<String>> {
    if matches!(r.operation.as_str(), "inbox" | "me") {
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
    } else if let Some(s) = r.org_id.as_deref().filter(|s| !js_trim(s).is_empty()) {
        // Organization-scoped public routes carry the organization in the
        // path field rather than in the query object. Preserve that scope for
        // short-name resolution before SQL selects a candidate Agent.
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
