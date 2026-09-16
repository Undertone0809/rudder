use crate::{
    ActorKind, AgentPermissions, AuthenticatedActor, PermissionView, TaskAssignSource,
    UpdatePermissions,
};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PermissionError {
    #[error("authentication required")]
    Unauthorized,
    #[error("forbidden")]
    Forbidden,
    #[error("Only CEO can manage permissions")]
    OnlyCeo,
    #[error("Agent not found")]
    NotFound,
    #[error("database transaction failed")]
    Database(#[from] sqlx::Error),
}

#[derive(Clone)]
pub struct PermissionService {
    pool: PgPool,
}

struct AgentRow {
    id: String,
    org_id: String,
    role: String,
    status: String,
    permissions: Value,
}

impl PermissionService {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn read(
        &self,
        actor: &AuthenticatedActor,
        target_id: String,
    ) -> Result<PermissionView, PermissionError> {
        let mut tx = self.pool.begin().await?;
        let target = load_agent(&mut tx, target_id, false)
            .await?
            .ok_or(PermissionError::NotFound)?;
        authorize(&mut tx, actor, &target, false).await?;
        let view = view(&mut tx, target).await?;
        tx.commit().await?;
        Ok(view)
    }

    pub async fn update(
        &self,
        actor: &AuthenticatedActor,
        target_id: String,
        update: UpdatePermissions,
    ) -> Result<PermissionView, PermissionError> {
        let mut tx = self.pool.begin().await?;
        // The target lock makes partial updates and their access projection serializable.
        let mut target = load_agent(&mut tx, target_id, true)
            .await?
            .ok_or(PermissionError::NotFound)?;
        authorize(&mut tx, actor, &target, true).await?;

        let current = normalize(&target.permissions);
        let permissions = AgentPermissions {
            can_create_agents: update.can_create_agents,
            can_manage_skills: update
                .can_manage_skills
                .unwrap_or(current.can_manage_skills),
        };
        target.permissions = serde_json::to_value(permissions).expect("permissions serialize");
        sqlx::query("UPDATE agents SET permissions=$1, updated_at=now() WHERE id=$2::uuid AND org_id=$3::uuid")
            .bind(&target.permissions)
            .bind(&target.id)
            .bind(&target.org_id)
            .execute(&mut *tx)
            .await?;

        let effective_assign =
            target.role == "ceo" || permissions.can_create_agents || update.can_assign_tasks;
        ensure_membership(&mut tx, &target).await?;
        set_task_assign(&mut tx, actor, &target, effective_assign).await?;
        let source = if target.role == "ceo" {
            TaskAssignSource::CeoRole
        } else if permissions.can_create_agents {
            TaskAssignSource::AgentCreator
        } else if effective_assign {
            TaskAssignSource::ExplicitGrant
        } else {
            TaskAssignSource::None
        };

        let (actor_type, actor_id, actor_agent_id, run_id) = activity_actor(actor);
        sqlx::query(
            "INSERT INTO activity_log
             (org_id,actor_type,actor_id,agent_id,run_id,action,entity_type,entity_id,details)
             VALUES ($1::uuid,$2,$3,$4::uuid,$5::uuid,'agent.permissions_updated','agent',$6,$7)",
        )
        .bind(&target.org_id)
        .bind(actor_type)
        .bind(actor_id)
        .bind(actor_agent_id)
        .bind(run_id)
        .bind(&target.id)
        .bind(json!({
            "canCreateAgents": permissions.can_create_agents,
            "canManageSkills": permissions.can_manage_skills,
            "canAssignTasks": effective_assign,
        }))
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(PermissionView {
            id: target.id,
            org_id: target.org_id,
            role: target.role,
            status: target.status,
            permissions,
            can_assign_tasks: effective_assign,
            task_assign_source: source,
        })
    }
}

async fn load_agent(
    tx: &mut Transaction<'_, Postgres>,
    id: String,
    update_lock: bool,
) -> Result<Option<AgentRow>, sqlx::Error> {
    let lock = if update_lock {
        "FOR UPDATE"
    } else {
        "FOR SHARE"
    };
    let sql = format!(
        "SELECT id::text,org_id::text,role,status,permissions FROM agents WHERE id=$1::uuid {lock}"
    );
    sqlx::query_as::<_, (String, String, String, String, Value)>(&sql)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await
        .map(|row| {
            row.map(|(id, org_id, role, status, permissions)| AgentRow {
                id,
                org_id,
                role,
                status,
                permissions,
            })
        })
}

async fn authorize(
    tx: &mut Transaction<'_, Postgres>,
    actor: &AuthenticatedActor,
    target: &AgentRow,
    mutation: bool,
) -> Result<(), PermissionError> {
    match &actor.0 {
        ActorKind::LocalBoard => {}
        ActorKind::InstanceAdmin { user_id } => {
            let current = sqlx::query_scalar::<_, String>(
                "SELECT id::text FROM instance_user_roles
                 WHERE user_id=$1 AND role='instance_admin' FOR SHARE",
            )
            .bind(user_id)
            .fetch_optional(&mut **tx)
            .await?;
            if current.is_none() {
                return Err(PermissionError::Forbidden);
            }
        }
        ActorKind::ScopedBoard {
            user_id,
            allowed_organizations,
        } => {
            if !allowed_organizations.contains(&target.org_id) {
                return Err(PermissionError::Forbidden);
            }
            // The share lock serializes this mutation before membership suspension/deletion.
            let membership = sqlx::query_scalar::<_, String>(
                "SELECT id::text FROM organization_memberships
                 WHERE org_id=$1::uuid AND principal_type='user'
                   AND principal_id=$2 AND status='active' FOR SHARE",
            )
            .bind(&target.org_id)
            .bind(user_id)
            .fetch_optional(&mut **tx)
            .await?;
            if membership.is_none() {
                let administrator = sqlx::query_scalar::<_, String>(
                    "SELECT id::text FROM instance_user_roles
                     WHERE user_id=$1 AND role='instance_admin' FOR SHARE",
                )
                .bind(user_id)
                .fetch_optional(&mut **tx)
                .await?;
                if administrator.is_none() {
                    return Err(PermissionError::Forbidden);
                }
            }
        }
        ActorKind::Agent {
            organization_id,
            agent_id,
            ..
        } => {
            if organization_id != &target.org_id {
                return Err(PermissionError::Forbidden);
            }
            // Re-read and lock the current actor. Auth middleware state may be stale.
            let current = sqlx::query_as::<_, (String, String, String)>(
                "SELECT org_id::text,role,status FROM agents WHERE id=$1::uuid FOR SHARE",
            )
            .bind(agent_id)
            .fetch_optional(&mut **tx)
            .await?;
            let Some((org_id, role, status)) = current else {
                return Err(PermissionError::Forbidden);
            };
            if org_id != target.org_id
                || matches!(status.as_str(), "terminated" | "pending_approval")
            {
                return Err(PermissionError::Forbidden);
            }
            if mutation && role != "ceo" {
                return Err(PermissionError::OnlyCeo);
            }
        }
    }
    Ok(())
}

fn normalize(value: &Value) -> AgentPermissions {
    let object = value.as_object();
    AgentPermissions {
        can_create_agents: object
            .and_then(|o| o.get("canCreateAgents"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        can_manage_skills: object
            .and_then(|o| o.get("canManageSkills"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
    }
}

async fn view(
    tx: &mut Transaction<'_, Postgres>,
    target: AgentRow,
) -> Result<PermissionView, sqlx::Error> {
    let permissions = normalize(&target.permissions);
    let explicit: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM principal_permission_grants
         WHERE org_id=$1::uuid AND principal_type='agent' AND principal_id=$2
           AND permission_key='tasks:assign')",
    )
    .bind(&target.org_id)
    .bind(&target.id)
    .fetch_one(&mut **tx)
    .await?;
    let (can_assign_tasks, task_assign_source) = if target.role == "ceo" {
        (true, TaskAssignSource::CeoRole)
    } else if permissions.can_create_agents {
        (true, TaskAssignSource::AgentCreator)
    } else if explicit {
        (true, TaskAssignSource::ExplicitGrant)
    } else {
        (false, TaskAssignSource::None)
    };
    Ok(PermissionView {
        id: target.id,
        org_id: target.org_id,
        role: target.role,
        status: target.status,
        permissions,
        can_assign_tasks,
        task_assign_source,
    })
}

async fn ensure_membership(
    tx: &mut Transaction<'_, Postgres>,
    target: &AgentRow,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO organization_memberships
         (org_id,principal_type,principal_id,status,membership_role)
         VALUES ($1::uuid,'agent',$2,'active','member')
         ON CONFLICT (org_id,principal_type,principal_id) DO UPDATE
         SET status='active',membership_role='member',updated_at=now()",
    )
    .bind(&target.org_id)
    .bind(&target.id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn set_task_assign(
    tx: &mut Transaction<'_, Postgres>,
    actor: &AuthenticatedActor,
    target: &AgentRow,
    enabled: bool,
) -> Result<(), sqlx::Error> {
    if enabled {
        let granted_by = match &actor.0 {
            ActorKind::LocalBoard | ActorKind::Agent { .. } => None,
            ActorKind::InstanceAdmin { user_id } | ActorKind::ScopedBoard { user_id, .. } => {
                Some(user_id.as_str())
            }
        };
        sqlx::query(
            "INSERT INTO principal_permission_grants
             (org_id,principal_type,principal_id,permission_key,scope,granted_by_user_id)
             VALUES ($1::uuid,'agent',$2,'tasks:assign',NULL,$3)
             ON CONFLICT (org_id,principal_type,principal_id,permission_key) DO UPDATE
             SET scope=NULL,granted_by_user_id=EXCLUDED.granted_by_user_id,updated_at=now()",
        )
        .bind(&target.org_id)
        .bind(&target.id)
        .bind(granted_by)
        .execute(&mut **tx)
        .await?;
    } else {
        sqlx::query(
            "DELETE FROM principal_permission_grants
             WHERE org_id=$1::uuid AND principal_type='agent' AND principal_id=$2
               AND permission_key='tasks:assign'",
        )
        .bind(&target.org_id)
        .bind(&target.id)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

fn activity_actor(
    actor: &AuthenticatedActor,
) -> (&'static str, String, Option<String>, Option<String>) {
    match &actor.0 {
        ActorKind::LocalBoard => ("user", "board".into(), None, None),
        ActorKind::InstanceAdmin { user_id } | ActorKind::ScopedBoard { user_id, .. } => {
            ("user", user_id.clone(), None, None)
        }
        ActorKind::Agent {
            agent_id, run_id, ..
        } => (
            "agent",
            agent_id.clone(),
            Some(agent_id.clone()),
            run_id.clone(),
        ),
    }
}
