use super::support;

use rudder_auth_core::{
    ActorEnvelope, ActorIdentity, NonceReplayGuard, RequestContext, VerifiedActor,
};
use rudder_d1_persistence::runtime_bindings::{
    Request as BindingRequest, execute as execute_binding,
};
use rudder_d1_persistence::runtime_spans::Request;
use serde_json::json;
use sqlx::PgPool;
use support::{CEO, ORG};

pub(super) const USER: &str = "span-owner";
pub(super) const OTHER_USER: &str = "span-other";
pub(super) const CHAT: &str = "21000000-0000-4000-8000-000000000101";
pub(super) const CHAT_TWO: &str = "21000000-0000-4000-8000-000000000103";
pub(super) const SIDE_CHAT: &str = "21000000-0000-4000-8000-000000000102";
pub(super) const RUN: &str = "64000000-0000-4000-8000-000000000101";
pub(super) const ATTEMPT: &str = "65000000-0000-4000-8000-000000000101";
pub(super) const ATTEMPT_TWO: &str = "65000000-0000-4000-8000-000000000102";
pub(super) const AGENT_TWO: &str = "50000000-0000-4000-8000-000000000002";
pub(super) const SECRET: &[u8] = b"native-chat-runtime-span-test-key";

pub(super) fn actor(user: &str, org: &str, nonce: &str) -> VerifiedActor {
    let identity = ActorIdentity::new("user", user).expect("valid actor");
    let path = format!("/internal/orgs/{org}/runtime-spans");
    let body = b"{}";
    let action = "runtime.span.open";
    let envelope = ActorEnvelope::new(
        identity.clone(),
        org,
        "session-spans",
        3,
        "rudder-server-foundation",
        "POST",
        &path,
        action,
        body,
        format!("request-{nonce}"),
        nonce,
        1_000,
        1_100,
    )
    .expect("create envelope")
    .sign(SECRET)
    .expect("sign envelope");
    let request_id = format!("request-{nonce}");
    let request = RequestContext::new(
        &identity,
        org,
        "session-spans",
        3,
        "rudder-server-foundation",
        "POST",
        &path,
        action,
        body,
        &request_id,
        1_050,
    );
    envelope
        .verify_to_actor(SECRET, &request, &mut NonceReplayGuard::new())
        .expect("verify actor")
}

pub(super) async fn seed_access(pool: &PgPool) {
    sqlx::query(
        "UPDATE agents SET agent_runtime_type='codex_local', status='idle'
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(CEO)
    .execute(pool)
    .await
    .expect("set Agent runtime");
    sqlx::query(
        "INSERT INTO agents (id, org_id, name, role, status, agent_runtime_type)
         VALUES ($1::uuid, $2::uuid, 'Second runtime fixture', 'ceo', 'idle', 'codex_local')",
    )
    .bind(AGENT_TWO)
    .bind(ORG)
    .execute(pool)
    .await
    .expect("insert second Agent");
    for user in [USER, OTHER_USER] {
        sqlx::query(
            "INSERT INTO organization_memberships
               (org_id, principal_type, principal_id, membership_role, status)
             VALUES ($1::uuid, 'user', $2, 'member', 'active')",
        )
        .bind(ORG)
        .bind(user)
        .execute(pool)
        .await
        .expect("insert organization membership");
    }
}

pub(super) async fn seed_chat(pool: &PgPool, id: &str, kind: &str, owner: &str) {
    sqlx::query(
        "INSERT INTO chat_conversations
           (id, org_id, title, conversation_kind, created_by_user_id,
            status, side_chat_state, side_chat_expires_at, preferred_agent_id)
         VALUES ($1::uuid, $2::uuid, 'Run span fixture', $3, $4,
                 'active', CASE WHEN $3='side_chat' THEN 'active' END,
                 CASE WHEN $3='side_chat' THEN clock_timestamp() + interval '1 hour' END,
                 $5::uuid)",
    )
    .bind(id)
    .bind(ORG)
    .bind(kind)
    .bind(owner)
    .bind(CEO)
    .execute(pool)
    .await
    .expect("insert Chat");
}

pub(super) async fn ensure_binding(
    pool: &PgPool,
    actor: &VerifiedActor,
    chat: &str,
) -> (String, String) {
    let request: BindingRequest = serde_json::from_value(json!({
        "operation":"ensure",
        "target":{"targetType":"chat_conversation","targetId":chat},
        "identity":{"agentId":CEO,"profileId":"default"}
    }))
    .expect("binding request");
    let result = execute_binding(pool, actor, ORG, &request)
        .await
        .expect("ensure runtime binding");
    (
        result["binding"]["id"]
            .as_str()
            .expect("binding id")
            .to_owned(),
        result["segment"]["id"]
            .as_str()
            .expect("segment id")
            .to_owned(),
    )
}

pub(super) async fn seed_run_attempt(pool: &PgPool, chat: &str) {
    sqlx::query(
        "INSERT INTO heartbeat_runs
           (id, org_id, agent_id, status, started_at, chat_conversation_id,
            execution_owner_token, execution_lease_expires_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'running', clock_timestamp(), $4::uuid,
                 'attempt-owner-token', clock_timestamp() + interval '1 hour')",
    )
    .bind(RUN)
    .bind(ORG)
    .bind(CEO)
    .bind(chat)
    .execute(pool)
    .await
    .expect("insert running Run");
    sqlx::query(
        "INSERT INTO heartbeat_run_attempts
           (id, org_id, run_id, agent_id, attempt_index, runtime_type, status,
            owner_token, attempt_epoch)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 0, 'codex_local', 'started',
                 'attempt-owner-token', 7)",
    )
    .bind(ATTEMPT)
    .bind(ORG)
    .bind(RUN)
    .bind(CEO)
    .execute(pool)
    .await
    .expect("insert durable attempt");
}

pub(super) fn open_request(binding: &str, segment: &str) -> Request {
    serde_json::from_value(json!({
        "operation":"open","runId":RUN,"attemptId":ATTEMPT,
        "attemptEpoch":7,"ownerToken":"attempt-owner-token",
        "bindingId":binding,"segmentId":segment
    }))
    .expect("open request")
}

pub(super) fn bind_request(
    span: &str,
    native: &str,
    root: Option<&str>,
    leaf: Option<&str>,
) -> Request {
    serde_json::from_value(json!({
        "operation":"bind_locator","spanId":span,"attemptId":ATTEMPT,
        "attemptEpoch":7,"ownerToken":"attempt-owner-token",
        "nativeSessionId":native,"rootSessionId":root,"leafId":leaf
    }))
    .expect("locator request")
}

pub(super) async fn span_counts(pool: &PgPool) -> (i64, i64, i64) {
    sqlx::query_as(
        "SELECT
           (SELECT count(*) FROM run_runtime_spans WHERE org_id=$1::uuid),
           (SELECT count(*) FROM activity_log WHERE org_id=$1::uuid
             AND action IN ('runtime.span.opened','runtime.span.locator_bound')),
           (SELECT count(*) FROM native_segments WHERE org_id=$1::uuid
             AND native_session_id IS NOT NULL)",
    )
    .bind(ORG)
    .fetch_one(pool)
    .await
    .expect("read span effect counts")
}

pub(super) async fn side_chat_lifecycle_snapshot(pool: &PgPool) -> String {
    sqlx::query_scalar(
        "SELECT jsonb_build_object(
           'state', side_chat_state, 'expiresAt', side_chat_expires_at,
           'updatedAt', updated_at
         )::text FROM chat_conversations
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(SIDE_CHAT)
    .fetch_one(pool)
    .await
    .expect("read Side Chat lifecycle snapshot")
}
