use super::{Result, Tx};

pub(super) async fn lock_target(
    tx: &mut Tx<'_>,
    organization_id: &str,
    target_id: &str,
) -> Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!(
            "runtime-binding:target:chat_conversation:{organization_id}:{target_id}"
        ))
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub(super) async fn lock_binding(
    tx: &mut Tx<'_>,
    organization_id: &str,
    binding_id: &str,
) -> Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!(
            "runtime-binding:binding:{organization_id}:{binding_id}"
        ))
        .execute(&mut **tx)
        .await?;
    Ok(())
}
