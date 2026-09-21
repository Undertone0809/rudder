mod support;

use rudder_d1_persistence::{MutationStore, Outcome, Receipt, ResultState, StoreError};
use rudder_organization_mutation_core::OrganizationBrandingCommand;
use rudder_project_goal_link_core::{
    ActorAuthority, ActorBinding, GoalSetTargetVerifier, Operation, ProjectGoalLinkCommand,
    ProjectGoalLinkState, ProjectGoalSetReplacementCommand, TargetVerifier,
    ValidatedGoalSetContext,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use support::{
    ASSET, CEO, Database, FOREIGN_ASSET, FOREIGN_GOAL, FOREIGN_PROJECT, GOAL, GOAL_TWO, ORG, OTHER,
    PROJECT,
};

struct SeedTargets;

impl TargetVerifier for SeedTargets {
    fn target_exists_in_organization(
        &self,
        organization_id: &str,
        project_org_id: &str,
        goal_org_id: &str,
        project_id: &str,
        goal_id: &str,
    ) -> bool {
        organization_id == ORG
            && project_org_id == ORG
            && goal_org_id == ORG
            && project_id == PROJECT
            && matches!(goal_id, GOAL | GOAL_TWO)
    }
}

impl GoalSetTargetVerifier for SeedTargets {
    fn goal_set_exists_in_organization(
        &self,
        organization_id: &str,
        project_id: &str,
        goal_ids: &[String],
    ) -> bool {
        organization_id == ORG
            && project_id == PROJECT
            && goal_ids
                .iter()
                .all(|goal_id| matches!(goal_id.as_str(), GOAL | GOAL_TWO))
    }
}

struct AnyTarget;

impl TargetVerifier for AnyTarget {
    fn target_exists_in_organization(
        &self,
        _organization_id: &str,
        _project_org_id: &str,
        _goal_org_id: &str,
        _project_id: &str,
        _goal_id: &str,
    ) -> bool {
        true
    }
}

fn project_goal_command(
    goal_id: &str,
    linked: bool,
    version: u64,
    operation: Operation,
    key: &str,
) -> ProjectGoalLinkCommand {
    project_goal_command_at_fence(goal_id, linked, version, 7, operation, key)
}

fn project_goal_command_at_fence(
    goal_id: &str,
    linked: bool,
    version: u64,
    fence_epoch: u64,
    operation: Operation,
    key: &str,
) -> ProjectGoalLinkCommand {
    let authority = ActorAuthority::verification_only("known-secret").unwrap();
    let binding: ActorBinding = serde_json::from_value(json!({
        "actor": {
            "ceo_agent": {
                "organization_id": ORG,
                "principal_id": CEO
            }
        },
        "proof": "73431c93f5c11188b21ad422ff959aa702c3b38d5780d060c0c2007309e7f2dd"
    }))
    .unwrap();
    let state = ProjectGoalLinkState::new(
        ORG,
        ORG,
        ORG,
        PROJECT,
        goal_id,
        version,
        fence_epoch,
        linked,
    );
    let context = state
        .validated_context(&binding, &authority, &SeedTargets)
        .unwrap();
    ProjectGoalLinkCommand::from_validated_context(context, operation, version, fence_epoch, key)
}

fn project_goal_command_from_state(
    state: ProjectGoalLinkState,
    operation: Operation,
    version: u64,
    fence_epoch: u64,
    key: &str,
) -> ProjectGoalLinkCommand {
    let authority = ActorAuthority::verification_only("known-secret").unwrap();
    let binding: ActorBinding = serde_json::from_value(json!({
        "actor": {
            "ceo_agent": {
                "organization_id": ORG,
                "principal_id": CEO
            }
        },
        "proof": "73431c93f5c11188b21ad422ff959aa702c3b38d5780d060c0c2007309e7f2dd"
    }))
    .unwrap();
    let context = state
        .validated_context(&binding, &authority, &SeedTargets)
        .unwrap();
    ProjectGoalLinkCommand::from_validated_context(context, operation, version, fence_epoch, key)
}

fn project_goal_set_command(
    goal_ids: Vec<String>,
    primary_goal_after: Option<String>,
    version: u64,
    key: &str,
) -> ProjectGoalSetReplacementCommand {
    let authority = ActorAuthority::verification_only("known-secret").unwrap();
    let binding: ActorBinding = serde_json::from_value(json!({
        "actor": {
            "ceo_agent": {
                "organization_id": ORG,
                "principal_id": CEO
            }
        },
        "proof": "73431c93f5c11188b21ad422ff959aa702c3b38d5780d060c0c2007309e7f2dd"
    }))
    .unwrap();
    let context = ValidatedGoalSetContext::from_target_snapshot(
        &binding,
        &authority,
        &SeedTargets,
        ORG,
        PROJECT,
        goal_ids,
        primary_goal_after,
    )
    .unwrap();
    ProjectGoalSetReplacementCommand::from_validated_context(context, version, 7, key)
}

async fn project_primary(database: &Database) -> Option<String> {
    sqlx::query_scalar("SELECT goal_id::text FROM projects WHERE id=$1::uuid AND org_id=$2::uuid")
        .bind(PROJECT)
        .bind(ORG)
        .fetch_one(&database.pool)
        .await
        .unwrap()
}

async fn project_goals(database: &Database) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT goal_id::text
         FROM project_goals
         WHERE project_id=$1::uuid AND org_id=$2::uuid
         ORDER BY goal_id",
    )
    .bind(PROJECT)
    .bind(ORG)
    .fetch_all(&database.pool)
    .await
    .unwrap()
}

async fn project_details(database: &Database, activity_id: &str) -> serde_json::Value {
    let details: String = sqlx::query_scalar(
        "SELECT details::text
         FROM activity_log
         WHERE org_id=$1::uuid AND id=$2::uuid AND action='project.updated'",
    )
    .bind(ORG)
    .bind(activity_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    serde_json::from_str(&details).unwrap()
}

fn branding(key: &str, version: u64) -> OrganizationBrandingCommand {
    branding_at(key, version, 7)
}

fn branding_at(key: &str, version: u64, fence_epoch: u64) -> OrganizationBrandingCommand {
    OrganizationBrandingCommand::board(ORG, "board-user", key, version, fence_epoch)
        .with_name(Some(format!("Name {key}")))
}

fn adapter_fingerprint(core_fingerprint: &str, primary_goal_after: Option<&str>) -> String {
    let identity = json!({
        "adapter_format": 1,
        "kind": "project_goal_link",
        "core_fingerprint": core_fingerprint,
        "primary_goal_after": primary_goal_after,
    });
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&identity).unwrap())
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn branding_applies_state_activity_and_immutable_receipt_atomically() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());

    let committed = store
        .branding(branding("branding-applied", 0))
        .await
        .unwrap();

    assert!(!committed.replayed);
    assert_eq!(committed.receipt.organization_id, ORG);
    assert_eq!(committed.receipt.version, 1);
    assert_eq!(committed.receipt.fence_epoch, 7);
    assert_eq!(database.name().await, "Name branding-applied");
    assert_eq!(database.counts().await, (1, 1, 1));
}

#[tokio::test(flavor = "multi_thread")]
async fn branding_replay_returns_original_receipt_after_a_later_mutation() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let first = store.branding(branding("branding-first", 0)).await.unwrap();
    store.branding(branding("branding-later", 1)).await.unwrap();

    let replay = store.branding(branding("branding-first", 0)).await.unwrap();

    assert!(replay.replayed);
    assert_eq!(replay.receipt, first.receipt);
    assert_eq!(database.name().await, "Name branding-later");
    assert_eq!(database.counts().await, (2, 2, 2));
}

#[tokio::test(flavor = "multi_thread")]
async fn branding_replay_rejects_a_semantically_tampered_snapshot() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let command = branding("branding-tamper", 0);
    store.branding(command.clone()).await.unwrap();
    database
        .sql(
            "ALTER TABLE organization_mutation_receipts
             DISABLE TRIGGER organization_mutation_receipts_guard;
             UPDATE organization_mutation_receipts
             SET result=jsonb_set(result, '{result,state,name}', to_jsonb('Tampered'::text))
             WHERE org_id='10000000-0000-4000-8000-000000000001'
               AND idempotency_key='branding-tamper';
             ALTER TABLE organization_mutation_receipts
             ENABLE TRIGGER organization_mutation_receipts_guard;",
        )
        .await;

    assert!(matches!(
        store.branding(command).await,
        Err(StoreError::InvalidReceipt)
    ));
    assert_eq!(database.name().await, "Name branding-tamper");
    assert_eq!(database.counts().await, (1, 1, 1));
}

#[tokio::test(flavor = "multi_thread")]
async fn branding_replay_rejects_a_tampered_omitted_field() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let command = branding("branding-omitted-field-tamper", 0);
    store.branding(command.clone()).await.unwrap();
    database
        .sql(
            "ALTER TABLE organization_mutation_receipts
             DISABLE TRIGGER organization_mutation_receipts_guard;
             UPDATE organization_mutation_receipts
             SET result=jsonb_set(result, '{result,state,description}', to_jsonb('Tampered'::text))
             WHERE org_id='10000000-0000-4000-8000-000000000001'
               AND idempotency_key='branding-omitted-field-tamper';
             ALTER TABLE organization_mutation_receipts
             ENABLE TRIGGER organization_mutation_receipts_guard;",
        )
        .await;

    assert!(matches!(
        store.branding(command).await,
        Err(StoreError::InvalidReceipt)
    ));
    assert_eq!(database.name().await, "Name branding-omitted-field-tamper");
    assert_eq!(database.counts().await, (1, 1, 1));
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_replay_rejects_a_semantically_tampered_transition() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let command = project_goal_command(GOAL, false, 0, Operation::Attach, "project-tamper");
    store
        .project_goal(command.clone(), Some(GOAL.to_owned()))
        .await
        .unwrap();
    database
        .sql(
            "ALTER TABLE organization_mutation_receipts
             DISABLE TRIGGER organization_mutation_receipts_guard;
             UPDATE organization_mutation_receipts
             SET result=jsonb_set(result, '{result,linked}', 'false'::jsonb)
             WHERE org_id='10000000-0000-4000-8000-000000000001'
               AND idempotency_key='project-tamper';
             ALTER TABLE organization_mutation_receipts
             ENABLE TRIGGER organization_mutation_receipts_guard;",
        )
        .await;

    assert!(matches!(
        store.project_goal(command, Some(GOAL.to_owned())).await,
        Err(StoreError::InvalidReceipt)
    ));
    assert_eq!(project_primary(&database).await.as_deref(), Some(GOAL));
    assert_eq!(project_goals(&database).await, vec![GOAL.to_owned()]);
    assert_eq!(database.counts().await, (1, 1, 1));
}

#[tokio::test(flavor = "multi_thread")]
async fn branding_conflicting_key_is_rejected_without_overwriting_original_evidence() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let first = store
        .branding(branding("branding-conflict", 0))
        .await
        .unwrap();

    let error = store
        .branding(branding("branding-conflict", 1))
        .await
        .unwrap_err();

    assert!(matches!(error, StoreError::IdempotencyConflict));
    assert_eq!(database.name().await, "Name branding-conflict");
    assert_eq!(database.counts().await, (1, 1, 1));
    let stored_fingerprint: String = sqlx::query_scalar(
        "SELECT command_fingerprint FROM organization_mutation_receipts
         WHERE org_id=$1::uuid AND idempotency_key=$2",
    )
    .bind(ORG)
    .bind("branding-conflict")
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(stored_fingerprint, first.receipt.fingerprint);
}

#[tokio::test(flavor = "multi_thread")]
async fn branding_checks_owner_scope_freshness_and_bigint_boundaries() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());

    database
        .sql("UPDATE organization_mutation_state SET owner='node', fence_epoch=8, fence_token='60000000-0000-4000-8000-000000000001' WHERE org_id='10000000-0000-4000-8000-000000000001'")
        .await;
    assert!(matches!(
        store.branding(branding("node-owned", 0)).await,
        Err(StoreError::NotOwned)
    ));
    database
        .sql("UPDATE organization_mutation_state SET owner='rust', fence_epoch=9, fence_token='70000000-0000-4000-8000-000000000001' WHERE org_id='10000000-0000-4000-8000-000000000001'")
        .await;

    assert!(matches!(
        store.branding(branding_at("stale-version", 1, 9)).await,
        Err(StoreError::StaleVersion)
    ));
    let stale_fence = branding_at("stale-fence", 0, 8);
    assert!(matches!(
        store.branding(stale_fence).await,
        Err(StoreError::StaleFence)
    ));

    database
        .sql("UPDATE organization_mutation_state SET mutation_version=9223372036854775807 WHERE org_id='10000000-0000-4000-8000-000000000001'")
        .await;
    assert!(matches!(
        store
            .branding(branding_at("version-overflow", i64::MAX as u64, 9))
            .await,
        Err(StoreError::VersionRange)
    ));
    assert!(matches!(
        store
            .branding(branding_at("u64-overflow", u64::MAX, 9))
            .await,
        Err(StoreError::VersionRange)
    ));
    assert_eq!(database.counts().await.1, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn branding_rejects_missing_and_cross_organization_resources() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());

    let missing_org = OrganizationBrandingCommand::board(
        "10000000-0000-4000-8000-000000000099",
        "board-user",
        "missing-org",
        0,
        7,
    )
    .with_name(Some("missing".to_owned()));
    assert!(matches!(
        store.branding(missing_org).await,
        Err(StoreError::NotFound)
    ));

    let foreign_asset = branding("foreign-asset", 0).with_logo_asset_id(Some(FOREIGN_ASSET.into()));
    assert!(matches!(
        store.branding(foreign_asset).await,
        Err(StoreError::NotFound)
    ));
    assert_eq!(database.name().await, "Original");
    assert_eq!(database.counts().await, (0, 0, 0));

    let local_asset = branding("local-asset", 0).with_logo_asset_id(Some(ASSET.into()));
    store.branding(local_asset).await.unwrap();
    let logo: String =
        sqlx::query_scalar("SELECT asset_id::text FROM organization_logos WHERE org_id=$1::uuid")
            .bind(ORG)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert_eq!(logo, ASSET);
    assert_ne!(OTHER, ORG);
    assert_ne!(CEO, "board-user");
}

#[tokio::test(flavor = "multi_thread")]
async fn branding_rolls_back_business_state_version_activity_and_receipt_on_audit_failure() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    database
        .sql(
            "CREATE FUNCTION fail_d1_activity() RETURNS trigger
             LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit failure'; END; $$;
             CREATE TRIGGER fail_d1_activity_trigger
             BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION fail_d1_activity();",
        )
        .await;

    let error = store
        .branding(branding("audit-rollback", 0))
        .await
        .unwrap_err();

    assert!(matches!(error, StoreError::Database(_)));
    assert_eq!(database.name().await, "Original");
    assert_eq!(database.counts().await, (0, 0, 0));
    database
        .sql(
            "DROP TRIGGER fail_d1_activity_trigger ON activity_log;
             DROP FUNCTION fail_d1_activity();",
        )
        .await;
    store.branding(branding("audit-retry", 0)).await.unwrap();
    assert_eq!(database.counts().await, (1, 1, 1));
}

#[tokio::test(flavor = "multi_thread")]
async fn branding_rejects_inactive_ceo_before_replay_and_preserves_scope() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let command = OrganizationBrandingCommand::ceo_agent(ORG, CEO, "inactive-ceo", 0, 7)
        .with_name(Some("inactive".to_owned()));
    database
        .sql(
            "UPDATE agents SET status='terminated' WHERE id='50000000-0000-4000-8000-000000000001'",
        )
        .await;

    assert!(matches!(
        store.branding(command).await,
        Err(StoreError::Unauthorized)
    ));
    assert_eq!(database.counts().await, (0, 0, 0));
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_mutations_keep_multi_goal_and_legacy_primary_projection_in_sync() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());

    let first = store
        .project_goal(
            project_goal_command(GOAL, false, 0, Operation::Attach, "project-first"),
            Some(GOAL.to_owned()),
        )
        .await
        .unwrap();
    assert!(!first.replayed);
    assert_eq!(first.receipt.version, 1);
    match &first.receipt.result {
        ResultState::ProjectGoalLink {
            linked,
            cancelled,
            primary_goal_after,
            ..
        } => {
            assert!(*linked);
            assert!(!*cancelled);
            assert_eq!(primary_goal_after.as_deref(), Some(GOAL));
        }
        result => panic!("unexpected project result: {result:?}"),
    }
    assert_eq!(project_primary(&database).await.as_deref(), Some(GOAL));
    assert_eq!(project_goals(&database).await, vec![GOAL.to_owned()]);
    assert_eq!(
        project_details(&database, &first.receipt.activity_id).await["goalIds"],
        json!([GOAL])
    );
    let first_state = match &first.receipt.result {
        ResultState::ProjectGoalLink { state, .. } => state.as_ref().clone(),
        result => panic!("unexpected project result: {result:?}"),
    };

    let second = store
        .project_goal(
            project_goal_command(GOAL_TWO, false, 1, Operation::Attach, "project-second"),
            Some(GOAL.to_owned()),
        )
        .await
        .unwrap();
    assert_eq!(second.receipt.version, 2);
    assert_eq!(project_primary(&database).await.as_deref(), Some(GOAL));
    assert_eq!(
        project_goals(&database).await,
        vec![GOAL.to_owned(), GOAL_TWO.to_owned()]
    );
    assert_eq!(
        project_details(&database, &second.receipt.activity_id).await["goalIds"],
        json!([GOAL, GOAL_TWO])
    );
    let second_state = match &second.receipt.result {
        ResultState::ProjectGoalLink { state, .. } => state.as_ref().clone(),
        result => panic!("unexpected project result: {result:?}"),
    };

    let detach_primary = store
        .project_goal(
            project_goal_command_from_state(
                first_state.rebase_scope(2, 7).unwrap(),
                Operation::Detach,
                2,
                7,
                "project-detach",
            ),
            Some(GOAL_TWO.to_owned()),
        )
        .await
        .unwrap();
    assert_eq!(detach_primary.receipt.version, 3);
    assert_eq!(project_primary(&database).await.as_deref(), Some(GOAL_TWO));
    assert_eq!(project_goals(&database).await, vec![GOAL_TWO.to_owned()]);
    assert_eq!(
        project_details(&database, &detach_primary.receipt.activity_id).await["goalIds"],
        json!([GOAL_TWO])
    );

    let detach_last = store
        .project_goal(
            project_goal_command_from_state(
                second_state.rebase_scope(3, 7).unwrap(),
                Operation::Detach,
                3,
                7,
                "project-last",
            ),
            None,
        )
        .await
        .unwrap();
    assert_eq!(detach_last.receipt.version, 4);
    match &detach_last.receipt.result {
        ResultState::ProjectGoalLink {
            linked,
            cancelled,
            primary_goal_after,
            ..
        } => {
            assert!(!*linked);
            assert!(!*cancelled);
            assert_eq!(*primary_goal_after, None);
        }
        result => panic!("unexpected project result: {result:?}"),
    }
    assert_eq!(project_primary(&database).await, None);
    assert!(project_goals(&database).await.is_empty());
    assert_eq!(
        project_details(&database, &detach_last.receipt.activity_id).await["goalIds"],
        json!([])
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_set_replacement_is_atomic_and_replays_its_original_receipt() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let first_command = project_goal_set_command(
        vec![GOAL.to_owned(), GOAL_TWO.to_owned()],
        Some(GOAL.to_owned()),
        0,
        "project-goal-set-first",
    );
    let first = store.project_goal_set(first_command.clone()).await.unwrap();

    assert!(!first.replayed);
    assert_eq!(first.receipt.version, 1);
    assert_eq!(project_primary(&database).await.as_deref(), Some(GOAL));
    assert_eq!(
        project_goals(&database).await,
        vec![GOAL.to_owned(), GOAL_TWO.to_owned()]
    );
    assert_eq!(
        project_details(&database, &first.receipt.activity_id).await,
        json!({"goalIds": [GOAL, GOAL_TWO], "primaryGoalId": GOAL})
    );
    match &first.receipt.result {
        ResultState::ProjectGoalSetReplacement {
            project_id,
            goal_ids,
            primary_goal_after,
            ..
        } => {
            assert_eq!(project_id, PROJECT);
            assert_eq!(goal_ids, &[GOAL.to_owned(), GOAL_TWO.to_owned()]);
            assert_eq!(primary_goal_after.as_deref(), Some(GOAL));
        }
        result => panic!("unexpected project goal-set result: {result:?}"),
    }

    let later = store
        .project_goal_set(project_goal_set_command(
            vec![GOAL_TWO.to_owned()],
            Some(GOAL_TWO.to_owned()),
            1,
            "project-goal-set-later",
        ))
        .await
        .unwrap();
    assert_eq!(later.receipt.version, 2);

    let replay = store.project_goal_set(first_command).await.unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.receipt, first.receipt);
    assert_eq!(project_primary(&database).await.as_deref(), Some(GOAL_TWO));
    assert_eq!(project_goals(&database).await, vec![GOAL_TWO.to_owned()]);
    assert_eq!(database.counts().await, (2, 2, 2));
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_set_replacement_rolls_back_business_projection_receipt_and_audit() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    database
        .sql(
            "CREATE FUNCTION fail_goal_set_activity() RETURNS trigger
             LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test goal-set audit failure'; END; $$;
             CREATE TRIGGER fail_goal_set_activity_trigger
             BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION fail_goal_set_activity();",
        )
        .await;

    let error = store
        .project_goal_set(project_goal_set_command(
            vec![GOAL.to_owned(), GOAL_TWO.to_owned()],
            Some(GOAL.to_owned()),
            0,
            "project-goal-set-audit-rollback",
        ))
        .await
        .unwrap_err();

    assert!(matches!(error, StoreError::Database(_)));
    assert_eq!(project_primary(&database).await, None);
    assert!(project_goals(&database).await.is_empty());
    assert_eq!(database.counts().await, (0, 0, 0));
    database
        .sql(
            "DROP TRIGGER fail_goal_set_activity_trigger ON activity_log;
             DROP FUNCTION fail_goal_set_activity();",
        )
        .await;

    store
        .project_goal_set(project_goal_set_command(
            vec![GOAL_TWO.to_owned()],
            Some(GOAL_TWO.to_owned()),
            0,
            "project-goal-set-audit-retry",
        ))
        .await
        .unwrap();
    assert_eq!(project_primary(&database).await.as_deref(), Some(GOAL_TWO));
    assert_eq!(project_goals(&database).await, vec![GOAL_TWO.to_owned()]);
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_rejects_a_primary_goal_that_is_not_in_the_project_set() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());

    let error = store
        .project_goal(
            project_goal_command(GOAL, false, 0, Operation::Attach, "project-invalid-primary"),
            Some(GOAL_TWO.to_owned()),
        )
        .await
        .unwrap_err();

    assert!(matches!(error, StoreError::InvalidProjection));
    assert_eq!(database.counts().await, (0, 0, 0));
    assert_eq!(project_primary(&database).await, None);
    assert!(project_goals(&database).await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_rejects_cross_organization_projection_targets_in_postgres() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let authority = ActorAuthority::verification_only("known-secret").unwrap();
    let binding: ActorBinding = serde_json::from_value(json!({
        "actor": {
            "ceo_agent": {
                "organization_id": ORG,
                "principal_id": CEO
            }
        },
        "proof": "73431c93f5c11188b21ad422ff959aa702c3b38d5780d060c0c2007309e7f2dd"
    }))
    .unwrap();

    for (project_id, goal_id, key) in [
        (FOREIGN_PROJECT, FOREIGN_GOAL, "foreign-both"),
        (PROJECT, FOREIGN_GOAL, "foreign-goal"),
    ] {
        let state = ProjectGoalLinkState::new(ORG, ORG, ORG, project_id, goal_id, 0, 7, false);
        let context = state
            .validated_context(&binding, &authority, &AnyTarget)
            .unwrap();
        let error = store
            .project_goal(
                ProjectGoalLinkCommand::from_validated_context(
                    context,
                    Operation::Attach,
                    0,
                    7,
                    key,
                ),
                Some(goal_id.to_owned()),
            )
            .await
            .unwrap_err();
        assert!(matches!(error, StoreError::NotFound));
    }
    assert_eq!(database.counts().await, (0, 0, 0));
    assert!(project_goals(&database).await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_replay_returns_the_original_receipt_after_later_mutations() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let first_command = project_goal_command(GOAL, false, 0, Operation::Attach, "project-replay");
    let first = store
        .project_goal(first_command.clone(), Some(GOAL.to_owned()))
        .await
        .unwrap();
    store
        .project_goal(
            project_goal_command(GOAL_TWO, false, 1, Operation::Attach, "project-later"),
            Some(GOAL.to_owned()),
        )
        .await
        .unwrap();

    let replay = store
        .project_goal(first_command, Some(GOAL.to_owned()))
        .await
        .unwrap();

    assert!(replay.replayed);
    assert_eq!(replay.receipt, first.receipt);
    assert_eq!(database.counts().await, (2, 2, 2));
    assert_eq!(project_primary(&database).await.as_deref(), Some(GOAL));
    assert_eq!(
        project_goals(&database).await,
        vec![GOAL.to_owned(), GOAL_TWO.to_owned()]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_replay_rejects_a_missing_predecessor_in_history() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let attached = store
        .project_goal(
            project_goal_command(GOAL, false, 0, Operation::Attach, "history-predecessor"),
            Some(GOAL.to_owned()),
        )
        .await
        .unwrap();
    let attached_state = match &attached.receipt.result {
        ResultState::ProjectGoalLink { state, .. } => state.as_ref().clone(),
        result => panic!("unexpected project result: {result:?}"),
    };
    let detached_command =
        project_goal_command_from_state(attached_state, Operation::Detach, 1, 7, "history-replay");
    store
        .project_goal(detached_command.clone(), None)
        .await
        .unwrap();

    database
        .sql(
            "ALTER TABLE organization_mutation_receipts
             DISABLE TRIGGER organization_mutation_receipts_guard;
             DELETE FROM organization_mutation_receipts
             WHERE org_id='10000000-0000-4000-8000-000000000001'
               AND idempotency_key='history-predecessor';
             ALTER TABLE organization_mutation_receipts
             ENABLE TRIGGER organization_mutation_receipts_guard;",
        )
        .await;

    assert!(matches!(
        store.project_goal(detached_command, None).await,
        Err(StoreError::InvalidReceipt)
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_replay_rejects_a_forked_history() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let first_command = project_goal_command(GOAL, false, 0, Operation::Attach, "fork-first");
    store
        .project_goal(first_command.clone(), Some(GOAL.to_owned()))
        .await
        .unwrap();

    let branch_context = ProjectGoalLinkState::bootstrap(ORG, ORG, ORG, PROJECT, GOAL, 1, 7, true);
    let branch_command = project_goal_command_from_state(
        branch_context.clone(),
        Operation::Attach,
        1,
        7,
        "fork-branch",
    );
    let branch_view = branch_command.as_integration_view().unwrap();
    let branch_state = branch_view.resulting_state().unwrap();
    let core_fingerprint = branch_view.fingerprint().unwrap();
    let primary_goal_after = Some(GOAL.to_owned());
    let activity_id = "70000000-0000-4000-8000-000000000001";
    let receipt = Receipt {
        organization_id: ORG.to_owned(),
        version: branch_state.version,
        fence_epoch: branch_state.fence_epoch,
        fingerprint: adapter_fingerprint(&core_fingerprint, primary_goal_after.as_deref()),
        activity_id: activity_id.to_owned(),
        outcome: Outcome::Noop,
        result: ResultState::ProjectGoalLink {
            state: Box::new(branch_state.clone()),
            project_id: PROJECT.to_owned(),
            goal_id: GOAL.to_owned(),
            operation: Operation::Attach,
            link_identifier: branch_view.link_identifier().unwrap(),
            core_fingerprint,
            target_version: branch_context.version,
            target_fence_epoch: branch_context.fence_epoch,
            linked: branch_state.linked,
            cancelled: branch_state.cancelled,
            primary_goal_after,
            state_integrity: branch_state.state_integrity().to_owned(),
            target_integrity: branch_context.state_integrity().to_owned(),
        },
    };
    let receipt_json = serde_json::to_string(&receipt).unwrap();
    database
        .sql(
            "INSERT INTO activity_log
             (id, org_id, actor_type, actor_id, action, entity_type, entity_id, details, idempotency_key)
             VALUES
             ('70000000-0000-4000-8000-000000000001'::uuid,
              '10000000-0000-4000-8000-000000000001'::uuid,
              'user', 'board-user', 'project.updated', 'project',
              '20000000-0000-4000-8000-000000000001', '{}'::jsonb, 'rust-d1:fork-branch')",
        )
        .await;
    sqlx::query(
        "INSERT INTO organization_mutation_receipts
         (org_id, idempotency_key, command_kind, command_fingerprint, receipt_format,
          outcome, resulting_version, fence_epoch, activity_id, result)
         VALUES ($1::uuid, $2, 'project_goal_link', $3, 2, 'noop', $4, $5, $6::uuid, $7::jsonb)",
    )
    .bind(ORG)
    .bind("fork-branch")
    .bind(&receipt.fingerprint)
    .bind(i64::try_from(receipt.version).unwrap())
    .bind(i64::try_from(receipt.fence_epoch).unwrap())
    .bind(activity_id)
    .bind(receipt_json)
    .execute(&database.pool)
    .await
    .unwrap();

    assert!(matches!(
        store
            .project_goal(first_command, Some(GOAL.to_owned()))
            .await,
        Err(StoreError::InvalidReceipt)
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_cancel_is_durable_terminal_and_replays_after_scope_advances() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let attached = store
        .project_goal(
            project_goal_command(GOAL, false, 0, Operation::Attach, "cancel-attach"),
            Some(GOAL.to_owned()),
        )
        .await
        .unwrap();
    let attached_state = match &attached.receipt.result {
        ResultState::ProjectGoalLink { state, .. } => state.as_ref().clone(),
        result => panic!("unexpected project result: {result:?}"),
    };
    let cancel_command = project_goal_command_from_state(
        attached_state.rebase_scope(1, 7).unwrap(),
        Operation::Cancel,
        1,
        7,
        "cancel-link",
    );
    let cancelled = store
        .project_goal(cancel_command.clone(), Some(GOAL.to_owned()))
        .await
        .unwrap();
    assert!(!cancelled.replayed);
    assert_eq!(cancelled.receipt.version, 2);
    assert_eq!(cancelled.receipt.fence_epoch, 8);
    match &cancelled.receipt.result {
        ResultState::ProjectGoalLink {
            state,
            linked,
            cancelled,
            ..
        } => {
            assert!(state.cancelled);
            assert!(*linked);
            assert!(*cancelled);
        }
        result => panic!("unexpected project result: {result:?}"),
    }

    store
        .branding(branding_at("after-cancel-branding", 2, 8))
        .await
        .unwrap();
    let replay = store
        .project_goal(cancel_command, Some(GOAL.to_owned()))
        .await
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.receipt, cancelled.receipt);

    let cancelled_state = match &cancelled.receipt.result {
        ResultState::ProjectGoalLink { state, .. } => state.as_ref().clone(),
        result => panic!("unexpected project result: {result:?}"),
    };
    let error = store
        .project_goal(
            project_goal_command_from_state(
                cancelled_state.rebase_scope(3, 8).unwrap(),
                Operation::Attach,
                3,
                8,
                "cancel-new-key",
            ),
            Some(GOAL.to_owned()),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        StoreError::Link(rudder_project_goal_link_core::LinkMutationError::Cancelled)
    ));
    assert_eq!(database.counts().await, (3, 3, 3));
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_noop_persists_new_integrity_and_rejects_stale_context() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let first = store
        .project_goal(
            project_goal_command(GOAL, false, 0, Operation::Attach, "noop-attach"),
            Some(GOAL.to_owned()),
        )
        .await
        .unwrap();
    let first_state = match &first.receipt.result {
        ResultState::ProjectGoalLink { state, .. } => state.as_ref().clone(),
        result => panic!("unexpected project result: {result:?}"),
    };
    let noop = store
        .project_goal(
            project_goal_command_from_state(
                first_state.rebase_scope(1, 7).unwrap(),
                Operation::Attach,
                1,
                7,
                "noop-second-key",
            ),
            Some(GOAL.to_owned()),
        )
        .await
        .unwrap();
    assert_eq!(noop.receipt.outcome, rudder_d1_persistence::Outcome::Noop);
    assert_eq!(noop.receipt.version, 1);
    assert_eq!(noop.receipt.fence_epoch, 7);
    let noop_integrity = match &noop.receipt.result {
        ResultState::ProjectGoalLink { state, .. } => state.state_integrity().to_owned(),
        result => panic!("unexpected project result: {result:?}"),
    };
    assert_ne!(noop_integrity, first_state.state_integrity());

    let error = store
        .project_goal(
            project_goal_command_from_state(
                first_state.rebase_scope(1, 7).unwrap(),
                Operation::Attach,
                1,
                7,
                "noop-stale-context",
            ),
            Some(GOAL.to_owned()),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        StoreError::Link(rudder_project_goal_link_core::LinkMutationError::TargetStateMismatch)
    ));
    assert_eq!(database.counts().await, (1, 2, 2));
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_respects_owner_fence_and_ceo_authority_before_mutation() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());

    database
        .sql("UPDATE organization_mutation_state SET owner='node', fence_epoch=8, fence_token='60000000-0000-4000-8000-000000000001' WHERE org_id='10000000-0000-4000-8000-000000000001'")
        .await;
    assert!(matches!(
        store
            .project_goal(
                project_goal_command(GOAL, false, 0, Operation::Attach, "project-node-owned"),
                Some(GOAL.to_owned()),
            )
            .await,
        Err(StoreError::NotOwned)
    ));

    database
        .sql("UPDATE organization_mutation_state SET owner='rust', fence_epoch=9, fence_token='70000000-0000-4000-8000-000000000001' WHERE org_id='10000000-0000-4000-8000-000000000001'")
        .await;
    assert!(matches!(
        store
            .project_goal(
                project_goal_command(GOAL, false, 0, Operation::Attach, "project-stale-fence"),
                Some(GOAL.to_owned()),
            )
            .await,
        Err(StoreError::StaleFence)
    ));

    database
        .sql(
            "UPDATE agents SET status='terminated' WHERE id='50000000-0000-4000-8000-000000000001'",
        )
        .await;
    assert!(matches!(
        store
            .project_goal(
                project_goal_command_at_fence(
                    GOAL,
                    false,
                    0,
                    9,
                    Operation::Attach,
                    "project-inactive-ceo",
                ),
                Some(GOAL.to_owned()),
            )
            .await,
        Err(StoreError::Unauthorized)
    ));
    assert_eq!(database.counts().await, (0, 0, 0));
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_rejects_stale_version_and_bigint_overflow_without_partial_mutation() {
    let max = i64::MAX as u64;

    {
        let database = Database::start().await;
        let store = MutationStore::new(database.pool.clone());

        database
            .sql("UPDATE organization_mutation_state SET mutation_version=1 WHERE org_id='10000000-0000-4000-8000-000000000001'")
            .await;
        assert!(matches!(
            store
                .project_goal(
                    project_goal_command(
                        GOAL,
                        false,
                        0,
                        Operation::Attach,
                        "project-stale-version"
                    ),
                    Some(GOAL.to_owned()),
                )
                .await,
            Err(StoreError::StaleVersion)
        ));

        database
            .sql("UPDATE organization_mutation_state SET mutation_version=9223372036854775807, fence_epoch=7 WHERE org_id='10000000-0000-4000-8000-000000000001'")
            .await;
        assert!(matches!(
            store
                .project_goal(
                    project_goal_command(
                        GOAL,
                        false,
                        max,
                        Operation::Attach,
                        "project-version-overflow"
                    ),
                    Some(GOAL.to_owned()),
                )
                .await,
            Err(StoreError::VersionRange)
        ));
        assert_eq!(database.counts().await, (i64::MAX, 0, 0));
    }

    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    database
        .sql("UPDATE organization_mutation_state SET fence_epoch=9223372036854775807, fence_token='80000000-0000-4000-8000-000000000001' WHERE org_id='10000000-0000-4000-8000-000000000001'")
        .await;
    assert!(matches!(
        store
            .project_goal(
                project_goal_command_at_fence(
                    GOAL,
                    false,
                    0,
                    max,
                    Operation::Cancel,
                    "project-fence-overflow",
                ),
                None,
            )
            .await,
        Err(StoreError::VersionRange)
    ));
    assert_eq!(database.counts().await, (0, 0, 0));
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_rolls_back_link_projection_and_receipt_on_audit_failure() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    database
        .sql(
            "CREATE FUNCTION fail_d1_project_activity() RETURNS trigger
             LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test project audit failure'; END; $$;
             CREATE TRIGGER fail_d1_project_activity_trigger
             BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION fail_d1_project_activity();",
        )
        .await;

    let error = store
        .project_goal(
            project_goal_command(GOAL, false, 0, Operation::Attach, "project-rollback"),
            Some(GOAL.to_owned()),
        )
        .await
        .unwrap_err();

    assert!(matches!(error, StoreError::Database(_)));
    assert_eq!(database.counts().await, (0, 0, 0));
    assert_eq!(project_primary(&database).await, None);
    assert!(project_goals(&database).await.is_empty());
    database
        .sql(
            "DROP TRIGGER fail_d1_project_activity_trigger ON activity_log;
             DROP FUNCTION fail_d1_project_activity();",
        )
        .await;
    store
        .project_goal(
            project_goal_command(GOAL, false, 0, Operation::Attach, "project-retry"),
            Some(GOAL.to_owned()),
        )
        .await
        .unwrap();
    assert_eq!(database.counts().await, (1, 1, 1));
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_rejects_the_1025th_link_without_partial_projection() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let mut goal_values = String::from("INSERT INTO goals (id, org_id, title) VALUES ");
    let mut link_values =
        String::from("INSERT INTO project_goals (project_id, goal_id, org_id) VALUES ");
    let mut first_goal = String::new();
    for index in 0..1024_u32 {
        let goal_id = format!("60000000-0000-4000-8000-{index:012x}");
        if index == 0 {
            first_goal = goal_id.clone();
        }
        if index > 0 {
            goal_values.push_str(", ");
            link_values.push_str(", ");
        }
        goal_values.push_str(&format!(
            "('{goal_id}'::uuid, '{ORG}'::uuid, 'Capacity goal')"
        ));
        link_values.push_str(&format!(
            "('{PROJECT}'::uuid, '{goal_id}'::uuid, '{ORG}'::uuid)"
        ));
    }
    database.sql(&goal_values).await;
    database.sql(&link_values).await;
    database
        .sql(&format!(
            "UPDATE projects SET goal_id='{first_goal}'::uuid WHERE id='{PROJECT}'::uuid"
        ))
        .await;

    let error = store
        .project_goal(
            project_goal_command(GOAL, false, 0, Operation::Attach, "project-capacity"),
            Some(first_goal.clone()),
        )
        .await
        .unwrap_err();

    assert!(matches!(error, StoreError::InvalidInput));
    assert_eq!(database.counts().await, (0, 0, 0));
    assert_eq!(
        project_primary(&database).await.as_deref(),
        Some(first_goal.as_str())
    );
    assert_eq!(project_goals(&database).await.len(), 1024);
}

#[test]
fn project_goal_entry_consumes_an_opaque_core_command_without_a_second_json_path() {
    fn accepts_command(
        store: &MutationStore,
        command: rudder_project_goal_link_core::ProjectGoalLinkCommand,
    ) {
        let _future = store.project_goal(command, None);
    }

    let _ = accepts_command;
}
