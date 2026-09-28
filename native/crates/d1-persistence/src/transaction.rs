use crate::{
    CommittedMutation, Outcome, ProjectDeleteCommand, Receipt, ResultState, StoreError,
    branding_kind, project_delete_kind, project_goal_kind, project_goal_set_kind,
};
use rudder_organization_mutation_core::{
    OrganizationBrandingCommand, OrganizationSettingsSnapshot,
};
use rudder_project_goal_link_core::{
    Operation, ProjectGoalLinkCommand, ProjectGoalSetReplacementCommand,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction};

pub(crate) type Tx<'a> = Transaction<'a, Postgres>;

pub(crate) const MAX_RESULT_BYTES: usize = 1024 * 1024;
const BRANDING_RECEIPT_FORMAT: i32 = 1;
const PROJECT_GOAL_RECEIPT_FORMAT: i32 = 2;
const PROJECT_GOAL_SET_RECEIPT_FORMAT: i32 = 1;
const PROJECT_DELETE_RECEIPT_FORMAT: i32 = 1;
const MAX_COMMAND_BYTES: usize = MAX_RESULT_BYTES / 2;
pub(crate) const MAX_PROJECT_GOALS: usize = 1024;
const MAX_TEXT_BYTES: usize = 256;

#[derive(Clone, Debug)]
pub(crate) struct ActorMetadata {
    pub kind: &'static str,
    pub principal_id: String,
    pub agent_id: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) enum ExpectedReceipt {
    OrganizationBranding {
        name: Option<String>,
        description: Option<Option<String>>,
        brand_color: Option<Option<String>>,
        logo_asset_id: Option<Option<String>>,
    },
    ProjectGoalLink {
        operation: Operation,
        link_identifier: String,
        core_fingerprint: String,
        linked: bool,
        cancelled: bool,
        target_integrity: String,
        primary_goal_after: Option<String>,
    },
    ProjectGoalSetReplacement {
        project_id: String,
        goal_ids: Vec<String>,
        primary_goal_after: Option<String>,
    },
    ProjectPatch {
        project_id: String,
        patch_fingerprint: String,
        goal_ids: Option<Vec<String>>,
        primary_goal_after: Option<Option<String>>,
        resource_attachment_operation: Option<ProjectResourceAttachmentOperationIdentity>,
    },
    ProjectDelete {
        project_id: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ProjectResourceAttachmentOperationIdentity {
    Attach { resource_id: String },
    Update { attachment_id: String },
    Remove { attachment_id: String },
}

#[derive(Clone, Debug)]
pub(crate) struct Metadata {
    pub org: String,
    pub key: String,
    pub kind: &'static str,
    pub fingerprint: String,
    pub expected_version: u64,
    pub fence_epoch: u64,
    pub actor: ActorMetadata,
    pub run_id: Option<String>,
    pub project_id: Option<String>,
    pub goal_id: Option<String>,
    pub link_identifier: Option<String>,
    pub expected_receipt: ExpectedReceipt,
    pub receipt_format: i32,
}

#[derive(Clone, Debug)]
pub(crate) struct LockedScope {
    pub version: u64,
    pub fence_epoch: u64,
    pub fence_token: String,
}

impl Metadata {
    pub fn branding(command: &OrganizationBrandingCommand) -> Result<Self, StoreError> {
        let view = command.as_integration_view()?;
        // The first public Rust writer owns only the scalar brandColor slice.
        // Names, descriptions, and logo storage remain on the fenced Node
        // path until their own component handoffs are complete.
        if view.name().is_some()
            || view.description().is_some()
            || view.logo_asset_id().is_some()
            || view.brand_color().is_none()
        {
            return Err(StoreError::InvalidInput);
        }
        let actor = actor_metadata(view.actor().kind(), view.actor().principal_id())?;
        let org = uuid(view.organization_id())?.to_owned();
        let key = bounded_text(view.idempotency_key(), false)?;
        let fingerprint = adapter_fingerprint(branding_kind(), &view.fingerprint()?, None)?;
        let body = json!({
            "organization_id": org,
            "actor_kind": actor.kind,
            "actor_id": actor.principal_id,
            "idempotency_key": key,
            "expected_version": view.expected_version(),
            "fence_epoch": view.fence_epoch(),
            "brand_color": view.brand_color(),
        });
        ensure_json_size(&body, MAX_COMMAND_BYTES)?;
        signed(view.expected_version())?;
        signed(view.fence_epoch())?;
        Ok(Self {
            org,
            key,
            kind: branding_kind(),
            fingerprint,
            expected_version: view.expected_version(),
            fence_epoch: view.fence_epoch(),
            actor,
            run_id: None,
            project_id: None,
            goal_id: None,
            link_identifier: None,
            expected_receipt: ExpectedReceipt::OrganizationBranding {
                name: None,
                description: None,
                brand_color: view.brand_color().map(|value| value.map(str::to_owned)),
                logo_asset_id: None,
            },
            receipt_format: BRANDING_RECEIPT_FORMAT,
        })
    }

    pub fn project_goal(
        command: &ProjectGoalLinkCommand,
        primary_goal_after: Option<String>,
    ) -> Result<Self, StoreError> {
        let view = command.as_integration_view()?;
        let context = view.context();
        let actor = actor_metadata(context.actor().kind(), context.actor().principal_id())?;
        let org = uuid(context.organization_id())?.to_owned();
        let project_id = uuid(context.project_id())?.to_owned();
        let goal_id = uuid(context.goal_id())?.to_owned();
        let project_org = uuid(context.project_organization_id())?;
        let goal_org = uuid(context.goal_organization_id())?;
        if project_org != org || goal_org != org {
            return Err(StoreError::Link(
                rudder_project_goal_link_core::LinkMutationError::CrossOrganization,
            ));
        }
        if let Some(primary) = primary_goal_after.as_deref() {
            uuid(primary)?;
        }
        let key = bounded_text(view.idempotency_key(), false)?;
        let core_fingerprint = view.fingerprint()?;
        let fingerprint = adapter_fingerprint(
            project_goal_kind(),
            &core_fingerprint,
            primary_goal_after.as_deref(),
        )?;
        let body = json!({
            "organization_id": org,
            "actor_kind": actor.kind,
            "actor_id": actor.principal_id,
            "project_id": project_id,
            "goal_id": goal_id,
            "operation": format!("{:?}", view.operation()).to_lowercase(),
            "idempotency_key": key,
            "expected_version": view.expected_version(),
            "fence_epoch": view.fence_epoch(),
            "primary_goal_after": primary_goal_after,
            "state_integrity": context.state_integrity(),
        });
        ensure_json_size(&body, MAX_COMMAND_BYTES)?;
        signed(view.expected_version())?;
        signed(view.fence_epoch())?;
        let link_identifier = view.link_identifier()?;
        Ok(Self {
            org,
            key,
            kind: project_goal_kind(),
            fingerprint,
            expected_version: view.expected_version(),
            fence_epoch: view.fence_epoch(),
            actor,
            run_id: None,
            project_id: Some(project_id),
            goal_id: Some(goal_id),
            link_identifier: Some(link_identifier.clone()),
            expected_receipt: ExpectedReceipt::ProjectGoalLink {
                operation: view.operation(),
                link_identifier: link_identifier.clone(),
                core_fingerprint: core_fingerprint.clone(),
                linked: context.linked(),
                cancelled: context.cancelled(),
                target_integrity: context.state_integrity().to_owned(),
                primary_goal_after: primary_goal_after.clone(),
            },
            receipt_format: PROJECT_GOAL_RECEIPT_FORMAT,
        })
    }

    pub fn project_goal_set(
        command: &ProjectGoalSetReplacementCommand,
    ) -> Result<Self, StoreError> {
        let view = command.as_integration_view()?;
        let context = view.context();
        let actor = actor_metadata(context.actor().kind(), context.actor().principal_id())?;
        let org = uuid(context.organization_id())?.to_owned();
        let project_id = uuid(context.project_id())?.to_owned();
        for goal_id in context.goal_ids() {
            uuid(goal_id)?;
        }
        let key = bounded_text(view.idempotency_key(), false)?;
        let core_fingerprint = view.fingerprint()?;
        let fingerprint = adapter_fingerprint(project_goal_set_kind(), &core_fingerprint, None)?;
        let run_id = view
            .run_id()
            .map(|value| uuid(value).map(str::to_owned))
            .transpose()?;
        let body = json!({
            "organization_id": org,
            "actor_kind": actor.kind,
            "actor_id": actor.principal_id,
            "project_id": project_id,
            "goal_ids": context.goal_ids(),
            "primary_goal_after": context.primary_goal_after(),
            "idempotency_key": key,
            "expected_version": view.expected_version(),
            "fence_epoch": view.fence_epoch(),
        });
        ensure_json_size(&body, MAX_COMMAND_BYTES)?;
        signed(view.expected_version())?;
        signed(view.fence_epoch())?;
        Ok(Self {
            org,
            key,
            kind: project_goal_set_kind(),
            fingerprint,
            expected_version: view.expected_version(),
            fence_epoch: view.fence_epoch(),
            actor,
            run_id,
            project_id: Some(project_id.clone()),
            goal_id: None,
            link_identifier: None,
            expected_receipt: ExpectedReceipt::ProjectGoalSetReplacement {
                project_id,
                goal_ids: context.goal_ids().to_owned(),
                primary_goal_after: context.primary_goal_after().map(str::to_owned),
            },
            receipt_format: PROJECT_GOAL_SET_RECEIPT_FORMAT,
        })
    }

    pub fn project_patch(
        command: &crate::ProjectPatchCommand,
        patch: &crate::project_patches::Patch,
    ) -> Result<Self, StoreError> {
        let actor_kind = match command.actor_kind.as_str() {
            "board" => "board",
            "agent" => "agent",
            "ceo_agent" => "ceo_agent",
            _ => return Err(StoreError::Unauthorized),
        };
        let actor = actor_metadata(actor_kind, &command.actor_id)?;
        let org = uuid(&command.organization_id)?.to_owned();
        let project_id = uuid(&command.project_id)?.to_owned();
        let key = bounded_text(&command.idempotency_key, false)?;
        let run_id = command
            .run_id
            .as_deref()
            .map(|value| uuid(value).map(str::to_owned))
            .transpose()?;
        let patch_fingerprint = hex_digest(Sha256::digest(
            serde_json::to_vec(&command.patch).map_err(|_| StoreError::InvalidInput)?,
        ));
        let resource_attachment_operation = project_resource_attachment_operation(&command.patch)?;
        let identity = json!({
            "adapter_format": 1,
            "kind": project_goal_set_kind(),
            "organization_id": org,
            "project_id": project_id,
            "actor_kind": actor.kind,
            "actor_id": actor.principal_id,
            "run_id": run_id,
            "idempotency_key": key,
            "patch_fingerprint": patch_fingerprint,
        });
        ensure_json_size(&identity, MAX_COMMAND_BYTES)?;
        let fingerprint = hex_digest(Sha256::digest(
            serde_json::to_vec(&identity).map_err(|_| StoreError::InvalidInput)?,
        ));
        signed(command.expected_version)?;
        signed(command.fence_epoch)?;
        if patch_fingerprint != patch.fingerprint() {
            return Err(StoreError::InvalidInput);
        }

        Ok(Self {
            org,
            key,
            kind: project_goal_set_kind(),
            fingerprint,
            expected_version: command.expected_version,
            fence_epoch: command.fence_epoch,
            actor,
            run_id,
            project_id: Some(project_id.clone()),
            goal_id: None,
            link_identifier: None,
            expected_receipt: ExpectedReceipt::ProjectPatch {
                project_id,
                patch_fingerprint,
                goal_ids: patch.goal_ids.clone(),
                primary_goal_after: patch
                    .goal_ids
                    .as_ref()
                    .map(|goal_ids| goal_ids.first().cloned()),
                resource_attachment_operation: resource_attachment_operation.clone(),
            },
            receipt_format: if resource_attachment_operation.is_some() {
                3
            } else {
                2
            },
        })
    }

    pub fn project_delete(command: &ProjectDeleteCommand) -> Result<Self, StoreError> {
        let actor_kind = match command.actor_kind.as_str() {
            "board" => "board",
            "agent" => "agent",
            _ => return Err(StoreError::Unauthorized),
        };
        let actor = actor_metadata(actor_kind, &command.actor_id)?;
        let org = uuid(&command.organization_id)?.to_owned();
        let project_id = uuid(&command.project_id)?.to_owned();
        let key = bounded_text(&command.idempotency_key, false)?;
        let run_id = command
            .run_id
            .as_deref()
            .map(|value| uuid(value).map(str::to_owned))
            .transpose()?;
        let identity = json!({
            "adapter_format": 1,
            "kind": project_delete_kind(),
            "operation": "delete",
            "organization_id": org,
            "project_id": project_id,
            "actor_kind": actor.kind,
            "actor_id": actor.principal_id,
            "run_id": run_id,
            "idempotency_key": key,
        });
        ensure_json_size(&identity, MAX_COMMAND_BYTES)?;
        signed(command.expected_version)?;
        signed(command.fence_epoch)?;
        let fingerprint = hex_digest(Sha256::digest(
            serde_json::to_vec(&identity).map_err(|_| StoreError::InvalidInput)?,
        ));

        Ok(Self {
            org,
            key,
            kind: project_delete_kind(),
            fingerprint,
            expected_version: command.expected_version,
            fence_epoch: command.fence_epoch,
            actor,
            run_id,
            project_id: Some(project_id.clone()),
            goal_id: None,
            link_identifier: None,
            expected_receipt: ExpectedReceipt::ProjectDelete { project_id },
            receipt_format: PROJECT_DELETE_RECEIPT_FORMAT,
        })
    }

    pub fn check_fresh(&self, version: u64, fence_epoch: u64) -> Result<(), StoreError> {
        if self.expected_version != version {
            return Err(StoreError::StaleVersion);
        }
        if self.fence_epoch != fence_epoch {
            return Err(StoreError::StaleFence);
        }
        Ok(())
    }
}

fn project_resource_attachment_operation(
    patch: &Value,
) -> Result<Option<ProjectResourceAttachmentOperationIdentity>, StoreError> {
    let Some(operation) = patch.get("resourceAttachmentOperation") else {
        return Ok(None);
    };
    let operation = operation.as_object().ok_or(StoreError::InvalidInput)?;
    let kind = operation
        .get("kind")
        .and_then(Value::as_str)
        .ok_or(StoreError::InvalidInput)?;
    match kind {
        "attach" => {
            let resource_id = operation
                .get("resourceId")
                .and_then(Value::as_str)
                .ok_or(StoreError::InvalidInput)?;
            uuid(resource_id)?;
            Ok(Some(ProjectResourceAttachmentOperationIdentity::Attach {
                resource_id: resource_id.to_owned(),
            }))
        }
        "update" | "remove" => {
            let attachment_id = operation
                .get("attachmentId")
                .and_then(Value::as_str)
                .ok_or(StoreError::InvalidInput)?;
            uuid(attachment_id)?;
            let identity = if kind == "update" {
                ProjectResourceAttachmentOperationIdentity::Update {
                    attachment_id: attachment_id.to_owned(),
                }
            } else {
                ProjectResourceAttachmentOperationIdentity::Remove {
                    attachment_id: attachment_id.to_owned(),
                }
            };
            Ok(Some(identity))
        }
        _ => Err(StoreError::InvalidInput),
    }
}

pub(crate) struct Effect {
    pub version: u64,
    pub fence_epoch: u64,
    pub outcome: Outcome,
    pub result: ResultState,
    pub entity_id: String,
    pub activity_action: Option<&'static str>,
    pub activity_entity_type: Option<&'static str>,
    pub details: Value,
}

pub(crate) async fn begin(pool: &PgPool) -> Result<Tx<'_>, StoreError> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        "SELECT set_config('lock_timeout','5s',true), \
                set_config('statement_timeout','15s',true), \
                set_config('idle_in_transaction_session_timeout','30s',true)",
    )
    .execute(&mut *tx)
    .await?;
    Ok(tx)
}

pub(crate) async fn finish(
    tx: Tx<'_>,
    result: Result<CommittedMutation, StoreError>,
) -> Result<CommittedMutation, StoreError> {
    match result {
        Ok(value) => {
            tx.commit().await?;
            Ok(value)
        }
        Err(error) => {
            let _ = tx.rollback().await;
            Err(error)
        }
    }
}

pub(crate) async fn lock_scope(
    tx: &mut Tx<'_>,
    metadata: &Metadata,
) -> Result<LockedScope, StoreError> {
    lock_scope_with_agent_policy(tx, metadata, false).await
}

pub(crate) async fn lock_scope_for_project_patch(
    tx: &mut Tx<'_>,
    metadata: &Metadata,
) -> Result<LockedScope, StoreError> {
    lock_scope_with_agent_policy(tx, metadata, true).await
}

pub(crate) async fn lock_organization_boundary(
    tx: &mut Tx<'_>,
    metadata: &Metadata,
) -> Result<(), StoreError> {
    let state = sqlx::query(
        "SELECT org_id FROM organization_mutation_state WHERE org_id=$1::uuid FOR UPDATE",
    )
    .bind(&metadata.org)
    .fetch_optional(&mut **tx)
    .await?;
    if state.is_none() {
        let organization_exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM organizations WHERE id=$1::uuid)",
        )
        .bind(&metadata.org)
        .fetch_one(&mut **tx)
        .await?;
        return Err(if organization_exists {
            StoreError::NotOwned
        } else {
            StoreError::NotFound
        });
    }
    Ok(())
}

pub(crate) async fn authorize_project_delete_caller(
    tx: &mut Tx<'_>,
    metadata: &Metadata,
) -> Result<(), StoreError> {
    match metadata.actor.kind {
        "board" => {}
        "agent" => {
            let agent =
                sqlx::query("SELECT status FROM agents WHERE id=$1::uuid AND org_id=$2::uuid")
                    .bind(&metadata.actor.principal_id)
                    .bind(&metadata.org)
                    .fetch_optional(&mut **tx)
                    .await?
                    .ok_or(StoreError::Unauthorized)?;
            if matches!(
                agent.try_get::<String, _>("status")?.as_str(),
                "terminated" | "pending_approval"
            ) {
                return Err(StoreError::Unauthorized);
            }
        }
        _ => return Err(StoreError::Unauthorized),
    }

    if let Some(run_id) = metadata.run_id.as_deref() {
        let exists = if let Some(agent_id) = metadata.actor.agent_id.as_deref() {
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(
                   SELECT 1 FROM heartbeat_runs
                   WHERE id=$1::uuid AND org_id=$2::uuid AND agent_id=$3::uuid
                 )",
            )
            .bind(run_id)
            .bind(&metadata.org)
            .bind(agent_id)
            .fetch_one(&mut **tx)
            .await?
        } else {
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(
                   SELECT 1 FROM heartbeat_runs WHERE id=$1::uuid AND org_id=$2::uuid
                 )",
            )
            .bind(run_id)
            .bind(&metadata.org)
            .fetch_one(&mut **tx)
            .await?
        };
        if !exists {
            return Err(StoreError::InvalidInput);
        }
    }
    Ok(())
}

pub(crate) async fn lock_scope_for_project_delete(
    tx: &mut Tx<'_>,
    metadata: &Metadata,
) -> Result<LockedScope, StoreError> {
    lock_scope_with_agent_policy(tx, metadata, true).await
}

async fn lock_scope_with_agent_policy(
    tx: &mut Tx<'_>,
    metadata: &Metadata,
    allow_non_ceo_agent: bool,
) -> Result<LockedScope, StoreError> {
    let organization_state = sqlx::query(
        "SELECT owner, mutation_version, fence_epoch, fence_token::text AS fence_token
         FROM organization_mutation_state
         WHERE org_id=$1::uuid
         FOR UPDATE",
    )
    .bind(&metadata.org)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(_organization_state) = organization_state else {
        let organization_exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM organizations WHERE id=$1::uuid)",
        )
        .bind(&metadata.org)
        .fetch_one(&mut **tx)
        .await?;
        return Err(if organization_exists {
            StoreError::NotOwned
        } else {
            StoreError::NotFound
        });
    };
    let project_id = metadata
        .project_id
        .as_deref()
        .ok_or(StoreError::InvalidInput)?;
    let state = sqlx::query(
        "SELECT owner, mutation_version, fence_epoch, fence_token::text AS fence_token
         FROM project_goal_mutation_state
         WHERE project_id=$1::uuid AND org_id=$2::uuid
         FOR UPDATE",
    )
    .bind(project_id)
    .bind(&metadata.org)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(state) = state else {
        let project_organization =
            sqlx::query_scalar::<_, String>("SELECT org_id::text FROM projects WHERE id=$1::uuid")
                .bind(project_id)
                .fetch_optional(&mut **tx)
                .await?;
        return Err(match project_organization {
            None => StoreError::NotFound,
            Some(organization) if organization != metadata.org => StoreError::NotFound,
            Some(_) => StoreError::NotOwned,
        });
    };
    if state.try_get::<String, _>("owner")? != "rust" {
        return Err(StoreError::NotOwned);
    }

    // Legacy Node writers acquire this fence row before touching any business
    // row. Keep Rust's lock order identical so an ownership handoff cannot
    // deadlock on organizations versus organization_mutation_state.
    let organization = sqlx::query("SELECT id FROM organizations WHERE id=$1::uuid FOR UPDATE")
        .bind(&metadata.org)
        .fetch_optional(&mut **tx)
        .await?;
    if organization.is_none() {
        return Err(StoreError::NotFound);
    }

    if metadata.actor.kind == "ceo_agent" || metadata.actor.kind == "agent" {
        let agent = sqlx::query(
            "SELECT role, status
             FROM agents
             WHERE id=$1::uuid AND org_id=$2::uuid
             FOR UPDATE",
        )
        .bind(&metadata.actor.principal_id)
        .bind(&metadata.org)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(StoreError::Unauthorized)?;
        if (!allow_non_ceo_agent && agent.try_get::<String, _>("role")? != "ceo")
            || matches!(
                agent.try_get::<String, _>("status")?.as_str(),
                "terminated" | "pending_approval"
            )
        {
            return Err(StoreError::Unauthorized);
        }
    } else if metadata.actor.kind != "board" {
        return Err(StoreError::Unauthorized);
    }

    let fence_token = state.try_get::<String, _>("fence_token")?;
    uuid(&fence_token)?;
    Ok(LockedScope {
        version: unsigned(state.try_get::<i64, _>("mutation_version")?)?,
        fence_epoch: unsigned(state.try_get::<i64, _>("fence_epoch")?)?,
        fence_token,
    })
}

pub(crate) async fn lock_branding_scope(
    tx: &mut Tx<'_>,
    metadata: &Metadata,
) -> Result<LockedScope, StoreError> {
    let state = sqlx::query(
        "SELECT owner, mutation_version, fence_epoch, fence_token::text AS fence_token
         FROM organization_branding_mutation_state
         WHERE org_id=$1::uuid
         FOR UPDATE",
    )
    .bind(&metadata.org)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(state) = state else {
        let organization_exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM organizations WHERE id=$1::uuid)",
        )
        .bind(&metadata.org)
        .fetch_one(&mut **tx)
        .await?;
        return Err(if organization_exists {
            StoreError::NotOwned
        } else {
            StoreError::NotFound
        });
    };
    if state.try_get::<String, _>("owner")? != "rust" {
        return Err(StoreError::NotOwned);
    }

    // Node branding writers lock this component before the organization-wide
    // fence. Rust keeps the same component -> organization order so a handoff
    // cannot leave a stale Node transaction able to write brandColor.
    let organization = sqlx::query("SELECT id FROM organizations WHERE id=$1::uuid FOR UPDATE")
        .bind(&metadata.org)
        .fetch_optional(&mut **tx)
        .await?;
    if organization.is_none() {
        return Err(StoreError::NotFound);
    }

    if metadata.actor.kind == "ceo_agent" || metadata.actor.kind == "agent" {
        let agent = sqlx::query(
            "SELECT role, status
             FROM agents
             WHERE id=$1::uuid AND org_id=$2::uuid
             FOR UPDATE",
        )
        .bind(&metadata.actor.principal_id)
        .bind(&metadata.org)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(StoreError::Unauthorized)?;
        if agent.try_get::<String, _>("role")? != "ceo"
            || matches!(
                agent.try_get::<String, _>("status")?.as_str(),
                "terminated" | "pending_approval"
            )
        {
            return Err(StoreError::Unauthorized);
        }
    } else if metadata.actor.kind != "board" {
        return Err(StoreError::Unauthorized);
    }

    let fence_token = state.try_get::<String, _>("fence_token")?;
    uuid(&fence_token)?;
    Ok(LockedScope {
        version: unsigned(state.try_get::<i64, _>("mutation_version")?)?,
        fence_epoch: unsigned(state.try_get::<i64, _>("fence_epoch")?)?,
        fence_token,
    })
}

pub(crate) async fn replay(
    tx: &mut Tx<'_>,
    metadata: &Metadata,
) -> Result<Option<CommittedMutation>, StoreError> {
    let row = sqlx::query(
        "SELECT command_kind, command_fingerprint, receipt_format, outcome,
                resulting_version, fence_epoch, activity_id::text,
                CASE WHEN ($4 AND command_kind='project_delete' AND command_fingerprint=$5)
                          OR octet_length(result::text) <= $3
                     THEN result::text ELSE NULL END AS result_text
         FROM organization_mutation_receipts
         WHERE org_id=$1::uuid AND idempotency_key=$2",
    )
    .bind(&metadata.org)
    .bind(&metadata.key)
    .bind(i64::try_from(MAX_RESULT_BYTES).expect("result bound fits BIGINT"))
    .bind(metadata.kind == project_delete_kind())
    .bind(&metadata.fingerprint)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };

    if row.try_get::<String, _>("command_kind")? != metadata.kind
        || row.try_get::<String, _>("command_fingerprint")? != metadata.fingerprint
    {
        return Err(StoreError::IdempotencyConflict);
    }
    if row.try_get::<i32, _>("receipt_format")? != metadata.receipt_format {
        return Err(StoreError::InvalidReceipt);
    }
    let result_text: Option<String> = row.try_get("result_text")?;
    let Some(result_text) = result_text else {
        return Err(StoreError::InvalidReceipt);
    };
    let stored_value: Value =
        serde_json::from_str(&result_text).map_err(|_| StoreError::InvalidReceipt)?;
    let mut receipt_value = stored_value.clone();
    let resource_attachment_response = receipt_value
        .as_object_mut()
        .and_then(|object| object.remove("resource_attachment_response"));
    let receipt: Receipt =
        serde_json::from_value(receipt_value.clone()).map_err(|_| StoreError::InvalidReceipt)?;
    let canonical_value = serde_json::to_value(&receipt).map_err(|_| StoreError::InvalidReceipt)?;
    if canonical_value != receipt_value {
        return Err(StoreError::InvalidReceipt);
    }
    let resulting_version = unsigned(row.try_get::<i64, _>("resulting_version")?)?;
    let fence_epoch = unsigned(row.try_get::<i64, _>("fence_epoch")?)?;
    let row_outcome = row.try_get::<String, _>("outcome")?;
    if receipt.organization_id != metadata.org
        || receipt.fingerprint != metadata.fingerprint
        || receipt.version != resulting_version
        || receipt.fence_epoch != fence_epoch
        || receipt.activity_id != row.try_get::<String, _>("activity_id")?
        || receipt.outcome.as_str() != row_outcome
    {
        return Err(StoreError::InvalidReceipt);
    }
    validate_receipt_result(metadata, &receipt)?;
    validate_project_resource_attachment_response(metadata, resource_attachment_response.as_ref())?;
    Ok(Some(CommittedMutation {
        replayed: true,
        receipt,
    }))
}

pub(crate) async fn branding_replay(
    tx: &mut Tx<'_>,
    metadata: &Metadata,
) -> Result<Option<CommittedMutation>, StoreError> {
    let row = sqlx::query(
        "SELECT command_fingerprint, receipt_format, outcome,
                resulting_version, fence_epoch, activity_id::text,
                CASE WHEN octet_length(result::text) <= $3
                     THEN result::text ELSE NULL END AS result_text
         FROM organization_branding_mutation_receipts
         WHERE org_id=$1::uuid AND idempotency_key=$2",
    )
    .bind(&metadata.org)
    .bind(&metadata.key)
    .bind(i64::try_from(MAX_RESULT_BYTES).expect("result bound fits BIGINT"))
    .fetch_optional(&mut **tx)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };

    if row.try_get::<String, _>("command_fingerprint")? != metadata.fingerprint {
        return Err(StoreError::IdempotencyConflict);
    }
    if row.try_get::<i32, _>("receipt_format")? != metadata.receipt_format {
        return Err(StoreError::InvalidReceipt);
    }
    let result_text: Option<String> = row.try_get("result_text")?;
    let Some(result_text) = result_text else {
        return Err(StoreError::InvalidReceipt);
    };
    let stored_value: Value =
        serde_json::from_str(&result_text).map_err(|_| StoreError::InvalidReceipt)?;
    let receipt: Receipt =
        serde_json::from_value(stored_value.clone()).map_err(|_| StoreError::InvalidReceipt)?;
    let canonical_value = serde_json::to_value(&receipt).map_err(|_| StoreError::InvalidReceipt)?;
    if canonical_value != stored_value {
        return Err(StoreError::InvalidReceipt);
    }
    let resulting_version = unsigned(row.try_get::<i64, _>("resulting_version")?)?;
    let fence_epoch = unsigned(row.try_get::<i64, _>("fence_epoch")?)?;
    let row_outcome = row.try_get::<String, _>("outcome")?;
    if receipt.organization_id != metadata.org
        || receipt.fingerprint != metadata.fingerprint
        || receipt.version != resulting_version
        || receipt.fence_epoch != fence_epoch
        || receipt.activity_id != row.try_get::<String, _>("activity_id")?
        || receipt.outcome.as_str() != row_outcome
    {
        return Err(StoreError::InvalidReceipt);
    }
    validate_receipt_result(metadata, &receipt)?;
    Ok(Some(CommittedMutation {
        replayed: true,
        receipt,
    }))
}

pub(crate) async fn persist(
    tx: &mut Tx<'_>,
    metadata: &Metadata,
    scope: &LockedScope,
    effect: Effect,
) -> Result<CommittedMutation, StoreError> {
    persist_with_resource_attachment_response(tx, metadata, scope, effect, None).await
}

pub(crate) async fn persist_project_patch(
    tx: &mut Tx<'_>,
    metadata: &Metadata,
    scope: &LockedScope,
    effect: Effect,
    resource_attachment_response: Option<Value>,
) -> Result<CommittedMutation, StoreError> {
    persist_with_resource_attachment_response(
        tx,
        metadata,
        scope,
        effect,
        resource_attachment_response,
    )
    .await
}

async fn persist_with_resource_attachment_response(
    tx: &mut Tx<'_>,
    metadata: &Metadata,
    scope: &LockedScope,
    effect: Effect,
    resource_attachment_response: Option<Value>,
) -> Result<CommittedMutation, StoreError> {
    signed(effect.version)?;
    signed(effect.fence_epoch)?;
    if effect.fence_epoch < scope.fence_epoch
        || effect.fence_epoch > scope.fence_epoch.saturating_add(1)
    {
        return Err(StoreError::StaleFence);
    }
    ensure_json_size(&effect.details, MAX_RESULT_BYTES)?;
    let receipt = Receipt {
        organization_id: metadata.org.clone(),
        version: effect.version,
        fence_epoch: effect.fence_epoch,
        fingerprint: metadata.fingerprint.clone(),
        activity_id: String::new(),
        outcome: effect.outcome,
        result: effect.result,
    };
    validate_receipt_result(metadata, &receipt)?;
    validate_project_resource_attachment_response(metadata, resource_attachment_response.as_ref())?;

    let mut result_without_activity =
        serde_json::to_value(&receipt).map_err(|_| StoreError::InvalidReceipt)?;
    if let Some(response) = &resource_attachment_response {
        result_without_activity
            .as_object_mut()
            .ok_or(StoreError::InvalidReceipt)?
            .insert("resource_attachment_response".to_owned(), response.clone());
    }
    ensure_json_size(&result_without_activity, MAX_RESULT_BYTES)?;

    let project_id = metadata
        .project_id
        .as_deref()
        .ok_or(StoreError::InvalidInput)?;
    let updated = sqlx::query(
        "UPDATE project_goal_mutation_state
         SET mutation_version=$2,
             fence_epoch=$3,
             fence_token=CASE WHEN $3 > $5 THEN gen_random_uuid() ELSE fence_token END,
             updated_at=now()
         WHERE project_id=$1::uuid
           AND org_id=$7::uuid
           AND owner='rust'
           AND mutation_version=$4
           AND fence_epoch=$5
           AND fence_token=$6::uuid",
    )
    .bind(project_id)
    .bind(signed(effect.version)?)
    .bind(signed(effect.fence_epoch)?)
    .bind(signed(metadata.expected_version)?)
    .bind(signed(metadata.fence_epoch)?)
    .bind(&scope.fence_token)
    .bind(&metadata.org)
    .execute(&mut **tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(StoreError::StaleFence);
    }

    let details = serde_json::to_string(&effect.details).map_err(|_| StoreError::InvalidReceipt)?;
    let activity_action = effect.activity_action.unwrap_or("project.updated");
    let activity_entity_type = effect.activity_entity_type.unwrap_or("project");
    let activity_id: String = sqlx::query_scalar(
        "INSERT INTO activity_log
          (org_id, actor_type, actor_id, action, entity_type, entity_id,
           agent_id, run_id, details, idempotency_key)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid, $8::uuid, $9::jsonb, $10)
         RETURNING id::text",
    )
    .bind(&metadata.org)
    .bind(if metadata.actor.kind == "board" {
        "user"
    } else {
        "agent"
    })
    .bind(&metadata.actor.principal_id)
    .bind(activity_action)
    .bind(activity_entity_type)
    .bind(&effect.entity_id)
    .bind(metadata.actor.agent_id.as_deref())
    .bind(metadata.run_id.as_deref())
    .bind(details)
    .bind(activity_idempotency_key(&metadata.key))
    .fetch_one(&mut **tx)
    .await?;

    let mut receipt = receipt;
    receipt.activity_id = activity_id;
    let mut receipt_value =
        serde_json::to_value(&receipt).map_err(|_| StoreError::InvalidReceipt)?;
    if let Some(response) = resource_attachment_response {
        receipt_value
            .as_object_mut()
            .ok_or(StoreError::InvalidReceipt)?
            .insert("resource_attachment_response".to_owned(), response);
    }
    ensure_json_size(&receipt_value, MAX_RESULT_BYTES)?;
    let receipt_json =
        serde_json::to_string(&receipt_value).map_err(|_| StoreError::InvalidReceipt)?;
    sqlx::query(
        "INSERT INTO organization_mutation_receipts
          (org_id, idempotency_key, command_kind, command_fingerprint,
           receipt_format, outcome, resulting_version, fence_epoch,
           activity_id, result)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::uuid, $10::jsonb)",
    )
    .bind(&metadata.org)
    .bind(&metadata.key)
    .bind(metadata.kind)
    .bind(&metadata.fingerprint)
    .bind(metadata.receipt_format)
    .bind(receipt.outcome.as_str())
    .bind(signed(receipt.version)?)
    .bind(signed(receipt.fence_epoch)?)
    .bind(&receipt.activity_id)
    .bind(receipt_json)
    .execute(&mut **tx)
    .await?;

    let actor_type = if metadata.actor.kind == "board" {
        "user"
    } else {
        "agent"
    };
    let event_payload = json!({
        "actorType": actor_type,
        "actorId": metadata.actor.principal_id,
        "action": activity_action,
        "entityType": activity_entity_type,
        "entityId": effect.entity_id,
        "agentId": metadata.actor.agent_id,
        "runId": metadata.run_id,
        "details": effect.details,
    });
    ensure_json_size(&event_payload, MAX_RESULT_BYTES)?;
    sqlx::query(
        "INSERT INTO organization_mutation_outbox
          (org_id, activity_id, event_type, payload)
         VALUES ($1::uuid, $2::uuid, 'activity.logged', $3::jsonb)",
    )
    .bind(&metadata.org)
    .bind(&receipt.activity_id)
    .bind(serde_json::to_string(&event_payload).map_err(|_| StoreError::InvalidReceipt)?)
    .execute(&mut **tx)
    .await?;

    Ok(CommittedMutation {
        replayed: false,
        receipt,
    })
}

pub(crate) async fn persist_branding(
    tx: &mut Tx<'_>,
    metadata: &Metadata,
    scope: &LockedScope,
    effect: Effect,
) -> Result<CommittedMutation, StoreError> {
    signed(effect.version)?;
    signed(effect.fence_epoch)?;
    if effect.fence_epoch < scope.fence_epoch
        || effect.fence_epoch > scope.fence_epoch.saturating_add(1)
    {
        return Err(StoreError::StaleFence);
    }
    ensure_json_size(&effect.details, MAX_RESULT_BYTES)?;
    let receipt = Receipt {
        organization_id: metadata.org.clone(),
        version: effect.version,
        fence_epoch: effect.fence_epoch,
        fingerprint: metadata.fingerprint.clone(),
        activity_id: String::new(),
        outcome: effect.outcome,
        result: effect.result,
    };
    validate_receipt_result(metadata, &receipt)?;
    let result_without_activity =
        serde_json::to_value(&receipt).map_err(|_| StoreError::InvalidReceipt)?;
    ensure_json_size(&result_without_activity, MAX_RESULT_BYTES)?;

    let updated = sqlx::query(
        "UPDATE organization_branding_mutation_state
         SET mutation_version=$2,
             fence_epoch=$3,
             fence_token=CASE WHEN $3 > $5 THEN gen_random_uuid() ELSE fence_token END,
             updated_at=now()
         WHERE org_id=$1::uuid
           AND owner='rust'
           AND mutation_version=$4
           AND fence_epoch=$5
           AND fence_token=$6::uuid",
    )
    .bind(&metadata.org)
    .bind(signed(effect.version)?)
    .bind(signed(effect.fence_epoch)?)
    .bind(signed(metadata.expected_version)?)
    .bind(signed(metadata.fence_epoch)?)
    .bind(&scope.fence_token)
    .execute(&mut **tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(StoreError::StaleFence);
    }

    let details = serde_json::to_string(&effect.details).map_err(|_| StoreError::InvalidReceipt)?;
    let actor_type = if metadata.actor.kind == "board" {
        "user"
    } else {
        "agent"
    };
    let activity_id: String = sqlx::query_scalar(
        "INSERT INTO activity_log
          (org_id, actor_type, actor_id, action, entity_type, entity_id,
           agent_id, run_id, details, idempotency_key)
         VALUES ($1::uuid, $2, $3, 'organization.branding_updated',
                 'organization', $4, $5::uuid, $6::uuid, $7::jsonb, $8)
         RETURNING id::text",
    )
    .bind(&metadata.org)
    .bind(actor_type)
    .bind(&metadata.actor.principal_id)
    .bind(&effect.entity_id)
    .bind(metadata.actor.agent_id.as_deref())
    .bind(metadata.run_id.as_deref())
    .bind(&details)
    .bind(activity_idempotency_key(&metadata.key))
    .fetch_one(&mut **tx)
    .await?;

    let mut receipt = receipt;
    receipt.activity_id = activity_id.clone();
    let receipt_json = serde_json::to_string(&receipt).map_err(|_| StoreError::InvalidReceipt)?;
    if receipt_json.len() > MAX_RESULT_BYTES {
        return Err(StoreError::InvalidInput);
    }
    sqlx::query(
        "INSERT INTO organization_branding_mutation_receipts
          (org_id, idempotency_key, command_fingerprint, receipt_format,
           outcome, resulting_version, fence_epoch, activity_id, result)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::uuid, $9::jsonb)",
    )
    .bind(&metadata.org)
    .bind(&metadata.key)
    .bind(&metadata.fingerprint)
    .bind(metadata.receipt_format)
    .bind(receipt.outcome.as_str())
    .bind(signed(receipt.version)?)
    .bind(signed(receipt.fence_epoch)?)
    .bind(&receipt.activity_id)
    .bind(&receipt_json)
    .execute(&mut **tx)
    .await?;

    let event_payload = json!({
        "actorType": actor_type,
        "actorId": metadata.actor.principal_id,
        "action": "organization.branding_updated",
        "entityType": "organization",
        "entityId": effect.entity_id,
        "agentId": metadata.actor.agent_id,
        "runId": metadata.run_id,
        "details": effect.details,
    });
    ensure_json_size(&event_payload, MAX_RESULT_BYTES)?;
    sqlx::query(
        "INSERT INTO organization_mutation_outbox
          (org_id, activity_id, event_type, payload)
         VALUES ($1::uuid, $2::uuid, 'activity.logged', $3::jsonb)",
    )
    .bind(&metadata.org)
    .bind(&activity_id)
    .bind(serde_json::to_string(&event_payload).map_err(|_| StoreError::InvalidReceipt)?)
    .execute(&mut **tx)
    .await?;

    Ok(CommittedMutation {
        replayed: false,
        receipt,
    })
}

pub(crate) async fn persist_project_delete(
    tx: &mut Tx<'_>,
    metadata: &Metadata,
    version: u64,
    fence_epoch: u64,
    response: Value,
) -> Result<CommittedMutation, StoreError> {
    signed(version)?;
    signed(fence_epoch)?;
    if version
        != metadata
            .expected_version
            .checked_add(1)
            .ok_or(StoreError::VersionRange)?
        || fence_epoch != metadata.fence_epoch
    {
        return Err(StoreError::StaleFence);
    }
    let project_id = metadata
        .project_id
        .as_deref()
        .ok_or(StoreError::InvalidInput)?;
    let mut receipt = Receipt {
        organization_id: metadata.org.clone(),
        version,
        fence_epoch,
        fingerprint: metadata.fingerprint.clone(),
        activity_id: String::new(),
        outcome: Outcome::Applied,
        result: ResultState::ProjectDeleted {
            project_id: project_id.to_owned(),
            response,
        },
    };
    validate_receipt_result(metadata, &receipt)?;
    let activity_type = if metadata.actor.kind == "board" {
        "user"
    } else {
        "agent"
    };
    let details = json!({});
    let activity_id: String = sqlx::query_scalar(
        "INSERT INTO activity_log
          (org_id, actor_type, actor_id, action, entity_type, entity_id,
           agent_id, run_id, details, idempotency_key)
         VALUES ($1::uuid, $2, $3, 'project.deleted', 'project', $4, $5::uuid,
                 $6::uuid, $7::jsonb, $8)
         RETURNING id::text",
    )
    .bind(&metadata.org)
    .bind(activity_type)
    .bind(&metadata.actor.principal_id)
    .bind(project_id)
    .bind(metadata.actor.agent_id.as_deref())
    .bind(metadata.run_id.as_deref())
    .bind(serde_json::to_string(&details).map_err(|_| StoreError::InvalidReceipt)?)
    .bind(activity_idempotency_key(&metadata.key))
    .fetch_one(&mut **tx)
    .await?;

    receipt.activity_id = activity_id;
    // Legacy deletion returns the complete stored Project, whose text fields
    // have no application byte cap. Serialize and persist before commit so a
    // serialization or PostgreSQL storage failure rolls the deletion back.
    let receipt_json = serde_json::to_string(&receipt).map_err(|_| StoreError::InvalidReceipt)?;
    sqlx::query(
        "INSERT INTO organization_mutation_receipts
          (org_id, idempotency_key, command_kind, command_fingerprint,
           receipt_format, outcome, resulting_version, fence_epoch,
           activity_id, result)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::uuid, $10::jsonb)",
    )
    .bind(&metadata.org)
    .bind(&metadata.key)
    .bind(metadata.kind)
    .bind(&metadata.fingerprint)
    .bind(metadata.receipt_format)
    .bind(receipt.outcome.as_str())
    .bind(signed(receipt.version)?)
    .bind(signed(receipt.fence_epoch)?)
    .bind(&receipt.activity_id)
    .bind(&receipt_json)
    .execute(&mut **tx)
    .await?;

    let event_payload = json!({
        "actorType": activity_type,
        "actorId": metadata.actor.principal_id,
        "action": "project.deleted",
        "entityType": "project",
        "entityId": project_id,
        "agentId": metadata.actor.agent_id,
        "runId": metadata.run_id,
        "details": details,
    });
    ensure_json_size(&event_payload, MAX_RESULT_BYTES)?;
    sqlx::query(
        "INSERT INTO organization_mutation_outbox
          (org_id, activity_id, event_type, payload)
         VALUES ($1::uuid, $2::uuid, 'activity.logged', $3::jsonb)",
    )
    .bind(&metadata.org)
    .bind(&receipt.activity_id)
    .bind(serde_json::to_string(&event_payload).map_err(|_| StoreError::InvalidReceipt)?)
    .execute(&mut **tx)
    .await?;

    Ok(CommittedMutation {
        replayed: false,
        receipt,
    })
}

fn validate_receipt_result(metadata: &Metadata, receipt: &Receipt) -> Result<(), StoreError> {
    if receipt.organization_id != metadata.org
        || !is_sha256_hex(&receipt.fingerprint)
        || receipt.fingerprint != metadata.fingerprint
    {
        return Err(StoreError::InvalidReceipt);
    }
    match (&receipt.result, metadata.kind) {
        (
            ResultState::OrganizationBranding {
                state,
                state_integrity,
            },
            kind,
        ) if *kind == *branding_kind() => {
            if state.organization_id != metadata.org
                || state.version != receipt.version
                || state.fence_epoch != receipt.fence_epoch
                || !is_sha256_hex(state_integrity)
                || branding_state_integrity(state)? != *state_integrity
            {
                return Err(StoreError::InvalidReceipt);
            }
            bounded_text(&state.organization_id, false)?;
            bounded_text(&state.name, false)?;
            if let Some(value) = &state.description {
                bounded_text(value, true)?;
            }
            if let Some(value) = &state.brand_color {
                bounded_text(value, true)?;
                if !valid_brand_color(value) {
                    return Err(StoreError::InvalidReceipt);
                }
            }
            if let Some(value) = &state.logo_asset_id {
                uuid(value)?;
            }
            let ExpectedReceipt::OrganizationBranding {
                name,
                description,
                brand_color,
                logo_asset_id,
            } = &metadata.expected_receipt
            else {
                return Err(StoreError::InvalidReceipt);
            };
            let expected_version = metadata
                .expected_version
                .checked_add(1)
                .ok_or(StoreError::InvalidReceipt)?;
            if receipt.outcome != Outcome::Applied
                || receipt.version != expected_version
                || receipt.fence_epoch != metadata.fence_epoch
                || name
                    .as_deref()
                    .is_some_and(|value| value != state.name.as_str())
                || description
                    .as_ref()
                    .is_some_and(|value| value.as_deref() != state.description.as_deref())
                || brand_color
                    .as_ref()
                    .is_some_and(|value| value.as_deref() != state.brand_color.as_deref())
                || logo_asset_id
                    .as_ref()
                    .is_some_and(|value| value.as_deref() != state.logo_asset_id.as_deref())
            {
                return Err(StoreError::InvalidReceipt);
            }
        }
        (
            ResultState::ProjectGoalLink {
                state,
                project_id,
                goal_id,
                operation: result_operation,
                link_identifier,
                core_fingerprint,
                target_version,
                target_fence_epoch,
                linked,
                cancelled,
                primary_goal_after,
                state_integrity,
                target_integrity,
                ..
            },
            kind,
        ) if *kind == *project_goal_kind() => {
            if Some(project_id) != metadata.project_id.as_ref()
                || Some(goal_id) != metadata.goal_id.as_ref()
                || !is_sha256_hex(state_integrity)
                || state.project_id != *project_id
                || state.goal_id != *goal_id
                || state.organization_id != metadata.org
                || state.project_org_id != metadata.org
                || state.goal_org_id != metadata.org
                || state.link_identifier().ok().as_deref() != Some(link_identifier.as_str())
                || state.linked != *linked
                || state.cancelled != *cancelled
                || state.state_integrity() != state_integrity
                || !is_sha256_hex(target_integrity)
                || !is_sha256_hex(core_fingerprint)
                || state.version != receipt.version
                || state.fence_epoch != receipt.fence_epoch
                || *target_version != metadata.expected_version
                || *target_fence_epoch != metadata.fence_epoch
            {
                return Err(StoreError::InvalidReceipt);
            }
            uuid(project_id)?;
            uuid(goal_id)?;
            if let Some(primary) = primary_goal_after {
                uuid(primary)?;
            }
            let ExpectedReceipt::ProjectGoalLink {
                operation,
                link_identifier: expected_link_identifier,
                core_fingerprint: expected_core_fingerprint,
                linked: target_linked,
                cancelled: target_cancelled,
                target_integrity: expected_integrity,
                primary_goal_after: expected_primary,
            } = &metadata.expected_receipt
            else {
                return Err(StoreError::InvalidReceipt);
            };
            if *target_cancelled
                || *operation != *result_operation
                || expected_link_identifier != link_identifier
                || expected_core_fingerprint != core_fingerprint
                || expected_integrity != target_integrity
                || expected_primary.as_deref() != primary_goal_after.as_deref()
            {
                return Err(StoreError::InvalidReceipt);
            }
            let transition_valid = match (*operation, receipt.outcome) {
                (Operation::Attach, Outcome::Applied) => !*target_linked && *linked && !*cancelled,
                (Operation::Attach, Outcome::Noop) => *target_linked && *linked && !*cancelled,
                (Operation::Detach, Outcome::Applied) => *target_linked && !*linked && !*cancelled,
                (Operation::Detach, Outcome::Noop) => !*target_linked && !*linked && !*cancelled,
                (Operation::Cancel, Outcome::Applied) => *target_linked == *linked && *cancelled,
                (Operation::Cancel, Outcome::Noop) => false,
            };
            let expected_version = match receipt.outcome {
                Outcome::Applied => metadata
                    .expected_version
                    .checked_add(1)
                    .ok_or(StoreError::InvalidReceipt)?,
                Outcome::Noop => metadata.expected_version,
            };
            let expected_fence = if *operation == Operation::Cancel {
                metadata
                    .fence_epoch
                    .checked_add(1)
                    .ok_or(StoreError::InvalidReceipt)?
            } else {
                metadata.fence_epoch
            };
            if !transition_valid
                || state.version != expected_version
                || state.fence_epoch != expected_fence
            {
                return Err(StoreError::InvalidReceipt);
            }
            state.validate_persisted()?;
            state.validate_persisted_receipt(
                &metadata.key,
                core_fingerprint,
                *result_operation,
                *target_version,
                *target_fence_epoch,
                receipt.version,
                receipt.fence_epoch,
                *linked,
                *cancelled,
                target_integrity,
                receipt.outcome.as_str(),
            )?;
        }
        (
            ResultState::ProjectGoalSetReplacement {
                state,
                project_id,
                goal_ids,
                primary_goal_after,
                state_integrity,
            },
            kind,
        ) if *kind == *project_goal_set_kind() => {
            if Some(project_id) != metadata.project_id.as_ref()
                || state.organization_id != metadata.org
                || state.project_id != *project_id
                || state.goal_ids != *goal_ids
                || state.primary_goal_after != *primary_goal_after
                || !is_sha256_hex(state_integrity)
                || state.state_integrity() != state_integrity
                || state.version != receipt.version
                || state.fence_epoch != receipt.fence_epoch
            {
                return Err(StoreError::InvalidReceipt);
            }
            uuid(project_id)?;
            for goal_id in goal_ids {
                uuid(goal_id)?;
            }
            if let Some(primary) = primary_goal_after {
                uuid(primary)?;
            }
            let ExpectedReceipt::ProjectGoalSetReplacement {
                project_id: expected_project_id,
                goal_ids: expected_goal_ids,
                primary_goal_after: expected_primary,
            } = &metadata.expected_receipt
            else {
                return Err(StoreError::InvalidReceipt);
            };
            let expected_version = metadata
                .expected_version
                .checked_add(1)
                .ok_or(StoreError::InvalidReceipt)?;
            if receipt.outcome != Outcome::Applied
                || receipt.version != expected_version
                || receipt.fence_epoch != metadata.fence_epoch
                || expected_project_id != project_id
                || expected_goal_ids != goal_ids
                || expected_primary.as_deref() != primary_goal_after.as_deref()
            {
                return Err(StoreError::InvalidReceipt);
            }
            state.validate_persisted()?;
        }
        (
            ResultState::ProjectPatch {
                project_id,
                patch_fingerprint,
                goal_ids,
                primary_goal_after,
                state_integrity,
            },
            kind,
        ) if *kind == *project_goal_set_kind() => {
            if Some(project_id) != metadata.project_id.as_ref()
                || !is_sha256_hex(patch_fingerprint)
                || !is_sha256_hex(state_integrity)
                || project_patch_state_integrity(
                    project_id,
                    patch_fingerprint,
                    goal_ids,
                    primary_goal_after.as_deref(),
                )? != *state_integrity
            {
                return Err(StoreError::InvalidReceipt);
            }
            uuid(project_id)?;
            if let Some(primary) = primary_goal_after {
                uuid(primary)?;
                if !goal_ids.iter().any(|goal_id| goal_id == primary) {
                    return Err(StoreError::InvalidReceipt);
                }
            }
            for goal_id in goal_ids {
                uuid(goal_id)?;
            }
            let ExpectedReceipt::ProjectPatch {
                project_id: expected_project_id,
                patch_fingerprint: expected_patch_fingerprint,
                goal_ids: expected_goal_ids,
                primary_goal_after: expected_primary_goal_after,
                ..
            } = &metadata.expected_receipt
            else {
                return Err(StoreError::InvalidReceipt);
            };
            let expected_version = metadata
                .expected_version
                .checked_add(1)
                .ok_or(StoreError::InvalidReceipt)?;
            if receipt.outcome != Outcome::Applied
                || receipt.version != expected_version
                || receipt.fence_epoch != metadata.fence_epoch
                || expected_project_id != project_id
                || expected_patch_fingerprint != patch_fingerprint
                || expected_goal_ids
                    .as_ref()
                    .is_some_and(|expected| expected != goal_ids)
                || expected_primary_goal_after
                    .as_ref()
                    .is_some_and(|expected| expected.as_deref() != primary_goal_after.as_deref())
            {
                return Err(StoreError::InvalidReceipt);
            }
        }
        (
            ResultState::ProjectDeleted {
                project_id,
                response,
            },
            kind,
        ) if *kind == *project_delete_kind() => {
            let ExpectedReceipt::ProjectDelete {
                project_id: expected_project_id,
            } = &metadata.expected_receipt
            else {
                return Err(StoreError::InvalidReceipt);
            };
            let response = response.as_object().ok_or(StoreError::InvalidReceipt)?;
            let response_id = response
                .get("id")
                .and_then(Value::as_str)
                .ok_or(StoreError::InvalidReceipt)?;
            let response_org = response
                .get("orgId")
                .and_then(Value::as_str)
                .ok_or(StoreError::InvalidReceipt)?;
            if Some(project_id) != metadata.project_id.as_ref()
                || expected_project_id != project_id
                || uuid(project_id)? != project_id
                || response_id != project_id
                || response_org != metadata.org
                || response.get("icon").and_then(Value::as_str).is_none()
                || response
                    .get("urlKey")
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty)
                || receipt.outcome != Outcome::Applied
                || receipt.version
                    != metadata
                        .expected_version
                        .checked_add(1)
                        .ok_or(StoreError::InvalidReceipt)?
                || receipt.fence_epoch != metadata.fence_epoch
            {
                return Err(StoreError::InvalidReceipt);
            }
        }
        _ => return Err(StoreError::InvalidReceipt),
    }
    Ok(())
}

fn validate_project_resource_attachment_response(
    metadata: &Metadata,
    response: Option<&Value>,
) -> Result<(), StoreError> {
    let expected_operation = match &metadata.expected_receipt {
        ExpectedReceipt::ProjectPatch {
            resource_attachment_operation,
            ..
        } => resource_attachment_operation.as_ref(),
        _ => None,
    };
    match (expected_operation, response) {
        (None, None) => return Ok(()),
        (Some(_), None) | (None, Some(_)) => return Err(StoreError::InvalidReceipt),
        (Some(operation), Some(response)) => {
            let response = response.as_object().ok_or(StoreError::InvalidReceipt)?;
            if response.len() != 2 {
                return Err(StoreError::InvalidReceipt);
            }
            let status = response
                .get("status")
                .and_then(Value::as_u64)
                .ok_or(StoreError::InvalidReceipt)?;
            let expected_status = match operation {
                ProjectResourceAttachmentOperationIdentity::Attach { .. } => 201,
                ProjectResourceAttachmentOperationIdentity::Update { .. }
                | ProjectResourceAttachmentOperationIdentity::Remove { .. } => 200,
            };
            if status != expected_status {
                return Err(StoreError::InvalidReceipt);
            }
            let body = response
                .get("body")
                .and_then(Value::as_object)
                .ok_or(StoreError::InvalidReceipt)?;
            let body_id = body
                .get("id")
                .and_then(Value::as_str)
                .ok_or(StoreError::InvalidReceipt)?;
            let organization_id = body
                .get("orgId")
                .and_then(Value::as_str)
                .ok_or(StoreError::InvalidReceipt)?;
            let project_id = body
                .get("projectId")
                .and_then(Value::as_str)
                .ok_or(StoreError::InvalidReceipt)?;
            let resource_id = body
                .get("resourceId")
                .and_then(Value::as_str)
                .ok_or(StoreError::InvalidReceipt)?;
            let role = body
                .get("role")
                .and_then(Value::as_str)
                .ok_or(StoreError::InvalidReceipt)?;
            let sort_order = body
                .get("sortOrder")
                .and_then(Value::as_i64)
                .ok_or(StoreError::InvalidReceipt)?;
            let is_primary = body.get("isPrimary").and_then(Value::as_bool);
            for key in ["createdAt", "updatedAt"] {
                if body.get(key).and_then(Value::as_str).is_none() {
                    return Err(StoreError::InvalidReceipt);
                }
            }
            if !body
                .get("note")
                .is_some_and(|value| value.is_null() || value.is_string())
            {
                return Err(StoreError::InvalidReceipt);
            }
            uuid(body_id)?;
            uuid(organization_id)?;
            uuid(project_id)?;
            uuid(resource_id)?;
            if organization_id != metadata.org
                || metadata.project_id.as_deref() != Some(project_id)
                || role.is_empty()
                || sort_order < 0
                || is_primary.is_none()
            {
                return Err(StoreError::InvalidReceipt);
            }
            match operation {
                ProjectResourceAttachmentOperationIdentity::Attach {
                    resource_id: expected_resource_id,
                } if resource_id != expected_resource_id => {
                    return Err(StoreError::InvalidReceipt);
                }
                ProjectResourceAttachmentOperationIdentity::Update { attachment_id }
                | ProjectResourceAttachmentOperationIdentity::Remove { attachment_id }
                    if body_id != attachment_id =>
                {
                    return Err(StoreError::InvalidReceipt);
                }
                _ => {}
            }
            let resource = body
                .get("resource")
                .and_then(Value::as_object)
                .ok_or(StoreError::InvalidReceipt)?;
            if resource.get("id").and_then(Value::as_str) != Some(resource_id)
                || resource.get("orgId").and_then(Value::as_str) != Some(metadata.org.as_str())
                || [
                    "name",
                    "kind",
                    "sourceType",
                    "locator",
                    "createdAt",
                    "updatedAt",
                ]
                .iter()
                .any(|key| resource.get(*key).and_then(Value::as_str).is_none())
                || !resource
                    .get("description")
                    .is_some_and(|value| value.is_null() || value.is_string())
                || !resource
                    .get("metadata")
                    .is_some_and(|value| value.is_null() || value.is_object())
            {
                return Err(StoreError::InvalidReceipt);
            }
        }
    }
    Ok(())
}

fn actor_metadata(kind: &'static str, principal_id: &str) -> Result<ActorMetadata, StoreError> {
    let principal_id = bounded_text(principal_id, false)?;
    let agent_id = match kind {
        "board" => None,
        "ceo_agent" | "agent" => Some(uuid(&principal_id)?.to_owned()),
        _ => return Err(StoreError::Unauthorized),
    };
    Ok(ActorMetadata {
        kind,
        principal_id,
        agent_id,
    })
}

pub(crate) fn adapter_fingerprint(
    kind: &str,
    core_fingerprint: &str,
    primary_goal_after: Option<&str>,
) -> Result<String, StoreError> {
    if !is_sha256_hex(core_fingerprint) {
        return Err(StoreError::InvalidInput);
    }
    let identity = json!({
        "adapter_format": 1,
        "kind": kind,
        "core_fingerprint": core_fingerprint,
        "primary_goal_after": primary_goal_after,
    });
    ensure_json_size(&identity, MAX_COMMAND_BYTES)?;
    Ok(hex_digest(Sha256::digest(
        serde_json::to_vec(&identity).map_err(|_| StoreError::InvalidInput)?,
    )))
}

pub(crate) fn branding_state_integrity(
    state: &OrganizationSettingsSnapshot,
) -> Result<String, StoreError> {
    let value = json!({
        "schema": "rudder.d1.organization-branding-state.v1",
        "state": state,
    });
    ensure_json_size(&value, MAX_RESULT_BYTES)?;
    Ok(hex_digest(Sha256::digest(
        serde_json::to_vec(&value).map_err(|_| StoreError::InvalidReceipt)?,
    )))
}

pub(crate) fn project_patch_state_integrity(
    project_id: &str,
    patch_fingerprint: &str,
    goal_ids: &[String],
    primary_goal_after: Option<&str>,
) -> Result<String, StoreError> {
    let value = json!({
        "schema": "rudder.d1.project-patch-state.v1",
        "project_id": project_id,
        "patch_fingerprint": patch_fingerprint,
        "goal_ids": goal_ids,
        "primary_goal_after": primary_goal_after,
    });
    ensure_json_size(&value, MAX_RESULT_BYTES)?;
    Ok(hex_digest(Sha256::digest(
        serde_json::to_vec(&value).map_err(|_| StoreError::InvalidReceipt)?,
    )))
}

fn activity_idempotency_key(key: &str) -> String {
    format!("rust-d1:{}", hex_digest(Sha256::digest(key.as_bytes())))
}

pub(crate) fn uuid(value: &str) -> Result<&str, StoreError> {
    if value.len() != 36
        || !value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
    {
        return Err(StoreError::InvalidInput);
    }
    Ok(value)
}

pub(crate) fn signed(value: u64) -> Result<i64, StoreError> {
    i64::try_from(value).map_err(|_| StoreError::VersionRange)
}

pub(crate) fn unsigned(value: i64) -> Result<u64, StoreError> {
    u64::try_from(value).map_err(|_| StoreError::InvalidReceipt)
}

fn bounded_text(value: &str, allow_empty: bool) -> Result<String, StoreError> {
    if (!allow_empty && value.is_empty())
        || value.len() > MAX_TEXT_BYTES
        || value
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_control())
    {
        return Err(StoreError::InvalidInput);
    }
    Ok(value.to_owned())
}

fn ensure_json_size(value: &Value, max_bytes: usize) -> Result<(), StoreError> {
    let encoded = serde_json::to_vec(value).map_err(|_| StoreError::InvalidInput)?;
    if encoded.len() > max_bytes {
        return Err(StoreError::InvalidInput);
    }
    Ok(())
}

pub(crate) fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_brand_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_hexdigit)
}

fn hex_digest(digest: impl IntoIterator<Item = u8>) -> String {
    digest
        .into_iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod project_delete_tests {
    use super::*;

    fn command() -> ProjectDeleteCommand {
        ProjectDeleteCommand {
            organization_id: "10000000-0000-4000-8000-000000000001".to_owned(),
            project_id: "20000000-0000-4000-8000-000000000001".to_owned(),
            actor_kind: "board".to_owned(),
            actor_id: "board-user".to_owned(),
            run_id: None,
            idempotency_key: "project-delete-test".to_owned(),
            expected_version: 4,
            fence_epoch: 7,
        }
    }

    #[test]
    fn project_delete_fingerprint_binds_org_project_actor_run_and_key() {
        let base = Metadata::project_delete(&command()).unwrap().fingerprint;
        let mut changed = command();
        changed.organization_id = "10000000-0000-4000-8000-000000000002".to_owned();
        assert_ne!(
            base,
            Metadata::project_delete(&changed).unwrap().fingerprint
        );

        let mut changed = command();
        changed.project_id = "20000000-0000-4000-8000-000000000002".to_owned();
        assert_ne!(
            base,
            Metadata::project_delete(&changed).unwrap().fingerprint
        );

        let mut changed = command();
        changed.actor_id = "another-board-user".to_owned();
        assert_ne!(
            base,
            Metadata::project_delete(&changed).unwrap().fingerprint
        );

        let mut changed = command();
        changed.actor_kind = "agent".to_owned();
        changed.actor_id = "50000000-0000-4000-8000-000000000001".to_owned();
        assert_ne!(
            base,
            Metadata::project_delete(&changed).unwrap().fingerprint
        );

        let mut changed = command();
        changed.run_id = Some("60000000-0000-4000-8000-000000000001".to_owned());
        assert_ne!(
            base,
            Metadata::project_delete(&changed).unwrap().fingerprint
        );

        let mut changed = command();
        changed.idempotency_key = "another-key".to_owned();
        assert_ne!(
            base,
            Metadata::project_delete(&changed).unwrap().fingerprint
        );
    }

    #[test]
    fn project_delete_fingerprint_does_not_depend_on_preflight_fence_snapshot() {
        let base = Metadata::project_delete(&command()).unwrap().fingerprint;
        let mut changed = command();
        changed.expected_version = 40;
        changed.fence_epoch = 70;
        assert_eq!(
            base,
            Metadata::project_delete(&changed).unwrap().fingerprint
        );
    }
}
