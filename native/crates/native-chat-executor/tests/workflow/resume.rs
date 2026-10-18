use crate::{fixture::*, resume_fixture::*};

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn exact_open_thread_resumes_without_replaying_history_or_rotating_segment() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run_id, attempt_id, expected_segment_id) =
        resumed_database("complete").await;
    let (result, host) =
        execute_on_worker(&database, host, actor, run_id.clone(), attempt_id).await;
    let observation = result.expect("synthetic resumed turn should be observed");
    assert_eq!(observation.turn_receipt.thread_id(), THREAD);
    assert_eq!(observation.turn_receipt.turn_id(), TURN);
    assert!(
        observation
            .cleanup_receipt
            .as_ref()
            .unwrap()
            .proves_quiescence_for(&observation.turn_receipt)
    );
    assert!(observation.cleanup_proven);

    let events = host.events();
    let resumes: Vec<&serde_json::Value> = events
        .iter()
        .filter(|event| event["received"]["method"] == "thread/resume")
        .collect();
    assert_eq!(resumes.len(), 1);
    assert_eq!(resumes[0]["received"]["params"]["threadId"], THREAD);
    assert_eq!(resumes[0]["received"]["params"]["excludeTurns"], true);
    assert!(
        !events
            .iter()
            .any(|event| event["received"]["method"] == "thread/start"),
        "a known exact Thread must resume rather than start a new Thread"
    );
    let turn_start = events
        .iter()
        .find(|event| event.get("turnStart").is_some())
        .expect("provider received one turn/start")
        .get("turnStart")
        .expect("turn/start frame");
    assert_eq!(turn_start["params"]["input"].as_array().unwrap().len(), 1);
    assert_eq!(turn_start["params"]["input"][0]["text"], RESUME_BODY);
    assert!(turn_start["params"].get("history").is_none());
    let admitted_message_id: String = sqlx::query_scalar(
        "SELECT g.source_message_id::text FROM heartbeat_runs r
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read current resumed input identity");
    assert_eq!(
        turn_start["params"]["clientUserMessageId"],
        admitted_message_id
    );

    let (
        segment_id,
        state,
        native_session_id,
        run_status,
        run_hold,
        generation_status,
        generation_hold,
    ): (String, String, Option<String>, String, bool, String, bool) = sqlx::query_as(
        "SELECT s.id::text, s.state, s.native_session_id, r.status,
                r.native_admission_hold, g.status, g.native_admission_hold
         FROM heartbeat_runs r
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         JOIN runtime_bindings b ON b.org_id=r.org_id
           AND b.id=(r.context_snapshot->>'runtimeBindingId')::uuid
         JOIN native_segments s ON s.org_id=b.org_id AND s.binding_id=b.id
           AND s.id=(r.context_snapshot->>'nativeSegmentId')::uuid
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read resumed binding, Segment, and held lifecycle state");
    assert_eq!(segment_id, expected_segment_id);
    assert_eq!(state, "open");
    assert_eq!(native_session_id.as_deref(), Some(THREAD));
    assert_eq!(run_status, "running");
    assert!(run_hold);
    assert_eq!(generation_status, "starting");
    assert!(generation_hold);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn mismatched_resumed_thread_is_rejected_before_any_turn_dispatch() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run_id, attempt_id, expected_segment_id) =
        resumed_database("mismatched-resume").await;
    let (result, host) =
        execute_on_worker(&database, host, actor, run_id.clone(), attempt_id.clone()).await;
    assert!(matches!(
        result,
        Err(ExecutorError::InvalidProviderObservation)
    ));
    let events = host.events();
    let resumes: Vec<&serde_json::Value> = events
        .iter()
        .filter(|event| event["received"]["method"] == "thread/resume")
        .collect();
    assert_eq!(resumes.len(), 1);
    assert_eq!(resumes[0]["received"]["params"]["threadId"], THREAD);
    assert_eq!(resumes[0]["received"]["params"]["excludeTurns"], true);
    assert!(
        !events
            .iter()
            .any(|event| event["received"]["method"] == "thread/start"
                || event["received"]["method"] == "turn/start"),
        "a mismatched Thread response must not create a new Thread or submit input"
    );

    let (phase, state, segment_id, native_session_id, run_hold, generation_hold): (
        String,
        String,
        String,
        Option<String>,
        bool,
        bool,
    ) = sqlx::query_as(
        "SELECT a.protocol_phase, s.state, s.id::text, s.native_session_id,
                r.native_admission_hold, g.native_admission_hold
         FROM heartbeat_runs r
         JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id AND a.id=$3::uuid
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         JOIN runtime_bindings b ON b.org_id=r.org_id
           AND b.id=(r.context_snapshot->>'runtimeBindingId')::uuid
         JOIN native_segments s ON s.org_id=b.org_id AND s.binding_id=b.id
           AND s.id=(r.context_snapshot->>'nativeSegmentId')::uuid
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .bind(&attempt_id)
    .fetch_one(&database.pool)
    .await
    .expect("read state after a mismatched Thread response");
    assert_eq!(phase, "thread_known");
    assert_eq!(state, "open");
    assert_eq!(segment_id, expected_segment_id);
    assert_eq!(native_session_id.as_deref(), Some(THREAD));
    assert!(run_hold && generation_hold);
}
