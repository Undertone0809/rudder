use super::{ExecutionFence, NATIVE_WRITE_MARKER, Result, context::lock_current_execution};
use crate::native_chat::NativeChatExecutionActor;
use sqlx::{PgPool, Row};

pub struct LeaseReceipt {
    generation_expires_at_unix_ms: i64,
    run_expires_at_unix_ms: i64,
}

impl LeaseReceipt {
    pub fn generation_expires_at_unix_ms(&self) -> i64 {
        self.generation_expires_at_unix_ms
    }

    pub fn run_expires_at_unix_ms(&self) -> i64 {
        self.run_expires_at_unix_ms
    }
}

/// Extend both independently owned leases atomically. The current exact fence
/// and both unexpired leases are checked after Conversation/Generation/Run/
/// Attempt locks; an expired owner cannot revive itself.
pub async fn renew_lease(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
) -> Result<LeaseReceipt> {
    renew(pool, actor, fence, None).await
}

pub(super) async fn renew(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    stop: Option<&super::stopping::StopIntent>,
) -> Result<LeaseReceipt> {
    let mut tx = pool.begin().await?;
    if let Some(stop) = stop {
        super::context::lock_stopping_execution(&mut tx, actor, fence, stop).await?;
    } else {
        lock_current_execution(&mut tx, actor, fence).await?;
    }
    sqlx::query("SELECT set_config('rudder.native_chat_write', $1, true)")
        .bind(NATIVE_WRITE_MARKER)
        .execute(&mut *tx)
        .await?;

    let generation_updated = sqlx::query(
        "UPDATE chat_generations
         SET control_lease_expires_at=clock_timestamp() + make_interval(secs => $4),
             updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid AND conversation_id=$3::uuid
           AND execution_authority='native_rust' AND native_admission_hold=true
           AND control_owner_token=$5 AND attempt_epoch=$6
           AND COALESCE(control_lease_expires_at > clock_timestamp(), false)",
    )
    .bind(&fence.organization_id)
    .bind(&fence.generation_id)
    .bind(&fence.conversation_id)
    .bind(super::GENERATION_CONTROL_LEASE_SECONDS)
    .bind(&fence.generation_owner_token)
    .bind(fence.generation_attempt_epoch)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if generation_updated != 1 {
        return Err(super::http(409, "Native Chat generation lease is stale"));
    }

    let run_updated = sqlx::query(
        "UPDATE heartbeat_runs
         SET execution_lease_expires_at=clock_timestamp() + make_interval(secs => $4),
             updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid AND chat_generation_id=$3::uuid
           AND execution_authority='native_rust' AND native_admission_hold=true
           AND execution_owner_token=$5
           AND COALESCE(execution_lease_expires_at > clock_timestamp(), false)",
    )
    .bind(&fence.organization_id)
    .bind(&fence.run_id)
    .bind(&fence.generation_id)
    .bind(super::RUN_EXECUTION_LEASE_SECONDS)
    .bind(&fence.run_owner_token)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if run_updated != 1 {
        return Err(super::http(409, "Run execution lease is stale"));
    }

    let row = sqlx::query(
        "SELECT floor(extract(epoch FROM g.control_lease_expires_at) * 1000)::bigint AS generation_expiry,
                floor(extract(epoch FROM r.execution_lease_expires_at) * 1000)::bigint AS run_expiry,
                COALESCE(g.control_lease_expires_at > clock_timestamp(), false)
                  AND COALESCE(r.execution_lease_expires_at > clock_timestamp(), false) AS live
         FROM chat_generations g
         JOIN heartbeat_runs r ON r.org_id=g.org_id AND r.chat_generation_id=g.id
         WHERE g.org_id=$1::uuid AND g.id=$2::uuid AND r.id=$3::uuid
           AND g.control_owner_token=$4 AND r.execution_owner_token=$5
           AND g.native_admission_hold=true AND r.native_admission_hold=true",
    )
    .bind(&fence.organization_id)
    .bind(&fence.generation_id)
    .bind(&fence.run_id)
    .bind(&fence.generation_owner_token)
    .bind(&fence.run_owner_token)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| super::http(409, "Native Chat execution fence changed"))?;
    let live: bool = row.try_get("live")?;
    if !live {
        return Err(super::http(
            409,
            "Native Chat execution lease expired during renewal",
        ));
    }
    let receipt = LeaseReceipt {
        generation_expires_at_unix_ms: row.try_get("generation_expiry")?,
        run_expires_at_unix_ms: row.try_get("run_expiry")?,
    };
    super::super::auth::authorize_execution_org(&mut tx, actor, fence).await?;
    tx.commit().await?;
    Ok(receipt)
}
