use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

fn fixture_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_OID,
        format!(
            "native-chat-queue-cutover:{}",
            NEXT.fetch_add(1, Ordering::Relaxed)
        )
        .as_bytes(),
    )
    .to_string()
}

async fn queued_chat(pool: &PgPool, status: &str) -> (String, String) {
    let chat = fixture_id();
    seed_chat(pool, &chat).await;
    let item = sqlx::query_scalar(
        "INSERT INTO chat_queued_messages
           (org_id,conversation_id,position,status,client_mutation_id,payload,cancelled_at)
         VALUES($1::uuid,$2::uuid,1,$3,'legacy-queue-fixture','{\"body\":\"previous input\"}',
           CASE WHEN $3='cancelled' THEN clock_timestamp() END)
         RETURNING id::text",
    )
    .bind(ORG)
    .bind(&chat)
    .bind(status)
    .fetch_one(pool)
    .await
    .unwrap();
    (chat, item)
}

async fn queue_snapshot(pool: &PgPool, chat: &str) -> Value {
    sqlx::query_scalar(
        "SELECT jsonb_agg(to_jsonb(q) ORDER BY q.position)
         FROM chat_queued_messages q WHERE q.org_id=$1::uuid AND q.conversation_id=$2::uuid",
    )
    .bind(ORG)
    .bind(chat)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn legacy_input(pool: &PgPool, chat: &str) -> (String, String) {
    let message = fixture_id();
    let turn = fixture_id();
    sqlx::query("INSERT INTO chat_messages(id,org_id,conversation_id,role,kind,body,chat_turn_id,turn_variant) VALUES($1::uuid,$2::uuid,$3::uuid,'user','message','legacy input',$4::uuid,0)")
        .bind(&message).bind(ORG).bind(chat).bind(&turn).execute(pool).await.unwrap();
    (message, turn)
}

async fn assert_legacy_input_blocks(pool: &PgPool, actor: &VerifiedActor, chat: &str) {
    let before = row_counts(pool, chat).await;
    let result = execute(
        pool,
        actor,
        ORG,
        &request(chat, "new-native-input", "new input"),
    )
    .await;
    assert!(
        matches!(result, Err(Error::Http(409, ref message)) if message.contains("unresolved legacy input"))
    );
    assert_eq!(row_counts(pool, chat).await, before);
    let bindings: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM runtime_bindings WHERE org_id=$1::uuid AND conversation_id=$2::uuid",
    )
    .bind(ORG)
    .bind(chat)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(bindings, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn unbound_legacy_input_requires_its_exact_terminal_projection() {
    let database = Database::start().await;
    prepare(&database).await;
    let actor = verified_actor(USER, "legacy-input-cutover");
    for scenario in [
        "missing",
        "different_turn",
        "different_variant",
        "streaming",
        "superseded",
        "earlier_reply",
        "missing_turn",
        "interrupted",
    ] {
        let chat = fixture_id();
        seed_chat(&database.pool, &chat).await;
        let (source, turn) = legacy_input(&database.pool, &chat).await;
        if scenario == "missing_turn" {
            sqlx::query("UPDATE chat_messages SET chat_turn_id=NULL WHERE id=$1::uuid")
                .bind(source)
                .execute(&database.pool)
                .await
                .unwrap();
        } else if scenario != "missing" {
            sqlx::query("INSERT INTO chat_messages(org_id,conversation_id,role,kind,status,body,chat_turn_id,turn_variant,superseded_at,created_at) VALUES($1::uuid,$2::uuid,'assistant','message',$3,'legacy reply',$4::uuid,$5,CASE WHEN $6 THEN clock_timestamp() END,clock_timestamp()+($7::int * interval '1 day'))")
                .bind(ORG).bind(&chat)
                .bind(if scenario == "streaming" { "streaming" } else if scenario == "interrupted" { "interrupted" } else { "completed" })
                .bind(if scenario == "different_turn" { fixture_id() } else { turn })
                .bind(if scenario == "different_variant" { 1 } else { 0 })
                .bind(scenario == "superseded")
                .bind(if scenario == "earlier_reply" { -1 } else { 0 })
                .execute(&database.pool).await.unwrap();
        }
        assert_legacy_input_blocks(&database.pool, &actor, &chat).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn resolved_legacy_turns_allow_native_admission_without_rewriting_history() {
    let database = Database::start().await;
    prepare(&database).await;
    let actor = verified_actor(USER, "legacy-input-resolved");
    for status in ["completed", "failed", "stopped"] {
        let chat = fixture_id();
        seed_chat(&database.pool, &chat).await;
        let (_, turn) = legacy_input(&database.pool, &chat).await;
        sqlx::query("INSERT INTO chat_messages(org_id,conversation_id,role,kind,status,body,chat_turn_id) VALUES($1::uuid,$2::uuid,'assistant','message',$3,'legacy result',$4::uuid)")
            .bind(ORG).bind(&chat).bind(status).bind(turn).execute(&database.pool).await.unwrap();
        let before: Value = sqlx::query_scalar("SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM chat_messages m WHERE org_id=$1::uuid AND conversation_id=$2::uuid")
            .bind(ORG).bind(&chat).fetch_one(&database.pool).await.unwrap();
        let input = request(&chat, "native-after-resolved-history", "new input");
        let receipt = execute(&database.pool, &actor, ORG, &input).await.unwrap();
        let replay = execute(&database.pool, &actor, ORG, &input).await.unwrap();
        assert_eq!(replay["generationId"], receipt["generationId"]);
        let after: Value = sqlx::query_scalar("SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM chat_messages m WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND body<>'new input'")
            .bind(ORG).bind(&chat).fetch_one(&database.pool).await.unwrap();
        assert_eq!(after, before);
        assert_eq!(row_counts(&database.pool, &chat).await, (3, 1, 1, 1, 1));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn native_admission_cannot_cross_the_legacy_message_generation_commit_gap() {
    let database = Database::start().await;
    prepare(&database).await;
    let actor = verified_actor(USER, "legacy-message-generation-gap");
    let chat = fixture_id();
    seed_chat(&database.pool, &chat).await;
    let mut legacy = database.pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!(
            "runtime-binding:target:chat_conversation:{ORG}:{chat}"
        ))
        .execute(&mut *legacy)
        .await
        .unwrap();
    sqlx::query("INSERT INTO chat_messages(org_id,conversation_id,role,kind,body,chat_turn_id) VALUES($1::uuid,$2::uuid,'user','message','legacy input',$3::uuid)")
        .bind(ORG).bind(&chat).bind(fixture_id()).execute(&mut *legacy).await.unwrap();
    let input = request(&chat, "concurrent-native-input", "new input");
    let mut native = Box::pin(execute(&database.pool, &actor, ORG, &input));
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(150), &mut native)
            .await
            .is_err()
    );
    // Legacy persistence ends; Generation creation has deliberately not begun.
    legacy.commit().await.unwrap();
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), native)
        .await
        .unwrap();
    assert!(
        matches!(result, Err(Error::Http(409, ref message)) if message.contains("unresolved legacy input"))
    );
    assert_eq!(row_counts(&database.pool, &chat).await, (1, 0, 0, 0, 0));
    assert_legacy_input_blocks(&database.pool, &actor, &chat).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn older_orphan_input_is_not_hidden_by_thousands_of_resolved_later_turns() {
    let database = Database::start().await;
    prepare(&database).await;
    let actor = verified_actor(USER, "legacy-orphan-history");
    let chat = fixture_id();
    seed_chat(&database.pool, &chat).await;
    let (_, orphan_turn) = legacy_input(&database.pool, &chat).await;
    sqlx::query("WITH turns AS MATERIALIZED (SELECT gen_random_uuid() AS id FROM generate_series(1,2048)) INSERT INTO chat_messages(org_id,conversation_id,role,kind,body,chat_turn_id,created_at) SELECT $1::uuid,$2::uuid,roles.role,'message','resolved history',turns.id,statement_timestamp() FROM turns CROSS JOIN (VALUES ('user'),('assistant')) roles(role)")
        .bind(ORG).bind(&chat).execute(&database.pool).await.unwrap();
    assert_legacy_input_blocks(&database.pool, &actor, &chat).await;
    sqlx::query("INSERT INTO chat_messages(org_id,conversation_id,role,kind,body,chat_turn_id) VALUES($1::uuid,$2::uuid,'assistant','message','orphan explicitly resolved',$3::uuid)")
        .bind(ORG).bind(&chat).bind(orphan_turn).execute(&database.pool).await.unwrap();
    let before = row_counts(&database.pool, &chat).await;
    execute(
        &database.pool,
        &actor,
        ORG,
        &request(&chat, "after-all-input-resolved", "new input"),
    )
    .await
    .unwrap();
    assert_eq!(
        row_counts(&database.pool, &chat).await,
        (before.0 + 1, 1, 1, 1, 1)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn legacy_run_snapshot_association_blocks_until_runtime_and_effects_are_terminal() {
    let database = Database::start().await;
    prepare(&database).await;
    let actor = verified_actor(USER, "legacy-run-snapshot");
    for (status, pending_effects) in [("queued", false), ("running", false), ("succeeded", true)] {
        let chat = fixture_id();
        seed_chat(&database.pool, &chat).await;
        let generation = fixture_id();
        let run = fixture_id();
        sqlx::query("INSERT INTO chat_generations(id,org_id,conversation_id,status) VALUES($1::uuid,$2::uuid,$3::uuid,'completed')")
            .bind(&generation).bind(ORG).bind(&chat).execute(&database.pool).await.unwrap();
        sqlx::query("INSERT INTO heartbeat_runs(id,org_id,agent_id,status,terminal_effects_pending,context_snapshot) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,jsonb_build_object('chatGenerationId',$6::text))")
            .bind(&run).bind(ORG).bind(CEO).bind(status).bind(pending_effects).bind(&generation).execute(&database.pool).await.unwrap();
        let before = row_counts(&database.pool, &chat).await;
        let result = execute(
            &database.pool,
            &actor,
            ORG,
            &request(&chat, "native-after-legacy-run", "new input"),
        )
        .await;
        assert!(
            matches!(result, Err(Error::Http(409, ref message)) if message.contains("active or unreconciled"))
        );
        assert_eq!(row_counts(&database.pool, &chat).await, before);
        sqlx::query("UPDATE heartbeat_runs SET status='succeeded',terminal_effects_pending=false WHERE org_id=$1::uuid AND id=$2::uuid")
            .bind(ORG).bind(&run).execute(&database.pool).await.unwrap();
        execute(
            &database.pool,
            &actor,
            ORG,
            &request(&chat, "native-after-legacy-run", "new input"),
        )
        .await
        .unwrap();
    }
}

async fn assert_queue_blocks(pool: &PgPool, actor: &VerifiedActor, chat: &str) {
    let before = queue_snapshot(pool, chat).await;
    let result = execute(
        pool,
        actor,
        ORG,
        &request(chat, "new-native-input", "new input"),
    )
    .await;
    assert!(
        matches!(result, Err(Error::Http(409, ref message)) if message.contains("queued input"))
    );
    assert_eq!(row_counts(pool, chat).await, (0, 0, 0, 0, 0));
    let bindings: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM runtime_bindings WHERE org_id=$1::uuid AND conversation_id=$2::uuid",
    )
    .bind(ORG)
    .bind(chat)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(bindings, 0);
    assert_eq!(queue_snapshot(pool, chat).await, before);
}

#[tokio::test(flavor = "multi_thread")]
async fn native_admission_preserves_every_unresolved_or_unknown_legacy_queue_state() {
    let database = Database::start().await;
    prepare(&database).await;
    let actor = verified_actor(USER, "queue-cutover-blocked");
    for status in [
        "queued",
        "steer_pending",
        "accepted_current",
        "acceptance_unknown",
        "reconciled_current",
        "continuation_pending",
        "running_next",
        "failed_actionable",
        "dequeue_claimed",
        "running",
        "failed",
        "steered",
        "future_unknown_state",
    ] {
        let (chat, _) = queued_chat(&database.pool, status).await;
        assert_queue_blocks(&database.pool, &actor, &chat).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn native_admission_allows_settled_queue_history_without_modifying_it() {
    let database = Database::start().await;
    prepare(&database).await;
    let actor = verified_actor(USER, "queue-cutover-settled");
    for status in ["completed", "delivered", "cancelled"] {
        let (chat, _) = queued_chat(&database.pool, status).await;
        let before = queue_snapshot(&database.pool, &chat).await;
        let input = request(&chat, "new-native-input", "new input");
        let receipt = execute(&database.pool, &actor, ORG, &input).await.unwrap();
        let replay = execute(&database.pool, &actor, ORG, &input).await.unwrap();
        assert_eq!(replay["generationId"], receipt["generationId"]);
        assert_eq!(replay["idempotentReplay"], true);
        assert_eq!(row_counts(&database.pool, &chat).await, (1, 1, 1, 1, 1));
        assert_eq!(queue_snapshot(&database.pool, &chat).await, before);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn terminal_queue_labels_do_not_hide_leases_cancel_ambiguity_or_pending_controls() {
    let database = Database::start().await;
    prepare(&database).await;
    let actor = verified_actor(USER, "queue-cutover-inconsistent");
    for patch in [
        "delivery_lease_token='stale-claim',delivery_lease_owner='legacy',delivery_lease_expires_at=now()-interval '1 hour'",
        "delivery_lease_owner='owner-without-token'",
        "delivery_lease_expires_at=now()+interval '1 minute'",
    ] {
        let (chat, item) = queued_chat(&database.pool, "completed").await;
        sqlx::query(&format!(
            "UPDATE chat_queued_messages SET {patch} WHERE id=$1::uuid"
        ))
        .bind(item)
        .execute(&database.pool)
        .await
        .unwrap();
        assert_queue_blocks(&database.pool, &actor, &chat).await;
    }
    for patch in [
        "cancelled_at=NULL",
        "provider_turn_id='uncertain-native-input'",
    ] {
        let (chat, item) = queued_chat(&database.pool, "cancelled").await;
        sqlx::query(&format!(
            "UPDATE chat_queued_messages SET {patch} WHERE id=$1::uuid"
        ))
        .bind(item)
        .execute(&database.pool)
        .await
        .unwrap();
        assert_queue_blocks(&database.pool, &actor, &chat).await;
    }
    let (chat, item) = queued_chat(&database.pool, "delivered").await;
    let action = fixture_id();
    sqlx::query(
        "INSERT INTO chat_control_actions(id,org_id,action_kind) VALUES($1::uuid,$2::uuid,'steer')",
    )
    .bind(&action)
    .bind(ORG)
    .execute(&database.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE chat_queued_messages SET control_action_id=$1::uuid WHERE id=$2::uuid")
        .bind(&action)
        .bind(&item)
        .execute(&database.pool)
        .await
        .unwrap();
    assert_queue_blocks(&database.pool, &actor, &chat).await;
    sqlx::query("UPDATE chat_control_actions SET local_disposition='delivered',provider_disposition='acknowledged',resolved_at=clock_timestamp() WHERE id=$1::uuid")
        .bind(action).execute(&database.pool).await.unwrap();
    execute(
        &database.pool,
        &actor,
        ORG,
        &request(&chat, "after-control-reconciled", "new input"),
    )
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn native_admission_rechecks_legacy_queue_after_waiting_for_target_lock() {
    let database = Database::start().await;
    prepare(&database).await;
    let actor = verified_actor(USER, "queue-cutover-lock-order");
    let chat = fixture_id();
    seed_chat(&database.pool, &chat).await;
    let mut legacy = database.pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!(
            "runtime-binding:target:chat_conversation:{ORG}:{chat}"
        ))
        .execute(&mut *legacy)
        .await
        .unwrap();
    sqlx::query("INSERT INTO chat_queued_messages(org_id,conversation_id,position,client_mutation_id,payload) VALUES($1::uuid,$2::uuid,1,'racing-legacy-input','{}')")
        .bind(ORG).bind(&chat).execute(&mut *legacy).await.unwrap();
    let input = request(&chat, "racing-native-input", "new input");
    let mut submission = Box::pin(execute(&database.pool, &actor, ORG, &input));
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(150), &mut submission)
            .await
            .is_err()
    );
    legacy.commit().await.unwrap();
    assert!(matches!(
        tokio::time::timeout(std::time::Duration::from_secs(5), submission)
            .await
            .unwrap(),
        Err(Error::Http(409, _))
    ));
    assert_queue_blocks(&database.pool, &actor, &chat).await;
}
