use super::*;
use rudder_d1_persistence::native_chat::{BrowserCredentialBinding, BrowserPrincipal};
use sha2::{Digest, Sha256};

const SESSION_ID: &str = "browser-session-native-chat";
const SESSION_TOKEN: &str = "fixture-session-token-never-returned";
const BOARD_KEY_ID: &str = "60000000-0000-4000-8000-000000000001";
const BOARD_KEY_TOKEN: &str = "fixture-board-key-token-never-returned";
const SECOND_CHAT: &str = "21000000-0000-4000-8000-000000000202";

fn digest(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}

fn verified_agent_actor(organization_id: &str, agent_id: &str, nonce: &str) -> VerifiedActor {
    let actor = ActorIdentity::new("agent", agent_id).expect("valid Agent actor identity");
    let path = format!("/internal/orgs/{organization_id}/native-chat-execution");
    let body = b"{}";
    let request_id = format!("execution-agent-{nonce}");
    let envelope = ActorEnvelope::new(
        actor.clone(),
        organization_id,
        "agent-api-key-native-chat-execution",
        1,
        "rudder-server-foundation",
        "POST",
        &path,
        "runtime.native_chat.execution",
        body,
        &request_id,
        nonce,
        1_000,
        1_100,
    )
    .expect("unsigned Agent envelope")
    .sign(SECRET)
    .expect("signed Agent envelope");
    let request = RequestContext::new(
        &actor,
        organization_id,
        "agent-api-key-native-chat-execution",
        1,
        "rudder-server-foundation",
        "POST",
        &path,
        "runtime.native_chat.execution",
        body,
        &request_id,
        1_050,
    );
    envelope
        .verify_to_actor(SECRET, &request, &mut NonceReplayGuard::new())
        .expect("verified Agent actor")
}

fn browser_session_principal() -> BrowserPrincipal {
    BrowserPrincipal::from_trusted_browser_auth(
        USER,
        ORG,
        SESSION_ID,
        BrowserCredentialBinding::session(SESSION_ID, digest(SESSION_TOKEN)),
    )
    .expect("Foundation-authenticated session adapter")
}

fn browser_board_key_principal() -> BrowserPrincipal {
    BrowserPrincipal::from_trusted_browser_auth(
        USER,
        ORG,
        &format!("board-key:{BOARD_KEY_ID}"),
        BrowserCredentialBinding::board_key(BOARD_KEY_ID, digest(BOARD_KEY_TOKEN)),
    )
    .expect("Foundation-authenticated board-key adapter")
}

async fn seed_browser_target(database: &Database, host: &ExecutionHost) {
    sqlx::query(
        "INSERT INTO \"user\"(id,name,email,created_at,updated_at)
         VALUES ($1,'Browser fixture','native-chat-browser@example.test',now(),now())",
    )
    .bind(USER)
    .execute(&database.pool)
    .await
    .expect("seed browser user row");
    sqlx::query(
        "INSERT INTO organization_memberships(org_id,principal_type,principal_id,membership_role,status)
         VALUES ($1::uuid,'user',$2,'member','active')",
    )
    .bind(ORG)
    .bind(USER)
    .execute(&database.pool)
    .await
    .expect("seed browser organization membership");
    sqlx::query(
        "UPDATE agents SET agent_runtime_type='codex_local',status='idle',
           workspace_key='codex-agent',agent_runtime_config=$1::jsonb
         WHERE org_id=$2::uuid AND id=$3::uuid",
    )
    .bind(host.persisted_agent_config().to_string())
    .bind(ORG)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("persist trusted Codex local runtime defaults");
    sqlx::query(
        "INSERT INTO chat_conversations
           (id,org_id,title,conversation_kind,created_by_user_id,status,preferred_agent_id)
         VALUES ($1::uuid,$2::uuid,'Browser Native Chat fixture','chat',$3,'active',$4::uuid)",
    )
    .bind(CHAT)
    .bind(ORG)
    .bind(USER)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("seed browser-owned ordinary Chat");
}

async fn seed_second_browser_chat(database: &Database) {
    sqlx::query(
        "INSERT INTO chat_conversations
           (id,org_id,title,conversation_kind,created_by_user_id,status,preferred_agent_id)
         VALUES ($1::uuid,$2::uuid,'Second Browser fixture','chat',$3,'active',$4::uuid)",
    )
    .bind(SECOND_CHAT)
    .bind(ORG)
    .bind(USER)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("seed second browser-owned ordinary Chat");
}

async fn admit_browser_turn(
    database: &Database,
    host: &ExecutionHost,
    actor: &BrowserPrincipal,
    conversation_id: &str,
    mutation_id: &str,
) -> (String, String) {
    let request: AdmissionRequest = serde_json::from_value(json!({
        "operation":"submit_native_chat_turn",
        "conversationId":conversation_id,
        "clientMutationId":mutation_id,
        "body":"browser-authenticated execution capability fixture"
    }))
    .unwrap();
    let receipt = execute(&database.pool, actor, ORG, &request, host.context())
        .await
        .expect("admit browser turn");
    (
        receipt["runId"].as_str().unwrap().to_owned(),
        receipt["attemptId"].as_str().unwrap().to_owned(),
    )
}

async fn claim_browser_turn(
    database: &Database,
    host: &ExecutionHost,
    actor: &BrowserPrincipal,
    run_id: &str,
    attempt_id: &str,
) -> (
    rudder_d1_persistence::native_chat::NativeChatExecutionPrincipal,
    rudder_d1_persistence::native_chat::execution::ExecutionFence,
) {
    let (principal, fence, _config, _permit) = claim(
        &database.pool,
        actor,
        ORG,
        run_id,
        attempt_id,
        host.context(),
    )
    .await
    .expect("claim browser turn")
    .into_execution_parts();
    (principal, fence)
}

async fn native_admission_counts(database: &Database) -> (i64, i64, i64, i64, i64, i64, i64) {
    sqlx::query_as(
        "SELECT
           (SELECT count(*) FROM chat_messages WHERE org_id=$1::uuid AND conversation_id=$2::uuid),
           (SELECT count(*) FROM chat_generations WHERE org_id=$1::uuid AND conversation_id=$2::uuid),
           (SELECT count(*) FROM heartbeat_runs WHERE org_id=$1::uuid AND chat_conversation_id=$2::uuid),
           (SELECT count(*) FROM heartbeat_run_attempts a JOIN heartbeat_runs r ON r.org_id=a.org_id AND r.id=a.run_id WHERE r.org_id=$1::uuid AND r.chat_conversation_id=$2::uuid),
           (SELECT count(*) FROM activity_log WHERE org_id=$1::uuid),
           (SELECT count(*) FROM runtime_bindings WHERE org_id=$1::uuid AND target_type='chat_conversation' AND target_id=$2),
           (SELECT count(*) FROM native_segments WHERE org_id=$1::uuid AND binding_id IN (SELECT id FROM runtime_bindings WHERE org_id=$1::uuid AND target_type='chat_conversation' AND target_id=$2))",
    )
    .bind(ORG)
    .bind(CHAT)
    .fetch_one(&database.pool)
    .await
    .unwrap()
}

async fn seed_session(database: &Database, expiry_sql: &str) {
    let insert = format!(
        "INSERT INTO session(id,expires_at,token,created_at,updated_at,user_id)
         VALUES ($1,{expiry_sql},$2,now(),now(),$3)"
    );
    sqlx::query(&insert)
        .bind(SESSION_ID)
        .bind(SESSION_TOKEN)
        .bind(USER)
        .execute(&database.pool)
        .await
        .expect("seed exact Browser session row");
}

async fn claim_state_snapshot(database: &Database, run_id: &str, attempt_id: &str) -> Value {
    sqlx::query_scalar(
        "SELECT jsonb_build_object(
           'generationHold',g.native_admission_hold,
           'generationOwnerPresent',g.control_owner_token IS NOT NULL,
           'generationLeasePresent',g.control_lease_expires_at IS NOT NULL,
           'runHold',r.native_admission_hold,
           'attemptModel',a.model,
           'spanCount',(SELECT count(*) FROM run_runtime_spans s
             WHERE s.org_id=a.org_id AND s.run_id=a.run_id AND s.attempt_id=a.id),
           'claimActivityCount',(SELECT count(*) FROM activity_log l
             WHERE l.org_id=a.org_id AND l.run_id=a.run_id
               AND l.action='runtime.native_chat.execution_claimed')
         )
         FROM heartbeat_run_attempts a
         JOIN heartbeat_runs r ON r.org_id=a.org_id AND r.id=a.run_id
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         WHERE a.org_id=$1::uuid AND r.id=$2::uuid AND a.id=$3::uuid",
    )
    .bind(ORG)
    .bind(run_id)
    .bind(attempt_id)
    .fetch_one(&database.pool)
    .await
    .expect("read exact claim side-effect snapshot")
}

#[tokio::test(flavor = "multi_thread")]
async fn session_principal_admits_only_after_d1_revalidates_live_row_and_user() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    seed_browser_target(&database, &host).await;
    seed_session(&database, "clock_timestamp()+interval '5 minutes'").await;
    let actor = browser_session_principal();
    let request: AdmissionRequest = serde_json::from_value(json!({
        "operation":"submit_native_chat_turn",
        "conversationId":CHAT,
        "clientMutationId":"browser-session-admission",
        "body":"one browser-authenticated input"
    }))
    .unwrap();

    let receipt = execute(&database.pool, &actor, ORG, &request, host.context())
        .await
        .expect("live session authorizes D1 admission");
    assert_eq!(receipt["executionAuthority"], "native_rust");
    // Admission has not claimed a worker yet; claim establishes the held
    // execution. Browser authentication must preserve that existing contract.
    assert_eq!(receipt["nativeAdmissionHold"], false);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM chat_messages WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND role='user'",
        )
        .bind(ORG)
        .bind(CHAT)
        .fetch_one(&database.pool)
        .await
        .unwrap(),
        1
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn session_expiry_is_rechecked_after_credential_lock_wait_before_any_write() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    seed_browser_target(&database, &host).await;
    seed_session(&database, "clock_timestamp()+interval '5 minutes'").await;
    let actor = browser_session_principal();
    let request: AdmissionRequest = serde_json::from_value(json!({
        "operation":"submit_native_chat_turn",
        "conversationId":CHAT,
        "clientMutationId":"browser-expiry-after-wait",
        "body":"must not be admitted after expiry"
    }))
    .unwrap();

    let mut blocker = database.pool.begin().await.unwrap();
    sqlx::query("UPDATE session SET expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1")
        .bind(SESSION_ID)
        .execute(&mut *blocker)
        .await
        .unwrap();
    let release_expired_row = async {
        wait_for_lock_wait(&database.pool, "native_chat_browser_session_lock").await;
        sqlx::query(
            "UPDATE session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        )
        .bind(SESSION_ID)
        .execute(&mut *blocker)
        .await
        .unwrap();
        blocker.commit().await.unwrap();
    };
    let (operation, ()) = tokio::join!(
        execute(&database.pool, &actor, ORG, &request, host.context()),
        release_expired_row
    );

    match operation {
        Err(Error::Http(401, _)) => {}
        Err(Error::Http(status, _)) => panic!("expected expired-session 401, got {status}"),
        Err(Error::Database(error)) => panic!("unexpected database error: {error}"),
        Ok(_) => panic!("expired browser session admitted a turn"),
    }
    assert_eq!(
        native_admission_counts(&database).await,
        (0, 0, 0, 0, 0, 0, 0)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn replaced_session_token_while_waiting_for_target_wins_before_credential_lock() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    seed_browser_target(&database, &host).await;
    seed_session(&database, "clock_timestamp()+interval '5 minutes'").await;
    let actor = browser_session_principal();
    let request: AdmissionRequest = serde_json::from_value(json!({
        "operation":"submit_native_chat_turn",
        "conversationId":CHAT,
        "clientMutationId":"browser-token-replaced-during-target-wait",
        "body":"must not be admitted after the target wait"
    }))
    .unwrap();

    let target_lock_key = format!("runtime-binding:target:chat_conversation:{ORG}:{CHAT}");
    let mut blocker = database.pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(target_lock_key)
        .execute(&mut *blocker)
        .await
        .unwrap();
    let replace_before_release = async {
        wait_for_lock_wait(&database.pool, "pg_advisory_xact_lock(hashtextextended").await;
        sqlx::query("UPDATE session SET token='target-wait-replacement' WHERE id=$1")
            .bind(SESSION_ID)
            .execute(&database.pool)
            .await
            .expect("credential replacement must not wait on admission auth");
        blocker.commit().await.unwrap();
    };
    let (operation, ()) = tokio::join!(
        execute(&database.pool, &actor, ORG, &request, host.context()),
        replace_before_release
    );

    match operation {
        Err(Error::Http(401, _)) => {}
        Err(Error::Http(status, _)) => panic!("expected replaced-token 401, got {status}"),
        Err(Error::Database(error)) => panic!("unexpected database error: {error}"),
        Ok(_) => panic!("stale browser principal admitted after target-lock wait"),
    }
    assert_eq!(
        native_admission_counts(&database).await,
        (0, 0, 0, 0, 0, 0, 0)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn duplicate_session_token_added_while_waiting_is_rejected_when_visible() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    seed_browser_target(&database, &host).await;
    seed_session(&database, "clock_timestamp()+interval '5 minutes'").await;
    let actor = browser_session_principal();
    let request: AdmissionRequest = serde_json::from_value(json!({
        "operation":"submit_native_chat_turn",
        "conversationId":CHAT,
        "clientMutationId":"browser-session-duplicate-during-target-wait",
        "body":"must not be admitted with an ambiguous visible token"
    }))
    .unwrap();

    let target_lock_key = format!("runtime-binding:target:chat_conversation:{ORG}:{CHAT}");
    let mut blocker = database.pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(target_lock_key)
        .execute(&mut *blocker)
        .await
        .unwrap();
    let insert_duplicate_before_release = async {
        wait_for_lock_wait(&database.pool, "pg_advisory_xact_lock(hashtextextended").await;
        sqlx::query(
            "INSERT INTO session(id,expires_at,token,created_at,updated_at,user_id)
             VALUES ('duplicate-browser-session',clock_timestamp()+interval '5 minutes',$1,now(),now(),$2)",
        )
        .bind(SESSION_TOKEN)
        .bind(USER)
        .execute(&database.pool)
        .await
        .expect("legacy duplicate token row may be inserted before lock-time revalidation");
        blocker.commit().await.unwrap();
    };
    let (operation, ()) = tokio::join!(
        execute(&database.pool, &actor, ORG, &request, host.context()),
        insert_duplicate_before_release
    );

    match operation {
        Err(Error::Http(401, _)) => {}
        Err(Error::Http(status, _)) => panic!("expected ambiguous-session 401, got {status}"),
        Err(Error::Database(error)) => panic!("unexpected database error: {error}"),
        Ok(_) => panic!("ambiguous visible browser session token was admitted"),
    }
    assert_eq!(
        native_admission_counts(&database).await,
        (0, 0, 0, 0, 0, 0, 0)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn membership_revocation_while_waiting_for_target_wins_before_locked_grant_check() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    seed_browser_target(&database, &host).await;
    seed_session(&database, "clock_timestamp()+interval '5 minutes'").await;
    let actor = browser_session_principal();
    let request: AdmissionRequest = serde_json::from_value(json!({
        "operation":"submit_native_chat_turn",
        "conversationId":CHAT,
        "clientMutationId":"browser-membership-revoked-during-target-wait",
        "body":"must not be admitted after membership revocation"
    }))
    .unwrap();

    let target_lock_key = format!("runtime-binding:target:chat_conversation:{ORG}:{CHAT}");
    let mut blocker = database.pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(target_lock_key)
        .execute(&mut *blocker)
        .await
        .unwrap();
    let revoke_before_release = async {
        wait_for_lock_wait(&database.pool, "pg_advisory_xact_lock(hashtextextended").await;
        sqlx::query(
            "UPDATE organization_memberships SET status='inactive'
             WHERE org_id=$1::uuid AND principal_type='user' AND principal_id=$2",
        )
        .bind(ORG)
        .bind(USER)
        .execute(&database.pool)
        .await
        .expect("pre-target authorization must not lock the membership row");
        blocker.commit().await.unwrap();
    };
    let (operation, ()) = tokio::join!(
        execute(&database.pool, &actor, ORG, &request, host.context()),
        revoke_before_release
    );

    match operation {
        Err(Error::Http(403, _)) => {}
        Err(Error::Http(status, _)) => panic!("expected revoked-membership 403, got {status}"),
        Err(Error::Database(error)) => panic!("unexpected database error: {error}"),
        Ok(_) => panic!("revoked browser membership admitted a turn"),
    }
    assert_eq!(
        native_admission_counts(&database).await,
        (0, 0, 0, 0, 0, 0, 0)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn locked_membership_grant_blocks_revocation_through_admission_commit() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    seed_browser_target(&database, &host).await;
    seed_session(&database, "clock_timestamp()+interval '5 minutes'").await;
    let actor = browser_session_principal();
    let request: AdmissionRequest = serde_json::from_value(json!({
        "operation":"submit_native_chat_turn",
        "conversationId":CHAT,
        "clientMutationId":"browser-membership-locked-through-commit",
        "body":"membership authorization remains stable through commit"
    }))
    .unwrap();

    let mut conversation_blocker = database.pool.begin().await.unwrap();
    sqlx::query(
        "SELECT id FROM chat_conversations WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE",
    )
    .bind(ORG)
    .bind(CHAT)
    .fetch_one(&mut *conversation_blocker)
    .await
    .unwrap();
    let revoke_after_auth = async {
        wait_for_lock_wait(&database.pool, "FOR UPDATE").await;
        let pool = database.pool.clone();
        let revoke = tokio::spawn(async move {
            sqlx::query(
                "UPDATE organization_memberships SET status='inactive'
                 WHERE org_id=$1::uuid AND principal_type='user' AND principal_id=$2",
            )
            .bind(ORG)
            .bind(USER)
            .execute(&pool)
            .await
        });
        wait_for_lock_wait(&database.pool, "UPDATE organization_memberships").await;
        conversation_blocker.commit().await.unwrap();
        revoke
            .await
            .expect("membership revocation task must finish")
            .expect("membership revocation must follow admission commit");
    };
    let (operation, ()) = tokio::join!(
        execute(&database.pool, &actor, ORG, &request, host.context()),
        revoke_after_auth
    );
    let receipt = operation.expect("locked membership remains valid until admission commits");
    assert_eq!(receipt["executionAuthority"], "native_rust");
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM chat_messages WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND role='user'",
        )
        .bind(ORG)
        .bind(CHAT)
        .fetch_one(&database.pool)
        .await
        .unwrap(),
        1
    );
    let membership_status: String = sqlx::query_scalar(
        "SELECT status FROM organization_memberships
         WHERE org_id=$1::uuid AND principal_type='user' AND principal_id=$2",
    )
    .bind(ORG)
    .bind(USER)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(membership_status, "inactive");
}

#[tokio::test(flavor = "multi_thread")]
async fn session_expiry_during_final_audit_wait_rolls_back_all_admission_writes() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    seed_browser_target(&database, &host).await;
    seed_session(&database, "clock_timestamp()+interval '2 seconds'").await;
    database
        .sql(
            "CREATE FUNCTION block_browser_admission_audit() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.action='chat.message_added' THEN
             PERFORM pg_advisory_xact_lock(71317001);
           END IF;
           RETURN NEW;
         END $$;
         CREATE TRIGGER block_browser_admission_audit BEFORE INSERT ON activity_log
           FOR EACH ROW EXECUTE FUNCTION block_browser_admission_audit();",
        )
        .await;
    let mut blocker = database.pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(71317001)")
        .execute(&mut *blocker)
        .await
        .unwrap();
    let actor = browser_session_principal();
    let request: AdmissionRequest = serde_json::from_value(json!({
        "operation":"submit_native_chat_turn", "conversationId":CHAT,
        "clientMutationId":"browser-expired-at-final-audit", "body":"must roll back"
    }))
    .unwrap();
    let release_after_expiry = async {
        // Admission has written Message/Generation/Run/Attempt/binding rows
        // before its final activity INSERT reaches this deterministic barrier.
        wait_for_lock_wait(&database.pool, "INSERT INTO activity_log").await;
        sqlx::query(
            "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM (expires_at-clock_timestamp())))::double precision+0.02)
             FROM session WHERE id=$1",
        ).bind(SESSION_ID).execute(&database.pool).await.unwrap();
        blocker.commit().await.unwrap();
    };
    let (result, ()) = tokio::join!(
        execute(&database.pool, &actor, ORG, &request, host.context()),
        release_after_expiry
    );
    assert!(matches!(result, Err(Error::Http(401, _))));
    assert_eq!(
        native_admission_counts(&database).await,
        (0, 0, 0, 0, 0, 0, 0)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn revoked_board_key_is_revalidated_in_d1_before_admission() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    seed_browser_target(&database, &host).await;
    let key_hash = digest(BOARD_KEY_TOKEN)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    sqlx::query(
        "INSERT INTO board_api_keys(id,user_id,name,key_hash)
         VALUES ($1::uuid,$2,'Browser fixture key',$3)",
    )
    .bind(BOARD_KEY_ID)
    .bind(USER)
    .bind(&key_hash)
    .execute(&database.pool)
    .await
    .expect("seed browser board key");
    let actor = browser_board_key_principal();
    sqlx::query("UPDATE board_api_keys SET revoked_at=clock_timestamp() WHERE id=$1::uuid")
        .bind(BOARD_KEY_ID)
        .execute(&database.pool)
        .await
        .unwrap();
    let request: AdmissionRequest = serde_json::from_value(json!({
        "operation":"submit_native_chat_turn",
        "conversationId":CHAT,
        "clientMutationId":"browser-revoked-board-key",
        "body":"must not be admitted with a revoked key"
    }))
    .unwrap();

    match execute(&database.pool, &actor, ORG, &request, host.context()).await {
        Err(Error::Http(401, _)) => {}
        Err(Error::Http(status, _)) => panic!("expected revoked-key 401, got {status}"),
        Err(Error::Database(error)) => panic!("unexpected database error: {error}"),
        Ok(_) => panic!("revoked board key admitted a turn"),
    }
    assert_eq!(
        native_admission_counts(&database).await,
        (0, 0, 0, 0, 0, 0, 0)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn replaced_session_token_under_same_row_id_fails_fingerprint_revalidation() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    seed_browser_target(&database, &host).await;
    seed_session(&database, "clock_timestamp()+interval '5 minutes'").await;
    let actor = browser_session_principal();
    sqlx::query("UPDATE session SET token='replacement-token' WHERE id=$1")
        .bind(SESSION_ID)
        .execute(&database.pool)
        .await
        .unwrap();
    let request: AdmissionRequest = serde_json::from_value(json!({
        "operation":"submit_native_chat_turn",
        "conversationId":CHAT,
        "clientMutationId":"browser-token-replaced",
        "body":"must not be admitted after credential replacement"
    }))
    .unwrap();

    match execute(&database.pool, &actor, ORG, &request, host.context()).await {
        Err(Error::Http(401, _)) => {}
        Err(Error::Http(status, _)) => panic!("expected replaced-token 401, got {status}"),
        Err(Error::Database(error)) => panic!("unexpected database error: {error}"),
        Ok(_) => panic!("replaced browser session token admitted a turn"),
    }
    assert_eq!(
        native_admission_counts(&database).await,
        (0, 0, 0, 0, 0, 0, 0)
    );
}

async fn admitted_browser_control(
    database: &Database,
    host: &ExecutionHost,
) -> (
    BrowserPrincipal,
    rudder_d1_persistence::native_chat::control::StopRequest,
) {
    seed_browser_target(database, host).await;
    seed_session(database, "clock_timestamp()+interval '5 minutes'").await;
    let actor = browser_session_principal();
    let request: AdmissionRequest = serde_json::from_value(json!({
        "operation":"submit_native_chat_turn", "conversationId":CHAT,
        "clientMutationId":"browser-control-input", "body":"browser control input"
    }))
    .unwrap();
    let receipt = execute(&database.pool, &actor, ORG, &request, host.context())
        .await
        .unwrap();
    let run = receipt["runId"].as_str().unwrap();
    let stop = super::control::stop_request(&database.pool, run).await;
    super::control::seed_text(&database.pool, &stop, run).await;
    (actor, stop)
}

#[tokio::test(flavor = "multi_thread")]
async fn browser_control_read_ack_and_stop_revalidate_current_credential() {
    use rudder_d1_persistence::native_chat::control::{
        ClientCheckpointRequest, ReadEvents, read_events, record_client_checkpoint, request_stop,
    };
    let database = Database::start().await;
    let host = ExecutionHost::new();
    let (actor, stop) = admitted_browser_control(&database, &host).await;
    let read = ReadEvents {
        conversation_id: CHAT.into(),
        generation_id: stop.generation_id.clone(),
        after_seq: 0,
        limit: 100,
        max_bytes: 4096,
    };
    assert_eq!(
        read_events(&database.pool, &actor, &read)
            .await
            .unwrap()
            .events
            .len(),
        3
    );
    let checkpoint = ClientCheckpointRequest {
        conversation_id: CHAT.into(),
        generation_id: stop.generation_id.clone(),
        attempt_epoch: 1,
        generation_seq: 2,
        rendered_body_hash: format!("{:x}", Sha256::digest(b"a")),
    };
    assert!(
        record_client_checkpoint(&database.pool, &actor, &checkpoint)
            .await
            .unwrap()
            .advanced
    );
    let before = super::control::counts(&database.pool, &stop.generation_id).await;
    sqlx::query("UPDATE session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1")
        .bind(SESSION_ID)
        .execute(&database.pool)
        .await
        .unwrap();
    assert!(matches!(
        read_events(&database.pool, &actor, &read).await,
        Err(Error::Http(401, _))
    ));
    assert!(matches!(
        record_client_checkpoint(&database.pool, &actor, &checkpoint).await,
        Err(Error::Http(401, _))
    ));
    assert!(matches!(
        request_stop(&database.pool, &actor, &stop).await,
        Err(Error::Http(401, _))
    ));
    assert_eq!(
        before,
        super::control::counts(&database.pool, &stop.generation_id).await
    );
    sqlx::query("UPDATE session SET expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1")
        .bind(SESSION_ID)
        .execute(&database.pool)
        .await
        .unwrap();
    assert_eq!(
        request_stop(&database.pool, &actor, &stop)
            .await
            .unwrap()
            .accepted_through_seq,
        Some(2)
    );
    // An idempotent Stop retry still requires a valid current credential.
    sqlx::query("DELETE FROM session WHERE id=$1")
        .bind(SESSION_ID)
        .execute(&database.pool)
        .await
        .unwrap();
    assert!(matches!(
        request_stop(&database.pool, &actor, &stop).await,
        Err(Error::Http(401, _))
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn browser_stop_does_not_lock_credentials_before_target_and_rechecks_after_wait() {
    use rudder_d1_persistence::native_chat::control::request_stop;
    let database = Database::start().await;
    let host = ExecutionHost::new();
    let (actor, stop) = admitted_browser_control(&database, &host).await;
    let before = super::control::counts(&database.pool, &stop.generation_id).await;
    let mut blocker = database.pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!(
            "runtime-binding:target:chat_conversation:{ORG}:{CHAT}"
        ))
        .execute(&mut *blocker)
        .await
        .unwrap();
    let revoke = async {
        wait_for_lock_wait(&database.pool, "pg_advisory_xact_lock(hashtextextended").await;
        // This must finish while the Stop waiter is still blocked on its target.
        sqlx::query("UPDATE session SET token='replacement-browser-control-token' WHERE id=$1")
            .bind(SESSION_ID)
            .execute(&database.pool)
            .await
            .unwrap();
        blocker.commit().await.unwrap();
    };
    let (result, ()) = tokio::join!(request_stop(&database.pool, &actor, &stop), revoke);
    assert!(matches!(result, Err(Error::Http(401, _))));
    assert_eq!(
        before,
        super::control::counts(&database.pool, &stop.generation_id).await
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn claimed_execution_continues_after_cookie_expiry_but_stops_after_membership_revocation() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    seed_browser_target(&database, &host).await;
    seed_session(&database, "clock_timestamp()+interval '5 minutes'").await;
    let actor = browser_session_principal();
    let (run_id, attempt_id) = admit_browser_turn(
        &database,
        &host,
        &actor,
        CHAT,
        "browser-execution-capability",
    )
    .await;
    let (execution_actor, fence) =
        claim_browser_turn(&database, &host, &actor, &run_id, &attempt_id).await;

    sqlx::query("UPDATE session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1")
        .bind(SESSION_ID)
        .execute(&database.pool)
        .await
        .expect("expire original request cookie after successful claim");

    let checkpoint = current_checkpoint(&database.pool, &execution_actor, &fence)
        .await
        .expect("claimed worker authority does not depend on original cookie lifetime");
    assert_eq!(checkpoint.phase, Phase::NoThreadRequest);

    let before: (Value, bool, bool) = sqlx::query_as(
        "SELECT a.checkpoint_json, g.native_admission_hold, r.native_admission_hold
         FROM heartbeat_run_attempts a
         JOIN heartbeat_runs r ON r.org_id=a.org_id AND r.id=a.run_id
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         WHERE a.org_id=$1::uuid AND a.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&attempt_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE organization_memberships SET status='inactive'
         WHERE org_id=$1::uuid AND principal_type='user' AND principal_id=$2",
    )
    .bind(ORG)
    .bind(USER)
    .execute(&database.pool)
    .await
    .expect("revoke current organization membership");
    assert!(matches!(
        current_checkpoint(&database.pool, &execution_actor, &fence).await,
        Err(Error::Http(403, _))
    ));
    let after: (Value, bool, bool) = sqlx::query_as(
        "SELECT a.checkpoint_json, g.native_admission_hold, r.native_admission_hold
         FROM heartbeat_run_attempts a
         JOIN heartbeat_runs r ON r.org_id=a.org_id AND r.id=a.run_id
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         WHERE a.org_id=$1::uuid AND a.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&attempt_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(
        after, before,
        "revoked worker access is read-only and effect-free"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn claimed_browser_execution_rejects_deleted_user_even_if_membership_remains() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    seed_browser_target(&database, &host).await;
    seed_session(&database, "clock_timestamp()+interval '5 minutes'").await;
    let actor = browser_session_principal();
    let (run_id, attempt_id) =
        admit_browser_turn(&database, &host, &actor, CHAT, "browser-user-deletion").await;
    let (execution_actor, fence) =
        claim_browser_turn(&database, &host, &actor, &run_id, &attempt_id).await;

    let before: (Value, bool, bool) = sqlx::query_as(
        "SELECT a.checkpoint_json, g.native_admission_hold, r.native_admission_hold
         FROM heartbeat_run_attempts a
         JOIN heartbeat_runs r ON r.org_id=a.org_id AND r.id=a.run_id
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         WHERE a.org_id=$1::uuid AND a.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&attempt_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();

    let deleted_user: Option<String> =
        sqlx::query_scalar("DELETE FROM \"user\" WHERE id=$1 RETURNING id")
            .bind(USER)
            .fetch_optional(&database.pool)
            .await
            .expect("delete browser user while leaving polymorphic membership untouched");
    assert_eq!(deleted_user.as_deref(), Some(USER));
    let membership_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM organization_memberships
         WHERE org_id=$1::uuid AND principal_type='user' AND principal_id=$2 AND status='active'",
    )
    .bind(ORG)
    .bind(USER)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(
        membership_count, 1,
        "the fixture retains its polymorphic grant"
    );

    assert!(matches!(
        current_checkpoint(&database.pool, &execution_actor, &fence).await,
        Err(Error::Http(403, _))
    ));
    let after: (Value, bool, bool) = sqlx::query_as(
        "SELECT a.checkpoint_json, g.native_admission_hold, r.native_admission_hold
         FROM heartbeat_run_attempts a
         JOIN heartbeat_runs r ON r.org_id=a.org_id AND r.id=a.run_id
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         WHERE a.org_id=$1::uuid AND a.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&attempt_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(after, before, "deleted-user denial is effect-free");
}

#[tokio::test(flavor = "multi_thread")]
async fn execution_principal_rejects_a_different_claim_fence() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    seed_browser_target(&database, &host).await;
    seed_second_browser_chat(&database).await;
    seed_session(&database, "clock_timestamp()+interval '5 minutes'").await;
    let actor = browser_session_principal();

    let (run_a, attempt_a) =
        admit_browser_turn(&database, &host, &actor, CHAT, "browser-fence-a").await;
    let (run_b, attempt_b) =
        admit_browser_turn(&database, &host, &actor, SECOND_CHAT, "browser-fence-b").await;
    let (principal_a, fence_a) =
        claim_browser_turn(&database, &host, &actor, &run_a, &attempt_a).await;
    let (principal_b, fence_b) =
        claim_browser_turn(&database, &host, &actor, &run_b, &attempt_b).await;

    assert!(matches!(
        current_checkpoint(&database.pool, &principal_a, &fence_b).await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(
        current_checkpoint(&database.pool, &principal_b, &fence_b)
            .await
            .unwrap()
            .phase,
        Phase::NoThreadRequest
    );
    assert_eq!(fence_a.identity().run_id, run_a.as_str());
}

#[tokio::test(flavor = "multi_thread")]
async fn cookie_expiring_during_claim_final_audit_wait_rolls_back_claim() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    seed_browser_target(&database, &host).await;
    seed_session(&database, "clock_timestamp()+interval '5 minutes'").await;
    let actor = browser_session_principal();
    let (run_id, attempt_id) =
        admit_browser_turn(&database, &host, &actor, CHAT, "browser-claim-expiry").await;

    sqlx::query("UPDATE session SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1")
        .bind(SESSION_ID)
        .execute(&database.pool)
        .await
        .expect("set short claim-time expiry");
    let before = claim_state_snapshot(&database, &run_id, &attempt_id).await;
    database
        .sql(
            "CREATE FUNCTION block_native_claim_audit() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN
               IF NEW.action='runtime.native_chat.execution_claimed' THEN
                 PERFORM pg_advisory_xact_lock(71317002);
               END IF;
               RETURN NEW;
             END $$;
             CREATE TRIGGER block_native_claim_audit BEFORE INSERT ON activity_log
               FOR EACH ROW EXECUTE FUNCTION block_native_claim_audit();",
        )
        .await;
    let mut blocker = database.pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(71317002)")
        .execute(&mut *blocker)
        .await
        .unwrap();

    let claim_operation = claim(
        &database.pool,
        &actor,
        ORG,
        &run_id,
        &attempt_id,
        host.context(),
    );
    let release_after_expiry = async {
        wait_for_lock_wait(&database.pool, "INSERT INTO activity_log").await;
        sqlx::query(
            "SELECT pg_sleep(GREATEST(
               0.0,
               EXTRACT(EPOCH FROM (expires_at-clock_timestamp()))::double precision
             ) + 0.05) FROM session WHERE id=$1",
        )
        .bind(SESSION_ID)
        .execute(&database.pool)
        .await
        .expect("wait until the locked browser session expires");
        blocker.commit().await.unwrap();
    };
    let (result, ()) = tokio::join!(claim_operation, release_after_expiry);
    assert!(matches!(result, Err(Error::Http(401, _))));
    assert_eq!(
        claim_state_snapshot(&database, &run_id, &attempt_id).await,
        before,
        "expired claim must roll back owner, span, model, and audit writes"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_termination_serializes_with_execution_authority_through_commit() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    seed_browser_target(&database, &host).await;
    let actor = verified_agent_actor(ORG, CEO, "agent-execution-lock");
    let request: AdmissionRequest = serde_json::from_value(json!({
        "operation":"submit_native_chat_turn",
        "conversationId":CHAT,
        "clientMutationId":"agent-execution-lock",
        "body":"agent-owned execution authority fixture"
    }))
    .unwrap();
    let receipt = execute(&database.pool, &actor, ORG, &request, host.context())
        .await
        .expect("selected active Agent may admit this Chat turn");
    let run_id = receipt["runId"].as_str().unwrap().to_owned();
    let attempt_id = receipt["attemptId"].as_str().unwrap().to_owned();
    let claimed = claim(
        &database.pool,
        &actor,
        ORG,
        &run_id,
        &attempt_id,
        host.context(),
    )
    .await
    .expect("active Agent may claim its admitted Run");
    let (execution_actor, fence, _, _) = claimed.into_execution_parts();
    let generation_id: String = sqlx::query_scalar(
        "SELECT chat_generation_id::text FROM heartbeat_runs
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();

    let mut generation_blocker = database.pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM chat_generations WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE")
        .bind(ORG)
        .bind(&generation_id)
        .fetch_one(&mut *generation_blocker)
        .await
        .unwrap();

    let checkpoint_operation = current_checkpoint(&database.pool, &execution_actor, &fence);
    let terminate_after_authorization = async {
        // The checkpoint has passed agent authorization and is blocked on the
        // next locked row. Its FOR SHARE must keep Agent termination behind
        // this transaction until the checkpoint commits.
        wait_for_lock_wait(&database.pool, "FROM chat_generations").await;
        let pool = database.pool.clone();
        let termination = tokio::spawn(async move {
            sqlx::query(
                "/* native_chat_test_agent_termination */
                 UPDATE agents SET status='terminated'
                 WHERE org_id=$1::uuid AND id=$2::uuid",
            )
            .bind(ORG)
            .bind(CEO)
            .execute(&pool)
            .await
        });
        wait_for_lock_wait(&database.pool, "native_chat_test_agent_termination").await;
        generation_blocker.commit().await.unwrap();
        termination
            .await
            .expect("Agent termination task must finish")
            .expect("Agent termination must follow the authorized checkpoint");
    };
    let (checkpoint, ()) = tokio::join!(checkpoint_operation, terminate_after_authorization);
    assert_eq!(checkpoint.unwrap().phase, Phase::NoThreadRequest);

    let before: Value = sqlx::query_scalar(
        "SELECT checkpoint_json FROM heartbeat_run_attempts
         WHERE org_id=$1::uuid AND run_id=$2::uuid AND id=$3::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .bind(&attempt_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert!(matches!(
        current_checkpoint(&database.pool, &execution_actor, &fence).await,
        Err(Error::Http(403, _))
    ));
    let after: Value = sqlx::query_scalar(
        "SELECT checkpoint_json FROM heartbeat_run_attempts
         WHERE org_id=$1::uuid AND run_id=$2::uuid AND id=$3::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .bind(&attempt_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(
        after, before,
        "terminated Agent cannot mutate the checkpoint"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn browser_preclaim_stop_rechecks_expiry_and_then_resolves_without_execution() {
    use rudder_d1_persistence::native_chat::control::{
        FinalizeUnclaimedStop, finalize_unclaimed_stop, request_stop,
    };
    let database = Database::start().await;
    let host = ExecutionHost::new();
    seed_browser_target(&database, &host).await;
    seed_session(&database, "clock_timestamp()+interval '5 minutes'").await;
    let actor = browser_session_principal();
    let (run, attempt) =
        admit_browser_turn(&database, &host, &actor, CHAT, "browser-preclaim-stop").await;
    let stop = super::control::stop_request(&database.pool, &run).await;
    request_stop(&database.pool, &actor, &stop).await.unwrap();
    let request = FinalizeUnclaimedStop {
        conversation_id: CHAT.into(),
        generation_id: stop.generation_id.clone(),
        control_action_id: stop.control_action_id.clone(),
    };
    sqlx::query("UPDATE session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1")
        .bind(SESSION_ID)
        .execute(&database.pool)
        .await
        .unwrap();
    let before = claim_state_snapshot(&database, &run, &attempt).await;
    assert!(matches!(
        finalize_unclaimed_stop(&database.pool, &actor, &request).await,
        Err(Error::Http(401, _))
    ));
    assert_eq!(
        claim_state_snapshot(&database, &run, &attempt).await,
        before
    );
    sqlx::query("UPDATE session SET expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1")
        .bind(SESSION_ID)
        .execute(&database.pool)
        .await
        .unwrap();
    let receipt = finalize_unclaimed_stop(&database.pool, &actor, &request)
        .await
        .unwrap();
    assert_eq!(receipt.input_disposition, "not_submitted");
    assert_eq!(receipt.attempt_id, attempt);
    assert!(!receipt.idempotent);
    assert!(
        finalize_unclaimed_stop(&database.pool, &actor, &request)
            .await
            .unwrap()
            .idempotent
    );
    let state: (String, String, bool, i64) = sqlx::query_as(
        "SELECT r.status,g.status,r.native_admission_hold OR g.native_admission_hold,
         (SELECT count(*) FROM chat_messages m WHERE m.run_id=r.id AND m.role='assistant')
         FROM heartbeat_runs r JOIN chat_generations g ON g.id=r.chat_generation_id WHERE r.id=$1::uuid"
    ).bind(&run).fetch_one(&database.pool).await.unwrap();
    assert_eq!(state, ("cancelled".into(), "stopped".into(), false, 0));
}

#[tokio::test(flavor = "multi_thread")]
async fn browser_preclaim_stop_never_releases_a_claimed_execution() {
    use rudder_d1_persistence::native_chat::control::{
        FinalizeUnclaimedStop, finalize_unclaimed_stop, request_stop,
    };
    let database = Database::start().await;
    let host = ExecutionHost::new();
    seed_browser_target(&database, &host).await;
    seed_session(&database, "clock_timestamp()+interval '5 minutes'").await;
    let actor = browser_session_principal();
    let (run, attempt) =
        admit_browser_turn(&database, &host, &actor, CHAT, "browser-claimed-stop").await;
    let (_principal, _fence) = claim_browser_turn(&database, &host, &actor, &run, &attempt).await;
    let stop = super::control::stop_request(&database.pool, &run).await;
    request_stop(&database.pool, &actor, &stop).await.unwrap();
    let request = FinalizeUnclaimedStop {
        conversation_id: CHAT.into(),
        generation_id: stop.generation_id,
        control_action_id: stop.control_action_id,
    };
    let before = claim_state_snapshot(&database, &run, &attempt).await;
    assert!(matches!(
        finalize_unclaimed_stop(&database.pool, &actor, &request).await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(
        claim_state_snapshot(&database, &run, &attempt).await,
        before
    );
}
