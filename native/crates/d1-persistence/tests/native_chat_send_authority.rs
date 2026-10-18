#[allow(dead_code)]
#[path = "support/mod.rs"]
mod support;

use rudder_auth_core::{
    ActorEnvelope, ActorIdentity, NonceReplayGuard, RequestContext, VerifiedActor,
};
use rudder_d1_persistence::native_chat::{
    Error, SendAuthority, classify_existing_send, classify_first_send,
};
use sqlx::PgPool;
use support::{CEO, Database, ORG, OTHER};

const USER: &str = "native-send-authority-owner";
const CHAT: &str = "21000000-0000-4000-8000-000000000901";
const LEGACY_CHAT: &str = "21000000-0000-4000-8000-000000000902";
const HERMES_CHAT: &str = "21000000-0000-4000-8000-000000000903";
const FOREIGN_CHAT: &str = "21000000-0000-4000-8000-000000000904";
const LEGACY_AGENT: &str = "50000000-0000-4000-8000-000000000901";
const HERMES_AGENT: &str = "50000000-0000-4000-8000-000000000902";
const UNKNOWN_AGENT: &str = "50000000-0000-4000-8000-000000000903";
const FOREIGN_AGENT: &str = "50000000-0000-4000-8000-000000000904";
const SECRET: &[u8] = b"native-chat-send-authority-test-key";

fn actor(nonce: &str, organization_id: &str) -> VerifiedActor {
    let identity = ActorIdentity::new("user", USER).expect("fixture user actor");
    let path = format!("/internal/orgs/{organization_id}/chat/send-authority");
    let body = b"{}";
    let request_id = format!("send-authority-{nonce}");
    ActorEnvelope::new(
        identity.clone(),
        organization_id,
        "test-session",
        1,
        "rudder-server-foundation",
        "POST",
        &path,
        "chat.native_send_authority",
        body,
        &request_id,
        nonce,
        1_000,
        1_100,
    )
    .expect("create envelope")
    .sign(SECRET)
    .expect("sign envelope")
    .verify_to_actor(
        SECRET,
        &RequestContext::new(
            &identity,
            organization_id,
            "test-session",
            1,
            "rudder-server-foundation",
            "POST",
            &path,
            "chat.native_send_authority",
            body,
            &request_id,
            1_050,
        ),
        &mut NonceReplayGuard::new(),
    )
    .expect("verify actor envelope")
}

async fn prepare(database: &Database) {
    sqlx::query(
        "INSERT INTO \"user\"(id,name,email,created_at,updated_at)
         VALUES ($1,'Send authority fixture','native-send-authority@example.test',now(),now())",
    )
    .bind(USER)
    .execute(&database.pool)
    .await
    .expect("seed user");
    sqlx::query(
        "INSERT INTO organization_memberships(org_id,principal_type,principal_id,membership_role,status)
         VALUES($1::uuid,'user',$2,'member','active')",
    )
    .bind(ORG)
    .bind(USER)
    .execute(&database.pool)
    .await
    .expect("seed user organization membership");
    sqlx::query(
        "INSERT INTO agents(id,org_id,name,role,status,agent_runtime_type)
         VALUES
           ($1::uuid,$2::uuid,'Legacy','general','idle','process'),
           ($3::uuid,$2::uuid,'Hermes','general','idle','hermes_local'),
           ($4::uuid,$2::uuid,'Future','general','idle','future_runtime'),
           ($5::uuid,$6::uuid,'Foreign','general','idle','process')",
    )
    .bind(LEGACY_AGENT)
    .bind(ORG)
    .bind(HERMES_AGENT)
    .bind(UNKNOWN_AGENT)
    .bind(FOREIGN_AGENT)
    .bind(OTHER)
    .execute(&database.pool)
    .await
    .expect("seed classifier Agents");
    for (chat_id, agent_id, organization_id) in [
        (CHAT, CEO, ORG),
        (LEGACY_CHAT, LEGACY_AGENT, ORG),
        (HERMES_CHAT, HERMES_AGENT, ORG),
        (FOREIGN_CHAT, CEO, OTHER),
    ] {
        sqlx::query(
            "INSERT INTO chat_conversations
               (id,org_id,title,conversation_kind,created_by_user_id,preferred_agent_id)
             VALUES($1::uuid,$2::uuid,'Send authority fixture','chat',$3,$4::uuid)",
        )
        .bind(chat_id)
        .bind(organization_id)
        .bind(USER)
        .bind(agent_id)
        .execute(&database.pool)
        .await
        .expect("seed Chat");
    }
    sqlx::query("UPDATE agents SET agent_runtime_type='codex_local' WHERE id=$1::uuid")
        .bind(CEO)
        .execute(&database.pool)
        .await
        .expect("set selected Codex Agent");
}

async fn add_native_binding(pool: &PgPool, chat_id: &str, agent_id: &str) {
    sqlx::query(
        "INSERT INTO runtime_bindings
           (org_id,conversation_id,target_type,target_id,principal_scope_ref,agent_id,
            runtime_type,host_id,profile_id,instructions_revision,capability_revision,continuity)
         VALUES($1::uuid,$2::uuid,'chat_conversation',$2,'org:' || $1::text,$3::uuid,
                'codex_local','host-test','default','instructions-v1','capabilities-v1','native')",
    )
    .bind(ORG)
    .bind(chat_id)
    .bind(agent_id)
    .execute(pool)
    .await
    .expect("seed persisted Native binding");
}

#[tokio::test(flavor = "multi_thread")]
async fn current_persisted_runtime_selects_native_or_known_legacy_and_rejects_unknown() {
    let database = Database::start().await;
    prepare(&database).await;
    let authority = classify_existing_send(&database.pool, &actor("codex", ORG), ORG, CHAT)
        .await
        .expect("fresh Codex target classification");
    assert_eq!(authority, SendAuthority::Native);
    let authority = classify_existing_send(&database.pool, &actor("hermes", ORG), ORG, HERMES_CHAT)
        .await
        .expect("Hermes is selected for Native authority even before its executor is integrated");
    assert_eq!(authority, SendAuthority::Native);
    let authority = classify_existing_send(&database.pool, &actor("legacy", ORG), ORG, LEGACY_CHAT)
        .await
        .expect("known legacy Agent classification");
    assert_eq!(authority, SendAuthority::Legacy);

    sqlx::query("UPDATE chat_conversations SET preferred_agent_id=$2::uuid WHERE id=$1::uuid")
        .bind(CHAT)
        .bind(UNKNOWN_AGENT)
        .execute(&database.pool)
        .await
        .expect("set unknown runtime selection");
    assert!(matches!(
        classify_existing_send(&database.pool, &actor("unknown", ORG), ORG, CHAT).await,
        Err(Error::Http(409, _))
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn native_binding_wins_after_runtime_change_and_legacy_history_cannot_be_reimported() {
    let database = Database::start().await;
    prepare(&database).await;
    add_native_binding(&database.pool, CHAT, CEO).await;
    sqlx::query("UPDATE agents SET agent_runtime_type='process' WHERE id=$1::uuid")
        .bind(CEO)
        .execute(&database.pool)
        .await
        .expect("change current Agent runtime after Native binding");
    assert_eq!(
        classify_existing_send(&database.pool, &actor("bound", ORG), ORG, CHAT)
            .await
            .expect("persisted binding keeps Native ownership"),
        SendAuthority::Native
    );

    sqlx::query(
        "INSERT INTO chat_messages(org_id,conversation_id,role,kind,status,body)
         VALUES($1::uuid,$2::uuid,'assistant','message','completed','legacy history')",
    )
    .bind(ORG)
    .bind(LEGACY_CHAT)
    .execute(&database.pool)
    .await
    .expect("seed legacy history");
    sqlx::query("UPDATE agents SET agent_runtime_type='codex_local' WHERE id=$1::uuid")
        .bind(LEGACY_AGENT)
        .execute(&database.pool)
        .await
        .expect("change legacy Chat preference to Codex");
    assert!(matches!(
        classify_existing_send(&database.pool, &actor("history", ORG), ORG, LEGACY_CHAT).await,
        Err(Error::Http(409, _))
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn first_send_retry_preserves_exact_native_or_legacy_mutation_authority() {
    let database = Database::start().await;
    prepare(&database).await;
    sqlx::query(
        "UPDATE chat_conversations SET initial_client_mutation_id='native-retry'
         WHERE id=$1::uuid",
    )
    .bind(CHAT)
    .execute(&database.pool)
    .await
    .expect("set Native retry identity");
    add_native_binding(&database.pool, CHAT, CEO).await;
    sqlx::query(
        "UPDATE chat_conversations SET initial_client_mutation_id='legacy-retry'
         WHERE id=$1::uuid",
    )
    .bind(LEGACY_CHAT)
    .execute(&database.pool)
    .await
    .expect("set legacy retry identity");

    assert_eq!(
        classify_first_send(
            &database.pool,
            &actor("native-retry", ORG),
            ORG,
            Some("native-retry"),
            Some(LEGACY_AGENT),
        )
        .await
        .expect("Native mutation key wins over changed request Agent"),
        SendAuthority::Native
    );
    assert_eq!(
        classify_first_send(
            &database.pool,
            &actor("legacy-retry", ORG),
            ORG,
            Some("legacy-retry"),
            Some(CEO),
        )
        .await
        .expect("legacy mutation key remains on compatibility route"),
        SendAuthority::Legacy
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn classifier_hides_foreign_targets_and_rejects_foreign_agent_hints() {
    let database = Database::start().await;
    prepare(&database).await;
    assert!(matches!(
        classify_existing_send(
            &database.pool,
            &actor("foreign-target", ORG),
            ORG,
            FOREIGN_CHAT
        )
        .await,
        Err(Error::Http(404, _))
    ));
    assert!(matches!(
        classify_first_send(
            &database.pool,
            &actor("foreign-agent", ORG),
            ORG,
            None,
            Some(FOREIGN_AGENT),
        )
        .await,
        Err(Error::Http(422, _))
    ));
    assert!(matches!(
        classify_first_send(
            &database.pool,
            &actor("foreign-org", ORG),
            OTHER,
            None,
            Some(FOREIGN_AGENT),
        )
        .await,
        Err(Error::Http(403, _))
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn missing_agent_cannot_route_mixed_native_and_legacy_defaults_through_node() {
    let database = Database::start().await;
    prepare(&database).await;
    assert!(matches!(
        classify_first_send(
            &database.pool,
            &actor("mixed-default", ORG),
            ORG,
            None,
            None
        )
        .await,
        Err(Error::Http(409, _))
    ));
    sqlx::query("UPDATE agents SET agent_runtime_type='codex_local' WHERE org_id=$1::uuid")
        .bind(ORG)
        .execute(&database.pool)
        .await
        .expect("all default candidates are Native");
    assert!(matches!(
        classify_first_send(
            &database.pool,
            &actor("native-default", ORG),
            ORG,
            None,
            None
        )
        .await,
        Err(Error::Http(422, _))
    ));
    sqlx::query("UPDATE agents SET agent_runtime_type='process' WHERE org_id=$1::uuid")
        .bind(ORG)
        .execute(&database.pool)
        .await
        .expect("all default candidates are known legacy");
    assert_eq!(
        classify_first_send(
            &database.pool,
            &actor("legacy-default", ORG),
            ORG,
            None,
            None
        )
        .await
        .unwrap(),
        SendAuthority::Legacy
    );
    sqlx::query("UPDATE agents SET agent_runtime_type='unknown_runtime' WHERE id=$1::uuid")
        .bind(CEO)
        .execute(&database.pool)
        .await
        .expect("unknown default candidate");
    assert!(matches!(
        classify_first_send(
            &database.pool,
            &actor("unknown-default", ORG),
            ORG,
            None,
            None
        )
        .await,
        Err(Error::Http(409, _))
    ));
}
