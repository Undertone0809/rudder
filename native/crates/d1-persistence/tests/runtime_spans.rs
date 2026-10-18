#[path = "runtime_spans/fixtures.rs"]
mod fixtures;
mod support;

use fixtures::*;
use rudder_d1_persistence::runtime_spans::{Error, Request, execute};
use serde_json::{Value, json};
use support::{CEO, Database, ORG, OTHER};

#[tokio::test(flavor = "multi_thread")]
async fn open_and_locator_bind_are_fenced_concurrent_and_restart_readable() {
    let database = Database::start().await;
    let organization_profile = (database.name().await, database.brand_color().await);
    seed_access(&database.pool).await;
    seed_chat(&database.pool, CHAT, "chat", USER).await;
    seed_chat(&database.pool, CHAT_TWO, "chat", USER).await;
    let owner_actor = actor(USER, ORG, "open-and-bind");
    let (binding_id, segment_id) = ensure_binding(&database.pool, &owner_actor, CHAT).await;
    let (other_binding_id, other_segment_id) =
        ensure_binding(&database.pool, &owner_actor, CHAT_TWO).await;
    seed_run_attempt(&database.pool, CHAT).await;

    let open = open_request(&binding_id, &segment_id);
    let before_invalid_context = span_counts(&database.pool).await;
    let before_invalid_general_counts = database.counts().await;
    let wrong_chat = open_request(&other_binding_id, &other_segment_id);
    assert!(matches!(
        execute(&database.pool, &owner_actor, ORG, &wrong_chat).await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(database.counts().await, before_invalid_general_counts);
    sqlx::query(
        "UPDATE runtime_bindings SET agent_id=$2::uuid WHERE org_id=$3::uuid AND id=$1::uuid",
    )
    .bind(&binding_id)
    .bind(AGENT_TWO)
    .bind(ORG)
    .execute(&database.pool)
    .await
    .expect("mismatch binding Agent fixture");
    assert!(matches!(
        execute(&database.pool, &owner_actor, ORG, &open).await,
        Err(Error::Http(409, _))
    ));
    sqlx::query(
        "UPDATE runtime_bindings SET agent_id=$2::uuid WHERE org_id=$3::uuid AND id=$1::uuid",
    )
    .bind(&binding_id)
    .bind(CEO)
    .bind(ORG)
    .execute(&database.pool)
    .await
    .expect("restore binding Agent fixture");
    sqlx::query(
        "INSERT INTO heartbeat_run_attempts
           (id, org_id, run_id, agent_id, attempt_index, runtime_type, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 'codex_local', 'started')",
    )
    .bind(ATTEMPT_TWO)
    .bind(ORG)
    .bind(RUN)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("insert newer attempt fixture");
    assert!(matches!(
        execute(&database.pool, &owner_actor, ORG, &open).await,
        Err(Error::Http(409, _))
    ));
    sqlx::query("DELETE FROM heartbeat_run_attempts WHERE id=$1::uuid")
        .bind(ATTEMPT_TWO)
        .execute(&database.pool)
        .await
        .expect("remove newer attempt fixture");
    assert_eq!(span_counts(&database.pool).await, before_invalid_context);

    let before_runtime_mismatch = span_counts(&database.pool).await;
    sqlx::query("UPDATE heartbeat_run_attempts SET runtime_type='hermes' WHERE id=$1::uuid")
        .bind(ATTEMPT)
        .execute(&database.pool)
        .await
        .expect("change attempt runtime fixture");
    assert!(matches!(
        execute(&database.pool, &owner_actor, ORG, &open).await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(span_counts(&database.pool).await, before_runtime_mismatch);
    sqlx::query("UPDATE heartbeat_run_attempts SET runtime_type='codex_local' WHERE id=$1::uuid")
        .bind(ATTEMPT)
        .execute(&database.pool)
        .await
        .expect("restore attempt runtime fixture");

    let before_scope_mismatch = span_counts(&database.pool).await;
    sqlx::query(
        "UPDATE runtime_bindings SET principal_scope_ref='user:wrong-owner' WHERE id=$1::uuid",
    )
    .bind(&binding_id)
    .execute(&database.pool)
    .await
    .expect("change principal scope fixture");
    assert!(matches!(
        execute(&database.pool, &owner_actor, ORG, &open).await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(span_counts(&database.pool).await, before_scope_mismatch);
    sqlx::query("UPDATE runtime_bindings SET principal_scope_ref=$2 WHERE id=$1::uuid")
        .bind(&binding_id)
        .bind(format!("org:{ORG}"))
        .execute(&database.pool)
        .await
        .expect("restore principal scope fixture");

    let before_missing_lease = span_counts(&database.pool).await;
    database
        .sql("UPDATE heartbeat_runs SET execution_lease_expires_at=NULL WHERE id='64000000-0000-4000-8000-000000000101'::uuid")
        .await;
    assert!(matches!(
        execute(&database.pool, &owner_actor, ORG, &open).await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(span_counts(&database.pool).await, before_missing_lease);
    sqlx::query("UPDATE heartbeat_runs SET execution_lease_expires_at=clock_timestamp() + interval '1 hour' WHERE id=$1::uuid")
        .bind(RUN)
        .execute(&database.pool)
        .await
        .expect("restore Run lease fixture");

    let mut tasks = Vec::new();
    for _ in 0..8 {
        let pool = database.pool.clone();
        let actor = owner_actor.clone();
        let request = open.clone();
        tasks.push(tokio::spawn(async move {
            execute(&pool, &actor, ORG, &request).await
        }));
    }
    let mut opened = Vec::new();
    for task in tasks {
        opened.push(
            task.await
                .expect("open task joined")
                .expect("open succeeded"),
        );
    }
    let span_id = opened[0]["span"]["id"]
        .as_str()
        .expect("span id")
        .to_owned();
    for result in &opened {
        assert_eq!(result["span"]["id"], span_id);
        assert_eq!(result["span"]["ordinal"], 0);
        assert_eq!(result["span"]["attemptRef"], ATTEMPT);
        assert_eq!(result["segment"]["id"], segment_id);
        assert!(result["span"].get("ownerToken").is_none());
        assert!(result["segment"].get("providerState").is_none());
    }
    assert_eq!(span_counts(&database.pool).await, (1, 1, 0));

    let locator = bind_request(
        &span_id,
        " session-opaque ",
        Some("root-opaque"),
        Some("leaf-opaque"),
    );
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let pool = database.pool.clone();
        let actor = owner_actor.clone();
        let request = locator.clone();
        tasks.push(tokio::spawn(async move {
            execute(&pool, &actor, ORG, &request).await
        }));
    }
    let mut bound = Vec::new();
    for task in tasks {
        bound.push(
            task.await
                .expect("bind task joined")
                .expect("bind succeeded"),
        );
    }
    for result in &bound {
        assert_eq!(result["segment"]["nativeSessionId"], " session-opaque ");
        assert_eq!(result["segment"]["rootSessionId"], "root-opaque");
        assert_eq!(result["segment"]["leafId"], "leaf-opaque");
        assert_eq!(result["segment"]["state"], "open");
    }
    assert_eq!(span_counts(&database.pool).await, (1, 2, 1));

    let changed = bind_request(
        &span_id,
        "different-native-session",
        Some("root-opaque"),
        Some("leaf-opaque"),
    );
    assert!(matches!(
        execute(&database.pool, &owner_actor, ORG, &changed).await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(span_counts(&database.pool).await, (1, 2, 1));

    let before_read = span_counts(&database.pool).await;
    let before_read_general_counts = database.counts().await;
    let read: Request =
        serde_json::from_value(json!({"operation":"read","spanId":span_id})).expect("read request");
    let read_result = execute(&database.pool, &owner_actor, ORG, &read)
        .await
        .expect("read span");
    assert_eq!(read_result, bound[0]);
    assert_eq!(span_counts(&database.pool).await, before_read);
    assert_eq!(database.counts().await, before_read_general_counts);

    sqlx::query("UPDATE heartbeat_runs SET execution_lease_expires_at=clock_timestamp() - interval '1 second' WHERE id=$1::uuid")
        .bind(RUN)
        .execute(&database.pool)
        .await
        .expect("expire current Run lease");
    let before_expired_lease = span_counts(&database.pool).await;
    assert!(matches!(
        execute(&database.pool, &owner_actor, ORG, &open).await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(span_counts(&database.pool).await, before_expired_lease);

    let wrong_org_actor = actor(OTHER_USER, OTHER, "foreign-org");
    assert!(matches!(
        execute(&database.pool, &wrong_org_actor, OTHER, &read).await,
        Err(Error::Http(404, _))
    ));
    assert_eq!(
        (database.name().await, database.brand_color().await),
        organization_profile
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn span_lifecycle_close_seal_reconcile_is_fenced_and_idempotent() {
    let database = Database::start().await;
    seed_access(&database.pool).await;
    seed_chat(&database.pool, CHAT, "chat", USER).await;
    let owner = actor(USER, ORG, "span-lifecycle");
    let (binding_id, segment_id) = ensure_binding(&database.pool, &owner, CHAT).await;
    seed_run_attempt(&database.pool, CHAT).await;

    let opened = execute(
        &database.pool,
        &owner,
        ORG,
        &open_request(&binding_id, &segment_id),
    )
    .await
    .expect("open span");
    let span_id = opened["span"]["id"].as_str().expect("span id");

    let seal: Request = serde_json::from_value(json!({
        "operation":"seal_segment",
        "spanId":span_id,
        "runId":RUN,
        "attemptId":ATTEMPT,
        "attemptEpoch":7,
        "ownerToken":"attempt-owner-token"
    }))
    .expect("seal request");
    let sealed = execute(&database.pool, &owner, ORG, &seal)
        .await
        .expect("seal segment");
    assert_eq!(sealed["segment"]["state"], "sealed");
    assert!(sealed["segment"]["sealedAt"].is_string());

    let close: Request = serde_json::from_value(json!({
        "operation":"close",
        "spanId":span_id,
        "runId":RUN,
        "attemptId":ATTEMPT,
        "attemptEpoch":7,
        "ownerToken":"attempt-owner-token",
        "completeness":"complete"
    }))
    .expect("close request");
    let closed = execute(&database.pool, &owner, ORG, &close)
        .await
        .expect("close span");
    assert_eq!(closed["span"]["state"], "sealed");
    assert_eq!(closed["span"]["completeness"], "complete");
    assert!(closed["span"]["closedAt"].is_string());

    let repeated = execute(&database.pool, &owner, ORG, &close)
        .await
        .expect("repeat close is idempotent");
    assert_eq!(repeated, closed);

    let reconcile: Request = serde_json::from_value(json!({
        "operation":"reconcile_segment",
        "spanId":span_id,
        "runId":RUN,
        "attemptId":ATTEMPT,
        "attemptEpoch":7,
        "ownerToken":"attempt-owner-token"
    }))
    .expect("reconcile request");
    let reconciled = execute(&database.pool, &owner, ORG, &reconcile)
        .await
        .expect("reconcile sealed segment");
    assert_eq!(reconciled["segment"]["state"], "sealed");

    let stale: Request = serde_json::from_value(json!({
        "operation":"close",
        "spanId":span_id,
        "runId":RUN,
        "attemptId":ATTEMPT,
        "attemptEpoch":7,
        "ownerToken":"stale-owner-token",
        "completeness":"complete"
    }))
    .expect("stale close request");
    assert!(matches!(
        execute(&database.pool, &owner, ORG, &stale).await,
        Err(Error::Http(409, _))
    ));
}

#[path = "runtime_spans/concurrency_and_side_chat.rs"]
mod concurrency_and_side_chat;

#[tokio::test(flavor = "multi_thread")]
async fn message_transcript_reader_maps_events_paginates_and_fences_access() {
    const GENERATION: &str = "66000000-0000-4000-8000-000000000101";
    const SOURCE_MESSAGE: &str = "67000000-0000-4000-8000-000000000101";
    const ASSISTANT_MESSAGE: &str = "68000000-0000-4000-8000-000000000101";

    let database = Database::start().await;
    seed_access(&database.pool).await;
    seed_chat(&database.pool, CHAT, "chat", USER).await;
    let owner = actor(USER, ORG, "message-transcript-reader");
    let (binding_id, segment_id) = ensure_binding(&database.pool, &owner, CHAT).await;
    seed_run_attempt(&database.pool, CHAT).await;
    let opened = execute(
        &database.pool,
        &owner,
        ORG,
        &open_request(&binding_id, &segment_id),
    )
    .await
    .expect("open native span");
    let span_id = opened["span"]["id"].as_str().expect("span id").to_owned();

    // Build a native-authority Run and its durable assistant message around the
    // real span. The transaction-local marker is the same guard bypass that the
    // Rust writer uses when appending native generation events.
    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin native transcript fixture");
    sqlx::query("SELECT set_config('rudder.native_chat_write', 'native_chat:test_fixture', true)")
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
            source_message_id, source_turn_variant, status, attempt_epoch)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'native_rust', $4::uuid, 0, 'running', 7)",
    )
    .bind(GENERATION)
    .bind(ORG)
    .bind(CHAT)
    .bind(SOURCE_MESSAGE)
    .execute(&mut *tx)
    .await
    .expect("insert native generation");
    sqlx::query(
        "INSERT INTO chat_messages
           (id, org_id, conversation_id, role, kind, status, body,
            run_id, replying_agent_id, turn_variant)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'assistant', 'message', 'completed', '',
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
         SET chat_generation_id=$2::uuid, execution_authority='native_rust',
             scene='chat', target_type='chat_conversation', target_id=$3,
             idempotency_key='message-transcript-fixture',
             session_intent_json=$5::jsonb,
             native_admission_hold=false
         WHERE org_id=$1::uuid AND id=$4::uuid",
    )
    .bind(ORG)
    .bind(GENERATION)
    .bind(CHAT)
    .bind(RUN)
    .bind(json!({
        "kind": "fresh",
        "reuseScope": "none",
        "sourceRunId": null,
        "sessionId": null,
        "sessionParams": null,
    }))
    .execute(&mut *tx)
    .await
    .expect("mark Run native authority");
    for (sequence, event_kind, payload) in [
        (1, "assistant_delta", json!({"delta":"chunk-A"})),
        (2, "runtime_output", json!({"body":"final-A"})),
        (3, "assistant_delta", json!({"delta":"chunk-B"})),
    ] {
        sqlx::query(
            "INSERT INTO chat_generation_events
               (org_id, generation_id, generation_seq, attempt_epoch,
                event_kind, payload, assistant_message_id, run_id)
             VALUES ($1::uuid, $2::uuid, $3, 7, $4, $5::jsonb, $6::uuid, $7::uuid)",
        )
        .bind(ORG)
        .bind(GENERATION)
        .bind(sequence)
        .bind(event_kind)
        .bind(payload)
        .bind(ASSISTANT_MESSAGE)
        .bind(RUN)
        .execute(&mut *tx)
        .await
        .expect("insert native transcript event");
    }
    tx.commit().await.expect("commit native transcript fixture");

    let first_page: Request = serde_json::from_value(json!({
        "operation":"read_message_transcript",
        "conversationId":CHAT,
        "messageId":ASSISTANT_MESSAGE,
        "afterSeq":0,
        "limit":1
    }))
    .expect("first transcript request");
    let first = execute(&database.pool, &owner, ORG, &first_page)
        .await
        .expect("read first transcript page");
    assert_eq!(first["messageId"], ASSISTANT_MESSAGE);
    assert_eq!(first["messageRef"], ASSISTANT_MESSAGE);
    assert_eq!(first["reader"]["source"], "native_event_ledger");
    assert_eq!(first["reader"]["spanId"], span_id);
    assert_eq!(first["reader"]["revision"], 1);
    assert_eq!(first["reader"]["availability"], "partial");
    assert_eq!(first["reader"]["nextCursor"], "1");
    let first_entry = &first["transcript"][0];
    assert_eq!(first_entry["kind"], "assistant");
    assert_eq!(first_entry["text"], "chunk-A");
    assert_eq!(first_entry["delta"], true);
    assert_eq!(first_entry["phase"], "commentary");
    assert_eq!(first_entry["generationId"], GENERATION);
    assert_eq!(first_entry["generationSeqStart"], 1);
    assert_eq!(first_entry["generationSeqEnd"], 1);
    assert!(first_entry["ts"].is_string());

    let second_page: Request = serde_json::from_value(json!({
        "operation":"read_message_transcript",
        "conversationId":CHAT,
        "messageId":ASSISTANT_MESSAGE,
        "afterSeq":1,
        "limit":10
    }))
    .expect("second transcript request");
    let second = execute(&database.pool, &owner, ORG, &second_page)
        .await
        .expect("read second transcript page");
    assert_eq!(second["reader"]["revision"], 3);
    assert!(second["reader"]["nextCursor"].is_null());
    assert_eq!(
        second["transcript"]
            .as_array()
            .expect("second transcript")
            .iter()
            .map(|item| {
                (
                    item["text"].as_str().expect("transcript text"),
                    item["delta"].as_bool().expect("transcript delta"),
                    item["phase"].as_str().expect("transcript phase"),
                )
            })
            .collect::<Vec<_>>(),
        vec![
            ("final-A", false, "final_answer"),
            ("chunk-B", true, "commentary")
        ]
    );

    sqlx::query(
        "UPDATE run_runtime_spans
         SET state='sealed', completeness='complete', closed_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&span_id)
    .execute(&database.pool)
    .await
    .expect("seal native span");
    let complete_page: Request = serde_json::from_value(json!({
        "operation":"read_message_transcript",
        "conversationId":CHAT,
        "messageId":ASSISTANT_MESSAGE,
        "afterSeq":3,
        "limit":10
    }))
    .expect("complete transcript request");
    let complete = execute(&database.pool, &owner, ORG, &complete_page)
        .await
        .expect("read complete transcript");
    assert_eq!(complete["transcript"], json!([]));
    assert_eq!(complete["reader"]["availability"], "complete");
    assert_eq!(complete["reader"]["completeness"], "complete");
    assert_eq!(complete["reader"]["revision"], 3);

    let wrong_conversation: Request = serde_json::from_value(json!({
        "operation":"read_message_transcript",
        "conversationId":CHAT_TWO,
        "messageId":ASSISTANT_MESSAGE,
        "afterSeq":0,
        "limit":10
    }))
    .expect("wrong conversation transcript request");
    assert!(matches!(
        execute(&database.pool, &owner, ORG, &wrong_conversation).await,
        Err(Error::Http(404, _))
    ));

    let denied = actor(
        "message-transcript-denied",
        ORG,
        "message-transcript-denied",
    );
    assert!(matches!(
        execute(&database.pool, &denied, ORG, &complete_page).await,
        Err(Error::Http(403, _))
    ));
    let foreign = actor(OTHER_USER, OTHER, "message-transcript-foreign-org");
    assert!(matches!(
        execute(&database.pool, &foreign, OTHER, &complete_page).await,
        Err(Error::Http(404, _))
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn conversation_reader_pages_summarizes_cutoffs_and_side_chat_access() {
    const GENERATION: &str = "66000000-0000-4000-8000-000000000102";
    const SOURCE_MESSAGE: &str = "67000000-0000-4000-8000-000000000102";
    const ASSISTANT_MESSAGE: &str = "68000000-0000-4000-8000-000000000102";
    const SIDE_MESSAGE: &str = "68000000-0000-4000-8000-000000000103";
    const SIDE_APPROVAL: &str = "69000000-0000-4000-8000-000000000101";
    const SIDE_ATTACHMENT: &str = "6a000000-0000-4000-8000-000000000101";

    let database = Database::start().await;
    seed_access(&database.pool).await;
    seed_chat(&database.pool, CHAT, "chat", USER).await;
    seed_chat(&database.pool, SIDE_CHAT, "side_chat", USER).await;
    sqlx::query(
        "UPDATE chat_conversations
         SET preferred_agent_id=NULL, routed_agent_id=NULL
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(SIDE_CHAT)
    .execute(&database.pool)
    .await
    .expect("clear legacy Side Chat target");
    let owner = actor(USER, ORG, "conversation-reader");
    seed_run_attempt(&database.pool, CHAT).await;

    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin conversation fixture");
    sqlx::query("SELECT set_config('rudder.native_chat_write', 'native_chat:test_fixture', true)")
        .execute(&mut *tx)
        .await
        .expect("mark native fixture writer");
    sqlx::query(
        "INSERT INTO chat_messages
           (id, org_id, conversation_id, role, kind, status, body,
            run_id, replying_agent_id, turn_variant)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'user', 'message', 'completed', 'prompt',
                 NULL, NULL, 0),
                ($4::uuid, $2::uuid, $3::uuid, 'assistant', 'message', 'completed', 'answer',
                 $5::uuid, $6::uuid, 0)",
    )
    .bind(SOURCE_MESSAGE)
    .bind(ORG)
    .bind(CHAT)
    .bind(ASSISTANT_MESSAGE)
    .bind(RUN)
    .bind(CEO)
    .execute(&mut *tx)
    .await
    .expect("insert conversation messages");
    sqlx::query(
        "INSERT INTO chat_generations
           (id, org_id, conversation_id, execution_authority, source_message_id,
            source_turn_variant, status, attempt_epoch, accepted_through_seq)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'native_rust', $4::uuid, 0,
                 'completed', 7, 1)",
    )
    .bind(GENERATION)
    .bind(ORG)
    .bind(CHAT)
    .bind(SOURCE_MESSAGE)
    .execute(&mut *tx)
    .await
    .expect("insert conversation generation");
    sqlx::query(
        "UPDATE heartbeat_runs
         SET chat_generation_id=$2::uuid, execution_authority='native_rust',
             scene='chat', target_type='chat_conversation', target_id=$3,
             idempotency_key='conversation-reader-fixture', native_admission_hold=false,
             session_intent_json=$5::jsonb
         WHERE org_id=$1::uuid AND id=$4::uuid",
    )
    .bind(ORG)
    .bind(GENERATION)
    .bind(CHAT)
    .bind(RUN)
    .bind(json!({
        "kind": "fresh",
        "reuseScope": "none",
        "sourceRunId": null,
        "sessionId": null,
        "sessionParams": null,
    }))
    .execute(&mut *tx)
    .await
    .expect("mark conversation Run native authority");
    for (sequence, payload) in [
        (1, json!({"entry":{"kind":"tool","text":"visible"}})),
        (2, json!({"entry":{"kind":"tool","text":"cut off"}})),
    ] {
        sqlx::query(
            "INSERT INTO chat_generation_events
               (org_id, generation_id, generation_seq, attempt_epoch,
                event_kind, payload, assistant_message_id, run_id)
             VALUES ($1::uuid, $2::uuid, $3, 7, 'transcript', $4::jsonb, $5::uuid, $6::uuid)",
        )
        .bind(ORG)
        .bind(GENERATION)
        .bind(sequence)
        .bind(payload)
        .bind(ASSISTANT_MESSAGE)
        .bind(RUN)
        .execute(&mut *tx)
        .await
        .expect("insert conversation transcript event");
    }
    sqlx::query(
        "INSERT INTO approvals
           (id, org_id, type, requested_by_user_id, status, payload)
         VALUES ($1::uuid, $2::uuid, 'operation_proposal', $3,
                 'pending', $4::jsonb)",
    )
    .bind(SIDE_APPROVAL)
    .bind(ORG)
    .bind(USER)
    .bind(json!({"title":"Side Chat approval"}))
    .execute(&mut *tx)
    .await
    .expect("insert Side Chat approval");
    sqlx::query(
        "INSERT INTO chat_messages
           (id, org_id, conversation_id, role, kind, status, body,
            structured_payload, approval_id, turn_variant)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'assistant', 'message', 'completed',
                 'side answer', $4::jsonb, $5::uuid, 0)",
    )
    .bind(SIDE_MESSAGE)
    .bind(ORG)
    .bind(SIDE_CHAT)
    .bind(json!({
        "source": "side_chat_fixture",
        "annotation": {"label": "copied"},
        "__chatTranscript": [{"kind": "assistant", "text": "legacy"}],
    }))
    .bind(SIDE_APPROVAL)
    .execute(&mut *tx)
    .await
    .expect("insert Side Chat message");
    sqlx::query(
        "INSERT INTO chat_message_transcript_entries
           (org_id, message_id, entry_seq, payload)
         VALUES ($1::uuid, $2::uuid, 1, $3::jsonb)",
    )
    .bind(ORG)
    .bind(SIDE_MESSAGE)
    .bind(json!({"kind":"assistant","text":"detached"}))
    .execute(&mut *tx)
    .await
    .expect("insert detached Side Chat transcript");
    sqlx::query(
        "INSERT INTO chat_attachments
           (id, org_id, conversation_id, message_id, asset_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)",
    )
    .bind(SIDE_ATTACHMENT)
    .bind(ORG)
    .bind(SIDE_CHAT)
    .bind(SIDE_MESSAGE)
    .bind(support::ASSET)
    .execute(&mut *tx)
    .await
    .expect("insert Side Chat attachment");
    tx.commit().await.expect("commit conversation fixture");

    let first_request: Request = serde_json::from_value(json!({
        "operation":"read_conversation_messages",
        "conversationId":CHAT,
        "limit":1,
        "includeTranscript":false
    }))
    .expect("first conversation page request");
    let first = execute(&database.pool, &owner, ORG, &first_request)
        .await
        .expect("read first conversation page");
    assert_eq!(
        first["messages"].as_array().expect("first messages").len(),
        1
    );
    assert!(first["nextCursor"].is_string());
    assert_eq!(first["messages"][0]["transcript"], json!([]));

    let cursor = first["nextCursor"].as_str().expect("conversation cursor");
    let second_request: Request = serde_json::from_value(json!({
        "operation":"read_conversation_messages",
        "conversationId":CHAT,
        "limit":10,
        "cursor":cursor,
        "includeTranscript":true
    }))
    .expect("second conversation page request");
    let second = execute(&database.pool, &owner, ORG, &second_request)
        .await
        .expect("read second conversation page");
    assert_eq!(second["nextCursor"], Value::Null);
    let message = &second["messages"][0];
    assert_eq!(message["body"], "answer");
    assert_eq!(message["transcriptSummary"]["entryCount"], 1);
    assert_eq!(message["transcript"][0]["text"], "visible");
    assert_eq!(
        message["transcript"]
            .as_array()
            .expect("visible transcript")
            .len(),
        1
    );

    let side_request: Request = serde_json::from_value(json!({
        "operation":"read_conversation_messages",
        "conversationId":SIDE_CHAT,
        "limit":10,
        "includeTranscript":false
    }))
    .expect("Side Chat reader request");
    let side = execute(&database.pool, &owner, ORG, &side_request)
        .await
        .expect("read Side Chat messages");
    let side_message = &side["messages"][0];
    assert_eq!(side_message["body"], "side answer");
    assert_eq!(
        side_message["structuredPayload"],
        json!({"source":"side_chat_fixture","annotation":{"label":"copied"}})
    );
    assert_eq!(side_message["approval"]["id"], SIDE_APPROVAL);
    assert_eq!(side_message["approval"]["type"], "operation_proposal");
    assert_eq!(side_message["attachments"][0]["id"], SIDE_ATTACHMENT);
    assert_eq!(
        side_message["attachments"][0]["contentPath"],
        format!("/api/assets/{}/content", support::ASSET)
    );
    assert_eq!(side_message["transcript"], json!([]));
    assert_eq!(side_message["transcriptSummary"]["entryCount"], 1);

    let side_with_transcript_request: Request = serde_json::from_value(json!({
        "operation":"read_conversation_messages",
        "conversationId":SIDE_CHAT,
        "limit":10,
        "includeTranscript":true
    }))
    .expect("Side Chat reader transcript request");
    let side_with_transcript = execute(&database.pool, &owner, ORG, &side_with_transcript_request)
        .await
        .expect("read Side Chat messages with transcript");
    assert_eq!(
        side_with_transcript["messages"][0]["transcript"][0]["text"],
        "detached"
    );

    let side_transcript_request: Request = serde_json::from_value(json!({
        "operation":"read_message_transcript",
        "conversationId":SIDE_CHAT,
        "messageId":SIDE_MESSAGE,
        "afterSeq":0,
        "limit":10
    }))
    .expect("Side Chat detached transcript request");
    let side_transcript = execute(&database.pool, &owner, ORG, &side_transcript_request)
        .await
        .expect("read detached Side Chat transcript");
    assert_eq!(side_transcript["reader"]["source"], "legacy_compatibility");
    assert_eq!(side_transcript["transcript"][0]["text"], "detached");

    let denied = actor(
        "conversation-reader-denied",
        ORG,
        "conversation-reader-denied",
    );
    assert!(matches!(
        execute(&database.pool, &denied, ORG, &first_request).await,
        Err(Error::Http(403, _))
    ));
}
