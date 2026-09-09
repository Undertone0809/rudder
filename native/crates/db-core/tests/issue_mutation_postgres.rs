//! Explicitly opt-in disposable PostgreSQL coverage for the mutation executor.
//!
//! This test never reads the repository's default database setting. It requires a
//! caller-supplied connection URL, creates a uniquely named schema, installs the
//! relevant production-shaped tables and foreign-key fences, and drops the schema
//! before returning—even when the exercise task panics.

use rudder_db_core::issue_mutation::{
    ApprovalResubmissionOptions, CheckoutOptions, IssueMutationError, IssueMutationRepository,
    TrustedApprovalAuthorization, TrustedOrganizationId,
};
use rudder_issue_core::{
    ActorRef, AgentId, ApprovalDecision, ApprovalDecisionCommand, ApprovalId, ApprovalRef,
    ApprovalResubmissionCommand, CheckoutCommand, IdempotencyKey, IssueId, IssueRef, IssueStatus,
    OrganizationId, ReviewDecision, ReviewDecisionCommand, RunId, UserId,
};
use serde_json::json;
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{env, error::Error, process, time::SystemTime};
use time::{Duration, OffsetDateTime};

const ORG_A: &str = "00000000-0000-0000-0000-000000000001";
const ORG_B: &str = "00000000-0000-0000-0000-000000000002";
const CHECKOUT_ISSUE_ID: &str = "00000000-0000-0000-0000-000000000010";
const FENCED_ISSUE_ID: &str = "00000000-0000-0000-0000-000000000011";
const REVIEW_DONE_ISSUE_ID: &str = "00000000-0000-0000-0000-000000000012";
const REVIEW_PROGRESS_ISSUE_ID: &str = "00000000-0000-0000-0000-000000000013";
const AGENT_A: &str = "00000000-0000-0000-0000-000000000020";
const AGENT_B: &str = "00000000-0000-0000-0000-000000000021";
const RUN_A: &str = "00000000-0000-0000-0000-000000000030";
const RUN_B: &str = "00000000-0000-0000-0000-000000000031";
const APPROVAL_ID: &str = "00000000-0000-0000-0000-000000000040";
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
    let replay_checkout = repository
        .checkout(&scope, checkout_command, checkout_options)
        .await?;
    assert!(!first_checkout.replayed);
    assert!(replay_checkout.replayed);
    assert_eq!(first_checkout.ledger_id, replay_checkout.ledger_id);
    assert_eq!(first_checkout.activity_id, replay_checkout.activity_id);
    assert_eq!(first_checkout.outcome, replay_checkout.outcome);

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
            Some(RunId::new(RUN_B)),
        ),
        AgentId::new(AGENT_A),
        Some(RunId::new(RUN_B)),
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
        scope.clone(),
        ApprovalId::new(APPROVAL_ID),
        board_actor.clone(),
    );
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
        board_actor,
        ApprovalDecision::Approve,
        Some("approved after revision".into()),
        2,
        IdempotencyKey::new("integration-approval-approved-key"),
    );
    let approved = repository.decide_approval(&authorization, approve).await?;
    assert_eq!(approved.outcome["Recorded"]["status"], "approved");

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

    let review_rows: (String, bool, String, bool) = sqlx::query_as(
        "SELECT done.status, done.completed_at IS NOT NULL, progress.status, progress.started_at IS NOT NULL\n           FROM issues AS done JOIN issues AS progress ON progress.org_id = done.org_id\n          WHERE done.org_id = $1::uuid AND done.id = $2::uuid AND progress.id = $3::uuid",
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
    assert_eq!(counts, (6, 6, 2, 6));
    Ok(())
}

async fn create_fixture(pool: &PgPool) -> Result<(), sqlx::Error> {
    for statement in [
        "CREATE TABLE organizations (id uuid PRIMARY KEY)",
        "CREATE TABLE agents (\n             id uuid PRIMARY KEY,\n             org_id uuid NOT NULL REFERENCES organizations(id),\n             name text NOT NULL,\n             UNIQUE (org_id, id)\n         )",
        "CREATE TABLE heartbeat_runs (\n             id uuid PRIMARY KEY,\n             org_id uuid NOT NULL REFERENCES organizations(id),\n             agent_id uuid NOT NULL,\n             status text NOT NULL,\n             created_at timestamptz NOT NULL DEFAULT now(),\n             UNIQUE (org_id, id),\n             FOREIGN KEY (org_id, agent_id) REFERENCES agents(org_id, id)\n         )",
        "CREATE TABLE issues (\n             id uuid PRIMARY KEY,\n             org_id uuid NOT NULL REFERENCES organizations(id),\n             title text NOT NULL,\n             status text NOT NULL,\n             assignee_agent_id uuid,\n             assignee_user_id text,\n             reviewer_agent_id uuid,\n             reviewer_user_id text,\n             revision bigint NOT NULL,\n             fencing_token bigint NOT NULL,\n             checkout_run_id uuid,\n             execution_run_id uuid,\n             checkout_lease_owner text,\n             checkout_lease_expires_at timestamptz,\n             started_at timestamptz,\n             completed_at timestamptz,\n             cancelled_at timestamptz,\n             updated_at timestamptz NOT NULL,\n             UNIQUE (org_id, id),\n             FOREIGN KEY (org_id, assignee_agent_id) REFERENCES agents(org_id, id),\n             FOREIGN KEY (org_id, reviewer_agent_id) REFERENCES agents(org_id, id),\n             FOREIGN KEY (org_id, checkout_run_id) REFERENCES heartbeat_runs(org_id, id),\n             FOREIGN KEY (org_id, execution_run_id) REFERENCES heartbeat_runs(org_id, id)\n         )",
        "CREATE TABLE approvals (\n             id uuid PRIMARY KEY,\n             org_id uuid NOT NULL REFERENCES organizations(id),\n             type text NOT NULL,\n             requested_by_agent_id uuid,\n             requested_by_user_id text,\n             status text NOT NULL,\n             revision bigint NOT NULL,\n             decision text,\n             decision_idempotency_key text,\n             decision_note text,\n             decided_by_user_id text,\n             decided_at timestamptz,\n             payload jsonb NOT NULL,\n             updated_at timestamptz NOT NULL,\n             UNIQUE (org_id, id),
             UNIQUE (org_id, decision_idempotency_key),\n             FOREIGN KEY (org_id, requested_by_agent_id) REFERENCES agents(org_id, id)\n         )",
        "CREATE TABLE issue_approvals (\n             org_id uuid NOT NULL REFERENCES organizations(id),\n             issue_id uuid NOT NULL,\n             approval_id uuid NOT NULL,\n             created_at timestamptz NOT NULL DEFAULT now(),\n             PRIMARY KEY (org_id, issue_id, approval_id),\n             FOREIGN KEY (org_id, issue_id) REFERENCES issues(org_id, id),\n             FOREIGN KEY (org_id, approval_id) REFERENCES approvals(org_id, id)\n         )",
        "CREATE TABLE issue_comments (\n             id uuid PRIMARY KEY DEFAULT (md5(random()::text || clock_timestamp()::text)::uuid),\n             org_id uuid NOT NULL REFERENCES organizations(id),\n             issue_id uuid NOT NULL,\n             author_agent_id uuid,\n             author_user_id text,\n             body text NOT NULL,\n             created_at timestamptz NOT NULL DEFAULT now(),\n             updated_at timestamptz NOT NULL DEFAULT now(),\n             FOREIGN KEY (org_id, issue_id) REFERENCES issues(org_id, id),\n             FOREIGN KEY (org_id, author_agent_id) REFERENCES agents(org_id, id)\n         )",
        "CREATE TABLE activity_log (\n             id uuid PRIMARY KEY DEFAULT (md5(random()::text || clock_timestamp()::text)::uuid),\n             org_id uuid NOT NULL REFERENCES organizations(id),\n             actor_type text NOT NULL,\n             actor_id text NOT NULL,\n             action text NOT NULL,\n             entity_type text NOT NULL,\n             entity_id text NOT NULL,\n             agent_id uuid,\n             run_id uuid,\n             details jsonb,\n             idempotency_key text,\n             created_at timestamptz NOT NULL DEFAULT now(),\n             UNIQUE (org_id, id),\n             UNIQUE (org_id, idempotency_key),\n             FOREIGN KEY (org_id, agent_id) REFERENCES agents(org_id, id),\n             FOREIGN KEY (org_id, run_id) REFERENCES heartbeat_runs(org_id, id)\n         )",
        "CREATE TABLE issue_mutation_commands (\n             id uuid PRIMARY KEY DEFAULT (md5(random()::text || clock_timestamp()::text)::uuid),\n             org_id uuid NOT NULL REFERENCES organizations(id),\n             issue_id uuid,\n             approval_id uuid,\n             command_type text NOT NULL,\n             idempotency_key text NOT NULL,\n             command_fingerprint text NOT NULL,\n             outcome jsonb NOT NULL,\n             activity_id uuid,\n             UNIQUE (org_id, id),\n             UNIQUE (org_id, idempotency_key),\n             FOREIGN KEY (org_id, issue_id) REFERENCES issues(org_id, id),\n             FOREIGN KEY (org_id, approval_id) REFERENCES approvals(org_id, id),\n             FOREIGN KEY (org_id, activity_id) REFERENCES activity_log(org_id, id)\n         )",
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
        "INSERT INTO heartbeat_runs (id, org_id, agent_id, status) VALUES\n             ($1::uuid, $3::uuid, $5::uuid, 'running'),\n             ($2::uuid, $4::uuid, $6::uuid, 'running')",
    )
    .bind(RUN_A)
    .bind(RUN_B)
    .bind(ORG_A)
    .bind(ORG_B)
    .bind(AGENT_A)
    .bind(AGENT_B)
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
        "INSERT INTO approvals (\n             id, org_id, type, requested_by_agent_id, requested_by_user_id, status, revision, payload, updated_at\n         ) VALUES ($1::uuid, $2::uuid, 'hire_agent', NULL, NULL, 'pending', 0, $3::jsonb, now())",
    )
    .bind(APPROVAL_ID)
    .bind(ORG_A)
    .bind(json!({"request": "new agent"}))
    .execute(pool)
    .await?;
    Ok(())
}
