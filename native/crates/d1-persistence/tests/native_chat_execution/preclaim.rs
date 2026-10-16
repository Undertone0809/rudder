use super::*;
use rudder_d1_persistence::native_chat::control::{FinalizeUnclaimedStop, finalize_unclaimed_stop};

fn finalize_request(request: &StopRequest) -> FinalizeUnclaimedStop {
    FinalizeUnclaimedStop {
        conversation_id: request.conversation_id.clone(),
        generation_id: request.generation_id.clone(),
        control_action_id: request.control_action_id.clone(),
    }
}

async fn mutate(pool: &PgPool, sql: &str, run: &str) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_preclaim',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(sql).bind(run).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
}

async fn send(
    database: &Database,
    actor: &VerifiedActor,
    host: &ExecutionHost,
    mutation: &str,
) -> Value {
    let request: AdmissionRequest =
        serde_json::from_value(json!({"operation":"submit_native_chat_turn",
        "conversationId":CHAT,"clientMutationId":mutation,"body":if mutation == "native-execution-1" { "begin a durable native execution" } else { "new explicit input" }}))
        .unwrap();
    execute(&database.pool, actor, ORG, &request, host.context())
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn preclaim_fresh_stop_is_atomic_idempotent_and_accepts_expired_admission_lease() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    let (actor, run, attempt) = prepare(&database, &host).await;
    let request = stop_request(&database.pool, &run).await;
    request_stop(&database.pool, &actor, &request)
        .await
        .unwrap();
    mutate(&database.pool,"UPDATE heartbeat_runs SET execution_lease_expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1::uuid",&run).await;
    let final_request = finalize_request(&request);
    let (a, b) = tokio::join!(
        finalize_unclaimed_stop(&database.pool, &actor, &final_request),
        finalize_unclaimed_stop(&database.pool, &actor, &final_request)
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_ne!(a.idempotent, b.idempotent);
    assert_eq!(a.input_disposition, "not_submitted");
    assert_eq!(a.attempt_id, attempt);
    assert_eq!(counts(&database.pool, &request.generation_id).await, (1, 5));
    let states: Value = sqlx::query_scalar("SELECT jsonb_build_object('run',r.status,'attempt',a.status,
      'generation',g.status,'phase',a.protocol_phase,'revision',a.checkpoint_json->'revision',
      'hold',r.native_admission_hold OR g.native_admission_hold,'leaseCleared',r.execution_lease_expires_at IS NULL,
      'processAbsent',r.process_pid IS NULL AND r.process_started_at IS NULL AND r.process_exited_at IS NULL,
      'usageAbsent',r.usage_json IS NULL AND a.usage_delta_json IS NULL AND a.cost_cents IS NULL)
      FROM heartbeat_runs r JOIN heartbeat_run_attempts a ON a.run_id=r.id JOIN chat_generations g ON g.id=r.chat_generation_id
      WHERE r.id=$1::uuid").bind(&run).fetch_one(&database.pool).await.unwrap();
    assert_eq!(
        states,
        json!({"run":"cancelled","attempt":"cancelled","generation":"stopped",
        "phase":"execution_terminal_committed","revision":1,"hold":false,"leaseCleared":true,"processAbsent":true,"usageAbsent":true})
    );
    let empty: (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT
      (SELECT count(*) FROM chat_messages WHERE run_id=$1::uuid AND role='assistant'),
      (SELECT count(*) FROM run_runtime_spans WHERE run_id=$1::uuid),
      (SELECT count(*) FROM cost_events WHERE heartbeat_run_id=$1::uuid),
      (SELECT count(*) FROM activity_log WHERE action='runtime.native_chat.stopped_before_claim')",
    )
    .bind(&run)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(empty, (0, 0, 0, 1));
    let retry = request_stop(&database.pool, &actor, &request)
        .await
        .unwrap();
    assert!(retry.idempotent);
    assert_eq!(retry.outcome, StopOutcome::StopIntentRecorded);
    assert_conflict(claim(&database.pool, &actor, ORG, &run, &attempt, host.context()).await);
    let page = read_events(
        &database.pool,
        &actor,
        &ReadEvents {
            conversation_id: CHAT.into(),
            generation_id: request.generation_id.clone(),
            after_seq: 3,
            limit: 100,
            max_bytes: 4096,
        },
    )
    .await
    .unwrap();
    assert_eq!(page.events.len(), 2);
    for event in page.events {
        assert_eq!(
            event.payload,
            json!({"status":"cancelled","inputDisposition":"not_submitted"})
        );
    }
    let next = send(&database, &actor, &host, "after-preclaim-stop").await;
    assert_ne!(next["runId"], run);
    assert!(
        finalize_unclaimed_stop(&database.pool, &actor, &final_request)
            .await
            .unwrap()
            .idempotent
    );
    assert_eq!(
        send(&database, &actor, &host, "native-execution-1").await["runId"],
        run
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn preclaim_resume_stop_preserves_exact_thread_and_next_send_uses_it() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    let (actor, first, _) = prepare(&database, &host).await;
    let first_stop = stop_request(&database.pool, &first).await;
    request_stop(&database.pool, &actor, &first_stop)
        .await
        .unwrap();
    finalize_unclaimed_stop(&database.pool, &actor, &finalize_request(&first_stop))
        .await
        .unwrap();
    // An earlier provider Thread, independently established before this new
    // admission. The cancelled Run itself never creates or opens a Thread.
    sqlx::query(
        "UPDATE native_segments SET state='open',native_session_id=$1 WHERE org_id=$2::uuid",
    )
    .bind(OPAQUE_THREAD)
    .bind(ORG)
    .execute(&database.pool)
    .await
    .unwrap();
    let resumed = send(&database, &actor, &host, "preclaim-resumed").await;
    let run = resumed["runId"].as_str().unwrap();
    let before: Value =
        sqlx::query_scalar("SELECT to_jsonb(s) FROM native_segments s WHERE org_id=$1::uuid")
            .bind(ORG)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    let mut request = stop_request(&database.pool, run).await;
    request.control_action_id = "71000000-0000-4000-8000-000000000003".into();
    request_stop(&database.pool, &actor, &request)
        .await
        .unwrap();
    finalize_unclaimed_stop(&database.pool, &actor, &finalize_request(&request))
        .await
        .unwrap();
    let after: Value =
        sqlx::query_scalar("SELECT to_jsonb(s) FROM native_segments s WHERE org_id=$1::uuid")
            .bind(ORG)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert_eq!(before, after);
    let checkpoint: Value = sqlx::query_scalar(
        "SELECT checkpoint_json FROM heartbeat_run_attempts WHERE run_id=$1::uuid",
    )
    .bind(run)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(checkpoint["threadId"], OPAQUE_THREAD);
    assert_eq!(checkpoint["turnId"], Value::Null);
    let next = send(&database, &actor, &host, "after-preclaim-resume").await;
    let next_session: Value =
        sqlx::query_scalar("SELECT session_intent_json FROM heartbeat_runs WHERE id=$1::uuid")
            .bind(next["runId"].as_str().unwrap())
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert_eq!(next_session["sessionId"], OPAQUE_THREAD);
    assert_eq!(next_session["kind"], "resume");
}

#[tokio::test(flavor = "multi_thread")]
async fn preclaim_stop_rejects_changed_identity_or_any_execution_evidence_without_writes() {
    let cases = [
        "UPDATE heartbeat_runs SET execution_owner_token='changed-owner' WHERE id=$1::uuid",
        "UPDATE heartbeat_run_attempts SET connection_epoch=2 WHERE run_id=$1::uuid",
        "UPDATE heartbeat_run_attempts SET id=gen_random_uuid() WHERE run_id=$1::uuid",
        "UPDATE heartbeat_runs SET process_pid=123 WHERE id=$1::uuid",
        "UPDATE heartbeat_runs SET usage_json='{}'::jsonb WHERE id=$1::uuid",
        "UPDATE heartbeat_run_attempts SET cost_cents=0 WHERE run_id=$1::uuid",
        "UPDATE heartbeat_runs SET context_snapshot=context_snapshot || '{\"inputFingerprint\":\"changed\"}'::jsonb WHERE id=$1::uuid",
        "UPDATE heartbeat_run_attempts SET protocol_phase='thread_start_indeterminate',checkpoint_json=jsonb_set(jsonb_set(checkpoint_json,'{phase}','\"thread_start_indeterminate\"'::jsonb),'{revision}','1'::jsonb) WHERE run_id=$1::uuid",
        "INSERT INTO heartbeat_run_attempts(org_id,run_id,agent_id,attempt_index,runtime_type,owner_token,attempt_epoch,generation_attempt_epoch,connection_epoch,protocol_phase,checkpoint_json) SELECT org_id,run_id,agent_id,2,runtime_type,owner_token,2,generation_attempt_epoch,2,protocol_phase,checkpoint_json FROM heartbeat_run_attempts WHERE run_id=$1::uuid AND attempt_index=1",
    ];
    for sql in cases {
        let database = Database::start().await;
        let host = ExecutionHost::new();
        let (actor, run, _) = prepare(&database, &host).await;
        let request = stop_request(&database.pool, &run).await;
        request_stop(&database.pool, &actor, &request)
            .await
            .unwrap();
        mutate(&database.pool, sql, &run).await;
        assert_conflict(
            finalize_unclaimed_stop(&database.pool, &actor, &finalize_request(&request)).await,
        );
        assert_eq!(counts(&database.pool, &request.generation_id).await, (1, 3));
        let status: String =
            sqlx::query_scalar("SELECT status FROM heartbeat_runs WHERE id=$1::uuid")
                .bind(&run)
                .fetch_one(&database.pool)
                .await
                .unwrap();
        assert_eq!(status, "running");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn preclaim_stop_rejects_unpinned_receipt_and_nonzero_cutoff() {
    for cutoff in [0, 2] {
        let database = Database::start().await;
        let host = ExecutionHost::new();
        let (actor, run, _) = prepare(&database, &host).await;
        let mut request = stop_request(&database.pool, &run).await;
        request.requested_render_seq = cutoff;
        if cutoff > 0 {
            seed_text(&database.pool, &request, &run).await;
            request.requested_body_hash = hash("a");
        }
        request_stop(&database.pool, &actor, &request)
            .await
            .unwrap();
        if cutoff == 0 {
            sqlx::query("UPDATE chat_control_actions SET provider_evidence=provider_evidence-'executionPin' WHERE id=$1::uuid")
                .bind(&request.control_action_id).execute(&database.pool).await.unwrap();
        }
        assert_conflict(
            finalize_unclaimed_stop(&database.pool, &actor, &finalize_request(&request)).await,
        );
        assert_eq!(
            counts(&database.pool, &request.generation_id).await,
            (1, if cutoff == 0 { 3 } else { 5 })
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn preclaim_stop_and_claim_serialize_in_both_lock_orders() {
    for stop_first in [true, false] {
        let database = Database::start().await;
        let host = ExecutionHost::new();
        let (actor, run, attempt) = prepare(&database, &host).await;
        let request = stop_request(&database.pool, &run).await;
        let mut lock = database.pool.begin().await.unwrap();
        sqlx::query("SELECT id FROM chat_conversations WHERE id=$1::uuid FOR UPDATE")
            .bind(CHAT)
            .fetch_one(&mut *lock)
            .await
            .unwrap();
        let pool = database.pool.clone();
        let a = actor.clone();
        let r = request.clone();
        let stop = async move { request_stop(&pool, &a, &r).await };
        let pool = database.pool.clone();
        let a = actor.clone();
        let claim_task = async move { claim(&pool, &a, ORG, &run, &attempt, host.context()).await };
        let (stop_task, claim_task) = if stop_first {
            let s = tokio::spawn(stop);
            wait_for_lock_wait(&database.pool, "chat_conversations").await;
            (s, tokio::spawn(claim_task))
        } else {
            let c = tokio::spawn(claim_task);
            wait_for_lock_wait(&database.pool, "chat_conversations").await;
            (tokio::spawn(stop), c)
        };
        lock.commit().await.unwrap();
        stop_task.await.unwrap().unwrap();
        let claimed = claim_task.await.unwrap();
        let finalized =
            finalize_unclaimed_stop(&database.pool, &actor, &finalize_request(&request)).await;
        if stop_first {
            assert_conflict(claimed);
            assert!(finalized.is_ok());
        } else {
            assert!(claimed.is_ok());
            assert_conflict(finalized);
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn preclaim_stop_reauthorizes_after_wait_and_on_terminal_retry() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    let (actor, run, _) = prepare(&database, &host).await;
    let request = stop_request(&database.pool, &run).await;
    request_stop(&database.pool, &actor, &request)
        .await
        .unwrap();
    let final_request = finalize_request(&request);
    let foreign = verified_actor(OTHER, USER, "foreign-preclaim");
    assert!(matches!(
        finalize_unclaimed_stop(&database.pool, &foreign, &final_request).await,
        Err(Error::Http(403 | 404, _))
    ));
    let mut lock = database.pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM chat_conversations WHERE id=$1::uuid FOR UPDATE")
        .bind(CHAT)
        .fetch_one(&mut *lock)
        .await
        .unwrap();
    let pool = database.pool.clone();
    let a = actor.clone();
    let f = final_request.clone();
    let task = tokio::spawn(async move { finalize_unclaimed_stop(&pool, &a, &f).await });
    wait_for_lock_wait(&database.pool, "chat_conversations").await;
    sqlx::query("UPDATE organization_memberships SET status='inactive' WHERE org_id=$1::uuid AND principal_id=$2")
        .bind(ORG).bind(USER).execute(&database.pool).await.unwrap();
    lock.commit().await.unwrap();
    assert!(matches!(task.await.unwrap(), Err(Error::Http(403, _))));
    assert_eq!(counts(&database.pool, &request.generation_id).await, (1, 3));
    sqlx::query("UPDATE organization_memberships SET status='active' WHERE org_id=$1::uuid AND principal_id=$2")
        .bind(ORG).bind(USER).execute(&database.pool).await.unwrap();
    finalize_unclaimed_stop(&database.pool, &actor, &final_request)
        .await
        .unwrap();
    sqlx::query("UPDATE organization_memberships SET status='inactive' WHERE org_id=$1::uuid AND principal_id=$2")
        .bind(ORG).bind(USER).execute(&database.pool).await.unwrap();
    assert!(matches!(
        finalize_unclaimed_stop(&database.pool, &actor, &final_request).await,
        Err(Error::Http(403, _))
    ));
    assert_eq!(counts(&database.pool, &request.generation_id).await, (1, 5));
}

#[tokio::test(flavor = "multi_thread")]
async fn preclaim_stop_rolls_back_all_terminal_writes_on_audit_failure() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    let (actor, run, _) = prepare(&database, &host).await;
    let request = stop_request(&database.pool, &run).await;
    request_stop(&database.pool, &actor, &request)
        .await
        .unwrap();
    let before: Value = sqlx::query_scalar("SELECT jsonb_build_object('run',to_jsonb(r),'attempt',to_jsonb(a),'generation',to_jsonb(g),'action',to_jsonb(c))
      FROM heartbeat_runs r JOIN heartbeat_run_attempts a ON a.run_id=r.id
      JOIN chat_generations g ON g.id=r.chat_generation_id
      JOIN chat_control_actions c ON c.expected_generation_id=g.id WHERE r.id=$1::uuid")
        .bind(&run).fetch_one(&database.pool).await.unwrap();
    sqlx::raw_sql("CREATE FUNCTION test_preclaim_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='runtime.native_chat.stopped_before_claim' THEN RAISE EXCEPTION 'injected audit failure'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER test_preclaim_audit_failure BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION test_preclaim_audit_failure();")
        .execute(&database.pool).await.unwrap();
    assert!(
        finalize_unclaimed_stop(&database.pool, &actor, &finalize_request(&request))
            .await
            .is_err()
    );
    let after: Value = sqlx::query_scalar("SELECT jsonb_build_object('run',to_jsonb(r),'attempt',to_jsonb(a),'generation',to_jsonb(g),'action',to_jsonb(c))
      FROM heartbeat_runs r JOIN heartbeat_run_attempts a ON a.run_id=r.id
      JOIN chat_generations g ON g.id=r.chat_generation_id
      JOIN chat_control_actions c ON c.expected_generation_id=g.id WHERE r.id=$1::uuid")
        .bind(&run).fetch_one(&database.pool).await.unwrap();
    assert_eq!(before, after);
    assert_eq!(counts(&database.pool, &request.generation_id).await, (1, 3));
    sqlx::query("DROP TRIGGER test_preclaim_audit_failure ON activity_log")
        .execute(&database.pool)
        .await
        .unwrap();
    assert!(
        !finalize_unclaimed_stop(&database.pool, &actor, &finalize_request(&request))
            .await
            .unwrap()
            .idempotent
    );
}
