use super::*;
use rudder_d1_persistence::native_chat::control::{
    ReadEvents, StopOutcome, StopRequest, read_events, request_stop,
};
use sha2::{Digest, Sha256};

#[path = "preclaim.rs"]
mod preclaim;

fn hash(body: &str) -> String {
    format!("{:x}", Sha256::digest(body.as_bytes()))
}

async fn stop_request(pool: &PgPool, run: &str) -> StopRequest {
    let generation: String =
        sqlx::query_scalar("SELECT chat_generation_id::text FROM heartbeat_runs WHERE id=$1::uuid")
            .bind(run)
            .fetch_one(pool)
            .await
            .unwrap();
    StopRequest {
        conversation_id: CHAT.into(),
        generation_id: generation,
        control_action_id: "71000000-0000-4000-8000-000000000001".into(),
        expected_attempt_epoch: 1,
        expected_control_version: 0,
        requested_render_seq: 0,
        requested_body_hash: hash(""),
    }
}

async fn counts(pool: &PgPool, generation: &str) -> (i64, i64) {
    sqlx::query_as(
        "SELECT (SELECT count(*) FROM chat_control_actions WHERE expected_generation_id=$1::uuid),
      (SELECT count(*) FROM chat_generation_events WHERE generation_id=$1::uuid)",
    )
    .bind(generation)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn seed_text(pool: &PgPool, request: &StopRequest, run: &str) -> String {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_control',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    let message: String = sqlx::query_scalar(
        "INSERT INTO chat_messages(org_id,conversation_id,role,kind,status,body,run_id)
      VALUES($1::uuid,$2::uuid,'assistant','message','streaming','ab',$3::uuid) RETURNING id::text",
    )
    .bind(ORG)
    .bind(CHAT)
    .bind(run)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    for (seq, delta, body) in [(2, "a", "a"), (3, "b", "ab")] {
        sqlx::query("INSERT INTO chat_generation_events(org_id,generation_id,generation_seq,attempt_epoch,event_kind,payload,assistant_message_id,run_id)
          VALUES($1::uuid,$2::uuid,$3,1,'assistant_delta',$4,$5::uuid,$6::uuid)")
            .bind(ORG).bind(&request.generation_id).bind(seq)
            .bind(json!({"delta":delta,"bodyHash":hash(body),"providerThreadId":"private-test-sentinel","ownerToken":"private-owner"}))
            .bind(&message).bind(run).execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
    message
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_intent_is_atomic_idempotent_and_retains_execution_holds() {
    let database = Database::start().await;
    let (actor, run, attempt, fence) = seed_execution(&database).await;
    let request = stop_request(&database.pool, &run).await;
    let before: Value =
        sqlx::query_scalar("SELECT to_jsonb(a) FROM heartbeat_run_attempts a WHERE id=$1::uuid")
            .bind(&attempt)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    let receipt = request_stop(&database.pool, &actor, &request)
        .await
        .unwrap();
    assert_eq!(receipt.outcome, StopOutcome::StopIntentRecorded);
    assert_eq!(receipt.accepted_through_seq, Some(0));
    assert_eq!(receipt.applied_control_version, Some(1));
    assert_eq!(counts(&database.pool, &request.generation_id).await, (1, 3));
    let replay = request_stop(&database.pool, &actor, &request)
        .await
        .unwrap();
    assert!(replay.idempotent);
    assert_eq!(replay.outcome, receipt.outcome);
    assert_eq!(counts(&database.pool, &request.generation_id).await, (1, 3));
    let mut changed = request.clone();
    changed.requested_render_seq = 1;
    assert_conflict(request_stop(&database.pool, &actor, &changed).await);
    changed = request.clone();
    changed.expected_control_version = 1;
    assert_conflict(request_stop(&database.pool, &actor, &changed).await);
    changed = request.clone();
    changed.control_action_id = "71000000-0000-4000-8000-000000000002".into();
    assert_conflict(request_stop(&database.pool, &actor, &changed).await);
    changed.expected_control_version = 1;
    assert_eq!(
        request_stop(&database.pool, &actor, &changed)
            .await
            .unwrap()
            .outcome,
        StopOutcome::StopInProgress
    );
    assert_eq!(counts(&database.pool, &request.generation_id).await, (2, 3));
    let state:(String,bool,bool,bool)=sqlx::query_as("SELECT g.status,g.native_admission_hold,r.native_admission_hold,
      g.runtime_terminal_at IS NULL FROM chat_generations g JOIN heartbeat_runs r ON r.chat_generation_id=g.id WHERE r.id=$1::uuid")
        .bind(&run).fetch_one(&database.pool).await.unwrap();
    assert_eq!(state, ("stop_requested".into(), true, true, true));
    let after: Value =
        sqlx::query_scalar("SELECT to_jsonb(a) FROM heartbeat_run_attempts a WHERE id=$1::uuid")
            .bind(&attempt)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert_eq!(before, after);
    assert_conflict(renew_lease(&database.pool, &actor, &fence).await);
    let audit: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log WHERE action='runtime.native_chat.stop_requested'",
    )
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(audit, 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_freezes_rendered_cursor_instead_of_latest_output_and_zero_clears_later_message() {
    for cutoff in [0, 2] {
        let database = Database::start().await;
        let (actor, run, _, _) = seed_execution(&database).await;
        let mut request = stop_request(&database.pool, &run).await;
        let message = seed_text(&database.pool, &request, &run).await;
        request.requested_render_seq = cutoff;
        request.requested_body_hash = hash(if cutoff == 0 { "" } else { "a" });
        let receipt = request_stop(&database.pool, &actor, &request)
            .await
            .unwrap();
        assert_eq!(receipt.accepted_through_seq, Some(cutoff));
        let projection: (String, String) =
            sqlx::query_as("SELECT body,status FROM chat_messages WHERE id=$1::uuid")
                .bind(message)
                .fetch_one(&database.pool)
                .await
                .unwrap();
        assert_eq!(
            projection,
            (if cutoff == 0 { "" } else { "a" }.into(), "stopped".into())
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_prefers_newer_durable_checkpoint_and_invalid_hash_rolls_back() {
    let database = Database::start().await;
    let (actor, run, _, _) = seed_execution(&database).await;
    let mut request = stop_request(&database.pool, &run).await;
    seed_text(&database.pool, &request, &run).await;
    request.requested_render_seq = 2;
    request.requested_body_hash = hash("wrong");
    assert_conflict(request_stop(&database.pool, &actor, &request).await);
    assert_eq!(counts(&database.pool, &request.generation_id).await, (0, 3));
    let mut tx = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_control',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE chat_generations SET last_client_checkpoint_seq=3,last_client_checkpoint_hash=$2 WHERE id=$1::uuid")
        .bind(&request.generation_id).bind(hash("ab")).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    let receipt = request_stop(&database.pool, &actor, &request)
        .await
        .unwrap();
    assert_eq!(receipt.accepted_through_seq, Some(3));
    assert_eq!(receipt.frozen_body_hash, Some(hash("ab")));
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_reauthorizes_after_lock_wait_and_rejects_foreign_generation() {
    let database = Database::start().await;
    let (actor, run, _, _) = seed_execution(&database).await;
    let request = stop_request(&database.pool, &run).await;
    let foreign = verified_actor(OTHER, USER, "foreign-control");
    assert!(matches!(
        request_stop(&database.pool, &foreign, &request).await,
        Err(Error::Http(403 | 404, _))
    ));
    let mut lock = database.pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM chat_conversations WHERE id=$1::uuid FOR UPDATE")
        .bind(CHAT)
        .fetch_one(&mut *lock)
        .await
        .unwrap();
    let pool = database.pool.clone();
    let cloned_actor = actor.clone();
    let cloned_request = request.clone();
    let task =
        tokio::spawn(async move { request_stop(&pool, &cloned_actor, &cloned_request).await });
    wait_for_lock_wait(&database.pool, "chat_conversations").await;
    sqlx::query("UPDATE organization_memberships SET status='inactive' WHERE org_id=$1::uuid AND principal_id=$2")
        .bind(ORG).bind(USER).execute(&database.pool).await.unwrap();
    lock.commit().await.unwrap();
    assert!(matches!(task.await.unwrap(), Err(Error::Http(403, _))));
    assert_eq!(counts(&database.pool, &request.generation_id).await, (0, 1));
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_concurrency_has_one_winner_and_unclaimed_stop_prevents_dispatch() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    let (actor, run, attempt) = prepare(&database, &host).await;
    let request = stop_request(&database.pool, &run).await;
    let (a, b) = tokio::join!(
        request_stop(&database.pool, &actor, &request),
        request_stop(&database.pool, &actor, &request)
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_ne!(a.idempotent, b.idempotent);
    assert_eq!(counts(&database.pool, &request.generation_id).await, (1, 3));
    assert_conflict(claim(&database.pool, &actor, ORG, &run, &attempt, host.context()).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn event_pages_are_ordered_bounded_private_and_survive_new_pool() {
    let database = Database::start().await;
    let (actor, run, _, _) = seed_execution(&database).await;
    let request = stop_request(&database.pool, &run).await;
    seed_text(&database.pool, &request, &run).await;
    request_stop(&database.pool, &actor, &request)
        .await
        .unwrap();
    // Historical reading uses the Run Agent, not the currently selected Agent.
    sqlx::query("UPDATE chat_conversations SET preferred_agent_id=NULL,routed_agent_id=NULL WHERE id=$1::uuid")
        .bind(CHAT).execute(&database.pool).await.unwrap();
    let mut page_request = ReadEvents {
        conversation_id: CHAT.into(),
        generation_id: request.generation_id.clone(),
        after_seq: 0,
        limit: 1,
        max_bytes: 2048,
    };
    let first = read_events(&database.pool, &actor, &page_request)
        .await
        .unwrap();
    assert_eq!(first.next_seq, 1);
    assert!(first.has_more);
    let encoded = serde_json::to_string(&first).unwrap();
    assert!(!encoded.contains("private-test-sentinel"));
    assert!(!encoded.contains("private-owner"));
    let new_pool = PgPoolOptions::new()
        .max_connections(2)
        .connect_with((*database.pool.connect_options()).clone())
        .await
        .unwrap();
    page_request.after_seq = first.next_seq;
    page_request.limit = 100;
    let rest = read_events(&new_pool, &actor, &page_request).await.unwrap();
    assert_eq!(
        rest.events
            .iter()
            .map(|event| event.generation_seq)
            .collect::<Vec<_>>(),
        vec![2, 3, 4, 5]
    );
    assert!(!rest.has_more);
    assert!(serde_json::to_vec(&rest.events).unwrap().len() <= page_request.max_bytes);
    assert_eq!(counts(&database.pool, &request.generation_id).await, (1, 5));
    sqlx::query("UPDATE organization_memberships SET status='inactive' WHERE org_id=$1::uuid AND principal_id=$2")
        .bind(ORG).bind(USER).execute(&database.pool).await.unwrap();
    assert!(matches!(
        read_events(&new_pool, &actor, &page_request).await,
        Err(Error::Http(403, _))
    ));
    new_pool.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn event_reader_enforces_count_and_byte_bounds_without_skipping_oversized_event() {
    let database = Database::start().await;
    let (actor, run, _, _) = seed_execution(&database).await;
    let request = stop_request(&database.pool, &run).await;
    let mut tx = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_control',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO chat_generation_events(org_id,generation_id,generation_seq,attempt_epoch,event_kind,payload)
        SELECT $1::uuid,$2::uuid,s,1,'assistant_delta',jsonb_build_object('delta',repeat('x',600),'bodyHash',$3::text) FROM generate_series(2,152) s")
        .bind(ORG).bind(&request.generation_id).bind(hash(&"x".repeat(600))).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO chat_generation_events(org_id,generation_id,generation_seq,attempt_epoch,event_kind,payload)
        VALUES($1::uuid,$2::uuid,153,1,'assistant_delta',jsonb_build_object('delta',repeat('x',70000)))")
        .bind(ORG).bind(&request.generation_id).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    let mut read = ReadEvents {
        conversation_id: CHAT.into(),
        generation_id: request.generation_id.clone(),
        after_seq: 0,
        limit: 100,
        max_bytes: 1024,
    };
    let page = read_events(&database.pool, &actor, &read).await.unwrap();
    assert!(page.has_more);
    assert_eq!(page.next_seq, 2);
    assert!(serde_json::to_vec(&page.events).unwrap().len() <= 1024);
    read.max_bytes = 256 * 1024;
    let page = read_events(&database.pool, &actor, &read).await.unwrap();
    assert_eq!(page.events.len(), 100);
    assert_eq!(page.next_seq, 100);
    assert!(page.has_more);
    read.after_seq = page.next_seq;
    let page = read_events(&database.pool, &actor, &read).await.unwrap();
    assert_eq!(page.next_seq, 152);
    assert!(page.has_more);
    read.after_seq = page.next_seq;
    assert!(matches!(
        read_events(&database.pool, &actor, &read).await,
        Err(Error::Http(422, _))
    ));
    assert_eq!(
        counts(&database.pool, &request.generation_id).await,
        (0, 153)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_rejects_stale_epoch_unsupported_projection_and_non_native_action_receipt() {
    let database = Database::start().await;
    let (actor, run, _, _) = seed_execution(&database).await;
    let mut request = stop_request(&database.pool, &run).await;
    request.expected_attempt_epoch = 2;
    assert_conflict(request_stop(&database.pool, &actor, &request).await);
    request.expected_attempt_epoch = 1;
    let message = seed_text(&database.pool, &request, &run).await;
    let mut tx = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_control',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE chat_messages SET structured_payload=$2 WHERE id=$1::uuid")
        .bind(&message)
        .bind(json!({"transcript":["later output"]}))
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_conflict(request_stop(&database.pool, &actor, &request).await);
    assert_eq!(counts(&database.pool, &request.generation_id).await, (0, 3));
    let body: String = sqlx::query_scalar("SELECT body FROM chat_messages WHERE id=$1::uuid")
        .bind(&message)
        .fetch_one(&database.pool)
        .await
        .unwrap();
    assert_eq!(body, "ab");
    // Legacy control rows must never masquerade as a Rust intent receipt.
    sqlx::query("INSERT INTO chat_control_actions(id,org_id,expected_generation_id,expected_attempt_epoch,expected_control_version,action_kind,requested_render_seq,requested_body_hash)
      VALUES($1::uuid,$2::uuid,$3::uuid,1,0,'stop',0,$4)")
        .bind(&request.control_action_id).bind(ORG).bind(&request.generation_id).bind(hash("")).execute(&database.pool).await.unwrap();
    assert_conflict(request_stop(&database.pool, &actor, &request).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn malformed_event_does_not_advance_replay_or_commit_stop_intent() {
    let database = Database::start().await;
    let (actor, run, _, _) = seed_execution(&database).await;
    let mut request = stop_request(&database.pool, &run).await;
    let mut tx = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_control',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO chat_generation_events(org_id,generation_id,generation_seq,attempt_epoch,event_kind,payload)
      VALUES($1::uuid,$2::uuid,2,1,'assistant_delta',$3)")
        .bind(ORG).bind(&request.generation_id).bind(json!({"bodyHash":hash("")})).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    let read = ReadEvents {
        conversation_id: CHAT.into(),
        generation_id: request.generation_id.clone(),
        after_seq: 1,
        limit: 100,
        max_bytes: 1024,
    };
    assert!(matches!(
        read_events(&database.pool, &actor, &read).await,
        Err(Error::Http(409, _))
    ));
    request.requested_render_seq = 2;
    assert_conflict(request_stop(&database.pool, &actor, &request).await);
    assert_eq!(counts(&database.pool, &request.generation_id).await, (0, 2));
}

#[tokio::test(flavor = "multi_thread")]
async fn stopping_owner_path_rejects_tampered_action_and_cannot_revive_expired_leases() {
    use rudder_d1_persistence::native_chat::execution::{observe_stop, renew_stopping_lease};
    let database = Database::start().await;
    let (actor, run, _attempt, fence) = seed_execution(&database).await;
    assert!(
        observe_stop(&database.pool, &actor, &fence)
            .await
            .unwrap()
            .is_none()
    );
    let request = stop_request(&database.pool, &run).await;
    request_stop(&database.pool, &actor, &request)
        .await
        .unwrap();
    let stop = observe_stop(&database.pool, &actor, &fence)
        .await
        .unwrap()
        .unwrap();
    renew_stopping_lease(&database.pool, &actor, &fence, &stop)
        .await
        .unwrap();
    assert_conflict(renew_lease(&database.pool, &actor, &fence).await);
    let original: Value =
        sqlx::query_scalar("SELECT to_jsonb(a) FROM chat_control_actions a WHERE id=$1::uuid")
            .bind(&request.control_action_id)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    for mutation in [
        "control_owner_token='foreign-owner'",
        "applied_control_version=2",
        "accepted_through_seq=2",
        "frozen_body_hash=repeat('0',64)",
        "provider_evidence=jsonb_set(provider_evidence,'{authority}','\"foreign\"')",
        "provider_evidence=jsonb_set(provider_evidence,'{executionPin,identityHash}','\"changed\"')",
        "provider_evidence=jsonb_set(provider_evidence,'{stoppingCheckpointHash}',provider_evidence->'executionPin'->'checkpointHash')",
    ] {
        sqlx::query(&format!(
            "UPDATE chat_control_actions SET {mutation} WHERE id=$1::uuid"
        ))
        .bind(&request.control_action_id)
        .execute(&database.pool)
        .await
        .unwrap();
        assert_conflict(observe_stop(&database.pool, &actor, &fence).await);
        assert_conflict(renew_stopping_lease(&database.pool, &actor, &fence, &stop).await);
        sqlx::query("UPDATE chat_control_actions SET control_owner_token=$2,applied_control_version=$3,accepted_through_seq=$4,frozen_body_hash=$5,provider_evidence=$6 WHERE id=$1::uuid")
            .bind(&request.control_action_id).bind(original["control_owner_token"].as_str()).bind(original["applied_control_version"].as_i64().unwrap() as i32).bind(original["accepted_through_seq"].as_i64().unwrap() as i32).bind(original["frozen_body_hash"].as_str()).bind(&original["provider_evidence"]).execute(&database.pool).await.unwrap();
    }
    let mut tx = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_stop_lease',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE chat_generations SET control_lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1::uuid").bind(&request.generation_id).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    assert_conflict(renew_stopping_lease(&database.pool, &actor, &fence, &stop).await);
    let held: bool =
        sqlx::query_scalar("SELECT native_admission_hold FROM heartbeat_runs WHERE id=$1::uuid")
            .bind(run)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert!(held);
}
