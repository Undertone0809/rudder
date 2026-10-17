//! Private Rust control ledger. Recording Stop intent does not acknowledge
//! provider cancellation, finalize a Run, release a hold, or dispatch work.
//! Public routes and provider event ingestion are deliberately not wired here.

use super::{NativeChatActor, Result, auth, http, validation};
use crate::runtime_bindings;
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};

mod authority;
mod checkpoint;
mod messages;
pub(super) mod pin;
mod preclaim;
mod projection;
mod reads;
mod stop;

pub use authority::{
    ControlState, StopTargetAuthority, read_control_state, read_stop_target_authority,
};
pub use checkpoint::{ClientCheckpointReceipt, ClientCheckpointRequest, record_client_checkpoint};
pub use messages::{ReadTurn, TurnView, read_turn, read_turn_for_control};
pub use preclaim::{FinalizeUnclaimedStop, UnclaimedStopReceipt, finalize_unclaimed_stop};
pub use reads::{Event, EventPage, ReadEvents, read_events};
pub use stop::request_stop;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StopRequest {
    pub conversation_id: String,
    pub generation_id: String,
    pub control_action_id: String,
    pub expected_attempt_epoch: i32,
    pub expected_control_version: i32,
    pub requested_render_seq: i32,
    pub requested_body_hash: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StopOutcome {
    StopIntentRecorded,
    StopInProgress,
    Stopped,
    CompletionCommitted,
    AlreadyTerminal,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopReceipt {
    pub control_action_id: String,
    pub generation_id: String,
    pub outcome: StopOutcome,
    pub idempotent: bool,
    pub applied_control_version: Option<i32>,
    pub accepted_through_seq: Option<i32>,
    pub frozen_body_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_disposition: Option<String>,
}

struct Target {
    run_id: String,
    agent_id: String,
}

async fn target(
    tx: &mut auth::Tx<'_>,
    actor: &impl NativeChatActor,
    conversation_id: &str,
    generation_id: &str,
) -> Result<Target> {
    let org = actor.organization_id();
    auth::preauthorize_org(tx, actor, org).await?;
    let row = sqlx::query(
        "SELECT r.id::text AS run_id, r.agent_id::text AS agent_id
         FROM chat_generations g JOIN heartbeat_runs r
           ON r.org_id=g.org_id AND r.chat_generation_id=g.id
           AND r.chat_conversation_id=g.conversation_id
         JOIN chat_conversations c ON c.org_id=g.org_id AND c.id=g.conversation_id
         WHERE g.org_id=$1::uuid AND g.id=$2::uuid AND g.conversation_id=$3::uuid
           AND g.execution_authority='native_rust' AND r.execution_authority='native_rust'
           AND c.conversation_kind='chat' AND r.scene='chat'
           AND r.target_type='chat_conversation' AND r.target_id=c.id::text",
    )
    .bind(org)
    .bind(generation_id)
    .bind(conversation_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(404, "Native Chat generation not found"))?;
    let target = Target {
        run_id: row.try_get("run_id")?,
        agent_id: row.try_get("agent_id")?,
    };
    // Historical generations remain readable after selecting a different Agent.
    // Agent actors must still match the actual persisted Run association.
    runtime_bindings::preauthorize_chat_target_read_tx(
        tx,
        actor,
        org,
        conversation_id,
        &target.agent_id,
    )
    .await?;
    Ok(target)
}

fn validate_ids(actor: &impl NativeChatActor, conversation: &str, generation: &str) -> Result<()> {
    canonical_id(actor.organization_id(), "organization id")?;
    canonical_id(conversation, "conversation id")?;
    canonical_id(generation, "generation id")?;
    Ok(())
}

fn canonical_id(value: &str, field: &str) -> Result<()> {
    if validation::canonical_uuid(value, field)? != value {
        return Err(http(400, format!("Expected canonical {field}")));
    }
    Ok(())
}

fn normalize_hash(hash: &str) -> Result<String> {
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(http(422, "Rendered body hash must be SHA-256"));
    }
    Ok(hash.to_ascii_lowercase())
}
