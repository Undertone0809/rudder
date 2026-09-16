//! Private, bounded Agent-permissions authority candidate.
//!
//! This crate intentionally owns no listener and performs no authentication.
//! A trusted authentication layer must construct and attach [`AuthenticatedActor`].

mod http;
mod store;

pub use http::{configure, get_permissions, patch_permissions};
pub use store::{PermissionError, PermissionService};

use serde::{Deserialize, Serialize};

/// Authenticated request context. It cannot be deserialized from request data.
#[derive(Clone, Debug)]
pub struct AuthenticatedActor(ActorKind);

#[derive(Clone, Debug)]
enum ActorKind {
    LocalBoard,
    InstanceAdmin {
        user_id: String,
    },
    ScopedBoard {
        user_id: String,
        allowed_organizations: Vec<String>,
    },
    Agent {
        organization_id: String,
        agent_id: String,
        run_id: Option<String>,
    },
}

impl AuthenticatedActor {
    /// Construct after local-implicit or instance-admin board authentication.
    pub fn local_implicit_board() -> Self {
        Self(ActorKind::LocalBoard)
    }

    /// Construct after an instance-admin session or board key is authenticated.
    pub fn instance_admin(user_id: impl Into<String>) -> Self {
        Self(ActorKind::InstanceAdmin {
            user_id: user_id.into(),
        })
    }

    /// Construct after session membership has produced an organization allow-list.
    pub fn scoped_board(user_id: impl Into<String>, organizations: Vec<String>) -> Self {
        Self(ActorKind::ScopedBoard {
            user_id: user_id.into(),
            allowed_organizations: organizations,
        })
    }

    /// Construct only after an Agent key or Agent JWT has been authenticated.
    pub fn agent(
        organization_id: impl Into<String>,
        agent_id: impl Into<String>,
        run_id: Option<String>,
    ) -> Self {
        Self(ActorKind::Agent {
            organization_id: organization_id.into(),
            agent_id: agent_id.into(),
            run_id,
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermissions {
    pub can_create_agents: bool,
    pub can_manage_skills: bool,
}

impl Default for AgentPermissions {
    fn default() -> Self {
        Self {
            can_create_agents: true,
            can_manage_skills: true,
        }
    }
}

/// Exact request shape of `PATCH /api/agents/:id/permissions`.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePermissions {
    pub can_create_agents: bool,
    pub can_manage_skills: Option<bool>,
    pub can_assign_tasks: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskAssignSource {
    CeoRole,
    AgentCreator,
    ExplicitGrant,
    None,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionView {
    pub id: String,
    pub org_id: String,
    pub role: String,
    pub status: String,
    pub permissions: AgentPermissions,
    pub can_assign_tasks: bool,
    pub task_assign_source: TaskAssignSource,
}
