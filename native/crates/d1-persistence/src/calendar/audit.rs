use super::Result;
use super::common::Audit;
use serde_json::Value;
pub(super) async fn audit(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: &str,
    audit: &Audit,
    action: &str,
    entity_type: &str,
    entity_id: &str,
    details: Option<&Value>,
) -> Result<()> {
    crate::activity::write_activity(
        tx,
        org,
        &crate::activity::ActivityActor {
            actor_type: audit.actor_type,
            actor_id: audit.actor_id.clone(),
            run_id: audit.run_id.clone(),
        },
        action,
        entity_type,
        entity_id,
        details,
    )
    .await?;
    Ok(())
}
