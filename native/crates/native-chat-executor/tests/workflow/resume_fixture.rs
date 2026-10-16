use crate::fixture::*;
use rudder_auth_core::VerifiedActor;
use serde_json::{Value, json};

pub(crate) const RESUME_BODY: &str = "Continue the exact existing Thread: 雪🧭";

pub(crate) async fn resumed_database(
    mode: &str,
) -> (Database, FixtureHost, VerifiedActor, String, String, String) {
    let database = Database::start().await;
    let host = FixtureHost::new(mode);
    let (actor, first_run_id, _) = admitted(&database, &host).await;
    let context_snapshot: Value = sqlx::query_scalar(
        "SELECT context_snapshot FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&first_run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read first admitted binding association");
    let binding_id = context_snapshot["runtimeBindingId"]
        .as_str()
        .expect("RuntimeBinding id")
        .to_owned();
    let segment_id = context_snapshot["nativeSegmentId"]
        .as_str()
        .expect("NativeSegment id")
        .to_owned();

    // Model a finished earlier Run whose exact Thread remains the active
    // binding's open Segment. All mutations are confined to this disposable DB.
    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin earlier-Run fixture");
    sqlx::query("SELECT set_config('rudder.native_chat_write', 'native_chat:admission', true)")
        .execute(&mut *tx)
        .await
        .expect("authorize fixture updates");
    sqlx::query(
        "UPDATE heartbeat_runs SET status='failed', finished_at=clock_timestamp(),
             updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&first_run_id)
    .execute(&mut *tx)
    .await
    .expect("finish the earlier Run fixture");
    sqlx::query(
        "UPDATE chat_generations SET status='failed', completed_at=clock_timestamp(),
             updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND conversation_id=$2::uuid",
    )
    .bind(ORG)
    .bind(CHAT)
    .execute(&mut *tx)
    .await
    .expect("finish the earlier Generation fixture");
    sqlx::query(
        "UPDATE native_segments SET state='open', native_session_id=$1,
             updated_at=clock_timestamp()
         WHERE org_id=$2::uuid AND binding_id=$3::uuid AND id=$4::uuid",
    )
    .bind(THREAD)
    .bind(ORG)
    .bind(&binding_id)
    .bind(&segment_id)
    .execute(&mut *tx)
    .await
    .expect("persist the exact open Thread locator");
    tx.commit().await.expect("commit earlier-Run fixture");

    let request: AdmissionRequest = serde_json::from_value(json!({
        "operation": "submit_native_chat_turn",
        "conversationId": CHAT,
        "clientMutationId": "native-chat-executor-resume-2",
        "body": RESUME_BODY,
    }))
    .expect("typed exact-Thread continuation request");
    let receipt = admit(&database.pool, &actor, ORG, &request, host.context())
        .await
        .expect("admit a turn against the existing open Thread");
    let run_id = receipt["runId"]
        .as_str()
        .expect("resumed Run id")
        .to_owned();
    let attempt_id = receipt["attemptId"]
        .as_str()
        .expect("resumed Attempt id")
        .to_owned();
    (database, host, actor, run_id, attempt_id, segment_id)
}
