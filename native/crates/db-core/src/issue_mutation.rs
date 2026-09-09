//! Bounded, private SQLx mutation adapter for the migrated issue/governance schema.
//!
//! This module is deliberately not wired to an HTTP route or a public writer. The
//! caller must provide [`TrustedOrganizationId`] from authenticated host state;
//! command payloads are checked against that scope but never choose the SQL
//! organization predicate. Every mutation reserves a durable command-ledger
//! row, applies the issue-core state machine under row locks and optimistic
//! preconditions, and commits its activity evidence and final ledger receipt in
//! one PostgreSQL transaction.

use rudder_issue_core::{
    ActorRef, AgentId, Approval, ApprovalDecision, ApprovalDecisionCommand, ApprovalRef,
    ApprovalStatus, ApprovalType, CheckoutCommand, DomainError, IdempotencyKey, Issue, IssueId,
    IssueRef, IssueStatus, OrganizationId, PrincipalRef, ReviewDecisionCommand, RunId,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool, Postgres, postgres::PgRow, query::QueryAs};
use thiserror::Error;
use time::OffsetDateTime;

pub const CHECKOUT_COMMAND_TYPE: &str = "issue.checkout";
pub const REVIEW_COMMAND_TYPE: &str = "issue.review_decision";
pub const APPROVAL_COMMAND_TYPE: &str = "approval.decision";

/// An organization id captured from authenticated host state.
///
/// The constructor is intentionally named `from_host` to keep the trust
/// boundary visible at call sites. No repository method accepts an
/// organization id from a command or model payload as its scope.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct TrustedOrganizationId(OrganizationId);

impl TrustedOrganizationId {
    pub fn from_host(value: OrganizationId) -> Self {
        Self(value)
    }

    pub fn as_id(&self) -> &OrganizationId {
        &self.0
    }

    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

/// Host-owned checkout lease options. The issue-core command still owns the
/// fencing precondition; the lease expiry is only written by this adapter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CheckoutOptions {
    pub fencing_token: u64,
    pub lease_expires_at: Option<OffsetDateTime>,
}

impl CheckoutOptions {
    pub fn new(fencing_token: u64) -> Self {
        Self {
            fencing_token,
            lease_expires_at: None,
        }
    }

    pub fn with_lease(fencing_token: u64, lease_expires_at: Option<OffsetDateTime>) -> Self {
        Self {
            fencing_token,
            lease_expires_at,
        }
    }
}

/// Values bound by a mutation query. Keeping binds in the plan makes the
/// parameterization and organization fence directly testable without a live DB.
#[derive(Clone, Debug, PartialEq)]
pub enum MutationBind {
    Uuid(String),
    NullableUuid(Option<String>),
    Text(String),
    NullableText(Option<String>),
    BigInt(i64),
    Json(Value),
    Timestamp(Option<OffsetDateTime>),
}

#[derive(Clone, Debug, PartialEq)]
pub struct MutationQueryPlan {
    pub sql: String,
    pub binds: Vec<MutationBind>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CheckoutQueryPlans {
    pub reserve_ledger: MutationQueryPlan,
    pub load_issue: MutationQueryPlan,
    pub update_issue: MutationQueryPlan,
    pub insert_activity: MutationQueryPlan,
    pub finalize_ledger: MutationQueryPlan,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ReviewQueryPlans {
    pub reserve_ledger: MutationQueryPlan,
    pub load_issue: MutationQueryPlan,
    pub update_issue: MutationQueryPlan,
    pub insert_activity: MutationQueryPlan,
    pub finalize_ledger: MutationQueryPlan,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ApprovalQueryPlans {
    pub reserve_ledger: MutationQueryPlan,
    pub load_approval: MutationQueryPlan,
    pub update_approval: MutationQueryPlan,
    pub insert_activity: MutationQueryPlan,
    pub finalize_ledger: MutationQueryPlan,
}

#[derive(Clone, Debug, Error, PartialEq)]
pub enum IssueMutationError {
    #[error(transparent)]
    Domain(#[from] DomainError),
    #[error("database mutation failed")]
    Database,
    #[error("failed to serialize mutation evidence")]
    Serialization,
    #[error("{entity} {id} was not found in the trusted organization")]
    NotFound { entity: &'static str, id: String },
    #[error("stored {entity} {id} is invalid: {detail}")]
    InvalidStoredState {
        entity: &'static str,
        id: String,
        detail: String,
    },
    #[error("command ledger row is incomplete for idempotency key {key:?}")]
    IncompleteLedger { key: IdempotencyKey },
    #[error("idempotency key was already used by a different command: {key:?}")]
    IdempotencyConflict { key: IdempotencyKey },
    #[error("approval already contains decision idempotency key {key:?}")]
    ApprovalDecisionKeyConflict { key: IdempotencyKey },
    #[error("optimistic mutation precondition changed before persistence")]
    ConcurrentModification,
    #[error("{field} is outside PostgreSQL bigint range")]
    NumericOverflow { field: &'static str },
}

impl From<sqlx::Error> for IssueMutationError {
    fn from(_: sqlx::Error) -> Self {
        Self::Database
    }
}

impl From<serde_json::Error> for IssueMutationError {
    fn from(_: serde_json::Error) -> Self {
        Self::Serialization
    }
}

/// A committed mutation result. Both ids are returned so callers cannot mistake
/// the domain result for durable audit evidence. Replays return the same ids.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct MutationReceipt {
    pub command_type: String,
    pub idempotency_key: IdempotencyKey,
    pub ledger_id: String,
    pub activity_id: String,
    pub outcome: Value,
    pub replayed: bool,
}

#[derive(Clone, Copy)]
enum ActivityKind {
    Checkout,
    Review,
    Approval,
}

#[derive(Clone, Copy)]
enum LedgerTarget<'a> {
    Issue(&'a str),
    Approval(&'a str),
}

#[derive(Clone, Debug)]
struct ActorSqlParts {
    actor_type: &'static str,
    actor_id: String,
    agent_id: Option<String>,
    run_id: Option<String>,
}

#[derive(Clone, Debug, FromRow)]
struct LedgerRow {
    id: String,
    org_id: String,
    issue_id: Option<String>,
    approval_id: Option<String>,
    command_type: String,
    idempotency_key: String,
    command_fingerprint: String,
    outcome: Value,
    activity_id: Option<String>,
}

#[derive(Clone, Debug, FromRow)]
struct LedgerIdRow {
    id: String,
}

#[derive(Clone, Debug, FromRow)]
struct ActivityIdRow {
    id: String,
}

#[derive(Clone, Debug, FromRow)]
struct FinalizedLedgerRow {
    id: String,
    activity_id: String,
}

#[derive(Clone, Debug, FromRow)]
struct IssueMutationRow {
    id: String,
    org_id: String,
    title: String,
    status: String,
    assignee_agent_id: Option<String>,
    assignee_user_id: Option<String>,
    reviewer_agent_id: Option<String>,
    reviewer_user_id: Option<String>,
    revision: i64,
    fencing_token: i64,
    checkout_run_id: Option<String>,
    execution_run_id: Option<String>,
    checkout_lease_owner: Option<String>,
    checkout_lease_expires_at: Option<OffsetDateTime>,
}

#[derive(Clone, Debug, FromRow)]
struct IssueUpdateRow {
    revision: i64,
    fencing_token: i64,
}

#[derive(Clone, Debug, FromRow)]
struct ApprovalMutationRow {
    id: String,
    org_id: String,
    approval_type: String,
    status: String,
    revision: i64,
    decision: Option<String>,
    decision_idempotency_key: Option<String>,
    decision_note: Option<String>,
    requested_by_agent_id: Option<String>,
    requested_by_user_id: Option<String>,
    payload: Value,
}

#[derive(Clone, Debug, FromRow)]
struct ApprovalUpdateRow {
    revision: i64,
}

fn plan(sql: &str, binds: Vec<MutationBind>) -> MutationQueryPlan {
    MutationQueryPlan {
        sql: sql.to_owned(),
        binds,
    }
}

fn ensure_issue_scope(
    scope: &TrustedOrganizationId,
    issue: &IssueRef,
    actor: &ActorRef,
) -> Result<(), IssueMutationError> {
    if issue.organization_id != *scope.as_id() {
        return Err(DomainError::CrossOrganization {
            expected: scope.0.clone(),
            found: issue.organization_id.clone(),
        }
        .into());
    }
    if actor.organization_id() != scope.as_id() {
        return Err(DomainError::CrossOrganization {
            expected: scope.0.clone(),
            found: actor.organization_id().clone(),
        }
        .into());
    }
    Ok(())
}

fn ensure_approval_scope(
    scope: &TrustedOrganizationId,
    approval: &ApprovalRef,
    actor: &ActorRef,
) -> Result<(), IssueMutationError> {
    if approval.organization_id != *scope.as_id() {
        return Err(DomainError::CrossOrganization {
            expected: scope.0.clone(),
            found: approval.organization_id.clone(),
        }
        .into());
    }
    if actor.organization_id() != scope.as_id() {
        return Err(DomainError::CrossOrganization {
            expected: scope.0.clone(),
            found: actor.organization_id().clone(),
        }
        .into());
    }
    Ok(())
}

fn bigint(value: u64, field: &'static str) -> Result<i64, IssueMutationError> {
    i64::try_from(value).map_err(|_| IssueMutationError::NumericOverflow { field })
}

fn revision(value: i64, entity: &'static str, id: &str) -> Result<u64, IssueMutationError> {
    u64::try_from(value).map_err(|_| IssueMutationError::InvalidStoredState {
        entity,
        id: id.to_owned(),
        detail: "revision must be non-negative".into(),
    })
}

fn fingerprint_value<T: Serialize>(
    command_type: &str,
    scope: &TrustedOrganizationId,
    command: &T,
    extra: Option<Value>,
) -> Result<String, IssueMutationError> {
    let envelope = json!({
        "organization": scope.as_str(),
        "commandType": command_type,
        "command": command,
        "extra": extra,
    });
    let bytes = serde_json::to_vec(&envelope)?;
    let digest = Sha256::digest(bytes);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Return the stable fingerprint used by the checkout command ledger.
pub fn command_fingerprint(
    command_type: &str,
    scope: &TrustedOrganizationId,
    command: &CheckoutCommand,
    options: &CheckoutOptions,
) -> Result<String, IssueMutationError> {
    fingerprint_value(
        command_type,
        scope,
        command,
        Some(json!({
            "fencingToken": options.fencing_token.to_string(),
            "leaseExpiresAt": options
                .lease_expires_at
                .map(|value| value.unix_timestamp_nanos().to_string()),
        })),
    )
}

fn reserve_ledger_plan(
    scope: &TrustedOrganizationId,
    command_type: &str,
    key: &IdempotencyKey,
    fingerprint: &str,
) -> MutationQueryPlan {
    plan(
        "INSERT INTO issue_mutation_commands (\
             org_id, command_type, idempotency_key, command_fingerprint, outcome\
         ) VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::jsonb)\
         ON CONFLICT (org_id, idempotency_key) DO NOTHING\
         RETURNING id::text AS id",
        vec![
            MutationBind::Uuid(scope.as_str().into()),
            MutationBind::Text(command_type.into()),
            MutationBind::Text(key.as_str().into()),
            MutationBind::Text(fingerprint.into()),
            MutationBind::Json(json!({"state": "pending"})),
        ],
    )
}

fn ledger_lookup_plan(scope: &TrustedOrganizationId, key: &IdempotencyKey) -> MutationQueryPlan {
    plan(
        "SELECT id::text AS id, org_id::text AS org_id, issue_id::text AS issue_id,\
                approval_id::text AS approval_id, command_type, idempotency_key,\
                command_fingerprint, outcome, activity_id::text AS activity_id\
           FROM issue_mutation_commands\
          WHERE org_id = $1::uuid AND idempotency_key = $2::text\
          FOR UPDATE",
        vec![
            MutationBind::Uuid(scope.as_str().into()),
            MutationBind::Text(key.as_str().into()),
        ],
    )
}

fn load_issue_plan(scope: &TrustedOrganizationId, issue_id: &IssueId) -> MutationQueryPlan {
    plan(
        "SELECT i.id::text AS id, i.org_id::text AS org_id, i.title, i.status,\
                i.assignee_agent_id::text AS assignee_agent_id,\
                i.assignee_user_id, i.reviewer_agent_id::text AS reviewer_agent_id,\
                i.reviewer_user_id, i.revision, i.fencing_token,\
                i.checkout_run_id::text AS checkout_run_id,\
                i.execution_run_id::text AS execution_run_id,\
                i.checkout_lease_owner, i.checkout_lease_expires_at\
           FROM issues AS i\
          WHERE i.org_id = $1::uuid AND i.id = $2::uuid\
          FOR UPDATE",
        vec![
            MutationBind::Uuid(scope.as_str().into()),
            MutationBind::Uuid(issue_id.as_str().into()),
        ],
    )
}

fn load_approval_plan(
    scope: &TrustedOrganizationId,
    approval_id: &rudder_issue_core::ApprovalId,
) -> MutationQueryPlan {
    plan(
        "SELECT a.id::text AS id, a.org_id::text AS org_id, a.type AS approval_type,\
                a.status, a.revision, a.decision, a.decision_idempotency_key,\
                a.decision_note, a.requested_by_agent_id::text AS requested_by_agent_id,\
                a.requested_by_user_id, a.payload\
           FROM approvals AS a\
          WHERE a.org_id = $1::uuid AND a.id = $2::uuid\
          FOR UPDATE",
        vec![
            MutationBind::Uuid(scope.as_str().into()),
            MutationBind::Uuid(approval_id.as_str().into()),
        ],
    )
}

fn update_checkout_plan(
    scope: &TrustedOrganizationId,
    command: &CheckoutCommand,
    options: &CheckoutOptions,
) -> Result<MutationQueryPlan, IssueMutationError> {
    let expected_revision = bigint(command.expected_revision, "expected issue revision")?;
    let expected_fence = bigint(command.expected_fencing_token, "expected fencing token")?;
    let requested_fence = bigint(options.fencing_token, "fencing token")?;
    let run_id = command
        .run_id
        .as_ref()
        .ok_or(DomainError::CheckoutRunRequired)?;
    Ok(plan(
        "UPDATE issues AS i\
            SET status = 'in_progress',\
                checkout_run_id = $6::uuid,\
                execution_run_id = $6::uuid,\
                checkout_lease_owner = $7::text,\
                checkout_lease_expires_at = $8::timestamptz,\
                revision = i.revision + 1,\
                fencing_token = $5::int8,\
                started_at = COALESCE(i.started_at, now()),\
                updated_at = now()\
          WHERE i.org_id = $1::uuid AND i.id = $2::uuid\
            AND i.revision = $3::int8 AND i.fencing_token = $4::int8\
            AND i.checkout_run_id IS NULL\
            AND i.execution_run_id IS NULL\
            AND i.checkout_lease_owner IS NULL\
            AND i.checkout_lease_expires_at IS NULL\
          RETURNING i.revision, i.fencing_token",
        vec![
            MutationBind::Uuid(scope.as_str().into()),
            MutationBind::Uuid(command.issue.issue_id.as_str().into()),
            MutationBind::BigInt(expected_revision),
            MutationBind::BigInt(expected_fence),
            MutationBind::BigInt(requested_fence),
            MutationBind::Uuid(run_id.as_str().into()),
            MutationBind::Text(command.target_agent_id.as_str().into()),
            MutationBind::Timestamp(options.lease_expires_at),
        ],
    ))
}

fn update_review_plan(
    scope: &TrustedOrganizationId,
    command: &ReviewDecisionCommand,
) -> Result<MutationQueryPlan, IssueMutationError> {
    let expected_revision = bigint(command.expected_revision, "expected issue revision")?;
    let expected_fence = bigint(command.expected_fencing_token, "expected fencing token")?;
    let status = command.decision.resulting_status();
    Ok(plan(
        "UPDATE issues AS i\
            SET status = $5::text,\
                checkout_run_id = NULL,\
                execution_run_id = NULL,\
                checkout_lease_owner = NULL,\
                checkout_lease_expires_at = NULL,\
                revision = i.revision + 1,\
                updated_at = now()\
          WHERE i.org_id = $1::uuid AND i.id = $2::uuid\
            AND i.revision = $3::int8 AND i.fencing_token = $4::int8\
            AND i.status = 'in_review'\
          RETURNING i.revision, i.fencing_token",
        vec![
            MutationBind::Uuid(scope.as_str().into()),
            MutationBind::Uuid(command.issue.issue_id.as_str().into()),
            MutationBind::BigInt(expected_revision),
            MutationBind::BigInt(expected_fence),
            MutationBind::Text(issue_status_text(status).into()),
        ],
    ))
}

fn update_approval_plan(
    scope: &TrustedOrganizationId,
    command: &ApprovalDecisionCommand,
) -> Result<MutationQueryPlan, IssueMutationError> {
    let expected_revision = bigint(command.expected_revision, "expected approval revision")?;
    let (status, decision) = approval_decision_text(command.decision);
    let decided_by_user_id = match &command.actor {
        ActorRef::User { user_id, .. } => Some(user_id.as_str().to_owned()),
        ActorRef::Agent { .. } => None,
    };
    Ok(plan(
        "UPDATE approvals AS a\
            SET status = $4::text,\
                revision = a.revision + 1,\
                decision = $5::text,\
                decision_idempotency_key = $6::text,\
                decision_note = $7::text,\
                decided_by_user_id = $8::text,\
                decided_at = now(),\
                updated_at = now()\
          WHERE a.org_id = $1::uuid AND a.id = $2::uuid\
            AND a.revision = $3::int8\
            AND a.status = 'pending'\
            AND a.decision_idempotency_key IS NULL\
          RETURNING a.revision",
        vec![
            MutationBind::Uuid(scope.as_str().into()),
            MutationBind::Uuid(command.approval.approval_id.as_str().into()),
            MutationBind::BigInt(expected_revision),
            MutationBind::Text(status.into()),
            MutationBind::Text(decision.into()),
            MutationBind::Text(command.idempotency_key.as_str().into()),
            MutationBind::NullableText(command.note.clone()),
            MutationBind::NullableText(decided_by_user_id),
        ],
    ))
}

fn activity_plan(
    scope: &TrustedOrganizationId,
    actor: &ActorRef,
    kind: ActivityKind,
    entity_id: &str,
    details: Value,
    key: &IdempotencyKey,
) -> MutationQueryPlan {
    let actor = actor_sql_parts(actor);
    let (action, entity_type) = match kind {
        ActivityKind::Checkout => ("issue.checked_out", "issue"),
        ActivityKind::Review => ("issue.review_decision_recorded", "issue"),
        ActivityKind::Approval => ("approval.decision_recorded", "approval"),
    };
    plan(
        "INSERT INTO activity_log (\
             org_id, actor_type, actor_id, action, entity_type, entity_id,\
             agent_id, run_id, details, idempotency_key\
         ) VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text,\
                   $7::uuid, $8::uuid, $9::jsonb, $10::text)\
         RETURNING id::text AS id",
        vec![
            MutationBind::Uuid(scope.as_str().into()),
            MutationBind::Text(actor.actor_type.into()),
            MutationBind::Text(actor.actor_id),
            MutationBind::Text(action.into()),
            MutationBind::Text(entity_type.into()),
            MutationBind::Text(entity_id.into()),
            MutationBind::NullableUuid(actor.agent_id),
            MutationBind::NullableUuid(actor.run_id),
            MutationBind::Json(details),
            MutationBind::Text(key.as_str().into()),
        ],
    )
}

fn finalize_ledger_plan(
    scope: &TrustedOrganizationId,
    ledger_id: &str,
    target: LedgerTarget<'_>,
    stored_outcome: Value,
    activity_id: &str,
) -> MutationQueryPlan {
    match target {
        LedgerTarget::Issue(issue_id) => plan(
            "UPDATE issue_mutation_commands\
                SET issue_id = $3::uuid, outcome = $4::jsonb, activity_id = $5::uuid\
              WHERE org_id = $1::uuid AND id = $2::uuid\
              RETURNING id::text AS id, activity_id::text AS activity_id",
            vec![
                MutationBind::Uuid(scope.as_str().into()),
                MutationBind::Uuid(ledger_id.into()),
                MutationBind::Uuid(issue_id.into()),
                MutationBind::Json(stored_outcome),
                MutationBind::Uuid(activity_id.into()),
            ],
        ),
        LedgerTarget::Approval(approval_id) => plan(
            "UPDATE issue_mutation_commands\
                SET approval_id = $3::uuid, outcome = $4::jsonb, activity_id = $5::uuid\
              WHERE org_id = $1::uuid AND id = $2::uuid\
              RETURNING id::text AS id, activity_id::text AS activity_id",
            vec![
                MutationBind::Uuid(scope.as_str().into()),
                MutationBind::Uuid(ledger_id.into()),
                MutationBind::Uuid(approval_id.into()),
                MutationBind::Json(stored_outcome),
                MutationBind::Uuid(activity_id.into()),
            ],
        ),
    }
}

fn actor_sql_parts(actor: &ActorRef) -> ActorSqlParts {
    match actor {
        ActorRef::Agent {
            agent_id, run_id, ..
        } => ActorSqlParts {
            actor_type: "agent",
            actor_id: agent_id.as_str().into(),
            agent_id: Some(agent_id.as_str().into()),
            run_id: run_id.as_ref().map(|value| value.as_str().into()),
        },
        ActorRef::User { user_id, .. } => ActorSqlParts {
            actor_type: "user",
            actor_id: user_id.as_str().into(),
            agent_id: None,
            run_id: None,
        },
    }
}

fn issue_status_text(status: IssueStatus) -> &'static str {
    match status {
        IssueStatus::Backlog => "backlog",
        IssueStatus::Todo => "todo",
        IssueStatus::InProgress => "in_progress",
        IssueStatus::InReview => "in_review",
        IssueStatus::Blocked => "blocked",
        IssueStatus::Done => "done",
        IssueStatus::Cancelled => "cancelled",
    }
}

fn approval_decision_text(decision: ApprovalDecision) -> (&'static str, &'static str) {
    match decision {
        ApprovalDecision::Approve => ("approved", "approve"),
        ApprovalDecision::Reject => ("rejected", "reject"),
        ApprovalDecision::RequestChanges => ("changes_requested", "request_changes"),
    }
}

fn approval_type(value: &str, id: &str) -> Result<ApprovalType, IssueMutationError> {
    match value {
        "budget_override_required" => Ok(ApprovalType::BudgetOverrideRequired),
        "issue_action" => Ok(ApprovalType::IssueAction),
        "agent_activation" => Ok(ApprovalType::AgentActivation),
        "goal_change" => Ok(ApprovalType::GoalChange),
        _ => Err(IssueMutationError::InvalidStoredState {
            entity: "approval",
            id: id.into(),
            detail: format!("unknown approval type {value}"),
        }),
    }
}

fn approval_status(value: &str, id: &str) -> Result<ApprovalStatus, IssueMutationError> {
    match value {
        "pending" => Ok(ApprovalStatus::Pending),
        "approved" => Ok(ApprovalStatus::Approved),
        "rejected" => Ok(ApprovalStatus::Rejected),
        "changes_requested" | "revision_requested" => Ok(ApprovalStatus::ChangesRequested),
        "cancelled" => Ok(ApprovalStatus::Cancelled),
        _ => Err(IssueMutationError::InvalidStoredState {
            entity: "approval",
            id: id.into(),
            detail: format!("unknown approval status {value}"),
        }),
    }
}

fn approval_decision(value: Option<&str>) -> Option<ApprovalDecision> {
    match value {
        Some("approve") | Some("approved") => Some(ApprovalDecision::Approve),
        Some("reject") | Some("rejected") => Some(ApprovalDecision::Reject),
        Some("request_changes") | Some("changes_requested") => {
            Some(ApprovalDecision::RequestChanges)
        }
        _ => None,
    }
}

fn issue_status(value: &str, id: &str) -> Result<IssueStatus, IssueMutationError> {
    match value {
        "backlog" => Ok(IssueStatus::Backlog),
        "todo" => Ok(IssueStatus::Todo),
        "in_progress" => Ok(IssueStatus::InProgress),
        "in_review" => Ok(IssueStatus::InReview),
        "blocked" => Ok(IssueStatus::Blocked),
        "done" => Ok(IssueStatus::Done),
        "cancelled" => Ok(IssueStatus::Cancelled),
        _ => Err(IssueMutationError::InvalidStoredState {
            entity: "issue",
            id: id.into(),
            detail: format!("unknown issue status {value}"),
        }),
    }
}

fn principal(
    scope: &TrustedOrganizationId,
    agent_id: Option<&str>,
    user_id: Option<&str>,
    role: &'static str,
) -> Result<Option<PrincipalRef>, IssueMutationError> {
    match (agent_id, user_id) {
        (Some(_), Some(_)) => Err(DomainError::MultiplePrincipals { role }.into()),
        (Some(agent_id), None) => Ok(Some(PrincipalRef::agent(
            scope.0.clone(),
            AgentId::new(agent_id),
        ))),
        (None, Some(user_id)) => Ok(Some(PrincipalRef::user(
            scope.0.clone(),
            rudder_issue_core::UserId::new(user_id),
        ))),
        (None, None) => Ok(None),
    }
}

fn issue_from_row(
    scope: &TrustedOrganizationId,
    row: &IssueMutationRow,
) -> Result<Issue, IssueMutationError> {
    if row.org_id != scope.as_str() {
        return Err(IssueMutationError::InvalidStoredState {
            entity: "issue",
            id: row.id.clone(),
            detail: "row organization differs from trusted scope".into(),
        });
    }
    let identity = IssueRef::new(scope.0.clone(), IssueId::new(row.id.clone()));
    let mut issue = Issue::new(
        identity,
        row.title.clone(),
        issue_status(&row.status, &row.id)?,
        principal(
            scope,
            row.assignee_agent_id.as_deref(),
            row.assignee_user_id.as_deref(),
            "assignee",
        )?,
        principal(
            scope,
            row.reviewer_agent_id.as_deref(),
            row.reviewer_user_id.as_deref(),
            "reviewer",
        )?,
    )?;
    issue.revision = revision(row.revision, "issue", &row.id)?;
    issue.fencing_token = revision(row.fencing_token, "issue", &row.id)?;
    issue.checkout_run_id = row.checkout_run_id.clone().map(RunId::new);
    issue.execution_run_id = row.execution_run_id.clone().map(RunId::new);
    issue.validate()?;
    Ok(issue)
}

fn ensure_no_checkout_lease(row: &IssueMutationRow) -> Result<(), IssueMutationError> {
    let held_run = row
        .checkout_run_id
        .clone()
        .or_else(|| row.execution_run_id.clone())
        .or_else(|| row.checkout_lease_owner.clone());
    if held_run.is_some() || row.checkout_lease_expires_at.is_some() {
        return Err(DomainError::LeaseHeld {
            run_id: RunId::new(held_run.unwrap_or_else(|| "lease".into())),
        }
        .into());
    }
    Ok(())
}

fn approval_target_issue_id(payload: &Value) -> Option<String> {
    payload
        .get("issueId")
        .and_then(Value::as_str)
        .or_else(|| payload.get("primaryIssueId").and_then(Value::as_str))
        .map(str::to_owned)
        .or_else(|| {
            payload
                .get("issueIds")
                .and_then(Value::as_array)
                .and_then(|ids| ids.first())
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
}

fn approval_requester(
    scope: &TrustedOrganizationId,
    row: &ApprovalMutationRow,
) -> Result<ActorRef, IssueMutationError> {
    match (
        row.requested_by_agent_id.as_deref(),
        row.requested_by_user_id.as_deref(),
    ) {
        (Some(_), Some(_)) => Err(DomainError::MultiplePrincipals {
            role: "approval requester",
        }
        .into()),
        (Some(agent_id), None) => Ok(ActorRef::agent(
            scope.0.clone(),
            AgentId::new(agent_id),
            None,
        )),
        (None, Some(user_id)) => Ok(ActorRef::user(
            scope.0.clone(),
            rudder_issue_core::UserId::new(user_id),
        )),
        (None, None) => Err(IssueMutationError::InvalidStoredState {
            entity: "approval",
            id: row.id.clone(),
            detail: "approval requester is missing".into(),
        }),
    }
}

fn approval_from_row(
    scope: &TrustedOrganizationId,
    row: &ApprovalMutationRow,
) -> Result<Approval, IssueMutationError> {
    if row.org_id != scope.as_str() {
        return Err(IssueMutationError::InvalidStoredState {
            entity: "approval",
            id: row.id.clone(),
            detail: "row organization differs from trusted scope".into(),
        });
    }
    let issue_id = approval_target_issue_id(&row.payload).ok_or_else(|| {
        IssueMutationError::InvalidStoredState {
            entity: "approval",
            id: row.id.clone(),
            detail: "payload has no issueId, primaryIssueId, or issueIds target".into(),
        }
    })?;
    let identity = ApprovalRef::new(
        scope.0.clone(),
        rudder_issue_core::ApprovalId::new(row.id.clone()),
    );
    let mut approval = Approval::new(
        identity,
        approval_type(&row.approval_type, &row.id)?,
        rudder_issue_core::GovernedTarget::issue(IssueRef::new(
            scope.0.clone(),
            IssueId::new(issue_id),
        )),
        approval_requester(scope, row)?,
    )?;
    approval.status = approval_status(&row.status, &row.id)?;
    approval.revision = revision(row.revision, "approval", &row.id)?;
    approval.decision = approval_decision(row.decision.as_deref());
    approval.note = row.decision_note.clone();
    approval.validate()?;
    Ok(approval)
}

fn stored_outcome(command_type: &str, fingerprint: &str, result: Value, evidence: Value) -> Value {
    json!({
        "state": "applied",
        "commandType": command_type,
        "fingerprint": fingerprint,
        "evidence": evidence,
        "result": result,
    })
}

fn replay_receipt(
    row: LedgerRow,
    scope: &TrustedOrganizationId,
    key: &IdempotencyKey,
    command_type: &str,
    fingerprint: &str,
    target: LedgerTarget<'_>,
) -> Result<MutationReceipt, IssueMutationError> {
    if row.org_id != scope.as_str()
        || row.idempotency_key != key.as_str()
        || row.command_type != command_type
        || row.command_fingerprint != fingerprint
    {
        return Err(IssueMutationError::IdempotencyConflict { key: key.clone() });
    }
    let target_matches = match target {
        LedgerTarget::Issue(issue_id) => {
            row.issue_id.as_deref() == Some(issue_id) && row.approval_id.is_none()
        }
        LedgerTarget::Approval(approval_id) => {
            row.approval_id.as_deref() == Some(approval_id) && row.issue_id.is_none()
        }
    };
    let Some(activity_id) = row.activity_id else {
        return Err(IssueMutationError::IncompleteLedger { key: key.clone() });
    };
    if !target_matches
        || row.outcome.get("state").and_then(Value::as_str) != Some("applied")
        || row.outcome.get("commandType").and_then(Value::as_str) != Some(command_type)
        || row.outcome.get("fingerprint").and_then(Value::as_str) != Some(fingerprint)
    {
        return Err(IssueMutationError::IncompleteLedger { key: key.clone() });
    }
    let Some(outcome) = row.outcome.get("result").cloned() else {
        return Err(IssueMutationError::IncompleteLedger { key: key.clone() });
    };
    Ok(MutationReceipt {
        command_type: command_type.into(),
        idempotency_key: key.clone(),
        ledger_id: row.id,
        activity_id,
        outcome,
        replayed: true,
    })
}

enum Reservation {
    New(String),
    Replay(MutationReceipt),
}

struct ReservationRequest<'a> {
    reserve: &'a MutationQueryPlan,
    lookup: &'a MutationQueryPlan,
    scope: &'a TrustedOrganizationId,
    key: &'a IdempotencyKey,
    command_type: &'a str,
    fingerprint: &'a str,
    target: LedgerTarget<'a>,
}

async fn reserve_or_replay(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    request: ReservationRequest<'_>,
) -> Result<Reservation, IssueMutationError> {
    if let Some(row) = bind_query_as::<LedgerIdRow>(request.reserve)
        .fetch_optional(&mut **tx)
        .await?
    {
        return Ok(Reservation::New(row.id));
    }
    let row = bind_query_as::<LedgerRow>(request.lookup)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| IssueMutationError::IncompleteLedger {
            key: request.key.clone(),
        })?;
    Ok(Reservation::Replay(replay_receipt(
        row,
        request.scope,
        request.key,
        request.command_type,
        request.fingerprint,
        request.target,
    )?))
}

fn bind_query_as<'q, O>(
    plan: &'q MutationQueryPlan,
) -> QueryAs<'q, Postgres, O, sqlx::postgres::PgArguments>
where
    O: for<'r> FromRow<'r, PgRow>,
{
    let mut query = sqlx::query_as::<_, O>(&plan.sql);
    for bind in &plan.binds {
        query = match bind {
            MutationBind::Uuid(value) | MutationBind::Text(value) => query.bind(value.clone()),
            MutationBind::NullableUuid(value) | MutationBind::NullableText(value) => {
                query.bind(value.clone())
            }
            MutationBind::BigInt(value) => query.bind(*value),
            MutationBind::Json(value) => query.bind(value.clone()),
            MutationBind::Timestamp(value) => query.bind(*value),
        };
    }
    query
}

/// Build all checkout queries without executing them.
pub fn checkout_query_plans(
    scope: &TrustedOrganizationId,
    command: &CheckoutCommand,
    options: &CheckoutOptions,
) -> Result<CheckoutQueryPlans, IssueMutationError> {
    ensure_issue_scope(scope, &command.issue, &command.actor)?;
    let fingerprint = command_fingerprint(CHECKOUT_COMMAND_TYPE, scope, command, options)?;
    Ok(CheckoutQueryPlans {
        reserve_ledger: reserve_ledger_plan(
            scope,
            CHECKOUT_COMMAND_TYPE,
            &command.idempotency_key,
            &fingerprint,
        ),
        load_issue: load_issue_plan(scope, &command.issue.issue_id),
        update_issue: update_checkout_plan(scope, command, options)?,
        insert_activity: activity_plan(
            scope,
            &command.actor,
            ActivityKind::Checkout,
            command.issue.issue_id.as_str(),
            json!({"state": "pending"}),
            &command.idempotency_key,
        ),
        finalize_ledger: finalize_ledger_plan(
            scope,
            "ledger-id",
            LedgerTarget::Issue(command.issue.issue_id.as_str()),
            json!({"state": "pending"}),
            "activity-id",
        ),
    })
}

/// Build all review-decision queries without executing them.
pub fn review_decision_query_plans(
    scope: &TrustedOrganizationId,
    command: &ReviewDecisionCommand,
) -> Result<ReviewQueryPlans, IssueMutationError> {
    ensure_issue_scope(scope, &command.issue, &command.actor)?;
    let fingerprint = fingerprint_value(REVIEW_COMMAND_TYPE, scope, command, None)?;
    Ok(ReviewQueryPlans {
        reserve_ledger: reserve_ledger_plan(
            scope,
            REVIEW_COMMAND_TYPE,
            &command.idempotency_key,
            &fingerprint,
        ),
        load_issue: load_issue_plan(scope, &command.issue.issue_id),
        update_issue: update_review_plan(scope, command)?,
        insert_activity: activity_plan(
            scope,
            &command.actor,
            ActivityKind::Review,
            command.issue.issue_id.as_str(),
            json!({"state": "pending"}),
            &command.idempotency_key,
        ),
        finalize_ledger: finalize_ledger_plan(
            scope,
            "ledger-id",
            LedgerTarget::Issue(command.issue.issue_id.as_str()),
            json!({"state": "pending"}),
            "activity-id",
        ),
    })
}

/// Build all approval-decision queries without executing them.
pub fn approval_decision_query_plans(
    scope: &TrustedOrganizationId,
    command: &ApprovalDecisionCommand,
) -> Result<ApprovalQueryPlans, IssueMutationError> {
    ensure_approval_scope(scope, &command.approval, &command.actor)?;
    let fingerprint = fingerprint_value(APPROVAL_COMMAND_TYPE, scope, command, None)?;
    Ok(ApprovalQueryPlans {
        reserve_ledger: reserve_ledger_plan(
            scope,
            APPROVAL_COMMAND_TYPE,
            &command.idempotency_key,
            &fingerprint,
        ),
        load_approval: load_approval_plan(scope, &command.approval.approval_id),
        update_approval: update_approval_plan(scope, command)?,
        insert_activity: activity_plan(
            scope,
            &command.actor,
            ActivityKind::Approval,
            command.approval.approval_id.as_str(),
            json!({"state": "pending"}),
            &command.idempotency_key,
        ),
        finalize_ledger: finalize_ledger_plan(
            scope,
            "ledger-id",
            LedgerTarget::Approval(command.approval.approval_id.as_str()),
            json!({"state": "pending"}),
            "activity-id",
        ),
    })
}

#[derive(Clone)]
pub struct IssueMutationRepository {
    pool: PgPool,
}

impl IssueMutationRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub fn from_pool(pool: PgPool) -> Self {
        Self::new(pool)
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn checkout(
        &self,
        scope: &TrustedOrganizationId,
        command: CheckoutCommand,
        options: CheckoutOptions,
    ) -> Result<MutationReceipt, IssueMutationError> {
        let plans = checkout_query_plans(scope, &command, &options)?;
        let fingerprint = command_fingerprint(CHECKOUT_COMMAND_TYPE, scope, &command, &options)?;
        let mut tx = self.pool.begin().await?;
        let lookup = ledger_lookup_plan(scope, &command.idempotency_key);
        let reservation = reserve_or_replay(
            &mut tx,
            ReservationRequest {
                reserve: &plans.reserve_ledger,
                lookup: &lookup,
                scope,
                key: &command.idempotency_key,
                command_type: CHECKOUT_COMMAND_TYPE,
                fingerprint: &fingerprint,
                target: LedgerTarget::Issue(command.issue.issue_id.as_str()),
            },
        )
        .await?;
        let ledger_id = match reservation {
            Reservation::Replay(receipt) => {
                tx.commit().await?;
                return Ok(receipt);
            }
            Reservation::New(id) => id,
        };
        let row = bind_query_as::<IssueMutationRow>(&plans.load_issue)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| IssueMutationError::NotFound {
                entity: "issue",
                id: command.issue.issue_id.as_str().into(),
            })?;
        ensure_no_checkout_lease(&row)?;
        let mut issue = issue_from_row(scope, &row)?;
        let domain_outcome = issue.checkout(command.clone(), options.fencing_token)?;
        let result = serde_json::to_value(&domain_outcome)?;
        let update = update_checkout_plan(scope, &command, &options)?;
        let updated = bind_query_as::<IssueUpdateRow>(&update)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(IssueMutationError::ConcurrentModification)?;
        if updated.revision != i64::try_from(issue.revision).unwrap_or(i64::MAX)
            || updated.fencing_token != i64::try_from(issue.fencing_token).unwrap_or(i64::MAX)
        {
            return Err(IssueMutationError::ConcurrentModification);
        }
        let stored = stored_outcome(
            CHECKOUT_COMMAND_TYPE,
            &fingerprint,
            result.clone(),
            json!({
                "targetAgentId": command.target_agent_id.as_str(),
                "runId": command.run_id.as_ref().map(RunId::as_str),
                "fencingToken": options.fencing_token.to_string(),
                "leaseExpiresAt": options
                    .lease_expires_at
                    .map(|value| value.unix_timestamp_nanos().to_string()),
            }),
        );
        let activity = activity_plan(
            scope,
            &command.actor,
            ActivityKind::Checkout,
            command.issue.issue_id.as_str(),
            stored.clone(),
            &command.idempotency_key,
        );
        let activity_id = bind_query_as::<ActivityIdRow>(&activity)
            .fetch_one(&mut *tx)
            .await?
            .id;
        let finalize = finalize_ledger_plan(
            scope,
            &ledger_id,
            LedgerTarget::Issue(command.issue.issue_id.as_str()),
            stored,
            &activity_id,
        );
        let finalized = bind_query_as::<FinalizedLedgerRow>(&finalize)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(IssueMutationError::ConcurrentModification)?;
        tx.commit().await?;
        Ok(MutationReceipt {
            command_type: CHECKOUT_COMMAND_TYPE.into(),
            idempotency_key: command.idempotency_key,
            ledger_id: finalized.id,
            activity_id: finalized.activity_id,
            outcome: result,
            replayed: false,
        })
    }

    pub async fn decide_review(
        &self,
        scope: &TrustedOrganizationId,
        command: ReviewDecisionCommand,
    ) -> Result<MutationReceipt, IssueMutationError> {
        let plans = review_decision_query_plans(scope, &command)?;
        let fingerprint = fingerprint_value(REVIEW_COMMAND_TYPE, scope, &command, None)?;
        let mut tx = self.pool.begin().await?;
        let lookup = ledger_lookup_plan(scope, &command.idempotency_key);
        let reservation = reserve_or_replay(
            &mut tx,
            ReservationRequest {
                reserve: &plans.reserve_ledger,
                lookup: &lookup,
                scope,
                key: &command.idempotency_key,
                command_type: REVIEW_COMMAND_TYPE,
                fingerprint: &fingerprint,
                target: LedgerTarget::Issue(command.issue.issue_id.as_str()),
            },
        )
        .await?;
        let ledger_id = match reservation {
            Reservation::Replay(receipt) => {
                tx.commit().await?;
                return Ok(receipt);
            }
            Reservation::New(id) => id,
        };
        let row = bind_query_as::<IssueMutationRow>(&plans.load_issue)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| IssueMutationError::NotFound {
                entity: "issue",
                id: command.issue.issue_id.as_str().into(),
            })?;
        let mut issue = issue_from_row(scope, &row)?;
        let domain_outcome = issue.decide_review(command.clone())?;
        let result = serde_json::to_value(&domain_outcome)?;
        let update = update_review_plan(scope, &command)?;
        let updated = bind_query_as::<IssueUpdateRow>(&update)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(IssueMutationError::ConcurrentModification)?;
        if updated.revision != i64::try_from(issue.revision).unwrap_or(i64::MAX)
            || updated.fencing_token != i64::try_from(issue.fencing_token).unwrap_or(i64::MAX)
        {
            return Err(IssueMutationError::ConcurrentModification);
        }
        let stored = stored_outcome(
            REVIEW_COMMAND_TYPE,
            &fingerprint,
            result.clone(),
            json!({
                "decision": command.decision,
                "comment": command.comment.clone(),
            }),
        );
        let activity = activity_plan(
            scope,
            &command.actor,
            ActivityKind::Review,
            command.issue.issue_id.as_str(),
            stored.clone(),
            &command.idempotency_key,
        );
        let activity_id = bind_query_as::<ActivityIdRow>(&activity)
            .fetch_one(&mut *tx)
            .await?
            .id;
        let finalize = finalize_ledger_plan(
            scope,
            &ledger_id,
            LedgerTarget::Issue(command.issue.issue_id.as_str()),
            stored,
            &activity_id,
        );
        let finalized = bind_query_as::<FinalizedLedgerRow>(&finalize)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(IssueMutationError::ConcurrentModification)?;
        tx.commit().await?;
        Ok(MutationReceipt {
            command_type: REVIEW_COMMAND_TYPE.into(),
            idempotency_key: command.idempotency_key,
            ledger_id: finalized.id,
            activity_id: finalized.activity_id,
            outcome: result,
            replayed: false,
        })
    }

    pub async fn decide_approval(
        &self,
        scope: &TrustedOrganizationId,
        command: ApprovalDecisionCommand,
    ) -> Result<MutationReceipt, IssueMutationError> {
        let plans = approval_decision_query_plans(scope, &command)?;
        let fingerprint = fingerprint_value(APPROVAL_COMMAND_TYPE, scope, &command, None)?;
        let mut tx = self.pool.begin().await?;
        let lookup = ledger_lookup_plan(scope, &command.idempotency_key);
        let reservation = reserve_or_replay(
            &mut tx,
            ReservationRequest {
                reserve: &plans.reserve_ledger,
                lookup: &lookup,
                scope,
                key: &command.idempotency_key,
                command_type: APPROVAL_COMMAND_TYPE,
                fingerprint: &fingerprint,
                target: LedgerTarget::Approval(command.approval.approval_id.as_str()),
            },
        )
        .await?;
        let ledger_id = match reservation {
            Reservation::Replay(receipt) => {
                tx.commit().await?;
                return Ok(receipt);
            }
            Reservation::New(id) => id,
        };
        let row = bind_query_as::<ApprovalMutationRow>(&plans.load_approval)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| IssueMutationError::NotFound {
                entity: "approval",
                id: command.approval.approval_id.as_str().into(),
            })?;
        if row.decision_idempotency_key.is_some() {
            return Err(IssueMutationError::ApprovalDecisionKeyConflict {
                key: command.idempotency_key,
            });
        }
        let mut approval = approval_from_row(scope, &row)?;
        let domain_outcome = approval.decide(command.clone())?;
        let result = serde_json::to_value(&domain_outcome)?;
        let update = update_approval_plan(scope, &command)?;
        let updated = bind_query_as::<ApprovalUpdateRow>(&update)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(IssueMutationError::ConcurrentModification)?;
        if updated.revision != i64::try_from(approval.revision).unwrap_or(i64::MAX) {
            return Err(IssueMutationError::ConcurrentModification);
        }
        let stored = stored_outcome(
            APPROVAL_COMMAND_TYPE,
            &fingerprint,
            result.clone(),
            json!({
                "decision": command.decision,
                "note": command.note.clone(),
            }),
        );
        let activity = activity_plan(
            scope,
            &command.actor,
            ActivityKind::Approval,
            command.approval.approval_id.as_str(),
            stored.clone(),
            &command.idempotency_key,
        );
        let activity_id = bind_query_as::<ActivityIdRow>(&activity)
            .fetch_one(&mut *tx)
            .await?
            .id;
        let finalize = finalize_ledger_plan(
            scope,
            &ledger_id,
            LedgerTarget::Approval(command.approval.approval_id.as_str()),
            stored,
            &activity_id,
        );
        let finalized = bind_query_as::<FinalizedLedgerRow>(&finalize)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(IssueMutationError::ConcurrentModification)?;
        tx.commit().await?;
        Ok(MutationReceipt {
            command_type: APPROVAL_COMMAND_TYPE.into(),
            idempotency_key: command.idempotency_key,
            ledger_id: finalized.id,
            activity_id: finalized.activity_id,
            outcome: result,
            replayed: false,
        })
    }
}
