use super::{AgentCreateRequest, common::*, constants::*, reads, redaction};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;
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
    native_auth: Option<&dyn super::NativeAgentAuthorizer>,
    public_agent_create: bool,
) -> Result<Value> {
    if op == "create" {
        return create(tx, ctx, input, public_agent_create).await;
    }
    let row = current.ok_or_else(|| http(404, "Agent not found"))?;
    let id = text(row, "id");
    match op {
        "instructions-path-patch"
        | "instructions-bundle-patch"
        | "instructions-file-put"
        | "instructions-file-delete" => {
            super::instructions::write_operation(tx, ctx, row, op, input, native_auth).await
        }
        "permissions" => super::detail::update_permissions(tx, ctx, row, input, native_auth).await,
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
            activity(
                tx,
                ctx,
                "agent.key_revoked",
                id,
                Some(&json!({"keyId":ctx.request.key_id})),
            )
            .await?;
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

async fn create(
    tx: &mut Tx<'_>,
    ctx: &Context<'_>,
    input: &Value,
    public_agent_create: bool,
) -> Result<Value> {
    let request = AgentCreateRequest::parse(input)?;
    let config_source = request
        .node_owned
        .as_ref()
        .map(|prepared| &prepared.normalized_agent_runtime_config)
        .unwrap_or(&request.agent_runtime_config);
    let mut config_source = config_source.clone();
    super::validation::apply_create_defaults(
        &request.agent_runtime_type,
        &mut config_source,
        public_agent_create,
    )?;
    let normalized_runtime_config =
        super::validation::normalize_runtime_config(tx, ctx.org, &config_source).await?;
    let requested_name = request
        .name
        .as_deref()
        .map(js_trim)
        .filter(|value| !value.is_empty());
    let base_name = match requested_name {
        Some(value) => value.to_owned(),
        None => suggest_name(tx, ctx.org).await?,
    };
    let existing_names = sqlx::query_scalar::<_, String>(
        "SELECT name FROM agents WHERE org_id=$1::uuid AND status<>'terminated'",
    )
    .bind(ctx.org)
    .fetch_all(&mut **tx)
    .await?;
    let unique_name = deduplicate_name(&base_name, &existing_names);
    let icon = normalize_avatar_icon(
        request
            .node_owned
            .as_ref()
            .and_then(|node| node.avatar_icon.as_deref()),
    )?;
    assert_avatar_asset_belongs_to_org(tx, ctx.org, &icon).await?;

    // Generate the id in PostgreSQL so the same transaction owns the id,
    // workspace key, row, membership, grant, activity, and budget policy.
    let id = sqlx::query_scalar::<_, String>(
        "INSERT INTO agents
           (org_id,name,role,title,icon,capabilities,agent_runtime_type,agent_runtime_config,runtime_config,
            budget_monthly_cents,spent_monthly_cents,permissions,metadata,status,last_heartbeat_at)
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,0,$11::jsonb,$12::jsonb,'idle',NULL)
         RETURNING id::text",
    )
    .bind(ctx.org)
    .bind(&unique_name)
    .bind(&request.role)
    .bind(request.title.as_deref())
    .bind(&icon)
    .bind(request.capabilities.as_deref())
    .bind(&request.agent_runtime_type)
    .bind(normalized_runtime_config.to_string())
    .bind(request.runtime_config.to_string())
    .bind(request.budget_monthly_cents as i32)
    .bind(serde_json::to_string(&request.permissions).map_err(|_| http(500, "Internal server error"))?)
    .bind(request.metadata.as_ref().map(Value::to_string))
    .fetch_one(&mut **tx)
    .await?;

    let existing_keys = sqlx::query_scalar::<_, String>(
        "SELECT workspace_key FROM agents WHERE org_id=$1::uuid AND id<>$2::uuid AND workspace_key IS NOT NULL",
    )
    .bind(ctx.org)
    .bind(&id)
    .fetch_all(&mut **tx)
    .await?
    .into_iter()
    .filter(|key| !key.trim().is_empty())
    .collect::<std::collections::BTreeSet<_>>();
    let workspace_key = derive_workspace_key(&unique_name, &id, &existing_keys)?;
    sqlx::query(
        "UPDATE agents SET workspace_key=$1,updated_at=now() WHERE org_id=$2::uuid AND id=$3::uuid",
    )
    .bind(&workspace_key)
    .bind(ctx.org)
    .bind(&id)
    .execute(&mut **tx)
    .await?;

    // The instruction plan is an outbox row in the same Agent transaction.
    // No host filesystem call is allowed before commit; a later detail read
    // or recovery worker can replay the row without changing Agent identity.
    if (public_agent_create || super::instructions::create_feature_enabled())
        && let Some(bundle) = request
            .node_owned
            .as_ref()
            .and_then(|node| node.instructions_bundle.as_ref())
    {
        super::instructions::enqueue_create_bundle(tx, ctx.org, &id, bundle).await?;
    }

    // Every created Agent is an active organization principal and receives
    // the same default task-assignment grant as the Node route.
    sqlx::query("INSERT INTO organization_memberships(org_id,principal_type,principal_id,membership_role,status) VALUES($1::uuid,'agent',$2,'member','active') ON CONFLICT(org_id,principal_type,principal_id) DO UPDATE SET membership_role='member',status='active',updated_at=now()")
        .bind(ctx.org)
        .bind(&id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("INSERT INTO principal_permission_grants(org_id,principal_type,principal_id,permission_key,scope,granted_by_user_id) VALUES($1::uuid,'agent',$2,'tasks:assign',NULL,$3) ON CONFLICT(org_id,principal_type,principal_id,permission_key) DO UPDATE SET scope=NULL,granted_by_user_id=excluded.granted_by_user_id,updated_at=now()")
        .bind(ctx.org)
        .bind(&id)
        .bind(ctx.user())
        .execute(&mut **tx)
        .await?;

    // Public Rust creates apply validated skill selection in the same
    // transaction. The private compatibility bridge retains its pilot gate.
    if public_agent_create || super::agent_create_feature_enabled() {
        super::skills::assign_desired_skills(
            tx,
            ctx.org,
            &id,
            &request,
            &normalized_runtime_config,
        )
        .await?;
    }

    if public_agent_create || super::intelligence::feature_enabled() {
        super::intelligence::ensure_default(tx, ctx.org, &id, &request, &normalized_runtime_config)
            .await?;
    }

    if request.budget_monthly_cents > 0 {
        sqlx::query("INSERT INTO budget_policies(org_id,scope_type,scope_id,metric,window_kind,amount,warn_percent,hard_stop_enabled,notify_enabled,is_active,created_by_user_id,updated_by_user_id) VALUES($1::uuid,'agent',$2::uuid,'billed_cents','calendar_month_utc',$3,80,true,true,true,$4,$4) ON CONFLICT(org_id,scope_type,scope_id,metric,window_kind) DO UPDATE SET amount=excluded.amount,warn_percent=excluded.warn_percent,hard_stop_enabled=excluded.hard_stop_enabled,notify_enabled=excluded.notify_enabled,is_active=true,updated_by_user_id=excluded.updated_by_user_id,updated_at=now()")
            .bind(ctx.org)
            .bind(&id)
            .bind(request.budget_monthly_cents as i32)
            .bind(ctx.user())
            .execute(&mut **tx)
            .await?;
    }

    // The public Rust create path applies the existing managed MCP helper in
    // the Agent transaction; private bridge callers retain the pilot gate.
    if public_agent_create || super::managed_mcp::feature_enabled() {
        super::managed_mcp::ensure_default_bindings_for_agent(tx, ctx.org, &id).await?;
    }

    activity(
        tx,
        ctx,
        "agent.created",
        &id,
        Some(&json!({
            "name": unique_name,
            "role": request.role,
            "workspaceKey": workspace_key,
            "budgetMonthlyCents": request.budget_monthly_cents,
        })),
    )
    .await?;
    let row = match stored(tx, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Err(http(500, "Agent create did not persist")),
        Err(error) => return Err(error),
    };
    match reads::public_row(tx, row, true, false).await {
        Ok(value) => Ok(value),
        Err(error) => Err(error),
    }
}

fn default_avatar_icon() -> Result<String> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| http(503, "Secure randomness is unavailable"))?;
    // Match UUID v4 formatting used by the shared Oreo avatar validator.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!("oreo:bloom:rose-milk:{}", Uuid::from_bytes(bytes)))
}

fn valid_background(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "mist" | "slate" | "sky" | "mint" | "peach" | "violet"
    )
}

fn split_avatar_background(value: &str) -> (&str, Option<&str>) {
    let lower = value.to_ascii_lowercase();
    let Some(index) = lower.find("?bg=") else {
        return (value, None);
    };
    (&value[..index], Some(&value[index + 4..]))
}

fn valid_uuid_suffix(value: &str) -> bool {
    let (uuid, background) = split_avatar_background(value);
    uuid_like(uuid) && background.is_none_or(valid_background)
}

fn extract_avatar_asset_id(icon: &str) -> Option<&str> {
    let prefix = icon.get(..6)?;
    if !prefix.eq_ignore_ascii_case("asset:") {
        return None;
    }
    let value = &icon[6..];
    let (uuid, _) = split_avatar_background(value);
    (valid_uuid_suffix(value) && uuid_like(uuid)).then_some(uuid)
}

pub(super) fn supported_avatar_icon(icon: &str) -> bool {
    let lowered = icon.to_ascii_lowercase();
    if let Some(value) = lowered.strip_prefix("oreo:") {
        let mut parts = value.split(':');
        let shape = parts.next();
        let palette = parts.next();
        let uuid = parts.next();
        return parts.next().is_none()
            && matches!(
                shape,
                Some("bloom" | "silk" | "flare" | "nova" | "void" | "jade")
            )
            && matches!(
                palette,
                Some(
                    "rose-milk"
                        | "peach-cream"
                        | "mint-milk"
                        | "aurora-pink"
                        | "lilac-silk"
                        | "blue-cream"
                        | "jade-cream"
                        | "coral-mist"
                        | "lemon-mint"
                        | "violet-peach"
                        | "magenta-void"
                        | "teal-void"
                        | "amber-dusk"
                        | "sky-melon"
                        | "grapefruit"
                        | "lavender-lime"
                        | "aqua-orchid"
                        | "honeydew"
                        | "plum-gold"
                        | "ice-berry"
                        | "apricot-mint"
                        | "candy-blue"
                        | "raspberry-cream"
                        | "spring-glow"
                        | "sunset-punch"
                        | "moon-pearl"
                        | "seafoam-rose"
                        | "blueberry-milk"
                        | "mango-iris"
                        | "forest-neon"
                        | "cotton-candy"
                        | "lime-sorbet"
                        | "cherry-cola"
                        | "opal-mint"
                        | "peach-lilac"
                        | "cyan-flame"
                        | "orchid-night"
                        | "pistachio-blush"
                        | "lagoon-gold"
                        | "vanilla-sky"
                )
            )
            && uuid.is_some_and(uuid_like);
    }
    ["dicebear:notionists:", "asset:"]
        .iter()
        .find_map(|prefix| lowered.strip_prefix(prefix))
        .is_some_and(valid_uuid_suffix)
}

fn normalize_avatar_icon(icon: Option<&str>) -> Result<String> {
    let Some(icon) = icon.map(str::trim).filter(|value| !value.is_empty()) else {
        return default_avatar_icon();
    };
    if supported_avatar_icon(icon) {
        return Ok(icon.to_owned());
    }
    Err(http(422, "Invalid avatar reference"))
}

async fn assert_avatar_asset_belongs_to_org(tx: &mut Tx<'_>, org: &str, icon: &str) -> Result<()> {
    let Some(asset_id) = extract_avatar_asset_id(icon) else {
        return Ok(());
    };
    let asset = sqlx::query_as::<_, (String, String)>(
        "SELECT org_id::text,content_type FROM assets WHERE id=$1::uuid",
    )
    .bind(asset_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((asset_org, content_type)) = asset else {
        return Err(http(422, "Avatar asset not found"));
    };
    if asset_org != org {
        return Err(http(403, "Avatar asset belongs to another organization"));
    }
    if !content_type.to_ascii_lowercase().starts_with("image/") {
        return Err(http(422, "Avatar asset must be an image"));
    }
    Ok(())
}

fn deduplicate_name(base: &str, existing: &[String]) -> String {
    if !existing.iter().any(|name| slug(name) == slug(base)) {
        return base.to_owned();
    }
    for suffix in 2..=100 {
        let candidate = format!("{base} {suffix}");
        if !existing.iter().any(|name| slug(name) == slug(&candidate)) {
            return candidate;
        }
    }
    format!(
        "{base} {}",
        time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000
    )
}

fn derive_workspace_key(
    name: &str,
    id: &str,
    existing: &std::collections::BTreeSet<String>,
) -> Result<String> {
    let slug_name = slug(name);
    let slug_name = if slug_name.is_empty() {
        "agent"
    } else {
        &slug_name
    };
    let hex_id = id.replace('-', "");
    let mut length = 8usize;
    while length <= hex_id.len() {
        let candidate = format!("{slug_name}--{}", &hex_id[..length]);
        if !existing.contains(&candidate) {
            return Ok(candidate);
        }
        if length == hex_id.len() {
            break;
        }
        length = (length + 4).min(hex_id.len());
    }
    Err(http(
        500,
        "Unable to allocate unique workspace key for agent",
    ))
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

#[cfg(test)]
mod avatar_tests {
    use super::super::AgentCoreError;
    use super::*;

    #[test]
    fn supported_avatar_refs_match_case_insensitively_and_preserve_input() {
        let asset = "ASSET:40000000-0000-4000-8000-000000000001?BG=MIST";
        assert_eq!(normalize_avatar_icon(Some(asset)).expect("asset"), asset);
        let oreo = "OREO:BLOOM:ROSE-MILK:40000000-0000-4000-8000-000000000001";
        assert_eq!(normalize_avatar_icon(Some(oreo)).expect("oreo"), oreo);
        let dicebear = "DICEBEAR:NOTIONISTS:40000000-0000-4000-8000-000000000001?Bg=Slate";
        assert_eq!(
            normalize_avatar_icon(Some(dicebear)).expect("dicebear"),
            dicebear
        );
    }

    #[test]
    fn malformed_private_avatar_refs_are_rejected() {
        for icon in [
            "asset:not-a-uuid",
            "asset:40000000-0000-4000-8000-000000000001?bg=unknown",
            "notionists:40000000-0000-4000-8000-000000000001",
            "oreo:legacy:rose-milk:40000000-0000-4000-8000-000000000001",
        ] {
            assert!(
                matches!(
                    normalize_avatar_icon(Some(icon)),
                    Err(AgentCoreError::Http(422, _, _))
                ),
                "{icon}"
            );
        }
    }
}
