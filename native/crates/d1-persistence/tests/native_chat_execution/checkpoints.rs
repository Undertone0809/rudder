use super::*;

#[tokio::test(flavor = "multi_thread")]
async fn checkpoint_cas_is_monotonic_exact_and_survives_a_fresh_pool_read() {
    let database = Database::start().await;
    let (actor, run_id, _attempt_id, fence) = seed_execution(&database).await;

    let mut thread_start = advance_checkpoint(
        &database.pool,
        &actor,
        &fence,
        Phase::NoThreadRequest,
        0,
        CheckpointTransition::PrepareThreadStart,
    )
    .await
    .expect("persist indeterminate thread-start phase");
    assert_eq!(
        thread_start.snapshot().phase,
        Phase::ThreadStartIndeterminate
    );
    assert_eq!(thread_start.snapshot().revision, 1);
    let start_permit = thread_start
        .take_effect_permit()
        .expect("one thread-start permit");
    assert_eq!(start_permit.kind(), EffectKind::StartThread);
    assert_eq!(start_permit.committed_revision(), 1);
    assert!(thread_start.take_effect_permit().is_none());

    assert_conflict(
        advance_checkpoint(
            &database.pool,
            &actor,
            &fence,
            Phase::NoThreadRequest,
            0,
            CheckpointTransition::PrepareThreadStart,
        )
        .await,
    );
    assert_conflict(
        advance_checkpoint(
            &database.pool,
            &actor,
            &fence,
            Phase::ThreadStartIndeterminate,
            1,
            CheckpointTransition::RecordTurn {
                thread_id: OPAQUE_THREAD.to_owned(),
                turn_id: OPAQUE_TURN.to_owned(),
            },
        )
        .await,
    );

    let thread = advance_checkpoint(
        &database.pool,
        &actor,
        &fence,
        Phase::ThreadStartIndeterminate,
        1,
        CheckpointTransition::RecordThread {
            thread_id: OPAQUE_THREAD.to_owned(),
        },
    )
    .await
    .expect("record opaque provider Thread exactly");
    assert_eq!(thread.snapshot().thread_id.as_deref(), Some(OPAQUE_THREAD));
    assert_eq!(thread.snapshot().revision, 2);

    let prepared = advance_checkpoint(
        &database.pool,
        &actor,
        &fence,
        Phase::ThreadKnown,
        2,
        CheckpointTransition::PrepareInput,
    )
    .await
    .expect("persist input preparation");
    assert_eq!(prepared.snapshot().phase, Phase::InputPreSubmission);
    assert_eq!(prepared.snapshot().revision, 3);
    let mut indeterminate = advance_checkpoint(
        &database.pool,
        &actor,
        &fence,
        Phase::InputPreSubmission,
        3,
        CheckpointTransition::MarkInputIndeterminate,
    )
    .await
    .expect("commit non-replayable input phase before submission");
    assert_eq!(indeterminate.snapshot().phase, Phase::InputIndeterminate);
    let input_permit = indeterminate
        .take_effect_permit()
        .expect("one input permit");
    assert_eq!(input_permit.kind(), EffectKind::SubmitInput);
    assert_eq!(input_permit.committed_revision(), 4);

    let port: i32 = sqlx::query_scalar("SELECT inet_server_port()")
        .fetch_one(&database.pool)
        .await
        .expect("read disposable PostgreSQL port");
    let restarted_pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&format!("postgresql://postgres@127.0.0.1:{port}/postgres"))
        .await
        .expect("connect a fresh pool after service restart");
    let restored = current_checkpoint(&restarted_pool, &actor, &fence)
        .await
        .expect("restore committed checkpoint from PostgreSQL");
    assert_eq!(restored.phase, Phase::InputIndeterminate);
    assert_eq!(restored.revision, 4);
    assert_eq!(restored.thread_id.as_deref(), Some(OPAQUE_THREAD));
    assert_eq!(restored.turn_id, None);
    restarted_pool.close().await;

    let turn = advance_checkpoint(
        &database.pool,
        &actor,
        &fence,
        Phase::InputIndeterminate,
        4,
        CheckpointTransition::RecordTurn {
            thread_id: OPAQUE_THREAD.to_owned(),
            turn_id: OPAQUE_TURN.to_owned(),
        },
    )
    .await
    .expect("record exact provider Turn");
    assert_eq!(turn.snapshot().turn_id.as_deref(), Some(OPAQUE_TURN));
    let terminal = advance_checkpoint(
        &database.pool,
        &actor,
        &fence,
        Phase::TurnKnown,
        5,
        CheckpointTransition::ObserveProviderTerminal {
            thread_id: OPAQUE_THREAD.to_owned(),
            turn_id: OPAQUE_TURN.to_owned(),
        },
    )
    .await
    .expect("record provider terminal observation only");
    assert_eq!(terminal.snapshot().phase, Phase::ProviderTerminalObserved);
    assert_eq!(terminal.snapshot().revision, 6);

    let run_state: (String, bool, Option<String>) = sqlx::query_as(
        "SELECT r.status, r.native_admission_hold, r.session_id_after
         FROM heartbeat_runs r WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read Run after provider terminal");
    assert_eq!(
        run_state.0, "running",
        "provider terminal is not Run completion"
    );
    assert!(run_state.1);
    assert_eq!(run_state.2.as_deref(), Some(OPAQUE_THREAD));

    let mirrored: (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT a.provider_thread_id, a.provider_turn_id,
                g.provider_thread_id, g.provider_turn_id
         FROM heartbeat_run_attempts a
         JOIN heartbeat_runs r ON r.org_id=a.org_id AND r.id=a.run_id
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND a.id=$3::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .bind(fence.identity().attempt_id)
    .fetch_one(&database.pool)
    .await
    .expect("read exact identity mirrors");
    assert_eq!(
        mirrored,
        (
            Some(OPAQUE_THREAD.to_owned()),
            Some(OPAQUE_TURN.to_owned()),
            Some(OPAQUE_THREAD.to_owned()),
            Some(OPAQUE_TURN.to_owned()),
        )
    );
}
