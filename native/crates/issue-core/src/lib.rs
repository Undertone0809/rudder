use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;

#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
pub struct OrganizationId(String);

impl OrganizationId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
pub struct IssueId(String);

impl IssueId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
pub struct AgentId(String);

impl AgentId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
pub struct UserId(String);

impl UserId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

macro_rules! string_identifier {
    ($name:ident) => {
        #[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
    };
}

string_identifier!(RunId);
string_identifier!(CommentId);
string_identifier!(ApprovalId);
string_identifier!(IdempotencyKey);

#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
pub struct IssueRef {
    pub organization_id: OrganizationId,
    pub issue_id: IssueId,
}

impl IssueRef {
    pub fn new(organization_id: OrganizationId, issue_id: IssueId) -> Self {
        Self {
            organization_id,
            issue_id,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub enum PrincipalRef {
    Agent {
        organization_id: OrganizationId,
        agent_id: AgentId,
    },
    User {
        organization_id: OrganizationId,
        user_id: UserId,
    },
}

impl PrincipalRef {
    pub fn agent(organization_id: OrganizationId, agent_id: AgentId) -> Self {
        Self::Agent {
            organization_id,
            agent_id,
        }
    }

    pub fn user(organization_id: OrganizationId, user_id: UserId) -> Self {
        Self::User {
            organization_id,
            user_id,
        }
    }

    pub fn organization_id(&self) -> &OrganizationId {
        match self {
            Self::Agent {
                organization_id, ..
            }
            | Self::User {
                organization_id, ..
            } => organization_id,
        }
    }

    pub fn agent_id(&self) -> Option<&AgentId> {
        match self {
            Self::Agent { agent_id, .. } => Some(agent_id),
            Self::User { .. } => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub enum ActorRef {
    Agent {
        organization_id: OrganizationId,
        agent_id: AgentId,
        run_id: Option<RunId>,
    },
    User {
        organization_id: OrganizationId,
        user_id: UserId,
    },
}

impl ActorRef {
    pub fn agent(
        organization_id: OrganizationId,
        agent_id: AgentId,
        run_id: Option<RunId>,
    ) -> Self {
        Self::Agent {
            organization_id,
            agent_id,
            run_id,
        }
    }

    pub fn user(organization_id: OrganizationId, user_id: UserId) -> Self {
        Self::User {
            organization_id,
            user_id,
        }
    }

    pub fn organization_id(&self) -> &OrganizationId {
        match self {
            Self::Agent {
                organization_id, ..
            }
            | Self::User {
                organization_id, ..
            } => organization_id,
        }
    }

    pub fn agent_id(&self) -> Option<&AgentId> {
        match self {
            Self::Agent { agent_id, .. } => Some(agent_id),
            Self::User { .. } => None,
        }
    }

    pub fn user_id(&self) -> Option<&UserId> {
        match self {
            Self::Agent { .. } => None,
            Self::User { user_id, .. } => Some(user_id),
        }
    }

    pub fn run_id(&self) -> Option<&RunId> {
        match self {
            Self::Agent { run_id, .. } => run_id.as_ref(),
            Self::User { .. } => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueStatus {
    Backlog,
    Todo,
    InProgress,
    InReview,
    Blocked,
    Done,
    Cancelled,
}

#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum DomainError {
    #[error("in_review issues require a reviewer")]
    MissingReviewer,
    #[error("in_progress issues require an assignee")]
    MissingAssignee,
    #[error("entity belongs to a different organization")]
    CrossOrganization {
        expected: OrganizationId,
        found: OrganizationId,
    },
    #[error("an issue cannot have both an agent and user {role}")]
    MultiplePrincipals { role: &'static str },
    #[error("an issue cannot be its own parent")]
    SelfParent,
    #[error("issue hierarchy contains a cycle")]
    HierarchyCycle,
    #[error("command targets a different issue")]
    IssueIdentityMismatch,
    #[error("an agent may only checkout work as itself")]
    AgentCanOnlyCheckoutAsItself,
    #[error("agent checkout requires a run id")]
    CheckoutRunRequired,
    #[error("checkout actor run does not match the command run")]
    CheckoutRunMismatch { expected: RunId, found: RunId },
    #[error("the checkout target is not the current assignee")]
    CheckoutAssigneeMismatch,
    #[error("expected revision does not match the current issue revision")]
    RevisionMismatch { expected: u64, actual: u64 },
    #[error("expected fencing token does not match the current issue fence")]
    FencingTokenMismatch { expected: u64, actual: u64 },
    #[error("checkout status is not one of the command's expected statuses")]
    CheckoutStatusMismatch { status: IssueStatus },
    #[error("checkout fencing token must advance")]
    FenceNotAdvanced { current: u64, requested: u64 },
    #[error("the checkout lease is already held by another run")]
    LeaseHeld { run_id: RunId },
    #[error("idempotency key was reused with a different command")]
    IdempotencyConflict { key: IdempotencyKey },
    #[error("issue revision counter overflowed")]
    RevisionOverflow,
    #[error("the actor is not the current reviewer")]
    ReviewerMismatch,
    #[error("agent review requires a run id")]
    ReviewRunRequired,
    #[error("review actor run does not match the command run")]
    ReviewRunMismatch { expected: RunId, found: RunId },
    #[error("review decisions require a non-empty comment")]
    ReviewCommentRequired,
    #[error("the issue has no open review")]
    ReviewNotOpen,
    #[error("approval targets a different approval")]
    ApprovalIdentityMismatch,
    #[error("approval is not pending")]
    ApprovalNotPending,
    #[error("approval target belongs to a different organization")]
    ApprovalTargetOrganizationMismatch,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Issue {
    pub identity: IssueRef,
    pub title: String,
    pub status: IssueStatus,
    pub assignee: Option<PrincipalRef>,
    pub reviewer: Option<PrincipalRef>,
    pub revision: u64,
    pub fencing_token: u64,
    pub checkout_run_id: Option<RunId>,
    pub execution_run_id: Option<RunId>,
    checkout_commands: BTreeMap<IdempotencyKey, CheckoutCommand>,
    review_commands: BTreeMap<IdempotencyKey, ReviewDecisionCommand>,
}

impl Issue {
    pub fn new(
        identity: IssueRef,
        title: impl Into<String>,
        status: IssueStatus,
        assignee: Option<PrincipalRef>,
        reviewer: Option<PrincipalRef>,
    ) -> Result<Self, DomainError> {
        let issue = Self {
            identity,
            title: title.into(),
            status,
            assignee,
            reviewer,
            revision: 0,
            fencing_token: 0,
            checkout_run_id: None,
            execution_run_id: None,
            checkout_commands: BTreeMap::new(),
            review_commands: BTreeMap::new(),
        };
        issue.validate_state()?;
        Ok(issue)
    }

    pub fn validate(&self) -> Result<(), DomainError> {
        self.validate_state()
    }

    fn validate_state(&self) -> Result<(), DomainError> {
        for principal in [self.assignee.as_ref(), self.reviewer.as_ref()]
            .into_iter()
            .flatten()
        {
            if principal.organization_id() != &self.identity.organization_id {
                return Err(DomainError::CrossOrganization {
                    expected: self.identity.organization_id.clone(),
                    found: principal.organization_id().clone(),
                });
            }
        }
        if self.status == IssueStatus::InReview && self.reviewer.is_none() {
            return Err(DomainError::MissingReviewer);
        }
        if self.status == IssueStatus::InProgress && self.assignee.is_none() {
            return Err(DomainError::MissingAssignee);
        }
        Ok(())
    }

    pub fn transition_status(&mut self, status: IssueStatus) -> Result<(), DomainError> {
        let revision = self
            .revision
            .checked_add(1)
            .ok_or(DomainError::RevisionOverflow)?;
        let previous = self.status;
        self.status = status;
        if let Err(error) = self.validate_state() {
            self.status = previous;
            return Err(error);
        }
        self.revision = revision;
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub enum CheckoutOutcome {
    CheckedOut {
        run_id: RunId,
        revision: u64,
        fencing_token: u64,
    },
    AlreadyApplied {
        run_id: RunId,
        revision: u64,
        fencing_token: u64,
    },
}

impl CheckoutOutcome {
    fn checked_out(run_id: RunId, revision: u64, fencing_token: u64) -> Self {
        Self::CheckedOut {
            run_id,
            revision,
            fencing_token,
        }
    }

    fn already_applied(run_id: RunId, revision: u64, fencing_token: u64) -> Self {
        Self::AlreadyApplied {
            run_id,
            revision,
            fencing_token,
        }
    }

    pub fn is_already_applied(&self) -> bool {
        matches!(self, Self::AlreadyApplied { .. })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CheckoutCommand {
    pub issue: IssueRef,
    pub actor: ActorRef,
    pub target_agent_id: AgentId,
    pub run_id: Option<RunId>,
    pub expected_statuses: Vec<IssueStatus>,
    pub expected_revision: u64,
    pub expected_fencing_token: u64,
    pub idempotency_key: IdempotencyKey,
}

impl CheckoutCommand {
    #[allow(clippy::too_many_arguments)]
    pub fn new<I>(
        issue: IssueRef,
        actor: ActorRef,
        target_agent_id: AgentId,
        run_id: Option<RunId>,
        expected_statuses: I,
        expected_revision: u64,
        expected_fencing_token: u64,
        idempotency_key: IdempotencyKey,
    ) -> Self
    where
        I: IntoIterator<Item = IssueStatus>,
    {
        Self {
            issue,
            actor,
            target_agent_id,
            run_id,
            expected_statuses: expected_statuses.into_iter().collect(),
            expected_revision,
            expected_fencing_token,
            idempotency_key,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewDecision {
    Approve,
    RequestChanges,
    NeedsFollowup,
    Blocked,
}

impl ReviewDecision {
    pub fn resulting_status(self) -> IssueStatus {
        match self {
            Self::Approve => IssueStatus::Done,
            Self::RequestChanges => IssueStatus::InProgress,
            Self::NeedsFollowup => IssueStatus::Todo,
            Self::Blocked => IssueStatus::Blocked,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ReviewDecisionCommand {
    pub issue: IssueRef,
    pub actor: ActorRef,
    pub decision: ReviewDecision,
    pub comment: String,
    pub expected_revision: u64,
    pub expected_fencing_token: u64,
    pub idempotency_key: IdempotencyKey,
}

impl ReviewDecisionCommand {
    pub fn new(
        issue: IssueRef,
        actor: ActorRef,
        decision: ReviewDecision,
        comment: impl Into<String>,
        expected_revision: u64,
        expected_fencing_token: u64,
        idempotency_key: IdempotencyKey,
    ) -> Self {
        Self {
            issue,
            actor,
            decision,
            comment: comment.into(),
            expected_revision,
            expected_fencing_token,
            idempotency_key,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub enum ReviewDecisionOutcome {
    Recorded {
        decision: ReviewDecision,
        previous_status: IssueStatus,
        status: IssueStatus,
        revision: u64,
        fencing_token: u64,
    },
    AlreadyApplied {
        decision: ReviewDecision,
        status: IssueStatus,
        revision: u64,
        fencing_token: u64,
    },
}

impl ReviewDecisionOutcome {
    fn recorded(
        decision: ReviewDecision,
        previous_status: IssueStatus,
        status: IssueStatus,
        revision: u64,
        fencing_token: u64,
    ) -> Self {
        Self::Recorded {
            decision,
            previous_status,
            status,
            revision,
            fencing_token,
        }
    }

    fn already_applied(
        decision: ReviewDecision,
        status: IssueStatus,
        revision: u64,
        fencing_token: u64,
    ) -> Self {
        Self::AlreadyApplied {
            decision,
            status,
            revision,
            fencing_token,
        }
    }
}

impl Issue {
    pub fn checkout(
        &mut self,
        command: CheckoutCommand,
        fencing_token: u64,
    ) -> Result<CheckoutOutcome, DomainError> {
        if command.issue != self.identity {
            return Err(DomainError::IssueIdentityMismatch);
        }
        if command.actor.organization_id() != &self.identity.organization_id {
            return Err(DomainError::CrossOrganization {
                expected: self.identity.organization_id.clone(),
                found: command.actor.organization_id().clone(),
            });
        }
        if command.actor.agent_id() != Some(&command.target_agent_id) {
            return Err(DomainError::AgentCanOnlyCheckoutAsItself);
        }
        let run_id = command
            .run_id
            .clone()
            .ok_or(DomainError::CheckoutRunRequired)?;
        match command.actor.run_id() {
            Some(actor_run) if actor_run == &run_id => {}
            Some(actor_run) => {
                return Err(DomainError::CheckoutRunMismatch {
                    expected: run_id,
                    found: actor_run.clone(),
                });
            }
            None => return Err(DomainError::CheckoutRunRequired),
        }
        match self.assignee.as_ref() {
            Some(PrincipalRef::Agent {
                organization_id,
                agent_id,
            }) if organization_id == &self.identity.organization_id
                && agent_id == &command.target_agent_id => {}
            _ => return Err(DomainError::CheckoutAssigneeMismatch),
        }

        let key = command.idempotency_key.clone();
        if let Some(previous) = self.checkout_commands.get(&key) {
            if previous == &command {
                return Ok(CheckoutOutcome::already_applied(
                    run_id,
                    self.revision,
                    self.fencing_token,
                ));
            }
            return Err(DomainError::IdempotencyConflict { key });
        }

        if let Some(held_run) = self.checkout_run_id.as_ref() {
            return Err(DomainError::LeaseHeld {
                run_id: held_run.clone(),
            });
        }
        if self.revision != command.expected_revision {
            return Err(DomainError::RevisionMismatch {
                expected: command.expected_revision,
                actual: self.revision,
            });
        }
        if self.fencing_token != command.expected_fencing_token {
            return Err(DomainError::FencingTokenMismatch {
                expected: command.expected_fencing_token,
                actual: self.fencing_token,
            });
        }
        if !command.expected_statuses.contains(&self.status) {
            return Err(DomainError::CheckoutStatusMismatch {
                status: self.status,
            });
        }
        if fencing_token <= self.fencing_token {
            return Err(DomainError::FenceNotAdvanced {
                current: self.fencing_token,
                requested: fencing_token,
            });
        }

        let revision = self
            .revision
            .checked_add(1)
            .ok_or(DomainError::RevisionOverflow)?;
        self.status = IssueStatus::InProgress;
        self.checkout_run_id = Some(run_id.clone());
        self.execution_run_id = Some(run_id.clone());
        self.fencing_token = fencing_token;
        self.revision = revision;
        self.checkout_commands.insert(key, command);

        Ok(CheckoutOutcome::checked_out(
            run_id,
            revision,
            fencing_token,
        ))
    }

    pub fn decide_review(
        &mut self,
        command: ReviewDecisionCommand,
    ) -> Result<ReviewDecisionOutcome, DomainError> {
        if command.issue != self.identity {
            return Err(DomainError::IssueIdentityMismatch);
        }
        if command.actor.organization_id() != &self.identity.organization_id {
            return Err(DomainError::CrossOrganization {
                expected: self.identity.organization_id.clone(),
                found: command.actor.organization_id().clone(),
            });
        }

        let reviewer = self.reviewer.as_ref().ok_or(DomainError::MissingReviewer)?;
        let reviewer_matches = match (reviewer, &command.actor) {
            (
                PrincipalRef::Agent {
                    organization_id,
                    agent_id,
                },
                ActorRef::Agent {
                    organization_id: actor_org,
                    agent_id: actor_agent,
                    run_id: actor_run,
                },
            ) => {
                if actor_org != organization_id || actor_agent != agent_id {
                    false
                } else if actor_run.is_none() {
                    return Err(DomainError::ReviewRunRequired);
                } else {
                    true
                }
            }
            (
                PrincipalRef::User {
                    organization_id,
                    user_id,
                },
                ActorRef::User {
                    organization_id: actor_org,
                    user_id: actor_user,
                },
            ) => actor_org == organization_id && actor_user == user_id,
            _ => false,
        };
        if !reviewer_matches {
            return Err(DomainError::ReviewerMismatch);
        }
        if command.comment.trim().is_empty() {
            return Err(DomainError::ReviewCommentRequired);
        }

        let key = command.idempotency_key.clone();
        if let Some(previous) = self.review_commands.get(&key) {
            if previous == &command {
                return Ok(ReviewDecisionOutcome::already_applied(
                    command.decision,
                    self.status,
                    self.revision,
                    self.fencing_token,
                ));
            }
            return Err(DomainError::IdempotencyConflict { key });
        }

        if self.revision != command.expected_revision {
            return Err(DomainError::RevisionMismatch {
                expected: command.expected_revision,
                actual: self.revision,
            });
        }
        if self.fencing_token != command.expected_fencing_token {
            return Err(DomainError::FencingTokenMismatch {
                expected: command.expected_fencing_token,
                actual: self.fencing_token,
            });
        }
        if self.status != IssueStatus::InReview {
            return Err(DomainError::ReviewNotOpen);
        }
        if command.decision == ReviewDecision::RequestChanges && self.assignee.is_none() {
            return Err(DomainError::MissingAssignee);
        }

        let previous_status = self.status;
        let status = command.decision.resulting_status();
        let revision = self
            .revision
            .checked_add(1)
            .ok_or(DomainError::RevisionOverflow)?;
        self.status = status;
        self.revision = revision;
        self.checkout_run_id = None;
        self.execution_run_id = None;
        self.review_commands.insert(key, command.clone());

        Ok(ReviewDecisionOutcome::recorded(
            command.decision,
            previous_status,
            status,
            revision,
            self.fencing_token,
        ))
    }

    pub fn record_review_decision(
        &mut self,
        command: ReviewDecisionCommand,
    ) -> Result<ReviewDecisionOutcome, DomainError> {
        self.decide_review(command)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalType {
    BudgetOverrideRequired,
    IssueAction,
    AgentActivation,
    GoalChange,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Rejected,
    ChangesRequested,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Approve,
    Reject,
    RequestChanges,
}

impl ApprovalDecision {
    fn resulting_status(self) -> ApprovalStatus {
        match self {
            Self::Approve => ApprovalStatus::Approved,
            Self::Reject => ApprovalStatus::Rejected,
            Self::RequestChanges => ApprovalStatus::ChangesRequested,
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct ApprovalRef {
    pub organization_id: OrganizationId,
    pub approval_id: ApprovalId,
}

impl ApprovalRef {
    pub fn new(organization_id: OrganizationId, approval_id: ApprovalId) -> Self {
        Self {
            organization_id,
            approval_id,
        }
    }

    pub fn organization_id(&self) -> &OrganizationId {
        &self.organization_id
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub enum GovernedTarget {
    Issue(IssueRef),
}

impl GovernedTarget {
    pub fn issue(issue: IssueRef) -> Self {
        Self::Issue(issue)
    }

    pub fn organization_id(&self) -> &OrganizationId {
        match self {
            Self::Issue(issue) => &issue.organization_id,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ApprovalDecisionCommand {
    pub approval: ApprovalRef,
    pub actor: ActorRef,
    pub decision: ApprovalDecision,
    pub note: Option<String>,
    pub expected_revision: u64,
    pub idempotency_key: IdempotencyKey,
}

impl ApprovalDecisionCommand {
    pub fn new(
        approval: ApprovalRef,
        actor: ActorRef,
        decision: ApprovalDecision,
        note: Option<String>,
        expected_revision: u64,
        idempotency_key: IdempotencyKey,
    ) -> Self {
        Self {
            approval,
            actor,
            decision,
            note,
            expected_revision,
            idempotency_key,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub enum ApprovalDecisionOutcome {
    Recorded {
        decision: ApprovalDecision,
        status: ApprovalStatus,
        revision: u64,
    },
    AlreadyApplied {
        decision: ApprovalDecision,
        status: ApprovalStatus,
        revision: u64,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Approval {
    pub identity: ApprovalRef,
    pub approval_type: ApprovalType,
    pub target: GovernedTarget,
    pub requester: ActorRef,
    pub status: ApprovalStatus,
    pub revision: u64,
    pub decision: Option<ApprovalDecision>,
    pub decided_by: Option<ActorRef>,
    pub note: Option<String>,
    decision_commands: BTreeMap<IdempotencyKey, ApprovalDecisionCommand>,
}

impl Approval {
    pub fn new(
        identity: ApprovalRef,
        approval_type: ApprovalType,
        target: GovernedTarget,
        requester: ActorRef,
    ) -> Result<Self, DomainError> {
        if identity.organization_id != *target.organization_id() {
            return Err(DomainError::CrossOrganization {
                expected: identity.organization_id,
                found: target.organization_id().clone(),
            });
        }
        if requester.organization_id() != &identity.organization_id {
            return Err(DomainError::CrossOrganization {
                expected: identity.organization_id,
                found: requester.organization_id().clone(),
            });
        }
        Ok(Self {
            identity,
            approval_type,
            target,
            requester,
            status: ApprovalStatus::Pending,
            revision: 0,
            decision: None,
            decided_by: None,
            note: None,
            decision_commands: BTreeMap::new(),
        })
    }

    pub fn validate(&self) -> Result<(), DomainError> {
        if self.identity.organization_id != *self.target.organization_id() {
            return Err(DomainError::CrossOrganization {
                expected: self.identity.organization_id.clone(),
                found: self.target.organization_id().clone(),
            });
        }
        if self.requester.organization_id() != &self.identity.organization_id {
            return Err(DomainError::CrossOrganization {
                expected: self.identity.organization_id.clone(),
                found: self.requester.organization_id().clone(),
            });
        }
        Ok(())
    }

    pub fn decide(
        &mut self,
        command: ApprovalDecisionCommand,
    ) -> Result<ApprovalDecisionOutcome, DomainError> {
        if command.approval != self.identity {
            return Err(DomainError::ApprovalIdentityMismatch);
        }
        if command.actor.organization_id() != &self.identity.organization_id {
            return Err(DomainError::CrossOrganization {
                expected: self.identity.organization_id.clone(),
                found: command.actor.organization_id().clone(),
            });
        }
        self.validate()?;

        let key = command.idempotency_key.clone();
        if let Some(previous) = self.decision_commands.get(&key) {
            if previous == &command {
                return Ok(ApprovalDecisionOutcome::AlreadyApplied {
                    decision: command.decision,
                    status: self.status,
                    revision: self.revision,
                });
            }
            return Err(DomainError::IdempotencyConflict { key });
        }
        if self.revision != command.expected_revision {
            return Err(DomainError::RevisionMismatch {
                expected: command.expected_revision,
                actual: self.revision,
            });
        }
        if self.status != ApprovalStatus::Pending {
            return Err(DomainError::ApprovalNotPending);
        }

        let revision = self
            .revision
            .checked_add(1)
            .ok_or(DomainError::RevisionOverflow)?;
        let status = command.decision.resulting_status();
        self.status = status;
        self.revision = revision;
        self.decision = Some(command.decision);
        self.decided_by = Some(command.actor.clone());
        self.note = command.note.clone();
        self.decision_commands.insert(key, command.clone());

        Ok(ApprovalDecisionOutcome::Recorded {
            decision: command.decision,
            status,
            revision,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MentionKind {
    Wake,
    Reference,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct MentionTarget {
    pub organization_id: OrganizationId,
    pub agent_id: AgentId,
    pub kind: MentionKind,
}

impl MentionTarget {
    pub fn wake(organization_id: OrganizationId, agent_id: AgentId) -> Self {
        Self {
            organization_id,
            agent_id,
            kind: MentionKind::Wake,
        }
    }

    pub fn reference(organization_id: OrganizationId, agent_id: AgentId) -> Self {
        Self {
            organization_id,
            agent_id,
            kind: MentionKind::Reference,
        }
    }

    pub fn is_wake(&self) -> bool {
        self.kind == MentionKind::Wake
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AttentionRequest {
    pub issue: IssueRef,
    pub comment_id: CommentId,
    pub author: ActorRef,
    pub mentions: Vec<MentionTarget>,
    pub reopen_intent: bool,
    pub idempotency_key: IdempotencyKey,
}

impl AttentionRequest {
    pub fn new<I>(
        issue: IssueRef,
        comment_id: CommentId,
        author: ActorRef,
        mentions: I,
        reopen_intent: bool,
        idempotency_key: IdempotencyKey,
    ) -> Self
    where
        I: IntoIterator<Item = MentionTarget>,
    {
        Self {
            issue,
            comment_id,
            author,
            mentions: mentions.into_iter().collect(),
            reopen_intent,
            idempotency_key,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WakeReason {
    IssueCommentMentioned,
    IssueReopened,
}

impl WakeReason {
    #[allow(non_upper_case_globals)]
    pub const CommentMentioned: Self = Self::IssueCommentMentioned;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WakeRelationship {
    Assignee,
    Reviewer,
    Collaborator,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct WakeRequest {
    pub issue: IssueRef,
    pub comment_id: CommentId,
    pub target_agent_id: AgentId,
    pub reason: WakeReason,
    pub relationship: WakeRelationship,
}

fn wake_relationship(issue: &Issue, agent_id: &AgentId) -> WakeRelationship {
    if matches!(
        issue.assignee.as_ref(),
        Some(PrincipalRef::Agent { agent_id: assigned, .. }) if assigned == agent_id
    ) {
        WakeRelationship::Assignee
    } else if matches!(
        issue.reviewer.as_ref(),
        Some(PrincipalRef::Agent { agent_id: reviewer, .. }) if reviewer == agent_id
    ) {
        WakeRelationship::Reviewer
    } else {
        WakeRelationship::Collaborator
    }
}

pub fn route_comment_attention(
    issue: &Issue,
    request: AttentionRequest,
) -> Result<Vec<WakeRequest>, DomainError> {
    if request.issue != issue.identity {
        return Err(DomainError::IssueIdentityMismatch);
    }
    if request.author.organization_id() != &issue.identity.organization_id {
        return Err(DomainError::CrossOrganization {
            expected: issue.identity.organization_id.clone(),
            found: request.author.organization_id().clone(),
        });
    }

    let author_agent = request.author.agent_id();
    let reopen =
        request.reopen_intent && matches!(issue.status, IssueStatus::Done | IssueStatus::Cancelled);
    let assignee_agent = match issue.assignee.as_ref() {
        Some(PrincipalRef::Agent { agent_id, .. }) => Some(agent_id.clone()),
        _ => None,
    };
    let mut seen = BTreeSet::new();
    let mut wakes = Vec::new();

    for mention in &request.mentions {
        if mention.organization_id != issue.identity.organization_id {
            return Err(DomainError::CrossOrganization {
                expected: issue.identity.organization_id.clone(),
                found: mention.organization_id.clone(),
            });
        }
        if !mention.is_wake() || author_agent == Some(&mention.agent_id) {
            continue;
        }
        if !seen.insert(mention.agent_id.clone()) {
            continue;
        }
        let reason = if reopen && assignee_agent.as_ref() == Some(&mention.agent_id) {
            WakeReason::IssueReopened
        } else {
            WakeReason::IssueCommentMentioned
        };
        wakes.push(WakeRequest {
            issue: issue.identity.clone(),
            comment_id: request.comment_id.clone(),
            target_agent_id: mention.agent_id.clone(),
            reason,
            relationship: wake_relationship(issue, &mention.agent_id),
        });
    }

    match (reopen, assignee_agent) {
        (true, Some(assignee))
            if author_agent != Some(&assignee) && seen.insert(assignee.clone()) =>
        {
            wakes.push(WakeRequest {
                issue: issue.identity.clone(),
                comment_id: request.comment_id,
                target_agent_id: assignee,
                reason: WakeReason::IssueReopened,
                relationship: WakeRelationship::Assignee,
            });
        }
        _ => {}
    }

    Ok(wakes)
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditAction {
    IssueCreated,
    IssueUpdated,
    IssueCheckedOut,
    ReviewDecisionRecorded,
    ApprovalDecisionRecorded,
    CommentAttentionRouted,
    HierarchyUpdated,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub enum AuditEntity {
    Issue(IssueRef),
    Approval(ApprovalRef),
    Comment {
        issue: IssueRef,
        comment_id: CommentId,
    },
    Run {
        organization_id: OrganizationId,
        run_id: RunId,
    },
}

impl AuditEntity {
    pub fn organization_id(&self) -> &OrganizationId {
        match self {
            Self::Issue(issue) => &issue.organization_id,
            Self::Approval(approval) => &approval.organization_id,
            Self::Comment { issue, .. } => &issue.organization_id,
            Self::Run {
                organization_id, ..
            } => organization_id,
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct AuditEntry {
    pub organization_id: OrganizationId,
    pub actor: ActorRef,
    pub entity: AuditEntity,
    pub action: AuditAction,
    pub idempotency_key: IdempotencyKey,
}

impl AuditEntry {
    pub fn issue(
        organization_id: OrganizationId,
        actor: ActorRef,
        issue: IssueRef,
        action: AuditAction,
        idempotency_key: IdempotencyKey,
    ) -> Self {
        Self {
            organization_id,
            actor,
            entity: AuditEntity::Issue(issue),
            action,
            idempotency_key,
        }
    }

    pub fn approval(
        organization_id: OrganizationId,
        actor: ActorRef,
        approval: ApprovalRef,
        action: AuditAction,
        idempotency_key: IdempotencyKey,
    ) -> Self {
        Self {
            organization_id,
            actor,
            entity: AuditEntity::Approval(approval),
            action,
            idempotency_key,
        }
    }

    pub fn comment(
        organization_id: OrganizationId,
        actor: ActorRef,
        issue: IssueRef,
        comment_id: CommentId,
        action: AuditAction,
        idempotency_key: IdempotencyKey,
    ) -> Self {
        Self {
            organization_id,
            actor,
            entity: AuditEntity::Comment { issue, comment_id },
            action,
            idempotency_key,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub enum AuditAppendOutcome {
    Recorded,
    AlreadyApplied,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct AuditLedger {
    entries: Vec<AuditEntry>,
    by_idempotency_key: BTreeMap<IdempotencyKey, AuditEntry>,
}

impl AuditLedger {
    pub fn append(&mut self, entry: AuditEntry) -> Result<AuditAppendOutcome, DomainError> {
        if entry.actor.organization_id() != &entry.organization_id {
            return Err(DomainError::CrossOrganization {
                expected: entry.organization_id.clone(),
                found: entry.actor.organization_id().clone(),
            });
        }
        if entry.entity.organization_id() != &entry.organization_id {
            return Err(DomainError::CrossOrganization {
                expected: entry.organization_id.clone(),
                found: entry.entity.organization_id().clone(),
            });
        }

        let key = entry.idempotency_key.clone();
        if let Some(previous) = self.by_idempotency_key.get(&key) {
            if previous == &entry {
                return Ok(AuditAppendOutcome::AlreadyApplied);
            }
            return Err(DomainError::IdempotencyConflict { key });
        }
        self.by_idempotency_key.insert(key, entry.clone());
        self.entries.push(entry);
        Ok(AuditAppendOutcome::Recorded)
    }

    pub fn entries(&self) -> &[AuditEntry] {
        &self.entries
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct IssueHierarchy {
    parents: BTreeMap<IssueRef, IssueRef>,
}

impl IssueHierarchy {
    pub fn link_parent(&mut self, child: IssueRef, parent: IssueRef) -> Result<(), DomainError> {
        if child.organization_id != parent.organization_id {
            return Err(DomainError::CrossOrganization {
                expected: child.organization_id,
                found: parent.organization_id,
            });
        }
        if child == parent {
            return Err(DomainError::SelfParent);
        }

        let mut cursor = parent.clone();
        let mut visited = Vec::new();
        while let Some(next) = self.parents.get(&cursor) {
            if *next == child {
                return Err(DomainError::HierarchyCycle);
            }
            if visited.iter().any(|seen: &IssueRef| seen == &cursor) {
                return Err(DomainError::HierarchyCycle);
            }
            visited.push(cursor.clone());
            cursor = next.clone();
        }

        self.parents.insert(child, parent);
        Ok(())
    }

    pub fn parent_of(&self, child: &IssueRef) -> Option<&IssueRef> {
        self.parents.get(child)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue_ref(org: &str, issue: &str) -> IssueRef {
        IssueRef::new(OrganizationId::new(org), IssueId::new(issue))
    }

    #[test]
    fn issue_in_review_requires_a_reviewer() {
        let issue = Issue::new(
            issue_ref("org-a", "issue-1"),
            "Review the change",
            IssueStatus::InReview,
            None,
            None,
        );

        assert_eq!(issue, Err(DomainError::MissingReviewer));
    }

    #[test]
    fn hierarchy_rejects_a_parent_from_another_organization() {
        let child = issue_ref("org-a", "child");
        let parent = issue_ref("org-b", "parent");
        let mut hierarchy = IssueHierarchy::default();

        assert_eq!(
            hierarchy.link_parent(child, parent),
            Err(DomainError::CrossOrganization {
                expected: OrganizationId::new("org-a"),
                found: OrganizationId::new("org-b"),
            }),
        );
    }

    #[test]
    fn checkout_requires_the_agent_to_act_as_itself_and_is_idempotent() {
        let org = OrganizationId::new("org-a");
        let target = AgentId::new("agent-a");
        let run = RunId::new("run-a");
        let mut issue = Issue::new(
            issue_ref("org-a", "issue-1"),
            "Implement the change",
            IssueStatus::Todo,
            Some(PrincipalRef::agent(org.clone(), target.clone())),
            None,
        )
        .unwrap();
        let command = CheckoutCommand::new(
            issue.identity.clone(),
            ActorRef::agent(org.clone(), target.clone(), Some(run.clone())),
            target.clone(),
            Some(run),
            [IssueStatus::Todo],
            0,
            0,
            IdempotencyKey::new("checkout-1"),
        );

        let result = issue.checkout(command.clone(), 1).unwrap();
        assert!(matches!(result, CheckoutOutcome::CheckedOut { .. }));
        assert_eq!(issue.status, IssueStatus::InProgress);
        assert!(matches!(
            issue.checkout(command, 1),
            Ok(CheckoutOutcome::AlreadyApplied { .. })
        ));

        let wrong_actor = CheckoutCommand::new(
            issue.identity.clone(),
            ActorRef::agent(
                org.clone(),
                AgentId::new("agent-b"),
                Some(RunId::new("run-b")),
            ),
            target,
            Some(RunId::new("run-b")),
            [IssueStatus::InProgress],
            issue.revision,
            issue.fencing_token,
            IdempotencyKey::new("checkout-2"),
        );
        assert_eq!(
            issue.checkout(wrong_actor, 2),
            Err(DomainError::AgentCanOnlyCheckoutAsItself)
        );
    }

    #[test]
    fn stale_checkout_lease_is_rejected_without_takeover_proof() {
        let org = OrganizationId::new("org-a");
        let agent = AgentId::new("agent-a");
        let mut issue = Issue::new(
            issue_ref("org-a", "issue-1"),
            "Implement the change",
            IssueStatus::Todo,
            Some(PrincipalRef::agent(org.clone(), agent.clone())),
            None,
        )
        .unwrap();
        let first = CheckoutCommand::new(
            issue.identity.clone(),
            ActorRef::agent(org.clone(), agent.clone(), Some(RunId::new("run-a"))),
            agent.clone(),
            Some(RunId::new("run-a")),
            [IssueStatus::Todo],
            0,
            0,
            IdempotencyKey::new("checkout-1"),
        );
        issue.checkout(first, 1).unwrap();

        let stale = CheckoutCommand::new(
            issue.identity.clone(),
            ActorRef::agent(org.clone(), agent.clone(), Some(RunId::new("run-b"))),
            agent,
            Some(RunId::new("run-b")),
            [IssueStatus::InProgress],
            issue.revision,
            issue.fencing_token,
            IdempotencyKey::new("checkout-2"),
        );
        assert!(matches!(
            issue.checkout(stale, 2),
            Err(DomainError::LeaseHeld { .. })
        ));
    }

    #[test]
    fn reviewer_needs_followup_returns_the_issue_to_todo_and_rejects_a_repeat() {
        let org = OrganizationId::new("org-a");
        let reviewer = AgentId::new("reviewer-a");
        let assignee = AgentId::new("agent-a");
        let mut issue = Issue::new(
            issue_ref("org-a", "issue-1"),
            "Review the change",
            IssueStatus::InReview,
            Some(PrincipalRef::agent(org.clone(), assignee)),
            Some(PrincipalRef::agent(org.clone(), reviewer.clone())),
        )
        .unwrap();
        let command = ReviewDecisionCommand::new(
            issue.identity.clone(),
            ActorRef::agent(org, reviewer, Some(RunId::new("review-run"))),
            ReviewDecision::NeedsFollowup,
            "Please add the preview URL.",
            0,
            0,
            IdempotencyKey::new("review-1"),
        );

        let result = issue.record_review_decision(command.clone()).unwrap();
        assert!(matches!(result, ReviewDecisionOutcome::Recorded { .. }));
        assert_eq!(issue.status, IssueStatus::Todo);
        assert!(matches!(
            issue.record_review_decision(command),
            Ok(ReviewDecisionOutcome::AlreadyApplied { .. })
        ));

        let repeat = ReviewDecisionCommand::new(
            issue.identity.clone(),
            ActorRef::agent(
                OrganizationId::new("org-a"),
                AgentId::new("reviewer-a"),
                Some(RunId::new("review-run")),
            ),
            ReviewDecision::NeedsFollowup,
            "A second follow-up.",
            issue.revision,
            issue.fencing_token,
            IdempotencyKey::new("review-2"),
        );
        assert_eq!(
            issue.record_review_decision(repeat),
            Err(DomainError::ReviewNotOpen)
        );
    }

    #[test]
    fn approval_decision_rejects_a_cross_organization_target() {
        let target = GovernedTarget::Issue(issue_ref("org-a", "issue-1"));
        let mut approval = Approval::new(
            ApprovalRef::new(OrganizationId::new("org-a"), ApprovalId::new("approval-1")),
            ApprovalType::BudgetOverrideRequired,
            target,
            ActorRef::user(OrganizationId::new("org-a"), UserId::new("requester")),
        )
        .unwrap();
        let decision = ApprovalDecisionCommand::new(
            approval.identity.clone(),
            ActorRef::user(OrganizationId::new("org-b"), UserId::new("approver")),
            ApprovalDecision::Approve,
            None,
            0,
            IdempotencyKey::new("approval-decision-1"),
        );

        assert!(matches!(
            approval.decide(decision),
            Err(DomainError::CrossOrganization { .. })
        ));
    }

    #[test]
    fn comment_attention_wakes_only_explicit_deduplicated_mentions() {
        let org = OrganizationId::new("org-a");
        let assignee = AgentId::new("agent-a");
        let reviewer = AgentId::new("reviewer-a");
        let issue = Issue::new(
            issue_ref("org-a", "issue-1"),
            "Handle attention",
            IssueStatus::Todo,
            Some(PrincipalRef::agent(org.clone(), assignee.clone())),
            Some(PrincipalRef::agent(org.clone(), reviewer)),
        )
        .unwrap();
        let request = AttentionRequest::new(
            issue.identity.clone(),
            CommentId::new("comment-1"),
            ActorRef::user(org.clone(), UserId::new("operator")),
            [
                MentionTarget::wake(org.clone(), assignee.clone()),
                MentionTarget::wake(org, assignee.clone()),
            ],
            false,
            IdempotencyKey::new("comment-1"),
        );

        let wakes = route_comment_attention(&issue, request).unwrap();
        assert_eq!(wakes.len(), 1);
        assert_eq!(wakes[0].target_agent_id, assignee);
        assert_eq!(wakes[0].reason, WakeReason::IssueCommentMentioned);
        assert_eq!(wakes[0].relationship, WakeRelationship::Assignee);
    }

    #[test]
    fn audit_ledger_rejects_cross_organization_entries_and_replays_same_key() {
        let mut ledger = AuditLedger::default();
        let entry = AuditEntry::issue(
            OrganizationId::new("org-a"),
            ActorRef::user(OrganizationId::new("org-a"), UserId::new("operator")),
            IssueRef::new(OrganizationId::new("org-a"), IssueId::new("issue-1")),
            AuditAction::IssueUpdated,
            IdempotencyKey::new("audit-1"),
        );
        assert_eq!(
            ledger.append(entry.clone()).unwrap(),
            AuditAppendOutcome::Recorded
        );
        assert_eq!(
            ledger.append(entry).unwrap(),
            AuditAppendOutcome::AlreadyApplied
        );

        let cross_org = AuditEntry::issue(
            OrganizationId::new("org-b"),
            ActorRef::user(OrganizationId::new("org-b"), UserId::new("operator")),
            IssueRef::new(OrganizationId::new("org-a"), IssueId::new("issue-1")),
            AuditAction::IssueUpdated,
            IdempotencyKey::new("audit-2"),
        );
        assert!(matches!(
            ledger.append(cross_org),
            Err(DomainError::CrossOrganization { .. })
        ));
    }
}
