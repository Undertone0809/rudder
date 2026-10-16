// Shared harness also exposes organization-mutation helpers used by other suites.
#[allow(dead_code)]
mod support;

use rudder_auth_core::{
    ActorEnvelope, ActorIdentity, NonceReplayGuard, RequestContext, VerifiedActor,
};
use rudder_d1_persistence::runtime_bindings::{Error, Request, execute};
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{CEO, Database, ORG, OTHER};

const USER: &str = "owner-user";
const CHAT: &str = "21000000-0000-4000-8000-000000000001";
const CHAT_TWO: &str = "21000000-0000-4000-8000-000000000002";
const CHAT_FOREIGN: &str = "21000000-0000-4000-8000-000000000003";
const CHAT_NULL_OWNER: &str = "21000000-0000-4000-8000-000000000004";
const SIDE_PRIVATE: &str = "21000000-0000-4000-8000-000000000009";
const SIDE_NULL_OWNER: &str = "21000000-0000-4000-8000-000000000010";
const CHAT_AUDIT_FAILURE: &str = "21000000-0000-4000-8000-000000000011";
const SIDE_NULL_EXPIRY: &str = "21000000-0000-4000-8000-000000000012";
const SIDE_PAST_EXPIRY: &str = "21000000-0000-4000-8000-000000000013";
const SIDE_KEPT: &str = "21000000-0000-4000-8000-000000000014";
const CHAT_PENDING_AGENT: &str = "21000000-0000-4000-8000-000000000015";
const SECRET: &[u8] = b"native-chat-runtime-binding-test-key";

fn verified_actor(kind: &str, id: &str, org: &str, session: &str, nonce: &str) -> VerifiedActor {
    let actor = ActorIdentity::new(kind, id).expect("valid actor identity");
    let path = format!("/internal/orgs/{org}/runtime-bindings");
    let body = b"{}";
    let envelope = ActorEnvelope::new(
        actor.clone(),
        org,
        session,
        3,
        "rudder-server-foundation",
        "POST",
        &path,
        "runtime.binding.ensure",
        body,
        format!("request-{nonce}"),
        nonce,
        1_000,
        1_100,
    )
    .expect("unsigned envelope")
    .sign(SECRET)
    .expect("signed envelope");
    let request_id = format!("request-{nonce}");
    let request = RequestContext::new(
        &actor,
        org,
        session,
        3,
        "rudder-server-foundation",
        "POST",
        &path,
        "runtime.binding.ensure",
        body,
        &request_id,
        1_050,
    );
    envelope
        .verify_to_actor(SECRET, &request, &mut NonceReplayGuard::new())
        .expect("verified actor token")
}

fn owner(org: &str, nonce: &str) -> VerifiedActor {
    verified_actor("user", USER, org, "session-owner", nonce)
}

fn ensure_request(chat_id: &str, agent_id: &str, profile_id: &str) -> Request {
    serde_json::from_value(json!({
        "operation":"ensure",
        "target":{"targetType":"chat_conversation","targetId":chat_id},
        "identity":{"agentId":agent_id,"profileId":profile_id}
    }))
    .expect("valid ensure request")
}

fn current_request(chat_id: &str) -> Request {
    serde_json::from_value(json!({
        "operation":"current",
        "target":{"targetType":"chat_conversation","targetId":chat_id}
    }))
    .expect("valid current request")
}

fn read_request(binding_id: &str) -> Request {
    serde_json::from_value(json!({"operation":"read","bindingId":binding_id}))
        .expect("valid read request")
}

async fn seed_chat(
    pool: &PgPool,
    id: &str,
    org: &str,
    owner: Option<&str>,
    kind: &str,
    side_state: Option<&str>,
    preferred_agent: Option<&str>,
) {
    sqlx::query(
        "INSERT INTO chat_conversations
           (id, org_id, title, conversation_kind, created_by_user_id, status,
            side_chat_state, preferred_agent_id, side_chat_expires_at)
         VALUES ($1::uuid, $2::uuid, 'Synthetic Chat', $3, $4, 'active', $5, $6::uuid,
                 CASE WHEN $3='side_chat' AND $5='active'
                      THEN clock_timestamp() + interval '1 hour' ELSE NULL END)",
    )
    .bind(id)
    .bind(org)
    .bind(kind)
    .bind(owner)
    .bind(side_state)
    .bind(preferred_agent.or(Some(CEO)))
    .execute(pool)
    .await
    .expect("seed chat conversation");
}

async fn side_chat_snapshot(pool: &PgPool, conversation_id: &str) -> String {
    sqlx::query_scalar(
        "SELECT jsonb_build_object(
           'status', c.status,
           'sideChatState', c.side_chat_state,
           'sideChatExpiresAt', c.side_chat_expires_at,
           'updatedAt', c.updated_at,
           'bindings', (SELECT count(*) FROM runtime_bindings b
                        WHERE b.org_id=c.org_id AND b.conversation_id=c.id),
           'segments', (SELECT count(*) FROM native_segments s
                        JOIN runtime_bindings b ON b.org_id=s.org_id AND b.id=s.binding_id
                        WHERE b.org_id=c.org_id AND b.conversation_id=c.id),
           'audit', (SELECT count(*) FROM activity_log a
                     WHERE a.org_id=c.org_id AND a.action='runtime.binding.created'
                       AND a.entity_id IN (SELECT b.id::text FROM runtime_bindings b
                                           WHERE b.org_id=c.org_id AND b.conversation_id=c.id))
         )::text
         FROM chat_conversations c WHERE c.org_id=$1::uuid AND c.id=$2::uuid",
    )
    .bind(ORG)
    .bind(conversation_id)
    .fetch_one(pool)
    .await
    .expect("read side chat snapshot")
}

async fn seed_agent(pool: &PgPool) {
    sqlx::query("UPDATE agents SET agent_runtime_type='codex_local', status='idle' WHERE id=$1::uuid AND org_id=$2::uuid")
        .bind(CEO)
        .bind(ORG)
        .execute(pool)
        .await
        .expect("set synthetic local runtime type");
}

async fn seed_memberships(pool: &PgPool) {
    for (org, kind, id) in [
        (ORG, "user", USER),
        (ORG, "user", "someone-else"),
        (OTHER, "user", USER),
    ] {
        sqlx::query(
            "INSERT INTO organization_memberships(org_id, principal_type, principal_id, membership_role, status)
             VALUES($1::uuid, $2, $3, 'member', 'active')",
        )
        .bind(org)
        .bind(kind)
        .bind(id)
        .execute(pool)
        .await
        .expect("seed organization membership");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn ensure_is_concurrent_idempotent_and_rejects_identity_rotation() {
    let database = Database::start().await;
    seed_agent(&database.pool).await;
    seed_memberships(&database.pool).await;
    seed_chat(&database.pool, CHAT, ORG, Some(USER), "chat", None, None).await;
    let actor = owner(ORG, "ensure-concurrent");
    let request = ensure_request(CHAT, CEO, "default");

    // Every concurrent identical request must converge on one durable binding
    // and one initial pending segment.
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let pool = database.pool.clone();
        let actor = actor.clone();
        let request = request.clone();
        tasks.push(tokio::spawn(async move {
            execute(&pool, &actor, ORG, &request).await
        }));
    }
    let mut results = Vec::new();
    for task in tasks {
        results.push(
            task.await
                .expect("ensure task joined")
                .expect("ensure succeeded"),
        );
    }
    let binding_id = results[0]["binding"]["id"]
        .as_str()
        .expect("binding id")
        .to_owned();
    let segment_id = results[0]["segment"]["id"]
        .as_str()
        .expect("segment id")
        .to_owned();
    for result in &results {
        assert_eq!(result["binding"]["id"], binding_id);
        assert_eq!(result["segment"]["id"], segment_id);
        assert_eq!(result["binding"]["bindingEpoch"], 0);
        assert_eq!(result["binding"]["runtimeType"], "codex_local");
        assert_eq!(result["binding"]["principalScopeRef"], format!("org:{ORG}"));
        assert_eq!(result["segment"]["state"], "pending");
        assert_eq!(result["segment"]["nativeSessionId"], Value::Null);
        assert_eq!(result["segment"]["providerState"], Value::Null);
    }

    // A different profile is a conflict. It must not supersede or create an
    // epoch, even after a valid binding already exists.
    let changed = ensure_request(CHAT, CEO, "different-profile");
    assert!(matches!(
        execute(&database.pool, &actor, ORG, &changed).await,
        Err(Error::Http(409, _))
    ));
    let rows: (i64, i64, i64) = sqlx::query_as(
        "SELECT count(*), count(*) FILTER (WHERE status='active'),
                count(DISTINCT binding_epoch)
         FROM runtime_bindings WHERE org_id=$1::uuid AND target_id=$2",
    )
    .bind(ORG)
    .bind(CHAT)
    .fetch_one(&database.pool)
    .await
    .expect("count bindings");
    assert_eq!(rows, (1, 1, 1));
    let segment_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM native_segments WHERE binding_id=$1::uuid")
            .bind(&binding_id)
            .fetch_one(&database.pool)
            .await
            .expect("count initial segment");
    assert_eq!(segment_count, 1);
    let audit_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log WHERE action='runtime.binding.created' AND entity_id=$1",
    )
    .bind(&binding_id)
    .fetch_one(&database.pool)
    .await
    .expect("count binding audit events");
    assert_eq!(audit_count, 1);

    // current/read are pure projections and preserve the binding timestamp and
    // segment state across calls.
    let before: (String, String, String) = sqlx::query_as(
        "SELECT b.updated_at::text, s.updated_at::text, s.state
         FROM runtime_bindings b JOIN native_segments s ON s.id=b.current_segment_id
         WHERE b.org_id=$1::uuid AND b.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&binding_id)
    .fetch_one(&database.pool)
    .await
    .expect("capture read baseline");
    let current = execute(&database.pool, &actor, ORG, &current_request(CHAT))
        .await
        .expect("current binding");
    let read = execute(&database.pool, &actor, ORG, &read_request(&binding_id))
        .await
        .expect("read binding");
    assert_eq!(current["binding"]["id"], binding_id);
    assert_eq!(read["binding"]["id"], binding_id);
    assert_eq!(read["segment"]["id"], segment_id);
    let after: (String, String, String) = sqlx::query_as(
        "SELECT b.updated_at::text, s.updated_at::text, s.state
         FROM runtime_bindings b JOIN native_segments s ON s.id=b.current_segment_id
         WHERE b.org_id=$1::uuid AND b.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&binding_id)
    .fetch_one(&database.pool)
    .await
    .expect("capture read result");
    assert_eq!(before, after);

    // If the transactional outbox insert fails after the activity row is
    // written, the binding, segment, and audit entry must all roll back.
    seed_chat(
        &database.pool,
        CHAT_AUDIT_FAILURE,
        ORG,
        Some(USER),
        "chat",
        None,
        None,
    )
    .await;
    database
        .sql(
            "CREATE FUNCTION fail_runtime_binding_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN
               IF NEW.event_type='activity.logged' THEN RAISE EXCEPTION 'synthetic outbox failure'; END IF;
               RETURN NEW;
             END; $$;
             CREATE TRIGGER fail_runtime_binding_outbox_trigger
               BEFORE INSERT ON organization_mutation_outbox
               FOR EACH ROW EXECUTE FUNCTION fail_runtime_binding_outbox();",
        )
        .await;
    assert!(matches!(
        execute(
            &database.pool,
            &actor,
            ORG,
            &ensure_request(CHAT_AUDIT_FAILURE, CEO, "default"),
        )
        .await,
        Err(Error::Database(_))
    ));
    database
        .sql(
            "DROP TRIGGER fail_runtime_binding_outbox_trigger ON organization_mutation_outbox;
             DROP FUNCTION fail_runtime_binding_outbox();",
        )
        .await;
    let rolled_back: (i64, i64, i64) = sqlx::query_as(
        "SELECT
           (SELECT count(*) FROM runtime_bindings WHERE target_id=$1),
           (SELECT count(*) FROM native_segments s JOIN runtime_bindings b ON b.id=s.binding_id WHERE b.target_id=$1),
           (SELECT count(*) FROM activity_log WHERE action='runtime.binding.created' AND entity_id IN
             (SELECT id::text FROM runtime_bindings WHERE target_id=$1))",
    )
    .bind(CHAT_AUDIT_FAILURE)
    .fetch_one(&database.pool)
    .await
    .expect("check transaction rollback");
    assert_eq!(rolled_back, (0, 0, 0));
}

#[tokio::test(flavor = "multi_thread")]
async fn ensure_and_reads_enforce_owner_agent_side_chat_and_org_boundaries() {
    let database = Database::start().await;
    seed_agent(&database.pool).await;
    seed_memberships(&database.pool).await;
    seed_chat(&database.pool, CHAT, ORG, Some(USER), "chat", None, None).await;
    seed_chat(
        &database.pool,
        CHAT_TWO,
        ORG,
        Some("someone-else"),
        "chat",
        None,
        None,
    )
    .await;
    seed_chat(
        &database.pool,
        CHAT_FOREIGN,
        OTHER,
        Some(USER),
        "chat",
        None,
        None,
    )
    .await;
    seed_chat(
        &database.pool,
        CHAT_NULL_OWNER,
        ORG,
        None,
        "chat",
        None,
        None,
    )
    .await;
    let actor = owner(ORG, "owner-boundary");
    let ensured = execute(
        &database.pool,
        &actor,
        ORG,
        &ensure_request(CHAT, CEO, "default"),
    )
    .await
    .expect("owner can ensure own conversation");
    let binding_id = ensured["binding"]["id"].as_str().unwrap();

    let shared_chat = execute(
        &database.pool,
        &actor,
        ORG,
        &ensure_request(CHAT_TWO, CEO, "default"),
    )
    .await
    .expect("organization member can access shared normal Chat");
    assert_eq!(
        shared_chat["binding"]["principalScopeRef"],
        format!("org:{ORG}")
    );
    let legacy_chat = execute(
        &database.pool,
        &actor,
        ORG,
        &ensure_request(CHAT_NULL_OWNER, CEO, "default"),
    )
    .await
    .expect("normal Chat with no legacy owner remains organization-scoped");
    assert_eq!(
        legacy_chat["binding"]["principalScopeRef"],
        format!("org:{ORG}")
    );
    assert!(matches!(
        execute(
            &database.pool,
            &actor,
            OTHER,
            &ensure_request(CHAT_FOREIGN, CEO, "default")
        )
        .await,
        Err(Error::Http(403, _))
    ));

    // A binding identifier from another organization is indistinguishable from
    // a missing row; route organization mismatch is rejected before querying.
    assert!(matches!(
        execute(&database.pool, &actor, OTHER, &read_request(binding_id)).await,
        Err(Error::Http(403, _))
    ));
    let foreign_actor = owner(OTHER, "foreign-owner");
    assert!(matches!(
        execute(
            &database.pool,
            &foreign_actor,
            OTHER,
            &read_request(binding_id)
        )
        .await,
        Err(Error::Http(404, _))
    ));

    // Agent actors can address only their own selected/assigned runtime and
    // still inherit the target owner's stable principal scope.
    let assigned_chat = "21000000-0000-4000-8000-000000000005";
    seed_chat(
        &database.pool,
        assigned_chat,
        ORG,
        Some(USER),
        "chat",
        None,
        Some(CEO),
    )
    .await;
    let agent = verified_actor("agent", CEO, ORG, "session-agent", "agent-owner");
    let agent_result = execute(
        &database.pool,
        &agent,
        ORG,
        &ensure_request(assigned_chat, CEO, "default"),
    )
    .await
    .expect("assigned agent can ensure target");
    assert_eq!(
        agent_result["binding"]["principalScopeRef"],
        format!("org:{ORG}")
    );
    assert!(
        execute(&database.pool, &agent, ORG, &read_request(binding_id))
            .await
            .is_ok()
    );

    seed_chat(
        &database.pool,
        CHAT_PENDING_AGENT,
        ORG,
        Some(USER),
        "chat",
        None,
        Some(CEO),
    )
    .await;
    sqlx::query(
        "UPDATE agents SET status='pending_approval' WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("mark selected agent as pending approval");
    assert!(matches!(
        execute(
            &database.pool,
            &actor,
            ORG,
            &ensure_request(CHAT_PENDING_AGENT, CEO, "default")
        )
        .await,
        Err(Error::Http(409, _))
    ));
    assert!(matches!(
        execute(&database.pool, &agent, ORG, &read_request(binding_id)).await,
        Err(Error::Http(403, _))
    ));
    sqlx::query("UPDATE agents SET status='idle' WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(ORG)
        .bind(CEO)
        .execute(&database.pool)
        .await
        .expect("restore selected agent status");

    // Side Chats are owner-scoped and a completed Side Chat cannot gain a new
    // binding. The trusted local implicit pair must also match the persisted
    // local-board owner rather than falling back to organization scope.
    let side_chat = "21000000-0000-4000-8000-000000000006";
    let completed_side_chat = "21000000-0000-4000-8000-000000000007";
    let local_chat = "21000000-0000-4000-8000-000000000008";
    seed_chat(
        &database.pool,
        SIDE_PRIVATE,
        ORG,
        Some("someone-else"),
        "side_chat",
        Some("active"),
        None,
    )
    .await;
    seed_chat(
        &database.pool,
        SIDE_NULL_OWNER,
        ORG,
        None,
        "side_chat",
        Some("active"),
        None,
    )
    .await;
    seed_chat(
        &database.pool,
        side_chat,
        ORG,
        Some(USER),
        "side_chat",
        Some("active"),
        None,
    )
    .await;
    seed_chat(
        &database.pool,
        completed_side_chat,
        ORG,
        Some(USER),
        "side_chat",
        Some("completed"),
        None,
    )
    .await;
    seed_chat(
        &database.pool,
        SIDE_NULL_EXPIRY,
        ORG,
        Some(USER),
        "side_chat",
        Some("active"),
        None,
    )
    .await;
    seed_chat(
        &database.pool,
        SIDE_PAST_EXPIRY,
        ORG,
        Some(USER),
        "side_chat",
        Some("active"),
        None,
    )
    .await;
    seed_chat(
        &database.pool,
        SIDE_KEPT,
        ORG,
        Some(USER),
        "side_chat",
        Some("kept"),
        None,
    )
    .await;
    sqlx::query(
        "UPDATE chat_conversations SET side_chat_expires_at=NULL
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(SIDE_NULL_EXPIRY)
    .execute(&database.pool)
    .await
    .expect("clear active Side Chat expiry");
    sqlx::query(
        "UPDATE chat_conversations SET side_chat_expires_at=clock_timestamp()-interval '1 second'
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(SIDE_PAST_EXPIRY)
    .execute(&database.pool)
    .await
    .expect("expire active Side Chat");
    seed_chat(
        &database.pool,
        local_chat,
        ORG,
        Some("local-board"),
        "chat",
        None,
        None,
    )
    .await;
    let side_result = execute(
        &database.pool,
        &actor,
        ORG,
        &ensure_request(side_chat, CEO, "default"),
    )
    .await
    .expect("Side Chat owner can ensure private target");
    assert_eq!(
        side_result["binding"]["principalScopeRef"],
        format!("user:{USER}")
    );
    let side_chat_binding_id = side_result["binding"]["id"]
        .as_str()
        .expect("Side Chat binding id");
    let non_owner = verified_actor(
        "user",
        "someone-else",
        ORG,
        "session-other",
        "side-read-other",
    );
    assert!(matches!(
        execute(
            &database.pool,
            &non_owner,
            ORG,
            &read_request(side_chat_binding_id)
        )
        .await,
        Err(Error::Http(404, _))
    ));
    assert!(matches!(
        execute(
            &database.pool,
            &actor,
            ORG,
            &ensure_request(completed_side_chat, CEO, "default")
        )
        .await,
        Err(Error::Http(409, _))
    ));
    assert!(matches!(
        execute(
            &database.pool,
            &actor,
            ORG,
            &ensure_request(SIDE_PRIVATE, CEO, "default")
        )
        .await,
        Err(Error::Http(404, _))
    ));
    for expired_side_chat in [SIDE_NULL_EXPIRY, SIDE_PAST_EXPIRY] {
        let before = side_chat_snapshot(&database.pool, expired_side_chat).await;
        assert!(matches!(
            execute(
                &database.pool,
                &actor,
                ORG,
                &ensure_request(expired_side_chat, CEO, "default")
            )
            .await,
            Err(Error::Http(409, _))
        ));
        assert_eq!(
            side_chat_snapshot(&database.pool, expired_side_chat).await,
            before,
            "expired Side Chat ensure must not mutate the row or create binding/segment/audit"
        );
    }
    let kept_result = execute(
        &database.pool,
        &actor,
        ORG,
        &ensure_request(SIDE_KEPT, CEO, "default"),
    )
    .await
    .expect("kept Side Chat remains mutable without an expiry");
    assert_eq!(
        kept_result["binding"]["principalScopeRef"],
        format!("user:{USER}")
    );
    assert!(matches!(
        execute(
            &database.pool,
            &actor,
            ORG,
            &ensure_request(SIDE_NULL_OWNER, CEO, "default")
        )
        .await,
        Err(Error::Http(404, _))
    ));
    let local_implicit = verified_actor(
        "user",
        "local-board",
        ORG,
        "local-implicit",
        "local-implicit",
    );
    let local_result = execute(
        &database.pool,
        &local_implicit,
        ORG,
        &ensure_request(local_chat, CEO, "default"),
    )
    .await
    .expect("signed local implicit board can ensure shared Chat");
    assert_eq!(
        local_result["binding"]["principalScopeRef"],
        format!("org:{ORG}")
    );
    // Changing the conversation's owner must not transfer the previous owner's
    // immutable native binding to the new owner, including public projections.
    database.sql(&format!(
        "UPDATE chat_conversations SET created_by_user_id='someone-else' WHERE id='{side_chat}'::uuid"
    )).await;
    let before = side_chat_snapshot(&database.pool, side_chat).await;
    for request in [
        current_request(side_chat),
        read_request(side_chat_binding_id),
        serde_json::from_value(json!({"operation":"public_current","target":{"targetType":"chat_conversation","targetId":side_chat}})).unwrap(),
        serde_json::from_value(json!({"operation":"public_read","bindingId":side_chat_binding_id})).unwrap(),
    ] {
        assert!(matches!(
            execute(&database.pool, &non_owner, ORG, &request).await,
            Err(Error::Http(404, _))
        ));
    }
    assert_eq!(side_chat_snapshot(&database.pool, side_chat).await, before);
}
