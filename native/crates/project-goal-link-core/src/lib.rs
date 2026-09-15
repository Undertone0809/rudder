//! Bounded, private Project↔Goal hierarchy link mutation contract core.
//!
//! This crate owns only deterministic validation and fenced state transitions.
//! A later SQLx adapter must bind the returned fingerprint, organization scope,
//! version and fence epoch in one transaction. It performs no I/O and is not a
//! public writer.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use thiserror::Error;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Actor {
    Board {
        organization_id: String,
        principal_id: String,
    },
    CeoAgent {
        organization_id: String,
        principal_id: String,
    },
    Agent {
        organization_id: String,
        principal_id: String,
    },
}

impl Actor {
    pub fn organization_id(&self) -> &str {
        match self {
            Self::Board {
                organization_id, ..
            }
            | Self::CeoAgent {
                organization_id, ..
            }
            | Self::Agent {
                organization_id, ..
            } => organization_id,
        }
    }

    pub fn principal_id(&self) -> &str {
        match self {
            Self::Board { principal_id, .. }
            | Self::CeoAgent { principal_id, .. }
            | Self::Agent { principal_id, .. } => principal_id,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::Board { .. } => "board",
            Self::CeoAgent { .. } => "ceo_agent",
            Self::Agent { .. } => "agent",
        }
    }

    fn can_mutate(&self) -> bool {
        matches!(self, Self::Board { .. } | Self::CeoAgent { .. })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Attach,
    Detach,
}

impl Operation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Attach => "attach",
            Self::Detach => "detach",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGoalLinkCommand {
    pub organization_id: String,
    pub actor: Actor,
    pub project_id: String,
    pub goal_id: String,
    pub operation: Operation,
    pub expected_version: u64,
    pub fence_epoch: u64,
    pub idempotency_key: String,
}

impl ProjectGoalLinkCommand {
    #[allow(clippy::too_many_arguments)]
    pub fn board(
        organization_id: impl Into<String>,
        principal_id: impl Into<String>,
        project_id: impl Into<String>,
        goal_id: impl Into<String>,
        operation: Operation,
        expected_version: u64,
        fence_epoch: u64,
        idempotency_key: impl Into<String>,
    ) -> Self {
        let organization_id = organization_id.into();
        Self {
            actor: Actor::Board {
                organization_id: organization_id.clone(),
                principal_id: principal_id.into(),
            },
            organization_id,
            project_id: project_id.into(),
            goal_id: goal_id.into(),
            operation,
            expected_version,
            fence_epoch,
            idempotency_key: idempotency_key.into(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn ceo_agent(
        organization_id: impl Into<String>,
        principal_id: impl Into<String>,
        project_id: impl Into<String>,
        goal_id: impl Into<String>,
        operation: Operation,
        expected_version: u64,
        fence_epoch: u64,
        idempotency_key: impl Into<String>,
    ) -> Self {
        let organization_id = organization_id.into();
        Self {
            actor: Actor::CeoAgent {
                organization_id: organization_id.clone(),
                principal_id: principal_id.into(),
            },
            organization_id,
            project_id: project_id.into(),
            goal_id: goal_id.into(),
            operation,
            expected_version,
            fence_epoch,
            idempotency_key: idempotency_key.into(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn agent(
        organization_id: impl Into<String>,
        principal_id: impl Into<String>,
        project_id: impl Into<String>,
        goal_id: impl Into<String>,
        operation: Operation,
        expected_version: u64,
        fence_epoch: u64,
        idempotency_key: impl Into<String>,
    ) -> Self {
        let organization_id = organization_id.into();
        Self {
            actor: Actor::Agent {
                organization_id: organization_id.clone(),
                principal_id: principal_id.into(),
            },
            organization_id,
            project_id: project_id.into(),
            goal_id: goal_id.into(),
            operation,
            expected_version,
            fence_epoch,
            idempotency_key: idempotency_key.into(),
        }
    }

    pub fn validate(&self) -> Result<(), LinkMutationError> {
        if self.organization_id.is_empty()
            || self.project_id.is_empty()
            || self.goal_id.is_empty()
            || self.idempotency_key.is_empty()
            || self.actor.principal_id().is_empty()
            || self.actor.organization_id().is_empty()
        {
            return Err(LinkMutationError::InvalidField);
        }
        if self.actor.organization_id() != self.organization_id {
            return Err(LinkMutationError::CrossOrganization);
        }
        if !self.actor.can_mutate() {
            return Err(LinkMutationError::Unauthorized);
        }
        Ok(())
    }

    /// Private identity, not proof that a serialized actor is authenticated.
    pub fn fingerprint(&self) -> Result<String, LinkMutationError> {
        self.validate()?;
        #[derive(Serialize)]
        struct Fingerprint<'a> {
            organization_id: &'a str,
            actor_kind: &'static str,
            actor_id: &'a str,
            project_id: &'a str,
            goal_id: &'a str,
            operation: &'static str,
            expected_version: u64,
            fence_epoch: u64,
        }
        let value = Fingerprint {
            organization_id: &self.organization_id,
            actor_kind: self.actor.kind(),
            actor_id: self.actor.principal_id(),
            project_id: &self.project_id,
            goal_id: &self.goal_id,
            operation: self.operation.as_str(),
            expected_version: self.expected_version,
            fence_epoch: self.fence_epoch,
        };
        let bytes = serde_json::to_vec(&value).map_err(|_| LinkMutationError::FingerprintFailed)?;
        Ok(hex_digest(Sha256::digest(bytes)))
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct AppliedReceipt {
    version: u64,
    fence_epoch: u64,
    linked: bool,
    fingerprint: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGoalLinkState {
    pub organization_id: String,
    pub project_org_id: String,
    pub goal_org_id: String,
    pub version: u64,
    pub fence_epoch: u64,
    pub linked: bool,
    applied_idempotency: BTreeMap<String, AppliedReceipt>,
}

impl ProjectGoalLinkState {
    pub fn new(
        organization_id: impl Into<String>,
        project_org_id: impl Into<String>,
        goal_org_id: impl Into<String>,
        version: u64,
        fence_epoch: u64,
        linked: bool,
    ) -> Self {
        Self {
            organization_id: organization_id.into(),
            project_org_id: project_org_id.into(),
            goal_org_id: goal_org_id.into(),
            version,
            fence_epoch,
            linked,
            applied_idempotency: BTreeMap::new(),
        }
    }

    pub fn apply(
        &mut self,
        command: ProjectGoalLinkCommand,
    ) -> Result<LinkMutationOutcome, LinkMutationError> {
        command.validate()?;
        if self.organization_id.is_empty()
            || self.project_org_id.is_empty()
            || self.goal_org_id.is_empty()
        {
            return Err(LinkMutationError::InvalidField);
        }
        if self.organization_id != command.organization_id
            || self.project_org_id != command.organization_id
            || self.goal_org_id != command.organization_id
        {
            return Err(LinkMutationError::CrossOrganization);
        }
        let fingerprint = command.fingerprint()?;
        if let Some(previous) = self.applied_idempotency.get(&command.idempotency_key) {
            if previous.fingerprint == fingerprint {
                return Ok(LinkMutationOutcome::AlreadyApplied {
                    version: previous.version,
                    fence_epoch: previous.fence_epoch,
                    linked: previous.linked,
                    fingerprint,
                });
            }
            return Err(LinkMutationError::IdempotencyConflict);
        }
        if command.expected_version != self.version {
            return Err(LinkMutationError::StaleVersion);
        }
        if command.fence_epoch != self.fence_epoch {
            return Err(LinkMutationError::StaleFence);
        }

        let requested_linked = matches!(command.operation, Operation::Attach);
        if requested_linked == self.linked {
            self.applied_idempotency.insert(
                command.idempotency_key,
                AppliedReceipt {
                    version: self.version,
                    fence_epoch: self.fence_epoch,
                    linked: self.linked,
                    fingerprint: fingerprint.clone(),
                },
            );
            return Ok(LinkMutationOutcome::Noop {
                version: self.version,
                fence_epoch: self.fence_epoch,
                linked: self.linked,
                fingerprint,
            });
        }

        let next_version = self
            .version
            .checked_add(1)
            .ok_or(LinkMutationError::VersionOverflow)?;
        self.linked = requested_linked;
        self.version = next_version;
        self.applied_idempotency.insert(
            command.idempotency_key,
            AppliedReceipt {
                version: self.version,
                fence_epoch: self.fence_epoch,
                linked: self.linked,
                fingerprint: fingerprint.clone(),
            },
        );
        Ok(LinkMutationOutcome::Applied {
            version: self.version,
            fence_epoch: self.fence_epoch,
            linked: self.linked,
            fingerprint,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkMutationOutcome {
    Applied {
        version: u64,
        fence_epoch: u64,
        linked: bool,
        fingerprint: String,
    },
    Noop {
        version: u64,
        fence_epoch: u64,
        linked: bool,
        fingerprint: String,
    },
    AlreadyApplied {
        version: u64,
        fence_epoch: u64,
        linked: bool,
        fingerprint: String,
    },
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum LinkMutationError {
    #[error("mutation contains an empty field")]
    InvalidField,
    #[error("project and goal must belong to the mutation organization")]
    CrossOrganization,
    #[error("actor is not authorized for project-goal mutations")]
    Unauthorized,
    #[error("project-goal idempotency key was reused with a different command")]
    IdempotencyConflict,
    #[error("project-goal version is stale")]
    StaleVersion,
    #[error("project-goal fence epoch is stale")]
    StaleFence,
    #[error("project-goal version overflowed")]
    VersionOverflow,
    #[error("project-goal fingerprint could not be encoded")]
    FingerprintFailed,
}

fn hex_digest(digest: impl IntoIterator<Item = u8>) -> String {
    digest
        .into_iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> ProjectGoalLinkState {
        ProjectGoalLinkState::new("org-a", "org-a", "org-a", 2, 4, false)
    }

    fn board(operation: Operation, key: &str) -> ProjectGoalLinkCommand {
        ProjectGoalLinkCommand::board(
            "org-a",
            "board-a",
            "project-a",
            "goal-a",
            operation,
            2,
            4,
            key,
        )
    }

    #[test]
    fn attach_advances_version_and_sets_linked() {
        let mut state = state();
        let outcome = state.apply(board(Operation::Attach, "attach-1")).unwrap();
        assert!(matches!(
            outcome,
            LinkMutationOutcome::Applied {
                version: 3,
                linked: true,
                ..
            }
        ));
        assert_eq!(state.version, 3);
        assert!(state.linked);
    }

    #[test]
    fn detach_advances_version_and_clears_linked() {
        let mut state = ProjectGoalLinkState::new("org-a", "org-a", "org-a", 2, 4, true);
        let outcome = state.apply(board(Operation::Detach, "detach-1")).unwrap();
        assert!(matches!(
            outcome,
            LinkMutationOutcome::Applied {
                version: 3,
                linked: false,
                ..
            }
        ));
    }

    #[test]
    fn cross_organization_project_or_goal_fails_closed() {
        let mut project_foreign = ProjectGoalLinkState::new("org-a", "org-b", "org-a", 2, 4, false);
        assert_eq!(
            project_foreign.apply(board(Operation::Attach, "cross-project")),
            Err(LinkMutationError::CrossOrganization)
        );
        let mut goal_foreign = ProjectGoalLinkState::new("org-a", "org-a", "org-b", 2, 4, false);
        assert_eq!(
            goal_foreign.apply(board(Operation::Attach, "cross-goal")),
            Err(LinkMutationError::CrossOrganization)
        );
    }

    #[test]
    fn non_ceo_agent_fails_without_mutating_state() {
        let mut state = state();
        let command = ProjectGoalLinkCommand::agent(
            "org-a",
            "agent-a",
            "project-a",
            "goal-a",
            Operation::Attach,
            2,
            4,
            "agent-1",
        );
        assert_eq!(state.apply(command), Err(LinkMutationError::Unauthorized));
        assert_eq!(state.version, 2);
        assert!(!state.linked);
    }

    #[test]
    fn stale_version_and_fence_are_rejected() {
        let mut stale_version = state();
        let mut command = board(Operation::Attach, "stale-version");
        command.expected_version = 1;
        assert_eq!(
            stale_version.apply(command),
            Err(LinkMutationError::StaleVersion)
        );

        let mut stale_fence = state();
        let mut command = board(Operation::Attach, "stale-fence");
        command.fence_epoch = 3;
        assert_eq!(
            stale_fence.apply(command),
            Err(LinkMutationError::StaleFence)
        );
    }

    #[test]
    fn replay_is_idempotent_and_conflict_is_rejected() {
        let mut state = state();
        let first = state.apply(board(Operation::Attach, "same-key")).unwrap();
        let replay = state.apply(board(Operation::Attach, "same-key")).unwrap();
        assert!(matches!(
            first,
            LinkMutationOutcome::Applied { version: 3, .. }
        ));
        assert!(matches!(
            replay,
            LinkMutationOutcome::AlreadyApplied {
                version: 3,
                linked: true,
                ..
            }
        ));
        let mut conflict = board(Operation::Detach, "same-key");
        conflict.expected_version = 3;
        assert_eq!(
            state.apply(conflict),
            Err(LinkMutationError::IdempotencyConflict)
        );
    }

    #[test]
    fn repeated_attach_and_detach_are_noops() {
        let mut attached = ProjectGoalLinkState::new("org-a", "org-a", "org-a", 2, 4, true);
        assert!(matches!(
            attached
                .apply(board(Operation::Attach, "already-attached"))
                .unwrap(),
            LinkMutationOutcome::Noop {
                version: 2,
                linked: true,
                ..
            }
        ));
        let mut detached = state();
        assert!(matches!(
            detached
                .apply(board(Operation::Detach, "already-detached"))
                .unwrap(),
            LinkMutationOutcome::Noop {
                version: 2,
                linked: false,
                ..
            }
        ));
    }
}
