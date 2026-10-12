use super::*;

pub(super) async fn workspace(conn: &mut PgConnection, id: &str) -> Result<Option<Value>> {
    let raw = sqlx::query_scalar::<_, String>(
        "SELECT to_jsonb(w)::text FROM execution_workspaces w WHERE id=$1::uuid",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    raw.map(|raw| projection(&raw)).transpose()
}
pub(super) fn projection(raw: &str) -> Result<Value> {
    let row = boundary::parse(raw).map_err(|_| http(500, "Invalid workspace record"))?;
    let mut result = serde_json::Map::new();
    for (key, value) in row
        .as_object()
        .ok_or_else(|| http(500, "Invalid workspace record"))?
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
            && let Some(raw) = value.as_str()
            && let Ok(date) =
                time::OffsetDateTime::parse(raw, &time::format_description::well_known::Rfc3339)
        {
            value = json!(timestamp(date));
        }
        result.insert(key, value);
    }
    let derived = result
        .get("derivedFromExecutionWorkspaceId")
        .cloned()
        .unwrap_or(Value::Null);
    result.insert("derivedFromRunWorkspaceId".into(), derived);
    Ok(Value::Object(result))
}
pub(super) fn timestamp(date: time::OffsetDateTime) -> String {
    let date = date.to_offset(time::UtcOffset::UTC);
    format!(
        "{}.{:03}Z",
        date.format(
            &time::format_description::parse_borrowed::<2>(
                "[year]-[month]-[day]T[hour]:[minute]:[second]"
            )
            .unwrap()
        )
        .unwrap(),
        date.millisecond()
    )
}
pub(super) fn now() -> String {
    timestamp(time::OffsetDateTime::now_utc())
}

/// Fresh PostgreSQL facts are checked after every wait and before each effect.
/// An authenticated ingress assertion is not a durable authorization lease.
pub(super) async fn authorize(
    conn: &mut PgConnection,
    actor: &VerifiedActor,
    req: &Request,
    org: &str,
) -> Result<()> {
    let identity = actor.actor();
    if identity.kind == "agent" {
        let jwt = actor.session_id() == format!("agent-jwt:{}", identity.id);
        let key = actor.session_id().strip_prefix("agent-key:");
        if (!jwt && key.is_none())
            || (jwt
                && (req.credential_expires_at.is_none()
                    || req.authenticated_org_id.is_none()
                    || req.actor_run_id.is_none()))
        {
            return Err(http(401, "Agent authentication required"));
        }
        let (valid, allowed, run_bound): (bool, bool, bool) = sqlx::query_as(
            "SELECT EXISTS(SELECT 1 FROM agents a WHERE a.id::text=$1 AND a.status NOT IN ('terminated','pending_approval') AND (($4 AND a.org_id::text=$5 AND $6::bigint>EXTRACT(EPOCH FROM clock_timestamp())) OR (NOT $4 AND EXISTS(SELECT 1 FROM agent_api_keys k WHERE k.id::text=$2 AND k.agent_id=a.id AND k.org_id=a.org_id AND k.revoked_at IS NULL)))), EXISTS(SELECT 1 FROM agents WHERE id::text=$1 AND org_id::text=$3), (NOT $4 OR EXISTS(SELECT 1 FROM heartbeat_runs WHERE id::text=$7 AND agent_id::text=$1 AND org_id::text=$5))"
        ).bind(&identity.id).bind(key).bind(org).bind(jwt).bind(&req.authenticated_org_id)
            .bind(req.credential_expires_at).bind(&req.actor_run_id).fetch_one(&mut *conn).await?;
        if !valid {
            return Err(http(401, "Agent authentication required"));
        }
        if !allowed {
            return Err(http(403, "Agent key cannot access another organization"));
        }
        if !run_bound {
            return Err(http(
                403,
                "Agent run context is not valid for this organization",
            ));
        }
        return Ok(());
    }
    if identity.kind != "user" {
        return Err(http(401, "Unauthorized"));
    }
    if req.local_implicit && identity.id == "local-board" && actor.session_id() == "local-implicit"
    {
        return Ok(());
    }
    let key = actor.session_id().strip_prefix("board-key:");
    let (valid, allowed): (bool, bool) = sqlx::query_as(
        "SELECT CASE WHEN $3::text IS NOT NULL THEN EXISTS(SELECT 1 FROM board_api_keys WHERE id::text=$3 AND user_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp())) ELSE EXISTS(SELECT 1 FROM session WHERE id=$4 AND user_id=$1 AND expires_at>clock_timestamp()) END, (EXISTS(SELECT 1 FROM instance_user_roles WHERE user_id=$1 AND role='instance_admin') OR EXISTS(SELECT 1 FROM organization_memberships WHERE org_id::text=$2 AND principal_type='user' AND principal_id=$1 AND status='active'))"
    ).bind(&identity.id).bind(org).bind(key).bind(actor.session_id()).fetch_one(&mut *conn).await?;
    if !valid {
        return Err(http(401, "Unauthorized"));
    }
    if !allowed {
        return Err(http(403, "User does not have access to this organization"));
    }
    Ok(())
}

pub(super) async fn update(
    conn: &mut PgConnection,
    id: &str,
    patch: &Value,
    deferred_metadata: Option<&str>,
) -> Result<Value> {
    let mut fields = serde_json::Map::new();
    for (key, value) in patch
        .as_object()
        .ok_or_else(|| http(500, "Invalid internal patch"))?
    {
        let column = match key.as_str() {
            "status" => "status",
            "cleanupEligibleAt" => "cleanup_eligible_at",
            "cleanupReason" => "cleanup_reason",
            "metadata" => "metadata",
            _ => return Err(http(500, "Invalid internal patch field")),
        };
        fields.insert(
            column.into(),
            if key == "cleanupEligibleAt" {
                value
                    .as_str()
                    .map(|date| json!(validation::database_datetime(date)))
                    .unwrap_or(Value::Null)
            } else {
                value.clone()
            },
        );
    }
    fields.insert("updated_at".into(), json!(now()));
    let columns = fields
        .keys()
        .map(|column| {
            if column == "metadata" && deferred_metadata.is_some() {
                "metadata=$3::jsonb".to_owned()
            } else {
                format!("{column}=p.{column}")
            }
        })
        .collect::<Vec<_>>()
        .join(",");
    let query = format!(
        "UPDATE execution_workspaces w SET {columns} FROM jsonb_populate_record(NULL::execution_workspaces,$2::jsonb) p WHERE w.id=$1::uuid RETURNING to_jsonb(w)::text"
    );
    let mut query = sqlx::query_scalar::<_, String>(&query)
        .bind(id)
        .bind(Value::Object(fields).to_string());
    if let Some(raw) = deferred_metadata {
        query = query.bind(raw);
    }
    let raw = query
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| http(404, "Run workspace not found"))?;
    projection(&raw)
}
