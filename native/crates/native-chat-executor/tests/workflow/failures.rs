use crate::fixture::*;
use serde_json::Value;

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn approval_request_stops_execution_without_automatic_approval() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run_id, attempt_id) = database_and_admission("approval").await;
    let (result, host) =
        execute_on_worker(&database, host, actor, run_id.clone(), attempt_id.clone()).await;
    assert!(matches!(result, Err(ExecutorError::ApprovalRequired)));
    assert!(host.provider_started());
    let events = host.events();
    assert!(
        events
            .iter()
            .any(|event| { event["sent"]["method"] == "item/commandExecution/requestApproval" })
    );
    assert!(
        !events.iter().any(|event| {
            event["received"]["id"] == "approval-request-1"
                && event["received"].get("result").is_some()
        }),
        "the executor must not automatically approve a provider request"
    );
    let (phase, run_hold, generation_hold): (String, bool, bool) = sqlx::query_as(
        "SELECT a.protocol_phase, r.native_admission_hold, g.native_admission_hold
         FROM heartbeat_runs r
         JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id AND a.id=$3::uuid
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .bind(&attempt_id)
    .fetch_one(&database.pool)
    .await
    .expect("read governed-stop state");
    assert_eq!(phase, "input_indeterminate");
    assert!(run_hold && generation_hold);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn stale_owner_is_rejected_before_provider_process_launch() {
    assert_ignored_external_dependencies();
    let database = Database::start().await;
    let host = FixtureHost::new("complete");
    let (actor, run_id, attempt_id) = admitted(&database, &host).await;
    let claimed = claim(
        &database.pool,
        &actor,
        ORG,
        &run_id,
        &attempt_id,
        host.context(),
    )
    .await
    .expect("seed an earlier owner");
    assert!(!claimed.fence.run_execution_owner_token().is_empty());
    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin stale-owner fixture");
    sqlx::query("SELECT set_config('rudder.native_chat_write', 'native_chat:execution', true)")
        .execute(&mut *tx)
        .await
        .expect("mark protected test fixture update");
    sqlx::query(
        "UPDATE heartbeat_runs SET execution_owner_token='stale-owner-replaced',
             updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .execute(&mut *tx)
    .await
    .expect("invalidate old Run owner");
    tx.commit().await.expect("commit stale owner fixture");

    let (result, host) =
        execute_on_worker(&database, host, actor, run_id.clone(), attempt_id).await;
    assert!(matches!(result, Err(ExecutorError::Persistence(_))));
    assert!(
        !host.provider_started(),
        "stale owner must not launch a helper"
    );
    let (run_hold, generation_hold): (bool, bool) = sqlx::query_as(
        "SELECT r.native_admission_hold, g.native_admission_hold
         FROM heartbeat_runs r JOIN chat_generations g
           ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read stale-owner holds");
    assert!(run_hold && generation_hold);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn helper_exit_after_turn_start_preserves_indeterminate_input_and_never_retries() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run_id, attempt_id) = database_and_admission("exit").await;
    let (first, host) =
        execute_on_worker(&database, host, actor, run_id.clone(), attempt_id.clone()).await;
    assert!(matches!(
        first,
        Err(ExecutorError::ProcessExited | ExecutorError::Transport(_))
    ));
    assert!(host.provider_started());
    let (phase, checkpoint, run_hold, generation_hold): (String, Value, bool, bool) =
        sqlx::query_as(
            "SELECT a.protocol_phase, a.checkpoint_json,
                    r.native_admission_hold, g.native_admission_hold
             FROM heartbeat_runs r
             JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id AND a.id=$3::uuid
             JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
             WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
        )
        .bind(ORG)
        .bind(&run_id)
        .bind(&attempt_id)
        .fetch_one(&database.pool)
        .await
        .expect("read uncertain dispatched-input state");
    assert_eq!(phase, "input_indeterminate");
    assert_eq!(checkpoint["phase"], "input_indeterminate");
    assert!(checkpoint["threadId"].as_str().is_some());
    assert!(checkpoint["turnId"].is_null());
    assert!(run_hold && generation_hold);

    let (retry, host) =
        execute_on_worker(&database, host, verified_actor(), run_id, attempt_id).await;
    assert!(
        retry.is_err(),
        "an uncertain provider write cannot be retried automatically"
    );
    assert_eq!(
        host.events()
            .iter()
            .filter(|event| event.get("turnStart").is_some())
            .count(),
        1,
        "retry rejection must not duplicate turn/start"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn unsupported_source_content_is_rejected_before_thread_or_provider_launch() {
    assert_ignored_external_dependencies();
    for unsupported in ["attachment", "structured", "oversized"] {
        let (database, host, actor, run_id, attempt_id) = database_and_admission("complete").await;
        let message_id: String = sqlx::query_scalar(
            "SELECT g.source_message_id::text FROM heartbeat_runs r
             JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
             WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
        )
        .bind(ORG)
        .bind(&run_id)
        .fetch_one(&database.pool)
        .await
        .expect("read admitted source message");
        match unsupported {
            "attachment" => {
                sqlx::query(
                    "INSERT INTO chat_attachments (org_id, conversation_id, message_id, asset_id)
                     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)",
                )
                .bind(ORG)
                .bind(CHAT)
                .bind(&message_id)
                .bind(support::ASSET)
                .execute(&database.pool)
                .await
                .expect("attach the seeded organization asset to source input");
            }
            "structured" => {
                let mut tx = database
                    .pool
                    .begin()
                    .await
                    .expect("begin structured fixture");
                sqlx::query(
                    "SELECT set_config('rudder.native_chat_write', 'native_chat:execution', true)",
                )
                .execute(&mut *tx)
                .await
                .expect("mark protected structured fixture update");
                sqlx::query(
                    r#"UPDATE chat_messages SET structured_payload='{"source":"unsupported"}'::jsonb
                       WHERE org_id=$1::uuid AND id=$2::uuid"#,
                )
                .bind(ORG)
                .bind(&message_id)
                .execute(&mut *tx)
                .await
                .expect("add unsupported structured source payload");
                tx.commit().await.expect("commit structured fixture");
            }
            "oversized" => {
                let mut tx = database
                    .pool
                    .begin()
                    .await
                    .expect("begin oversized fixture");
                sqlx::query(
                    "SELECT set_config('rudder.native_chat_write', 'native_chat:execution', true)",
                )
                .execute(&mut *tx)
                .await
                .expect("mark protected oversized fixture update");
                sqlx::query(
                    "UPDATE chat_messages SET body=repeat('x', 80001)
                     WHERE org_id=$1::uuid AND id=$2::uuid",
                )
                .bind(ORG)
                .bind(&message_id)
                .execute(&mut *tx)
                .await
                .expect("exceed the admitted input size bound");
                tx.commit().await.expect("commit oversized fixture");
            }
            _ => unreachable!(),
        }

        let (result, host) =
            execute_on_worker(&database, host, actor, run_id.clone(), attempt_id.clone()).await;
        assert!(
            result.is_err(),
            "unsupported {unsupported} content must be rejected"
        );
        assert!(
            !host.provider_started(),
            "unsupported {unsupported} content must fail before provider launch"
        );
        assert!(host.events().is_empty());
        let (phase, run_hold, generation_hold, provider_thread, segment_state, segment_thread): (
            String,
            bool,
            bool,
            Option<String>,
            String,
            Option<String>,
        ) = sqlx::query_as(
            "SELECT a.protocol_phase, r.native_admission_hold, g.native_admission_hold,
                    g.provider_thread_id, s.state, s.native_session_id
             FROM heartbeat_runs r
             JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id AND a.id=$3::uuid
             JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
             JOIN runtime_bindings b ON b.org_id=g.org_id AND b.id=(r.context_snapshot->>'runtimeBindingId')::uuid
             JOIN native_segments s ON s.org_id=b.org_id AND s.binding_id=b.id
                                  AND s.id=(r.context_snapshot->>'nativeSegmentId')::uuid
             WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
        )
        .bind(ORG)
        .bind(&run_id)
        .bind(&attempt_id)
        .fetch_one(&database.pool)
        .await
        .expect("read state after unsupported content rejection");
        assert_eq!(phase, "no_thread_request");
        assert!(run_hold && generation_hold);
        assert_eq!(provider_thread, None);
        assert_eq!(segment_state, "pending");
        assert_eq!(segment_thread, None);
    }
}
