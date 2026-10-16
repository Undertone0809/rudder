use super::*;

#[tokio::test(flavor = "multi_thread")]
async fn claim_rejects_non_native_binding_continuity_without_claim_effects() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    let (actor, run_id, attempt_id) = prepare(&database, &host).await;
    let binding_id: String = sqlx::query_scalar(
        "SELECT context_snapshot->>'runtimeBindingId' FROM heartbeat_runs
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read admitted RuntimeBinding id");

    for continuity in ["legacy", "context_handoff"] {
        sqlx::query(
            "UPDATE runtime_bindings SET continuity=$1
             WHERE org_id=$2::uuid AND id=$3::uuid",
        )
        .bind(continuity)
        .bind(ORG)
        .bind(&binding_id)
        .execute(&database.pool)
        .await
        .expect("set continuity fixture");

        let before: (
            bool,
            Option<String>,
            bool,
            bool,
            Option<String>,
            bool,
            String,
            Value,
        ) = sqlx::query_as(
            "SELECT g.native_admission_hold, g.control_owner_token,
                        g.control_lease_expires_at IS NOT NULL,
                        r.native_admission_hold, r.execution_owner_token,
                        r.execution_lease_expires_at IS NOT NULL,
                        a.status, a.checkpoint_json
                 FROM chat_generations g
                 JOIN heartbeat_runs r ON r.org_id=g.org_id AND r.chat_generation_id=g.id
                 JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id
                 WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND a.id=$3::uuid",
        )
        .bind(ORG)
        .bind(&run_id)
        .bind(&attempt_id)
        .fetch_one(&database.pool)
        .await
        .expect("snapshot execution state before rejected claim");

        assert_conflict(
            claim(
                &database.pool,
                &actor,
                ORG,
                &run_id,
                &attempt_id,
                host.context(),
            )
            .await,
        );

        let after: (
            bool,
            Option<String>,
            bool,
            bool,
            Option<String>,
            bool,
            String,
            Value,
        ) = sqlx::query_as(
            "SELECT g.native_admission_hold, g.control_owner_token,
                        g.control_lease_expires_at IS NOT NULL,
                        r.native_admission_hold, r.execution_owner_token,
                        r.execution_lease_expires_at IS NOT NULL,
                        a.status, a.checkpoint_json
                 FROM chat_generations g
                 JOIN heartbeat_runs r ON r.org_id=g.org_id AND r.chat_generation_id=g.id
                 JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id
                 WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND a.id=$3::uuid",
        )
        .bind(ORG)
        .bind(&run_id)
        .bind(&attempt_id)
        .fetch_one(&database.pool)
        .await
        .expect("read execution state after rejected claim");
        assert_eq!(
            after, before,
            "rejected continuity must not claim execution"
        );

        let audit_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM activity_log
             WHERE org_id=$1::uuid AND action='runtime.native_chat.execution_claimed'
               AND entity_id=(SELECT chat_generation_id::text FROM heartbeat_runs
                              WHERE org_id=$1::uuid AND id=$2::uuid)",
        )
        .bind(ORG)
        .bind(&run_id)
        .fetch_one(&database.pool)
        .await
        .expect("count claim activity after continuity rejection");
        assert_eq!(audit_count, 0);
    }
}
