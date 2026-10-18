use crate::fixture::*;
use rudder_d1_persistence::native_chat::execution::finalize;
use serde_json::Value;
use std::time::Duration;

const POLICY_SQL: &str = "INSERT INTO budget_policies
 (org_id,scope_type,scope_id,metric,window_kind,amount,hard_stop_enabled,is_active)
 VALUES ($1::uuid,'organization',$1::uuid,'billed_cents','lifetime',10000,true,true)";

fn assert_guard(error: sqlx::Error) {
    assert_eq!(
        error.as_database_error().and_then(|e| e.code()).as_deref(),
        Some("42501"),
        "{error}"
    );
}

async fn finalization_snapshot(pool: &sqlx::PgPool, run: &str) -> Value {
    sqlx::query_scalar(
        "SELECT jsonb_build_object('result',r.result_json,
         'messages',(SELECT count(*) FROM chat_messages WHERE run_id=r.id),
         'generationEvents',(SELECT count(*) FROM chat_generation_events WHERE run_id=r.id),
         'runEvents',(SELECT count(*) FROM heartbeat_run_events WHERE run_id=r.id),
         'activity',(SELECT count(*) FROM activity_log WHERE org_id=r.org_id
           AND entity_type='heartbeat_run' AND entity_id=r.id::text))
         FROM heartbeat_runs r WHERE r.id=$1::uuid",
    )
    .bind(run)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; disposable PostgreSQL and controlled provider"]
async fn changed_attempt_model_cannot_project_a_terminal_receipt() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run, attempt) = database_and_admission("complete").await;
    let (observed, _host) =
        execute_on_worker(&database, host, actor, run.clone(), attempt.clone()).await;
    let observed = observed.unwrap();
    let before = finalization_snapshot(&database.pool, &run).await;
    let mut tx = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE heartbeat_run_attempts SET model='vendor/incorrect-model' WHERE id=$1::uuid",
    )
    .bind(&attempt)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let error = finalize(
        &database.pool,
        &verified_actor(),
        &observed.fence,
        &observed.turn_receipt,
        observed.cleanup_receipt.as_ref().unwrap(),
    )
    .await
    .unwrap_err();
    assert!(
        matches!(
            error,
            rudder_d1_persistence::runtime_bindings::Error::Http(409, _)
        ),
        "{error}"
    );
    assert_eq!(finalization_snapshot(&database.pool, &run).await, before);
    let held: bool = sqlx::query_scalar("SELECT r.native_admission_hold AND g.native_admission_hold
        FROM heartbeat_runs r JOIN chat_generations g ON g.id=r.chat_generation_id WHERE r.id=$1::uuid")
        .bind(&run).fetch_one(&database.pool).await.unwrap();
    assert!(held);
}

async fn retry_after_membership_revocation(row_lock: bool) {
    assert_ignored_external_dependencies();
    let (database, host, actor, run, attempt) = database_and_admission("complete").await;
    let (observed, _host) = execute_on_worker(&database, host, actor, run.clone(), attempt).await;
    let observed = observed.unwrap();
    finalize(
        &database.pool,
        &verified_actor(),
        &observed.fence,
        &observed.turn_receipt,
        observed.cleanup_receipt.as_ref().unwrap(),
    )
    .await
    .unwrap();
    let before = finalization_snapshot(&database.pool, &run).await;
    let mut blocker = database.pool.begin().await.unwrap();
    let blocker_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    if row_lock {
        sqlx::query("SELECT id FROM chat_conversations WHERE id=$1::uuid FOR UPDATE")
            .bind(CHAT)
            .execute(&mut *blocker)
            .await
            .unwrap();
    } else {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
            .bind(format!(
                "runtime-binding:target:chat_conversation:{ORG}:{CHAT}"
            ))
            .execute(&mut *blocker)
            .await
            .unwrap();
    }
    let pool = database.pool.clone();
    let pending = tokio::spawn(async move {
        finalize(
            &pool,
            &verified_actor(),
            &observed.fence,
            &observed.turn_receipt,
            observed.cleanup_receipt.as_ref().unwrap(),
        )
        .await
    });
    // Require a database-confirmed waiter behind this exact transaction. The
    // revocation therefore occurs after the retry's initial authorization.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let waiting: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity
             WHERE $1=ANY(pg_blocking_pids(pid)))",
        )
        .bind(blocker_pid)
        .fetch_one(&database.pool)
        .await
        .unwrap();
        if waiting {
            break;
        }
        assert!(
            !pending.is_finished(),
            "retry bypassed the authorization lock"
        );
        assert!(std::time::Instant::now() < deadline, "retry never waited");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let revoked = sqlx::query(
        "DELETE FROM organization_memberships
         WHERE org_id=$1::uuid AND principal_type='user' AND principal_id=$2",
    )
    .bind(ORG)
    .bind(&verified_actor().actor().id)
    .execute(&mut *blocker)
    .await
    .unwrap();
    assert_eq!(revoked.rows_affected(), 1);
    blocker.commit().await.unwrap();
    let error = pending.await.unwrap().unwrap_err();
    assert!(
        matches!(
            error,
            rudder_d1_persistence::runtime_bindings::Error::Http(403, _)
        ),
        "{error}"
    );
    assert_eq!(finalization_snapshot(&database.pool, &run).await, before);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; disposable PostgreSQL and controlled provider"]
async fn exact_retry_rechecks_revoked_membership_after_target_lock_wait() {
    retry_after_membership_revocation(false).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; disposable PostgreSQL and controlled provider"]
async fn exact_retry_rechecks_revoked_membership_after_conversation_row_wait() {
    retry_after_membership_revocation(true).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; disposable PostgreSQL and controlled provider"]
async fn private_locator_migration_preserves_authority_and_legacy_and_refuses_unbacked_mirrors() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run, attempt) = database_and_admission("complete").await;
    let (observed, _host) =
        execute_on_worker(&database, host, actor, run.clone(), attempt.clone()).await;
    let observed = observed.unwrap();
    let migration = include_str!(
        "../../../../../packages/db/src/migrations/0181_native_chat_finalization_guards.sql"
    )
    .split("--> statement-breakpoint")
    .next()
    .unwrap();
    let mut tx = database.pool.begin().await.unwrap();
    sqlx::query(
        "ALTER TABLE heartbeat_runs DISABLE TRIGGER heartbeat_runs_native_private_session_guard",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "SELECT set_config('rudder.native_chat_write','native_chat:migration_fixture',true)",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE heartbeat_runs SET session_id_before=$2,session_id_after=$2 WHERE id=$1::uuid",
    )
    .bind(&run)
    .bind(observed.turn_receipt.thread_id())
    .execute(&mut *tx)
    .await
    .unwrap();
    let legacy: String = sqlx::query_scalar("INSERT INTO heartbeat_runs(org_id,agent_id,status,session_id_after) VALUES ($1::uuid,$2::uuid,'succeeded','legacy-visible-session') RETURNING id::text")
        .bind(ORG).bind(CEO).fetch_one(&mut *tx).await.unwrap();
    sqlx::raw_sql(migration).execute(&mut *tx).await.unwrap();
    let native: (Option<String>, Option<String>, String) = sqlx::query_as(
        "SELECT r.session_id_before,r.session_id_after,a.provider_thread_id FROM heartbeat_runs r JOIN heartbeat_run_attempts a ON a.run_id=r.id AND a.id=$2::uuid WHERE r.id=$1::uuid")
        .bind(&run).bind(&attempt).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(
        native,
        (None, None, observed.turn_receipt.thread_id().to_owned())
    );
    let legacy_session: String =
        sqlx::query_scalar("SELECT session_id_after FROM heartbeat_runs WHERE id=$1::uuid")
            .bind(legacy)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(legacy_session, "legacy-visible-session");
    let marker: String = sqlx::query_scalar("SELECT current_setting('rudder.native_chat_write')")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(marker, "native_chat:migration_fixture");

    sqlx::query(
        "UPDATE heartbeat_runs SET session_id_after='unbacked-native-locator' WHERE id=$1::uuid",
    )
    .bind(&run)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("SAVEPOINT before_migration")
        .execute(&mut *tx)
        .await
        .unwrap();
    let error = sqlx::raw_sql(migration)
        .execute(&mut *tx)
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().and_then(|e| e.code()).as_deref(),
        Some("23514")
    );
    sqlx::query("ROLLBACK TO SAVEPOINT before_migration")
        .execute(&mut *tx)
        .await
        .unwrap();
    let retained: String =
        sqlx::query_scalar("SELECT session_id_after FROM heartbeat_runs WHERE id=$1::uuid")
            .bind(&run)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(retained, "unbacked-native-locator");
    tx.rollback().await.unwrap();

    // Even an authorized native writer cannot put locators into public columns.
    let mut tx = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    let error = sqlx::query("UPDATE heartbeat_runs SET session_id_after=$2 WHERE id=$1::uuid")
        .bind(&run)
        .bind(observed.turn_receipt.thread_id())
        .execute(&mut *tx)
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().and_then(|e| e.code()).as_deref(),
        Some("23514")
    );
    tx.rollback().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; disposable PostgreSQL and controlled provider"]
async fn policy_insert_serializes_with_finalization_and_preserves_terminal_answer_with_hold() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run, attempt) = database_and_admission("complete").await;
    let (observed, _host) = execute_on_worker(&database, host, actor, run.clone(), attempt).await;
    let observed = observed.unwrap();
    let mut policy_tx = database.pool.begin().await.unwrap();
    sqlx::query(POLICY_SQL)
        .bind(ORG)
        .execute(&mut *policy_tx)
        .await
        .unwrap();
    let pool = database.pool.clone();
    let mut pending = tokio::spawn(async move {
        finalize(
            &pool,
            &verified_actor(),
            &observed.fence,
            &observed.turn_receipt,
            observed.cleanup_receipt.as_ref().unwrap(),
        )
        .await
    });
    // Observe a real advisory-lock waiter, not just a scheduler delay.
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        let waiters: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM pg_stat_activity WHERE wait_event='advisory'
             AND query LIKE '%rudder:native-chat:budget:%'",
        )
        .fetch_one(&database.pool)
        .await
        .unwrap();
        if waiters > 0 {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "finalizer did not wait on policy serialization"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut pending)
            .await
            .is_err()
    );
    policy_tx.commit().await.unwrap();
    let result = pending.await.unwrap().unwrap();
    assert_eq!(result["budgetDisposition"], "reconciliation_required");
    assert_eq!(result["nativeAdmissionHold"], true);
    assert_eq!(result["cost"]["status"], "unknown");
    assert!(result["assistantMessageId"].is_string());
    let persisted: (String, bool, String, bool, i64, i64) = sqlx::query_as(
        "SELECT r.status,r.native_admission_hold,g.status,g.native_admission_hold,
         (SELECT count(*) FROM chat_messages m WHERE m.run_id=r.id AND m.role='assistant'),
         (SELECT count(*) FROM cost_events c WHERE c.heartbeat_run_id=r.id)
         FROM heartbeat_runs r JOIN chat_generations g ON g.id=r.chat_generation_id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(
        persisted,
        ("succeeded".into(), true, "completed".into(), true, 1, 0)
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; disposable PostgreSQL and controlled provider"]
async fn event_and_cost_guards_cover_old_and_new_native_associations_and_allow_legacy() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run, attempt) = database_and_admission("complete").await;
    let (observed, _host) = execute_on_worker(&database, host, actor, run.clone(), attempt).await;
    let observed = observed.unwrap();
    finalize(
        &database.pool,
        &verified_actor(),
        &observed.fence,
        &observed.turn_receipt,
        observed.cleanup_receipt.as_ref().unwrap(),
    )
    .await
    .unwrap();
    let generation = observed.fence.identity().generation_id;
    let legacy: String = sqlx::query_scalar(
        "INSERT INTO heartbeat_runs(org_id,agent_id,status) VALUES ($1::uuid,$2::uuid,'succeeded') RETURNING id::text",
    ).bind(ORG).bind(CEO).fetch_one(&database.pool).await.unwrap();
    let legacy_generation: String = sqlx::query_scalar(
        "INSERT INTO chat_generations(org_id,conversation_id,status) VALUES ($1::uuid,$2::uuid,'completed') RETURNING id::text",
    ).bind(ORG).bind(CHAT).fetch_one(&database.pool).await.unwrap();

    let run_event: i64 = sqlx::query_scalar(
        "INSERT INTO heartbeat_run_events(org_id,run_id,agent_id,seq,event_type)
         VALUES($1::uuid,$2::uuid,$3::uuid,1,'status') RETURNING id",
    )
    .bind(ORG)
    .bind(&legacy)
    .bind(CEO)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_guard(
        sqlx::query("UPDATE heartbeat_run_events SET run_id=$1::uuid WHERE id=$2")
            .bind(&run)
            .bind(run_event)
            .execute(&database.pool)
            .await
            .unwrap_err(),
    );
    assert_guard(
        sqlx::query("UPDATE heartbeat_run_events SET run_id=$1::uuid WHERE run_id=$2::uuid")
            .bind(&legacy)
            .bind(&run)
            .execute(&database.pool)
            .await
            .unwrap_err(),
    );
    assert_guard(
        sqlx::query("DELETE FROM heartbeat_run_events WHERE run_id=$1::uuid")
            .bind(&run)
            .execute(&database.pool)
            .await
            .unwrap_err(),
    );
    sqlx::query("DELETE FROM heartbeat_run_events WHERE id=$1")
        .bind(run_event)
        .execute(&database.pool)
        .await
        .unwrap();

    let event: String = sqlx::query_scalar(
        "INSERT INTO chat_generation_events(org_id,generation_id,generation_seq,attempt_epoch,event_kind)
         VALUES($1::uuid,$2::uuid,1,1,'runtime_terminal') RETURNING id::text",
    ).bind(ORG).bind(&legacy_generation).fetch_one(&database.pool).await.unwrap();
    assert_guard(
        sqlx::query("UPDATE chat_generation_events SET generation_id=$1::uuid WHERE id=$2::uuid")
            .bind(generation)
            .bind(&event)
            .execute(&database.pool)
            .await
            .unwrap_err(),
    );
    assert_guard(
        sqlx::query(
            "UPDATE chat_generation_events SET generation_id=$1::uuid WHERE generation_id=$2::uuid",
        )
        .bind(&legacy_generation)
        .bind(generation)
        .execute(&database.pool)
        .await
        .unwrap_err(),
    );
    assert_guard(
        sqlx::query("DELETE FROM chat_generation_events WHERE generation_id=$1::uuid")
            .bind(generation)
            .execute(&database.pool)
            .await
            .unwrap_err(),
    );
    sqlx::query("DELETE FROM chat_generation_events WHERE id=$1::uuid")
        .bind(&event)
        .execute(&database.pool)
        .await
        .unwrap();

    let cost_sql = "INSERT INTO cost_events(org_id,agent_id,heartbeat_run_id,provider,model,cost_cents,occurred_at)
                    VALUES($1::uuid,$2::uuid,$3::uuid,'fixture','model',1,clock_timestamp()) RETURNING id::text";
    assert_guard(
        sqlx::query_scalar::<_, String>(cost_sql)
            .bind(ORG)
            .bind(CEO)
            .bind(&run)
            .fetch_one(&database.pool)
            .await
            .unwrap_err(),
    );
    let cost: String = sqlx::query_scalar(cost_sql)
        .bind(ORG)
        .bind(CEO)
        .bind(&legacy)
        .fetch_one(&database.pool)
        .await
        .unwrap();
    assert_guard(
        sqlx::query("UPDATE cost_events SET heartbeat_run_id=$1::uuid WHERE id=$2::uuid")
            .bind(&run)
            .bind(&cost)
            .execute(&database.pool)
            .await
            .unwrap_err(),
    );
    let mut tx = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE cost_events SET heartbeat_run_id=$1::uuid WHERE id=$2::uuid")
        .bind(&run)
        .bind(&cost)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_guard(
        sqlx::query("UPDATE cost_events SET heartbeat_run_id=NULL WHERE id=$1::uuid")
            .bind(&cost)
            .execute(&database.pool)
            .await
            .unwrap_err(),
    );
    assert_guard(
        sqlx::query("DELETE FROM cost_events WHERE id=$1::uuid")
            .bind(&cost)
            .execute(&database.pool)
            .await
            .unwrap_err(),
    );
    let native_result: Value =
        sqlx::query_scalar("SELECT result_json FROM heartbeat_runs WHERE id=$1::uuid")
            .bind(&run)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert_eq!(
        native_result["nativeChatFinalization"]["result"]["cost"]["status"],
        "unknown"
    );
}
