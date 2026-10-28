//! Public Organization writes. This module owns the organization-row
//! transaction and its database effects; the listener supplies only verified
//! identity and the existing native workspace provisioner.

use crate::{StoreError, activity, organization_reads, transaction};
use rudder_organization_mutation_core::{Actor, OrganizationBrandingPatch};
use serde_json::{Map, Value, json};
use sqlx::{PgConnection, PgPool, Postgres, Row, Transaction};
use std::{future::Future, pin::Pin};
use uuid::Uuid;

pub struct OrganizationCreateActor {
    pub user_id: String,
}

pub trait OrganizationCreateAuthorizer: Send + Sync {
    fn authorize<'a>(
        &'a self,
        connection: &'a mut PgConnection,
    ) -> Pin<Box<dyn Future<Output = Result<OrganizationCreateActor, StoreError>> + Send + 'a>>;
}

pub trait OrganizationWorkspaceProvisioner: Send + Sync {
    fn ensure<'a>(
        &'a self,
        organization_id: &'a str,
        organization_name: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<(), StoreError>> + Send + 'a>>;

    fn remove<'a>(
        &'a self,
        organization_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<(), StoreError>> + Send + 'a>>;
}

pub struct OrganizationPatchCommand<'a> {
    pub organization_id: &'a str,
    pub body: &'a Value,
    pub branding_route: bool,
    pub actor_kind: &'a str,
    pub actor_id: &'a str,
    pub agent_id: Option<&'a str>,
    pub run_id: Option<&'a str>,
    pub idempotency_key: Option<&'a str>,
    pub authorizer: &'a dyn crate::agent_core::NativeAgentAuthorizer,
}

#[derive(Clone, Debug, Default)]
struct CreateInput {
    name: String,
    issue_prefix: Option<String>,
    description: Option<String>,
    budget_monthly_cents: i32,
    default_chat_issue_creation_mode: String,
    brand_color: Option<String>,
    require_board_approval_for_new_agents: Option<bool>,
}

#[derive(Clone, Debug, Default)]
struct PatchInput {
    normalized: Map<String, Value>,
    name: Option<String>,
    description: Option<Option<String>>,
    issue_prefix: Option<String>,
    budget_monthly_cents: Option<i32>,
    spent_monthly_cents: Option<i32>,
    status: Option<String>,
    default_chat_issue_creation_mode: Option<String>,
    require_board_approval_for_new_agents: Option<bool>,
    brand_color: Option<Option<String>>,
    logo_asset_id: Option<Option<String>>,
}

pub async fn create_public(
    pool: &PgPool,
    body: &Value,
    authorizer: &dyn OrganizationCreateAuthorizer,
    provisioner: &dyn OrganizationWorkspaceProvisioner,
) -> Result<Value, StoreError> {
    let input = parse_create(body)?;
    let mut tx = pool.begin().await?;
    let mut workspace_organization_id = None;
    let operation = async {
        let actor = authorizer.authorize(&mut tx).await?;
        let (organization_id, _url_key) = create_row(&mut tx, &input).await?;
        // Provision while the organization row is still in this transaction.
        // A later database failure rolls back the row and is compensated below
        // only after an independent query confirms that rollback completed.
        workspace_organization_id = Some(organization_id.clone());
        provisioner.ensure(&organization_id, &input.name).await?;

        sqlx::query(
            "INSERT INTO organization_mutation_state (org_id, owner)
         VALUES ($1::uuid, 'node') ON CONFLICT (org_id) DO NOTHING",
        )
        .bind(&organization_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO organization_branding_mutation_state
           (org_id, owner, fence_epoch, fence_token)
         VALUES ($1::uuid, 'rust', 1, gen_random_uuid())
         ON CONFLICT (org_id) DO NOTHING",
        )
        .bind(&organization_id)
        .execute(&mut *tx)
        .await?;
        // The organizations trigger creates a Node-owned branding state row.
        // Creation is the authority boundary for this newly Rust-owned public
        // route, so advance its fence before any subsequent branding write.
        sqlx::query(
            "UPDATE organization_branding_mutation_state
         SET owner='rust', fence_epoch=fence_epoch+1,
             fence_token=gen_random_uuid(), updated_at=now()
         WHERE org_id=$1::uuid AND owner='node'",
        )
        .bind(&organization_id)
        .execute(&mut *tx)
        .await?;

        for (name, color) in [
            ("Bug", "#ef4444"),
            ("Feature", "#a855f7"),
            ("UI", "#06b6d4"),
        ] {
            sqlx::query("INSERT INTO labels (org_id, name, color) VALUES ($1::uuid, $2, $3)")
                .bind(&organization_id)
                .bind(name)
                .bind(color)
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query(
            "INSERT INTO organization_memberships
           (org_id, principal_type, principal_id, status, membership_role)
         VALUES ($1::uuid, 'user', $2, 'active', 'owner')
         ON CONFLICT (org_id, principal_type, principal_id)
         DO UPDATE SET status='active', membership_role='owner', updated_at=now()",
        )
        .bind(&organization_id)
        .bind(&actor.user_id)
        .execute(&mut *tx)
        .await?;

        write_organization_created_analytics(&mut tx, &organization_id).await?;
        if input.budget_monthly_cents > 0 {
            create_budget_policy(
                &mut tx,
                &organization_id,
                input.budget_monthly_cents,
                &actor.user_id,
            )
            .await?;
        }
        activity::write_activity(
            &mut tx,
            &organization_id,
            &activity::ActivityActor {
                actor_type: "user",
                actor_id: actor.user_id,
                run_id: None,
            },
            "organization.created",
            "organization",
            &organization_id,
            Some(&json!({"name":input.name})),
        )
        .await?;
        let response = organization_reads::read_organization(
            &mut tx,
            &organization_id,
            time::OffsetDateTime::now_utc(),
        )
        .await?
        .ok_or(StoreError::NotFound)?;
        Ok(response)
    }
    .await;

    match operation {
        Ok(response) => {
            // A failed commit has an ambiguous result. Preserve the workspace
            // so it cannot be removed from an organization that actually made
            // it to disk.
            tx.commit().await?;
            Ok(response)
        }
        Err(error) => {
            let rollback_succeeded = tx.rollback().await.is_ok();
            if let Some(organization_id) = workspace_organization_id {
                if !rollback_succeeded {
                    tracing::warn!(%organization_id, "create rollback failed; preserving organization workspace");
                } else {
                    match sqlx::query_scalar::<_, bool>(
                        "SELECT EXISTS(SELECT 1 FROM organizations WHERE id=$1::uuid)",
                    )
                    .bind(&organization_id)
                    .fetch_one(pool)
                    .await
                    {
                        Ok(false) => {
                            if let Err(cleanup_error) = provisioner.remove(&organization_id).await {
                                tracing::warn!(%organization_id, ?cleanup_error, "organization workspace cleanup failed after create rollback");
                            }
                        }
                        Ok(true) => {
                            tracing::warn!(%organization_id, "organization row remains after failed create rollback; preserving workspace")
                        }
                        Err(check_error) => {
                            tracing::warn!(%organization_id, ?check_error, "could not confirm create rollback; preserving workspace")
                        }
                    }
                }
            }
            Err(error)
        }
    }
}

pub async fn patch_public(
    pool: &PgPool,
    command: OrganizationPatchCommand<'_>,
) -> Result<Value, StoreError> {
    let mut tx = pool.begin().await?;
    let response = patch_in_transaction(&mut tx, command).await?;
    tx.commit().await?;
    Ok(response)
}

/// Compose an approved Chat organization change with its locked Approval.
/// Public and Approval callers share parsing, authorization, fence adoption,
/// branding receipts, projection and activity in this existing writer.
pub(crate) async fn patch_in_transaction(
    tx: &mut Transaction<'_, Postgres>,
    command: OrganizationPatchCommand<'_>,
) -> Result<Value, StoreError> {
    let OrganizationPatchCommand {
        organization_id,
        body,
        branding_route,
        actor_kind,
        actor_id,
        agent_id,
        run_id,
        idempotency_key,
        authorizer,
    } = command;
    let patch = parse_patch(body, actor_kind == "agent" || branding_route)?;
    let organization_id = transaction::uuid(organization_id)?.to_ascii_lowercase();
    let actor_kind = match actor_kind {
        "board" => "user",
        "agent" => "agent",
        _ => return Err(StoreError::Unauthorized),
    };
    let actor_id = transaction::bounded_text(actor_id, false)?;
    let details = Value::Object(patch.normalized.clone());
    let action = if branding_route {
        "organization.branding_updated"
    } else {
        "organization.updated"
    };
    let keyed_branding = branding_route
        && idempotency_key.is_some()
        && patch.name.is_none()
        && patch.description.is_none()
        && (patch.brand_color.is_some() || patch.logo_asset_id.is_some());
    let idempotency_key = if keyed_branding {
        idempotency_key
            .map(|key| transaction::bounded_text(key, false))
            .transpose()?
    } else {
        // The ordinary organization PATCH historically ignores this header.
        None
    };
    revalidate_public_identity(tx, &organization_id, authorizer).await?;
    // Branding writers take the component lock before the organization row.
    // Keep this order when a complete organization update includes branding.
    if patch.brand_color.is_some() || patch.logo_asset_id.is_some() {
        sqlx::query(
            "SELECT org_id FROM organization_branding_mutation_state
             WHERE org_id=$1::uuid FOR UPDATE",
        )
        .bind(&organization_id)
        .fetch_optional(&mut **tx)
        .await?;
    }
    lock_organization(tx, &organization_id).await?;
    revalidate_public_identity(tx, &organization_id, authorizer).await?;
    if actor_kind == "agent" {
        let role = sqlx::query_scalar::<_, String>(
            "SELECT role FROM agents WHERE id=$1::uuid AND org_id=$2::uuid
             AND status NOT IN ('terminated','pending_approval') FOR UPDATE",
        )
        .bind(agent_id.unwrap_or(&actor_id))
        .bind(&organization_id)
        .fetch_optional(&mut **tx)
        .await?;
        if role.as_deref() != Some("ceo") {
            return Err(StoreError::Unauthorized);
        }
    }

    if patch.brand_color.is_some() || patch.logo_asset_id.is_some() {
        adopt_branding_authority(tx, &organization_id).await?;
    }

    if keyed_branding {
        let key = idempotency_key.as_deref().ok_or(StoreError::InvalidInput)?;
        // Match organization_branding_scope_for_idempotency while staying on
        // this already-authorized write connection: a replay binds the
        // receipt's predecessor version/fence; a new key binds current scope.
        let scope = sqlx::query(
            "SELECT state.owner, state.mutation_version, state.fence_epoch,
                    receipt.resulting_version, receipt.fence_epoch AS receipt_fence_epoch
             FROM organization_branding_mutation_state state
             LEFT JOIN organization_branding_mutation_receipts receipt
               ON receipt.org_id=state.org_id AND receipt.idempotency_key=$2
             WHERE state.org_id=$1::uuid",
        )
        .bind(&organization_id)
        .bind(key)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(StoreError::NotOwned)?;
        if scope.try_get::<String, _>("owner")? != "rust" {
            return Err(StoreError::NotOwned);
        }
        let expected_version = match scope.try_get::<Option<i64>, _>("resulting_version")? {
            Some(version) => transaction::unsigned(version)?
                .checked_sub(1)
                .ok_or(StoreError::InvalidReceipt)?,
            None => transaction::unsigned(scope.try_get("mutation_version")?)?,
        };
        let expected_fence_epoch = match scope.try_get::<Option<i64>, _>("receipt_fence_epoch")? {
            Some(epoch) => transaction::unsigned(epoch)?,
            None => transaction::unsigned(scope.try_get("fence_epoch")?)?,
        };
        let actor = if actor_kind == "agent" {
            Actor::CeoAgent {
                organization_id: organization_id.clone(),
                principal_id: agent_id.unwrap_or(&actor_id).to_owned(),
            }
        } else {
            Actor::Board {
                organization_id: organization_id.clone(),
                principal_id: actor_id.clone(),
            }
        };
        let input = OrganizationBrandingPatch {
            name: patch.name.clone(),
            description: patch.description.clone(),
            brand_color: patch.brand_color.clone(),
            logo_asset_id: patch.logo_asset_id.clone(),
        };
        let command = input.into_command(
            organization_id.clone(),
            actor,
            key.to_owned(),
            expected_version,
            expected_fence_epoch,
        )?;
        let metadata = transaction::Metadata::branding(
            &command,
            crate::OrganizationBrandingActivityAction::OrganizationBrandingUpdated,
        )?;
        // The keyed pilot contract revalidates current identity in this write
        // transaction before the store checks replay or changes state.
        revalidate_public_identity(tx, &organization_id, authorizer).await?;
        let _committed = crate::branding::apply(tx, command, &metadata).await?;
        return organization_reads::read_organization(
            tx,
            &organization_id,
            time::OffsetDateTime::now_utc(),
        )
        .await?
        .ok_or(StoreError::NotFound);
    }

    apply_patch(tx, &organization_id, &patch).await?;
    let response = organization_reads::read_organization(
        tx,
        &organization_id,
        time::OffsetDateTime::now_utc(),
    )
    .await?
    .ok_or(StoreError::NotFound)?;
    let audit_actor = activity::ActivityActor {
        actor_type: actor_kind,
        actor_id: actor_id.clone(),
        run_id: run_id.map(str::to_owned),
    };
    activity::write_activity_options(
        tx,
        activity::ActivityWrite {
            org: &organization_id,
            audit: &audit_actor,
            action,
            entity_type: "organization",
            entity_id: &organization_id,
            details: Some(&details),
            options: activity::ActivityOptions {
                agent_id,
                bind_run: actor_kind == "agent",
                ..Default::default()
            },
        },
    )
    .await?;
    Ok(response)
}

pub async fn archive_public(
    pool: &PgPool,
    organization_id: &str,
    actor_id: &str,
    authorizer: &dyn crate::agent_core::NativeAgentAuthorizer,
) -> Result<Option<Value>, StoreError> {
    let organization_id = transaction::uuid(organization_id)?.to_ascii_lowercase();
    let mut tx = pool.begin().await?;
    revalidate_public_identity(&mut tx, &organization_id, authorizer).await?;
    lock_organization(&mut tx, &organization_id).await?;
    revalidate_public_identity(&mut tx, &organization_id, authorizer).await?;
    sqlx::query("UPDATE organizations SET status='archived', updated_at=now() WHERE id=$1::uuid")
        .bind(&organization_id)
        .execute(&mut *tx)
        .await?;
    activity::write_activity(
        &mut tx,
        &organization_id,
        &activity::ActivityActor {
            actor_type: "user",
            actor_id: actor_id.to_owned(),
            run_id: None,
        },
        "organization.archived",
        "organization",
        &organization_id,
        None,
    )
    .await?;
    let response = organization_reads::read_organization(
        &mut tx,
        &organization_id,
        time::OffsetDateTime::now_utc(),
    )
    .await?;
    tx.commit().await?;
    Ok(response)
}

pub async fn delete_public(
    pool: &PgPool,
    organization_id: &str,
    authorizer: &dyn crate::agent_core::NativeAgentAuthorizer,
) -> Result<bool, StoreError> {
    let organization_id = transaction::uuid(organization_id)?.to_ascii_lowercase();
    let mut tx = pool.begin().await?;
    revalidate_public_identity(&mut tx, &organization_id, authorizer).await?;
    lock_organization(&mut tx, &organization_id).await?;
    revalidate_public_identity(&mut tx, &organization_id, authorizer).await?;
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM organizations WHERE id=$1::uuid)",
    )
    .bind(&organization_id)
    .fetch_one(&mut *tx)
    .await?;
    if !exists {
        return Ok(false);
    }
    sqlx::query(
        "SELECT org_id FROM organization_branding_mutation_state WHERE org_id=$1::uuid FOR UPDATE",
    )
    .bind(&organization_id)
    .fetch_optional(&mut *tx)
    .await?;
    sqlx::query("SELECT project_id FROM project_goal_mutation_state WHERE org_id=$1::uuid ORDER BY project_id FOR UPDATE")
        .bind(&organization_id).fetch_all(&mut *tx).await?;
    for table in DELETE_BEFORE_ACTIVITY {
        sqlx::query(&format!("DELETE FROM {table} WHERE org_id=$1::uuid"))
            .bind(&organization_id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("DELETE FROM activity_log WHERE org_id=$1::uuid")
        .bind(&organization_id)
        .execute(&mut *tx)
        .await?;
    for table in DELETE_AFTER_ACTIVITY {
        sqlx::query(&format!("DELETE FROM {table} WHERE org_id=$1::uuid"))
            .bind(&organization_id)
            .execute(&mut *tx)
            .await?;
    }
    let deleted = sqlx::query("DELETE FROM organizations WHERE id=$1::uuid")
        .bind(&organization_id)
        .execute(&mut *tx)
        .await?
        .rows_affected()
        > 0;
    tx.commit().await?;
    Ok(deleted)
}

const DELETE_BEFORE_ACTIVITY: &[&str] = &[
    "issue_block_audit_attempts",
    "requests",
    "heartbeat_run_events",
    "runtime_source_aliases",
    "runtime_retention_claims",
    "organization_mutation_outbox",
];

const DELETE_AFTER_ACTIVITY: &[&str] = &[
    // These tables use NO ACTION organization foreign keys. Delete events
    // before their source rows, and creation requests before their agents.
    "agent_issue_creation_requests",
    "calendar_events",
    "calendar_sources",
    "workspace_operations",
    "workspace_runtime_services",
    "execution_workspaces",
    "project_workspaces",
    "agent_task_sessions",
    "heartbeat_runs",
    "agent_wakeup_requests",
    "agent_config_revisions",
    "agent_api_keys",
    "agent_runtime_state",
    "issue_approvals",
    "issue_attachments",
    "issue_documents",
    "issue_comments",
    "issue_read_states",
    "issue_work_products",
    "cost_events",
    "cost_monthly_spend_rollups",
    "finance_events",
    "document_revisions",
    "documents",
    "approval_comments",
    "approvals",
    "chat_attachments",
    "chat_messages",
    "chat_context_links",
    "chat_conversations",
    "organization_secrets",
    "organization_skills",
    "join_requests",
    "invites",
    "budget_incidents",
    "budget_policies",
    "principal_permission_grants",
    "organization_memberships",
    "issues",
    "organization_logos",
    "organization_issue_prefix_aliases",
    "assets",
    "project_goals",
    "projects",
    "goals",
    "agents",
];

async fn lock_organization(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
) -> Result<(), StoreError> {
    let row = sqlx::query(
        "SELECT org_id FROM organization_mutation_state WHERE org_id=$1::uuid FOR UPDATE",
    )
    .bind(org)
    .fetch_optional(&mut **tx)
    .await?;
    if row.is_none() {
        let exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM organizations WHERE id=$1::uuid)",
        )
        .bind(org)
        .fetch_one(&mut **tx)
        .await?;
        return Err(if exists {
            StoreError::NotOwned
        } else {
            StoreError::NotFound
        });
    }
    if sqlx::query("SELECT id FROM organizations WHERE id=$1::uuid FOR UPDATE")
        .bind(org)
        .fetch_optional(&mut **tx)
        .await?
        .is_none()
    {
        return Err(StoreError::NotFound);
    }
    Ok(())
}

async fn revalidate_public_identity(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    authorizer: &dyn crate::agent_core::NativeAgentAuthorizer,
) -> Result<(), StoreError> {
    match authorizer.revalidate(tx, org).await? {
        crate::agent_core::NativeAgentAccess::Authorized => Ok(()),
        crate::agent_core::NativeAgentAccess::Unauthorized => {
            Err(StoreError::PublicIdentityUnauthorized)
        }
        crate::agent_core::NativeAgentAccess::Forbidden => Err(StoreError::PublicIdentityForbidden),
    }
}

async fn create_row(
    tx: &mut Transaction<'_, Postgres>,
    input: &CreateInput,
) -> Result<(String, String), StoreError> {
    let issue_base = input
        .issue_prefix
        .clone()
        .unwrap_or_else(|| derive_issue_key(&input.name));
    let url_base = derive_url_key(&input.name);
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('rudder:organization-issue-prefix'))")
        .execute(&mut **tx)
        .await?;
    let mut issue_attempt = 1;
    let mut url_attempt = 1;
    while issue_attempt < 10_000 && url_attempt < 10_000 {
        let prefix = if issue_attempt == 1 {
            issue_base.clone()
        } else {
            format!("{issue_base}{issue_attempt}")
        };
        let url_key = if url_attempt == 1 {
            url_base.clone()
        } else {
            format!("{url_base}-{url_attempt}")
        };
        if route_key_owned(tx, &prefix, None).await? {
            if input.issue_prefix.is_some() {
                return Err(StoreError::OrganizationConflict(format!(
                    "Issue key \"{prefix}\" is already in use. Choose another key."
                )));
            }
            issue_attempt += 1;
            continue;
        }
        if route_key_owned(tx, &url_key, None).await? {
            url_attempt += 1;
            continue;
        }

        // The precheck is serialized by the shared advisory lock. Savepoints
        // still let a concurrent unique-index winner advance only the
        // colliding key without leaving this transaction aborted.
        sqlx::query("SAVEPOINT organization_create_key_attempt")
            .execute(&mut **tx)
            .await?;
        let row = sqlx::query(
            "INSERT INTO organizations
               (url_key,name,description,issue_prefix,budget_monthly_cents,
                default_chat_issue_creation_mode,brand_color,require_board_approval_for_new_agents)
             VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,true))
             RETURNING id::text",
        )
        .bind(&url_key)
        .bind(&input.name)
        .bind(&input.description)
        .bind(&prefix)
        .bind(input.budget_monthly_cents)
        .bind(&input.default_chat_issue_creation_mode)
        .bind(&input.brand_color)
        .bind(input.require_board_approval_for_new_agents)
        .fetch_one(&mut **tx)
        .await;
        match row {
            Ok(row) => {
                sqlx::query("RELEASE SAVEPOINT organization_create_key_attempt")
                    .execute(&mut **tx)
                    .await?;
                return Ok((row.try_get("id")?, url_key));
            }
            Err(sqlx::Error::Database(error)) if error.code().as_deref() == Some("23505") => {
                let constraint = error.constraint().unwrap_or_default().to_owned();
                sqlx::query("ROLLBACK TO SAVEPOINT organization_create_key_attempt")
                    .execute(&mut **tx)
                    .await?;
                sqlx::query("RELEASE SAVEPOINT organization_create_key_attempt")
                    .execute(&mut **tx)
                    .await?;
                if constraint == "organizations_issue_prefix_idx" {
                    if input.issue_prefix.is_some() {
                        return Err(StoreError::OrganizationConflict(format!(
                            "Issue key \"{prefix}\" is already in use. Choose another key."
                        )));
                    }
                    issue_attempt += 1;
                } else if constraint == "organizations_url_key_idx" {
                    url_attempt += 1;
                } else {
                    return Err(StoreError::Database(sqlx::Error::Database(error)));
                }
            }
            Err(error) => return Err(error.into()),
        }
    }
    Err(StoreError::OrganizationConflict(
        "Unable to allocate unique organization keys".to_owned(),
    ))
}

async fn route_key_owned(
    tx: &mut Transaction<'_, Postgres>,
    route_key: &str,
    excluded_org: Option<&str>,
) -> Result<bool, StoreError> {
    Ok(sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
           SELECT 1 FROM organizations
           WHERE (lower(url_key)=lower($1) OR lower(issue_prefix)=lower($1))
             AND ($2::uuid IS NULL OR id<>$2::uuid)
         ) OR EXISTS(
           SELECT 1 FROM organization_issue_prefix_aliases
           WHERE lower(prefix)=lower($1) AND ($2::uuid IS NULL OR org_id<>$2::uuid)
         )",
    )
    .bind(route_key)
    .bind(excluded_org)
    .fetch_one(&mut **tx)
    .await?)
}

async fn apply_patch(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    patch: &PatchInput,
) -> Result<(), StoreError> {
    let existing =
        sqlx::query("SELECT issue_prefix, url_key FROM organizations WHERE id=$1::uuid FOR UPDATE")
            .bind(org)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or(StoreError::NotFound)?;
    let existing_prefix: String = existing.try_get("issue_prefix")?;
    let requested_prefix = patch.issue_prefix.as_deref();
    if requested_prefix.is_some_and(|prefix| prefix != existing_prefix) {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext('rudder:organization-issue-prefix'))")
            .execute(&mut **tx)
            .await?;
        let prefix = requested_prefix.expect("checked");
        if route_key_owned(tx, prefix, Some(org)).await? {
            return Err(StoreError::OrganizationConflict(format!(
                "Issue key \"{prefix}\" is already in use. Choose another key."
            )));
        }
        sqlx::query("DELETE FROM organization_issue_prefix_aliases WHERE org_id=$1::uuid AND lower(prefix)=lower($2)")
            .bind(org).bind(prefix).execute(&mut **tx).await?;
        sqlx::query("INSERT INTO organization_issue_prefix_aliases (org_id,prefix) VALUES ($1::uuid,$2) ON CONFLICT (prefix) DO NOTHING")
            .bind(org).bind(&existing_prefix).execute(&mut **tx).await?;
        sqlx::query("UPDATE issues SET identifier=$2 || '-' || issue_number::text WHERE org_id=$1::uuid AND issue_number IS NOT NULL")
            .bind(org).bind(prefix).execute(&mut **tx).await?;
    }

    if patch.brand_color.is_some() || patch.logo_asset_id.is_some() {
        adopt_branding_authority(tx, org).await?;
    }
    if let Some(Some(asset_id)) = patch.logo_asset_id.as_ref() {
        let asset_org = sqlx::query_scalar::<_, String>(
            "SELECT org_id::text FROM assets WHERE id=$1::uuid FOR KEY SHARE",
        )
        .bind(asset_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(StoreError::NotFound)?;
        if asset_org != org {
            return Err(StoreError::OrganizationInvalid(
                "Logo asset must belong to the same organization".to_owned(),
            ));
        }
    }
    let old_logo: Option<String> = sqlx::query_scalar(
        "SELECT asset_id::text FROM organization_logos WHERE org_id=$1::uuid FOR UPDATE",
    )
    .bind(org)
    .fetch_optional(&mut **tx)
    .await?;
    let updated = sqlx::query(
        "UPDATE organizations SET
           name=COALESCE($2,name),
           description=CASE WHEN $3 THEN $4 ELSE description END,
           issue_prefix=COALESCE($5,issue_prefix),
           budget_monthly_cents=COALESCE($6,budget_monthly_cents),
           spent_monthly_cents=COALESCE($7,spent_monthly_cents),
           status=COALESCE($8,status),
           default_chat_issue_creation_mode=COALESCE($9,default_chat_issue_creation_mode),
           require_board_approval_for_new_agents=COALESCE($10,require_board_approval_for_new_agents),
           brand_color=CASE WHEN $11 THEN $12 ELSE brand_color END,
           updated_at=now()
         WHERE id=$1::uuid",
    )
    .bind(org)
    .bind(&patch.name)
    .bind(patch.description.is_some())
    .bind(patch.description.as_ref().and_then(|value| value.as_deref()))
    .bind(requested_prefix)
    .bind(patch.budget_monthly_cents)
    .bind(patch.spent_monthly_cents)
    .bind(&patch.status)
    .bind(&patch.default_chat_issue_creation_mode)
    .bind(patch.require_board_approval_for_new_agents)
    .bind(patch.brand_color.is_some())
    .bind(patch.brand_color.as_ref().and_then(|value| value.as_deref()))
    .execute(&mut **tx).await?;
    if updated.rows_affected() == 0 {
        return Err(StoreError::NotFound);
    }
    if let Some(logo) = &patch.logo_asset_id {
        match logo {
            Some(asset_id) => {
                sqlx::query("INSERT INTO organization_logos (org_id,asset_id) VALUES ($1::uuid,$2::uuid) ON CONFLICT (org_id) DO UPDATE SET asset_id=EXCLUDED.asset_id,updated_at=now()")
                    .bind(org).bind(asset_id).execute(&mut **tx).await?;
            }
            None => {
                sqlx::query("DELETE FROM organization_logos WHERE org_id=$1::uuid")
                    .bind(org)
                    .execute(&mut **tx)
                    .await?;
            }
        }
        if let Some(old_logo) = old_logo
            .as_deref()
            .filter(|old| Some(*old) != logo.as_deref())
        {
            sqlx::query("DELETE FROM assets WHERE id=$1::uuid AND org_id=$2::uuid")
                .bind(old_logo)
                .bind(org)
                .execute(&mut **tx)
                .await?;
        }
    }
    Ok(())
}

async fn adopt_branding_authority(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
) -> Result<(), StoreError> {
    let row = sqlx::query("SELECT owner, fence_epoch FROM organization_branding_mutation_state WHERE org_id=$1::uuid FOR UPDATE")
        .bind(org).fetch_optional(&mut **tx).await?.ok_or(StoreError::NotOwned)?;
    let owner: String = row.try_get("owner")?;
    if owner == "node" {
        sqlx::query("UPDATE organization_branding_mutation_state SET owner='rust', fence_epoch=fence_epoch+1, fence_token=gen_random_uuid(), updated_at=now() WHERE org_id=$1::uuid")
            .bind(org).execute(&mut **tx).await?;
    } else if owner != "rust" {
        return Err(StoreError::NotOwned);
    }
    Ok(())
}

fn parse_create(value: &Value) -> Result<CreateInput, StoreError> {
    let object = value
        .as_object()
        .ok_or_else(|| StoreError::OrganizationInvalid("Invalid organization".to_owned()))?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| StoreError::OrganizationInvalid("Invalid organization name".to_owned()))?
        .to_owned();
    let issue_prefix = object
        .get("issuePrefix")
        .map(parse_issue_prefix)
        .transpose()?;
    let description = parse_optional_string(object.get("description"), true)?;
    let budget_monthly_cents = parse_nonnegative_integer(
        object.get("budgetMonthlyCents"),
        "Invalid organization budget",
    )?
    .unwrap_or(0);
    let default_chat_issue_creation_mode = object
        .get("defaultChatIssueCreationMode")
        .and_then(Value::as_str)
        .unwrap_or("manual_approval");
    if !matches!(
        default_chat_issue_creation_mode,
        "manual_approval" | "auto_create"
    ) {
        return Err(StoreError::OrganizationInvalid(
            "Invalid default chat issue creation mode".to_owned(),
        ));
    }
    let brand_color = parse_color(object.get("brandColor"))?;
    let require_board_approval_for_new_agents = object
        .get("requireBoardApprovalForNewAgents")
        .map(|value| {
            value.as_bool().ok_or_else(|| {
                StoreError::OrganizationInvalid("Invalid board approval setting".to_owned())
            })
        })
        .transpose()?;
    Ok(CreateInput {
        name,
        issue_prefix,
        description,
        budget_monthly_cents,
        default_chat_issue_creation_mode: default_chat_issue_creation_mode.to_owned(),
        brand_color,
        require_board_approval_for_new_agents,
    })
}

fn parse_patch(value: &Value, strict: bool) -> Result<PatchInput, StoreError> {
    let object = value
        .as_object()
        .ok_or_else(|| StoreError::OrganizationInvalid("Invalid organization update".to_owned()))?;
    let allowed_agent = ["name", "description", "brandColor", "logoAssetId"];
    if strict
        && object
            .keys()
            .any(|key| !allowed_agent.contains(&key.as_str()))
    {
        return Err(StoreError::OrganizationInvalid(
            "Invalid organization branding update".to_owned(),
        ));
    }
    let mut normalized = Map::new();
    let name = object
        .get("name")
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| {
                    StoreError::OrganizationInvalid("Invalid organization name".to_owned())
                })
        })
        .transpose()?;
    if let Some(value) = &name {
        normalized.insert("name".to_owned(), json!(value));
    }
    let description = object
        .get("description")
        .map(|value| match value {
            Value::Null => Ok(None),
            Value::String(value) => Ok(Some(value.clone())),
            _ => Err(StoreError::OrganizationInvalid(
                "Invalid organization description".to_owned(),
            )),
        })
        .transpose()?;
    if let Some(value) = &description {
        normalized.insert("description".to_owned(), json!(value));
    }
    let issue_prefix = object
        .get("issuePrefix")
        .map(parse_issue_prefix)
        .transpose()?;
    if let Some(value) = &issue_prefix {
        normalized.insert("issuePrefix".to_owned(), json!(value));
    }
    let budget_monthly_cents = parse_nonnegative_integer(
        object.get("budgetMonthlyCents"),
        "Invalid organization budget",
    )?;
    if let Some(value) = budget_monthly_cents {
        normalized.insert("budgetMonthlyCents".to_owned(), json!(value));
    }
    let spent_monthly_cents = parse_nonnegative_integer(
        object.get("spentMonthlyCents"),
        "Invalid organization spend",
    )?;
    if let Some(value) = spent_monthly_cents {
        normalized.insert("spentMonthlyCents".to_owned(), json!(value));
    }
    let status = object
        .get("status")
        .map(|value| {
            value
                .as_str()
                .filter(|value| matches!(*value, "active" | "paused" | "archived"))
                .map(str::to_owned)
                .ok_or_else(|| {
                    StoreError::OrganizationInvalid("Invalid organization status".to_owned())
                })
        })
        .transpose()?;
    if let Some(value) = &status {
        normalized.insert("status".to_owned(), json!(value));
    }
    let default_chat_issue_creation_mode = object
        .get("defaultChatIssueCreationMode")
        .map(|value| {
            value
                .as_str()
                .filter(|value| matches!(*value, "manual_approval" | "auto_create"))
                .map(str::to_owned)
                .ok_or_else(|| {
                    StoreError::OrganizationInvalid(
                        "Invalid default chat issue creation mode".to_owned(),
                    )
                })
        })
        .transpose()?;
    if let Some(value) = &default_chat_issue_creation_mode {
        normalized.insert("defaultChatIssueCreationMode".to_owned(), json!(value));
    }
    let require_board_approval_for_new_agents = object
        .get("requireBoardApprovalForNewAgents")
        .map(|value| {
            value.as_bool().ok_or_else(|| {
                StoreError::OrganizationInvalid("Invalid board approval setting".to_owned())
            })
        })
        .transpose()?;
    if let Some(value) = require_board_approval_for_new_agents {
        normalized.insert("requireBoardApprovalForNewAgents".to_owned(), json!(value));
    }
    let brand_color = object
        .get("brandColor")
        .map(parse_nullable_color)
        .transpose()?;
    if let Some(value) = &brand_color {
        normalized.insert("brandColor".to_owned(), json!(value));
    }
    let logo_asset_id = object
        .get("logoAssetId")
        .map(parse_nullable_uuid)
        .transpose()?;
    if let Some(value) = &logo_asset_id {
        normalized.insert("logoAssetId".to_owned(), json!(value));
    }
    if strict && normalized.is_empty() {
        return Err(StoreError::OrganizationInvalid(
            "At least one branding field must be provided".to_owned(),
        ));
    }
    Ok(PatchInput {
        normalized,
        name,
        description,
        issue_prefix,
        budget_monthly_cents,
        spent_monthly_cents,
        status,
        default_chat_issue_creation_mode,
        require_board_approval_for_new_agents,
        brand_color,
        logo_asset_id,
    })
}

fn parse_optional_string(
    value: Option<&Value>,
    nullable: bool,
) -> Result<Option<String>, StoreError> {
    match value {
        None => Ok(None),
        Some(Value::Null) if nullable => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(StoreError::OrganizationInvalid(
            "Invalid organization description".to_owned(),
        )),
    }
}

fn parse_nonnegative_integer(
    value: Option<&Value>,
    message: &str,
) -> Result<Option<i32>, StoreError> {
    match value {
        None => Ok(None),
        Some(Value::Number(number)) => number
            .as_i64()
            .filter(|value| *value >= 0 && *value <= i32::MAX as i64)
            .map(|value| Some(value as i32))
            .ok_or_else(|| StoreError::OrganizationInvalid(message.to_owned())),
        _ => Err(StoreError::OrganizationInvalid(message.to_owned())),
    }
}

fn parse_issue_prefix(value: &Value) -> Result<String, StoreError> {
    let Some(value) = value.as_str() else {
        return Err(StoreError::OrganizationInvalid(
            "Issue key must start with a letter and contain only letters and numbers".to_owned(),
        ));
    };
    let normalized = value.trim().to_ascii_uppercase();
    let valid = !normalized.is_empty()
        && normalized.len() <= 12
        && normalized.as_bytes()[0].is_ascii_uppercase()
        && normalized
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit());
    if valid {
        Ok(normalized)
    } else {
        Err(StoreError::OrganizationInvalid(
            "Issue key must start with a letter and contain only letters and numbers".to_owned(),
        ))
    }
}

fn parse_color(value: Option<&Value>) -> Result<Option<String>, StoreError> {
    value
        .map(parse_nullable_color)
        .transpose()
        .map(Option::flatten)
}
fn parse_nullable_color(value: &Value) -> Result<Option<String>, StoreError> {
    match value {
        Value::Null => Ok(None),
        Value::String(value)
            if value.len() == 7
                && value.starts_with('#')
                && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit()) =>
        {
            Ok(Some(value.clone()))
        }
        _ => Err(StoreError::OrganizationInvalid(
            "Invalid brand color".to_owned(),
        )),
    }
}
fn parse_nullable_uuid(value: &Value) -> Result<Option<String>, StoreError> {
    match value {
        Value::Null => Ok(None),
        Value::String(value) => Uuid::parse_str(value)
            .map(|id| Some(id.to_string()))
            .map_err(|_| StoreError::OrganizationInvalid("Invalid logo asset id".to_owned())),
        _ => Err(StoreError::OrganizationInvalid(
            "Invalid logo asset id".to_owned(),
        )),
    }
}

fn derive_issue_key(name: &str) -> String {
    let candidate: String = name
        .to_ascii_uppercase()
        .bytes()
        .filter(u8::is_ascii_alphanumeric)
        .take(3)
        .map(char::from)
        .collect();
    if candidate
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_uppercase)
    {
        candidate
    } else {
        "CMP".to_owned()
    }
}
fn derive_url_key(name: &str) -> String {
    let mut output = String::new();
    let mut separator = false;
    for byte in name.to_ascii_lowercase().bytes() {
        if byte.is_ascii_lowercase() || byte.is_ascii_digit() {
            output.push(char::from(byte));
            separator = false;
        } else if !separator && !output.is_empty() {
            output.push('-');
            separator = true;
        }
    }
    while output.ends_with('-') {
        output.pop();
    }
    if output.is_empty() {
        "organization".to_owned()
    } else {
        output
    }
}

async fn write_organization_created_analytics(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
) -> Result<(), StoreError> {
    let prior: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM organizations WHERE id<>$1::uuid)")
            .bind(org)
            .fetch_one(&mut **tx)
            .await?;
    let created_at: String =
        sqlx::query_scalar("SELECT created_at::text FROM organizations WHERE id=$1::uuid")
            .bind(org)
            .fetch_one(&mut **tx)
            .await?;
    let properties = json!({
        "creation_path":"manual",
        "template_kind":"custom",
        "is_first_organization":!prior,
        "is_user_initiated":true,
    });
    let dedupe_key = format!("organization_created:{org}");
    crate::product_analytics::write_product_analytics_event(
        tx,
        crate::product_analytics::ProductAnalyticsEvent {
            org_id: Some(org),
            event_name: "organization_created",
            occurred_at: Some(&created_at),
            source_transition: "organization.create",
            confidence: "exact",
            actor_type: "system",
            actor_id: None,
            entity_type: Some("organization"),
            entity_id: Some(org),
            work_surface: None,
            work_id: Some(org),
            work_cycle_id: None,
            root_run_id: None,
            run_id: None,
            completion_revision: None,
            origin: "system",
            dedupe_key: &dedupe_key,
            properties: &properties,
        },
    )
    .await?;
    Ok(())
}

async fn create_budget_policy(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    amount: i32,
    actor: &str,
) -> Result<(), StoreError> {
    let row = sqlx::query_scalar::<_, String>(
        "INSERT INTO budget_policies
           (org_id,scope_type,scope_id,metric,window_kind,amount,warn_percent,hard_stop_enabled,notify_enabled,is_active,created_by_user_id,updated_by_user_id)
         VALUES ($1::uuid,'organization',$1::uuid,'billed_cents','calendar_month_utc',$2,80,true,true,true,$3,$3)
         RETURNING id::text",
    ).bind(org).bind(amount).bind(actor).fetch_one(&mut **tx).await?;
    activity::write_activity(&mut *tx, org, &activity::ActivityActor { actor_type:"user", actor_id: actor.to_owned(), run_id:None }, "budget.policy_upserted", "budget_policy", &row, Some(&json!({"scopeType":"organization","scopeId":org,"amount":amount,"windowKind":"calendar_month_utc"}))).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn organization_create_defaults_and_key_derivation_match_the_public_contract() {
        let input = parse_create(&json!({"name":"North Star / Operations"})).unwrap();
        assert_eq!(input.issue_prefix.as_deref(), None);
        assert_eq!(input.default_chat_issue_creation_mode, "manual_approval");
        assert_eq!(input.budget_monthly_cents, 0);
        assert_eq!(derive_issue_key(&input.name), "NOR");
        assert_eq!(derive_url_key(&input.name), "north-star-operations");

        let explicit = parse_create(&json!({"name":"North Star","issuePrefix":" n2 "})).unwrap();
        assert_eq!(explicit.issue_prefix.as_deref(), Some("N2"));
        assert!(parse_create(&json!({"name":"North Star","issuePrefix":"2N"})).is_err());
    }

    #[test]
    fn organization_patch_preserves_absent_versus_null_and_legacy_unknown_key_behavior() {
        let absent = parse_patch(&json!({"name":"North Star"}), false).unwrap();
        assert_eq!(absent.description, None);
        assert_eq!(absent.brand_color, None);
        assert_eq!(absent.logo_asset_id, None);

        let cleared = parse_patch(
            &json!({"description":null,"brandColor":null,"logoAssetId":null}),
            false,
        )
        .unwrap();
        assert_eq!(cleared.description, Some(None));
        assert_eq!(cleared.brand_color, Some(None));
        assert_eq!(cleared.logo_asset_id, Some(None));

        let legacy_unknown =
            parse_patch(&json!({"name":"North Star","futureField":true}), false).unwrap();
        assert_eq!(legacy_unknown.name.as_deref(), Some("North Star"));
        assert!(!legacy_unknown.normalized.contains_key("futureField"));
        assert!(parse_patch(&json!({"brandColor":"#123abc","futureField":true}), true).is_err());
        assert!(parse_patch(&json!({}), true).is_err());
    }
}
