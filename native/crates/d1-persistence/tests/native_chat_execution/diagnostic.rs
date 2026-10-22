use super::*;
use rudder_d1_persistence::native_chat::control::request_stop;
use rudder_d1_persistence::native_chat::execution::record_execution_diagnostic;

#[tokio::test(flavor = "multi_thread")]
async fn diagnostic_is_fenced_bounded_and_does_not_finalize_or_release_input() {
    let database = Database::start().await;
    let (actor, run, attempt, fence) = seed_execution(&database).await;
    record_execution_diagnostic(&database.pool, &actor, &fence, "pi_session_tree", true)
        .await
        .expect("write safe classification");
    let details: Value = sqlx::query_scalar(
        "SELECT details FROM activity_log WHERE org_id=$1::uuid AND entity_id=$2
         AND action='runtime.native_chat.execution_unresolved'",
    )
    .bind(ORG)
    .bind(fence.identity().generation_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(details["code"], "pi_session_tree");
    assert_eq!(details["attemptId"], attempt);
    assert_eq!(details["processQuiescent"], true);
    let serialized = details.to_string();
    assert!(!serialized.contains(fence.run_execution_owner_token()));
    assert!(!serialized.contains(fence.generation_control_owner_token()));
    let state: (String, bool, bool, String, Option<String>) = sqlx::query_as(
        "SELECT r.status,r.native_admission_hold,g.native_admission_hold,
                a.protocol_phase,a.error_code
         FROM heartbeat_runs r JOIN chat_generations g ON g.id=r.chat_generation_id
         JOIN heartbeat_run_attempts a ON a.run_id=r.id WHERE r.id=$1::uuid",
    )
    .bind(&run)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(
        state,
        (
            "running".into(),
            true,
            true,
            "no_thread_request".into(),
            None
        )
    );
    assert!(matches!(
        record_execution_diagnostic(
            &database.pool,
            &actor,
            &fence,
            "unsafe /path?token=value",
            true
        )
        .await,
        Err(Error::Http(400, _))
    ));
    let foreign = verified_actor(OTHER, USER, "diagnostic-foreign");
    assert!(matches!(
        record_execution_diagnostic(&database.pool, &foreign, &fence, "pi_deadline", true).await,
        Err(Error::Http(403, _))
    ));
    let mut stale = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test',true)")
        .execute(&mut *stale)
        .await
        .unwrap();
    sqlx::query("UPDATE heartbeat_runs SET execution_lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1::uuid")
        .bind(&run).execute(&mut *stale).await.unwrap();
    stale.commit().await.unwrap();
    assert_conflict(
        record_execution_diagnostic(&database.pool, &actor, &fence, "pi_deadline", true).await,
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND action='runtime.native_chat.execution_unresolved'")
        .bind(ORG).fetch_one(&database.pool).await.unwrap();
    assert_eq!(
        count, 1,
        "denied/stale diagnostics must not append audit rows"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn stopping_diagnostic_reauthorizes_stop_without_changing_frozen_state() {
    let database = Database::start().await;
    let (actor, run, attempt, fence) = seed_execution(&database).await;
    let stop = super::control::stop_request(&database.pool, &run).await;
    request_stop(&database.pool, &actor, &stop).await.unwrap();
    let snapshot = |pool: PgPool, run: String| async move {
        sqlx::query_scalar::<_, Value>(
            "SELECT jsonb_build_object('generation',to_jsonb(g),'run',to_jsonb(r),
                'attempt',to_jsonb(a),'action',to_jsonb(c))
             FROM heartbeat_runs r JOIN chat_generations g ON g.id=r.chat_generation_id
             JOIN heartbeat_run_attempts a ON a.run_id=r.id
             JOIN chat_control_actions c ON c.expected_generation_id=g.id
             WHERE r.id=$1::uuid",
        )
        .bind(run)
        .fetch_one(&pool)
        .await
        .unwrap()
    };
    let before = snapshot(database.pool.clone(), run.clone()).await;
    record_execution_diagnostic(
        &database.pool,
        &actor,
        &fence,
        "cursor_output_overflow",
        true,
    )
    .await
    .expect("record failure through exact stopping action");
    assert_eq!(before, snapshot(database.pool.clone(), run.clone()).await);
    let details: Value = sqlx::query_scalar(
        "SELECT details FROM activity_log WHERE org_id=$1::uuid AND entity_id=$2
         AND action='runtime.native_chat.execution_unresolved'",
    )
    .bind(ORG)
    .bind(fence.identity().generation_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(details["code"], "cursor_output_overflow");
    assert_eq!(details["attemptId"], attempt);
    assert_eq!(details["processQuiescent"], true);
    let serialized = details.to_string();
    assert!(!serialized.contains(fence.run_execution_owner_token()));
    assert!(!serialized.contains(fence.generation_control_owner_token()));
    let foreign = verified_actor(OTHER, USER, "stopping-diagnostic-foreign");
    assert!(matches!(
        record_execution_diagnostic(&database.pool, &foreign, &fence, "cursor_closed", true).await,
        Err(Error::Http(403, _))
    ));
    let mut tx = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE heartbeat_runs SET execution_lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1::uuid")
        .bind(&run).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    assert_conflict(
        record_execution_diagnostic(&database.pool, &actor, &fence, "cursor_closed", true).await,
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND action='runtime.native_chat.execution_unresolved'")
        .bind(ORG).fetch_one(&database.pool).await.unwrap();
    assert_eq!(
        count, 1,
        "stale/foreign owners cannot append Stop diagnostics"
    );
}
