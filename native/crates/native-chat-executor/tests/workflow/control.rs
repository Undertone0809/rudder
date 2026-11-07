use crate::fixture::*;
use rudder_d1_persistence::native_chat::{
    Error,
    control::{StopOutcome, StopRequest, request_stop},
    execution::finalize,
};
use std::time::Duration;

async fn wait_for_advisory_waiters(pool: &sqlx::PgPool, count: i64) {
    for _ in 0..300 {
        let waiting:i64=sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'")
            .fetch_one(pool).await.unwrap();
        if waiting >= count {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("owned fixture did not reach {count} advisory waiters");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; disposable PostgreSQL and synthetic local provider only"]
async fn durable_stop_and_real_terminal_finalizer_serialize_in_both_lock_orders() {
    assert_ignored_external_dependencies();
    for terminal_first in [true, false] {
        let (database, host, actor, run, attempt) = database_and_admission("complete").await;
        let (observed, host) =
            execute_on_worker(&database, host, actor.clone(), run.clone(), attempt.clone()).await;
        let observed = observed.unwrap();
        assert!(host.provider_started());
        let generation = observed.fence.identity().generation_id.to_owned();
        let streamed_message: String = sqlx::query_scalar(
            "SELECT id::text FROM chat_messages WHERE run_id=$1::uuid AND role='assistant'",
        )
        .bind(&run)
        .fetch_one(&database.pool)
        .await
        .unwrap();
        let request = StopRequest {
            conversation_id: CHAT.into(),
            generation_id: generation.clone(),
            control_action_id: "71000000-0000-4000-8000-000000000001".into(),
            expected_attempt_epoch: 1,
            expected_control_version: 0,
            requested_render_seq: 0,
            requested_body_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
                .into(),
        };
        let mut blocker = database.pool.begin().await.unwrap();
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
            .bind(format!(
                "runtime-binding:target:chat_conversation:{ORG}:{CHAT}"
            ))
            .execute(&mut *blocker)
            .await
            .unwrap();
        let (terminal_tx, terminal_rx) = tokio::sync::oneshot::channel::<()>();
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
        let final_pool = database.pool.clone();
        let final_actor = actor.clone();
        let final_task = tokio::spawn(async move {
            terminal_rx.await.unwrap();
            let result = finalize(
                &final_pool,
                &final_actor,
                &observed.fence,
                &observed.turn_receipt,
                observed.cleanup_receipt.as_ref().unwrap(),
            )
            .await;
            (result, observed)
        });
        let stop_pool = database.pool.clone();
        let stop_actor = actor.clone();
        let stop_request = request.clone();
        let stop_task = tokio::spawn(async move {
            stop_rx.await.unwrap();
            request_stop(&stop_pool, &stop_actor, &stop_request).await
        });
        if terminal_first {
            terminal_tx.send(()).unwrap();
            wait_for_advisory_waiters(&database.pool, 1).await;
            stop_tx.send(()).unwrap();
        } else {
            stop_tx.send(()).unwrap();
            wait_for_advisory_waiters(&database.pool, 1).await;
            terminal_tx.send(()).unwrap();
        }
        wait_for_advisory_waiters(&database.pool, 2).await;
        blocker.commit().await.unwrap();
        let (final_result, observed) = final_task.await.unwrap();
        let stop_result = stop_task.await.unwrap().unwrap();
        let (status, hold, messages): (String, bool, i64) = sqlx::query_as(
            "SELECT g.status,g.native_admission_hold,
             (SELECT count(*) FROM chat_messages WHERE run_id=$2::uuid AND role='assistant')
             FROM chat_generations g WHERE g.id=$1::uuid",
        )
        .bind(&generation)
        .bind(&run)
        .fetch_one(&database.pool)
        .await
        .unwrap();
        let event_kinds: Vec<String> = sqlx::query_scalar(
            "SELECT event_kind FROM chat_generation_events
             WHERE generation_id=$1::uuid AND run_id=$2::uuid ORDER BY generation_seq",
        )
        .bind(&generation)
        .bind(&run)
        .fetch_all(&database.pool)
        .await
        .unwrap();
        if terminal_first {
            final_result.unwrap();
            assert_eq!(stop_result.outcome, StopOutcome::CompletionCommitted);
            assert_eq!((status, hold, messages), ("completed".into(), false, 1));
            assert_eq!(
                event_kinds,
                vec![
                    "generation_started".to_owned(),
                    "runtime_output".to_owned(),
                    "runtime_terminal".to_owned(),
                    "terminal_projected".to_owned(),
                ]
            );
            let body: String = sqlx::query_scalar(
                "SELECT body FROM chat_messages WHERE run_id=$1::uuid AND role='assistant'",
            )
            .bind(&run)
            .fetch_one(&database.pool)
            .await
            .unwrap();
            assert_eq!(body, "synthetic answer");
        } else {
            assert!(matches!(final_result, Err(Error::Http(409, _))));
            assert_eq!(stop_result.outcome, StopOutcome::StopIntentRecorded);
            assert_eq!((status, hold, messages), ("stop_requested".into(), true, 1));
            assert_eq!(
                event_kinds,
                vec![
                    "generation_started".to_owned(),
                    "runtime_output".to_owned(),
                    "stop_requested".to_owned(),
                    "output_cutoff".to_owned(),
                ]
            );
            let stop = rudder_d1_persistence::native_chat::execution::observe_stop(
                &database.pool,
                &actor,
                &observed.fence,
            )
            .await
            .unwrap()
            .unwrap();
            let cancelled = rudder_d1_persistence::native_chat::execution::finalize_stopped(
                &database.pool,
                &actor,
                &observed.fence,
                &observed.turn_receipt,
                observed.cleanup_receipt.as_ref().unwrap(),
                &stop,
            )
            .await
            .unwrap();
            assert_eq!(cancelled["status"], "cancelled");
            assert_eq!(cancelled["assistantMessageId"], streamed_message);
            let frozen: (String, String) =
                sqlx::query_as("SELECT body,status FROM chat_messages WHERE id=$1::uuid")
                    .bind(&streamed_message)
                    .fetch_one(&database.pool)
                    .await
                    .unwrap();
            assert_eq!(
                frozen,
                (String::new(), "stopped".into()),
                "Stop at sequence zero must preserve the same row but hide its unseen tail"
            );
            assert_eq!(cancelled["nativeAdmissionHold"], false);
        }
        let retry = request_stop(&database.pool, &actor, &request)
            .await
            .unwrap();
        assert!(retry.idempotent);
        assert_eq!(retry.outcome, stop_result.outcome);
        assert_eq!(
            host.events()
                .iter()
                .filter(|event| event["received"]["method"] == "turn/start")
                .count(),
            1
        );
    }
}
