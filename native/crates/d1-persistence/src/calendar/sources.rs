use super::audit::audit;
use super::common::object;
use super::common::{
    Audit, OWNER_TYPES, SOURCE_STATUSES, SOURCE_TYPES, VISIBILITIES, date_field, enum_field,
    list_value, optional_text, source_json, string_field, uuid_optional,
};
use super::{Result, http};
use serde_json::{Map, Value, json};
use sqlx::{PgPool, Row};

pub(super) async fn list_sources(pool: &PgPool, org: &str) -> Result<Value> {
    let sql = format!(
        "SELECT {} AS value FROM calendar_sources s WHERE s.org_id=$1::uuid ORDER BY s.type,s.name",
        source_json("s")
    );
    let rows = sqlx::query(&sql).bind(org).fetch_all(pool).await?;
    Ok(Value::Array(
        rows.into_iter()
            .map(list_value)
            .collect::<Result<Vec<_>>>()?,
    ))
}

pub(super) async fn get_source(pool: &PgPool, org: &str, id: &str) -> Result<Option<Value>> {
    let sql = format!(
        "SELECT {} AS value FROM calendar_sources s WHERE s.id=$1::uuid AND s.org_id=$2::uuid",
        source_json("s")
    );
    let row = sqlx::query(&sql)
        .bind(id)
        .bind(org)
        .fetch_optional(pool)
        .await?;
    row.map(list_value).transpose()
}

pub(super) fn source_input(value: &Value, partial: bool) -> Result<Map<String, Value>> {
    let _ = object(value)?;
    let mut out = Map::new();
    for (key, allowed, default) in [
        ("type", SOURCE_TYPES, Some("rudder_local")),
        ("ownerType", OWNER_TYPES, Some("user")),
        ("visibilityDefault", VISIBILITIES, Some("full")),
        ("status", SOURCE_STATUSES, Some("active")),
    ] {
        if let Some(v) = enum_field(value, key, allowed, if partial { None } else { default })? {
            out.insert(key.into(), Value::String(v));
        }
    }
    if let Some(name) = string_field(value, "name", 1, 160)? {
        out.insert("name".into(), Value::String(name));
    } else if !partial {
        return Err(http(400, "Validation error"));
    }
    for key in ["ownerAgentId"] {
        if let Some(id) = uuid_optional(value, key)? {
            out.insert(key.into(), id.map(Value::String).unwrap_or(Value::Null));
        }
    }
    for key in ["ownerUserId", "externalProvider", "externalCalendarId"] {
        if let Some(v) = optional_text(value, key)? {
            if let Some(text) = &v {
                let length = text.encode_utf16().count();
                let max = match key {
                    "externalProvider" => 80,
                    "externalCalendarId" => 512,
                    _ => usize::MAX,
                };
                if length < 1 || length > max {
                    return Err(http(400, "Validation error"));
                }
            }
            out.insert(key.into(), v.map(Value::String).unwrap_or(Value::Null));
        }
    }
    if let Some(cursor) = value.get("syncCursorJson") {
        if !cursor.is_null() && !cursor.is_object() {
            return Err(http(400, "Validation error"));
        }
        out.insert("syncCursorJson".into(), cursor.clone());
    }
    if let Some(last) = date_field(value, "lastSyncedAt", false)? {
        out.insert("lastSyncedAt".into(), Value::String(last));
    } else if value.get("lastSyncedAt").is_some_and(Value::is_null) {
        out.insert("lastSyncedAt".into(), Value::Null);
    }
    Ok(out)
}

pub(super) async fn source_create(
    pool: &PgPool,
    org: &str,
    audit_ctx: &Audit,
    input: &Value,
) -> Result<Value> {
    let data = source_input(input, false)?;
    if let Some(id) = data.get("ownerAgentId").and_then(Value::as_str) {
        let row = sqlx::query("SELECT org_id::text,status FROM agents WHERE id=$1::uuid")
            .bind(id)
            .fetch_optional(pool)
            .await?;
        let Some(row) = row else {
            return Err(http(404, "Agent not found"));
        };
        let agent_org: String = row.try_get("org_id")?;
        let agent_status: String = row.try_get("status")?;
        if agent_org != org {
            return Err(http(422, "Agent must belong to same organization"));
        }
        if agent_status == "terminated" {
            return Err(http(
                409,
                "Cannot create calendar blocks for terminated agents",
            ));
        }
    }
    let cursor = data
        .get("syncCursorJson")
        .filter(|value| !value.is_null())
        .map(serde_json::to_string)
        .transpose()
        .map_err(|_| http(400, "Validation error"))?;
    let mut tx = pool.begin().await?;
    let row = sqlx::query("INSERT INTO calendar_sources (org_id,type,name,owner_type,owner_user_id,owner_agent_id,external_provider,external_calendar_id,visibility_default,status,sync_cursor_json) VALUES ($1::uuid,$2,$3,$4,$5,$6::uuid,$7,$8,$9,$10,$11::jsonb) RETURNING id::text")
        .bind(org).bind(data["type"].as_str()).bind(data["name"].as_str()).bind(data["ownerType"].as_str())
        .bind(data.get("ownerUserId").and_then(Value::as_str).or(Some(audit_ctx.actor_id.as_str())))
        .bind(data.get("ownerAgentId").and_then(Value::as_str))
        .bind(data.get("externalProvider").and_then(Value::as_str)).bind(data.get("externalCalendarId").and_then(Value::as_str))
        .bind(data["visibilityDefault"].as_str()).bind(data["status"].as_str()).bind(cursor)
        .fetch_one(&mut *tx).await?;
    let id: String = row.try_get("id")?;
    let source = {
        let sql = format!(
            "SELECT {} AS value FROM calendar_sources s WHERE s.id=$1::uuid AND s.org_id=$2::uuid",
            source_json("s")
        );
        let row = sqlx::query(&sql)
            .bind(&id)
            .bind(org)
            .fetch_optional(&mut *tx)
            .await?;
        row.map(list_value)
            .transpose()?
            .ok_or_else(|| http(500, "Internal server error"))?
    };
    let details = json!({"name":source["name"],"type":source["type"],"visibilityDefault":source["visibilityDefault"]});
    audit(
        &mut tx,
        org,
        audit_ctx,
        "calendar.source_created",
        "calendar_source",
        &id,
        Some(&details),
    )
    .await?;
    tx.commit().await?;
    Ok(source)
}

pub(super) async fn source_update(
    pool: &PgPool,
    org: &str,
    audit_ctx: &Audit,
    id: &str,
    input: &Value,
) -> Result<Value> {
    let data = source_input(input, true)?;
    let existing = get_source(pool, org, id)
        .await?
        .ok_or_else(|| http(404, "Calendar source not found"))?;
    if let Some(agent) = data.get("ownerAgentId").and_then(Value::as_str) {
        let row = sqlx::query("SELECT org_id::text,status FROM agents WHERE id=$1::uuid")
            .bind(agent)
            .fetch_optional(pool)
            .await?;
        let Some(row) = row else {
            return Err(http(404, "Agent not found"));
        };
        let agent_org: String = row.try_get("org_id")?;
        let agent_status: String = row.try_get("status")?;
        if agent_org != org {
            return Err(http(422, "Agent must belong to same organization"));
        }
        if agent_status == "terminated" {
            return Err(http(
                409,
                "Cannot create calendar blocks for terminated agents",
            ));
        }
    }
    let owner_user = data
        .get("ownerUserId")
        .and_then(Value::as_str)
        .or_else(|| existing["ownerUserId"].as_str())
        .or(Some(audit_ctx.actor_id.as_str()));
    // Preserve nullable fields exactly: null clears the external values/cursor, while null ownerUserId falls back to the stored owner.
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE calendar_sources SET type=CASE WHEN $3::jsonb ? 'type' THEN ($3::jsonb)->>'type' ELSE type END,name=CASE WHEN $3::jsonb ? 'name' THEN ($3::jsonb)->>'name' ELSE name END,owner_type=CASE WHEN $3::jsonb ? 'ownerType' THEN ($3::jsonb)->>'ownerType' ELSE owner_type END,owner_user_id=$4,owner_agent_id=CASE WHEN $3::jsonb ? 'ownerAgentId' THEN NULLIF(($3::jsonb)->>'ownerAgentId','')::uuid ELSE owner_agent_id END,external_provider=CASE WHEN $3::jsonb ? 'externalProvider' THEN ($3::jsonb)->>'externalProvider' ELSE external_provider END,external_calendar_id=CASE WHEN $3::jsonb ? 'externalCalendarId' THEN ($3::jsonb)->>'externalCalendarId' ELSE external_calendar_id END,visibility_default=CASE WHEN $3::jsonb ? 'visibilityDefault' THEN ($3::jsonb)->>'visibilityDefault' ELSE visibility_default END,status=CASE WHEN $3::jsonb ? 'status' THEN ($3::jsonb)->>'status' ELSE status END,last_synced_at=CASE WHEN $3::jsonb ? 'lastSyncedAt' THEN NULLIF(($3::jsonb)->>'lastSyncedAt','')::timestamptz ELSE last_synced_at END,sync_cursor_json=CASE WHEN $3::jsonb ? 'syncCursorJson' THEN CASE WHEN ($3::jsonb)->'syncCursorJson' = 'null'::jsonb THEN NULL ELSE ($3::jsonb)->'syncCursorJson' END ELSE sync_cursor_json END,updated_at=now() WHERE id=$1::uuid AND org_id=$2::uuid")
        .bind(id).bind(org).bind(serde_json::to_string(&data).map_err(|_| http(400,"Validation error"))?).bind(owner_user).execute(&mut *tx).await?;
    let updated = {
        let sql = format!(
            "SELECT {} AS value FROM calendar_sources s WHERE s.id=$1::uuid AND s.org_id=$2::uuid",
            source_json("s")
        );
        let row = sqlx::query(&sql)
            .bind(id)
            .bind(org)
            .fetch_optional(&mut *tx)
            .await?;
        row.map(list_value)
            .transpose()?
            .ok_or_else(|| http(404, "Calendar source not found"))?
    };
    let details = json!({"name":updated["name"],"status":updated["status"],"visibilityDefault":updated["visibilityDefault"]});
    audit(
        &mut tx,
        org,
        audit_ctx,
        "calendar.source_updated",
        "calendar_source",
        id,
        Some(&details),
    )
    .await?;
    tx.commit().await?;
    Ok(updated)
}

pub(super) async fn source_delete(
    pool: &PgPool,
    org: &str,
    audit_ctx: &Audit,
    id: &str,
) -> Result<Value> {
    let mut tx = pool.begin().await?;
    let result = sqlx::query("DELETE FROM calendar_sources WHERE id=$1::uuid AND org_id=$2::uuid")
        .bind(id)
        .bind(org)
        .execute(&mut *tx)
        .await?;
    if result.rows_affected() == 0 {
        return Err(http(404, "Calendar source not found"));
    }
    audit(
        &mut tx,
        org,
        audit_ctx,
        "calendar.source_deleted",
        "calendar_source",
        id,
        None,
    )
    .await?;
    tx.commit().await?;
    Ok(json!({"ok":true}))
}
