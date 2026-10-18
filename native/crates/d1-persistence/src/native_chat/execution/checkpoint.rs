use super::{
    CheckpointSnapshot, ExecutionFence, NATIVE_WRITE_MARKER, Result,
    context::lock_current_execution,
};
use crate::activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_options};
use crate::native_chat::NativeChatExecutionActor;
use rudder_codex_app_server::EffectResponseReceipt;
use rudder_hermes_acp::{HermesSessionStartReceipt, HermesTurnReceipt};
use rudder_runtime_core::native_chat::{
    ClaudeSessionSelector, CursorSessionSelector, HermesSessionSelector, OpenCodeSessionSelector,
    PiSessionSelector,
};
use rudder_runtime_core::native_chat::{NativeChatProtocolCheckpoint, NativeChatProtocolPhase};
use serde_json::json;
use sqlx::PgPool;

/// A typed provider observation or pre-effect transition. There is deliberately
/// no variant for execution completion; provider events cannot finish a Run.
#[derive(Clone, Eq, PartialEq)]
pub enum CheckpointTransition {
    PrepareThreadStart,
    PrepareHermesSessionStart,
    PreparePiSessionStart,
    PrepareClaudeSessionStart,
    PrepareOpenCodeSessionStart,
    PrepareCursorSessionStart,
    RecordThread {
        thread_id: String,
    },
    PrepareInput,
    MarkInputIndeterminate,
    RecordTurn {
        thread_id: String,
        turn_id: String,
    },
    ObserveProviderTerminal {
        thread_id: String,
        turn_id: String,
    },
    RecordHermesSession {
        session_id: String,
    },
    RecordPiSession {
        selector: PiSessionSelector,
    },
    MarkHermesInputIndeterminate {
        request_id: u64,
    },
    MarkPiInputIndeterminate,
    RecordHermesTurn,
    ObserveHermesProviderTerminal {
        session_id: String,
        request_id: u64,
    },
    RecordPiTurn {
        session_id: String,
        entry_id: String,
    },
    ObservePiProviderTerminal {
        session_id: String,
        entry_id: String,
        next_leaf_id: String,
    },
    RecordClaudeSession {
        session_id: String,
    },
    MarkClaudeInputIndeterminate {
        request_id: String,
    },
    RecordClaudeTurn,
    ObserveClaudeProviderTerminal {
        session_id: String,
        request_id: String,
    },
    RecordOpenCodeSession {
        session_id: String,
    },
    MarkOpenCodeInputIndeterminate {
        request_id: String,
    },
    RecordOpenCodeTurn,
    ObserveOpenCodeProviderTerminal {
        session_id: String,
        request_id: String,
    },
    RecordCursorSession {
        session_id: String,
    },
    MarkCursorInputIndeterminate {
        request_id: String,
    },
    RecordCursorTurn,
    ObserveCursorProviderTerminal {
        session_id: String,
        request_id: String,
    },
}

pub(super) enum StoppingObservation<'a> {
    Codex(&'a EffectResponseReceipt),
    HermesSession(&'a HermesSessionStartReceipt),
    HermesTurn(&'a HermesTurnReceipt),
}

impl StoppingObservation<'_> {
    pub(super) fn connection_receipt_id(&self) -> &str {
        match self {
            Self::Codex(value) => value.connection_receipt_id(),
            Self::HermesSession(value) => value.connection_receipt_id(),
            Self::HermesTurn(value) => value.connection_receipt_id(),
        }
    }

    pub(super) fn correlation(&self) -> String {
        match self {
            Self::Codex(value) => value.correlation(),
            Self::HermesSession(value) => value.correlation(),
            Self::HermesTurn(value) => value.correlation(),
        }
    }

    pub(super) fn matches_claim(&self, fence: &ExecutionFence) -> bool {
        let id = fence.identity();
        match self {
            Self::Codex(value) => value.matches_connection_claim(
                id.run_id,
                id.attempt_id,
                fence.run_execution_owner_token(),
                id.connection_epoch,
                &fence.connection_claim_id,
            ),
            Self::HermesSession(value) => value.matches_connection_claim(
                id.run_id,
                id.attempt_id,
                fence.run_execution_owner_token(),
                id.connection_epoch,
                &fence.connection_claim_id,
            ),
            Self::HermesTurn(value) => value.matches_connection_claim(
                id.run_id,
                id.attempt_id,
                fence.run_execution_owner_token(),
                id.connection_epoch,
                &fence.connection_claim_id,
            ),
        }
    }
}

impl CheckpointTransition {
    pub(super) fn apply(
        &self,
        checkpoint: &NativeChatProtocolCheckpoint,
        expected_revision: u64,
    ) -> Result<NativeChatProtocolCheckpoint> {
        let proposed = match self {
            Self::PrepareThreadStart => checkpoint.prepare_thread_start(expected_revision),
            Self::PrepareHermesSessionStart => checkpoint.prepare_thread_start(expected_revision),
            Self::PreparePiSessionStart => checkpoint.prepare_thread_start(expected_revision),
            Self::PrepareClaudeSessionStart
            | Self::PrepareOpenCodeSessionStart
            | Self::PrepareCursorSessionStart => checkpoint.prepare_thread_start(expected_revision),
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
            Self::RecordHermesSession { session_id } => {
                let selector = HermesSessionSelector::from_persisted(session_id)
                    .map_err(|_| super::http(409, "Hermes session selector is invalid"))?;
                checkpoint.record_hermes_session(expected_revision, selector)
            }
            Self::RecordPiSession { selector } => {
                checkpoint.record_pi_session(expected_revision, selector.clone())
            }
            Self::MarkHermesInputIndeterminate { request_id } => {
                checkpoint.mark_hermes_input_indeterminate(expected_revision, *request_id)
            }
            Self::MarkPiInputIndeterminate => {
                checkpoint.mark_input_indeterminate(expected_revision)
            }
            Self::RecordHermesTurn => checkpoint.record_hermes_turn(expected_revision),
            Self::ObserveHermesProviderTerminal {
                session_id,
                request_id,
            } => checkpoint.record_hermes_provider_terminal(
                expected_revision,
                session_id,
                *request_id,
            ),
            Self::RecordPiTurn {
                session_id,
                entry_id,
            } => checkpoint.record_pi_turn_entry(expected_revision, session_id, entry_id.clone()),
            Self::ObservePiProviderTerminal {
                session_id,
                entry_id,
                next_leaf_id,
            } => checkpoint.record_pi_provider_terminal(
                expected_revision,
                session_id,
                entry_id,
                next_leaf_id.clone(),
            ),
            Self::RecordClaudeSession { session_id } => checkpoint.record_claude_session(
                expected_revision,
                ClaudeSessionSelector::from_persisted(session_id)
                    .map_err(|_| super::http(409, "Claude session selector is invalid"))?,
            ),
            Self::MarkClaudeInputIndeterminate { request_id } => {
                checkpoint.mark_claude_input_indeterminate(expected_revision, request_id.clone())
            }
            Self::RecordClaudeTurn => checkpoint.record_claude_turn(expected_revision),
            Self::ObserveClaudeProviderTerminal {
                session_id,
                request_id,
            } => checkpoint.record_claude_provider_terminal(
                expected_revision,
                session_id,
                request_id,
            ),
            Self::RecordOpenCodeSession { session_id } => checkpoint.record_opencode_session(
                expected_revision,
                OpenCodeSessionSelector::from_persisted(session_id)
                    .map_err(|_| super::http(409, "OpenCode session selector is invalid"))?,
            ),
            Self::MarkOpenCodeInputIndeterminate { request_id } => {
                checkpoint.mark_opencode_input_indeterminate(expected_revision, request_id.clone())
            }
            Self::RecordOpenCodeTurn => checkpoint.record_opencode_turn(expected_revision),
            Self::ObserveOpenCodeProviderTerminal {
                session_id,
                request_id,
            } => checkpoint.record_opencode_provider_terminal(
                expected_revision,
                session_id,
                request_id,
            ),
            Self::RecordCursorSession { session_id } => checkpoint.record_cursor_session(
                expected_revision,
                CursorSessionSelector::from_persisted(session_id)
                    .map_err(|_| super::http(409, "Cursor session selector is invalid"))?,
            ),
            Self::MarkCursorInputIndeterminate { request_id } => {
                checkpoint.mark_cursor_input_indeterminate(expected_revision, request_id.clone())
            }
            Self::RecordCursorTurn => checkpoint.record_cursor_turn(expected_revision),
            Self::ObserveCursorProviderTerminal {
                session_id,
                request_id,
            } => checkpoint.record_cursor_provider_terminal(
                expected_revision,
                session_id,
                request_id,
            ),
        };
        proposed
            .map_err(|_| super::http(409, "Native Chat checkpoint transition is stale or invalid"))
    }

    fn effect_kind(&self) -> Option<EffectKind> {
        match self {
            Self::PrepareThreadStart => Some(EffectKind::StartThread),
            Self::PrepareHermesSessionStart => Some(EffectKind::StartHermesSession),
            Self::PreparePiSessionStart => Some(EffectKind::StartPiSession),
            Self::PrepareClaudeSessionStart => Some(EffectKind::StartClaudeSession),
            Self::PrepareOpenCodeSessionStart => Some(EffectKind::StartOpenCodeSession),
            Self::PrepareCursorSessionStart => Some(EffectKind::StartCursorSession),
            Self::MarkInputIndeterminate => Some(EffectKind::SubmitInput),
            Self::MarkHermesInputIndeterminate { .. } => Some(EffectKind::SubmitHermesInput),
            Self::MarkPiInputIndeterminate => Some(EffectKind::SubmitPiInput),
            Self::MarkClaudeInputIndeterminate { .. } => Some(EffectKind::SubmitClaudeInput),
            Self::MarkOpenCodeInputIndeterminate { .. } => Some(EffectKind::SubmitOpenCodeInput),
            Self::MarkCursorInputIndeterminate { .. } => Some(EffectKind::SubmitCursorInput),
            _ => None,
        }
    }
}

/// A move-only authorization to perform one provider effect after its
/// indeterminate phase has committed. Reading a checkpoint after restart does
/// not recreate this permit, preventing automatic resend after ambiguity.
pub struct EffectPermit {
    kind: EffectKind,
    pub(super) fence: ExecutionFence,
    pub(super) phase: NativeChatProtocolPhase,
    committed_revision: u64,
    pub(super) thread_id: Option<String>,
    pub(super) source_message_id: Option<String>,
    pub(super) input_fingerprint: Option<String>,
    pub(super) session_id: Option<String>,
}

impl EffectPermit {
    pub fn kind(&self) -> EffectKind {
        self.kind
    }

    pub fn run_id(&self) -> &str {
        &self.fence.run_id
    }

    pub fn attempt_id(&self) -> &str {
        &self.fence.attempt_id
    }

    pub fn committed_revision(&self) -> u64 {
        self.committed_revision
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EffectKind {
    StartThread,
    SubmitInput,
    StartHermesSession,
    SubmitHermesInput,
    StartPiSession,
    SubmitPiInput,
    StartClaudeSession,
    SubmitClaudeInput,
    StartOpenCodeSession,
    SubmitOpenCodeInput,
    StartCursorSession,
    SubmitCursorInput,
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
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    expected_phase: NativeChatProtocolPhase,
    expected_revision: u64,
    transition: CheckpointTransition,
) -> Result<CheckpointReceipt> {
    advance(
        pool,
        actor,
        fence,
        expected_phase,
        expected_revision,
        transition,
        None,
    )
    .await
}

pub(super) async fn advance(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    expected_phase: NativeChatProtocolPhase,
    expected_revision: u64,
    transition: CheckpointTransition,
    stop: Option<(&super::stopping::StopIntent, StoppingObservation<'_>)>,
) -> Result<CheckpointReceipt> {
    let mut tx = pool.begin().await?;
    let locked = if let Some((stop, _)) = stop {
        super::context::lock_stopping_execution(&mut tx, actor, fence, stop).await?
    } else {
        lock_current_execution(&mut tx, actor, fence).await?
    };
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
    let new_session_id = match &transition {
        CheckpointTransition::RecordThread { thread_id } => Some(thread_id.as_str()),
        CheckpointTransition::RecordHermesSession { session_id } => Some(session_id.as_str()),
        CheckpointTransition::RecordPiSession { selector } => Some(selector.session_id.as_str()),
        _ => None,
    };
    if let Some(session_id) = new_session_id {
        if locked.segment_state != "pending"
            || locked.native_session_id.is_some()
            || locked.checkpoint.thread_id().is_some()
            || locked.checkpoint.hermes_session().is_some()
            || locked.checkpoint.pi_session().is_some()
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
        .bind(session_id)
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
         SET updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid AND chat_generation_id=$3::uuid
           AND execution_authority='native_rust' AND native_admission_hold=true
           AND execution_owner_token=$4
           AND COALESCE(execution_lease_expires_at > clock_timestamp(), false)",
    )
    .bind(&fence.organization_id)
    .bind(&fence.run_id)
    .bind(&fence.generation_id)
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

    if let Some((stop, observation)) = stop {
        super::stopping::record_checkpoint(
            &mut tx,
            actor,
            fence,
            stop,
            current,
            &next,
            &observation,
        )
        .await?;
        // The new checkpoint and chain now agree; recheck leases and current
        // access after all observation/audit writes before the commit.
        super::context::lock_stopping_execution(&mut tx, actor, fence, stop).await?;
    }
    tx.commit().await?;
    let effect_permit = transition.effect_kind().map(|kind| {
        let (source_message_id, input_fingerprint, session_id) = match kind {
            EffectKind::StartThread
            | EffectKind::StartHermesSession
            | EffectKind::StartPiSession
            | EffectKind::StartClaudeSession
            | EffectKind::StartOpenCodeSession
            | EffectKind::StartCursorSession => (None, None, None),
            EffectKind::SubmitInput => (
                locked.admitted_message_id.clone(),
                locked.admitted_input_fingerprint.clone(),
                None,
            ),
            EffectKind::SubmitHermesInput => (
                locked.admitted_message_id.clone(),
                locked.admitted_input_fingerprint.clone(),
                snapshot
                    .hermes_session
                    .as_ref()
                    .map(|session| session.as_str().to_owned()),
            ),
            EffectKind::SubmitPiInput => (
                locked.admitted_message_id.clone(),
                locked.admitted_input_fingerprint.clone(),
                snapshot
                    .pi_session
                    .as_ref()
                    .map(|session| session.session_id.clone()),
            ),
            EffectKind::SubmitClaudeInput => (
                locked.admitted_message_id.clone(),
                locked.admitted_input_fingerprint.clone(),
                snapshot
                    .claude_session
                    .as_ref()
                    .map(|s| s.as_str().to_owned()),
            ),
            EffectKind::SubmitOpenCodeInput => (
                locked.admitted_message_id.clone(),
                locked.admitted_input_fingerprint.clone(),
                snapshot
                    .opencode_session
                    .as_ref()
                    .map(|s| s.as_str().to_owned()),
            ),
            EffectKind::SubmitCursorInput => (
                locked.admitted_message_id.clone(),
                locked.admitted_input_fingerprint.clone(),
                snapshot
                    .cursor_session
                    .as_ref()
                    .map(|s| s.as_str().to_owned()),
            ),
        };
        EffectPermit {
            kind,
            fence: fence.clone(),
            phase: snapshot.phase,
            committed_revision: snapshot.revision,
            thread_id: snapshot.thread_id.clone(),
            source_message_id,
            input_fingerprint,
            session_id,
        }
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
    actor: &impl NativeChatExecutionActor,
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
        provider: checkpoint.provider(),
        phase: checkpoint.phase(),
        revision: checkpoint.revision(),
        thread_id: checkpoint.thread_id().map(str::to_owned),
        turn_id: checkpoint.turn_id().map(str::to_owned),
        pi_session: checkpoint.pi_session().cloned(),
        pi_turn_entry_id: checkpoint.pi_turn_entry_id().map(str::to_owned),
        hermes_session: checkpoint.hermes_session().cloned(),
        hermes_prompt_request_id: checkpoint.hermes_prompt_request_id(),
        claude_session: checkpoint.claude_session().cloned(),
        claude_prompt_request_id: checkpoint.claude_prompt_request_id().map(str::to_owned),
        opencode_session: checkpoint.opencode_session().cloned(),
        opencode_prompt_request_id: checkpoint.opencode_prompt_request_id().map(str::to_owned),
        cursor_session: checkpoint.cursor_session().cloned(),
        cursor_prompt_request_id: checkpoint.cursor_prompt_request_id().map(str::to_owned),
    }
}
