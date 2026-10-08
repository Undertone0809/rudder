use super::{audit, protocol::GroupPatch, saved_views, store::*};
use serde_json::{Value, json};
use sqlx::PgConnection;

pub(super) const PROJECTION: &str = r#"jsonb_build_object('id',g.id::text,'orgId',g.org_id::text,'userId',g.user_id,'name',g.name,'icon',g.icon,'sortOrder',g.sort_order,'collapsed',g.collapsed,
'pinnedAt',to_char(g.pinned_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
'createdAt',to_char(g.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
'updatedAt',to_char(g.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))"#;
pub(super) async fn find(db: &mut PgConnection, s: &Scope<'_>, id: &str) -> Result<Value> {
    let raw=sqlx::query_scalar::<_,String>(&format!("SELECT ({PROJECTION})::text FROM messenger_custom_groups g WHERE org_id=$1::uuid AND user_id=$2 AND id=$3::uuid"))
        .bind(s.org).bind(s.user).bind(id).fetch_optional(db).await?.ok_or_else(missing_group)?;
    decode(&raw)
}
pub(super) async fn create(
    tx: &mut Tx<'_>,
    s: &Scope<'_>,
    name: &str,
    icon: Option<&str>,
) -> Result<String> {
    let id=sqlx::query_scalar::<_,String>("INSERT INTO messenger_custom_groups(org_id,user_id,name,icon,sort_order,pinned_at,updated_at) SELECT $1::uuid,$2,$3,$4,COALESCE(MAX(sort_order),-1)+1,current_setting('rudder.messenger_now')::timestamptz,current_setting('rudder.messenger_now')::timestamptz FROM messenger_custom_groups WHERE org_id=$1::uuid AND user_id=$2 RETURNING id::text")
        .bind(s.org).bind(s.user).bind(name).bind(icon).fetch_one(&mut **tx).await?;
    encode(&find(&mut *tx, s, &id).await?)
}
pub(super) async fn update(
    tx: &mut Tx<'_>,
    s: &Scope<'_>,
    id: &str,
    p: &GroupPatch,
) -> Result<String> {
    group_locks(tx, s, &[id.to_owned()]).await?;
    find(&mut *tx, s, id).await?;
    sqlx::query("UPDATE messenger_custom_groups SET name=COALESCE($4,name),icon=CASE WHEN $5 THEN $6 ELSE icon END,collapsed=COALESCE($7,collapsed),pinned_at=CASE WHEN $8::boolean IS NULL THEN pinned_at WHEN $8 THEN current_setting('rudder.messenger_now')::timestamptz ELSE NULL END,sort_order=COALESCE($9,sort_order),updated_at=current_setting('rudder.messenger_now')::timestamptz WHERE org_id=$1::uuid AND user_id=$2 AND id=$3::uuid")
        .bind(s.org).bind(s.user).bind(id).bind(&p.name).bind(p.icon.present()).bind(p.icon.value()).bind(p.collapsed).bind(p.pinned).bind(p.sort_order).execute(&mut **tx).await?;
    encode(&find(&mut *tx, s, id).await?)
}
pub(super) async fn remove(
    tx: &mut Tx<'_>,
    s: &Scope<'_>,
    id: &str,
    source: &str,
) -> Result<String> {
    group_locks(tx, s, &[id.to_owned()]).await?;
    let group = find(&mut *tx, s, id).await?;
    let keys=sqlx::query_scalar::<_,String>("SELECT thread_key FROM messenger_custom_group_entries WHERE org_id=$1::uuid AND user_id=$2 AND group_id=$3::uuid AND thread_key LIKE 'saved-view:%'")
        .bind(s.org).bind(s.user).bind(id).fetch_all(&mut **tx).await?;
    for key in keys {
        placement_activity(
            tx,
            s,
            "messenger.saved_view_group_removed",
            &key,
            json!({"groupId":id,"source":source}),
        )
        .await?;
    }
    // This direct legacy activity intentionally never emitted activity.logged.
    audit::activity(
        tx,
        s,
        audit::Activity {
            action: "messenger.custom_group_removed",
            entity_type: "messenger_custom_group",
            entity_id: id,
            details: json!({"source":source}),
            idempotency_key: Some(&format!("messenger-custom-group-removed:{}:{id}", s.user)),
            event: false,
        },
    )
    .await?;
    sqlx::query(
        "DELETE FROM messenger_custom_groups WHERE org_id=$1::uuid AND user_id=$2 AND id=$3::uuid",
    )
    .bind(s.org)
    .bind(s.user)
    .bind(id)
    .execute(&mut **tx)
    .await?;
    encode(&group)
}
pub(super) async fn remove_entry(tx: &mut Tx<'_>, s: &Scope<'_>, key: &str) -> Result<String> {
    let saved = key.strip_prefix("saved-view:");
    if let Some(id) = saved {
        if !super::protocol::uuid(id) {
            return Err(Error::Http(400, "Invalid Messenger Saved View item key"));
        }
        saved_views::find(&mut *tx, s, id)
            .await?
            .ok_or_else(missing_saved)?;
    }
    if let Some(group) = membership(&mut *tx, s, key).await? {
        group_locks(tx, s, std::slice::from_ref(&group)).await?;
        sqlx::query("DELETE FROM messenger_custom_group_entries WHERE org_id=$1::uuid AND user_id=$2 AND group_id=$3::uuid AND thread_key=$4")
            .bind(s.org).bind(s.user).bind(&group).bind(key).execute(&mut **tx).await?;
        delete_empty(tx, s, &group).await?;
        if saved.is_some() {
            placement_activity(
                tx,
                s,
                "messenger.saved_view_group_removed",
                key,
                json!({"groupId":group,"source":"item_remove"}),
            )
            .await?;
        }
    }
    encode(&if saved.is_some() {
        json!({"itemKey":key})
    } else {
        json!({"itemKey":key,"threadKey":key})
    })
}
