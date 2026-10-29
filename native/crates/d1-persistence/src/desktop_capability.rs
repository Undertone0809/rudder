//! Atomic Browser/Computer activity and outbox persistence. Callers supply a
//! verified Run actor and the native capability policy's bounded metadata.
use crate::{
    StoreError,
    activity::{self, ActivityActor},
};
use serde_json::Value;
use sqlx::PgPool;

pub struct DesktopActivity<'a> {
    pub organization_id: &'a str,
    pub agent_id: &'a str,
    pub run_id: &'a str,
    pub action: &'a str,
    pub entity_type: &'a str,
    pub entity_id: &'a str,
    pub details: &'a Value,
}
pub async fn record_action(pool: &PgPool, event: &DesktopActivity<'_>) -> Result<(), StoreError> {
    let mut tx = pool.begin().await?;
    activity::write_activity(
        &mut tx,
        event.organization_id,
        &ActivityActor {
            actor_type: "agent",
            actor_id: event.agent_id.to_owned(),
            run_id: Some(event.run_id.to_owned()),
        },
        event.action,
        event.entity_type,
        event.entity_id,
        Some(event.details),
    )
    .await?;
    tx.commit().await?;
    Ok(())
}
