use super::{
    CheckpointSnapshot, ExecutionFence, NATIVE_WRITE_MARKER, Result,
    context::lock_current_execution,
};
use crate::activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_options};
use rudder_auth_core::VerifiedActor;
use rudder_runtime_core::native_chat::{NativeChatProtocolCheckpoint, NativeChatProtocolPhase};
use serde_json::json;
use sqlx::PgPool;

/// A typed provider observation or pre-effect transition. There is deliberately
/// no variant for execution completion; provider events cannot finish a Run.
#[derive(Clone, Eq, PartialEq)]
pub enum CheckpointTransition {
    PrepareThreadStart,
    RecordThread { thread_id: String },
    PrepareInput,
    MarkInputIndeterminate,
    RecordTurn { thread_id: String, turn_id: String },
    ObserveProviderTerminal { thread_id: String, turn_id: String },
}

impl CheckpointTransition {
    fn apply(
        &self,
        checkpoint: &NativeChatProtocolCheckpoint,
        expected_revision: u64,
    ) -> Result<NativeChatProtocolCheckpoint> {
        let proposed = match self {
            Self::PrepareThreadStart => checkpoint.prepare_thread_start(expected_revision),
            Self::RecordThread { thread_id } => {
                checkpoint.record_thread(expected_revision, thread_id.clone())
            }
            Self::PrepareInput => checkpoint.prepare_input(expected_revision),
            Self::MarkInputIndeterminate => checkpoint.mark_input_indeterminate(expected_revision),
            Self::RecordTurn { thread_id, turn_id } => {
                checkpoint.record_turn(expected_revision, thread_id, turn_id.clone())
            }
            Self::ObserveProviderTerminal { thread_id, turn_id } => {
                checkpoint.record_provider_terminal(expected_revision, thread_id, turn_id)
            }
        };
        proposed
            .map_err(|_| super::http(409, "Native Chat checkpoint transition is stale or invalid"))
    }

    fn effect_kind(&self) -> Option<EffectKind> {
        match self {
            Self::PrepareThreadStart => Some(EffectKind::StartThread),
            Self::MarkInputIndeterminate => Some(EffectKind::SubmitInput),
            _ => None,
        }
    }
}

/// A move-only authorization to perform one provider effect after its
/// indeterminate phase has committed. Reading a checkpoint after restart does
/// not recreate this permit, preventing automatic resend after ambiguity.
pub struct EffectPermit {
    kind: EffectKind,
    run_id: String,
    attempt_id: String,
    committed_revision: u64,
}

impl EffectPermit {
    pub fn kind(&self) -> EffectKind {
        self.kind
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn attempt_id(&self) -> &str {
        &self.attempt_id
    }

    pub fn committed_revision(&self) -> u64 {
        self.committed_revision
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EffectKind {
    StartThread,
    SubmitInput,
}

pub struct CheckpointReceipt {
    snapshot: CheckpointSnapshot,
    effect_permit: Option<EffectPermit>,
}

impl CheckpointReceipt {
    pub fn snapshot(&self) -> &CheckpointSnapshot {
        &self.snapshot
    }

    pub fn take_effect_permit(&mut self) -> Option<EffectPermit> {
        self.effect_permit.take()
    }
}

/// Commit a strict predecessor phase+revision CAS and return a move-only
/// provider-effect permit only for freshly committed pre-effect phases.
pub async fn advance_checkpoint(
    pool: &PgPool,
    actor: &VerifiedActor,
    fence: &ExecutionFence,
    expected_phase: NativeChatProtocolPhase,
    expected_revision: u64,
    transition: CheckpointTransition,
) -> Result<CheckpointReceipt> {
    let mut tx = pool.begin().await?;
    let locked = lock_current_execution(&mut tx, actor, fence).await?;
    let current = &locked.checkpoint;
    if current.phase() != expected_phase || current.revision() != expected_revision {
        return Err(super::http(
            409,
            "Native Chat checkpoint predecessor is stale",
        ));
    }
    let next = transition.apply(current, expected_revision)?;
    let snapshot = snapshot(&next);

    sqlx::query("SELECT set_config('rudder.native_chat_write', $1, true)")
        .bind(NATIVE_WRITE_MARKER)
        .execute(&mut *tx)
        .await?;

    // The exact Thread locator and its protocol checkpoint form one durable
    // transition. Write the Segment first so any later CAS/audit failure proves
    // transaction rollback also leaves the locator pending.
    if let CheckpointTransition::RecordThread { thread_id } = &transition {
        if locked.segment_state != "pending"
            || locked.native_session_id.is_some()
            || locked.checkpoint.thread_id().is_some()
        {
            return Err(super::http(
                409,
                "Native Chat Segment already has a Thread locator",
            ));
        }
        let segment_updated = sqlx::query(
            "UPDATE native_segments s
             SET native_session_id=$4, state='open', updated_at=clock_timestamp()
             FROM runtime_bindings b
             WHERE s.org_id=$1::uuid AND s.binding_id=$2::uuid AND s.id=$3::uuid
               AND s.native_session_id IS NULL AND s.state='pending'
               AND s.sealed_at IS NULL
               AND b.org_id=s.org_id AND b.id=s.binding_id
               AND b.current_segment_id=s.id AND b.status='active'
               AND b.continuity='native'",
        )
        .bind(&fence.organization_id)
        .bind(&locked.binding_id)
        .bind(&locked.segment_id)
        .bind(thread_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if segment_updated != 1 {
            return Err(super::http(
                409,
                "Native Chat Segment changed before Thread binding",
            ));
        }
    }

    let checkpoint_json = serde_json::to_value(&next)
        .map_err(|_| super::http(500, "Failed to encode Native Chat checkpoint"))?;
    let expected_revision_text = expected_revision.to_string();
    let attempt_updated = sqlx::query(
        "UPDATE heartbeat_run_attempts
         SET checkpoint_json=$7::jsonb, protocol_phase=$8,
             provider_thread_id=$9, provider_turn_id=$10
         WHERE org_id=$1::uuid AND run_id=$2::uuid AND id=$3::uuid
           AND owner_token=$4 AND attempt_epoch=$5
           AND generation_attempt_epoch=$6
           AND connection_epoch=$14
           AND protocol_phase=$11
           AND checkpoint_json->>'revision'=$12
           AND EXISTS (
             SELECT 1 FROM heartbeat_runs r
             JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
             WHERE r.org_id=$1::uuid AND r.id=$2::uuid
               AND r.execution_owner_token=$4 AND g.control_owner_token=$13
               AND r.native_admission_hold=true AND g.native_admission_hold=true
               AND COALESCE(r.execution_lease_expires_at > clock_timestamp(), false)
               AND COALESCE(g.control_lease_expires_at > clock_timestamp(), false)
           )",
    )
    .bind(&fence.organization_id)
    .bind(&fence.run_id)
    .bind(&fence.attempt_id)
    .bind(&fence.run_owner_token)
    .bind(fence.run_attempt_epoch)
    .bind(fence.generation_attempt_epoch)
    .bind(checkpoint_json.to_string())
    .bind(next.phase().as_str())
    .bind(next.thread_id())
    .bind(next.turn_id())
    .bind(expected_phase.as_str())
    .bind(&expected_revision_text)
    .bind(&fence.generation_owner_token)
    .bind(fence.connection_epoch)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if attempt_updated != 1 {
        return Err(super::http(
            409,
            "Native Chat checkpoint compare-and-set failed",
        ));
    }

    let generation_updated = sqlx::query(
        "UPDATE chat_generations
         SET provider_thread_id=$4, provider_turn_id=$5, updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid AND conversation_id=$3::uuid
           AND execution_authority='native_rust' AND native_admission_hold=true
           AND control_owner_token=$6 AND attempt_epoch=$7
           AND COALESCE(control_lease_expires_at > clock_timestamp(), false)",
    )
    .bind(&fence.organization_id)
    .bind(&fence.generation_id)
    .bind(&fence.conversation_id)
    .bind(next.thread_id())
    .bind(next.turn_id())
    .bind(&fence.generation_owner_token)
    .bind(fence.generation_attempt_epoch)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if generation_updated != 1 {
        return Err(super::http(
            409,
            "Native Chat generation lease expired during checkpoint",
        ));
    }

    let run_updated = sqlx::query(
        "UPDATE heartbeat_runs
         SET session_id_after=$4, updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid AND chat_generation_id=$3::uuid
           AND execution_authority='native_rust' AND native_admission_hold=true
           AND execution_owner_token=$5
           AND COALESCE(execution_lease_expires_at > clock_timestamp(), false)",
    )
    .bind(&fence.organization_id)
    .bind(&fence.run_id)
    .bind(&fence.generation_id)
    .bind(next.thread_id())
    .bind(&fence.run_owner_token)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if run_updated != 1 {
        return Err(super::http(
            409,
            "Run execution lease expired during checkpoint",
        ));
    }

    let details = json!({
        "conversationId": fence.conversation_id,
        "generationId": fence.generation_id,
        "runId": fence.run_id,
        "attemptId": fence.attempt_id,
        "generationAttemptEpoch": fence.generation_attempt_epoch,
        "runAttemptEpoch": fence.run_attempt_epoch,
        "connectionEpoch": fence.connection_epoch,
        "previousPhase": expected_phase.as_str(),
        "phase": next.phase().as_str(),
        "revision": next.revision(),
    });
    let audit = ActivityActor {
        actor_type: if actor.actor().kind == "agent" {
            "agent"
        } else {
            "user"
        },
        actor_id: actor.actor().id.clone(),
        run_id: Some(fence.run_id.clone()),
    };
    write_activity_options(
        &mut tx,
        ActivityWrite {
            org: &fence.organization_id,
            audit: &audit,
            action: "runtime.native_chat.checkpoint_advanced",
            entity_type: "chat_generation",
            entity_id: &fence.generation_id,
            details: Some(&details),
            options: ActivityOptions {
                agent_id: Some(&locked.agent_id),
                bind_run: true,
                ..ActivityOptions::default()
            },
        },
    )
    .await?;

    // Do not allow a long audit write to commit after either owner lease died.
    let live: bool = sqlx::query_scalar(
        "SELECT COALESCE(g.control_lease_expires_at > clock_timestamp(), false)
                AND COALESCE(r.execution_lease_expires_at > clock_timestamp(), false)
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
    .fetch_one(&mut *tx)
    .await?;
    if !live {
        return Err(super::http(
            409,
            "Native Chat execution lease expired during checkpoint",
        ));
    }

    tx.commit().await?;
    let effect_permit = transition.effect_kind().map(|kind| EffectPermit {
        kind,
        run_id: fence.run_id.clone(),
        attempt_id: fence.attempt_id.clone(),
        committed_revision: snapshot.revision,
    });
    Ok(CheckpointReceipt {
        snapshot,
        effect_permit,
    })
}

/// Re-read the exact durable checkpoint after a service/connection restart.
/// This returns no effect permit, even when the stored phase is indeterminate.
pub async fn current_checkpoint(
    pool: &PgPool,
    actor: &VerifiedActor,
    fence: &ExecutionFence,
) -> Result<CheckpointSnapshot> {
    let mut tx = pool.begin().await?;
    let locked = lock_current_execution(&mut tx, actor, fence).await?;
    let result = snapshot(&locked.checkpoint);
    tx.commit().await?;
    Ok(result)
}

fn snapshot(checkpoint: &NativeChatProtocolCheckpoint) -> CheckpointSnapshot {
    CheckpointSnapshot {
        phase: checkpoint.phase(),
        revision: checkpoint.revision(),
        thread_id: checkpoint.thread_id().map(str::to_owned),
        turn_id: checkpoint.turn_id().map(str::to_owned),
    }
}
