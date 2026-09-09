//! Explicitly opt-in disposable PostgreSQL coverage for the mutation executor.
//!
//! This test never reads the repository's default database setting. It requires a
//! caller-supplied connection URL, creates a uniquely named schema, installs only
//! the columns used by the bounded adapter, and drops the schema before returning.

use rudder_db_core::issue_mutation::{
    CheckoutOptions, IssueMutationRepository, TrustedOrganizationId,
};
use rudder_issue_core::{
    ActorRef, AgentId, CheckoutCommand, IdempotencyKey, IssueId, IssueRef, IssueStatus,
    OrganizationId, RunId,
};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{env, error::Error, process, time::SystemTime};
use time::{Duration, OffsetDateTime};

const ORG_ID: &str = "00000000-0000-0000-0000-000000000001";
const ISSUE_ID: &str = "00000000-0000-0000-0000-000000000002";
const AGENT_ID: &str = "00000000-0000-0000-0000-000000000003";
const RUN_ID: &str = "00000000-0000-0000-0000-000000000004";

#[tokio::test]
#[ignore = "explicit opt-in: set RUDDER_DB_CORE_ISSUE_MUTATION_DATABASE_URL to a disposable PostgreSQL instance"]
async fn checkout_executes_and_replays_with_audit_and_ledger_evidence() {
    let url = env::var("RUDDER_DB_CORE_ISSUE_MUTATION_DATABASE_URL")
        .expect("explicit disposable PostgreSQL URL");
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .expect("connect to explicit disposable PostgreSQL");
    let schema = disposable_schema_name();
    let quoted_schema = format!("\"{schema}\"");

    sqlx::query(&format!("CREATE SCHEMA {quoted_schema}"))
        .execute(&pool)
        .await
        .expect("create disposable schema");
    let result = exercise_checkout(&pool, &quoted_schema).await;
    let cleanup = sqlx::query(&format!("DROP SCHEMA {quoted_schema} CASCADE"))
        .execute(&pool)
        .await;
    pool.close().await;

    cleanup.expect("drop disposable schema");
    result.expect("execute checkout mutation integration flow");
}

fn disposable_schema_name() -> String {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .expect("system clock after Unix epoch")
        .as_nanos();
    format!("rudder_issue_mutation_{}_{}", process::id(), nanos)
}

async fn exercise_checkout(
    pool: &PgPool,
    quoted_schema: &str,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    sqlx::query(&format!("SET search_path TO {quoted_schema}"))
        .execute(pool)
        .await?;
    for statement in [
        "CREATE TABLE organizations (id uuid PRIMARY KEY)",
        "CREATE TABLE issues (\
             id uuid PRIMARY KEY,\
             org_id uuid NOT NULL,\
             title text NOT NULL,\
             status text NOT NULL,\
             assignee_agent_id uuid,\
             assignee_user_id text,\
             reviewer_agent_id uuid,\
             reviewer_user_id text,\
             revision bigint NOT NULL,\
             fencing_token bigint NOT NULL,\
             checkout_run_id uuid,\
             execution_run_id uuid,\
             checkout_lease_owner text,\
             checkout_lease_expires_at timestamptz,\
             started_at timestamptz,\
             updated_at timestamptz NOT NULL\
         )",
        "CREATE TABLE activity_log (\
             id uuid PRIMARY KEY DEFAULT (md5(random()::text || clock_timestamp()::text)::uuid),\
             org_id uuid NOT NULL,\
             actor_type text NOT NULL,\
             actor_id text NOT NULL,\
             action text NOT NULL,\
             entity_type text NOT NULL,\
             entity_id text NOT NULL,\
             agent_id uuid,\
             run_id uuid,\
             details jsonb,\
             idempotency_key text,\
             UNIQUE (org_id, idempotency_key)\
         )",
        "CREATE TABLE issue_mutation_commands (\
             id uuid PRIMARY KEY DEFAULT (md5(random()::text || clock_timestamp()::text)::uuid),\
             org_id uuid NOT NULL,\
             issue_id uuid,\
             approval_id uuid,\
             command_type text NOT NULL,\
             idempotency_key text NOT NULL,\
             command_fingerprint text NOT NULL,\
             outcome jsonb NOT NULL,\
             activity_id uuid,\
             UNIQUE (org_id, idempotency_key)\
         )",
    ] {
        sqlx::query(statement).execute(pool).await?;
    }
    sqlx::query("INSERT INTO organizations (id) VALUES ($1::uuid)")
        .bind(ORG_ID)
        .execute(pool)
        .await?;
    sqlx::query(
        "INSERT INTO issues (\
             id, org_id, title, status, assignee_agent_id, revision, fencing_token, updated_at\
         ) VALUES ($1::uuid, $2::uuid, $3::text, 'todo', $4::uuid, 0, 0, now())",
    )
    .bind(ISSUE_ID)
    .bind(ORG_ID)
    .bind("integration checkout")
    .bind(AGENT_ID)
    .execute(pool)
    .await?;

    let scope = TrustedOrganizationId::from_host(OrganizationId::new(ORG_ID));
    let agent = AgentId::new(AGENT_ID);
    let run = RunId::new(RUN_ID);
    let command = CheckoutCommand::new(
        IssueRef::new(OrganizationId::new(ORG_ID), IssueId::new(ISSUE_ID)),
        ActorRef::agent(
            OrganizationId::new(ORG_ID),
            agent.clone(),
            Some(run.clone()),
        ),
        agent,
        Some(run),
        [IssueStatus::Todo],
        0,
        0,
        IdempotencyKey::new("integration-checkout-key"),
    );
    let options =
        CheckoutOptions::with_lease(1, Some(OffsetDateTime::now_utc() + Duration::minutes(5)));
    let repository = IssueMutationRepository::new(pool.clone());
    let first = repository
        .checkout(&scope, command.clone(), options.clone())
        .await?;
    let replay = repository.checkout(&scope, command, options).await?;

    assert!(!first.replayed);
    assert!(replay.replayed);
    assert_eq!(first.ledger_id, replay.ledger_id);
    assert_eq!(first.activity_id, replay.activity_id);
    assert_eq!(first.outcome, replay.outcome);

    let issue: (String, i64, i64, String, String) = sqlx::query_as(
        "SELECT status, revision, fencing_token, checkout_run_id::text, checkout_lease_owner\
           FROM issues WHERE org_id = $1::uuid AND id = $2::uuid",
    )
    .bind(ORG_ID)
    .bind(ISSUE_ID)
    .fetch_one(pool)
    .await?;
    assert_eq!(issue.0, "in_progress");
    assert_eq!(issue.1, 1);
    assert_eq!(issue.2, 1);
    assert_eq!(issue.3, RUN_ID);
    assert_eq!(issue.4, AGENT_ID);

    let counts: (i64, i64) = sqlx::query_as(
        "SELECT\
             (SELECT count(*) FROM issue_mutation_commands WHERE org_id = $1::uuid),\
             (SELECT count(*) FROM activity_log WHERE org_id = $1::uuid)",
    )
    .bind(ORG_ID)
    .fetch_one(pool)
    .await?;
    assert_eq!(counts, (1, 1));
    Ok(())
}
