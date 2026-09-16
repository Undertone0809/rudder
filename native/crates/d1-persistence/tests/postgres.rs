mod support;
use rudder_d1_persistence::{
    AuthorizedActor, LinkRequest, MutationStore, Outcome, ResultState, StoreError,
};
use rudder_organization_mutation_core::OrganizationBrandingCommand;
use rudder_project_goal_link_core::{Operation, ProjectGoalLinkCommand};
use sqlx::postgres::PgPoolOptions;
use support::*;

fn actor() -> AuthorizedActor {
    AuthorizedActor::board_after_authorization(ORG, "board-one")
}
fn branding(key: &str, version: u64) -> OrganizationBrandingCommand {
    OrganizationBrandingCommand::board(ORG, "board-one", key, version, 7)
        .with_name(Some("Changed".to_owned()))
}
fn link(key: &str, version: u64, operation: Operation, primary: Option<&str>) -> LinkRequest {
    LinkRequest {
        command: ProjectGoalLinkCommand::board(
            ORG,
            "board-one",
            PROJECT,
            GOAL,
            operation,
            version,
            7,
            key,
        ),
        primary_goal_after: primary.map(str::to_owned),
    }
}

#[tokio::test]
async fn branding_commits_business_version_original_receipt_and_activity_together() {
    let db = Database::start().await;
    let store = MutationStore::new(db.pool.clone());
    let result = store
        .branding(
            &actor(),
            branding("brand", 0)
                .with_description(Some("Description".into()))
                .with_brand_color(Some("#123456".into())),
        )
        .await
        .unwrap();
    assert!(!result.replayed);
    assert_eq!(result.receipt.version, 1);
    assert_eq!(result.receipt.fence_epoch, 7);
    assert_eq!(db.name().await, "Changed");
    assert_eq!(db.counts().await, (1, 1, 1));
    assert!(
        matches!(result.receipt.result,ResultState::OrganizationBranding { state } if state.description.as_deref()==Some("Description"))
    );
}

#[tokio::test]
async fn default_node_ownership_never_becomes_a_rust_writer() {
    let db = Database::start().await;
    db.sql("UPDATE organization_mutation_state SET owner='node',fence_epoch=8")
        .await;
    let store = MutationStore::new(db.pool.clone());
    assert!(matches!(
        store.branding(&actor(), branding("owner", 0)).await,
        Err(StoreError::NotOwned)
    ));
    assert_eq!(db.counts().await, (0, 0, 0));
    assert_eq!(db.name().await, "Original");
}

#[tokio::test]
async fn replay_after_restart_later_commands_and_fence_change_returns_original_receipt() {
    let db = Database::start().await;
    let store = MutationStore::new(db.pool.clone());
    let first = store
        .branding(&actor(), branding("first", 0))
        .await
        .unwrap();
    store
        .branding(
            &actor(),
            branding("later", 1).with_name(Some("Later".into())),
        )
        .await
        .unwrap();
    db.sql("UPDATE organization_mutation_state SET fence_epoch=8")
        .await;
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&db.url)
        .await
        .unwrap();
    let replay = MutationStore::new(pool.clone())
        .branding(&actor(), branding("first", 0))
        .await
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.receipt, first.receipt);
    assert_eq!(db.name().await, "Later");
    assert_eq!(db.counts().await, (2, 2, 2));
    pool.close().await;
}

#[tokio::test]
async fn conflicting_replay_and_cross_domain_keys_never_overwrite_the_receipt() {
    let db = Database::start().await;
    let store = MutationStore::new(db.pool.clone());
    store.branding(&actor(), branding("same", 0)).await.unwrap();
    assert!(matches!(
        store
            .branding(&actor(), branding("same", 0).with_description(None))
            .await,
        Err(StoreError::IdempotencyConflict)
    ));
    assert!(matches!(
        store
            .project_goal(&actor(), link("same", 1, Operation::Attach, Some(GOAL)))
            .await,
        Err(StoreError::IdempotencyConflict)
    ));
    assert_eq!(db.counts().await, (1, 1, 1));
}

#[tokio::test]
async fn stale_versions_fences_and_bigint_overflow_roll_back_every_effect() {
    let db = Database::start().await;
    let store = MutationStore::new(db.pool.clone());
    assert!(matches!(
        store.branding(&actor(), branding("stale", 1)).await,
        Err(StoreError::StaleVersion)
    ));
    let mut stale = branding("fence", 0);
    stale.fence_epoch = 6;
    assert!(matches!(
        store.branding(&actor(), stale).await,
        Err(StoreError::StaleFence)
    ));
    db.sql("UPDATE organization_mutation_state SET mutation_version=9223372036854775807")
        .await;
    assert!(matches!(
        store
            .branding(&actor(), branding("overflow", i64::MAX as u64))
            .await,
        Err(StoreError::VersionRange)
    ));
    assert!(matches!(
        store.branding(&actor(), branding("range", u64::MAX)).await,
        Err(StoreError::VersionRange)
    ));
    assert_eq!(db.name().await, "Original");
    assert_eq!(db.counts().await, (i64::MAX, 0, 0));
}

#[tokio::test]
async fn actor_context_is_bound_and_ceo_role_is_checked_on_locked_database_rows() {
    let db = Database::start().await;
    let store = MutationStore::new(db.pool.clone());
    assert!(matches!(
        store
            .branding(
                &AuthorizedActor::board_after_authorization(OTHER, "board-one"),
                branding("foreign", 0)
            )
            .await,
        Err(StoreError::Unauthorized)
    ));
    assert!(matches!(
        store
            .branding(
                &AuthorizedActor::board_after_authorization(ORG, "somebody-else"),
                branding("spoof", 0)
            )
            .await,
        Err(StoreError::Unauthorized)
    ));
    let ceo = AuthorizedActor::agent_after_authorization(ORG, CEO);
    let command = OrganizationBrandingCommand::ceo_agent(ORG, CEO, "ceo", 0, 7)
        .with_name(Some("CEO change".into()));
    store.branding(&ceo, command.clone()).await.unwrap();
    db.sql("UPDATE agents SET role='general'").await;
    assert!(matches!(
        store.branding(&ceo, command).await,
        Err(StoreError::Unauthorized)
    ));
    assert_eq!(db.counts().await, (1, 1, 1));
}

#[tokio::test]
async fn foreign_assets_projects_goals_and_primary_projection_never_cross_organizations() {
    let db = Database::start().await;
    let store = MutationStore::new(db.pool.clone());
    assert!(matches!(
        store
            .branding(
                &actor(),
                branding("logo", 0).with_logo_asset_id(Some(FOREIGN_ASSET.into()))
            )
            .await,
        Err(StoreError::NotFound)
    ));
    for (project, goal) in [(FOREIGN_PROJECT, GOAL), (PROJECT, FOREIGN_GOAL)] {
        let mut request = link("foreign-link", 0, Operation::Attach, Some(goal));
        request.command.project_id = project.into();
        request.command.goal_id = goal.into();
        assert!(matches!(
            store.project_goal(&actor(), request).await,
            Err(StoreError::NotFound)
        ));
    }
    assert!(matches!(
        store
            .project_goal(
                &actor(),
                link("foreign-primary", 0, Operation::Attach, Some(FOREIGN_GOAL))
            )
            .await,
        Err(StoreError::InvalidProjection)
    ));
    assert_eq!(db.counts().await, (0, 0, 0));
}

#[tokio::test]
async fn logo_clear_preserves_omitted_fields_and_removes_only_the_old_scoped_asset() {
    let db = Database::start().await;
    let store = MutationStore::new(db.pool.clone());
    store
        .branding(
            &actor(),
            branding("set", 0)
                .with_logo_asset_id(Some(ASSET.into()))
                .with_description(Some("Keep".into())),
        )
        .await
        .unwrap();
    let result = store
        .branding(&actor(), branding("clear", 1).with_logo_asset_id(None))
        .await
        .unwrap();
    assert!(
        matches!(result.receipt.result,ResultState::OrganizationBranding { state } if state.logo_asset_id.is_none() && state.description.as_deref()==Some("Keep"))
    );
    let remaining: Vec<String> = sqlx::query_scalar("SELECT id::text FROM assets")
        .fetch_all(&db.pool)
        .await
        .unwrap();
    assert_eq!(remaining, vec![FOREIGN_ASSET.to_owned()]);
}

#[tokio::test]
async fn attach_detach_noop_and_replay_preserve_explicit_legacy_primary() {
    let db = Database::start().await;
    let store = MutationStore::new(db.pool.clone());
    let first = store
        .project_goal(&actor(), link("attach", 0, Operation::Attach, Some(GOAL)))
        .await
        .unwrap();
    let noop = store
        .project_goal(&actor(), link("noop", 1, Operation::Attach, Some(GOAL)))
        .await
        .unwrap();
    assert_eq!(noop.receipt.outcome, Outcome::Noop);
    assert_eq!(noop.receipt.version, 1);
    let mut second = link("second", 1, Operation::Attach, Some(GOAL));
    second.command.goal_id = GOAL_TWO.into();
    store.project_goal(&actor(), second).await.unwrap();
    store
        .project_goal(
            &actor(),
            link("detach", 2, Operation::Detach, Some(GOAL_TWO)),
        )
        .await
        .unwrap();
    let replay = store
        .project_goal(&actor(), link("attach", 0, Operation::Attach, Some(GOAL)))
        .await
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.receipt, first.receipt);
    let primary: Option<String> =
        sqlx::query_scalar("SELECT goal_id::text FROM projects WHERE id=$1::uuid")
            .bind(PROJECT)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(primary.as_deref(), Some(GOAL_TWO));
    assert_eq!(db.counts().await, (3, 4, 4));
}

#[tokio::test]
async fn audit_failure_rolls_back_business_link_version_and_receipt() {
    let db = Database::start().await;
    db.sql("CREATE FUNCTION reject_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$; CREATE TRIGGER reject_test_audit BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION reject_test_audit();").await;
    let store = MutationStore::new(db.pool.clone());
    assert!(matches!(
        store.branding(&actor(), branding("audit", 0)).await,
        Err(StoreError::Database(_))
    ));
    assert!(matches!(
        store
            .project_goal(
                &actor(),
                link("audit-link", 0, Operation::Attach, Some(GOAL))
            )
            .await,
        Err(StoreError::Database(_))
    ));
    assert_eq!(db.counts().await, (0, 0, 0));
    assert_eq!(db.name().await, "Original");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM project_goals")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn receipt_failure_rolls_back_the_already_inserted_activity_and_business_change() {
    let db = Database::start().await;
    db.sql("CREATE FUNCTION reject_test_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt failure'; END $$; CREATE TRIGGER reject_test_receipt BEFORE INSERT ON organization_mutation_receipts FOR EACH ROW EXECUTE FUNCTION reject_test_receipt();").await;
    let store = MutationStore::new(db.pool.clone());
    assert!(matches!(
        store.branding(&actor(), branding("receipt", 0)).await,
        Err(StoreError::Database(_))
    ));
    assert_eq!(db.counts().await, (0, 0, 0));
    assert_eq!(db.name().await, "Original");
}

#[tokio::test]
async fn simultaneous_same_key_commands_apply_once_and_replay_the_same_activity() {
    let db = Database::start().await;
    let store = MutationStore::new(db.pool.clone());
    let auth = actor();
    let (a, b) = tokio::join!(
        store.branding(&auth, branding("race", 0)),
        store.branding(&auth, branding("race", 0))
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_ne!(a.replayed, b.replayed);
    assert_eq!(a.receipt, b.receipt);
    assert_eq!(db.counts().await, (1, 1, 1));
}

#[tokio::test]
async fn simultaneous_different_commands_at_one_version_have_only_one_winner() {
    let db = Database::start().await;
    let store = MutationStore::new(db.pool.clone());
    let auth = actor();
    let (a, b) = tokio::join!(
        store.branding(&auth, branding("brand-race", 0)),
        store.project_goal(&auth, link("link-race", 0, Operation::Attach, Some(GOAL)))
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert!(
        matches!(a, Err(StoreError::StaleVersion)) || matches!(b, Err(StoreError::StaleVersion))
    );
    assert_eq!(db.counts().await, (1, 1, 1));
}

#[tokio::test]
async fn committed_outcomes_survive_a_real_postgresql_process_restart() {
    let mut db = Database::start().await;
    let first = MutationStore::new(db.pool.clone())
        .branding(&actor(), branding("durable", 0))
        .await
        .unwrap();
    db.restart().await;
    let replay = MutationStore::new(db.pool.clone())
        .branding(&actor(), branding("durable", 0))
        .await
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(first.receipt, replay.receipt);
    assert_eq!(db.counts().await, (1, 1, 1));
}

#[tokio::test]
async fn cancellation_during_activity_insert_rolls_back_and_releases_the_writer() {
    let db = Database::start().await;
    db.sql("CREATE FUNCTION slow_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(3); RETURN NEW; END $$; CREATE TRIGGER slow_test_audit BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION slow_test_audit();").await;
    let store = MutationStore::new(db.pool.clone());
    let worker = store.clone();
    let task =
        tokio::spawn(async move { worker.branding(&actor(), branding("cancelled", 0)).await });
    tokio::time::timeout(std::time::Duration::from_secs(10),async {
        loop {
            let sleeping: bool=sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='PgSleep')").fetch_one(&db.pool).await.unwrap();
            if sleeping { break; }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }).await.unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    // This lock waits for the cancelled transaction to roll back, not just MVCC visibility.
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        db.sql("DROP TRIGGER slow_test_audit ON activity_log"),
    )
    .await
    .unwrap();
    assert_eq!(db.counts().await, (0, 0, 0));
    assert_eq!(db.name().await, "Original");
    let retry = store
        .branding(&actor(), branding("cancelled", 0))
        .await
        .unwrap();
    assert!(!retry.replayed);
    assert_eq!(db.counts().await, (1, 1, 1));
}

#[tokio::test]
async fn the_same_key_in_another_organization_has_an_independent_receipt() {
    let db = Database::start().await;
    let store = MutationStore::new(db.pool.clone());
    store
        .branding(&actor(), branding("scoped", 0))
        .await
        .unwrap();
    let other = AuthorizedActor::board_after_authorization(OTHER, "board-one");
    let command = OrganizationBrandingCommand::board(OTHER, "board-one", "scoped", 0, 7)
        .with_name(Some("Other".into()));
    let receipt = store.branding(&other, command).await.unwrap();
    assert!(!receipt.replayed);
    assert_eq!(receipt.receipt.organization_id, OTHER);
    assert_eq!(db.name().await, "Changed");
    assert_eq!(db.counts().await, (1, 1, 1));
}

#[tokio::test]
async fn simultaneous_conflicting_fingerprints_report_conflict_not_a_second_apply() {
    let db = Database::start().await;
    let store = MutationStore::new(db.pool.clone());
    let auth = actor();
    let (a, b) = tokio::join!(
        store.branding(&auth, branding("conflicting", 0)),
        store.branding(
            &auth,
            branding("conflicting", 0).with_name(Some("Other".into()))
        )
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert!(
        matches!(a, Err(StoreError::IdempotencyConflict))
            || matches!(b, Err(StoreError::IdempotencyConflict))
    );
    assert_eq!(db.counts().await, (1, 1, 1));
}

#[tokio::test]
async fn malformed_keys_and_missing_authority_fail_without_provisioning_state() {
    let db = Database::start().await;
    let store = MutationStore::new(db.pool.clone());
    for key in ["x".repeat(257), "é".repeat(129)] {
        assert!(matches!(
            store.branding(&actor(), branding(&key, 0)).await,
            Err(StoreError::InvalidInput)
        ));
    }
    let org = "10000000-0000-4000-8000-000000000003";
    db.sql(&format!("INSERT INTO organizations(id,url_key,name,issue_prefix) VALUES('{org}','unowned','Unowned','UNOWNED')")).await;
    let command = OrganizationBrandingCommand::board(org, "board-one", "absent", 0, 0)
        .with_name(Some("No".into()));
    assert!(matches!(
        store
            .branding(
                &AuthorizedActor::board_after_authorization(org, "board-one"),
                command
            )
            .await,
        Err(StoreError::NotOwned)
    ));
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM organization_mutation_state WHERE org_id=$1::uuid"
        )
        .bind(org)
        .fetch_one(&db.pool)
        .await
        .unwrap(),
        0
    );
    assert_eq!(db.counts().await, (0, 0, 0));
}

#[tokio::test]
async fn primary_projection_is_fingerprinted_and_inconsistent_legacy_rows_are_rejected() {
    let db = Database::start().await;
    let store = MutationStore::new(db.pool.clone());
    store
        .project_goal(
            &actor(),
            link("projection", 0, Operation::Attach, Some(GOAL)),
        )
        .await
        .unwrap();
    assert!(matches!(
        store
            .project_goal(&actor(), link("projection", 0, Operation::Attach, None))
            .await,
        Err(StoreError::IdempotencyConflict)
    ));
    db.sql(&format!(
        "UPDATE projects SET goal_id='{GOAL_TWO}' WHERE id='{PROJECT}'"
    ))
    .await;
    assert!(matches!(
        store
            .project_goal(
                &actor(),
                link("bad-old-projection", 1, Operation::Detach, None)
            )
            .await,
        Err(StoreError::InvalidProjection)
    ));
    assert_eq!(db.counts().await, (1, 1, 1));
}

#[tokio::test]
async fn no_op_at_signed_version_limit_still_has_an_atomic_original_receipt() {
    let db = Database::start().await;
    let store = MutationStore::new(db.pool.clone());
    db.sql("UPDATE organization_mutation_state SET mutation_version=9223372036854775807")
        .await;
    let result = store
        .project_goal(
            &actor(),
            link("limit-noop", i64::MAX as u64, Operation::Detach, None),
        )
        .await
        .unwrap();
    assert_eq!(result.receipt.outcome, Outcome::Noop);
    assert_eq!(result.receipt.version, i64::MAX as u64);
    assert_eq!(db.counts().await, (i64::MAX, 1, 1));
}

#[tokio::test]
async fn authenticated_run_provenance_is_scoped_and_preserved_in_activity() {
    let db = Database::start().await;
    let store = MutationStore::new(db.pool.clone());
    let run = "60000000-0000-4000-8000-000000000001";
    db.sql(&format!("INSERT INTO heartbeat_runs(id,org_id,agent_id,invocation_source) VALUES('{run}','{ORG}','{CEO}','on_demand')")).await;
    let actor =
        AuthorizedActor::agent_after_authorization(ORG, CEO).with_run_after_authorization(run);
    let command = OrganizationBrandingCommand::ceo_agent(ORG, CEO, "run", 0, 7)
        .with_name(Some("With provenance".into()));
    let result = store.branding(&actor, command).await.unwrap();
    let provenance:(String,String,String)=sqlx::query_as("SELECT run_id::text,agent_id::text,actor_type FROM activity_log WHERE org_id=$1::uuid AND id=$2::uuid").bind(ORG).bind(result.receipt.activity_id).fetch_one(&db.pool).await.unwrap();
    assert_eq!(provenance, (run.into(), CEO.into(), "agent".into()));
    let bad =
        AuthorizedActor::agent_after_authorization(OTHER, CEO).with_run_after_authorization(run);
    let command = OrganizationBrandingCommand::ceo_agent(OTHER, CEO, "foreign-run", 0, 7)
        .with_name(Some("No".into()));
    assert!(matches!(
        store.branding(&bad, command).await,
        Err(StoreError::Unauthorized)
    ));
}

#[tokio::test]
async fn unsupported_formats_and_inconsistent_original_results_fail_closed() {
    let db = Database::start().await;
    let store = MutationStore::new(db.pool.clone());
    let first = store
        .branding(&actor(), branding("source-receipt", 0))
        .await
        .unwrap();
    for (key, format, corrupt) in [("future-format", 2, false), ("corrupt-result", 1, true)] {
        let activity:String=sqlx::query_scalar("INSERT INTO activity_log(org_id,actor_id,action,entity_type,entity_id) VALUES($1::uuid,'synthetic','organization.branding_updated','organization',$1::text) RETURNING id::text")
            .bind(ORG).fetch_one(&db.pool).await.unwrap();
        let mut result = serde_json::to_value(&first.receipt).unwrap();
        result["activity_id"] = serde_json::json!(activity);
        if corrupt {
            result["result"]["state"]["name"] = serde_json::json!("Not the original command");
        }
        sqlx::query("INSERT INTO organization_mutation_receipts(org_id,idempotency_key,command_kind,command_fingerprint,receipt_format,outcome,resulting_version,fence_epoch,activity_id,result) VALUES($1::uuid,$2,'organization_branding',$3,$4,'applied',1,7,$5::uuid,$6::jsonb)")
            .bind(ORG).bind(key).bind(&first.receipt.fingerprint).bind(format).bind(activity).bind(result.to_string()).execute(&db.pool).await.unwrap();
        assert!(matches!(
            store.branding(&actor(), branding(key, 0)).await,
            Err(StoreError::InvalidReceipt)
        ));
    }
    assert_eq!(db.name().await, "Changed");
    assert_eq!(db.counts().await, (1, 3, 3));
}

fn ceo_branding(key: &str, version: u64) -> OrganizationBrandingCommand {
    OrganizationBrandingCommand::ceo_agent(ORG, CEO, key, version, 7)
        .with_name(Some("CEO change".into()))
}

fn ceo_link(key: &str, version: u64) -> LinkRequest {
    LinkRequest {
        command: ProjectGoalLinkCommand::ceo_agent(
            ORG,
            CEO,
            PROJECT,
            GOAL,
            Operation::Attach,
            version,
            7,
            key,
        ),
        primary_goal_after: Some(GOAL.into()),
    }
}

async fn assert_inactive_ceo_is_rejected(status: &str) {
    let db = Database::start().await;
    let store = MutationStore::new(db.pool.clone());
    // Capture the trusted context before revocation to exercise the race window.
    let auth = AuthorizedActor::agent_after_authorization(ORG, CEO);
    sqlx::query("UPDATE agents SET status=$2 WHERE id=$1::uuid")
        .bind(CEO)
        .bind(status)
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(matches!(
        store
            .branding(&auth, ceo_branding("inactive-brand", 0))
            .await,
        Err(StoreError::Unauthorized)
    ));
    assert!(matches!(
        store
            .project_goal(&auth, ceo_link("inactive-link", 0))
            .await,
        Err(StoreError::Unauthorized)
    ));
    assert_eq!(db.counts().await, (0, 0, 0));
    assert_eq!(db.name().await, "Original");
}

#[tokio::test]
async fn actor_status_terminated_ceo_cannot_use_previously_authorized_commands() {
    assert_inactive_ceo_is_rejected("terminated").await;
}

#[tokio::test]
async fn actor_status_pending_approval_ceo_cannot_use_previously_authorized_commands() {
    assert_inactive_ceo_is_rejected("pending_approval").await;
}

#[tokio::test]
async fn actor_status_termination_blocks_original_receipt_replay() {
    let db = Database::start().await;
    let store = MutationStore::new(db.pool.clone());
    let auth = AuthorizedActor::agent_after_authorization(ORG, CEO);
    store
        .branding(&auth, ceo_branding("before-termination", 0))
        .await
        .unwrap();
    store
        .project_goal(&auth, ceo_link("before-termination-link", 1))
        .await
        .unwrap();
    sqlx::query("UPDATE agents SET status='terminated' WHERE id=$1::uuid")
        .bind(CEO)
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(matches!(
        store
            .branding(&auth, ceo_branding("before-termination", 0))
            .await,
        Err(StoreError::Unauthorized)
    ));
    assert!(matches!(
        store
            .project_goal(&auth, ceo_link("before-termination-link", 1))
            .await,
        Err(StoreError::Unauthorized)
    ));
    assert_eq!(db.counts().await, (2, 2, 2));
}

#[tokio::test]
async fn actor_status_paused_ceo_preserves_existing_authentication_semantics() {
    let db = Database::start().await;
    let store = MutationStore::new(db.pool.clone());
    let auth = AuthorizedActor::agent_after_authorization(ORG, CEO);
    sqlx::query("UPDATE agents SET status='paused' WHERE id=$1::uuid")
        .bind(CEO)
        .execute(&db.pool)
        .await
        .unwrap();
    store
        .branding(&auth, ceo_branding("paused-brand", 0))
        .await
        .unwrap();
    store
        .project_goal(&auth, ceo_link("paused-link", 1))
        .await
        .unwrap();
    assert_eq!(db.counts().await, (2, 2, 2));
}

const REVIEW_RUN_A: &str = "70000000-0000-4000-8000-000000000001";
const REVIEW_RUN_B: &str = "70000000-0000-4000-8000-000000000002";

async fn review_runs(db: &Database) {
    for run in [REVIEW_RUN_A, REVIEW_RUN_B] {
        sqlx::query("INSERT INTO heartbeat_runs(id,org_id,agent_id,invocation_source) VALUES($1::uuid,$2::uuid,$3::uuid,'on_demand')")
            .bind(run).bind(ORG).bind(CEO).execute(&db.pool).await.unwrap();
    }
}

#[tokio::test]
async fn review_branding_replay_survives_a_new_run_and_restart_without_changing_provenance() {
    let mut db = Database::start().await;
    review_runs(&db).await;
    let store = MutationStore::new(db.pool.clone());
    let first_actor = AuthorizedActor::agent_after_authorization(ORG, CEO)
        .with_run_after_authorization(REVIEW_RUN_A);
    let first = store
        .branding(&first_actor, ceo_branding("cross-run-brand", 0))
        .await
        .unwrap();
    store
        .branding(
            &first_actor,
            ceo_branding("later-brand", 1).with_name(Some("Later state".into())),
        )
        .await
        .unwrap();
    drop(store);
    db.restart().await;
    let store = MutationStore::new(db.pool.clone());
    for auth in [
        AuthorizedActor::agent_after_authorization(ORG, CEO)
            .with_run_after_authorization(REVIEW_RUN_B),
        AuthorizedActor::agent_after_authorization(ORG, CEO),
    ] {
        let replay = store
            .branding(&auth, ceo_branding("cross-run-brand", 0))
            .await
            .unwrap();
        assert!(replay.replayed);
        assert_eq!(replay.receipt, first.receipt);
    }
    let original_run: String = sqlx::query_scalar(
        "SELECT run_id::text FROM activity_log WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&first.receipt.activity_id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(original_run, REVIEW_RUN_A);
    assert_eq!(db.name().await, "Later state");
    assert_eq!(db.counts().await, (2, 2, 2));
}

#[tokio::test]
async fn review_link_replay_uses_logical_command_identity_across_runs() {
    let db = Database::start().await;
    review_runs(&db).await;
    let store = MutationStore::new(db.pool.clone());
    let first_actor = AuthorizedActor::agent_after_authorization(ORG, CEO)
        .with_run_after_authorization(REVIEW_RUN_A);
    let first = store
        .project_goal(&first_actor, ceo_link("cross-run-link", 0))
        .await
        .unwrap();
    let next_actor = AuthorizedActor::agent_after_authorization(ORG, CEO)
        .with_run_after_authorization(REVIEW_RUN_B);
    let replay = store
        .project_goal(&next_actor, ceo_link("cross-run-link", 0))
        .await
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.receipt, first.receipt);
    let original_run: String = sqlx::query_scalar(
        "SELECT run_id::text FROM activity_log WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&first.receipt.activity_id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(original_run, REVIEW_RUN_A);
    assert_eq!(db.counts().await, (1, 1, 1));
}

// End of replay regressions.

#[tokio::test]
async fn review_foreign_run_is_still_rejected_before_a_logical_replay() {
    let db = Database::start().await;
    review_runs(&db).await;
    let foreign_ceo = "50000000-0000-4000-8000-000000000002";
    let foreign_run = "70000000-0000-4000-8000-000000000003";
    sqlx::query(
        "INSERT INTO agents(id,org_id,name,role) VALUES($1::uuid,$2::uuid,'Other CEO','ceo')",
    )
    .bind(foreign_ceo)
    .bind(OTHER)
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO heartbeat_runs(id,org_id,agent_id,invocation_source) VALUES($1::uuid,$2::uuid,$3::uuid,'on_demand')")
        .bind(foreign_run).bind(OTHER).bind(foreign_ceo).execute(&db.pool).await.unwrap();
    let store = MutationStore::new(db.pool.clone());
    let first_actor = AuthorizedActor::agent_after_authorization(ORG, CEO)
        .with_run_after_authorization(REVIEW_RUN_A);
    store
        .branding(&first_actor, ceo_branding("foreign-run-replay", 0))
        .await
        .unwrap();
    let forged = AuthorizedActor::agent_after_authorization(ORG, CEO)
        .with_run_after_authorization(foreign_run);
    assert!(matches!(
        store
            .branding(&forged, ceo_branding("foreign-run-replay", 0))
            .await,
        Err(StoreError::Unauthorized)
    ));
    assert_eq!(db.counts().await, (1, 1, 1));
}

async fn review_forged_snapshot(
    db: &Database,
    original: &rudder_d1_persistence::Receipt,
    key: &str,
    field: &str,
    value: &str,
) {
    let activity: String = sqlx::query_scalar("INSERT INTO activity_log(org_id,actor_id,action,entity_type,entity_id) VALUES($1::uuid,'synthetic','organization.branding_updated','organization',$1::text) RETURNING id::text")
        .bind(ORG).fetch_one(&db.pool).await.unwrap();
    let mut result = serde_json::to_value(original).unwrap();
    result["activity_id"] = serde_json::json!(activity);
    result["result"]["state"][field] = serde_json::json!(value);
    sqlx::query("INSERT INTO organization_mutation_receipts(org_id,idempotency_key,command_kind,command_fingerprint,receipt_format,outcome,resulting_version,fence_epoch,activity_id,result) VALUES($1::uuid,$2,'organization_branding',$3,1,'applied',1,7,$4::uuid,$5::jsonb)")
        .bind(ORG).bind(key).bind(&original.fingerprint).bind(activity).bind(result.to_string())
        .execute(&db.pool).await.unwrap();
}

fn review_description_command(key: &str) -> OrganizationBrandingCommand {
    OrganizationBrandingCommand::board(ORG, "board-one", key, 0, 7)
        .with_description(Some("Only this field changes".into()))
}

// End of reviewed authorization fixture helpers.

#[tokio::test]
async fn review_branding_replay_validates_fields_omitted_by_the_original_command() {
    let db = Database::start().await;
    let store = MutationStore::new(db.pool.clone());
    let first = store
        .branding(&actor(), review_description_command("snapshot-source"))
        .await
        .unwrap();
    for (key, field, value) in [
        ("empty-snapshot-name", "name", ""),
        ("invalid-snapshot-color", "brand_color", "not-a-color"),
        ("invalid-snapshot-logo", "logo_asset_id", "not-a-uuid"),
    ] {
        review_forged_snapshot(&db, &first.receipt, key, field, value).await;
        assert!(
            matches!(
                store
                    .branding(&actor(), review_description_command(key))
                    .await,
                Err(StoreError::InvalidReceipt)
            ),
            "accepted corrupt omitted {field}"
        );
    }
    assert_eq!(db.name().await, "Original");
    assert_eq!(db.counts().await, (1, 4, 4));
}

#[tokio::test]
async fn review_invalid_existing_snapshot_cannot_be_committed_as_an_immutable_receipt() {
    let db = Database::start().await;
    sqlx::query("UPDATE organizations SET brand_color='invalid-old-color' WHERE id=$1::uuid")
        .bind(ORG)
        .execute(&db.pool)
        .await
        .unwrap();
    let store = MutationStore::new(db.pool.clone());
    assert!(matches!(
        store
            .branding(&actor(), review_description_command("invalid-base"))
            .await,
        Err(StoreError::InvalidReceipt)
    ));
    let description: Option<String> =
        sqlx::query_scalar("SELECT description FROM organizations WHERE id=$1::uuid")
            .bind(ORG)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(description, None);
    assert_eq!(db.counts().await, (0, 0, 0));
}

#[tokio::test]
async fn review_historical_valid_snapshot_does_not_require_a_deleted_logo_asset() {
    let db = Database::start().await;
    let store = MutationStore::new(db.pool.clone());
    let command = branding("historical-logo", 0).with_logo_asset_id(Some(ASSET.into()));
    let original = store.branding(&actor(), command.clone()).await.unwrap();
    store
        .branding(
            &actor(),
            branding("remove-historical-logo", 1).with_logo_asset_id(None),
        )
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM assets WHERE id=$1::uuid")
        .bind(ASSET)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let replay = store.branding(&actor(), command).await.unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.receipt, original.receipt);
    assert_eq!(db.counts().await, (2, 2, 2));
}

#[tokio::test]
async fn review_logical_identity_still_binds_the_authorized_principal() {
    let db = Database::start().await;
    let store = MutationStore::new(db.pool.clone());
    store
        .branding(&actor(), branding("principal-bound", 0))
        .await
        .unwrap();
    let other_actor = AuthorizedActor::board_after_authorization(ORG, "board-two");
    let different = OrganizationBrandingCommand::board(ORG, "board-two", "principal-bound", 0, 7)
        .with_name(Some("Changed".into()));
    assert!(matches!(
        store.branding(&other_actor, different).await,
        Err(StoreError::IdempotencyConflict)
    ));
    assert_eq!(db.counts().await, (1, 1, 1));
}

// End of complete-snapshot and principal-binding regressions.

#[tokio::test]
async fn review_partial_snapshot_cannot_silently_default_an_omitted_stored_field() {
    let db = Database::start().await;
    let store = MutationStore::new(db.pool.clone());
    let first = store
        .branding(
            &actor(),
            review_description_command("complete-snapshot-source"),
        )
        .await
        .unwrap();
    let activity: String = sqlx::query_scalar("INSERT INTO activity_log(org_id,actor_id,action,entity_type,entity_id) VALUES($1::uuid,'synthetic','organization.branding_updated','organization',$1::text) RETURNING id::text")
        .bind(ORG).fetch_one(&db.pool).await.unwrap();
    let mut result = serde_json::to_value(&first.receipt).unwrap();
    result["activity_id"] = serde_json::json!(activity);
    result["result"]["state"]
        .as_object_mut()
        .unwrap()
        .remove("brand_color");
    sqlx::query("INSERT INTO organization_mutation_receipts(org_id,idempotency_key,command_kind,command_fingerprint,receipt_format,outcome,resulting_version,fence_epoch,activity_id,result) VALUES($1::uuid,'incomplete-snapshot','organization_branding',$2,1,'applied',1,7,$3::uuid,$4::jsonb)")
        .bind(ORG).bind(&first.receipt.fingerprint).bind(activity).bind(result.to_string())
        .execute(&db.pool).await.unwrap();
    assert!(matches!(
        store
            .branding(&actor(), review_description_command("incomplete-snapshot"))
            .await,
        Err(StoreError::InvalidReceipt)
    ));
    assert_eq!(db.name().await, "Original");
    assert_eq!(db.counts().await, (1, 2, 2));
}

// End of review snapshot-completeness regression.

async fn full_project_goal_set(db: &Database) {
    sqlx::query("INSERT INTO goals(id,org_id,title) SELECT md5('synthetic-capacity-' || n::text)::uuid,$1::uuid,'Capacity fixture ' || n::text FROM generate_series(1,1023) AS n")
        .bind(ORG).execute(&db.pool).await.unwrap();
    sqlx::query("INSERT INTO project_goals(project_id,goal_id,org_id) SELECT $1::uuid,id,org_id FROM goals WHERE org_id=$2::uuid AND id<>$3::uuid")
        .bind(PROJECT).bind(ORG).bind(GOAL_TWO).execute(&db.pool).await.unwrap();
    sqlx::query("UPDATE projects SET goal_id=$2::uuid WHERE id=$1::uuid")
        .bind(PROJECT)
        .bind(GOAL)
        .execute(&db.pool)
        .await
        .unwrap();
}

async fn project_goal_count(db: &Database) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM project_goals WHERE org_id=$1::uuid AND project_id=$2::uuid",
    )
    .bind(ORG)
    .bind(PROJECT)
    .fetch_one(&db.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn link_capacity_append_cannot_create_a_state_the_adapter_cannot_read() {
    let db = Database::start().await;
    full_project_goal_set(&db).await;
    assert_eq!(project_goal_count(&db).await, 1024);
    let store = MutationStore::new(db.pool.clone());
    let mut request = link("over-capacity", 0, Operation::Attach, Some(GOAL));
    request.command.goal_id = GOAL_TWO.into();
    assert!(matches!(
        store.project_goal(&actor(), request).await,
        Err(StoreError::InvalidInput)
    ));
    assert_eq!(project_goal_count(&db).await, 1024);
    assert_eq!(db.counts().await, (0, 0, 0));
}

#[tokio::test]
async fn link_capacity_noop_and_detach_remain_available_at_the_read_bound() {
    let db = Database::start().await;
    full_project_goal_set(&db).await;
    let store = MutationStore::new(db.pool.clone());
    let noop = store
        .project_goal(
            &actor(),
            link("capacity-noop", 0, Operation::Attach, Some(GOAL)),
        )
        .await
        .unwrap();
    assert_eq!(noop.receipt.outcome, Outcome::Noop);
    let removable: String = sqlx::query_scalar("SELECT goal_id::text FROM project_goals WHERE org_id=$1::uuid AND project_id=$2::uuid AND goal_id<>$3::uuid ORDER BY goal_id LIMIT 1")
        .bind(ORG).bind(PROJECT).bind(GOAL).fetch_one(&db.pool).await.unwrap();
    let mut detach = link("capacity-detach", 0, Operation::Detach, Some(GOAL));
    detach.command.goal_id = removable;
    store.project_goal(&actor(), detach).await.unwrap();
    assert_eq!(project_goal_count(&db).await, 1023);
    let mut attach = link("capacity-refill", 1, Operation::Attach, Some(GOAL));
    attach.command.goal_id = GOAL_TWO.into();
    store.project_goal(&actor(), attach).await.unwrap();
    assert_eq!(project_goal_count(&db).await, 1024);
    assert_eq!(db.counts().await, (2, 3, 3));
}

#[tokio::test]
async fn link_capacity_bulk_scope_check_rejects_a_foreign_goal_in_an_existing_link() {
    let db = Database::start().await;
    sqlx::query(
        "INSERT INTO project_goals(project_id,goal_id,org_id) VALUES($1::uuid,$2::uuid,$3::uuid)",
    )
    .bind(PROJECT)
    .bind(FOREIGN_GOAL)
    .bind(ORG)
    .execute(&db.pool)
    .await
    .unwrap();
    let store = MutationStore::new(db.pool.clone());
    assert!(matches!(
        store
            .project_goal(
                &actor(),
                link("corrupt-existing-goal", 0, Operation::Attach, Some(GOAL))
            )
            .await,
        Err(StoreError::NotFound)
    ));
    assert_eq!(db.counts().await, (0, 0, 0));
    assert_eq!(project_goal_count(&db).await, 1);
}
