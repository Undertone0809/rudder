use super::*;

#[tokio::test(flavor = "multi_thread")]
async fn span_lock_wait_rechecks_lease_and_serializes_newer_attempt_insert() {
    let database = Database::start().await;
    seed_access(&database.pool).await;
    seed_chat(&database.pool, CHAT, "chat", USER).await;
    let owner = actor(USER, ORG, "span-lock-wait");
    let (binding_id, segment_id) = ensure_binding(&database.pool, &owner, CHAT).await;
    seed_run_attempt(&database.pool, CHAT).await;
    sqlx::query("UPDATE heartbeat_runs SET execution_lease_expires_at=clock_timestamp() + interval '250 milliseconds' WHERE id=$1::uuid")
        .bind(RUN)
        .execute(&database.pool)
        .await
        .expect("set short lease");

    let mut blocker = database.pool.begin().await.expect("begin segment blocker");
    sqlx::query("SELECT id FROM native_segments WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE")
        .bind(ORG)
        .bind(&segment_id)
        .fetch_one(&mut *blocker)
        .await
        .expect("lock segment row");

    let open = open_request(&binding_id, &segment_id);
    let span_pool = database.pool.clone();
    let span_actor = owner.clone();
    let span_request = open.clone();
    let span_task =
        tokio::spawn(async move { execute(&span_pool, &span_actor, ORG, &span_request).await });

    let mut waiting_for_segment = false;
    for _ in 0..100 {
        let waiting: bool = sqlx::query_scalar(
            "SELECT EXISTS(
               SELECT 1 FROM pg_stat_activity
               WHERE wait_event_type='Lock' AND query LIKE '%FROM runtime_bindings b%'
             )",
        )
        .fetch_one(&database.pool)
        .await
        .expect("inspect span lock wait");
        if waiting {
            waiting_for_segment = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(
        waiting_for_segment,
        "span operation should hold the Run lock while waiting on the segment"
    );

    let pool = database.pool.clone();
    let newer_attempt = tokio::spawn(async move {
        sqlx::query(
            "INSERT INTO heartbeat_run_attempts
               (id, org_id, run_id, agent_id, attempt_index, runtime_type, status)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 'codex_local', 'started')",
        )
        .bind(ATTEMPT_TWO)
        .bind(ORG)
        .bind(RUN)
        .bind(CEO)
        .execute(&pool)
        .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(350)).await;
    assert!(
        !newer_attempt.is_finished(),
        "Run FK must wait behind the span's Run FOR UPDATE lock"
    );

    blocker.rollback().await.expect("release segment blocker");
    assert!(matches!(
        span_task.await.expect("span operation joined"),
        Err(Error::Http(409, _))
    ));
    newer_attempt
        .await
        .expect("newer attempt insert joined")
        .expect("newer attempt inserted after span lock released");
    assert!(matches!(
        execute(&database.pool, &owner, ORG, &open).await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(span_counts(&database.pool).await, (0, 0, 0));
}

#[tokio::test(flavor = "multi_thread")]
async fn conversation_first_lock_order_allows_teardown_run_update_without_deadlock() {
    let database = Database::start().await;
    seed_access(&database.pool).await;
    seed_chat(&database.pool, CHAT, "chat", USER).await;
    let owner = actor(USER, ORG, "conversation-first-lock");
    let (binding_id, segment_id) = ensure_binding(&database.pool, &owner, CHAT).await;
    seed_run_attempt(&database.pool, CHAT).await;

    let before = span_counts(&database.pool).await;
    let mut teardown = database
        .pool
        .begin()
        .await
        .expect("begin lifecycle transaction");
    sqlx::query(
        "SELECT id FROM chat_conversations WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE",
    )
    .bind(ORG)
    .bind(CHAT)
    .fetch_one(&mut *teardown)
    .await
    .expect("lock conversation before teardown");

    let request = open_request(&binding_id, &segment_id);
    let operation_pool = database.pool.clone();
    let operation_actor = owner.clone();
    let operation =
        tokio::spawn(
            async move { execute(&operation_pool, &operation_actor, ORG, &request).await },
        );
    let mut waiting_for_conversation = false;
    for _ in 0..100 {
        let waiting: bool = sqlx::query_scalar(
            "SELECT EXISTS(
               SELECT 1 FROM pg_stat_activity
               WHERE wait_event_type='Lock' AND query LIKE '%FROM chat_conversations%'
             )",
        )
        .fetch_one(&database.pool)
        .await
        .expect("inspect conversation lock wait");
        if waiting {
            waiting_for_conversation = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(
        waiting_for_conversation,
        "span operation should wait for Conversation first"
    );

    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        sqlx::query("UPDATE heartbeat_runs SET chat_conversation_id=NULL WHERE org_id=$1::uuid AND id=$2::uuid")
            .bind(ORG)
            .bind(RUN)
            .execute(&mut *teardown),
    )
    .await
    .expect("teardown Run update must not deadlock behind span's Run lock")
    .expect("update Run association during teardown");
    teardown.commit().await.expect("commit lifecycle teardown");

    assert!(matches!(
        operation.await.expect("span operation joined"),
        Err(Error::Http(409, _))
    ));
    assert_eq!(span_counts(&database.pool).await, before);
}

#[tokio::test(flavor = "multi_thread")]
async fn admitted_side_chat_run_can_finish_after_ttl_without_touching_lifecycle() {
    let database = Database::start().await;
    seed_access(&database.pool).await;
    seed_chat(&database.pool, SIDE_CHAT, "side_chat", USER).await;
    let owner = actor(USER, ORG, "side-owner");
    let (binding_id, segment_id) = ensure_binding(&database.pool, &owner, SIDE_CHAT).await;
    seed_run_attempt(&database.pool, SIDE_CHAT).await;

    let open = open_request(&binding_id, &segment_id);
    let before_stale = span_counts(&database.pool).await;
    let new_owner = actor(OTHER_USER, ORG, "side-new-owner");
    sqlx::query(
        "UPDATE chat_conversations SET created_by_user_id=$3 WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(SIDE_CHAT)
    .bind(OTHER_USER)
    .execute(&database.pool)
    .await
    .expect("change Side Chat owner fixture");
    assert!(matches!(
        execute(&database.pool, &owner, ORG, &open).await,
        Err(Error::Http(404, _))
    ));
    assert!(matches!(
        execute(&database.pool, &new_owner, ORG, &open).await,
        Err(Error::Http(409, _))
    ));
    sqlx::query(
        "UPDATE chat_conversations SET created_by_user_id=$3 WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(SIDE_CHAT)
    .bind(USER)
    .execute(&database.pool)
    .await
    .expect("restore Side Chat owner fixture");
    assert_eq!(span_counts(&database.pool).await, before_stale);

    let mut stale = open.clone();
    if let Request::Open { attempt_epoch, .. } = &mut stale {
        *attempt_epoch = 8;
    }
    assert!(matches!(
        execute(&database.pool, &owner, ORG, &stale).await,
        Err(Error::Http(409, _))
    ));
    let mut stale = open.clone();
    if let Request::Open { owner_token, .. } = &mut stale {
        *owner_token = "wrong-owner".to_owned();
    }
    assert!(matches!(
        execute(&database.pool, &owner, ORG, &stale).await,
        Err(Error::Http(409, _))
    ));
    let wrong_segment = open_request(&binding_id, "63000000-0000-4000-8000-000000000109");
    assert!(matches!(
        execute(&database.pool, &owner, ORG, &wrong_segment).await,
        Err(Error::Http(404, _))
    ));
    assert_eq!(span_counts(&database.pool).await, before_stale);

    let opened = execute(&database.pool, &owner, ORG, &open)
        .await
        .expect("open valid span");
    let span_id = opened["span"]["id"].as_str().expect("span id").to_owned();
    let read: Request =
        serde_json::from_value(json!({"operation":"read","spanId":span_id})).expect("read request");
    sqlx::query(
        "UPDATE chat_conversations SET created_by_user_id=$3 WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(SIDE_CHAT)
    .bind(OTHER_USER)
    .execute(&database.pool)
    .await
    .expect("change Side Chat owner after span fixture");
    let before_owner_change = span_counts(&database.pool).await;
    assert!(matches!(
        execute(&database.pool, &owner, ORG, &read).await,
        Err(Error::Http(404, _))
    ));
    assert!(matches!(
        execute(&database.pool, &new_owner, ORG, &read).await,
        Err(Error::Http(404, _))
    ));
    let owner_change_locator = bind_request(&span_id, "side-native-session", None, None);
    assert!(matches!(
        execute(&database.pool, &owner, ORG, &owner_change_locator).await,
        Err(Error::Http(404, _))
    ));
    assert!(matches!(
        execute(&database.pool, &new_owner, ORG, &owner_change_locator).await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(span_counts(&database.pool).await, before_owner_change);
    sqlx::query(
        "UPDATE chat_conversations SET created_by_user_id=$3 WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(SIDE_CHAT)
    .bind(USER)
    .execute(&database.pool)
    .await
    .expect("restore Side Chat owner after span fixture");
    sqlx::query("UPDATE heartbeat_runs SET started_at=clock_timestamp() - interval '10 minutes' WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(ORG)
        .bind(RUN)
        .execute(&database.pool)
        .await
        .expect("place Run admission before expiry");
    sqlx::query(
        "UPDATE chat_conversations
         SET side_chat_expires_at=(SELECT started_at + interval '2 minutes'
                                   FROM heartbeat_runs WHERE id=$3::uuid)
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(SIDE_CHAT)
    .bind(RUN)
    .execute(&database.pool)
    .await
    .expect("expire Side Chat");

    let locator = bind_request(&span_id, "side-native-session", None, None);
    let before_expired_mutation = span_counts(&database.pool).await;
    let before_lifecycle = side_chat_lifecycle_snapshot(&database.pool).await;
    let bound = execute(&database.pool, &owner, ORG, &locator)
        .await
        .expect("pre-expiry admitted Run may persist locator after TTL");
    assert_eq!(bound["segment"]["nativeSessionId"], "side-native-session");
    assert_eq!(
        span_counts(&database.pool).await,
        (before_expired_mutation.0, before_expired_mutation.1 + 1, 1)
    );
    assert_eq!(
        side_chat_lifecycle_snapshot(&database.pool).await,
        before_lifecycle
    );

    assert_eq!(
        execute(&database.pool, &owner, ORG, &read)
            .await
            .expect("owner reads expired history")["span"]["id"],
        span_id
    );
    let non_owner = actor(OTHER_USER, ORG, "side-non-owner");
    assert!(matches!(
        execute(&database.pool, &non_owner, ORG, &read).await,
        Err(Error::Http(404, _))
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn run_started_after_side_chat_expiry_cannot_open_span_or_write_audit() {
    let database = Database::start().await;
    seed_access(&database.pool).await;
    seed_chat(&database.pool, SIDE_CHAT, "side_chat", USER).await;
    let owner = actor(USER, ORG, "late-side-run");
    let (binding_id, segment_id) = ensure_binding(&database.pool, &owner, SIDE_CHAT).await;
    seed_run_attempt(&database.pool, SIDE_CHAT).await;
    sqlx::query(
        "UPDATE chat_conversations
         SET side_chat_expires_at=clock_timestamp() - interval '1 second'
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(SIDE_CHAT)
    .execute(&database.pool)
    .await
    .expect("expire Side Chat before Run admission");
    sqlx::query("UPDATE heartbeat_runs SET started_at=clock_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(ORG)
        .bind(RUN)
        .execute(&database.pool)
        .await
        .expect("admit Run after Side Chat expiry");

    let before = span_counts(&database.pool).await;
    let lifecycle_before = side_chat_lifecycle_snapshot(&database.pool).await;
    let open = open_request(&binding_id, &segment_id);
    assert!(matches!(
        execute(&database.pool, &owner, ORG, &open).await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(span_counts(&database.pool).await, before);
    assert_eq!(
        side_chat_lifecycle_snapshot(&database.pool).await,
        lifecycle_before
    );
}

#[test]
fn span_wire_contract_rejects_unfenced_or_provider_state_fields() {
    for invalid in [
        json!({"operation":"open","runId":RUN,"attemptId":ATTEMPT,"attemptEpoch":1,"bindingId":"x","segmentId":"y"}),
        json!({"operation":"read","spanId":"x","ownerToken":"secret"}),
        json!({"operation":"bind_locator","spanId":"x","attemptId":ATTEMPT,"attemptEpoch":1,"ownerToken":"x","nativeSessionId":"n","providerState":{"token":"secret"}}),
        json!({"operation":"open","runId":RUN,"attemptId":ATTEMPT,"attemptEpoch":1,"ownerToken":"x","bindingId":"x","segmentId":"y","ordinal":99}),
    ] {
        assert!(serde_json::from_value::<Request>(invalid).is_err());
    }
}
