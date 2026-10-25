use super::*;
use rudder_d1_persistence::native_chat::control::{
    read_recovery_state, recover_expired_claimed_stop,
};

#[tokio::test(flavor = "multi_thread")]
async fn recovery_discovery_survives_fresh_reads_without_an_active_queue_generation() {
    let database = Database::start().await;
    let (actor, run, _, _) = seed_execution(&database).await;
    assert!(
        read_recovery_state(&database.pool, &actor, CHAT)
            .await
            .unwrap()
            .recovery
            .is_none()
    );
    let request = stop_request(&database.pool, &run).await;
    request_stop(&database.pool, &actor, &request)
        .await
        .unwrap();
    let mut tx = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_control',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE chat_generations SET control_lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1::uuid")
        .bind(&request.generation_id).execute(&mut *tx).await.unwrap();
    sqlx::query("UPDATE heartbeat_runs SET execution_lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1::uuid")
        .bind(&run).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    recover_expired_claimed_stop(&database.pool, &actor, &request)
        .await
        .unwrap()
        .expect("claimed owner loss recorded");

    let expected = json!({
        "executionAuthority":"native_rust", "orgId":ORG, "conversationId":CHAT,
        "recovery":{
            "generationId":request.generation_id,"runId":run,"attemptEpoch":1,
            "generationStatus":"interrupted_unverified","controlState":"control_lost",
            "cleanupState":"unknown"
        }
    });
    let before = counts(&database.pool, &request.generation_id).await;
    // Each call creates a fresh read-only transaction. No Node queue map or
    // active-generation status participates in either discovery or replay.
    for _ in 0..2 {
        let snapshot = read_recovery_state(&database.pool, &actor, CHAT)
            .await
            .unwrap();
        assert_eq!(serde_json::to_value(snapshot).unwrap(), expected);
    }
    assert_eq!(counts(&database.pool, &request.generation_id).await, before);
    let foreign = verified_actor(OTHER, "foreign-user", "recovery-read-foreign");
    assert!(
        read_recovery_state(&database.pool, &foreign, CHAT)
            .await
            .is_err()
    );

    // Clearing both holds alone is not resolution of the owner-loss incident.
    // The compound FK already prohibits a committed single-hold mismatch.
    let mut tx = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_control',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE heartbeat_runs SET native_admission_hold=false WHERE id=$1::uuid")
        .bind(&run)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE chat_generations SET native_admission_hold=false WHERE id=$1::uuid")
        .bind(&request.generation_id)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert!(matches!(
        read_recovery_state(&database.pool, &actor, CHAT).await,
        Err(rudder_d1_persistence::runtime_bindings::Error::Http(409, _))
    ));
}
