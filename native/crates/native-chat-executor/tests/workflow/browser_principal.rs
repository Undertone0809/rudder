use crate::fixture::*;
use rudder_d1_persistence::native_chat::{BrowserCredentialBinding, BrowserPrincipal, execution};
use rudder_native_chat_executor::{
    ExecutionRequest, run_observed_with_request_actor_on_blocking_thread,
};
use sha2::{Digest, Sha256};
use std::{sync::atomic::AtomicBool, time::Duration};

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; disposable PostgreSQL and synthetic provider only"]
async fn browser_claimed_worker_finalizes_with_execution_principal_after_session_expiry() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run_id, attempt_id) = database_and_admission("stream-output").await;
    let user = actor.actor().id.clone();
    let token = "synthetic-browser-executor-session";
    sqlx::query(
        "INSERT INTO \"user\"(id,name,email,created_at,updated_at)
        VALUES ($1,'Browser worker','browser-worker@example.test',now(),now()) ON CONFLICT(id) DO NOTHING",
    )
    .bind(&user)
    .execute(&database.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO session(id,user_id,token,expires_at,created_at,updated_at)
        VALUES ('browser-worker-session',$1,$2,now()+interval '1 hour',now(),now())",
    )
    .bind(&user)
    .bind(token)
    .execute(&database.pool)
    .await
    .unwrap();
    let browser = BrowserPrincipal::from_trusted_browser_auth(
        &user,
        ORG,
        "browser-worker-session",
        BrowserCredentialBinding::session(
            "browser-worker-session",
            Sha256::digest(token.as_bytes()).into(),
        ),
    )
    .unwrap();
    let pool = database.pool.clone();
    let handle = tokio::runtime::Handle::current();
    let worker_run = run_id.clone();
    let (result, _host) = tokio::task::spawn_blocking(move || {
        let paths = host.paths();
        let cancelled = AtomicBool::new(false);
        let result = run_observed_with_request_actor_on_blocking_thread(
            &handle,
            &pool,
            browser,
            host.context(),
            &paths,
            ExecutionRequest {
                organization_id: ORG,
                run_id: &worker_run,
                attempt_id: &attempt_id,
                timeout: Duration::from_secs(20),
                cancelled: &cancelled,
            },
        );
        (result, host)
    })
    .await
    .unwrap();
    let observed = result.expect("browser principal must reach claimed worker execution");
    // The request credential has ended; it cannot authorize another request.
    // Only the exact successful claim may now authorize terminalization.
    sqlx::query(
        "UPDATE session SET expires_at=now()-interval '1 second' WHERE id='browser-worker-session'",
    )
    .execute(&database.pool)
    .await
    .unwrap();
    let receipt = execution::finalize(
        &database.pool,
        &observed.execution_principal,
        &observed.fence,
        &observed.turn_receipt,
        observed.cleanup_receipt.as_ref().unwrap(),
    )
    .await
    .unwrap();
    assert!(receipt["assistantMessageId"].is_string());
    let (count, body, status): (i64, String, String) = sqlx::query_as(
        "SELECT count(*) OVER (),body,status FROM chat_messages
         WHERE org_id=$1::uuid AND run_id=$2::uuid AND role='assistant'",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
    assert_eq!(body, "same same answer");
    assert_eq!(status, "completed");
}
