//! Personal group placement operations. The owner mutex stabilizes membership;
//! all affected groups are then locked in sorted order, including source groups.
use super::{groups, saved_views, store::*};
use rudder_d1_persistence::messenger_reads::mutation_snapshot;
use serde_json::{Value, json};

pub(super) fn unique(keys: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for key in keys {
        if !out.contains(key) {
            out.push(key.clone());
        }
    }
    out
}
pub(super) async fn eligible(tx: &mut Tx<'_>, s: &Scope<'_>, keys: &[String]) -> Result<()> {
    let summaries = mutation_snapshot::items(tx, s.org, s.user, &locale(), Some(keys)).await?;
    for key in keys {
        if let Some(id) = key.strip_prefix("saved-view:") {
            if !super::protocol::uuid(id) {
                return Err(Error::Http(400, "Invalid Messenger Saved View item key"));
            }
            if saved_views::find(&mut *tx, s, id).await?.is_none() {
                return Err(missing_saved());
            }
        } else if !summaries.iter().any(|v| field(v, "threadKey") == key) {
            return Err(Error::Http(404, "Messenger thread not found"));
        }
    }
    Ok(())
}
/// This lock-time check intentionally does not hydrate or initialize user
/// state: Chat parent locks have already been acquired before the owner mutex.
async fn current(tx: &mut Tx<'_>, s: &Scope<'_>, key: &str) -> Result<()> {
    if let Some(id) = key.strip_prefix("saved-view:") {
        if saved_views::find(&mut *tx, s, id).await?.is_none() {
            return Err(missing_saved());
        }
    } else if let Some(id) = key.strip_prefix("chat:") {
        let allowed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_conversations WHERE org_id=$1::uuid AND id=$2::uuid AND status='active' AND messenger_visible AND (conversation_kind<>'side_chat' OR created_by_user_id=$3))").bind(s.org).bind(id).bind(s.user).fetch_one(&mut **tx).await?;
        if !allowed {
            return Err(Error::Http(404, "Messenger thread not found"));
        }
    } else if let Some(id) = key.strip_prefix("issue:") {
        let allowed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM issues WHERE org_id=$1::uuid AND id=$2::uuid AND hidden_at IS NULL)").bind(s.org).bind(id).fetch_one(&mut **tx).await?;
        if !allowed {
            return Err(Error::Http(404, "Messenger thread not found"));
        }
    }
    Ok(())
}
async fn put(tx: &mut Tx<'_>, s: &Scope<'_>, group: &str, key: &str) -> Result<Value> {
    let raw:String=sqlx::query_scalar("INSERT INTO messenger_custom_group_entries(org_id,user_id,group_id,thread_key,sort_order,updated_at) SELECT $1::uuid,$2,$3::uuid,$4,coalesce(max(sort_order),-1)+1,current_setting('rudder.messenger_now')::timestamptz FROM messenger_custom_group_entries WHERE org_id=$1::uuid AND user_id=$2 AND group_id=$3::uuid ON CONFLICT(org_id,user_id,thread_key) DO UPDATE SET group_id=EXCLUDED.group_id,sort_order=EXCLUDED.sort_order,updated_at=EXCLUDED.updated_at RETURNING jsonb_build_object('id',id,'orgId',org_id,'userId',user_id,'groupId',group_id,'threadKey',thread_key,'sortOrder',sort_order,'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),'updatedAt',to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))::text").bind(s.org).bind(s.user).bind(group).bind(key).fetch_one(&mut **tx).await?;
    let mut out: Value = decode(&raw)?;
    out["itemKey"] = json!(key);
    if key.starts_with("saved-view:") {
        out.as_object_mut().unwrap().remove("threadKey");
    }
    Ok(out)
}
pub(super) async fn assign(
    tx: &mut Tx<'_>,
    s: &Scope<'_>,
    group: &str,
    key: &str,
) -> Result<String> {
    let source = membership(&mut *tx, s, key).await?;
    let mut ids = vec![group.to_owned()];
    if let Some(source) = &source {
        ids.push(source.clone());
    }
    group_locks(tx, s, &ids).await?;
    groups::find(&mut *tx, s, group).await?;
    current(tx, s, key).await?;
    let row = put(tx, s, group, key).await?;
    if let Some(source) = source.filter(|id| id != group) {
        delete_empty(tx, s, &source).await?;
    }
    placement_activity(
        tx,
        s,
        "messenger.saved_view_group_assigned",
        key,
        json!({"groupId":group}),
    )
    .await?;
    mutation_activity(
        tx,
        s,
        "messenger.group_entry_assigned",
        "messenger_custom_group",
        group,
        json!({"itemKey":key}),
    )
    .await?;
    encode(&row)
}
pub(super) async fn merge(
    tx: &mut Tx<'_>,
    s: &Scope<'_>,
    name: &str,
    icon: Option<&str>,
    keys: &[String],
    anchor: Option<&str>,
) -> Result<String> {
    let keys = unique(keys);
    if keys.is_empty() {
        return Err(Error::Http(400, "At least one thread key is required"));
    }
    if let Some(anchor) = anchor {
        if !keys.iter().any(|key| key == anchor) {
            return Err(Error::Http(
                400,
                "Messenger group anchor must be included in the item keys",
            ));
        }
        if anchor != "issues" && !anchor.starts_with("chat:") && !anchor.starts_with("issue:") {
            return Err(Error::Http(
                400,
                "Messenger group anchor must be a Chat or Issue",
            ));
        }
    }
    let mut sources = Vec::new();
    let mut target = None;
    for key in &keys {
        if let Some(id) = membership(&mut *tx, s, key).await? {
            if anchor == Some(key.as_str()) {
                target = Some(id.clone());
            }
            sources.push(id);
        }
    }
    let reused = target.is_some();
    let group = if let Some(target) = target {
        groups::find(&mut *tx, s, &target).await?
    } else {
        decode(&groups::create(tx, s, name, icon).await?)?
    };
    let id = field(&group, "id");
    sources.push(id.into());
    group_locks(tx, s, &sources).await?;
    for key in &keys {
        current(tx, s, key).await?;
        put(tx, s, id, key).await?;
        placement_activity(
            tx,
            s,
            "messenger.saved_view_group_assigned",
            key,
            json!({"groupId":id,"source":if reused{"group_reuse"}else{"group_create"}}),
        )
        .await?;
    }
    for source in unique(&sources).iter().filter(|source| *source != id) {
        delete_empty(tx, s, source).await?;
    }
    mutation_activity(
        tx,
        s,
        "messenger.custom_group_merged",
        "messenger_custom_group",
        id,
        json!({"itemKeys":keys,"reused":reused}),
    )
    .await?;
    encode(&json!({})) // Public response hydrates the committed group directory.
}
pub(super) async fn reorder_groups(
    tx: &mut Tx<'_>,
    s: &Scope<'_>,
    ids: &[String],
) -> Result<String> {
    let ids = unique(ids);
    for id in &ids {
        groups::find(&mut *tx, s, id).await?;
    }
    group_locks(tx, s, &ids).await?;
    for (index, id) in ids.iter().enumerate() {
        sqlx::query("UPDATE messenger_custom_groups SET sort_order=$4,updated_at=current_setting('rudder.messenger_now')::timestamptz WHERE org_id=$1::uuid AND user_id=$2 AND id=$3::uuid").bind(s.org).bind(s.user).bind(id).bind(index as i32).execute(&mut **tx).await?;
    }
    mutation_activity(
        tx,
        s,
        "messenger.custom_groups_reordered",
        "organization",
        s.org,
        json!({"groupIds":ids}),
    )
    .await?;
    encode(&json!({}))
}
pub(super) async fn reorder_entries(
    tx: &mut Tx<'_>,
    s: &Scope<'_>,
    group: &str,
    keys: &[String],
) -> Result<String> {
    if unique(keys).len() != keys.len() {
        return Err(Error::Http(
            400,
            "Messenger custom group reorder keys must be unique",
        ));
    }
    group_locks(tx, s, &[group.into()]).await?;
    groups::find(&mut *tx, s, group).await?;
    let raw=sqlx::query_as::<_,(String,i32)>("SELECT e.thread_key,e.sort_order FROM messenger_custom_group_entries e LEFT JOIN messenger_saved_views v ON e.thread_key='saved-view:'||v.id::text AND v.org_id=e.org_id AND v.user_id=e.user_id WHERE e.org_id=$1::uuid AND e.user_id=$2 AND e.group_id=$3::uuid AND (v.id IS NULL OR v.hidden_at IS NULL) ORDER BY e.sort_order,e.created_at").bind(s.org).bind(s.user).bind(group).fetch_all(&mut **tx).await?;
    let mut ordered = keys
        .iter()
        .filter(|key| raw.iter().any(|(k, _)| k == *key))
        .cloned()
        .collect::<Vec<_>>();
    ordered.extend(
        raw.iter()
            .filter(|(key, _)| !keys.contains(key))
            .map(|(key, _)| key.clone()),
    );
    for (index, key) in ordered.iter().enumerate() {
        let next = raw[index].1;
        if raw.iter().any(|(k, order)| k == key && *order == next) {
            continue;
        }
        sqlx::query("UPDATE messenger_custom_group_entries SET sort_order=$5,updated_at=current_setting('rudder.messenger_now')::timestamptz WHERE org_id=$1::uuid AND user_id=$2 AND group_id=$3::uuid AND thread_key=$4").bind(s.org).bind(s.user).bind(group).bind(key).bind(next).execute(&mut **tx).await?;
        placement_activity(
            tx,
            s,
            "messenger.saved_view_group_reordered",
            key,
            json!({"groupId":group,"itemKeys":ordered}),
        )
        .await?;
    }
    mutation_activity(
        tx,
        s,
        "messenger.group_entries_reordered",
        "messenger_custom_group",
        group,
        json!({"itemKeys":ordered}),
    )
    .await?;
    encode(&json!({}))
}
