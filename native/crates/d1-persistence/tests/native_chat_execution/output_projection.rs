use super::*;
use rudder_d1_persistence::native_chat::control::{
    ClientCheckpointRequest, record_client_checkpoint,
};

#[tokio::test(flavor = "multi_thread")]
async fn long_output_history_uses_exact_snapshot_and_stops_at_rendered_prefix() {
    let database = Database::start().await;
    let (actor, run, _, _) = seed_execution(&database).await;
    let mut stop = stop_request(&database.pool, &run).await;
    let message = seed_text(&database.pool, &stop, &run).await;
    let mut tx = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_control',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    // More than the old total-history limit, followed by a replacement snapshot.
    sqlx::query("INSERT INTO chat_generation_events(org_id,generation_id,generation_seq,attempt_epoch,event_kind,payload,assistant_message_id,run_id)
        SELECT $1::uuid,$2::uuid,s,1,'assistant_delta',jsonb_build_object('delta','x','bodyHash',$3::text),$4::uuid,$5::uuid FROM generate_series(4,2200) s")
        .bind(ORG).bind(&stop.generation_id).bind(hash("x")).bind(&message).bind(&run)
        .execute(&mut *tx).await.unwrap();
    for (seq, kind, payload) in [
        (
            2201,
            "runtime_output",
            json!({"body":"snapshot","bodyHash":hash("snapshot")}),
        ),
        (
            2202,
            "assistant_delta",
            json!({"delta":"✓","bodyHash":hash("snapshot✓")}),
        ),
        (
            2203,
            "assistant_delta",
            json!({"delta":" unseen","bodyHash":hash("snapshot✓ unseen")}),
        ),
    ] {
        sqlx::query("INSERT INTO chat_generation_events(org_id,generation_id,generation_seq,attempt_epoch,event_kind,payload,assistant_message_id,run_id) VALUES($1::uuid,$2::uuid,$3,1,$4,$5,$6::uuid,$7::uuid)")
            .bind(ORG).bind(&stop.generation_id).bind(seq).bind(kind).bind(payload).bind(&message).bind(&run)
            .execute(&mut *tx).await.unwrap();
    }
    sqlx::query("UPDATE chat_messages SET body='snapshot✓ unseen' WHERE id=$1::uuid")
        .bind(&message)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    stop.requested_render_seq = 2202;
    stop.requested_body_hash = hash("snapshot✓");
    let receipt = request_stop(&database.pool, &actor, &stop).await.unwrap();
    assert_eq!(receipt.accepted_through_seq, Some(2202));
    let frozen: (String, String) =
        sqlx::query_as("SELECT body,status FROM chat_messages WHERE id=$1::uuid")
            .bind(message)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert_eq!(frozen, ("snapshot✓".into(), "stopped".into()));
}

#[tokio::test(flavor = "multi_thread")]
async fn text_checkpoint_and_stop_reject_missing_run_or_wrong_assistant_binding() {
    let database = Database::start().await;
    let (actor, run, _, _) = seed_execution(&database).await;
    let mut stop = stop_request(&database.pool, &run).await;
    let message = seed_text(&database.pool, &stop, &run).await;
    stop.requested_render_seq = 2;
    stop.requested_body_hash = hash("a");
    let checkpoint = ClientCheckpointRequest {
        conversation_id: CHAT.into(),
        generation_id: stop.generation_id.clone(),
        attempt_epoch: 1,
        generation_seq: 2,
        rendered_body_hash: hash("a"),
    };
    let before = counts(&database.pool, &stop.generation_id).await;
    let mut tx = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_control',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE chat_generation_events SET run_id=NULL WHERE generation_id=$1::uuid AND generation_seq=2")
        .bind(&stop.generation_id).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    assert_conflict(record_client_checkpoint(&database.pool, &actor, &checkpoint).await);
    assert_conflict(request_stop(&database.pool, &actor, &stop).await);
    let mut tx = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_control',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    // Valid FK to a different, source user message must not bind assistant output.
    sqlx::query("UPDATE chat_generation_events SET run_id=$2::uuid,assistant_message_id=(SELECT source_message_id FROM chat_generations WHERE id=$1::uuid) WHERE generation_id=$1::uuid AND generation_seq=2")
        .bind(&stop.generation_id).bind(&run).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    assert_conflict(request_stop(&database.pool, &actor, &stop).await);
    assert_eq!(before, counts(&database.pool, &stop.generation_id).await);
    let body: String = sqlx::query_scalar("SELECT body FROM chat_messages WHERE id=$1::uuid")
        .bind(message)
        .fetch_one(&database.pool)
        .await
        .unwrap();
    assert_eq!(body, "ab");
}

#[tokio::test(flavor = "multi_thread")]
async fn large_snapshot_replay_is_bounded_private_and_stop_can_freeze_it() {
    let database = Database::start().await;
    let (actor, run, _, _) = seed_execution(&database).await;
    let mut stop = stop_request(&database.pool, &run).await;
    let message = seed_text(&database.pool, &stop, &run).await;
    let body = "答".repeat(70_000); // 210 KiB, above the old 64 KiB event cap.
    let mut tx = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_control',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO chat_generation_events(org_id,generation_id,generation_seq,attempt_epoch,event_kind,payload,assistant_message_id,run_id) VALUES($1::uuid,$2::uuid,4,1,'runtime_output',$3,$4::uuid,$5::uuid)")
        .bind(ORG).bind(&stop.generation_id)
        .bind(json!({"body":body,"bodyHash":hash(&body),"nativeSource":{"claimDigest":"private-claim-digest-sentinel"}}))
        .bind(&message).bind(&run).execute(&mut *tx).await.unwrap();
    sqlx::query("UPDATE chat_messages SET body=$2 WHERE id=$1::uuid")
        .bind(&message)
        .bind(&body)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut read = ReadEvents {
        conversation_id: CHAT.into(),
        generation_id: stop.generation_id.clone(),
        after_seq: 3,
        limit: 100,
        max_bytes: 1024,
    };
    assert!(matches!(
        read_events(&database.pool, &actor, &read).await,
        Err(Error::Http(422, _))
    ));
    read.max_bytes = 1024 * 1024;
    let page = read_events(&database.pool, &actor, &read).await.unwrap();
    assert_eq!(page.next_seq, 4);
    assert!(!page.has_more);
    assert_eq!(page.events[0].payload["body"], body);
    assert!(
        !serde_json::to_string(&page)
            .unwrap()
            .contains("private-claim-digest-sentinel")
    );
    stop.requested_render_seq = 4;
    stop.requested_body_hash = hash(&body);
    let receipt = request_stop(&database.pool, &actor, &stop).await.unwrap();
    assert_eq!(receipt.frozen_body_hash, Some(hash(&body)));
}

#[tokio::test(flavor = "multi_thread")]
async fn zero_cutoff_cannot_freeze_a_row_without_exact_ledger_provenance() {
    let database = Database::start().await;
    let (actor, run, _, _) = seed_execution(&database).await;
    let stop = stop_request(&database.pool, &run).await;
    let message = seed_text(&database.pool, &stop, &run).await;
    let mut tx = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_control',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE chat_generation_events SET assistant_message_id=(SELECT source_message_id FROM chat_generations WHERE id=$1::uuid) WHERE generation_id=$1::uuid AND event_kind='assistant_delta'")
        .bind(&stop.generation_id).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    let before = counts(&database.pool, &stop.generation_id).await;
    assert_conflict(request_stop(&database.pool, &actor, &stop).await);
    assert_eq!(before, counts(&database.pool, &stop.generation_id).await);
    let row: (String, String) =
        sqlx::query_as("SELECT body,status FROM chat_messages WHERE id=$1::uuid")
            .bind(message)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert_eq!(row, ("ab".into(), "streaming".into()));
}

#[tokio::test(flavor = "multi_thread")]
async fn public_turn_messages_are_scoped_bounded_and_never_expose_execution_provenance() {
    use rudder_d1_persistence::native_chat::control::{ReadTurn, read_turn};
    let database = Database::start().await;
    let (actor, run, _, _) = seed_execution(&database).await;
    let stop = stop_request(&database.pool, &run).await;
    let request = ReadTurn {
        conversation_id: CHAT.into(),
        generation_id: stop.generation_id.clone(),
    };
    let admitted = read_turn(&database.pool, &actor, &request).await.unwrap();
    assert_eq!(admitted.source_message["role"], "user");
    assert_eq!(admitted.source_message["generationId"], stop.generation_id);
    assert_eq!(admitted.source_message["attachments"], json!([]));
    assert!(admitted.assistant_message.is_none());
    assert!(!admitted.runtime_terminal);
    assert_eq!(admitted.last_client_checkpoint_seq, None);
    assert_eq!(admitted.last_client_checkpoint_hash, None);
    let message = seed_text(&database.pool, &stop, &run).await;
    let empty_hash = hash("");
    rudder_d1_persistence::native_chat::control::record_client_checkpoint(
        &database.pool,
        &actor,
        &rudder_d1_persistence::native_chat::control::ClientCheckpointRequest {
            conversation_id: CHAT.into(),
            generation_id: stop.generation_id.clone(),
            attempt_epoch: 1,
            generation_seq: 0,
            rendered_body_hash: empty_hash.clone(),
        },
    )
    .await
    .unwrap();
    let checkpointed = read_turn(&database.pool, &actor, &request).await.unwrap();
    assert_eq!(checkpointed.last_client_checkpoint_seq, Some(0));
    assert_eq!(
        checkpointed.last_client_checkpoint_hash.as_deref(),
        Some(empty_hash.as_str())
    );
    let projected = read_turn(&database.pool, &actor, &request).await.unwrap();
    assert_eq!(projected.assistant_message.as_ref().unwrap()["id"], message);
    assert_eq!(projected.assistant_message.as_ref().unwrap()["body"], "ab");
    let wire = serde_json::to_string(&projected).unwrap();
    for private in [
        "ownerToken",
        "providerThreadId",
        "private-test-sentinel",
        "nativeSource",
        "clientMutationFingerprint",
    ] {
        assert!(!wire.contains(private), "{private}");
    }
    let foreign = verified_actor(OTHER, USER, "foreign-message-read");
    assert!(matches!(
        read_turn(&database.pool, &foreign, &request).await,
        Err(Error::Http(403 | 404, _))
    ));
    let mut tx = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_control',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(r#"UPDATE chat_messages SET structured_payload='{"hidden":"private-provider-content"}'::jsonb WHERE id=$1::uuid"#)
        .bind(&message).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    assert_conflict(read_turn(&database.pool, &actor, &request).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn control_turn_read_reports_legacy_only_for_the_exact_authorized_legacy_generation() {
    use rudder_d1_persistence::native_chat::control::{ReadTurn, read_turn_for_control};

    let database = Database::start().await;
    let (actor, _, _, _) = seed_execution(&database).await;
    let generation = "71000000-0000-4000-8000-000000000019";
    sqlx::query(
        "INSERT INTO chat_generations(id,org_id,conversation_id,status)
         VALUES($1::uuid,$2::uuid,$3::uuid,'completed')",
    )
    .bind(generation)
    .bind(ORG)
    .bind(CHAT)
    .execute(&database.pool)
    .await
    .unwrap();

    let request = ReadTurn {
        conversation_id: CHAT.into(),
        generation_id: generation.into(),
    };
    let result = read_turn_for_control(&database.pool, &actor, &request)
        .await
        .unwrap();
    assert_eq!(result["executionAuthority"], "legacy_ts");
    assert_eq!(result["generationId"], generation);
    assert_eq!(result["attemptEpoch"], 1);
    assert_eq!(result["controlVersion"], 0);
    assert!(result.get("sourceMessage").is_none());
    assert!(result.get("runId").is_none());

    let missing = ReadTurn {
        conversation_id: CHAT.into(),
        generation_id: "71000000-0000-4000-8000-000000000020".into(),
    };
    assert!(matches!(
        read_turn_for_control(&database.pool, &actor, &missing).await,
        Err(Error::Http(404, _))
    ));
    let foreign = verified_actor(OTHER, USER, "foreign-legacy-turn-read");
    assert!(matches!(
        read_turn_for_control(&database.pool, &foreign, &request).await,
        Err(Error::Http(403 | 404, _))
    ));
}
