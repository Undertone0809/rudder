use super::{
    audit, groups, keep,
    protocol::{AuditContext, Command},
    saved_views, threads,
};
use rudder_d1_persistence::legacy_read_json::{normalize_legacy_read_json, parse_legacy_read_json};
use serde_json::Value;
use sqlx::{PgConnection, PgPool, Postgres, Transaction};

#[derive(Debug, thiserror::Error)]
pub(super) enum Error {
    #[error("{1}")]
    Http(u16, &'static str),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
pub(super) type Result<T> = std::result::Result<T, Error>;
pub(super) type Tx<'a> = Transaction<'a, Postgres>;
pub(super) struct Scope<'a> {
    pub org: &'a str,
    pub user: &'a str,
    pub audit: &'a AuditContext,
}
pub(super) fn missing_saved() -> Error {
    Error::Http(404, "Messenger Saved View not found")
}
pub(super) fn missing_group() -> Error {
    Error::Http(404, "Messenger custom group not found")
}
pub(super) fn field<'a>(value: &'a Value, name: &str) -> &'a str {
    value[name].as_str().unwrap_or("")
}
pub(super) fn decode(raw: &str) -> Result<Value> {
    Ok(parse_legacy_read_json(raw)?)
}
pub(super) fn encode(value: &Value) -> Result<String> {
    Ok(serde_json::to_string(value)?)
}

/// Never lock groups ahead of the owner. Source deletion and legacy aggregate
/// cleanup still use these exact locks; no independent Rust fence may bypass it.
pub(super) async fn owner_lock(tx: &mut Tx<'_>, s: &Scope<'_>) -> Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("messenger-saved-views:{}:{}", s.org, s.user))
        .execute(&mut **tx)
        .await?;
    Ok(())
}
pub(super) async fn group_locks(tx: &mut Tx<'_>, s: &Scope<'_>, ids: &[String]) -> Result<()> {
    let mut ids = ids.to_vec();
    ids.sort();
    ids.dedup();
    for id in ids {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
            .bind(format!(
                "messenger-custom-group:{}:{}:{}",
                s.org,
                s.user,
                id.to_lowercase()
            ))
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}
pub(super) async fn delete_empty(tx: &mut Tx<'_>, s: &Scope<'_>, group: &str) -> Result<()> {
    sqlx::query("DELETE FROM messenger_custom_groups g WHERE g.org_id=$1::uuid AND g.user_id=$2 AND g.id=$3::uuid AND NOT EXISTS (SELECT 1 FROM messenger_custom_group_entries e WHERE e.org_id=g.org_id AND e.user_id=g.user_id AND e.group_id=g.id)")
        .bind(s.org).bind(s.user).bind(group).execute(&mut **tx).await?;
    Ok(())
}
pub(super) async fn membership(
    db: &mut PgConnection,
    s: &Scope<'_>,
    key: &str,
) -> Result<Option<String>> {
    Ok(sqlx::query_scalar("SELECT group_id::text FROM messenger_custom_group_entries WHERE org_id=$1::uuid AND user_id=$2 AND thread_key=$3 LIMIT 1")
        .bind(s.org).bind(s.user).bind(key).fetch_optional(db).await?)
}
pub(super) async fn mutate(pool: &PgPool, s: &Scope<'_>, input: &Command) -> Result<String> {
    let mut tx = pool.begin().await?;
    // Pin state does not mutate directory placement. In particular, Chat
    // deletion locks/cascades the parent row before acquiring placement locks
    // for cleanup, so holding owner -> Chat row here would invert that order.
    if !matches!(input, Command::ThreadUserState { .. }) {
        owner_lock(&mut tx, s).await?;
    }
    // PostgreSQL now() predates time spent waiting for the owner mutex. Legacy
    // writers create their mutation Date after that wait; capture it here so a
    // later serialized mutation cannot move updated/pinned timestamps backward.
    sqlx::query("SELECT set_config('rudder.messenger_now', clock_timestamp()::text, true)")
        .execute(&mut *tx)
        .await?;
    let body = match input {
        Command::SavedViewKeep { input } => keep::keep(&mut tx, s, input).await?,
        Command::SavedViewUpdate { id, patch } => {
            saved_views::update(&mut tx, s, id, patch).await?
        }
        Command::SavedViewDelete { id } => saved_views::remove(&mut tx, s, id).await?,
        Command::SavedViewReorder { ids } => saved_views::reorder(&mut tx, s, ids).await?,
        Command::GroupCreate { name, icon } => {
            groups::create(&mut tx, s, name, icon.as_deref()).await?
        }
        Command::GroupUpdate { group_id, patch } => {
            groups::update(&mut tx, s, group_id, patch).await?
        }
        Command::GroupDelete { group_id } => {
            groups::remove(&mut tx, s, group_id, "group_delete").await?
        }
        Command::GroupSeparate { group_id } => {
            groups::remove(&mut tx, s, group_id, "group_separate").await?
        }
        Command::GroupEntryRemove { item_key } => {
            groups::remove_entry(&mut tx, s, item_key).await?
        }
        Command::ThreadUserState { thread_key, pinned } => {
            threads::pin(&mut tx, s, thread_key, *pinned).await?
        }
        _ => return Err(Error::Http(422, "Invalid Messenger mutation")),
    };
    // Response serialization must succeed before committing; persistence and
    // durable event intent commit together, even if the HTTP response is lost.
    let body = normalize_legacy_read_json(&body)?;
    tx.commit().await?;
    Ok(body)
}

pub(super) async fn saved_activity(
    tx: &mut Tx<'_>,
    s: &Scope<'_>,
    action: &str,
    row: &Value,
    extra: Value,
) -> Result<()> {
    let mut details =
        serde_json::json!({"targetKind":row["targetKind"],"resourceKey":row["resourceKey"]});
    if let Some(extra) = extra.as_object() {
        details.as_object_mut().unwrap().extend(extra.clone());
    }
    audit::activity(
        tx,
        s,
        audit::Activity {
            action,
            entity_type: "messenger_saved_view",
            entity_id: field(row, "id"),
            details,
            idempotency_key: None,
            event: true,
        },
    )
    .await
}
pub(super) async fn placement_activity(
    tx: &mut Tx<'_>,
    s: &Scope<'_>,
    action: &str,
    key: &str,
    extra: Value,
) -> Result<()> {
    let Some(id) = key.strip_prefix("saved-view:") else {
        return Ok(());
    };
    if !super::protocol::uuid(id) {
        return Err(Error::Http(400, "Invalid Messenger Saved View item key"));
    }
    let mut details = serde_json::json!({"itemKey":key});
    if let Some(extra) = extra.as_object() {
        details.as_object_mut().unwrap().extend(extra.clone());
    }
    audit::activity(
        tx,
        s,
        audit::Activity {
            action,
            entity_type: "messenger_saved_view",
            entity_id: id,
            details,
            idempotency_key: None,
            event: true,
        },
    )
    .await
}
