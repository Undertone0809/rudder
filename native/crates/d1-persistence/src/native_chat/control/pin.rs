//! Internal action identity; never a provider permit or public response.
use super::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::native_chat) struct ExecutionPin {
    version: u8,
    pub run_id: String,
    pub attempt_id: String,
    pub attempt_index: i32,
    pub attempt_epoch: Option<i32>,
    pub generation_attempt_epoch: Option<i32>,
    pub connection_epoch: Option<i32>,
    identity_hash: String,
    pub checkpoint_hash: String,
}

impl ExecutionPin {
    pub fn same_identity(&self, other: &Self) -> bool {
        self.version == 1
            && other.version == 1
            && self.run_id == other.run_id
            && self.attempt_id == other.attempt_id
            && self.attempt_index == other.attempt_index
            && self.attempt_epoch == other.attempt_epoch
            && self.generation_attempt_epoch == other.generation_attempt_epoch
            && self.connection_epoch == other.connection_epoch
            && self.identity_hash == other.identity_hash
    }
}

pub(in crate::native_chat) fn digest(domain: &str, value: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(json!([domain, value]).to_string().as_bytes())
    )
}

/// Caller already holds Generation, Run and Attempt locks. Bound materialized
/// JSON, and hash owners/provider identities rather than copying them to the
/// control action. PostgreSQL JSON encoding itself is not an allocation cap.
pub(in crate::native_chat) async fn capture(
    tx: &mut auth::Tx<'_>,
    org: &str,
    run: &str,
    attempt: &str,
) -> Result<ExecutionPin> {
    let row = sqlx::query(
        "SELECT a.attempt_index,a.attempt_epoch,a.generation_attempt_epoch,a.connection_epoch,
          CASE WHEN octet_length(f.identity::text)<=65536 THEN f.identity END AS identity,
          CASE WHEN octet_length(f.checkpoint::text)<=16384 THEN f.checkpoint END AS checkpoint
         FROM heartbeat_runs r JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id
         CROSS JOIN LATERAL (SELECT
          jsonb_build_object('org',r.org_id,'agent',r.agent_id,'attemptAgent',a.agent_id,
            'generation',r.chat_generation_id,'conversation',r.chat_conversation_id,
            'runOwner',r.execution_owner_token,'attemptOwner',a.owner_token,
            'runtime',a.runtime_type,'context',r.context_snapshot,'intent',r.session_intent_json,
            'scope',r.session_reuse_scope,'sessionBefore',r.session_id_before) AS identity,
          jsonb_build_object('phase',a.protocol_phase,'checkpoint',a.checkpoint_json,
            'thread',a.provider_thread_id,'turn',a.provider_turn_id) AS checkpoint) f
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND a.id=$3::uuid",
    )
    .bind(org)
    .bind(run)
    .bind(attempt)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(409, "Native Chat action execution changed"))?;
    let identity: Option<Value> = row.try_get("identity")?;
    let checkpoint: Option<Value> = row.try_get("checkpoint")?;
    Ok(ExecutionPin {
        version: 1,
        run_id: run.into(),
        attempt_id: attempt.into(),
        attempt_index: row.try_get("attempt_index")?,
        attempt_epoch: row.try_get("attempt_epoch")?,
        generation_attempt_epoch: row.try_get("generation_attempt_epoch")?,
        connection_epoch: row.try_get("connection_epoch")?,
        identity_hash: digest(
            "native_chat_stop_identity_v1",
            &identity.ok_or_else(|| http(409, "Native Chat action identity exceeds bound"))?,
        ),
        checkpoint_hash: digest(
            "native_chat_stop_checkpoint_v1",
            &checkpoint.ok_or_else(|| http(409, "Native Chat action checkpoint exceeds bound"))?,
        ),
    })
}
