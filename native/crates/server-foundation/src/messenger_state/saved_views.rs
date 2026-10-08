use super::{
    protocol::{ListQuery, SavedPatch, Visibility},
    store::*,
};
use rudder_d1_persistence::legacy_read_json::normalize_legacy_read_json;
use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool};

pub(super) const PROJECTION: &str = r#"jsonb_build_object(
'id',v.id::text,'orgId',v.org_id::text,'userId',v.user_id,'targetKind',v.target_kind,'targetPayload',v.target_payload,
'resourceKey',v.resource_key,'instanceId',v.instance_id,'canonicalResourceKey',v.canonical_resource_key,'clientMutationId',v.client_mutation_id::text,
 'title',v.title,'subtitle',v.subtitle,'favicon',v.favicon,'sortOrder',v.sort_order,
'hiddenAt',to_char(v.hidden_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
'primaryRailPinnedAt',to_char(v.primary_rail_pinned_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
'createdAt',to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
'updatedAt',to_char(v.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))"#;

pub(super) async fn find(db: &mut PgConnection, s: &Scope<'_>, id: &str) -> Result<Option<Value>> {
    let raw=sqlx::query_scalar::<_,String>(&format!("SELECT ({PROJECTION})::text FROM messenger_saved_views v WHERE org_id=$1::uuid AND user_id=$2 AND id=$3::uuid"))
        .bind(s.org).bind(s.user).bind(id).fetch_optional(db).await?;
    raw.as_deref().map(decode).transpose()
}
pub(super) async fn get(pool: &PgPool, s: &Scope<'_>, id: &str) -> Result<String> {
    let raw=sqlx::query_scalar::<_,String>(&format!("SELECT ({PROJECTION})::text FROM messenger_saved_views v WHERE org_id=$1::uuid AND user_id=$2 AND id=$3::uuid"))
        .bind(s.org).bind(s.user).bind(id).fetch_optional(pool).await?.ok_or_else(missing_saved)?;
    Ok(normalize_legacy_read_json(&raw)?)
}
pub(super) async fn list(pool: &PgPool, s: &Scope<'_>, q: &ListQuery) -> Result<String> {
    list_db(&mut *pool.acquire().await?, s, q).await
}
pub(super) async fn list_db(db: &mut PgConnection, s: &Scope<'_>, q: &ListQuery) -> Result<String> {
    let (limit, offset) = (q.limit.unwrap_or(50), q.offset.unwrap_or(0));
    let visibility = match q.visibility {
        Some(Visibility::Hidden) => "AND hidden_at IS NOT NULL",
        Some(Visibility::All) => "",
        _ => "AND hidden_at IS NULL",
    };
    let pin = if q.primary_rail_pinned == Some(true) {
        "AND primary_rail_pinned_at IS NOT NULL"
    } else {
        ""
    };
    // An opaque SQL projection preserves deep legacy target JSON without
    // recursive decoding, while metadata uses JavaScript millisecond dates.
    let raw=sqlx::query_scalar::<_,String>(&format!(r#"WITH selected AS MATERIALIZED (
SELECT v.* FROM messenger_saved_views v WHERE org_id=$1::uuid AND user_id=$2 {visibility} {pin}
), page AS (SELECT ({PROJECTION}) AS payload, sort_order, created_at FROM selected v ORDER BY sort_order,created_at LIMIT $3 OFFSET $4),
result AS (SELECT COALESCE(jsonb_agg(payload ORDER BY sort_order,created_at),'[]'::jsonb) AS items FROM page), total AS (SELECT count(*) AS n FROM selected)
SELECT jsonb_build_object('items',items,'pageInfo',jsonb_build_object('limit',$3::bigint,'offset',$4::bigint,'total',n,'hasMore',$4+jsonb_array_length(items)<n,'nextOffset',CASE WHEN $4+jsonb_array_length(items)<n THEN $4+jsonb_array_length(items) ELSE NULL END))::text FROM result,total"#))
        .bind(s.org).bind(s.user).bind(i64::from(limit)).bind(offset as i64).fetch_one(db).await?;
    Ok(normalize_legacy_read_json(&raw)?)
}
pub(super) async fn pin_limit(tx: &mut Tx<'_>, s: &Scope<'_>) -> Result<()> {
    let n=sqlx::query_scalar::<_,i64>("SELECT count(*) FROM messenger_saved_views WHERE org_id=$1::uuid AND user_id=$2 AND primary_rail_pinned_at IS NOT NULL")
        .bind(s.org).bind(s.user).fetch_one(&mut **tx).await?;
    if n >= 100 {
        return Err(Error::Http(
            400,
            "Primary Rail supports up to 100 pinned Local Apps",
        ));
    }
    Ok(())
}
pub(super) async fn update(
    tx: &mut Tx<'_>,
    s: &Scope<'_>,
    id: &str,
    p: &SavedPatch,
) -> Result<String> {
    if p.hidden == Some(true) {
        return Err(Error::Http(400, "Messenger Saved Views cannot be hidden"));
    }
    let old = find(&mut *tx, s, id).await?.ok_or_else(missing_saved)?;
    if p.primary_rail_pinned.is_some() && old["targetKind"] != "local_app" {
        return Err(Error::Http(
            400,
            "Only Local App Saved Views can be pinned to the Primary Rail",
        ));
    }
    if p.primary_rail_pinned == Some(true) && old["primaryRailPinnedAt"].is_null() {
        pin_limit(tx, s).await?;
    }
    if let Some(t) = &p.target
        && (t.instance() != field(&old, "instanceId")
            || t.canonical() != field(&old, "canonicalResourceKey"))
    {
        return Err(Error::Http(
            400,
            "Saved View target identity cannot be changed",
        ));
    }
    let target = p.target.as_ref().map(|t| t.value().to_string());
    sqlx::query("UPDATE messenger_saved_views SET target_kind=CASE WHEN $4::jsonb IS NULL THEN target_kind ELSE $4::jsonb->>'kind' END,target_payload=COALESCE($4::jsonb,target_payload),title=COALESCE($5,title),subtitle=CASE WHEN $6 THEN $7 ELSE subtitle END,favicon=CASE WHEN $8 THEN $9 ELSE favicon END,hidden_at=CASE WHEN $10 THEN NULL ELSE hidden_at END,primary_rail_pinned_at=CASE WHEN $11::boolean IS NULL THEN primary_rail_pinned_at WHEN $11 THEN current_setting('rudder.messenger_now')::timestamptz ELSE NULL END,updated_at=current_setting('rudder.messenger_now')::timestamptz WHERE org_id=$1::uuid AND user_id=$2 AND id=$3::uuid")
        .bind(s.org).bind(s.user).bind(id).bind(target).bind(&p.title).bind(p.subtitle.present()).bind(p.subtitle.value()).bind(p.favicon.present()).bind(p.favicon.value()).bind(p.hidden==Some(false)).bind(p.primary_rail_pinned).execute(&mut **tx).await?;
    let row = find(&mut *tx, s, id).await?.ok_or_else(missing_saved)?;
    let action = if !old["hiddenAt"].is_null() && row["hiddenAt"].is_null() {
        "messenger.saved_view_restored"
    } else {
        "messenger.saved_view_updated"
    };
    saved_activity(
        tx,
        s,
        action,
        &row,
        p.primary_rail_pinned
            .map_or(json!({}), |v| json!({"primaryRailPinned":v})),
    )
    .await?;
    encode(&row)
}
pub(super) async fn remove(tx: &mut Tx<'_>, s: &Scope<'_>, id: &str) -> Result<String> {
    let old = find(&mut *tx, s, id).await?.ok_or_else(missing_saved)?;
    let key = format!("saved-view:{}", field(&old, "id"));
    let group = membership(&mut *tx, s, &key).await?;
    group_locks(tx, s, &group.iter().cloned().collect::<Vec<_>>()).await?;
    sqlx::query("DELETE FROM messenger_custom_group_entries WHERE org_id=$1::uuid AND user_id=$2 AND thread_key=$3")
        .bind(s.org).bind(s.user).bind(key).execute(&mut **tx).await?;
    if let Some(group) = group {
        delete_empty(tx, s, &group).await?;
    }
    sqlx::query(
        "DELETE FROM messenger_saved_views WHERE org_id=$1::uuid AND user_id=$2 AND id=$3::uuid",
    )
    .bind(s.org)
    .bind(s.user)
    .bind(id)
    .execute(&mut **tx)
    .await?;
    saved_activity(tx, s, "messenger.saved_view_deleted", &old, json!({})).await?;
    encode(&old)
}
pub(super) async fn reorder(tx: &mut Tx<'_>, s: &Scope<'_>, ids: &[String]) -> Result<String> {
    let rows=sqlx::query_scalar::<_,String>("SELECT jsonb_build_object('id',id::text,'sortOrder',sort_order,'targetKind',target_kind,'resourceKey',resource_key)::text FROM messenger_saved_views WHERE org_id=$1::uuid AND user_id=$2 AND hidden_at IS NULL ORDER BY sort_order,created_at")
        .bind(s.org).bind(s.user).fetch_all(&mut **tx).await?.iter().map(|raw|decode(raw)).collect::<Result<Vec<_>>>()?;
    if ids
        .iter()
        .any(|id| !rows.iter().any(|r| field(r, "id") == id))
    {
        return Err(missing_saved());
    }
    let mut ordered = ids.to_vec();
    ordered.extend(
        rows.iter()
            .map(|r| field(r, "id").to_owned())
            .filter(|id| !ids.contains(id)),
    );
    // Hidden rows reserve their exact old slots. Omitted visible rows follow
    // requested rows, preserving the old partial-reorder contract.
    for (id, slot) in ordered.iter().zip(rows.iter()) {
        sqlx::query("UPDATE messenger_saved_views SET sort_order=$4,updated_at=current_setting('rudder.messenger_now')::timestamptz WHERE org_id=$1::uuid AND user_id=$2 AND id=$3::uuid")
            .bind(s.org).bind(s.user).bind(id).bind(slot["sortOrder"].as_i64().unwrap_or(0) as i32).execute(&mut **tx).await?;
    }
    if let Some(row) = ids
        .first()
        .and_then(|id| rows.iter().find(|r| field(r, "id") == id))
    {
        saved_activity(
            tx,
            s,
            "messenger.saved_views_reordered",
            row,
            json!({"ids":ordered}),
        )
        .await?;
    }
    list_db(&mut *tx, s, &ListQuery::default()).await
}
