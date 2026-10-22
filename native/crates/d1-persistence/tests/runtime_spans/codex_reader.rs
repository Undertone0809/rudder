use super::*;
use rudder_d1_persistence::runtime_spans::{
    CodexTranscriptReadCompletion, CodexTranscriptReadPreflight, complete_codex_transcript_read,
    prepare_codex_transcript_read,
};

const GENERATION: &str = "66000000-0000-4000-8000-000000000201";
const SOURCE_MESSAGE: &str = "67000000-0000-4000-8000-000000000201";
const ASSISTANT_MESSAGE: &str = "68000000-0000-4000-8000-000000000201";
const THREAD_ID: &str = "codex-thread-reader-fixture";
const TURN_ID: &str = "codex-turn-reader-fixture";

async fn terminal_codex_fixture() -> (Database, rudder_auth_core::VerifiedActor, Request, String) {
    let database = Database::start().await;
    seed_access(&database.pool).await;
    seed_chat(&database.pool, CHAT, "chat", USER).await;
    let owner = actor(USER, ORG, "codex-reader-fixture");
    let (binding_id, segment_id) = ensure_binding(&database.pool, &owner, CHAT).await;
    sqlx::query("UPDATE runtime_bindings SET profile_id=$3 WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(ORG)
        .bind(&binding_id)
        .bind(format!("managed-codex:{CEO}:default"))
        .execute(&database.pool)
        .await
        .expect("pin historical Codex profile");
    seed_run_attempt(&database.pool, CHAT).await;
    let opened = execute(
        &database.pool,
        &owner,
        ORG,
        &open_request(&binding_id, &segment_id),
    )
    .await
    .expect("open Codex reader span");
    let span_id = opened["span"]["id"].as_str().expect("span id").to_owned();

    let mut tx = database.pool.begin().await.expect("begin reader fixture");
    sqlx::query(
        "SELECT set_config('rudder.native_chat_write', 'native_chat:codex_reader_fixture', true)",
    )
    .execute(&mut *tx)
    .await
    .expect("mark native fixture writer");
    sqlx::query(
        "INSERT INTO chat_messages
           (id, org_id, conversation_id, role, kind, status, body, turn_variant)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'user', 'message', 'completed', 'prompt', 0)",
    )
    .bind(SOURCE_MESSAGE)
    .bind(ORG)
    .bind(CHAT)
    .execute(&mut *tx)
    .await
    .expect("insert source message");
    sqlx::query(
        "INSERT INTO chat_generations
           (id, org_id, conversation_id, execution_authority,
            source_message_id, source_turn_variant, status, terminal_reason,
            control_state, attempt_epoch, provider_thread_id, provider_turn_id,
            runtime_terminal_at, completed_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'native_rust', $4::uuid, 0,
                 'completed', 'native_provider_succeeded', 'terminal', 7,
                 $5, $6, clock_timestamp(), clock_timestamp())",
    )
    .bind(GENERATION)
    .bind(ORG)
    .bind(CHAT)
    .bind(SOURCE_MESSAGE)
    .bind(THREAD_ID)
    .bind(TURN_ID)
    .execute(&mut *tx)
    .await
    .expect("insert terminal generation");
    sqlx::query(
        "INSERT INTO chat_messages
           (id, org_id, conversation_id, role, kind, status, body,
            run_id, replying_agent_id, turn_variant)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'assistant', 'message', 'completed', 'answer',
                 $4::uuid, $5::uuid, 0)",
    )
    .bind(ASSISTANT_MESSAGE)
    .bind(ORG)
    .bind(CHAT)
    .bind(RUN)
    .bind(CEO)
    .execute(&mut *tx)
    .await
    .expect("insert assistant message");
    sqlx::query(
        "UPDATE heartbeat_runs
         SET status='succeeded', finished_at=clock_timestamp(), process_exited_at=clock_timestamp(),
             execution_lease_expires_at=NULL, chat_generation_id=$2::uuid,
             execution_authority='native_rust', scene='chat',
             target_type='chat_conversation', target_id=$3,
             idempotency_key='codex-reader-fixture', session_intent_json=$5::jsonb,
             native_admission_hold=false
         WHERE org_id=$1::uuid AND id=$4::uuid",
    )
    .bind(ORG)
    .bind(GENERATION)
    .bind(CHAT)
    .bind(RUN)
    .bind(json!({
        "kind":"fresh",
        "reuseScope":"none",
        "sourceRunId":null,
        "sessionId":null,
        "sessionParams":null
    }))
    .execute(&mut *tx)
    .await
    .expect("mark Run terminal");
    sqlx::query(
        "UPDATE heartbeat_run_attempts
         SET status='succeeded', finished_at=clock_timestamp(),
             generation_attempt_epoch=7, connection_epoch=3,
             protocol_phase='execution_terminal_committed',
             checkpoint_json=$2::jsonb, provider_thread_id=$3, provider_turn_id=$4
         WHERE org_id=$1::uuid AND id=$5::uuid",
    )
    .bind(ORG)
    .bind(json!({
        "phase":"execution_terminal_committed",
        "revision":1,
        "threadId":THREAD_ID,
        "turnId":TURN_ID
    }))
    .bind(THREAD_ID)
    .bind(TURN_ID)
    .bind(ATTEMPT)
    .execute(&mut *tx)
    .await
    .expect("seal terminal attempt checkpoint");
    sqlx::query(
        "UPDATE run_runtime_spans
         SET state='sealed', completeness='terminal_only', closed_at=clock_timestamp(),
             native_execution_ref=$3,
             selector_json=jsonb_build_object('kind','codex_turn','threadId',$4,'turnId',$3)
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&span_id)
    .bind(TURN_ID)
    .bind(THREAD_ID)
    .execute(&mut *tx)
    .await
    .expect("seal exact terminal Codex span");
    sqlx::query(
        "UPDATE native_segments SET state='sealed', sealed_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(segment_id)
    .execute(&mut *tx)
    .await
    .expect("seal Codex segment");
    tx.commit().await.expect("commit reader fixture");

    let request: Request = serde_json::from_value(json!({
        "operation":"read_message_transcript",
        "conversationId":CHAT,
        "messageId":ASSISTANT_MESSAGE,
        "afterSeq":0,
        "limit":1
    }))
    .expect("read request");
    (database, owner, request, span_id)
}

async fn read_plan(
    database: &Database,
    owner: &rudder_auth_core::VerifiedActor,
    request: &Request,
) -> rudder_d1_persistence::runtime_spans::CodexTranscriptReadPlan {
    match prepare_codex_transcript_read(&database.pool, owner, ORG, request)
        .await
        .expect("prepare exact Codex read")
    {
        CodexTranscriptReadPreflight::Read(plan) => *plan,
        CodexTranscriptReadPreflight::Incomplete(reason) => panic!("incomplete: {reason}"),
        CodexTranscriptReadPreflight::LedgerPresent => panic!("ledger source exists"),
        CodexTranscriptReadPreflight::NotApplicable => panic!("read is not applicable"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn exact_codex_reader_requires_terminal_identity_and_revalidates_stop_and_binding() {
    let (database, owner, request, span_id) = terminal_codex_fixture().await;
    let before_events: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM chat_generation_events WHERE generation_id=$1::uuid",
    )
    .bind(GENERATION)
    .fetch_one(&database.pool)
    .await
    .expect("read fixture event count");
    let plan = read_plan(&database, &owner, &request).await;
    assert_eq!(plan.span_id(), span_id);
    assert_eq!(plan.thread_id(), THREAD_ID);
    assert_eq!(plan.turn_id(), TURN_ID);
    assert_eq!(plan.limit(), 1);
    assert!(
        plan.profile_id()
            .starts_with(&format!("managed-codex:{CEO}:"))
    );

    let transcript = vec![json!({
        "kind":"assistant", "ts":"2026-10-22T00:00:00Z",
        "text":"answer", "delta":false, "phase":"final_answer"
    })];
    let completed = complete_codex_transcript_read(&database.pool, &owner, ORG, &plan, &transcript)
        .await
        .expect("postflight exact read");
    match completed {
        CodexTranscriptReadCompletion::Complete(value) => {
            assert_eq!(value["transcript"], json!(transcript));
            assert_eq!(value["reader"]["source"], "codex_exact_turn");
            assert_eq!(value["reader"]["availability"], "complete");
        }
        CodexTranscriptReadCompletion::UseSqlPrefix => panic!("unchanged identity was fenced"),
    }

    let stale_after_stop = read_plan(&database, &owner, &request).await;
    let mut stop_tx = database.pool.begin().await.expect("begin Stop race");
    sqlx::query(
        "SELECT set_config('rudder.native_chat_write', 'native_chat:codex_reader_stop_race', true)",
    )
    .execute(&mut *stop_tx)
    .await
    .expect("mark Stop race writer");
    sqlx::query(
        "UPDATE chat_generations
         SET status='stop_requested', terminal_reason='operator_stop',
             stop_requested_at=clock_timestamp(), accepted_through_seq=0,
             control_state='stopping'
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(GENERATION)
    .execute(&mut *stop_tx)
    .await
    .expect("race Stop with provider read");
    stop_tx.commit().await.expect("commit Stop race");
    assert!(matches!(
        complete_codex_transcript_read(&database.pool, &owner, ORG, &stale_after_stop, &transcript)
            .await
            .expect("postflight Stop fence"),
        CodexTranscriptReadCompletion::UseSqlPrefix
    ));
    assert_eq!(
        before_events, 0,
        "Reader never writes SQL transcript events"
    );
    let after_events: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM chat_generation_events WHERE generation_id=$1::uuid",
    )
    .bind(GENERATION)
    .fetch_one(&database.pool)
    .await
    .expect("read final fixture event count");
    assert_eq!(after_events, before_events);
}

#[tokio::test(flavor = "multi_thread")]
async fn codex_reader_never_falls_back_when_ledger_or_a_cutoff_exists() {
    let (database, owner, request, _) = terminal_codex_fixture().await;
    // The transcript SQL page is limited to one result, while this ledger event
    // is intentionally far outside that page's position. Any eligible source
    // row in the prefix must suppress provider IPC before pagination.
    let mut ledger_tx = database
        .pool
        .begin()
        .await
        .expect("begin ledger source fixture");
    sqlx::query("SELECT set_config('rudder.native_chat_write', 'native_chat:codex_reader_ledger_source', true)")
        .execute(&mut *ledger_tx)
        .await
        .expect("mark ledger source writer");
    sqlx::query(
        "INSERT INTO chat_generation_events
           (org_id,generation_id,generation_seq,attempt_epoch,event_kind,payload,
            assistant_message_id,run_id)
         VALUES ($1::uuid,$2::uuid,99,7,'assistant_delta','{}'::jsonb,$3::uuid,$4::uuid)",
    )
    .bind(ORG)
    .bind(GENERATION)
    .bind(ASSISTANT_MESSAGE)
    .bind(RUN)
    .execute(&mut *ledger_tx)
    .await
    .expect("insert filtered ledger source");
    ledger_tx
        .commit()
        .await
        .expect("commit ledger source fixture");
    assert!(matches!(
        prepare_codex_transcript_read(&database.pool, &owner, ORG, &request)
            .await
            .expect("preflight ledger event"),
        CodexTranscriptReadPreflight::LedgerPresent
    ));

    let mut cutoff_tx = database.pool.begin().await.expect("begin cutoff fixture");
    sqlx::query(
        "SELECT set_config('rudder.native_chat_write', 'native_chat:codex_reader_cutoff', true)",
    )
    .execute(&mut *cutoff_tx)
    .await
    .expect("mark cutoff fixture writer");
    sqlx::query("DELETE FROM chat_generation_events WHERE generation_id=$1::uuid")
        .bind(GENERATION)
        .execute(&mut *cutoff_tx)
        .await
        .expect("remove ledger event fixture");
    sqlx::query("UPDATE chat_generations SET accepted_through_seq=0 WHERE id=$1::uuid")
        .bind(GENERATION)
        .execute(&mut *cutoff_tx)
        .await
        .expect("establish accepted cutoff");
    cutoff_tx.commit().await.expect("commit cutoff fixture");
    assert!(matches!(
        prepare_codex_transcript_read(&database.pool, &owner, ORG, &request)
            .await
            .expect("preflight accepted cutoff"),
        CodexTranscriptReadPreflight::Incomplete("frozen_prefix")
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn codex_reader_does_not_use_the_current_selected_agent_as_historical_profile() {
    let (database, owner, request, _) = terminal_codex_fixture().await;
    let plan = read_plan(&database, &owner, &request).await;
    let profile = plan.profile_id().to_owned();
    sqlx::query("UPDATE chat_conversations SET preferred_agent_id=$3::uuid WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(ORG)
        .bind(CHAT)
        .bind(AGENT_TWO)
        .execute(&database.pool)
        .await
        .expect("switch currently selected Agent");
    let next_plan = read_plan(&database, &owner, &request).await;
    assert_eq!(next_plan.profile_id(), profile);
    assert_eq!(next_plan.agent_id(), CEO);
}
