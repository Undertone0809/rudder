//! Explicitly opt-in disposable PostgreSQL coverage for the mutation executor.
//!
//! This test never reads the repository's default database setting. It requires a
//! caller-supplied connection URL, creates a uniquely named schema, installs a
//! documented faithful fixture for the mutation-relevant production columns and
//! constraints plus migrations `0163_issue_governance_mutations.sql` and
//! `0164_retain_issue_mutation_ledger.sql`, and drops the schema before returning—even
//! when the exercise task panics. The fixture keeps the production single-column
//! foreign keys; only the durable mutation ledger uses the composite organization
//! fences added by migration 0163.

use crate::issue_mutation::{
    ApprovalResubmissionOptions, CHECKOUT_COMMAND_TYPE, CheckoutOptions, HostApprovalCapability,
    IssueMutationError, IssueMutationRepository, TrustedApprovalAuthorization,
    TrustedOrganizationId, command_fingerprint,
};
use rudder_issue_core::{
    ActorRef, AgentId, ApprovalDecision, ApprovalDecisionCommand, ApprovalId, ApprovalRef,
    ApprovalResubmissionCommand, CheckoutCommand, IdempotencyKey, IssueId, IssueRef, IssueStatus,
    OrganizationId, ReviewDecision, ReviewDecisionCommand, RunId, UserId,
};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{env, error::Error, process, time::SystemTime};
use time::{Duration, OffsetDateTime};

const ORG_A: &str = "00000000-0000-0000-0000-000000000001";
const ORG_B: &str = "00000000-0000-0000-0000-000000000002";
const CHECKOUT_ISSUE_ID: &str = "00000000-0000-0000-0000-000000000010";
const FENCED_ISSUE_ID: &str = "00000000-0000-0000-0000-000000000011";
const REVIEW_DONE_ISSUE_ID: &str = "00000000-0000-0000-0000-000000000012";
const REVIEW_PROGRESS_ISSUE_ID: &str = "00000000-0000-0000-0000-000000000013";
const FAILURE_ISSUE_ID: &str = "00000000-0000-0000-0000-000000000014";
const AGENT_A: &str = "00000000-0000-0000-0000-000000000020";
const AGENT_B: &str = "00000000-0000-0000-0000-000000000021";
const RUN_A: &str = "00000000-0000-0000-0000-000000000030";
const RUN_B: &str = "00000000-0000-0000-0000-000000000031";
const RUN_C: &str = "00000000-0000-0000-0000-000000000032";
const APPROVAL_ID: &str = "00000000-0000-0000-0000-000000000040";
const AMBIGUOUS_APPROVAL_ID: &str = "00000000-0000-0000-0000-000000000041";
const BOARD_USER_ID: &str = "board-user";

#[tokio::test]
#[ignore = "explicit opt-in: set RUDDER_DB_CORE_ISSUE_MUTATION_DATABASE_URL to a disposable PostgreSQL instance"]
async fn issue_mutations_execute_replay_and_fence_all_relevant_rows()
-> Result<(), Box<dyn Error + Send + Sync>> {
    let url = env::var("RUDDER_DB_CORE_ISSUE_MUTATION_DATABASE_URL")
        .map_err(|_| "explicit disposable PostgreSQL URL is required")?;
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await?;
    let schema = disposable_schema_name();
    let quoted_schema = quote_identifier(&schema);

    sqlx::query(&format!("CREATE SCHEMA {quoted_schema}"))
        .execute(&pool)
        .await?;

    let task_pool = pool.clone();
    let task_schema = quoted_schema.clone();
    let exercise =
        tokio::spawn(async move { exercise_mutations(&task_pool, &task_schema).await }).await;

    let cleanup = sqlx::query(&format!("DROP SCHEMA {quoted_schema} CASCADE"))
        .execute(&pool)
        .await;
    pool.close().await;
    cleanup?;

    match exercise {
        Ok(result) => result?,
        Err(join_error) => return Err(format!("mutation exercise panicked: {join_error}").into()),
    }
    Ok(())
}

fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn disposable_schema_name() -> String {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .expect("system clock after Unix epoch")
        .as_nanos();
    format!("rudder_issue_mutation_{}_{}", process::id(), nanos)
}

async fn exercise_mutations(
    pool: &PgPool,
    quoted_schema: &str,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    sqlx::query(&format!("SET search_path TO {quoted_schema}"))
        .execute(pool)
        .await?;
    create_fixture(pool).await?;

    let scope = TrustedOrganizationId::from_host(OrganizationId::new(ORG_A));
    let agent_a = AgentId::new(AGENT_A);
    let run_a = RunId::new(RUN_A);
    let checkout_command = CheckoutCommand::new(
        IssueRef::new(OrganizationId::new(ORG_A), IssueId::new(CHECKOUT_ISSUE_ID)),
        ActorRef::agent(
            OrganizationId::new(ORG_A),
            agent_a.clone(),
            Some(run_a.clone()),
        ),
        agent_a.clone(),
        Some(run_a),
        [IssueStatus::Todo],
        0,
        0,
        IdempotencyKey::new("integration-checkout-key"),
    );
    let checkout_options =
        CheckoutOptions::with_lease(1, Some(OffsetDateTime::now_utc() + Duration::minutes(5)));
    let repository = IssueMutationRepository::new(pool.clone());
    let first_checkout = repository
        .checkout(&scope, checkout_command.clone(), checkout_options.clone())
        .await
        .map_err(|error| format!("first checkout failed: {error:?}"))?;
    sqlx::query("UPDATE heartbeat_runs SET status = 'succeeded' WHERE id = $1::uuid")
        .bind(RUN_A)
        .execute(pool)
        .await?;
    let replay_checkout = repository
        .checkout(&scope, checkout_command, checkout_options)
        .await?;
    assert!(!first_checkout.replayed);
    assert!(replay_checkout.replayed);
    assert_eq!(first_checkout.ledger_id, replay_checkout.ledger_id);
    assert_eq!(first_checkout.activity_id, replay_checkout.activity_id);
    assert_eq!(first_checkout.outcome, replay_checkout.outcome);
    sqlx::query("UPDATE heartbeat_runs SET status = 'running' WHERE id = $1::uuid")
        .bind(RUN_A)
        .execute(pool)
        .await?;

    let stale_checkout_command = CheckoutCommand::new(
        IssueRef::new(OrganizationId::new(ORG_A), IssueId::new(FENCED_ISSUE_ID)),
        ActorRef::agent(
            OrganizationId::new(ORG_A),
            agent_a.clone(),
            Some(RunId::new(RUN_A)),
        ),
        agent_a.clone(),
        Some(RunId::new(RUN_A)),
        [IssueStatus::Todo],
        1,
        0,
        IdempotencyKey::new("integration-stale-fence-key"),
    );
    let stale_checkout = repository
        .checkout(&scope, stale_checkout_command, CheckoutOptions::new(1))
        .await;
    assert!(matches!(
        stale_checkout,
        Err(IssueMutationError::Domain(
            rudder_issue_core::DomainError::RevisionMismatch { .. }
        ))
    ));

    let invalid_run_command = CheckoutCommand::new(
        IssueRef::new(OrganizationId::new(ORG_A), IssueId::new(FENCED_ISSUE_ID)),
        ActorRef::agent(
            OrganizationId::new(ORG_A),
            AgentId::new(AGENT_A),
            Some(RunId::new(RUN_C)),
        ),
        AgentId::new(AGENT_A),
        Some(RunId::new(RUN_C)),
        [IssueStatus::Todo],
        0,
        0,
        IdempotencyKey::new("integration-cross-scope-run-key"),
    );
    let invalid_run = repository
        .checkout(&scope, invalid_run_command, CheckoutOptions::new(1))
        .await;
    assert!(matches!(
        invalid_run,
        Err(IssueMutationError::NotFound { entity: "run", .. })
    ));

    let review_agent = ActorRef::agent(
        OrganizationId::new(ORG_A),
        AgentId::new(AGENT_A),
        Some(RunId::new(RUN_A)),
    );
    let approve_review = ReviewDecisionCommand::new(
        IssueRef::new(
            OrganizationId::new(ORG_A),
            IssueId::new(REVIEW_DONE_ISSUE_ID),
        ),
        review_agent,
        ReviewDecision::Approve,
        "approved by integration",
        0,
        0,
        IdempotencyKey::new("integration-review-done-key"),
    );
    repository.decide_review(&scope, approve_review).await?;

    let progress_review = ReviewDecisionCommand::new(
        IssueRef::new(
            OrganizationId::new(ORG_A),
            IssueId::new(REVIEW_PROGRESS_ISSUE_ID),
        ),
        ActorRef::user(OrganizationId::new(ORG_A), UserId::new(BOARD_USER_ID)),
        ReviewDecision::RequestChanges,
        "needs another pass",
        0,
        0,
        IdempotencyKey::new("integration-review-progress-key"),
    );
    repository.decide_review(&scope, progress_review).await?;

    let board_actor = ActorRef::user(OrganizationId::new(ORG_A), UserId::new(BOARD_USER_ID));
    let approval_ref = ApprovalRef::new(OrganizationId::new(ORG_A), ApprovalId::new(APPROVAL_ID));
    let authorization = TrustedApprovalAuthorization::from_host(
        &HostApprovalCapability::for_tests(),
        scope.clone(),
        ApprovalId::new(APPROVAL_ID),
        board_actor.clone(),
    )
    .map_err(|error| format!("approval authorization failed: {error}"))?;
    let request_changes = ApprovalDecisionCommand::new(
        approval_ref.clone(),
        board_actor.clone(),
        ApprovalDecision::RequestChanges,
        Some("please revise".into()),
        0,
        IdempotencyKey::new("integration-approval-revision-key"),
    );
    let revision = repository
        .decide_approval(&authorization, request_changes.clone())
        .await?;
    assert_eq!(revision.outcome["Recorded"]["status"], "revision_requested");
    let revision_replay = repository
        .decide_approval(&authorization, request_changes)
        .await?;
    assert!(revision_replay.replayed);
    assert_eq!(revision_replay.ledger_id, revision.ledger_id);
    assert_eq!(revision_replay.activity_id, revision.activity_id);

    let invalid_resubmission = ApprovalResubmissionCommand::new(
        approval_ref.clone(),
        board_actor.clone(),
        1,
        IdempotencyKey::new("integration-invalid-resubmit-key"),
    );
    let invalid_resubmission = repository
        .resubmit_approval(
            &authorization,
            invalid_resubmission,
            ApprovalResubmissionOptions::new(Some(json!({
                "issueIds": [CHECKOUT_ISSUE_ID, FENCED_ISSUE_ID]
            }))),
        )
        .await;
    assert!(matches!(
        invalid_resubmission,
        Err(IssueMutationError::InvalidStoredState { .. })
    ));

    let resubmission = ApprovalResubmissionCommand::new(
        approval_ref.clone(),
        board_actor.clone(),
        1,
        IdempotencyKey::new("integration-approval-resubmit-key"),
    );
    let pending = repository
        .resubmit_approval(
            &authorization,
            resubmission,
            ApprovalResubmissionOptions::new(Some(json!({"revision": 1}))),
        )
        .await?;
    assert_eq!(pending.outcome["Recorded"]["status"], "pending");

    let approve = ApprovalDecisionCommand::new(
        approval_ref,
        board_actor.clone(),
        ApprovalDecision::Approve,
        Some("approved after revision".into()),
        2,
        IdempotencyKey::new("integration-approval-approved-key"),
    );
    let approved = repository.decide_approval(&authorization, approve).await?;
    assert_eq!(approved.outcome["Recorded"]["status"], "approved");
    let approval_evidence: (Option<String>, Option<OffsetDateTime>, String) = sqlx::query_as(
        "SELECT decided_by_user_id, decided_at, status FROM approvals WHERE org_id = $1::uuid AND id = $2::uuid",
    )
    .bind(ORG_A)
    .bind(APPROVAL_ID)
    .fetch_one(pool)
    .await?;
    assert_eq!(approval_evidence.0.as_deref(), Some(BOARD_USER_ID));
    assert!(approval_evidence.1.is_some());
    assert_eq!(approval_evidence.2, "approved");

    let ambiguous_authorization = TrustedApprovalAuthorization::from_host(
        &HostApprovalCapability::for_tests(),
        scope.clone(),
        ApprovalId::new(AMBIGUOUS_APPROVAL_ID),
        board_actor.clone(),
    )?;
    let ambiguous_command = ApprovalDecisionCommand::new(
        ApprovalRef::new(
            OrganizationId::new(ORG_A),
            ApprovalId::new(AMBIGUOUS_APPROVAL_ID),
        ),
        board_actor.clone(),
        ApprovalDecision::Approve,
        None,
        0,
        IdempotencyKey::new("integration-ambiguous-approval-key"),
    );
    let ambiguous = repository
        .decide_approval(&ambiguous_authorization, ambiguous_command)
        .await;
    assert!(matches!(
        ambiguous,
        Err(IssueMutationError::InvalidStoredState { .. })
    ));
    let ambiguous_ledger_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM issue_mutation_commands WHERE org_id = $1::uuid AND idempotency_key = $2::text",
    )
    .bind(ORG_A)
    .bind("integration-ambiguous-approval-key")
    .fetch_one(pool)
    .await?;
    assert_eq!(ambiguous_ledger_count, 0);

    sqlx::query(
        "INSERT INTO activity_log (org_id, actor_type, actor_id, action, entity_type, entity_id, details, idempotency_key)\n         VALUES ($1::uuid, 'user', $2::text, 'test.failure_injection', 'issue', $3::text, '{}'::jsonb, $4::text)",
    )
    .bind(ORG_A)
    .bind(BOARD_USER_ID)
    .bind(FAILURE_ISSUE_ID)
    .bind("integration-failure-review-key")
    .execute(pool)
    .await?;
    let failed_review = ReviewDecisionCommand::new(
        IssueRef::new(OrganizationId::new(ORG_A), IssueId::new(FAILURE_ISSUE_ID)),
        ActorRef::user(OrganizationId::new(ORG_A), UserId::new(BOARD_USER_ID)),
        ReviewDecision::Approve,
        "must roll back",
        0,
        0,
        IdempotencyKey::new("integration-failure-review-key"),
    );
    let failed_review_result = repository.decide_review(&scope, failed_review).await;
    assert!(matches!(
        failed_review_result,
        Err(IssueMutationError::Database)
    ));
    let failure_state: (String, i64, i64) = sqlx::query_as(
        "SELECT status, revision, fencing_token FROM issues WHERE org_id = $1::uuid AND id = $2::uuid",
    )
    .bind(ORG_A)
    .bind(FAILURE_ISSUE_ID)
    .fetch_one(pool)
    .await?;
    assert_eq!(failure_state, ("in_review".into(), 0, 0));
    let failed_ledger_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM issue_mutation_commands WHERE org_id = $1::uuid AND idempotency_key = $2::text",
    )
    .bind(ORG_A)
    .bind("integration-failure-review-key")
    .fetch_one(pool)
    .await?;
    assert_eq!(failed_ledger_count, 0);

    let incomplete_command = CheckoutCommand::new(
        IssueRef::new(OrganizationId::new(ORG_A), IssueId::new(FENCED_ISSUE_ID)),
        ActorRef::agent(
            OrganizationId::new(ORG_A),
            AgentId::new(AGENT_A),
            Some(RunId::new(RUN_A)),
        ),
        AgentId::new(AGENT_A),
        Some(RunId::new(RUN_A)),
        [IssueStatus::Todo],
        0,
        0,
        IdempotencyKey::new("integration-incomplete-ledger-key"),
    );
    let incomplete_options = CheckoutOptions::new(1);
    let incomplete_fingerprint = command_fingerprint(
        CHECKOUT_COMMAND_TYPE,
        &scope,
        &incomplete_command,
        &incomplete_options,
    )?;
    sqlx::query(
        "INSERT INTO issue_mutation_commands (org_id, command_type, idempotency_key, command_fingerprint, outcome)\n         VALUES ($1::uuid, $2::text, $3::text, $4::text, '{\"state\":\"pending\"}'::jsonb)",
    )
    .bind(ORG_A)
    .bind(CHECKOUT_COMMAND_TYPE)
    .bind("integration-incomplete-ledger-key")
    .bind(incomplete_fingerprint)
    .execute(pool)
    .await?;
    let incomplete = repository
        .checkout(&scope, incomplete_command, incomplete_options)
        .await;
    assert!(matches!(
        incomplete,
        Err(IssueMutationError::IncompleteLedger { .. })
    ));
    let incomplete_row: (Value, Option<String>) = sqlx::query_as(
        "SELECT outcome, activity_id::text FROM issue_mutation_commands WHERE org_id = $1::uuid AND idempotency_key = $2::text",
    )
    .bind(ORG_A)
    .bind("integration-incomplete-ledger-key")
    .fetch_one(pool)
    .await?;
    assert_eq!(incomplete_row.0["state"], "pending");
    assert!(incomplete_row.1.is_none());

    let checkout_row: (String, i64, i64, String, String, bool) = sqlx::query_as(
        "SELECT status, revision, fencing_token, checkout_run_id::text, checkout_lease_owner, started_at IS NOT NULL\n           FROM issues WHERE org_id = $1::uuid AND id = $2::uuid",
    )
    .bind(ORG_A)
    .bind(CHECKOUT_ISSUE_ID)
    .fetch_one(pool)
    .await?;
    assert_eq!(checkout_row.0, "in_progress");
    assert_eq!(checkout_row.1, 1);
    assert_eq!(checkout_row.2, 1);
    assert_eq!(checkout_row.3, RUN_A);
    assert_eq!(checkout_row.4, AGENT_A);
    assert!(checkout_row.5);

    let review_rows: (String, bool, String, bool, Option<String>, Option<OffsetDateTime>) =
        sqlx::query_as(
            "SELECT done.status, done.completed_at IS NOT NULL, progress.status, progress.started_at IS NOT NULL, progress.execution_agent_name_key, progress.execution_locked_at\n           FROM issues AS done JOIN issues AS progress ON progress.org_id = done.org_id\n          WHERE done.org_id = $1::uuid AND done.id = $2::uuid AND progress.id = $3::uuid",
        )
    .bind(ORG_A)
    .bind(REVIEW_DONE_ISSUE_ID)
    .bind(REVIEW_PROGRESS_ISSUE_ID)
    .fetch_one(pool)
    .await?;
    assert_eq!(review_rows.0, "done");
    assert!(review_rows.1);
    assert_eq!(review_rows.2, "in_progress");
    assert!(review_rows.3);
    assert!(review_rows.4.is_none());
    assert!(review_rows.5.is_none());

    let comments: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT body, author_agent_id::text, author_user_id FROM issue_comments\n          WHERE org_id = $1::uuid ORDER BY created_at, id",
    )
    .bind(ORG_A)
    .fetch_all(pool)
    .await?;
    assert_eq!(comments.len(), 2);
    assert!(comments.iter().any(|comment| {
        comment.0 == "approved by integration"
            && comment.1.as_deref() == Some(AGENT_A)
            && comment.2.is_none()
    }));
    assert!(comments.iter().any(|comment| {
        comment.0 == "needs another pass"
            && comment.1.is_none()
            && comment.2.as_deref() == Some(BOARD_USER_ID)
    }));

    let counts: (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT\n             (SELECT count(*) FROM issue_mutation_commands WHERE org_id = $1::uuid),\n             (SELECT count(*) FROM activity_log WHERE org_id = $1::uuid),\n             (SELECT count(*) FROM issue_comments WHERE org_id = $1::uuid),\n             (SELECT count(*) FROM issue_mutation_commands WHERE org_id = $1::uuid AND outcome->>'state' = 'applied')",
    )
    .bind(ORG_A)
    .fetch_one(pool)
    .await?;
    assert_eq!(counts, (7, 7, 2, 6));
    Ok(())
}

async fn create_fixture(pool: &PgPool) -> Result<(), sqlx::Error> {
    for statement in [
        "CREATE TABLE organizations (id uuid PRIMARY KEY)",
        "CREATE TABLE agents (\n             id uuid PRIMARY KEY,\n             org_id uuid NOT NULL REFERENCES organizations(id),\n             name text NOT NULL,\n             UNIQUE (org_id, id)\n         )",
        "CREATE TABLE heartbeat_runs (\n             id uuid PRIMARY KEY,\n             org_id uuid NOT NULL REFERENCES organizations(id),\n             agent_id uuid NOT NULL REFERENCES agents(id),\n             status text NOT NULL,\n             created_at timestamptz NOT NULL DEFAULT now()\n         )",
        "CREATE TABLE issues (\n             id uuid PRIMARY KEY,\n             org_id uuid NOT NULL REFERENCES organizations(id),\n             title text NOT NULL,\n             status text NOT NULL,\n             assignee_agent_id uuid,\n             assignee_user_id text,\n             reviewer_agent_id uuid,\n             reviewer_user_id text,\n             revision bigint NOT NULL,\n             fencing_token bigint NOT NULL,\n             checkout_run_id uuid,\n             execution_run_id uuid,\n             execution_agent_name_key text,\n             execution_locked_at timestamptz,\n             checkout_lease_owner text,\n             checkout_lease_expires_at timestamptz,\n             started_at timestamptz,\n             completed_at timestamptz,\n             cancelled_at timestamptz,\n             updated_at timestamptz NOT NULL,\n             UNIQUE (org_id, id),\n             FOREIGN KEY (assignee_agent_id) REFERENCES agents(id),\n             FOREIGN KEY (reviewer_agent_id) REFERENCES agents(id),\n             FOREIGN KEY (checkout_run_id) REFERENCES heartbeat_runs(id),\n             FOREIGN KEY (execution_run_id) REFERENCES heartbeat_runs(id)\n         )",
        "CREATE TABLE approvals (\n             id uuid PRIMARY KEY,\n             org_id uuid NOT NULL REFERENCES organizations(id),\n             type text NOT NULL,\n             requested_by_agent_id uuid,\n             requested_by_user_id text,\n             status text NOT NULL,\n             revision bigint NOT NULL,\n             decision text,\n             decision_idempotency_key text,\n             decision_note text,\n             decided_by_user_id text,\n             decided_at timestamptz,\n             payload jsonb NOT NULL,\n             updated_at timestamptz NOT NULL,\n             UNIQUE (org_id, id),
             UNIQUE (org_id, decision_idempotency_key),\n             FOREIGN KEY (requested_by_agent_id) REFERENCES agents(id)\n         )",
        "CREATE TABLE issue_approvals (\n             org_id uuid NOT NULL REFERENCES organizations(id),\n             issue_id uuid NOT NULL,\n             approval_id uuid NOT NULL,\n             created_at timestamptz NOT NULL DEFAULT now(),\n             PRIMARY KEY (issue_id, approval_id),\n             FOREIGN KEY (issue_id) REFERENCES issues(id),\n             FOREIGN KEY (approval_id) REFERENCES approvals(id)\n         )",
        "CREATE TABLE issue_comments (\n             id uuid PRIMARY KEY DEFAULT (md5(random()::text || clock_timestamp()::text)::uuid),\n             org_id uuid NOT NULL REFERENCES organizations(id),\n             issue_id uuid NOT NULL,\n             author_agent_id uuid,\n             author_user_id text,\n             body text NOT NULL,\n             created_at timestamptz NOT NULL DEFAULT now(),\n             updated_at timestamptz NOT NULL DEFAULT now(),\n             FOREIGN KEY (issue_id) REFERENCES issues(id),\n             FOREIGN KEY (author_agent_id) REFERENCES agents(id)\n         )",
        "CREATE TABLE activity_log (\n             id uuid PRIMARY KEY DEFAULT (md5(random()::text || clock_timestamp()::text)::uuid),\n             org_id uuid NOT NULL REFERENCES organizations(id),\n             actor_type text NOT NULL,\n             actor_id text NOT NULL,\n             action text NOT NULL,\n             entity_type text NOT NULL,\n             entity_id text NOT NULL,\n             agent_id uuid,\n             run_id uuid,\n             details jsonb,\n             idempotency_key text,\n             created_at timestamptz NOT NULL DEFAULT now(),\n             UNIQUE (org_id, id),\n             UNIQUE (org_id, idempotency_key),\n             FOREIGN KEY (agent_id) REFERENCES agents(id),\n             FOREIGN KEY (run_id) REFERENCES heartbeat_runs(id)\n         )",
        "CREATE TABLE issue_mutation_commands (\n             id uuid PRIMARY KEY DEFAULT (md5(random()::text || clock_timestamp()::text)::uuid),\n             org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,\n             issue_id uuid,\n             approval_id uuid,\n             command_type text NOT NULL,\n             idempotency_key text NOT NULL,\n             command_fingerprint text NOT NULL,\n             outcome jsonb NOT NULL,\n             activity_id uuid,\n             created_at timestamptz NOT NULL DEFAULT now(),\n             UNIQUE (org_id, idempotency_key),\n             FOREIGN KEY (org_id, issue_id) REFERENCES issues(org_id, id) ON DELETE RESTRICT,\n             FOREIGN KEY (org_id, approval_id) REFERENCES approvals(org_id, id) ON DELETE RESTRICT,\n             FOREIGN KEY (org_id, activity_id) REFERENCES activity_log(org_id, id)\n         )",
    ] {
        sqlx::query(statement).execute(pool).await?;
    }

    sqlx::query("INSERT INTO organizations (id) VALUES ($1::uuid), ($2::uuid)")
        .bind(ORG_A)
        .bind(ORG_B)
        .execute(pool)
        .await?;
    sqlx::query(
        "INSERT INTO agents (id, org_id, name) VALUES\n             ($1::uuid, $3::uuid, 'agent-a'),\n             ($2::uuid, $4::uuid, 'agent-b')",
    )
    .bind(AGENT_A)
    .bind(AGENT_B)
    .bind(ORG_A)
    .bind(ORG_B)
    .execute(pool)
    .await?;
    sqlx::query(
        "INSERT INTO heartbeat_runs (id, org_id, agent_id, status) VALUES\n             ($1::uuid, $3::uuid, $5::uuid, 'running'),\n             ($2::uuid, $4::uuid, $6::uuid, 'running'),\n             ($7::uuid, $3::uuid, $6::uuid, 'running')",
    )
    .bind(RUN_A)
    .bind(RUN_B)
    .bind(ORG_A)
    .bind(ORG_B)
    .bind(AGENT_A)
    .bind(AGENT_B)
    .bind(RUN_C)
    .execute(pool)
    .await?;

    for (id, title, status, assignee, reviewer_agent, reviewer_user) in [
        (
            CHECKOUT_ISSUE_ID,
            "checkout",
            "todo",
            Some(AGENT_A),
            None,
            None,
        ),
        (FENCED_ISSUE_ID, "fenced", "todo", Some(AGENT_A), None, None),
        (
            REVIEW_DONE_ISSUE_ID,
            "done review",
            "blocked",
            None,
            Some(AGENT_A),
            None,
        ),
        (
            REVIEW_PROGRESS_ISSUE_ID,
            "progress review",
            "blocked",
            Some(AGENT_A),
            None,
            Some(BOARD_USER_ID),
        ),
        (
            FAILURE_ISSUE_ID,
            "failure injection",
            "in_review",
            None,
            None,
            Some(BOARD_USER_ID),
        ),
    ] {
        sqlx::query(
            "INSERT INTO issues (\n                 id, org_id, title, status, assignee_agent_id, reviewer_agent_id, reviewer_user_id,\n                 revision, fencing_token, updated_at\n             ) VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $5::uuid, $6::uuid, $7::text, 0, 0, now())",
        )
        .bind(id)
        .bind(ORG_A)
        .bind(title)
        .bind(status)
        .bind(assignee)
        .bind(reviewer_agent)
        .bind(reviewer_user)
        .execute(pool)
        .await?;
    }

    sqlx::query(
        "UPDATE issues SET execution_agent_name_key = 'stale-agent-lock', execution_locked_at = now()\n          WHERE id = $1::uuid",
    )
    .bind(REVIEW_PROGRESS_ISSUE_ID)
    .execute(pool)
    .await?;

    sqlx::query(
        "INSERT INTO approvals (\n             id, org_id, type, requested_by_agent_id, requested_by_user_id, status, revision, payload, updated_at\n         ) VALUES ($1::uuid, $2::uuid, 'hire_agent', NULL, NULL, 'pending', 0, $3::jsonb, now())",
    )
    .bind(APPROVAL_ID)
    .bind(ORG_A)
    .bind(json!({"request": "new agent"}))
    .execute(pool)
    .await?;
    sqlx::query(
        "INSERT INTO approvals (id, org_id, type, status, revision, payload, updated_at)\n         VALUES ($1::uuid, $2::uuid, 'issue_action', 'pending', 0, $3::jsonb, now())",
    )
    .bind(AMBIGUOUS_APPROVAL_ID)
    .bind(ORG_A)
    .bind(json!({"action": "ambiguous"}))
    .execute(pool)
    .await?;
    sqlx::query(
        "INSERT INTO issue_approvals (org_id, issue_id, approval_id)\n         VALUES ($1::uuid, $2::uuid, $4::uuid), ($1::uuid, $3::uuid, $4::uuid)",
    )
    .bind(ORG_A)
    .bind(REVIEW_DONE_ISSUE_ID)
    .bind(REVIEW_PROGRESS_ISSUE_ID)
    .bind(AMBIGUOUS_APPROVAL_ID)
    .execute(pool)
    .await?;
    Ok(())
}
