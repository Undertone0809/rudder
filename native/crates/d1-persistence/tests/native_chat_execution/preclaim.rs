use super::*;
use rudder_d1_persistence::native_chat::control::{FinalizeUnclaimedStop, finalize_unclaimed_stop};
use rudder_d1_persistence::native_chat::{DispatchUnavailableRequest, record_dispatch_unavailable};

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

async fn mark_dispatch_unavailable(
    pool: &PgPool,
    actor: &VerifiedActor,
    run: &str,
    attempt: &str,
) -> Result<(), Error> {
    let generation: String = sqlx::query_scalar(
        "SELECT chat_generation_id::text FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(run)
    .fetch_one(pool)
    .await
    .unwrap();
    record_dispatch_unavailable(
        pool,
        actor,
        &DispatchUnavailableRequest {
            conversation_id: CHAT.into(),
            generation_id: generation,
            run_id: run.into(),
            attempt_id: attempt.into(),
        },
    )
    .await
}

async fn set_holds(pool: &PgPool, generation: &str, run: &str) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_preclaim',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE chat_generations SET native_admission_hold=true WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(generation)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE heartbeat_runs SET native_admission_hold=true WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(run)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

async fn insert_dispatch_marker_event(pool: &PgPool, generation: &str, run: &str, payload: Value) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_preclaim',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO chat_generation_events(org_id,generation_id,generation_seq,attempt_epoch,
            event_kind,payload,run_id)
         SELECT $1::uuid,$2::uuid,COALESCE(max(generation_seq),0)+1,1,
            'dispatch_unavailable',$3::jsonb,$4::uuid
         FROM chat_generation_events WHERE org_id=$1::uuid AND generation_id=$2::uuid",
    )
    .bind(ORG)
    .bind(generation)
    .bind(payload.to_string())
    .bind(run)
    .execute(&mut *tx)
    .await
    .unwrap();
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
    assert_eq!(retry.outcome, StopOutcome::Stopped);
    assert_eq!(retry.input_disposition.as_deref(), Some("not_submitted"));
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
async fn stopped_retry_requires_exact_terminal_receipt_and_other_action_is_already_terminal() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    let (actor, run, _) = prepare(&database, &host).await;
    let request = stop_request(&database.pool, &run).await;
    request_stop(&database.pool, &actor, &request)
        .await
        .unwrap();
    finalize_unclaimed_stop(&database.pool, &actor, &finalize_request(&request))
        .await
        .unwrap();

    let retry = request_stop(&database.pool, &actor, &request)
        .await
        .unwrap();
    assert!(retry.idempotent);
    assert_eq!(retry.outcome, StopOutcome::Stopped);

    let mut different_action = request.clone();
    different_action.control_action_id = "71000000-0000-4000-8000-000000000099".into();
    let already_terminal = request_stop(&database.pool, &actor, &different_action)
        .await
        .unwrap();
    assert!(!already_terminal.idempotent);
    assert_eq!(already_terminal.outcome, StopOutcome::AlreadyTerminal);

    // Corrupting the exact action's terminal event link must make its retry
    // fail closed; it cannot turn terminal generation state into a Stop ack.
    let mut tx = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_preclaim',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "DELETE FROM chat_generation_events WHERE org_id=$1::uuid AND generation_id=$2::uuid
           AND control_action_id=$3::uuid AND event_kind='terminal_projected'",
    )
    .bind(ORG)
    .bind(&request.generation_id)
    .bind(&request.control_action_id)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_conflict(request_stop(&database.pool, &actor, &request).await);
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

#[tokio::test(flavor = "multi_thread")]
async fn dispatch_unavailable_marker_allows_only_proven_atomic_preclaim_stop() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    let (actor, run, attempt) = prepare(&database, &host).await;
    mark_dispatch_unavailable(&database.pool, &actor, &run, &attempt)
        .await
        .unwrap();
    let held: (bool, bool) = sqlx::query_as(
        "SELECT g.native_admission_hold,r.native_admission_hold
         FROM chat_generations g JOIN heartbeat_runs r ON r.chat_generation_id=g.id
         WHERE r.id=$1::uuid",
    )
    .bind(&run)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(held, (true, true));

    // The hold prevents a claim after the definitive local dispatch failure.
    assert_conflict(claim(&database.pool, &actor, ORG, &run, &attempt, host.context()).await);

    let request = stop_request(&database.pool, &run).await;
    request_stop(&database.pool, &actor, &request)
        .await
        .unwrap();
    let final_request = finalize_request(&request);
    let receipt = finalize_unclaimed_stop(&database.pool, &actor, &final_request)
        .await
        .unwrap();
    assert!(!receipt.idempotent);
    assert_eq!(receipt.input_disposition, "not_submitted");

    let state: Value = sqlx::query_scalar(
        "SELECT jsonb_build_object('generation',g.status,'run',r.status,'attempt',a.status,
          'generationHold',g.native_admission_hold,'runHold',r.native_admission_hold,
          'phase',a.protocol_phase,'revision',a.checkpoint_json->'revision',
          'result',r.result_json,'terminalization',c.provider_evidence->'terminalization')
         FROM chat_generations g JOIN heartbeat_runs r ON r.org_id=g.org_id AND r.chat_generation_id=g.id
         JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id
         JOIN chat_control_actions c ON c.expected_generation_id=g.id
         WHERE g.id=$1::uuid AND r.id=$2::uuid AND a.id=$3::uuid",
    )
    .bind(&request.generation_id)
    .bind(&run)
    .bind(&attempt)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(state["generation"], "stopped");
    assert_eq!(state["run"], "cancelled");
    assert_eq!(state["attempt"], "cancelled");
    assert_eq!(state["generationHold"], false);
    assert_eq!(state["runHold"], false);
    assert_eq!(state["phase"], "execution_terminal_committed");
    assert_eq!(state["revision"], 1);
    assert_eq!(
        state["result"]["nativeChatPreclaimStop"]["inputDisposition"],
        "not_submitted"
    );
    let marker: Value = sqlx::query_scalar(
        "SELECT jsonb_build_object('generationCount',(SELECT count(*) FROM chat_generation_events
            WHERE generation_id=$1::uuid AND event_kind='dispatch_unavailable'),
          'runCount',(SELECT count(*) FROM heartbeat_run_events
            WHERE run_id=$2::uuid AND event_type='runtime.native_chat_dispatch_unavailable'),
          'activityCount',(SELECT count(*) FROM activity_log WHERE action='chat.native_dispatch_unavailable'
            AND details->>'generationId'=$1 AND details->>'runId'=$2),
          'activityDetails',(SELECT details FROM activity_log WHERE action='chat.native_dispatch_unavailable'
            AND details->>'generationId'=$1 AND details->>'runId'=$2),
          'proof',c.provider_evidence->'terminalization'->'dispatchUnavailable')
         FROM chat_control_actions c WHERE c.id=$3::uuid",
    )
    .bind(&request.generation_id)
    .bind(&run)
    .bind(&request.control_action_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(marker["generationCount"], 1);
    assert_eq!(marker["runCount"], 1);
    assert_eq!(marker["activityCount"], 1);
    assert_eq!(marker["activityDetails"]["producer"], "native_rust");
    assert!(
        marker["activityDetails"]
            .get("executionAuthority")
            .is_none()
    );
    assert!(marker["proof"]["generationEventSeq"].as_i64().is_some());
    assert!(marker["proof"]["generationEventId"].as_str().is_some());
    assert!(marker["proof"]["runEventId"].as_i64().is_some());
    assert!(marker["proof"]["runEventSeq"].as_i64().is_some());
    assert!(marker["proof"]["activityLogId"].as_str().is_some());

    let retry = finalize_unclaimed_stop(&database.pool, &actor, &final_request)
        .await
        .unwrap();
    assert!(retry.idempotent);
    assert_eq!(retry.run_id, run);
    let next_run = send(&database, &actor, &host, "after-dispatch-unavailable-stop").await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    assert_ne!(next_run, run);

    // A second failed Turn in the same conversation has its own marker set.
    // Retrying the first Stop must remain bound to its own Generation/Run, and
    // the second Stop must not count the first Turn's activity row.
    let next_attempt: String = sqlx::query_scalar(
        "SELECT id::text FROM heartbeat_run_attempts WHERE org_id=$1::uuid AND run_id=$2::uuid",
    )
    .bind(ORG)
    .bind(&next_run)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    mark_dispatch_unavailable(&database.pool, &actor, &next_run, &next_attempt)
        .await
        .unwrap();
    let mut next_stop = stop_request(&database.pool, &next_run).await;
    next_stop.control_action_id = "71000000-0000-4000-8000-000000000004".into();
    request_stop(&database.pool, &actor, &next_stop)
        .await
        .unwrap();
    let next_final_request = finalize_request(&next_stop);
    let next_receipt = finalize_unclaimed_stop(&database.pool, &actor, &next_final_request)
        .await
        .unwrap();
    assert!(!next_receipt.idempotent);
    assert!(
        finalize_unclaimed_stop(&database.pool, &actor, &final_request)
            .await
            .unwrap()
            .idempotent
    );
    assert!(
        finalize_unclaimed_stop(&database.pool, &actor, &next_final_request)
            .await
            .unwrap()
            .idempotent
    );

    let state_before_tamper: Value = sqlx::query_scalar(
        "SELECT jsonb_build_object('run',to_jsonb(r),'attempt',to_jsonb(a),
          'generation',to_jsonb(g),'action',to_jsonb(c))
         FROM heartbeat_runs r JOIN heartbeat_run_attempts a ON a.run_id=r.id
         JOIN chat_generations g ON g.id=r.chat_generation_id
         JOIN chat_control_actions c ON c.expected_generation_id=g.id WHERE r.id=$1::uuid",
    )
    .bind(&run)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    insert_dispatch_marker_event(
        &database.pool,
        &request.generation_id,
        &run,
        json!({"code":"tampered_after_terminalization"}),
    )
    .await;
    assert_conflict(finalize_unclaimed_stop(&database.pool, &actor, &final_request).await);
    let state_after_tamper: Value = sqlx::query_scalar(
        "SELECT jsonb_build_object('run',to_jsonb(r),'attempt',to_jsonb(a),
          'generation',to_jsonb(g),'action',to_jsonb(c))
         FROM heartbeat_runs r JOIN heartbeat_run_attempts a ON a.run_id=r.id
         JOIN chat_generations g ON g.id=r.chat_generation_id
         JOIN chat_control_actions c ON c.expected_generation_id=g.id WHERE r.id=$1::uuid",
    )
    .bind(&run)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(state_before_tamper, state_after_tamper);
}

#[tokio::test(flavor = "multi_thread")]
async fn dispatch_unavailable_stop_rejects_bare_holds_partial_and_mismatched_markers() {
    for kind in ["bare-holds", "partial-malformed", "duplicate-marker"] {
        let database = Database::start().await;
        let host = ExecutionHost::new();
        let (actor, run, attempt) = prepare(&database, &host).await;
        let request = stop_request(&database.pool, &run).await;
        match kind {
            "bare-holds" => {
                set_holds(&database.pool, &request.generation_id, &run).await;
            }
            "partial-malformed" => {
                set_holds(&database.pool, &request.generation_id, &run).await;
                insert_dispatch_marker_event(
                    &database.pool,
                    &request.generation_id,
                    &run,
                    json!({"code":"different_failure"}),
                )
                .await;
            }
            "duplicate-marker" => {
                mark_dispatch_unavailable(&database.pool, &actor, &run, &attempt)
                    .await
                    .unwrap();
                insert_dispatch_marker_event(
                    &database.pool,
                    &request.generation_id,
                    &run,
                    json!({"code":"different_failure"}),
                )
                .await;
            }
            _ => unreachable!(),
        }
        request_stop(&database.pool, &actor, &request)
            .await
            .unwrap();
        let before: Value = sqlx::query_scalar(
            "SELECT jsonb_build_object('run',to_jsonb(r),'attempt',to_jsonb(a),
              'generation',to_jsonb(g),'action',to_jsonb(c))
             FROM heartbeat_runs r JOIN heartbeat_run_attempts a ON a.run_id=r.id
             JOIN chat_generations g ON g.id=r.chat_generation_id
             JOIN chat_control_actions c ON c.expected_generation_id=g.id WHERE r.id=$1::uuid",
        )
        .bind(&run)
        .fetch_one(&database.pool)
        .await
        .unwrap();
        let before_counts = counts(&database.pool, &request.generation_id).await;
        assert_conflict(
            finalize_unclaimed_stop(&database.pool, &actor, &finalize_request(&request)).await,
        );
        let after: Value = sqlx::query_scalar(
            "SELECT jsonb_build_object('run',to_jsonb(r),'attempt',to_jsonb(a),
              'generation',to_jsonb(g),'action',to_jsonb(c))
             FROM heartbeat_runs r JOIN heartbeat_run_attempts a ON a.run_id=r.id
             JOIN chat_generations g ON g.id=r.chat_generation_id
             JOIN chat_control_actions c ON c.expected_generation_id=g.id WHERE r.id=$1::uuid",
        )
        .bind(&run)
        .fetch_one(&database.pool)
        .await
        .unwrap();
        assert_eq!(
            before, after,
            "failed dispatch recovery wrote rows for {kind}"
        );
        assert_eq!(
            before_counts,
            counts(&database.pool, &request.generation_id).await
        );
        let holds: (bool, bool) = sqlx::query_as(
            "SELECT g.native_admission_hold,r.native_admission_hold
             FROM chat_generations g JOIN heartbeat_runs r ON r.chat_generation_id=g.id
             WHERE r.id=$1::uuid",
        )
        .bind(&run)
        .fetch_one(&database.pool)
        .await
        .unwrap();
        assert_eq!(
            holds,
            (true, true),
            "failed branch released holds for {kind}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn dispatch_unavailable_stop_rolls_back_hold_release_when_audit_fails() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    let (actor, run, attempt) = prepare(&database, &host).await;
    mark_dispatch_unavailable(&database.pool, &actor, &run, &attempt)
        .await
        .unwrap();
    let request = stop_request(&database.pool, &run).await;
    request_stop(&database.pool, &actor, &request)
        .await
        .unwrap();
    let before: Value = sqlx::query_scalar(
        "SELECT jsonb_build_object('run',to_jsonb(r),'attempt',to_jsonb(a),
          'generation',to_jsonb(g),'action',to_jsonb(c))
         FROM heartbeat_runs r JOIN heartbeat_run_attempts a ON a.run_id=r.id
         JOIN chat_generations g ON g.id=r.chat_generation_id
         JOIN chat_control_actions c ON c.expected_generation_id=g.id WHERE r.id=$1::uuid",
    )
    .bind(&run)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    sqlx::raw_sql(
        "CREATE FUNCTION test_dispatch_preclaim_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.action='runtime.native_chat.stopped_before_claim' THEN RAISE EXCEPTION 'injected audit failure'; END IF;
          RETURN NEW; END $$;
          CREATE TRIGGER test_dispatch_preclaim_audit_failure BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION test_dispatch_preclaim_audit_failure();",
    )
    .execute(&database.pool)
    .await
    .unwrap();
    assert!(
        finalize_unclaimed_stop(&database.pool, &actor, &finalize_request(&request))
            .await
            .is_err()
    );
    let after: Value = sqlx::query_scalar(
        "SELECT jsonb_build_object('run',to_jsonb(r),'attempt',to_jsonb(a),
          'generation',to_jsonb(g),'action',to_jsonb(c))
         FROM heartbeat_runs r JOIN heartbeat_run_attempts a ON a.run_id=r.id
         JOIN chat_generations g ON g.id=r.chat_generation_id
         JOIN chat_control_actions c ON c.expected_generation_id=g.id WHERE r.id=$1::uuid",
    )
    .bind(&run)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(before, after);
    sqlx::query("DROP TRIGGER test_dispatch_preclaim_audit_failure ON activity_log")
        .execute(&database.pool)
        .await
        .unwrap();
    let receipt = finalize_unclaimed_stop(&database.pool, &actor, &finalize_request(&request))
        .await
        .unwrap();
    assert!(!receipt.idempotent);
    let holds: (bool, bool) = sqlx::query_as(
        "SELECT g.native_admission_hold,r.native_admission_hold
         FROM chat_generations g JOIN heartbeat_runs r ON r.chat_generation_id=g.id
         WHERE r.id=$1::uuid",
    )
    .bind(&run)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(holds, (false, false));
}

#[tokio::test(flavor = "multi_thread")]
async fn dispatch_unavailable_marker_and_claim_serialize_in_both_lock_orders() {
    for marker_first in [true, false] {
        let database = Database::start().await;
        let host = ExecutionHost::new();
        let (actor, run, attempt) = prepare(&database, &host).await;
        let mut lock = database.pool.begin().await.unwrap();
        sqlx::query("SELECT id FROM chat_conversations WHERE id=$1::uuid FOR UPDATE")
            .bind(CHAT)
            .fetch_one(&mut *lock)
            .await
            .unwrap();
        let (marker_task, claim_task) = if marker_first {
            let pool = database.pool.clone();
            let marker_actor = actor.clone();
            let marker_run = run.clone();
            let marker_attempt = attempt.clone();
            let marker = tokio::spawn(async move {
                mark_dispatch_unavailable(&pool, &marker_actor, &marker_run, &marker_attempt).await
            });
            wait_for_lock_wait(&database.pool, "chat_conversations").await;
            let pool = database.pool.clone();
            let claim_actor = actor.clone();
            let claim_run = run.clone();
            let claim_attempt = attempt.clone();
            let claim_host = host;
            let claim_task = tokio::spawn(async move {
                claim(
                    &pool,
                    &claim_actor,
                    ORG,
                    &claim_run,
                    &claim_attempt,
                    claim_host.context(),
                )
                .await
            });
            (marker, claim_task)
        } else {
            let pool = database.pool.clone();
            let claim_actor = actor.clone();
            let claim_run = run.clone();
            let claim_attempt = attempt.clone();
            let claim_host = host;
            let claim_task = tokio::spawn(async move {
                claim(
                    &pool,
                    &claim_actor,
                    ORG,
                    &claim_run,
                    &claim_attempt,
                    claim_host.context(),
                )
                .await
            });
            wait_for_lock_wait(&database.pool, "chat_conversations").await;
            let pool = database.pool.clone();
            let marker_actor = actor.clone();
            let marker_run = run.clone();
            let marker_attempt = attempt.clone();
            let marker = tokio::spawn(async move {
                mark_dispatch_unavailable(&pool, &marker_actor, &marker_run, &marker_attempt).await
            });
            (marker, claim_task)
        };
        lock.commit().await.unwrap();
        let marker_result = marker_task.await.unwrap();
        let claim_result = claim_task.await.unwrap();
        if marker_first {
            marker_result.unwrap();
            assert_conflict(claim_result);
            let holds: (bool, bool) = sqlx::query_as(
                "SELECT g.native_admission_hold,r.native_admission_hold
                 FROM chat_generations g JOIN heartbeat_runs r ON r.chat_generation_id=g.id
                 WHERE r.id=$1::uuid",
            )
            .bind(&run)
            .fetch_one(&database.pool)
            .await
            .unwrap();
            assert_eq!(holds, (true, true));
        } else {
            assert_conflict(marker_result);
            assert!(claim_result.is_ok());
            let markers: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM chat_generation_events
                 WHERE generation_id=(SELECT chat_generation_id FROM heartbeat_runs WHERE id=$1::uuid)
                   AND event_kind='dispatch_unavailable'",
            )
            .bind(&run)
            .fetch_one(&database.pool)
            .await
            .unwrap();
            assert_eq!(markers, 0);
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn dispatch_unavailable_marker_serializes_with_stop() {
    for marker_first in [true, false] {
        let database = Database::start().await;
        let (actor, run, attempt) = prepare(&database, &ExecutionHost::new()).await;
        let request = stop_request(&database.pool, &run).await;
        let mut lock = database.pool.begin().await.unwrap();
        sqlx::query("SELECT id FROM chat_conversations WHERE id=$1::uuid FOR UPDATE")
            .bind(CHAT)
            .fetch_one(&mut *lock)
            .await
            .unwrap();
        let (marker_task, stop_task) = if marker_first {
            let pool = database.pool.clone();
            let actor_for_marker = actor.clone();
            let run_for_marker = run.clone();
            let attempt_for_marker = attempt.clone();
            let marker = tokio::spawn(async move {
                mark_dispatch_unavailable(
                    &pool,
                    &actor_for_marker,
                    &run_for_marker,
                    &attempt_for_marker,
                )
                .await
            });
            wait_for_lock_wait(&database.pool, "chat_conversations").await;
            let pool = database.pool.clone();
            let actor_for_stop = actor.clone();
            let request_for_stop = request.clone();
            let stop = tokio::spawn(async move {
                request_stop(&pool, &actor_for_stop, &request_for_stop).await
            });
            (marker, stop)
        } else {
            let pool = database.pool.clone();
            let actor_for_stop = actor.clone();
            let request_for_stop = request.clone();
            let stop = tokio::spawn(async move {
                request_stop(&pool, &actor_for_stop, &request_for_stop).await
            });
            wait_for_lock_wait(&database.pool, "chat_conversations").await;
            let pool = database.pool.clone();
            let actor_for_marker = actor.clone();
            let run_for_marker = run.clone();
            let attempt_for_marker = attempt.clone();
            let marker = tokio::spawn(async move {
                mark_dispatch_unavailable(
                    &pool,
                    &actor_for_marker,
                    &run_for_marker,
                    &attempt_for_marker,
                )
                .await
            });
            (marker, stop)
        };
        lock.commit().await.unwrap();
        let marker_result = marker_task.await.unwrap();
        stop_task.await.unwrap().unwrap();
        if marker_first {
            marker_result.unwrap();
        } else {
            assert_conflict(marker_result);
        }
        finalize_unclaimed_stop(&database.pool, &actor, &finalize_request(&request))
            .await
            .unwrap();
    }
}
