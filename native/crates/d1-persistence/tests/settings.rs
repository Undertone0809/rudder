mod support;

use rudder_d1_persistence::{MutationStore, ResultState, StoreError};
use rudder_organization_mutation_core::{
    OrganizationSettingsCommand, OrganizationSettingsIntentContext,
    OrganizationSettingsIntentSourceKind,
};
use serde_json::json;
use sqlx::Row;
use support::{ASSET, Database, FOREIGN_ASSET, ORG};

const SECOND_ASSET: &str = "40000000-0000-4000-8000-000000000003";
const INTENT_ID: &str = "70000000-0000-4000-8000-000000000001";
const CONVERSATION: &str = "70000000-0000-4000-8000-000000000002";
const PROPOSAL_MESSAGE: &str = "70000000-0000-4000-8000-000000000003";
const APPROVAL_ID: &str = "70000000-0000-4000-8000-000000000006";
const APPROVAL_CONVERSATION: &str = "70000000-0000-4000-8000-000000000007";
const APPROVAL_MESSAGE: &str = "70000000-0000-4000-8000-000000000008";
const APPROVAL_INTENT_ID: &str = "70000000-0000-4000-8000-000000000009";

fn settings(key: &str, version: u64) -> OrganizationSettingsCommand {
    OrganizationSettingsCommand::board(ORG, "board-user", key, version, 7)
}

fn mixed_settings(key: &str, version: u64) -> OrganizationSettingsCommand {
    settings(key, version)
        .with_name("Rudder Cloud")
        .with_description(Some("The agent work platform".to_owned()))
        .with_status("paused")
        .with_budget_monthly_cents(1200)
        .with_spent_monthly_cents(300)
        .with_default_chat_issue_creation_mode("auto_create")
        .with_require_board_approval_for_new_agents(false)
        .with_issue_prefix(" rud ")
        .with_brand_color(Some("#336699".to_owned()))
        .with_logo_asset_id(Some(SECOND_ASSET.to_owned()))
}

async fn seed_settings_rows(database: &Database) {
    database
        .sql(
            "INSERT INTO issues (id, org_id, title, issue_number, identifier)
             VALUES
               ('60000000-0000-4000-8000-000000000001'::uuid, '10000000-0000-4000-8000-000000000001'::uuid, 'First', 1, 'A-1'),
               ('60000000-0000-4000-8000-000000000002'::uuid, '10000000-0000-4000-8000-000000000001'::uuid, 'Second', 2, 'A-2');
             INSERT INTO assets
               (id, org_id, provider, object_key, content_type, byte_size, sha256)
             VALUES
               ('40000000-0000-4000-8000-000000000003'::uuid, '10000000-0000-4000-8000-000000000001'::uuid, 'local', 'synthetic-second', 'image/png', 1, 'synthetic-second');
             INSERT INTO organization_logos (org_id, asset_id)
             VALUES ('10000000-0000-4000-8000-000000000001'::uuid, '40000000-0000-4000-8000-000000000001'::uuid);",
        )
        .await;
}

async fn organization_settings(
    database: &Database,
) -> (
    String,
    Option<String>,
    String,
    i32,
    i32,
    String,
    bool,
    String,
) {
    let row = sqlx::query(
        "SELECT name, description, status, budget_monthly_cents,
                spent_monthly_cents, default_chat_issue_creation_mode,
                require_board_approval_for_new_agents, issue_prefix
         FROM organizations
         WHERE id=$1::uuid",
    )
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    (
        row.try_get("name").unwrap(),
        row.try_get("description").unwrap(),
        row.try_get("status").unwrap(),
        row.try_get("budget_monthly_cents").unwrap(),
        row.try_get("spent_monthly_cents").unwrap(),
        row.try_get("default_chat_issue_creation_mode").unwrap(),
        row.try_get("require_board_approval_for_new_agents")
            .unwrap(),
        row.try_get("issue_prefix").unwrap(),
    )
}

async fn issue_identifiers(database: &Database) -> Vec<(i32, String)> {
    sqlx::query_as(
        "SELECT issue_number, identifier
         FROM issues
         WHERE org_id=$1::uuid
         ORDER BY issue_number",
    )
    .bind(ORG)
    .fetch_all(&database.pool)
    .await
    .unwrap()
}

async fn logo_asset(database: &Database) -> Option<String> {
    sqlx::query_scalar(
        "SELECT asset_id::text
         FROM organization_logos
         WHERE org_id=$1::uuid",
    )
    .bind(ORG)
    .fetch_optional(&database.pool)
    .await
    .unwrap()
}

async fn asset_exists(database: &Database, asset_id: &str) -> bool {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM assets WHERE id=$1::uuid)")
        .bind(asset_id)
        .fetch_one(&database.pool)
        .await
        .unwrap()
}

async fn seed_chat_source(database: &Database) {
    database
        .sql(
            "INSERT INTO chat_conversations (id, org_id, title)
             VALUES ('70000000-0000-4000-8000-000000000002'::uuid,
                     '10000000-0000-4000-8000-000000000001'::uuid,
                     'Settings proposal');
             INSERT INTO chat_messages (id, org_id, conversation_id, role, body)
             VALUES ('70000000-0000-4000-8000-000000000003'::uuid,
                     '10000000-0000-4000-8000-000000000001'::uuid,
                     '70000000-0000-4000-8000-000000000002'::uuid,
                     'user', 'Update the organization settings');",
        )
        .await;
}

async fn seed_approval_chat_source(database: &Database) {
    database
        .sql(
            r#"INSERT INTO chat_conversations (id, org_id, title)
             VALUES ('70000000-0000-4000-8000-000000000007'::uuid,
                     '10000000-0000-4000-8000-000000000001'::uuid,
                     'Approval proposal');
             INSERT INTO approvals (id, org_id, type, payload)
             VALUES ('70000000-0000-4000-8000-000000000006'::uuid,
                     '10000000-0000-4000-8000-000000000001'::uuid,
                     'organization_settings', '{"name":"Approval Intent Name"}'::jsonb);
             INSERT INTO chat_messages (id, org_id, conversation_id, role, body, approval_id)
             VALUES ('70000000-0000-4000-8000-000000000008'::uuid,
                     '10000000-0000-4000-8000-000000000001'::uuid,
                     '70000000-0000-4000-8000-000000000007'::uuid,
                     'assistant', 'Approve the organization settings update',
                     '70000000-0000-4000-8000-000000000006'::uuid);
            "#,
        )
        .await;
}

fn lightweight_command(
    key: &str,
    version: u64,
    claim_token: Option<&str>,
) -> (
    OrganizationSettingsCommand,
    OrganizationSettingsIntentContext,
) {
    let base = settings(key, version).with_name("Intent Name");
    let mut context = OrganizationSettingsIntentContext {
        intent_id: INTENT_ID.to_owned(),
        organization_id: ORG.to_owned(),
        source_kind: OrganizationSettingsIntentSourceKind::ChatLightweight,
        source_id: PROPOSAL_MESSAGE.to_owned(),
        approval_id: None,
        conversation_id: Some(CONVERSATION.to_owned()),
        proposal_message_id: Some(PROPOSAL_MESSAGE.to_owned()),
        actor_user_id: None,
        actor_principal: "board".to_owned(),
        generation: 1,
        patch_fingerprint: base.patch_fingerprint().unwrap(),
        intent_fingerprint: String::new(),
        rust_idempotency_key: key.to_owned(),
        claim_token: claim_token.map(str::to_owned),
    };
    let command_with_empty_intent = base.clone().with_intent_context(context.clone());
    context.intent_fingerprint = command_with_empty_intent.intent_fingerprint().unwrap();
    let command = base.with_intent_context(context.clone());
    (command, context)
}

fn approval_command(
    key: &str,
    version: u64,
    claim_token: Option<&str>,
) -> (
    OrganizationSettingsCommand,
    OrganizationSettingsIntentContext,
) {
    let base = settings(key, version).with_name("Approval Intent Name");
    let mut context = OrganizationSettingsIntentContext {
        intent_id: APPROVAL_INTENT_ID.to_owned(),
        organization_id: ORG.to_owned(),
        source_kind: OrganizationSettingsIntentSourceKind::ChatApproval,
        source_id: APPROVAL_ID.to_owned(),
        approval_id: Some(APPROVAL_ID.to_owned()),
        conversation_id: Some(APPROVAL_CONVERSATION.to_owned()),
        proposal_message_id: Some(APPROVAL_MESSAGE.to_owned()),
        actor_user_id: Some("board-user".to_owned()),
        actor_principal: "board".to_owned(),
        generation: 1,
        patch_fingerprint: base.patch_fingerprint().unwrap(),
        intent_fingerprint: String::new(),
        rust_idempotency_key: key.to_owned(),
        claim_token: claim_token.map(str::to_owned),
    };
    let command_with_empty_intent = base.clone().with_intent_context(context.clone());
    context.intent_fingerprint = command_with_empty_intent.intent_fingerprint().unwrap();
    let command = base.with_intent_context(context.clone());
    (command, context)
}

async fn insert_lightweight_intent(
    database: &Database,
    command: &OrganizationSettingsCommand,
    context: &OrganizationSettingsIntentContext,
    claim_token: Option<&str>,
) {
    let patch = serde_json::to_string(&command.patch.normalized().unwrap()).unwrap();
    match claim_token {
        Some(claim_token) => {
            sqlx::query(
                "INSERT INTO organization_mutation_intents
                   (id, org_id, source_kind, source_id, conversation_id,
                    proposal_message_id, actor_principal, generation, patch,
                    patch_fingerprint, intent_fingerprint, rust_idempotency_key,
                    phase, claim_token, claim_owner, lease_expires_at)
                 VALUES ($1::uuid, $2::uuid, 'chat_lightweight', $3::uuid,
                         $4::uuid, $5::uuid, 'board', $6, $7::jsonb, $8, $9,
                         $10, 'claimed', $11::uuid, 'settings-worker', now() + interval '5 minutes')",
            )
            .bind(&context.intent_id)
            .bind(ORG)
            .bind(&context.source_id)
            .bind(context.conversation_id.as_deref().unwrap())
            .bind(context.proposal_message_id.as_deref().unwrap())
            .bind(i64::try_from(context.generation).unwrap())
            .bind(patch)
            .bind(&context.patch_fingerprint)
            .bind(&context.intent_fingerprint)
            .bind(&context.rust_idempotency_key)
            .bind(claim_token)
            .execute(&database.pool)
            .await
            .unwrap();
        }
        None => {
            sqlx::query(
                "INSERT INTO organization_mutation_intents
                   (id, org_id, source_kind, source_id, conversation_id,
                    proposal_message_id, actor_principal, generation, patch,
                    patch_fingerprint, intent_fingerprint, rust_idempotency_key)
                 VALUES ($1::uuid, $2::uuid, 'chat_lightweight', $3::uuid,
                         $4::uuid, $5::uuid, 'board', $6, $7::jsonb, $8, $9, $10)",
            )
            .bind(&context.intent_id)
            .bind(ORG)
            .bind(&context.source_id)
            .bind(context.conversation_id.as_deref().unwrap())
            .bind(context.proposal_message_id.as_deref().unwrap())
            .bind(i64::try_from(context.generation).unwrap())
            .bind(patch)
            .bind(&context.patch_fingerprint)
            .bind(&context.intent_fingerprint)
            .bind(&context.rust_idempotency_key)
            .execute(&database.pool)
            .await
            .unwrap();
        }
    }
}

async fn insert_approval_intent(
    database: &Database,
    command: &OrganizationSettingsCommand,
    context: &OrganizationSettingsIntentContext,
    claim_token: Option<&str>,
) {
    let patch = serde_json::to_string(&command.patch.normalized().unwrap()).unwrap();
    match claim_token {
        Some(claim_token) => {
            sqlx::query(
                "INSERT INTO organization_mutation_intents
                   (id, org_id, source_kind, source_id, approval_id, conversation_id,
                    proposal_message_id, actor_user_id, actor_principal, generation, patch,
                    patch_fingerprint, intent_fingerprint, rust_idempotency_key,
                    phase, claim_token, claim_owner, lease_expires_at)
                 VALUES ($1::uuid, $2::uuid, 'chat_approval', $3::uuid, $4::uuid,
                         $5::uuid, $6::uuid, 'board-user', 'board', $7, $8::jsonb, $9, $10,
                         $11, 'claimed', $12::uuid, 'settings-worker', now() + interval '5 minutes')",
            )
            .bind(&context.intent_id)
            .bind(ORG)
            .bind(&context.source_id)
            .bind(context.approval_id.as_deref().unwrap())
            .bind(context.conversation_id.as_deref().unwrap())
            .bind(context.proposal_message_id.as_deref().unwrap())
            .bind(i64::try_from(context.generation).unwrap())
            .bind(patch)
            .bind(&context.patch_fingerprint)
            .bind(&context.intent_fingerprint)
            .bind(&context.rust_idempotency_key)
            .bind(claim_token)
            .execute(&database.pool)
            .await
            .unwrap();
        }
        None => {
            sqlx::query(
                "INSERT INTO organization_mutation_intents
                   (id, org_id, source_kind, source_id, approval_id, conversation_id,
                    proposal_message_id, actor_user_id, actor_principal, generation, patch,
                    patch_fingerprint, intent_fingerprint, rust_idempotency_key)
                 VALUES ($1::uuid, $2::uuid, 'chat_approval', $3::uuid, $4::uuid,
                         $5::uuid, $6::uuid, 'board-user', 'board', $7, $8::jsonb, $9, $10,
                         $11)",
            )
            .bind(&context.intent_id)
            .bind(ORG)
            .bind(&context.source_id)
            .bind(context.approval_id.as_deref().unwrap())
            .bind(context.conversation_id.as_deref().unwrap())
            .bind(context.proposal_message_id.as_deref().unwrap())
            .bind(i64::try_from(context.generation).unwrap())
            .bind(patch)
            .bind(&context.patch_fingerprint)
            .bind(&context.intent_fingerprint)
            .bind(&context.rust_idempotency_key)
            .execute(&database.pool)
            .await
            .unwrap();
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_commits_mixed_fields_prefix_aliases_logo_and_audit_atomically() {
    let database = Database::start().await;
    seed_settings_rows(&database).await;
    let store = MutationStore::new(database.pool.clone());

    let command = mixed_settings("settings-mixed", 0);
    let committed = store.settings(command).await.unwrap();

    assert!(!committed.replayed);
    assert_eq!(committed.receipt.version, 1);
    assert_eq!(committed.receipt.fence_epoch, 7);
    assert_eq!(
        organization_settings(&database).await,
        (
            "Rudder Cloud".to_owned(),
            Some("The agent work platform".to_owned()),
            "paused".to_owned(),
            1200,
            300,
            "auto_create".to_owned(),
            false,
            "RUD".to_owned(),
        )
    );
    assert_eq!(database.brand_color().await.as_deref(), Some("#336699"));
    assert_eq!(
        issue_identifiers(&database).await,
        vec![(1, "RUD-1".to_owned()), (2, "RUD-2".to_owned())]
    );
    assert_eq!(logo_asset(&database).await.as_deref(), Some(SECOND_ASSET));
    assert!(!asset_exists(&database, ASSET).await);
    assert!(asset_exists(&database, SECOND_ASSET).await);

    match &committed.receipt.result {
        ResultState::OrganizationSettings { state, .. } => {
            assert_eq!(state.issue_prefix_aliases, vec!["A".to_owned()]);
            assert_eq!(state.issue_identifier_rewrites, 2);
            assert_eq!(state.logo_asset_id.as_deref(), Some(SECOND_ASSET));
        }
        result => panic!("unexpected settings result: {result:?}"),
    }

    let details: serde_json::Value = sqlx::query_scalar(
        "SELECT details
         FROM activity_log
         WHERE org_id=$1::uuid AND id=$2::uuid AND action='organization.updated'",
    )
    .bind(ORG)
    .bind(&committed.receipt.activity_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(
        details["auditSurface"],
        json!([
            "name",
            "description",
            "status",
            "budgetMonthlyCents",
            "spentMonthlyCents",
            "defaultChatIssueCreationMode",
            "requireBoardApprovalForNewAgents",
            "issuePrefix",
            "brandColor",
            "logoAssetId"
        ])
    );
    assert_eq!(details["issueIdentifierRewrites"], 2);
    assert_eq!(details["issuePrefixAliases"], json!(["A"]));
    assert_eq!(
        sqlx::query_scalar::<_, i32>(
            "SELECT receipt_format
             FROM organization_mutation_receipts
             WHERE org_id=$1::uuid AND idempotency_key='settings-mixed'",
        )
        .bind(ORG)
        .fetch_one(&database.pool)
        .await
        .unwrap(),
        2
    );

    let cleared = store
        .settings(settings("settings-logo-clear", 1).with_logo_asset_id(None))
        .await
        .unwrap();
    assert_eq!(cleared.receipt.version, 2);
    assert_eq!(logo_asset(&database).await, None);
    assert!(!asset_exists(&database, SECOND_ASSET).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_rolls_back_business_rows_receipt_and_outbox_when_activity_fails() {
    let database = Database::start().await;
    seed_settings_rows(&database).await;
    database
        .sql(
            "CREATE OR REPLACE FUNCTION rudder_test_reject_settings_activity() RETURNS trigger
             LANGUAGE plpgsql AS $$
             BEGIN
               IF NEW.action = 'organization.updated' THEN
                 RAISE EXCEPTION 'settings activity blocked';
               END IF;
               RETURN NEW;
             END;
             $$;
             CREATE TRIGGER rudder_test_reject_settings_activity
             BEFORE INSERT ON activity_log
             FOR EACH ROW EXECUTE FUNCTION rudder_test_reject_settings_activity();",
        )
        .await;
    let store = MutationStore::new(database.pool.clone());

    let error = store
        .settings(mixed_settings("settings-rollback", 0))
        .await
        .unwrap_err();
    assert!(matches!(error, StoreError::Database(_)));

    database
        .sql(
            "DROP TRIGGER rudder_test_reject_settings_activity ON activity_log;
             DROP FUNCTION rudder_test_reject_settings_activity();",
        )
        .await;
    assert_eq!(
        organization_settings(&database).await,
        (
            "Original".to_owned(),
            None,
            "active".to_owned(),
            0,
            0,
            "manual_approval".to_owned(),
            true,
            "A".to_owned(),
        )
    );
    assert_eq!(
        issue_identifiers(&database).await,
        vec![(1, "A-1".to_owned()), (2, "A-2".to_owned())]
    );
    assert_eq!(logo_asset(&database).await.as_deref(), Some(ASSET));
    assert!(asset_exists(&database, ASSET).await);
    assert!(asset_exists(&database, SECOND_ASSET).await);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM organization_issue_prefix_aliases WHERE org_id=$1::uuid",
        )
        .bind(ORG)
        .fetch_one(&database.pool)
        .await
        .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM organization_mutation_receipts WHERE org_id=$1::uuid",
        )
        .bind(ORG)
        .fetch_one(&database.pool)
        .await
        .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM organization_mutation_outbox WHERE org_id=$1::uuid",
        )
        .bind(ORG)
        .fetch_one(&database.pool)
        .await
        .unwrap(),
        0
    );
    assert_eq!(database.counts().await, (0, 0, 0));
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_rolls_back_prefix_and_issue_rewrites_when_logo_is_foreign() {
    let database = Database::start().await;
    seed_settings_rows(&database).await;
    let store = MutationStore::new(database.pool.clone());

    let error = store
        .settings(
            settings("settings-foreign-logo", 0)
                .with_name("Should Roll Back")
                .with_issue_prefix(" rud ")
                .with_logo_asset_id(Some(FOREIGN_ASSET.to_owned())),
        )
        .await
        .unwrap_err();
    assert!(matches!(error, StoreError::InvalidInput));

    assert_eq!(
        organization_settings(&database).await,
        (
            "Original".to_owned(),
            None,
            "active".to_owned(),
            0,
            0,
            "manual_approval".to_owned(),
            true,
            "A".to_owned(),
        )
    );
    assert_eq!(
        issue_identifiers(&database).await,
        vec![(1, "A-1".to_owned()), (2, "A-2".to_owned())]
    );
    assert_eq!(logo_asset(&database).await.as_deref(), Some(ASSET));
    assert!(asset_exists(&database, ASSET).await);
    assert!(asset_exists(&database, SECOND_ASSET).await);
    assert!(asset_exists(&database, FOREIGN_ASSET).await);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM organization_issue_prefix_aliases WHERE org_id=$1::uuid",
        )
        .bind(ORG)
        .fetch_one(&database.pool)
        .await
        .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM organization_mutation_receipts WHERE org_id=$1::uuid",
        )
        .bind(ORG)
        .fetch_one(&database.pool)
        .await
        .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM organization_mutation_outbox WHERE org_id=$1::uuid",
        )
        .bind(ORG)
        .fetch_one(&database.pool)
        .await
        .unwrap(),
        0
    );
    assert_eq!(database.counts().await, (0, 0, 0));
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_replays_format_two_and_rejects_conflict_or_wrong_format() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let command = settings("settings-replay", 0).with_name("Replay Name");
    let first = store.settings(command.clone()).await.unwrap();

    let replay = store.settings(command.clone()).await.unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.receipt, first.receipt);

    let conflict = store
        .settings(settings("settings-replay", 0).with_name("Conflict Name"))
        .await
        .unwrap_err();
    assert!(matches!(conflict, StoreError::IdempotencyConflict));

    database
        .sql(
            "ALTER TABLE organization_mutation_receipts
             DISABLE TRIGGER organization_mutation_receipts_guard;
             UPDATE organization_mutation_receipts
             SET receipt_format=1
             WHERE org_id='10000000-0000-4000-8000-000000000001'::uuid
               AND idempotency_key='settings-replay';
             ALTER TABLE organization_mutation_receipts
             ENABLE TRIGGER organization_mutation_receipts_guard;",
        )
        .await;
    let invalid_format = store.settings(command).await.unwrap_err();
    assert!(matches!(invalid_format, StoreError::InvalidReceipt));
    assert_eq!(database.counts().await, (1, 1, 1));
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_re_reads_immutable_intent_payload_before_mutating() {
    let database = Database::start().await;
    seed_chat_source(&database).await;
    let (command, context) = lightweight_command("settings-intent-tamper", 0, None);
    insert_lightweight_intent(&database, &command, &context, None).await;
    database
        .sql(
            r#"ALTER TABLE organization_mutation_intents
             DISABLE TRIGGER organization_mutation_intents_guard;
             UPDATE organization_mutation_intents
             SET patch='{"name":"Tampered"}'::jsonb
             WHERE id='70000000-0000-4000-8000-000000000001'::uuid;
             ALTER TABLE organization_mutation_intents
             ENABLE TRIGGER organization_mutation_intents_guard;"#,
        )
        .await;

    let store = MutationStore::new(database.pool.clone());
    assert!(matches!(
        store.settings(command).await,
        Err(StoreError::InvalidIntent)
    ));
    assert_eq!(database.name().await, "Original");
    assert_eq!(database.counts().await, (0, 0, 0));
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_rejects_unclaimed_intent_after_chat_source_cleanup() {
    let database = Database::start().await;
    seed_chat_source(&database).await;
    let (command, context) = lightweight_command("settings-source-cleanup-pending", 0, None);
    insert_lightweight_intent(&database, &command, &context, None).await;
    database
        .sql(
            "DELETE FROM chat_conversations WHERE id='70000000-0000-4000-8000-000000000002'::uuid;",
        )
        .await;

    let store = MutationStore::new(database.pool.clone());
    assert!(matches!(
        store.settings(command).await,
        Err(StoreError::InvalidIntent)
    ));
    assert_eq!(database.name().await, "Original");
    assert_eq!(database.counts().await, (0, 0, 0));
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_rejects_stale_claim_then_replays_completed_intent_after_source_cleanup() {
    let database = Database::start().await;
    seed_chat_source(&database).await;
    let claim_a = "70000000-0000-4000-8000-000000000004";
    let claim_b = "70000000-0000-4000-8000-000000000005";
    let (insert_command, insert_context) = lightweight_command("settings-claim", 0, Some(claim_a));
    insert_lightweight_intent(&database, &insert_command, &insert_context, Some(claim_a)).await;

    let (stale_command, _) = lightweight_command("settings-claim", 0, Some(claim_b));
    let store = MutationStore::new(database.pool.clone());
    assert!(matches!(
        store.settings(stale_command).await,
        Err(StoreError::StaleClaim)
    ));
    assert_eq!(database.name().await, "Original");

    database
        .sql(
            "UPDATE organization_mutation_intents
             SET claim_token='70000000-0000-4000-8000-000000000005'::uuid,
                 claim_owner='settings-worker-b',
                 lease_expires_at=now() + interval '5 minutes'
             WHERE id='70000000-0000-4000-8000-000000000001'::uuid;",
        )
        .await;
    database
        .sql(
            "DELETE FROM chat_conversations WHERE id='70000000-0000-4000-8000-000000000002'::uuid;",
        )
        .await;
    let (committing_command, _) = lightweight_command("settings-claim", 0, Some(claim_b));
    let committed = store.settings(committing_command).await.unwrap();
    assert!(!committed.replayed);
    assert_eq!(database.name().await, "Intent Name");

    database
        .sql(
            "UPDATE organization_mutation_intents
             SET phase='completed', downstream_completed_at=now()
             WHERE id='70000000-0000-4000-8000-000000000001'::uuid;",
        )
        .await;
    let (replay_command, _) = lightweight_command("settings-claim", 0, None);
    let replay = store.settings(replay_command).await.unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.receipt, committed.receipt);
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_recovers_claimed_approval_intent_after_approval_cleanup() {
    let database = Database::start().await;
    seed_approval_chat_source(&database).await;
    let claim = "70000000-0000-4000-8000-00000000000a";
    let (command, context) = approval_command("settings-approval-cleanup", 0, Some(claim));
    insert_approval_intent(&database, &command, &context, Some(claim)).await;
    database
        .sql("DELETE FROM approvals WHERE id='70000000-0000-4000-8000-000000000006'::uuid;")
        .await;

    let store = MutationStore::new(database.pool.clone());
    let committed = store.settings(command).await.unwrap();
    assert!(!committed.replayed);
    assert_eq!(database.name().await, "Approval Intent Name");
    assert_eq!(
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT approval_id::text
             FROM chat_messages
             WHERE id='70000000-0000-4000-8000-000000000008'::uuid",
        )
        .fetch_one(&database.pool)
        .await
        .unwrap(),
        None
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_accepts_claimed_approval_with_nullable_message_linkage() {
    let database = Database::start().await;
    seed_approval_chat_source(&database).await;
    let claim = "70000000-0000-4000-8000-00000000000b";
    let (command, context) = approval_command("settings-approval-null-link", 0, Some(claim));
    insert_approval_intent(&database, &command, &context, Some(claim)).await;
    database
        .sql(
            "UPDATE chat_messages
             SET approval_id=NULL
             WHERE id='70000000-0000-4000-8000-000000000008'::uuid;",
        )
        .await;

    let store = MutationStore::new(database.pool.clone());
    let committed = store.settings(command).await.unwrap();
    assert!(!committed.replayed);
    assert_eq!(database.name().await, "Approval Intent Name");
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT phase
             FROM organization_mutation_intents
             WHERE id='70000000-0000-4000-8000-000000000009'::uuid",
        )
        .fetch_one(&database.pool)
        .await
        .unwrap(),
        "rust_committed"
    );
}
