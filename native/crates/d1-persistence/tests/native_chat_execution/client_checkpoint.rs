use super::*;
use rudder_d1_persistence::native_chat::control::{
    ClientCheckpointRequest, record_client_checkpoint,
};

#[tokio::test(flavor = "multi_thread")]
async fn client_acknowledgement_is_monotonic_and_stop_keeps_the_acknowledged_prefix() {
    let database = Database::start().await;
    let (actor, run, _, _) = seed_execution(&database).await;
    let stop = stop_request(&database.pool, &run).await;
    let message = seed_text(&database.pool, &stop, &run).await;
    let request = ClientCheckpointRequest {
        conversation_id: CHAT.into(),
        generation_id: stop.generation_id.clone(),
        attempt_epoch: 1,
        generation_seq: 2,
        rendered_body_hash: hash("a"),
    };
    let before = counts(&database.pool, &stop.generation_id).await;
    let first = record_client_checkpoint(&database.pool, &actor, &request)
        .await
        .unwrap();
    assert!(first.advanced);
    assert_eq!(first.generation_seq, 2);
    let replay = record_client_checkpoint(&database.pool, &actor, &request)
        .await
        .unwrap();
    assert!(!replay.advanced);
    let mut old = request.clone();
    old.generation_seq = 0;
    old.rendered_body_hash = hash("");
    let older = record_client_checkpoint(&database.pool, &actor, &old)
        .await
        .unwrap();
    assert!(!older.advanced);
    assert_eq!(older.generation_seq, 2);
    assert_eq!(
        counts(&database.pool, &stop.generation_id).await,
        (before.0, before.1 + 1)
    );
    let result = request_stop(&database.pool, &actor, &stop).await.unwrap();
    assert_eq!(result.accepted_through_seq, Some(2));
    assert_eq!(result.frozen_body_hash, Some(hash("a")));
    let frozen: String = sqlx::query_scalar("SELECT body FROM chat_messages WHERE id=$1::uuid")
        .bind(message)
        .fetch_one(&database.pool)
        .await
        .unwrap();
    assert_eq!(frozen, "a");
    assert_conflict(record_client_checkpoint(&database.pool, &actor, &request).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn client_acknowledgement_rejects_forged_output_and_rolls_back_audit_failure() {
    let database = Database::start().await;
    let (actor, run, _, _) = seed_execution(&database).await;
    let stop = stop_request(&database.pool, &run).await;
    seed_text(&database.pool, &stop, &run).await;
    let request = ClientCheckpointRequest {
        conversation_id: CHAT.into(),
        generation_id: stop.generation_id.clone(),
        attempt_epoch: 1,
        generation_seq: 2,
        rendered_body_hash: hash("a"),
    };
    for (epoch, seq, body) in [(2, 2, "a"), (1, 999, "a"), (1, 2, "wrong"), (1, 1, "")] {
        let mut invalid = request.clone();
        invalid.attempt_epoch = epoch;
        invalid.generation_seq = seq;
        invalid.rendered_body_hash = hash(body);
        assert_conflict(record_client_checkpoint(&database.pool, &actor, &invalid).await);
    }
    let before: Value =
        sqlx::query_scalar("SELECT to_jsonb(g) FROM chat_generations g WHERE id=$1::uuid")
            .bind(&request.generation_id)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    let event_count = counts(&database.pool, &request.generation_id).await;
    let mut tx = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_control',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE chat_generation_events SET payload=payload||$2::jsonb WHERE generation_id=$1::uuid AND generation_seq=1")
        .bind(&request.generation_id).bind(json!({"bodyHash":hash("")}))
        .execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    let mut non_visible = request.clone();
    non_visible.generation_seq = 1;
    non_visible.rendered_body_hash = hash("");
    assert_conflict(record_client_checkpoint(&database.pool, &actor, &non_visible).await);
    sqlx::raw_sql("CREATE FUNCTION reject_client_ack_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='runtime.native_chat.client_checkpoint' THEN RAISE EXCEPTION 'fixture rejects checkpoint audit'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_client_ack_audit BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION reject_client_ack_audit();")
        .execute(&database.pool).await.unwrap();
    assert!(
        record_client_checkpoint(&database.pool, &actor, &request)
            .await
            .is_err()
    );
    let after: Value =
        sqlx::query_scalar("SELECT to_jsonb(g) FROM chat_generations g WHERE id=$1::uuid")
            .bind(&request.generation_id)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert_eq!(before, after);
    assert_eq!(
        event_count,
        counts(&database.pool, &request.generation_id).await
    );
    sqlx::raw_sql("DROP TRIGGER reject_client_ack_audit ON activity_log; DROP FUNCTION reject_client_ack_audit();")
        .execute(&database.pool).await.unwrap();
    assert!(
        record_client_checkpoint(&database.pool, &actor, &request)
            .await
            .unwrap()
            .advanced
    );
}
