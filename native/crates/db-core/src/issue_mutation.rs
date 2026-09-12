//! Bounded, private SQLx mutation adapter for the migrated issue/governance schema.
//!
//! This module is deliberately not wired to an HTTP route or a public writer. The
//! caller must provide [`TrustedOrganizationId`] from authenticated host state;
//! command payloads are checked against that scope but never choose the SQL
//! organization predicate. Approval operations additionally require a
//! [`TrustedApprovalAuthorization`] produced by the host after its board/approval
//! authorization check. The adapter records approval status/decision state only;
//! type-specific side effects for non-issue approvals remain owned by the host.
//! Every mutation reserves a durable command-ledger row, applies the issue-core
//! state machine under row locks and optimistic preconditions, and commits its
//! activity evidence and final ledger receipt in one PostgreSQL transaction.

use rudder_issue_core::{
    ActorRef, AgentId, Approval, ApprovalDecision, ApprovalDecisionCommand, ApprovalId,
    ApprovalRef, ApprovalResubmissionCommand, ApprovalStatus, ApprovalType, AttentionRequest,
    CheckoutCommand, DomainError, IdempotencyKey, Issue, IssueId, IssueRef, IssueStatus,
    OrganizationId, PrincipalRef, ReviewDecisionCommand, RunId, WakeReason, WakeRelationship,
    WakeRequest, route_comment_attention as route_domain_comment_attention,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool, Postgres, postgres::PgRow, query::QueryAs};
use std::collections::BTreeSet;
use thiserror::Error;
use time::OffsetDateTime;

pub const CHECKOUT_COMMAND_TYPE: &str = "issue.checkout";
pub const REVIEW_COMMAND_TYPE: &str = "issue.review_decision";
pub const APPROVAL_COMMAND_TYPE: &str = "approval.decision";
pub const APPROVAL_RESUBMISSION_COMMAND_TYPE: &str = "approval.resubmission";
pub const COMMENT_ATTENTION_COMMAND_TYPE: &str = "issue.comment_attention";
const MAX_COMMENT_ATTENTION_MENTIONS: usize = 64;

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

/// An opaque host capability required to construct approval authorization.
///
/// The private field prevents model/client payloads from deserializing or
/// assembling this capability. `for_tests` exists only inside the test build;
/// production callers must obtain the capability from their authenticated host
/// boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostApprovalCapability {
    _opaque: (),
}

impl HostApprovalCapability {
    #[cfg(test)]
    pub(crate) fn for_tests() -> Self {
        Self { _opaque: () }
    }
}

/// Host-trusted authorization for one approval operation.
///
/// The host creates this value only after authenticating the actor and checking
/// the board/approval policy. The command actor and approval id must match this
/// context; command payloads cannot grant themselves approval authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrustedApprovalAuthorization {
    organization: TrustedOrganizationId,
    approval_id: ApprovalId,
    actor: ActorRef,
}

impl TrustedApprovalAuthorization {
    pub fn from_host(
        _capability: &HostApprovalCapability,
        organization: TrustedOrganizationId,
        approval_id: ApprovalId,
        actor: ActorRef,
    ) -> Result<Self, IssueMutationError> {
        if !matches!(actor, ActorRef::User { .. }) {
            return Err(IssueMutationError::ApprovalAuthorizationMismatch);
        }
        if actor.organization_id() != organization.as_id() {
            return Err(IssueMutationError::ApprovalAuthorizationMismatch);
        }
        Ok(Self {
            organization,
            approval_id,
            actor,
        })
    }

    pub fn organization(&self) -> &TrustedOrganizationId {
        &self.organization
    }

    pub fn approval_id(&self) -> &ApprovalId {
        &self.approval_id
    }

    pub fn actor(&self) -> &ActorRef {
        &self.actor
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
    NullableJson(Option<Value>),
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
    pub validate_run: MutationQueryPlan,
    pub load_issue: MutationQueryPlan,
    pub update_issue: MutationQueryPlan,
    pub insert_activity: MutationQueryPlan,
    pub finalize_ledger: MutationQueryPlan,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ReviewQueryPlans {
    pub reserve_ledger: MutationQueryPlan,
    pub validate_run: Option<MutationQueryPlan>,
    pub load_issue: MutationQueryPlan,
    pub update_issue: MutationQueryPlan,
    pub insert_comment: MutationQueryPlan,
    pub insert_activity: MutationQueryPlan,
    pub finalize_ledger: MutationQueryPlan,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ApprovalQueryPlans {
    pub reserve_ledger: MutationQueryPlan,
    pub validate_run: Option<MutationQueryPlan>,
    pub load_approval: MutationQueryPlan,
    pub target_associations: MutationQueryPlan,
    pub update_approval: MutationQueryPlan,
    pub insert_activity: MutationQueryPlan,
    pub finalize_ledger: MutationQueryPlan,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ApprovalResubmissionOptions {
    pub payload: Option<Value>,
}

impl ApprovalResubmissionOptions {
    pub fn new(payload: Option<Value>) -> Self {
        Self { payload }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ApprovalResubmissionQueryPlans {
    pub reserve_ledger: MutationQueryPlan,
    pub validate_run: Option<MutationQueryPlan>,
    pub load_approval: MutationQueryPlan,
    pub target_associations: MutationQueryPlan,
    pub update_approval: MutationQueryPlan,
    pub insert_activity: MutationQueryPlan,
    pub finalize_ledger: MutationQueryPlan,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CommentAttentionQueryPlans {
    pub reserve_ledger: MutationQueryPlan,
    pub validate_run: Option<MutationQueryPlan>,
    pub load_issue: MutationQueryPlan,
    pub load_comment: MutationQueryPlan,
    pub validate_mentioned_agents: Option<MutationQueryPlan>,
    pub insert_wakeup: Option<MutationQueryPlan>,
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
    #[error("approval authorization does not match the host-trusted approval context")]
    ApprovalAuthorizationMismatch,
    #[error("optimistic mutation precondition changed before persistence")]
    ConcurrentModification,
    #[error("{field} is outside PostgreSQL bigint range")]
    NumericOverflow { field: &'static str },
    #[error("comment attention mentions exceed the bounded limit")]
    TooManyMentions,
    #[error("comment attention {field} must be a canonical UUID")]
    InvalidCommentAttentionIdentity { field: &'static str },
    #[error("comment author does not match the trusted attention actor")]
    CommentAuthorMismatch,
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
    ApprovalResubmission,
    CommentAttention,
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
    user_id: Option<String>,
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
struct CommentIdRow {
    id: String,
}

#[derive(Clone, Debug, FromRow)]
struct CommentAttentionRow {
    author_agent_id: Option<String>,
    author_user_id: Option<String>,
}

#[derive(Clone, Debug, FromRow)]
struct RunScopeRow {
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
    execution_agent_name_key: Option<String>,
    execution_locked_at: Option<OffsetDateTime>,
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
    decided_by_user_id: Option<String>,
    decided_at: Option<OffsetDateTime>,
    requested_by_agent_id: Option<String>,
    requested_by_user_id: Option<String>,
    payload: Value,
    linked_issue_ids: Value,
}

#[derive(Clone, Debug, FromRow)]
struct ApprovalUpdateRow {
    revision: i64,
}

#[derive(Clone, Debug, FromRow)]
struct ApprovalResubmissionUpdateRow {
    revision: i64,
    payload: Value,
}

#[derive(Clone, Debug, FromRow)]
struct ApprovalTargetAssociationRow {
    issue_id: String,
    association_org_id: String,
    joined_issue_id: Option<String>,
    issue_org_id: Option<String>,
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

fn ensure_approval_authorization(
    authorization: &TrustedApprovalAuthorization,
    command_approval: &ApprovalRef,
    command_actor: &ActorRef,
) -> Result<(), IssueMutationError> {
    ensure_approval_scope(
        &authorization.organization,
        command_approval,
        &authorization.actor,
    )?;
    if authorization.approval_id != command_approval.approval_id
        || authorization.actor != *command_actor
    {
        return Err(IssueMutationError::ApprovalAuthorizationMismatch);
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
        "INSERT INTO issue_mutation_commands (\n             org_id, command_type, idempotency_key, command_fingerprint, outcome\n         ) VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::jsonb)\n         ON CONFLICT (org_id, idempotency_key) DO NOTHING\n         RETURNING id::text AS id",
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
        "SELECT id::text AS id, org_id::text AS org_id, issue_id::text AS issue_id,\n                approval_id::text AS approval_id, command_type, idempotency_key,\n                command_fingerprint, outcome, activity_id::text AS activity_id\n           FROM issue_mutation_commands\n          WHERE org_id = $1::uuid AND idempotency_key = $2::text\n          FOR UPDATE",
        vec![
            MutationBind::Uuid(scope.as_str().into()),
            MutationBind::Text(key.as_str().into()),
        ],
    )
}

fn load_issue_plan(scope: &TrustedOrganizationId, issue_id: &IssueId) -> MutationQueryPlan {
    plan(
        "SELECT i.id::text AS id, i.org_id::text AS org_id, i.title, i.status,\n                i.assignee_agent_id::text AS assignee_agent_id,\n                i.assignee_user_id, i.reviewer_agent_id::text AS reviewer_agent_id,\n                i.reviewer_user_id, i.revision, i.fencing_token,\n                i.checkout_run_id::text AS checkout_run_id,\n                i.execution_run_id::text AS execution_run_id,\n                i.execution_agent_name_key, i.execution_locked_at, i.checkout_lease_owner, i.checkout_lease_expires_at\n           FROM issues AS i\n          WHERE i.org_id = $1::uuid AND i.id = $2::uuid\n          FOR UPDATE",
        vec![
            MutationBind::Uuid(scope.as_str().into()),
            MutationBind::Uuid(issue_id.as_str().into()),
        ],
    )
}

fn approval_target_associations_plan(
    scope: &TrustedOrganizationId,
    approval_id: &rudder_issue_core::ApprovalId,
) -> MutationQueryPlan {
    plan(
        "SELECT ia.issue_id::text AS issue_id,\n                ia.org_id::text AS association_org_id,\n                i.id::text AS joined_issue_id,\n                i.org_id::text AS issue_org_id\n           FROM issue_approvals AS ia\n           JOIN approvals AS a\n             ON a.id = ia.approval_id AND a.org_id = $1::uuid\n           LEFT JOIN issues AS i\n             ON i.id = ia.issue_id AND i.org_id = ia.org_id\n          WHERE ia.org_id = $1::uuid\n            AND ia.approval_id = $2::uuid\n          ORDER BY ia.created_at, ia.issue_id\n          FOR UPDATE OF ia",
        vec![
            MutationBind::Uuid(scope.as_str().into()),
            MutationBind::Uuid(approval_id.as_str().into()),
        ],
    )
}

fn approval_issue_target(approval: &Approval) -> Option<&IssueId> {
    match &approval.target {
        rudder_issue_core::GovernedTarget::Issue(issue) => Some(&issue.issue_id),
        rudder_issue_core::GovernedTarget::Organization(_) => None,
    }
}

fn resubmission_payload_issue_id(
    approval: &Approval,
    payload: Option<&Value>,
) -> Result<Option<IssueId>, IssueMutationError> {
    let Some(payload) = payload else {
        return Ok(None);
    };
    let target = approval_target_issue_id(payload).map_err(|field| {
        IssueMutationError::InvalidStoredState {
            entity: "approval",
            id: approval.identity.approval_id.as_str().into(),
            detail: format!("resubmission target field {field} is malformed"),
        }
    })?;
    let existing_target = approval_issue_target(approval);
    let Some(target) = target else {
        if existing_target.is_some() {
            return Err(IssueMutationError::InvalidStoredState {
                entity: "approval",
                id: approval.identity.approval_id.as_str().into(),
                detail: "resubmission payload omits the stored issue target".into(),
            });
        }
        return Ok(None);
    };
    if existing_target.map(IssueId::as_str) != Some(target.as_str()) {
        return Err(IssueMutationError::InvalidStoredState {
            entity: "approval",
            id: approval.identity.approval_id.as_str().into(),
            detail: "resubmission target differs from the stored approval target".into(),
        });
    }
    Ok(Some(IssueId::new(target)))
}

fn invalid_resubmission_payload(
    command: &ApprovalResubmissionCommand,
    detail: impl Into<String>,
) -> IssueMutationError {
    IssueMutationError::InvalidStoredState {
        entity: "approval",
        id: command.approval.approval_id.as_str().into(),
        detail: detail.into(),
    }
}

fn validate_resubmission_payload_shape(
    command: &ApprovalResubmissionCommand,
    payload: Option<&Value>,
) -> Result<(), IssueMutationError> {
    if let Some(payload) = payload {
        approval_target_issue_id(payload).map_err(|field| {
            invalid_resubmission_payload(
                command,
                format!("resubmission target field {field} is malformed"),
            )
        })?;
    }
    Ok(())
}

fn verify_resubmission_payload(
    approval: &Approval,
    options: &ApprovalResubmissionOptions,
    payload: &Value,
) -> Result<(), IssueMutationError> {
    let actual_target = approval_target_issue_id(payload).map_err(|field| {
        IssueMutationError::InvalidStoredState {
            entity: "approval",
            id: approval.identity.approval_id.as_str().into(),
            detail: format!("resubmitted payload target field {field} is malformed"),
        }
    })?;
    let expected_target = approval_issue_target(approval).map(IssueId::as_str);
    if actual_target.is_some() && actual_target.as_deref() != expected_target {
        return Err(IssueMutationError::InvalidStoredState {
            entity: "approval",
            id: approval.identity.approval_id.as_str().into(),
            detail: "resubmitted payload target differs from the stored approval target".into(),
        });
    }
    if options.payload.is_some() && actual_target.is_none() && expected_target.is_some() {
        return Err(IssueMutationError::InvalidStoredState {
            entity: "approval",
            id: approval.identity.approval_id.as_str().into(),
            detail: "resubmitted payload omits the stored issue target".into(),
        });
    }
    Ok(())
}

fn validate_issue_target_plan(
    scope: &TrustedOrganizationId,
    issue_id: &IssueId,
) -> MutationQueryPlan {
    plan(
        "SELECT i.id::text AS id\n           FROM issues AS i\n          WHERE i.org_id = $1::uuid AND i.id = $2::uuid\n          FOR SHARE",
        vec![
            MutationBind::Uuid(scope.as_str().into()),
            MutationBind::Uuid(issue_id.as_str().into()),
        ],
    )
}

fn validate_run_plan(
    scope: &TrustedOrganizationId,
    run_id: &RunId,
    agent_id: &AgentId,
) -> MutationQueryPlan {
    plan(
        "SELECT r.id::text AS id\n           FROM heartbeat_runs AS r\n           JOIN agents AS a ON a.id = r.agent_id AND a.org_id = r.org_id\n          WHERE r.org_id = $1::uuid AND r.id = $2::uuid AND r.agent_id = $3::uuid\n            AND r.status IN ('queued', 'running')\n          FOR SHARE",
        vec![
            MutationBind::Uuid(scope.as_str().into()),
            MutationBind::Uuid(run_id.as_str().into()),
            MutationBind::Uuid(agent_id.as_str().into()),
        ],
    )
}

fn validate_review_run_plan(
    scope: &TrustedOrganizationId,
    issue_id: &IssueId,
    run_id: &RunId,
    agent_id: &AgentId,
) -> MutationQueryPlan {
    plan(
        "SELECT r.id::text AS id\n           FROM heartbeat_runs AS r\n           JOIN agents AS a ON a.id = r.agent_id AND a.org_id = r.org_id\n           JOIN issues AS i\n             ON i.org_id = r.org_id\n            AND i.id = $2::uuid\n            AND (i.checkout_run_id = r.id OR i.execution_run_id = r.id)\n          WHERE r.org_id = $1::uuid AND r.id = $3::uuid AND r.agent_id = $4::uuid\n            AND r.status IN ('queued', 'running')\n          FOR SHARE OF r, i",
        vec![
            MutationBind::Uuid(scope.as_str().into()),
            MutationBind::Uuid(issue_id.as_str().into()),
            MutationBind::Uuid(run_id.as_str().into()),
            MutationBind::Uuid(agent_id.as_str().into()),
        ],
    )
}

fn actor_run_plan(scope: &TrustedOrganizationId, actor: &ActorRef) -> Option<MutationQueryPlan> {
    match actor {
        ActorRef::Agent {
            agent_id,
            run_id: Some(run_id),
            ..
        } => Some(validate_run_plan(scope, run_id, agent_id)),
        _ => None,
    }
}

fn review_actor_run_plan(
    scope: &TrustedOrganizationId,
    issue_id: &IssueId,
    actor: &ActorRef,
) -> Result<Option<MutationQueryPlan>, IssueMutationError> {
    match actor {
        ActorRef::Agent {
            agent_id,
            run_id: Some(run_id),
            ..
        } => Ok(Some(validate_review_run_plan(
            scope, issue_id, run_id, agent_id,
        ))),
        ActorRef::Agent { .. } => Err(DomainError::ReviewRunRequired.into()),
        ActorRef::User { .. } => Ok(None),
    }
}

fn insert_comment_plan(
    scope: &TrustedOrganizationId,
    issue_id: &IssueId,
    actor: &ActorRef,
    body: &str,
) -> MutationQueryPlan {
    let actor = actor_sql_parts(actor);
    plan(
        "INSERT INTO issue_comments (\n             org_id, issue_id, author_agent_id, author_user_id, body, created_at, updated_at\n         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, now(), now())\n         RETURNING id::text AS id",
        vec![
            MutationBind::Uuid(scope.as_str().into()),
            MutationBind::Uuid(issue_id.as_str().into()),
            MutationBind::NullableUuid(actor.agent_id),
            MutationBind::NullableText(actor.user_id),
            MutationBind::Text(body.into()),
        ],
    )
}

fn load_approval_plan(
    scope: &TrustedOrganizationId,
    approval_id: &rudder_issue_core::ApprovalId,
) -> MutationQueryPlan {
    plan(
        "SELECT a.id::text AS id, a.org_id::text AS org_id, a.type AS approval_type,\n                a.status, a.revision, a.decision, a.decision_idempotency_key,\n                a.decision_note, a.decided_by_user_id, a.decided_at,\n                a.requested_by_agent_id::text AS requested_by_agent_id,\n                a.requested_by_user_id, a.payload, '[]'::jsonb AS linked_issue_ids\n           FROM approvals AS a\n          WHERE a.org_id = $1::uuid AND a.id = $2::uuid\n          FOR UPDATE",
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
        "UPDATE issues AS i\n            SET status = 'in_progress',\n                checkout_run_id = $6::uuid,\n                execution_run_id = $6::uuid,\n                checkout_lease_owner = $7::text,\n                checkout_lease_expires_at = $8::timestamptz,\n                completed_at = NULL,\n                cancelled_at = NULL,\n                revision = i.revision + 1,\n                fencing_token = $5::int8,\n                started_at = COALESCE(i.started_at, now()),\n                updated_at = now()\n          WHERE i.org_id = $1::uuid AND i.id = $2::uuid\n            AND i.revision = $3::int8 AND i.fencing_token = $4::int8\n            AND i.checkout_run_id IS NULL\n            AND i.execution_run_id IS NULL\n            AND i.checkout_lease_owner IS NULL\n            AND i.checkout_lease_expires_at IS NULL\n          RETURNING i.revision, i.fencing_token",
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
    let run_id = match &command.actor {
        ActorRef::Agent {
            run_id: Some(run_id),
            ..
        } => Some(run_id),
        ActorRef::Agent { .. } => return Err(DomainError::ReviewRunRequired.into()),
        ActorRef::User { .. } => None,
    };
    let active_run_predicate = if run_id.is_some() {
        "\n            AND (i.checkout_run_id = $6::uuid OR i.execution_run_id = $6::uuid)"
    } else {
        ""
    };
    let sql = format!(
        "UPDATE issues AS i\n            SET status = $5::text,\n                checkout_run_id = NULL,\n                execution_run_id = NULL,\n                execution_agent_name_key = NULL,\n                execution_locked_at = NULL,\n                checkout_lease_owner = NULL,\n                checkout_lease_expires_at = NULL,\n                started_at = CASE WHEN $5::text = 'in_progress'\n                                  THEN COALESCE(i.started_at, now())\n                                  ELSE i.started_at END,\n                completed_at = CASE WHEN $5::text = 'done'\n                                    THEN now()\n                                    ELSE NULL END,\n                cancelled_at = CASE WHEN $5::text = 'cancelled'\n                                    THEN now()\n                                    ELSE NULL END,\n                revision = i.revision + 1,\n                updated_at = now()\n          WHERE i.org_id = $1::uuid AND i.id = $2::uuid\n            AND i.revision = $3::int8 AND i.fencing_token = $4::int8\n            AND i.status IN ('in_review', 'blocked'){active_run_predicate}\n          RETURNING i.revision, i.fencing_token"
    );
    let mut binds = vec![
        MutationBind::Uuid(scope.as_str().into()),
        MutationBind::Uuid(command.issue.issue_id.as_str().into()),
        MutationBind::BigInt(expected_revision),
        MutationBind::BigInt(expected_fence),
        MutationBind::Text(issue_status_text(status).into()),
    ];
    if let Some(run_id) = run_id {
        binds.push(MutationBind::Uuid(run_id.as_str().into()));
    }
    Ok(plan(&sql, binds))
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
        "UPDATE approvals AS a\n            SET status = $4::text,\n                revision = a.revision + 1,\n                decision = $5::text,\n                decision_idempotency_key = $6::text,\n                decision_note = $7::text,\n                decided_by_user_id = $8::text,\n                decided_at = now(),\n                updated_at = now()\n          WHERE a.org_id = $1::uuid AND a.id = $2::uuid\n            AND a.revision = $3::int8\n            AND a.status = 'pending'\n            AND a.decision_idempotency_key IS NULL\n          RETURNING a.revision",
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

fn update_approval_resubmission_plan(
    scope: &TrustedOrganizationId,
    command: &ApprovalResubmissionCommand,
    options: &ApprovalResubmissionOptions,
) -> Result<MutationQueryPlan, IssueMutationError> {
    let expected_revision = bigint(command.expected_revision, "expected approval revision")?;
    Ok(plan(
        "UPDATE approvals AS a\n            SET status = 'pending',\n                revision = a.revision + 1,\n                decision = NULL,\n                decision_idempotency_key = NULL,\n                decision_note = NULL,\n                decided_by_user_id = NULL,\n                decided_at = NULL,\n                payload = COALESCE($4::jsonb, a.payload),\n                updated_at = now()\n          WHERE a.org_id = $1::uuid AND a.id = $2::uuid\n            AND a.revision = $3::int8\n            AND a.status = 'revision_requested'\n          RETURNING a.revision, a.payload",
        vec![
            MutationBind::Uuid(scope.as_str().into()),
            MutationBind::Uuid(command.approval.approval_id.as_str().into()),
            MutationBind::BigInt(expected_revision),
            MutationBind::NullableJson(options.payload.clone()),
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
        ActivityKind::ApprovalResubmission => ("approval.resubmitted", "approval"),
        ActivityKind::CommentAttention => ("issue.comment_attention_routed", "issue"),
    };
    plan(
        "INSERT INTO activity_log (\n             org_id, actor_type, actor_id, action, entity_type, entity_id,\n             agent_id, run_id, details, idempotency_key\n         ) VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text,\n                   $7::uuid, $8::uuid, $9::jsonb, $10::text)\n         RETURNING id::text AS id",
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
            "UPDATE issue_mutation_commands\n                SET issue_id = $3::uuid, outcome = $4::jsonb, activity_id = $5::uuid\n              WHERE org_id = $1::uuid AND id = $2::uuid\n              RETURNING id::text AS id, activity_id::text AS activity_id",
            vec![
                MutationBind::Uuid(scope.as_str().into()),
                MutationBind::Uuid(ledger_id.into()),
                MutationBind::Uuid(issue_id.into()),
                MutationBind::Json(stored_outcome),
                MutationBind::Uuid(activity_id.into()),
            ],
        ),
        LedgerTarget::Approval(approval_id) => plan(
            "UPDATE issue_mutation_commands\n                SET approval_id = $3::uuid, outcome = $4::jsonb, activity_id = $5::uuid\n              WHERE org_id = $1::uuid AND id = $2::uuid\n              RETURNING id::text AS id, activity_id::text AS activity_id",
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
            user_id: None,
            run_id: run_id.as_ref().map(|value| value.as_str().into()),
        },
        ActorRef::User { user_id, .. } => ActorSqlParts {
            actor_type: "user",
            actor_id: user_id.as_str().into(),
            agent_id: None,
            user_id: Some(user_id.as_str().into()),
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
        ApprovalDecision::RequestChanges => ("revision_requested", "request_changes"),
    }
}

fn approval_type(value: &str, id: &str) -> Result<ApprovalType, IssueMutationError> {
    match value {
        "hire_agent" => Ok(ApprovalType::HireAgent),
        "approve_ceo_strategy" => Ok(ApprovalType::ApproveCeoStrategy),
        "chat_issue_creation" => Ok(ApprovalType::ChatIssueCreation),
        "chat_operation" => Ok(ApprovalType::ChatOperation),
        "agent_runtime" => Ok(ApprovalType::AgentRuntime),
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
        "changes_requested" | "revision_requested" => Ok(ApprovalStatus::RevisionRequested),
        "cancelled" => Ok(ApprovalStatus::Cancelled),
        _ => Err(IssueMutationError::InvalidStoredState {
            entity: "approval",
            id: id.into(),
            detail: format!("unknown approval status {value}"),
        }),
    }
}

fn approval_decision(
    value: Option<&str>,
    id: &str,
) -> Result<Option<ApprovalDecision>, IssueMutationError> {
    match value {
        None => Ok(None),
        Some("approve") | Some("approved") => Ok(Some(ApprovalDecision::Approve)),
        Some("reject") | Some("rejected") => Ok(Some(ApprovalDecision::Reject)),
        Some("request_changes") | Some("changes_requested") | Some("revision_requested") => {
            Ok(Some(ApprovalDecision::RequestChanges))
        }
        Some(value) => Err(IssueMutationError::InvalidStoredState {
            entity: "approval",
            id: id.into(),
            detail: format!("unknown approval decision {value}"),
        }),
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
        .or_else(|| row.execution_agent_name_key.clone())
        .or_else(|| row.checkout_lease_owner.clone());
    if held_run.is_some()
        || row.execution_locked_at.is_some()
        || row.checkout_lease_expires_at.is_some()
    {
        return Err(DomainError::LeaseHeld {
            run_id: RunId::new(held_run.unwrap_or_else(|| "lease".into())),
        }
        .into());
    }
    Ok(())
}

fn approval_target_issue_id(payload: &Value) -> Result<Option<String>, &'static str> {
    if !payload.is_object() {
        return Err("payload");
    }

    let mut targets = Vec::new();
    let mut add_target = |target: String| {
        if targets.iter().any(|existing| existing != &target) {
            Err("target")
        } else {
            targets.push(target);
            Ok(())
        }
    };

    for key in ["issueId", "primaryIssueId"] {
        if let Some(value) = payload.get(key) {
            match value {
                Value::String(value) if !value.is_empty() => add_target(value.clone())?,
                _ => return Err(key),
            }
        }
    }

    if let Some(value) = payload.get("issueIds") {
        let Value::Array(ids) = value else {
            return Err("issueIds");
        };
        if ids.len() > 1 {
            return Err("issueIds");
        }
        if let Some(value) = ids.first() {
            let Some(issue_id) = value.as_str().filter(|value| !value.is_empty()) else {
                return Err("issueIds");
            };
            add_target(issue_id.to_owned())?;
        }
    }

    Ok(targets.into_iter().next())
}

fn approval_requester(
    scope: &TrustedOrganizationId,
    row: &ApprovalMutationRow,
) -> Result<Option<ActorRef>, IssueMutationError> {
    match (
        row.requested_by_agent_id.as_deref(),
        row.requested_by_user_id.as_deref(),
    ) {
        (Some(_), Some(_)) => Err(DomainError::MultiplePrincipals {
            role: "approval requester",
        }
        .into()),
        (Some(agent_id), None) => Ok(Some(ActorRef::agent(
            scope.0.clone(),
            AgentId::new(agent_id),
            None,
        ))),
        (None, Some(user_id)) => Ok(Some(ActorRef::user(
            scope.0.clone(),
            rudder_issue_core::UserId::new(user_id),
        ))),
        (None, None) => Ok(None),
    }
}

fn approval_linked_issue_id(
    row: &ApprovalMutationRow,
) -> Result<Option<String>, IssueMutationError> {
    let Value::Array(ids) = &row.linked_issue_ids else {
        return Err(IssueMutationError::InvalidStoredState {
            entity: "approval",
            id: row.id.clone(),
            detail: "linked issue targets are not an array".into(),
        });
    };
    if ids.len() > 1 {
        return Err(IssueMutationError::InvalidStoredState {
            entity: "approval",
            id: row.id.clone(),
            detail: "multiple linked issue targets are unsupported".into(),
        });
    }
    ids.first()
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.is_empty())
                .map_or_else(
                    || {
                        Err(IssueMutationError::InvalidStoredState {
                            entity: "approval",
                            id: row.id.clone(),
                            detail: "linked issue target is malformed".into(),
                        })
                    },
                    |value| Ok(Some(value.to_owned())),
                )
        })
        .unwrap_or(Ok(None))
}

fn invalid_approval_state(
    row: &ApprovalMutationRow,
    detail: impl Into<String>,
) -> IssueMutationError {
    IssueMutationError::InvalidStoredState {
        entity: "approval",
        id: row.id.clone(),
        detail: detail.into(),
    }
}

fn approval_from_row(
    scope: &TrustedOrganizationId,
    row: &ApprovalMutationRow,
) -> Result<Approval, IssueMutationError> {
    if row.org_id != scope.as_str() {
        return Err(invalid_approval_state(
            row,
            "row organization differs from trusted scope",
        ));
    }
    let payload_issue_id = approval_target_issue_id(&row.payload).map_err(|field| {
        invalid_approval_state(row, format!("approval target field {field} is malformed"))
    })?;
    let linked_issue_id = approval_linked_issue_id(row)?;
    if matches!(
        (&payload_issue_id, &linked_issue_id),
        (Some(payload_issue_id), Some(linked_issue_id)) if payload_issue_id != linked_issue_id
    ) {
        return Err(invalid_approval_state(
            row,
            "payload and relational issue targets differ",
        ));
    }
    let target = match linked_issue_id.or(payload_issue_id) {
        Some(issue_id) => rudder_issue_core::GovernedTarget::issue(IssueRef::new(
            scope.0.clone(),
            IssueId::new(issue_id),
        )),
        None => rudder_issue_core::GovernedTarget::organization(scope.0.clone()),
    };
    let identity = ApprovalRef::new(scope.0.clone(), ApprovalId::new(row.id.clone()));
    let mut approval = Approval::new(
        identity,
        approval_type(&row.approval_type, &row.id)?,
        target,
        approval_requester(scope, row)?,
    )?;
    let status = approval_status(&row.status, &row.id)?;
    let decision = approval_decision(row.decision.as_deref(), &row.id)?;
    let expected_decision = match status {
        ApprovalStatus::Pending | ApprovalStatus::Cancelled => None,
        ApprovalStatus::Approved => Some(ApprovalDecision::Approve),
        ApprovalStatus::Rejected => Some(ApprovalDecision::Reject),
        ApprovalStatus::RevisionRequested => Some(ApprovalDecision::RequestChanges),
    };
    if decision != expected_decision {
        return Err(invalid_approval_state(
            row,
            "approval status and decision disagree",
        ));
    }
    let has_evidence = row.decision_idempotency_key.is_some()
        || row.decision_note.is_some()
        || row.decided_by_user_id.is_some()
        || row.decided_at.is_some();
    if decision.is_some() {
        if row.decision_idempotency_key.is_none()
            || row.decided_by_user_id.is_none()
            || row.decided_at.is_none()
        {
            return Err(invalid_approval_state(
                row,
                "decided approval is missing decision evidence",
            ));
        }
    } else if has_evidence {
        return Err(invalid_approval_state(
            row,
            "undecided approval contains decision evidence",
        ));
    }
    approval.status = status;
    approval.revision = revision(row.revision, "approval", &row.id)?;
    approval.decision = decision;
    approval.decided_by = row
        .decided_by_user_id
        .as_deref()
        .map(|user_id| ActorRef::user(scope.0.clone(), rudder_issue_core::UserId::new(user_id)));
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
            MutationBind::NullableJson(value) => query.bind(value.clone()),
            MutationBind::Timestamp(value) => query.bind(*value),
        };
    }
    query
}

fn approval_target_ids(
    scope: &TrustedOrganizationId,
    approval_id: &ApprovalId,
    rows: Vec<ApprovalTargetAssociationRow>,
) -> Result<Value, IssueMutationError> {
    let mut issue_ids = Vec::with_capacity(rows.len());
    for row in rows {
        if row.association_org_id != scope.as_str() {
            return Err(IssueMutationError::InvalidStoredState {
                entity: "approval",
                id: approval_id.as_str().into(),
                detail: "issue approval association belongs to a different organization".into(),
            });
        }
        if row.joined_issue_id.as_deref() != Some(row.issue_id.as_str())
            || row.issue_org_id.as_deref() != Some(scope.as_str())
        {
            return Err(IssueMutationError::InvalidStoredState {
                entity: "approval",
                id: approval_id.as_str().into(),
                detail:
                    "issue approval association does not match an issue in the trusted organization"
                        .into(),
            });
        }
        if !issue_ids.is_empty() {
            return Err(IssueMutationError::InvalidStoredState {
                entity: "approval",
                id: approval_id.as_str().into(),
                detail: "multiple linked issue targets are unsupported".into(),
            });
        }
        issue_ids.push(Value::String(row.issue_id));
    }
    Ok(Value::Array(issue_ids))
}

async fn load_approval_target_associations(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    query_plan: &MutationQueryPlan,
    scope: &TrustedOrganizationId,
    approval_id: &ApprovalId,
) -> Result<Value, IssueMutationError> {
    let rows = bind_query_as::<ApprovalTargetAssociationRow>(query_plan)
        .fetch_all(&mut **tx)
        .await?;
    approval_target_ids(scope, approval_id, rows)
}

async fn require_issue_target(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    scope: &TrustedOrganizationId,
    issue_id: &IssueId,
) -> Result<(), IssueMutationError> {
    let query_plan = validate_issue_target_plan(scope, issue_id);
    bind_query_as::<RunScopeRow>(&query_plan)
        .fetch_optional(&mut **tx)
        .await?
        .map(|row| {
            let _ = row.id;
        })
        .ok_or_else(|| IssueMutationError::NotFound {
            entity: "issue",
            id: issue_id.as_str().into(),
        })
}

async fn require_run_scope(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    query_plan: &MutationQueryPlan,
    run_id: &RunId,
) -> Result<(), IssueMutationError> {
    bind_query_as::<RunScopeRow>(query_plan)
        .fetch_optional(&mut **tx)
        .await?
        .map(|row| {
            let _ = row.id;
        })
        .ok_or_else(|| IssueMutationError::NotFound {
            entity: "run",
            id: run_id.as_str().into(),
        })
}

async fn require_actor_run_scope(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    query_plan: Option<&MutationQueryPlan>,
    actor: &ActorRef,
) -> Result<(), IssueMutationError> {
    let ActorRef::Agent {
        agent_id, run_id, ..
    } = actor
    else {
        return Ok(());
    };
    let run_id = run_id.as_ref().ok_or(DomainError::ReviewRunRequired)?;
    let query_plan = query_plan.ok_or_else(|| IssueMutationError::InvalidStoredState {
        entity: "actor",
        id: agent_id.as_str().into(),
        detail: "agent run validation plan is missing".into(),
    })?;
    require_run_scope(tx, query_plan, run_id).await
}

/// Build all checkout queries without executing them.
pub fn checkout_query_plans(
    scope: &TrustedOrganizationId,
    command: &CheckoutCommand,
    options: &CheckoutOptions,
) -> Result<CheckoutQueryPlans, IssueMutationError> {
    ensure_issue_scope(scope, &command.issue, &command.actor)?;
    let run_id = command
        .run_id
        .as_ref()
        .ok_or(DomainError::CheckoutRunRequired)?;
    let fingerprint = command_fingerprint(CHECKOUT_COMMAND_TYPE, scope, command, options)?;
    Ok(CheckoutQueryPlans {
        reserve_ledger: reserve_ledger_plan(
            scope,
            CHECKOUT_COMMAND_TYPE,
            &command.idempotency_key,
            &fingerprint,
        ),
        validate_run: validate_run_plan(scope, run_id, &command.target_agent_id),
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
        validate_run: review_actor_run_plan(scope, &command.issue.issue_id, &command.actor)?,
        load_issue: load_issue_plan(scope, &command.issue.issue_id),
        update_issue: update_review_plan(scope, command)?,
        insert_comment: insert_comment_plan(
            scope,
            &command.issue.issue_id,
            &command.actor,
            &command.comment,
        ),
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
    authorization: &TrustedApprovalAuthorization,
    command: &ApprovalDecisionCommand,
) -> Result<ApprovalQueryPlans, IssueMutationError> {
    ensure_approval_authorization(authorization, &command.approval, &command.actor)?;
    let scope = authorization.organization();
    let fingerprint = fingerprint_value(APPROVAL_COMMAND_TYPE, scope, command, None)?;
    Ok(ApprovalQueryPlans {
        reserve_ledger: reserve_ledger_plan(
            scope,
            APPROVAL_COMMAND_TYPE,
            &command.idempotency_key,
            &fingerprint,
        ),
        validate_run: actor_run_plan(scope, &command.actor),
        load_approval: load_approval_plan(scope, &command.approval.approval_id),
        target_associations: approval_target_associations_plan(
            scope,
            &command.approval.approval_id,
        ),
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

/// Build all approval-resubmission queries without executing them.
pub fn approval_resubmission_query_plans(
    authorization: &TrustedApprovalAuthorization,
    command: &ApprovalResubmissionCommand,
    options: &ApprovalResubmissionOptions,
) -> Result<ApprovalResubmissionQueryPlans, IssueMutationError> {
    ensure_approval_authorization(authorization, &command.approval, &command.actor)?;
    validate_resubmission_payload_shape(command, options.payload.as_ref())?;
    let scope = authorization.organization();
    let fingerprint = fingerprint_value(
        APPROVAL_RESUBMISSION_COMMAND_TYPE,
        scope,
        command,
        Some(options.payload.clone().unwrap_or(Value::Null)),
    )?;
    Ok(ApprovalResubmissionQueryPlans {
        reserve_ledger: reserve_ledger_plan(
            scope,
            APPROVAL_RESUBMISSION_COMMAND_TYPE,
            &command.idempotency_key,
            &fingerprint,
        ),
        validate_run: actor_run_plan(scope, &command.actor),
        load_approval: load_approval_plan(scope, &command.approval.approval_id),
        target_associations: approval_target_associations_plan(
            scope,
            &command.approval.approval_id,
        ),
        update_approval: update_approval_resubmission_plan(scope, command, options)?,
        insert_activity: activity_plan(
            scope,
            &command.actor,
            ActivityKind::ApprovalResubmission,
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

fn is_canonical_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn validate_comment_attention_identity(
    value: &str,
    field: &'static str,
) -> Result<(), IssueMutationError> {
    if is_canonical_uuid(value) {
        Ok(())
    } else {
        Err(IssueMutationError::InvalidCommentAttentionIdentity { field })
    }
}

fn attention_wake_agent_ids(request: &AttentionRequest) -> BTreeSet<String> {
    let author_agent = request.author.agent_id().map(AgentId::as_str);
    request
        .mentions
        .iter()
        .filter(|mention| mention.is_wake())
        .filter(|mention| author_agent != Some(mention.agent_id.as_str()))
        .map(|mention| mention.agent_id.as_str().to_owned())
        .collect()
}

fn ensure_comment_attention_request(
    scope: &TrustedOrganizationId,
    request: &AttentionRequest,
) -> Result<(), IssueMutationError> {
    ensure_issue_scope(scope, &request.issue, &request.author)?;
    if request.mentions.len() > MAX_COMMENT_ATTENTION_MENTIONS {
        return Err(IssueMutationError::TooManyMentions);
    }
    validate_comment_attention_identity(request.issue.issue_id.as_str(), "issue_id")?;
    validate_comment_attention_identity(request.comment_id.as_str(), "comment_id")?;
    if let ActorRef::Agent {
        agent_id, run_id, ..
    } = &request.author
    {
        validate_comment_attention_identity(agent_id.as_str(), "author_agent_id")?;
        if let Some(run_id) = run_id {
            validate_comment_attention_identity(run_id.as_str(), "author_run_id")?;
        }
    }
    for mention in &request.mentions {
        if mention.organization_id != *scope.as_id() {
            return Err(DomainError::CrossOrganization {
                expected: scope.0.clone(),
                found: mention.organization_id.clone(),
            }
            .into());
        }
        validate_comment_attention_identity(mention.agent_id.as_str(), "mentioned_agent_id")?;
    }
    Ok(())
}

fn load_comment_attention_plan(
    scope: &TrustedOrganizationId,
    request: &AttentionRequest,
) -> MutationQueryPlan {
    plan(
        "SELECT c.author_agent_id::text AS author_agent_id,\n                c.author_user_id\n           FROM issue_comments AS c\n          WHERE c.org_id = $1::uuid\n            AND c.issue_id = $2::uuid\n            AND c.id = $3::uuid\n            AND c.deleted_at IS NULL\n          FOR SHARE",
        vec![
            MutationBind::Uuid(scope.as_str().into()),
            MutationBind::Uuid(request.issue.issue_id.as_str().into()),
            MutationBind::Uuid(request.comment_id.as_str().into()),
        ],
    )
}

fn ensure_comment_author(
    comment: &CommentAttentionRow,
    actor: &ActorRef,
) -> Result<(), IssueMutationError> {
    let matches = match actor {
        ActorRef::Agent { agent_id, .. } => {
            comment.author_agent_id.as_deref() == Some(agent_id.as_str())
                && comment.author_user_id.is_none()
        }
        ActorRef::User { user_id, .. } => {
            comment.author_user_id.as_deref() == Some(user_id.as_str())
                && comment.author_agent_id.is_none()
        }
    };
    matches
        .then_some(())
        .ok_or(IssueMutationError::CommentAuthorMismatch)
}

fn validate_mentioned_agents_plan(
    scope: &TrustedOrganizationId,
    request: &AttentionRequest,
) -> Option<MutationQueryPlan> {
    let target_ids = attention_wake_agent_ids(request);
    if target_ids.is_empty() {
        return None;
    }
    let placeholders = target_ids
        .iter()
        .enumerate()
        .map(|(index, _)| format!("${}::uuid", index + 2))
        .collect::<Vec<_>>()
        .join(", ");
    let mut binds = vec![MutationBind::Uuid(scope.as_str().into())];
    binds.extend(target_ids.into_iter().map(MutationBind::Uuid));
    Some(plan(
        &format!(
            "SELECT a.id::text AS id\n               FROM agents AS a\n              WHERE a.org_id = $1::uuid\n                AND a.id IN ({placeholders})\n              FOR SHARE"
        ),
        binds,
    ))
}

fn wake_reason_text(reason: WakeReason) -> &'static str {
    match reason {
        WakeReason::IssueCommentMentioned => "issue_comment_mentioned",
        WakeReason::IssueReopened => "issue_reopened",
    }
}

fn wake_relationship_text(relationship: WakeRelationship) -> &'static str {
    match relationship {
        WakeRelationship::Assignee => "assignee",
        WakeRelationship::Reviewer => "reviewer",
        WakeRelationship::Collaborator => "collaborator",
    }
}

fn wakeup_idempotency_key(request: &AttentionRequest, wake: &WakeRequest) -> String {
    format!(
        "{}:wakeup:{}",
        request.idempotency_key.as_str(),
        wake.target_agent_id.as_str()
    )
}

fn insert_wakeup_plan_for(
    scope: &TrustedOrganizationId,
    request: &AttentionRequest,
    wake: &WakeRequest,
    idempotency_key: &str,
) -> MutationQueryPlan {
    let actor = actor_sql_parts(&request.author);
    plan(
        "INSERT INTO agent_wakeup_requests (\n             org_id, agent_id, source, trigger_detail, reason, payload,\n             requested_by_actor_type, requested_by_actor_id, idempotency_key, run_id\n         ) VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::jsonb,\n                   $7::text, $8::text, $9::text, $10::uuid)\n         ON CONFLICT (org_id, agent_id, idempotency_key)\n        WHERE idempotency_key IS NOT NULL DO NOTHING\n        RETURNING id::text AS id",
        vec![
            MutationBind::Uuid(scope.as_str().into()),
            MutationBind::Uuid(wake.target_agent_id.as_str().into()),
            MutationBind::Text("automation".into()),
            MutationBind::Text("system".into()),
            MutationBind::Text(wake_reason_text(wake.reason).into()),
            MutationBind::Json(json!({
                "issueId": wake.issue.issue_id.as_str(),
                "commentId": wake.comment_id.as_str(),
                "reason": wake_reason_text(wake.reason),
                "relationship": wake_relationship_text(wake.relationship),
            })),
            MutationBind::Text(actor.actor_type.into()),
            MutationBind::Text(actor.actor_id),
            MutationBind::Text(idempotency_key.into()),
            MutationBind::NullableUuid(actor.run_id),
        ],
    )
}

fn representative_wakeup(request: &AttentionRequest) -> Option<WakeRequest> {
    let author_agent = request.author.agent_id();
    let target_agent_id = request
        .mentions
        .iter()
        .find(|mention| mention.is_wake() && author_agent != Some(&mention.agent_id))
        .map(|mention| mention.agent_id.clone())?;
    Some(WakeRequest {
        issue: request.issue.clone(),
        comment_id: request.comment_id.clone(),
        target_agent_id,
        reason: WakeReason::IssueCommentMentioned,
        relationship: WakeRelationship::Collaborator,
    })
}

/// Build the private query set for routing comment attention.
///
/// This operation does not create or edit a comment. The host must have already
/// persisted the comment and authenticated the author; this adapter locks that
/// comment, derives wake requests through issue-core, and records wakeups plus
/// audit evidence in one transaction.
pub fn comment_attention_query_plans(
    scope: &TrustedOrganizationId,
    request: &AttentionRequest,
) -> Result<CommentAttentionQueryPlans, IssueMutationError> {
    ensure_comment_attention_request(scope, request)?;
    let fingerprint = fingerprint_value(COMMENT_ATTENTION_COMMAND_TYPE, scope, request, None)?;
    let representative = representative_wakeup(request);
    Ok(CommentAttentionQueryPlans {
        reserve_ledger: reserve_ledger_plan(
            scope,
            COMMENT_ATTENTION_COMMAND_TYPE,
            &request.idempotency_key,
            &fingerprint,
        ),
        validate_run: actor_run_plan(scope, &request.author),
        load_issue: load_issue_plan(scope, &request.issue.issue_id),
        load_comment: load_comment_attention_plan(scope, request),
        validate_mentioned_agents: validate_mentioned_agents_plan(scope, request),
        insert_wakeup: representative.map(|representative| {
            insert_wakeup_plan_for(
                scope,
                request,
                &representative,
                &wakeup_idempotency_key(request, &representative),
            )
        }),
        insert_activity: activity_plan(
            scope,
            &request.author,
            ActivityKind::CommentAttention,
            request.issue.issue_id.as_str(),
            json!({"state": "pending"}),
            &request.idempotency_key,
        ),
        finalize_ledger: finalize_ledger_plan(
            scope,
            "ledger-id",
            LedgerTarget::Issue(request.issue.issue_id.as_str()),
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

    pub async fn route_comment_attention(
        &self,
        scope: &TrustedOrganizationId,
        request: AttentionRequest,
    ) -> Result<MutationReceipt, IssueMutationError> {
        let plans = comment_attention_query_plans(scope, &request)?;
        let fingerprint = fingerprint_value(COMMENT_ATTENTION_COMMAND_TYPE, scope, &request, None)?;
        let mut tx = self.pool.begin().await?;
        let lookup = ledger_lookup_plan(scope, &request.idempotency_key);
        let reservation = reserve_or_replay(
            &mut tx,
            ReservationRequest {
                reserve: &plans.reserve_ledger,
                lookup: &lookup,
                scope,
                key: &request.idempotency_key,
                command_type: COMMENT_ATTENTION_COMMAND_TYPE,
                fingerprint: &fingerprint,
                target: LedgerTarget::Issue(request.issue.issue_id.as_str()),
            },
        )
        .await?;
        let ledger_id = match reservation {
            Reservation::Replay(receipt) => {
                tx.commit().await?;
                return Ok(receipt);
            }
            Reservation::New(id) => {
                if let Some(validate_run) = plans.validate_run.as_ref() {
                    let run_id = request.author.run_id().ok_or_else(|| {
                        IssueMutationError::InvalidStoredState {
                            entity: "actor",
                            id: request
                                .author
                                .agent_id()
                                .map(AgentId::as_str)
                                .unwrap_or("unknown")
                                .into(),
                            detail: "agent run validation plan exists without a run id".into(),
                        }
                    })?;
                    require_run_scope(&mut tx, validate_run, run_id).await?;
                }
                id
            }
        };
        let issue_row = bind_query_as::<IssueMutationRow>(&plans.load_issue)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| IssueMutationError::NotFound {
                entity: "issue",
                id: request.issue.issue_id.as_str().into(),
            })?;
        let issue = issue_from_row(scope, &issue_row)?;
        let comment = bind_query_as::<CommentAttentionRow>(&plans.load_comment)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| IssueMutationError::NotFound {
                entity: "comment",
                id: request.comment_id.as_str().into(),
            })?;
        ensure_comment_author(&comment, &request.author)?;
        let wakes = route_domain_comment_attention(&issue, request.clone())?;

        if let Some(validate_targets) = plans.validate_mentioned_agents.as_ref() {
            let found = bind_query_as::<RunScopeRow>(validate_targets)
                .fetch_all(&mut *tx)
                .await?
                .into_iter()
                .map(|row| row.id)
                .collect::<BTreeSet<_>>();
            if let Some(missing) = attention_wake_agent_ids(&request).difference(&found).next() {
                return Err(IssueMutationError::NotFound {
                    entity: "agent",
                    id: missing.clone(),
                });
            }
        }

        let result = serde_json::to_value(&wakes)?;
        let stored = stored_outcome(
            COMMENT_ATTENTION_COMMAND_TYPE,
            &fingerprint,
            result.clone(),
            json!({
                "commentId": request.comment_id.as_str(),
                "wakeCount": wakes.len(),
            }),
        );
        for wake in &wakes {
            let idempotency_key = wakeup_idempotency_key(&request, wake);
            let wakeup = insert_wakeup_plan_for(scope, &request, wake, &idempotency_key);
            let _ = bind_query_as::<RunScopeRow>(&wakeup)
                .fetch_optional(&mut *tx)
                .await?;
        }
        let activity = activity_plan(
            scope,
            &request.author,
            ActivityKind::CommentAttention,
            request.issue.issue_id.as_str(),
            stored.clone(),
            &request.idempotency_key,
        );
        let activity_id = bind_query_as::<ActivityIdRow>(&activity)
            .fetch_one(&mut *tx)
            .await?
            .id;
        let finalize = finalize_ledger_plan(
            scope,
            &ledger_id,
            LedgerTarget::Issue(request.issue.issue_id.as_str()),
            stored,
            &activity_id,
        );
        let finalized = bind_query_as::<FinalizedLedgerRow>(&finalize)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(IssueMutationError::ConcurrentModification)?;
        tx.commit().await?;
        Ok(MutationReceipt {
            command_type: COMMENT_ATTENTION_COMMAND_TYPE.into(),
            idempotency_key: request.idempotency_key,
            ledger_id: finalized.id,
            activity_id: finalized.activity_id,
            outcome: result,
            replayed: false,
        })
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
        let run_id = command
            .run_id
            .as_ref()
            .ok_or(DomainError::CheckoutRunRequired)?;
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
            Reservation::New(id) => {
                require_run_scope(&mut tx, &plans.validate_run, run_id).await?;
                id
            }
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
            Reservation::New(id) => {
                require_actor_run_scope(&mut tx, plans.validate_run.as_ref(), &command.actor)
                    .await?;
                id
            }
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
        let comment_id = bind_query_as::<CommentIdRow>(&plans.insert_comment)
            .fetch_one(&mut *tx)
            .await?
            .id;
        let stored = stored_outcome(
            REVIEW_COMMAND_TYPE,
            &fingerprint,
            result.clone(),
            json!({
                "decision": command.decision,
                "comment": command.comment.clone(),
                "commentId": comment_id,
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
        authorization: &TrustedApprovalAuthorization,
        command: ApprovalDecisionCommand,
    ) -> Result<MutationReceipt, IssueMutationError> {
        let plans = approval_decision_query_plans(authorization, &command)?;
        let scope = authorization.organization();
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
            Reservation::New(id) => {
                require_actor_run_scope(&mut tx, plans.validate_run.as_ref(), &command.actor)
                    .await?;
                id
            }
        };
        let mut row = bind_query_as::<ApprovalMutationRow>(&plans.load_approval)
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
        row.linked_issue_ids = load_approval_target_associations(
            &mut tx,
            &plans.target_associations,
            scope,
            &command.approval.approval_id,
        )
        .await?;
        let mut approval = approval_from_row(scope, &row)?;
        if let Some(issue_id) = approval_issue_target(&approval) {
            require_issue_target(&mut tx, scope, issue_id).await?;
        }
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

    pub async fn resubmit_approval(
        &self,
        authorization: &TrustedApprovalAuthorization,
        command: ApprovalResubmissionCommand,
        options: ApprovalResubmissionOptions,
    ) -> Result<MutationReceipt, IssueMutationError> {
        let plans = approval_resubmission_query_plans(authorization, &command, &options)?;
        let scope = authorization.organization();
        let fingerprint = fingerprint_value(
            APPROVAL_RESUBMISSION_COMMAND_TYPE,
            scope,
            &command,
            Some(options.payload.clone().unwrap_or(Value::Null)),
        )?;
        let mut tx = self.pool.begin().await?;
        let lookup = ledger_lookup_plan(scope, &command.idempotency_key);
        let reservation = reserve_or_replay(
            &mut tx,
            ReservationRequest {
                reserve: &plans.reserve_ledger,
                lookup: &lookup,
                scope,
                key: &command.idempotency_key,
                command_type: APPROVAL_RESUBMISSION_COMMAND_TYPE,
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
            Reservation::New(id) => {
                require_actor_run_scope(&mut tx, plans.validate_run.as_ref(), &command.actor)
                    .await?;
                id
            }
        };
        let mut row = bind_query_as::<ApprovalMutationRow>(&plans.load_approval)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| IssueMutationError::NotFound {
                entity: "approval",
                id: command.approval.approval_id.as_str().into(),
            })?;
        row.linked_issue_ids = load_approval_target_associations(
            &mut tx,
            &plans.target_associations,
            scope,
            &command.approval.approval_id,
        )
        .await?;
        let mut approval = approval_from_row(scope, &row)?;
        let target = resubmission_payload_issue_id(&approval, options.payload.as_ref())?
            .or_else(|| approval_issue_target(&approval).cloned());
        if let Some(issue_id) = target.as_ref() {
            require_issue_target(&mut tx, scope, issue_id).await?;
        }
        let domain_outcome = approval.resubmit(command.clone())?;
        let result = serde_json::to_value(&domain_outcome)?;
        let update = update_approval_resubmission_plan(scope, &command, &options)?;
        let updated = bind_query_as::<ApprovalResubmissionUpdateRow>(&update)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(IssueMutationError::ConcurrentModification)?;
        if updated.revision != i64::try_from(approval.revision).unwrap_or(i64::MAX) {
            return Err(IssueMutationError::ConcurrentModification);
        }
        verify_resubmission_payload(&approval, &options, &updated.payload)?;
        let stored = stored_outcome(
            APPROVAL_RESUBMISSION_COMMAND_TYPE,
            &fingerprint,
            result.clone(),
            json!({"payloadChanged": options.payload.is_some()}),
        );
        let activity = activity_plan(
            scope,
            &command.actor,
            ActivityKind::ApprovalResubmission,
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
            command_type: APPROVAL_RESUBMISSION_COMMAND_TYPE.into(),
            idempotency_key: command.idempotency_key,
            ledger_id: finalized.id,
            activity_id: finalized.activity_id,
            outcome: result,
            replayed: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_target_associations_query_is_org_fenced_and_locks_rows() {
        let scope = TrustedOrganizationId::from_host(OrganizationId::new("org-a"));
        let approval_id = ApprovalId::new("approval-id");
        let target_plan = approval_target_associations_plan(&scope, &approval_id);
        let approval_plan = load_approval_plan(&scope, &approval_id);

        assert!(target_plan.sql.contains("a.org_id = $1::uuid"));
        assert!(target_plan.sql.contains("ia.org_id = $1::uuid"));
        assert!(target_plan.sql.contains("i.org_id = ia.org_id"));
        assert!(target_plan.sql.contains("FOR UPDATE OF ia"));
        assert!(approval_plan.sql.contains("a.org_id = $1::uuid"));
        assert!(approval_plan.sql.contains("FOR UPDATE"));
    }

    #[test]
    fn production_approval_types_are_all_decoded() {
        let expected = [
            ("hire_agent", ApprovalType::HireAgent),
            ("approve_ceo_strategy", ApprovalType::ApproveCeoStrategy),
            ("chat_issue_creation", ApprovalType::ChatIssueCreation),
            ("chat_operation", ApprovalType::ChatOperation),
            ("agent_runtime", ApprovalType::AgentRuntime),
            (
                "budget_override_required",
                ApprovalType::BudgetOverrideRequired,
            ),
            ("goal_change", ApprovalType::GoalChange),
        ];

        for (value, expected_type) in expected {
            assert_eq!(approval_type(value, "approval-id").unwrap(), expected_type);
        }
    }

    #[test]
    fn non_issue_approval_rows_allow_missing_requester_and_target() {
        let scope = TrustedOrganizationId::from_host(OrganizationId::new("org-a"));
        let row = ApprovalMutationRow {
            id: "approval-id".into(),
            org_id: "org-a".into(),
            approval_type: "hire_agent".into(),
            status: "pending".into(),
            revision: 0,
            decision: None,
            decision_idempotency_key: None,
            decision_note: None,
            decided_by_user_id: None,
            decided_at: None,
            requested_by_agent_id: None,
            requested_by_user_id: None,
            payload: json!({"candidate": "new-agent"}),
            linked_issue_ids: json!([]),
        };

        let approval = approval_from_row(&scope, &row).unwrap();
        assert!(approval.requester.is_none());
        assert_eq!(
            approval.target,
            rudder_issue_core::GovernedTarget::organization(OrganizationId::new("org-a"))
        );

        let mut malformed = row;
        malformed.decision = Some("not-a-decision".into());
        assert!(matches!(
            approval_from_row(&scope, &malformed),
            Err(IssueMutationError::InvalidStoredState { .. })
        ));
        malformed.decision = None;
        malformed.status = "approved".into();
        assert!(matches!(
            approval_from_row(&scope, &malformed),
            Err(IssueMutationError::InvalidStoredState { .. })
        ));
    }

    #[test]
    fn non_object_approval_payloads_are_rejected_closed() {
        let scope = TrustedOrganizationId::from_host(OrganizationId::new("org-a"));
        for payload in [Value::Null, json!(["issue-a"]), json!("issue-a")] {
            let row = ApprovalMutationRow {
                id: "approval-id".into(),
                org_id: "org-a".into(),
                approval_type: "issue_action".into(),
                status: "pending".into(),
                revision: 0,
                decision: None,
                decision_idempotency_key: None,
                decision_note: None,
                decided_by_user_id: None,
                decided_at: None,
                requested_by_agent_id: None,
                requested_by_user_id: None,
                payload,
                linked_issue_ids: json!([]),
            };

            assert!(matches!(
                approval_from_row(&scope, &row),
                Err(IssueMutationError::InvalidStoredState { .. })
            ));
        }
    }

    #[test]
    fn approval_target_associations_reject_foreign_missing_and_ambiguous_rows() {
        let scope = TrustedOrganizationId::from_host(OrganizationId::new("org-a"));
        let approval_id = ApprovalId::new("approval-id");
        let valid = || ApprovalTargetAssociationRow {
            issue_id: "issue-a".into(),
            association_org_id: "org-a".into(),
            joined_issue_id: Some("issue-a".into()),
            issue_org_id: Some("org-a".into()),
        };

        let mut foreign = valid();
        foreign.association_org_id = "org-b".into();
        assert!(matches!(
            approval_target_ids(&scope, &approval_id, vec![foreign]),
            Err(IssueMutationError::InvalidStoredState { .. })
        ));

        let mut mismatched = valid();
        mismatched.joined_issue_id = None;
        assert!(matches!(
            approval_target_ids(&scope, &approval_id, vec![mismatched]),
            Err(IssueMutationError::InvalidStoredState { .. })
        ));

        let mut second = valid();
        second.issue_id = "issue-b".into();
        second.joined_issue_id = Some("issue-b".into());
        assert!(matches!(
            approval_target_ids(&scope, &approval_id, vec![valid(), second]),
            Err(IssueMutationError::InvalidStoredState { .. })
        ));
    }

    #[test]
    fn resubmission_verifies_the_persisted_payload_target() {
        let organization = OrganizationId::new("org-a");
        let approval = Approval::new(
            ApprovalRef::new(organization.clone(), ApprovalId::new("approval-id")),
            ApprovalType::IssueAction,
            rudder_issue_core::GovernedTarget::issue(IssueRef::new(
                organization,
                IssueId::new("issue-id"),
            )),
            None,
        )
        .unwrap();
        let options = ApprovalResubmissionOptions::new(Some(json!({
            "issueId": "issue-id"
        })));
        assert!(
            verify_resubmission_payload(
                &approval,
                &options,
                &json!({
                    "issueId": "issue-id"
                })
            )
            .is_ok()
        );
        assert!(
            verify_resubmission_payload(
                &approval,
                &options,
                &json!({
                    "issueId": "other-issue"
                })
            )
            .is_err()
        );
    }

    #[test]
    fn resubmission_rejects_payloads_that_drop_an_existing_issue_target() {
        let organization = OrganizationId::new("org-a");
        let approval = Approval::new(
            ApprovalRef::new(organization.clone(), ApprovalId::new("approval-id")),
            ApprovalType::IssueAction,
            rudder_issue_core::GovernedTarget::issue(IssueRef::new(
                organization,
                IssueId::new("issue-id"),
            )),
            None,
        )
        .unwrap();

        assert!(resubmission_payload_issue_id(&approval, Some(&json!({"revision": 2}))).is_err());
        assert_eq!(
            resubmission_payload_issue_id(
                &approval,
                Some(&json!({"issueId": "issue-id", "revision": 2}))
            )
            .unwrap(),
            Some(IssueId::new("issue-id"))
        );
        assert_eq!(
            resubmission_payload_issue_id(&approval, None).unwrap(),
            None
        );
    }

    #[test]
    fn production_issue_target_shapes_are_decoded_without_client_scope() {
        assert_eq!(
            approval_target_issue_id(&json!({"issueId": "issue-a"})).unwrap(),
            Some("issue-a".into())
        );
        assert_eq!(
            approval_target_issue_id(&json!({"primaryIssueId": "issue-b"})).unwrap(),
            Some("issue-b".into())
        );
        assert_eq!(
            approval_target_issue_id(&json!({"issueIds": ["issue-c", "issue-d"]})),
            Err("issueIds")
        );
        assert_eq!(
            approval_target_issue_id(&json!({"candidate": "agent"})).unwrap(),
            None
        );
        assert_eq!(
            approval_target_issue_id(&json!({"issueId": 42})),
            Err("issueId")
        );
        assert_eq!(
            approval_target_issue_id(&json!({"issueIds": ["issue-a", 42]})),
            Err("issueIds")
        );
    }
}
