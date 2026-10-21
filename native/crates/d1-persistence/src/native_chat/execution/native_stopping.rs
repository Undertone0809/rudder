//! One-use cancellation for provider-native sessions on an already owned host.
//! An interrupt acknowledgment does not finalize a Run or release an input.
use super::{ExecutionFence, Result, StopIntent, context::lock_stopping_execution, http};
use crate::native_chat::{NativeChatExecutionActor, auth, control::pin};
use rudder_native_process_transport::ConnectionReceipt;
use rudder_runtime_core::native_chat::{
    NativeChatProtocolCheckpoint, NativeChatProtocolPhase as Phase, NativeChatProvider as Provider,
};
use serde_json::json;
use sqlx::PgPool;
use std::time::{Duration, Instant};

#[derive(Clone, Eq, PartialEq)]
pub enum NativeInterruptTarget {
    Claude {
        session_id: Option<String>,
    },
    Cursor {
        session_id: String,
        request_id: String,
    },
    OpenCode {
        session_id: String,
        request_id: String,
    },
    Pi {
        session_id: String,
    },
}

impl NativeInterruptTarget {
    fn matches(&self, checkpoint: &NativeChatProtocolCheckpoint) -> bool {
        match self {
            Self::Claude { session_id } => {
                checkpoint.provider() == Provider::ClaudeLocal
                    && checkpoint.claude_session().map(|s| s.as_str()) == session_id.as_deref()
            }
            Self::Cursor {
                session_id,
                request_id,
            } => {
                checkpoint.provider() == Provider::CursorLocal
                    && checkpoint.cursor_session().map(|s| s.as_str()) == Some(session_id.as_str())
                    && checkpoint.cursor_prompt_request_id() == Some(request_id.as_str())
            }
            Self::OpenCode {
                session_id,
                request_id,
            } => {
                checkpoint.provider() == Provider::OpenCodeLocal
                    && checkpoint.opencode_session().map(|s| s.as_str())
                        == Some(session_id.as_str())
                    && checkpoint.opencode_prompt_request_id() == Some(request_id.as_str())
            }
            Self::Pi { session_id } => {
                checkpoint.provider() == Provider::PiLocal
                    && checkpoint
                        .pi_session()
                        .is_some_and(|s| s.session_id == *session_id)
            }
        }
    }
}

/// Move-only permission for a single local cancel write. The callback must
/// enqueue synchronously on the same connection; no retry capability survives.
pub struct NativeInterruptPermit {
    deadline: Instant,
    connection: String,
    target: NativeInterruptTarget,
}

impl NativeInterruptPermit {
    pub fn dispatch<T>(
        self,
        connection: &ConnectionReceipt,
        target: &NativeInterruptTarget,
        dispatch: impl FnOnce() -> T,
    ) -> Result<T> {
        if Instant::now() >= self.deadline
            || self.connection != connection.connection_receipt_id()
            || &self.target != target
        {
            return Err(http(
                409,
                "Native interrupt authorization expired or target changed",
            ));
        }
        Ok(dispatch())
    }
}

pub async fn reserve_native_interrupt(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    stop: &StopIntent,
    connection: &ConnectionReceipt,
    target: &NativeInterruptTarget,
) -> Result<Option<NativeInterruptPermit>> {
    let anchor = Instant::now();
    let id = fence.identity();
    if !connection.matches_connection_claim(
        id.run_id,
        id.attempt_id,
        fence.run_execution_owner_token(),
        id.connection_epoch,
        &fence.connection_claim_id,
    ) {
        return Err(http(
            409,
            "Native interrupt connection does not match execution",
        ));
    }
    let proof = pin::digest(
        "stop_connection_v1",
        &json!(connection.connection_receipt_id()),
    );
    let mut tx = pool.begin().await?;
    let locked = lock_stopping_execution(&mut tx, actor, fence, stop).await?;
    if !target.matches(&locked.checkpoint) {
        return Err(http(
            409,
            "Native interrupt provider session or input changed",
        ));
    }
    if matches!(
        locked.checkpoint.phase(),
        Phase::ProviderTerminalObserved | Phase::TurnKnown
    ) {
        tx.commit().await?;
        return Ok(None);
    }
    let active = locked.checkpoint.phase() == Phase::InputIndeterminate
        || (matches!(target, NativeInterruptTarget::Claude { session_id: None })
            && locked.checkpoint.phase() == Phase::ThreadStartIndeterminate
            && locked.checkpoint.claude_combined_input());
    if !active {
        return Err(http(409, "Native interrupt has no dispatched input"));
    }
    let evidence: serde_json::Value = sqlx::query_scalar(
        "SELECT provider_evidence FROM chat_control_actions WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(id.organization_id)
    .bind(&stop.action_id)
    .fetch_one(&mut *tx)
    .await?;
    if evidence["stoppingConnectionProof"].as_str() != Some(proof.as_str())
        || evidence["stoppingConnectionEpoch"].as_i64() != Some(i64::from(id.connection_epoch))
    {
        return Err(http(409, "Native interrupt connection is not registered"));
    }
    let remaining: i64 = sqlx::query_scalar(
        "SELECT floor(LEAST(extract(epoch FROM(g.control_lease_expires_at-clock_timestamp())),
          extract(epoch FROM(r.execution_lease_expires_at-clock_timestamp())))*1000)::bigint
         FROM chat_generations g JOIN heartbeat_runs r ON r.org_id=g.org_id AND r.chat_generation_id=g.id
         WHERE g.org_id=$1::uuid AND g.id=$2::uuid AND r.id=$3::uuid")
        .bind(id.organization_id).bind(id.generation_id).bind(id.run_id).fetch_one(&mut *tx).await?;
    if remaining <= 0 {
        return Err(http(409, "Native interrupt lease expired"));
    }
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:interrupt',true)")
        .execute(&mut *tx)
        .await?;
    let updated = sqlx::query(
        "UPDATE chat_control_actions SET provider_disposition='unverified',local_disposition='stopping',
           provider_evidence=jsonb_set(provider_evidence,'{interruptConnectionProof}',to_jsonb($3::text)),
           updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid AND provider_disposition='not_sent'")
        .bind(id.organization_id).bind(&stop.action_id).bind(&proof).execute(&mut *tx).await?.rows_affected();
    if updated == 1 {
        let audit = crate::activity::ActivityActor {
            actor_type: if actor.actor().kind == "agent" {
                "agent"
            } else {
                "user"
            },
            actor_id: actor.actor().id.clone(),
            run_id: Some(id.run_id.into()),
        };
        crate::activity::write_activity(
            &mut tx,
            id.organization_id,
            &audit,
            "runtime.native_chat.interrupt_reserved",
            "chat_generation",
            id.generation_id,
            Some(&json!({"controlActionId":stop.action_id})),
        )
        .await?;
    }
    lock_stopping_execution(&mut tx, actor, fence, stop).await?;
    auth::authorize_execution_org(&mut tx, actor, fence).await?;
    tx.commit().await?;
    Ok((updated == 1).then(|| NativeInterruptPermit {
        deadline: anchor + Duration::from_millis((remaining as u64).min(2000)),
        connection: connection.connection_receipt_id().into(),
        target: target.clone(),
    }))
}

/// Called only inside the atomic terminal transaction, after exact typed turn,
/// input checkpoint and cleanup validation. The durable Stop projection wins
/// even when a provider completes naturally before receiving cancellation.
pub(super) async fn resolve_action_owned(
    tx: &mut auth::Tx<'_>,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    stop: &StopIntent,
    connection_id: &str,
    provider_status: Option<&str>,
    result: &serde_json::Value,
) -> Result<()> {
    use sqlx::Row;
    let id = fence.identity();
    let row = sqlx::query("SELECT provider_evidence,provider_disposition FROM chat_control_actions WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(id.organization_id).bind(&stop.action_id).fetch_one(&mut **tx).await?;
    let mut evidence: serde_json::Value = row.try_get("provider_evidence")?;
    let connection = pin::digest("stop_connection_v1", &json!(connection_id));
    // A terminal result can race the first Stop poll. The finalizer already
    // validated this opaque cleanup against every claim dimension; register
    // that connection atomically when no earlier control bound one. This also
    // keeps exact terminal retries idempotent through finalize_inner's receipt.
    if evidence.get("stoppingConnectionProof").is_none()
        && evidence.get("stoppingConnectionEpoch").is_none()
        && evidence.get("interruptConnectionProof").is_none()
        && evidence.get("stoppingObservations").is_none()
    {
        evidence["stoppingConnectionProof"] = json!(connection);
        evidence["stoppingConnectionEpoch"] = json!(id.connection_epoch);
    }
    if evidence["stoppingConnectionProof"].as_str() != Some(connection.as_str())
        || evidence["stoppingConnectionEpoch"].as_i64() != Some(i64::from(id.connection_epoch))
        || evidence
            .get("interruptConnectionProof")
            .is_some_and(|v| v.as_str() != Some(connection.as_str()))
        || evidence.get("stoppingObservations").is_some()
    {
        return Err(http(409, "Native Stop cleanup connection changed"));
    }
    if provider_status.is_none()
        && (row.try_get::<String, _>("provider_disposition")? != "not_sent"
            || evidence.get("interruptConnectionProof").is_some())
    {
        return Err(http(409, "Native pre-input Stop has interrupt evidence"));
    }
    evidence["stopResolution"] = match provider_status {
        Some(status) => {
            json!({"result":result,"actualProviderStatus":status,"connectionProof":connection})
        }
        None => {
            json!({"result":result,"inputDisposition":"not_submitted","connectionProof":connection})
        }
    };
    sqlx::query("UPDATE chat_control_actions SET local_disposition='stopped',resolved_at=clock_timestamp(),updated_at=clock_timestamp(),provider_evidence=$3 WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(id.organization_id).bind(&stop.action_id).bind(evidence).execute(&mut **tx).await?;
    auth::authorize_execution_org(tx, actor, fence).await?;
    Ok(())
}
