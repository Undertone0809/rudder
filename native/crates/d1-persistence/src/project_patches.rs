use crate::{
    CommittedMutation, Outcome, ProjectPatchCommand, ResultState, StoreError, transaction,
};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::collections::HashSet;

#[derive(Clone, Debug)]
pub(crate) struct Patch {
    pub(crate) name: Option<String>,
    pub(crate) description: Option<Option<String>>,
    pub(crate) status: Option<String>,
    pub(crate) lead_agent_id: Option<Option<String>>,
    pub(crate) target_date: Option<Option<String>>,
    pub(crate) color: Option<Option<String>>,
    pub(crate) icon: Option<Option<String>>,
    pub(crate) execution_workspace_policy: Option<Option<Value>>,
    pub(crate) archived_at: Option<Option<String>>,
    pub(crate) goal_ids: Option<Vec<String>>,
    pub(crate) resource_attachments: Option<Vec<ResourceAttachmentInput>>,
    pub(crate) new_resources: Option<Vec<InlineResourceInput>>,
    resource_attachment_operation: Option<ResourceAttachmentOperation>,
    fingerprint: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResourceAttachmentInput {
    pub(crate) resource_id: String,
    pub(crate) role: Option<String>,
    pub(crate) note: Option<String>,
    pub(crate) sort_order: Option<u64>,
    pub(crate) is_primary: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InlineResourceInput {
    pub(crate) name: String,
    pub(crate) kind: String,
    pub(crate) source_type: Option<String>,
    pub(crate) locator: String,
    pub(crate) description: Option<String>,
    pub(crate) metadata: Option<Value>,
    pub(crate) role: Option<String>,
    pub(crate) note: Option<String>,
    pub(crate) sort_order: Option<u64>,
    pub(crate) is_primary: Option<bool>,
}

#[derive(Clone, Debug)]
enum ResourceAttachmentOperation {
    Attach(ResourceAttachmentInput),
    Update {
        attachment_id: String,
        role: Option<String>,
        note: Option<Option<String>>,
        sort_order: Option<u64>,
        is_primary: Option<bool>,
    },
    Remove {
        attachment_id: String,
    },
}

struct ResourceAttachmentActivity {
    action: &'static str,
    entity_id: String,
    details: Value,
    response_status: u16,
    response: Value,
}

#[derive(Clone, Debug)]
struct Attachment {
    resource_id: String,
    role: String,
    note: Option<String>,
    sort_order: Option<u64>,
    is_primary: bool,
}

impl Patch {
    pub(crate) fn parse(value: &Value) -> Result<Self, StoreError> {
        let object = value.as_object().ok_or(StoreError::InvalidInput)?;
        const ALLOWED: &[&str] = &[
            "goalId",
            "goalIds",
            "name",
            "description",
            "status",
            "leadAgentId",
            "targetDate",
            "color",
            "icon",
            "executionWorkspacePolicy",
            "resourceAttachments",
            "resourceAttachmentOperation",
            "newResources",
            "archivedAt",
        ];
        if object.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
            return Err(StoreError::InvalidInput);
        }

        let goal_ids_field = parse_field::<Vec<String>>(object, "goalIds")?;
        let goal_id_field = parse_field::<Option<String>>(object, "goalId")?;
        let goal_ids = if object.contains_key("goalIds") {
            Some(goal_ids_field.ok_or(StoreError::InvalidInput)?)
        } else if object.contains_key("goalId") {
            Some(goal_id_field.flatten().into_iter().collect())
        } else {
            None
        };

        let name = parse_field(object, "name")?;
        let status: Option<String> = parse_field(object, "status")?;
        if name.as_ref().is_some_and(String::is_empty)
            || status.as_ref().is_some_and(|value| {
                !matches!(
                    value.as_str(),
                    "backlog" | "planned" | "in_progress" | "completed" | "cancelled"
                )
            })
        {
            return Err(StoreError::InvalidInput);
        }

        let execution_workspace_policy =
            parse_field::<Option<Value>>(object, "executionWorkspacePolicy")?;
        if execution_workspace_policy
            .as_ref()
            .is_some_and(|value| value.as_ref().is_some_and(|value| !value.is_object()))
        {
            return Err(StoreError::InvalidInput);
        }

        let resource_attachments: Option<Vec<ResourceAttachmentInput>> =
            parse_field(object, "resourceAttachments")?;
        let new_resources: Option<Vec<InlineResourceInput>> = parse_field(object, "newResources")?;
        let resource_attachment_operation = object
            .get("resourceAttachmentOperation")
            .cloned()
            .map(parse_resource_attachment_operation)
            .transpose()?;
        if resource_attachment_operation.is_some()
            && object
                .keys()
                .any(|key| key != "resourceAttachmentOperation")
        {
            return Err(StoreError::InvalidInput);
        }
        for attachment in resource_attachments.iter().flatten() {
            validate_attachment_role(attachment.role.as_deref())?;
            if attachment
                .sort_order
                .is_some_and(|value| value > i32::MAX as u64)
            {
                return Err(StoreError::InvalidInput);
            }
        }
        for resource in new_resources.iter().flatten() {
            validate_resource_role(resource.role.as_deref())?;
            validate_resource_input(resource)?;
        }

        Ok(Self {
            name,
            description: parse_field(object, "description")?,
            status,
            lead_agent_id: parse_field(object, "leadAgentId")?,
            target_date: parse_field(object, "targetDate")?,
            color: parse_field(object, "color")?,
            icon: parse_field(object, "icon")?,
            execution_workspace_policy,
            archived_at: parse_field(object, "archivedAt")?,
            goal_ids,
            resource_attachments,
            new_resources,
            resource_attachment_operation,
            fingerprint: hex_digest(Sha256::digest(
                serde_json::to_vec(value).map_err(|_| StoreError::InvalidInput)?,
            )),
        })
    }

    pub(crate) fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
}

fn parse_field<T: DeserializeOwned>(
    object: &Map<String, Value>,
    key: &str,
) -> Result<Option<T>, StoreError> {
    object
        .get(key)
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| StoreError::InvalidInput)
}

fn parse_resource_attachment_operation(
    value: Value,
) -> Result<ResourceAttachmentOperation, StoreError> {
    let object = value.as_object().ok_or(StoreError::InvalidInput)?;
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .ok_or(StoreError::InvalidInput)?;
    match kind {
        "attach" => {
            const ALLOWED: &[&str] = &[
                "kind",
                "resourceId",
                "role",
                "note",
                "sortOrder",
                "isPrimary",
            ];
            if object.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
                return Err(StoreError::InvalidInput);
            }
            let mut input = object.clone();
            input.remove("kind");
            let input: ResourceAttachmentInput = serde_json::from_value(Value::Object(input))
                .map_err(|_| StoreError::InvalidInput)?;
            validate_attachment_role(input.role.as_deref())?;
            if input
                .sort_order
                .is_some_and(|value| value > i32::MAX as u64)
            {
                return Err(StoreError::InvalidInput);
            }
            Ok(ResourceAttachmentOperation::Attach(input))
        }
        "update" => {
            const ALLOWED: &[&str] = &[
                "kind",
                "attachmentId",
                "role",
                "note",
                "sortOrder",
                "isPrimary",
            ];
            if object.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
                return Err(StoreError::InvalidInput);
            }
            let attachment_id =
                parse_field::<String>(object, "attachmentId")?.ok_or(StoreError::InvalidInput)?;
            let role = parse_field::<String>(object, "role")?;
            let note = parse_field::<Option<String>>(object, "note")?;
            let sort_order = parse_field::<u64>(object, "sortOrder")?;
            let is_primary = parse_field::<bool>(object, "isPrimary")?;
            validate_attachment_role(role.as_deref())?;
            if sort_order.is_some_and(|value| value > i32::MAX as u64) {
                return Err(StoreError::InvalidInput);
            }
            Ok(ResourceAttachmentOperation::Update {
                attachment_id,
                role,
                note,
                sort_order,
                is_primary,
            })
        }
        "remove" => {
            const ALLOWED: &[&str] = &["kind", "attachmentId"];
            if object.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
                return Err(StoreError::InvalidInput);
            }
            let attachment_id =
                parse_field::<String>(object, "attachmentId")?.ok_or(StoreError::InvalidInput)?;
            Ok(ResourceAttachmentOperation::Remove { attachment_id })
        }
        _ => Err(StoreError::InvalidInput),
    }
}

fn validate_attachment_role(role: Option<&str>) -> Result<(), StoreError> {
    if role.is_some_and(|role| {
        !matches!(
            role,
            "working_set" | "reference" | "tracking" | "deliverable" | "background"
        )
    }) {
        return Err(StoreError::InvalidInput);
    }
    Ok(())
}

fn validate_resource_role(role: Option<&str>) -> Result<(), StoreError> {
    validate_attachment_role(role)
}

fn validate_resource_input(resource: &InlineResourceInput) -> Result<(), StoreError> {
    if resource.name.is_empty()
        || resource.locator.is_empty()
        || !matches!(
            resource.kind.as_str(),
            "file" | "directory" | "url" | "connector_object"
        )
        || resource
            .source_type
            .as_deref()
            .is_some_and(|source| !matches!(source, "external" | "library"))
        || resource
            .sort_order
            .is_some_and(|value| value > i32::MAX as u64)
        || resource
            .metadata
            .as_ref()
            .is_some_and(|value| !value.is_object())
    {
        return Err(StoreError::InvalidInput);
    }
    let source_type = resource.source_type.as_deref().unwrap_or("external");
    if source_type == "library" {
        let locator = resource.locator.trim();
        let parts: Vec<&str> = locator.split('/').collect();
        let has_scheme = locator.split_once(':').is_some_and(|(prefix, _)| {
            !prefix.is_empty()
                && prefix
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '.' | '-'))
        });
        if !matches!(resource.kind.as_str(), "file" | "directory")
            || locator.is_empty()
            || has_scheme
            || locator.starts_with('/')
            || locator.starts_with('\\')
            || locator.starts_with('~')
            || locator.contains('\\')
            || parts
                .iter()
                .any(|part| part.is_empty() || *part == "." || *part == "..")
            || parts.first() != Some(&"projects")
            || (resource.kind == "directory" && parts.len() < 2)
            || (resource.kind == "file" && parts.len() < 3)
        {
            return Err(StoreError::InvalidResource);
        }
    }
    Ok(())
}

pub(crate) async fn apply(
    tx: &mut transaction::Tx<'_>,
    command: ProjectPatchCommand,
    patch: Patch,
    metadata: &transaction::Metadata,
) -> Result<CommittedMutation, StoreError> {
    let scope = transaction::lock_scope_for_project_patch(tx, metadata).await?;
    if let Some(receipt) = transaction::replay(tx, metadata).await? {
        return Ok(receipt);
    }
    metadata.check_fresh(scope.version, scope.fence_epoch)?;

    let project = sqlx::query(
        "SELECT name, goal_id::text AS goal_id
         FROM projects
         WHERE id=$1::uuid AND org_id=$2::uuid
         FOR UPDATE",
    )
    .bind(&command.project_id)
    .bind(&command.organization_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(StoreError::NotFound)?;
    let current_name: String = project.try_get("name")?;
    let current_primary: Option<String> = project.try_get("goal_id")?;
    let existing_goal_ids = read_project_goals(tx, &command).await?;

    validate_project_patch_targets(tx, &command, &patch).await?;
    let next_name = match patch.name.as_deref() {
        Some(name) => Some(resolve_project_name(tx, &command, &current_name, name).await?),
        None => None,
    };
    let next_primary = patch
        .goal_ids
        .as_ref()
        .map(|goal_ids| goal_ids.first().cloned());
    let next_goal_ids = patch
        .goal_ids
        .clone()
        .unwrap_or_else(|| existing_goal_ids.clone());
    let primary_after = next_primary.clone().unwrap_or(current_primary.clone());
    let touch_project = patch.resource_attachment_operation.is_none();

    sqlx::query(
        "UPDATE projects SET
           name=CASE WHEN $3 THEN $4 ELSE name END,
           description=CASE WHEN $5 THEN $6 ELSE description END,
           status=CASE WHEN $7 THEN $8 ELSE status END,
           lead_agent_id=CASE WHEN $9 THEN $10::uuid ELSE lead_agent_id END,
           target_date=CASE WHEN $11 THEN $12::date ELSE target_date END,
           color=CASE WHEN $13 THEN $14 ELSE color END,
           icon=CASE WHEN $15 THEN $16 ELSE icon END,
           execution_workspace_policy=CASE WHEN $17 THEN $18::jsonb ELSE execution_workspace_policy END,
           archived_at=CASE WHEN $19 THEN $20::timestamptz ELSE archived_at END,
           goal_id=CASE WHEN $21 THEN $22::uuid ELSE goal_id END,
           updated_at=CASE WHEN $23 THEN now() ELSE updated_at END
         WHERE id=$1::uuid AND org_id=$2::uuid",
    )
    .bind(&command.project_id)
    .bind(&command.organization_id)
    .bind(next_name.is_some())
    .bind(next_name)
    .bind(patch.description.is_some())
    .bind(patch.description.clone().flatten())
    .bind(patch.status.is_some())
    .bind(patch.status.clone())
    .bind(patch.lead_agent_id.is_some())
    .bind(patch.lead_agent_id.clone().flatten())
    .bind(patch.target_date.is_some())
    .bind(patch.target_date.clone().flatten())
    .bind(patch.color.is_some())
    .bind(patch.color.clone().flatten())
    .bind(patch.icon.is_some())
    .bind(patch.icon.clone().flatten())
    .bind(patch.execution_workspace_policy.is_some())
    .bind(
        patch
            .execution_workspace_policy
            .as_ref()
            .and_then(|value| value.as_ref())
            .map(serde_json::to_string)
            .transpose()
            .map_err(|_| StoreError::InvalidInput)?,
    )
    .bind(patch.archived_at.is_some())
    .bind(patch.archived_at.clone().flatten())
    .bind(patch.goal_ids.is_some())
    .bind(next_primary.clone().flatten())
    .bind(touch_project)
    .execute(&mut **tx)
    .await?;

    if let Some(goal_ids) = patch.goal_ids.as_deref() {
        sqlx::query(
            "DELETE FROM project_goals
             WHERE project_id=$1::uuid AND org_id=$2::uuid",
        )
        .bind(&command.project_id)
        .bind(&command.organization_id)
        .execute(&mut **tx)
        .await?;
        for goal_id in goal_ids {
            sqlx::query(
                "INSERT INTO project_goals (project_id, goal_id, org_id)
                 VALUES ($1::uuid, $2::uuid, $3::uuid)",
            )
            .bind(&command.project_id)
            .bind(goal_id)
            .bind(&command.organization_id)
            .execute(&mut **tx)
            .await?;
        }
    }

    let resource_activity = if let Some(operation) = patch.resource_attachment_operation.as_ref() {
        Some(apply_resource_attachment_operation(tx, &command, operation).await?)
    } else {
        if patch.resource_attachments.is_some() || patch.new_resources.is_some() {
            replace_resources(tx, &command, &patch).await?;
        }
        None
    };

    let patch_fingerprint = patch.fingerprint().to_owned();
    let state_integrity = transaction::project_patch_state_integrity(
        &command.project_id,
        &patch_fingerprint,
        &next_goal_ids,
        primary_after.as_deref(),
    )?;
    let resource_attachment_response = resource_activity.as_ref().map(|activity| {
        json!({
            "status": activity.response_status,
            "body": activity.response,
        })
    });
    transaction::persist_project_patch(
        tx,
        metadata,
        &scope,
        transaction::Effect {
            version: scope
                .version
                .checked_add(1)
                .ok_or(StoreError::VersionRange)?,
            fence_epoch: scope.fence_epoch,
            outcome: Outcome::Applied,
            result: ResultState::ProjectPatch {
                project_id: command.project_id.clone(),
                patch_fingerprint,
                goal_ids: next_goal_ids,
                primary_goal_after: primary_after,
                state_integrity,
            },
            entity_id: resource_activity
                .as_ref()
                .map(|activity| activity.entity_id.clone())
                .unwrap_or_else(|| command.project_id.clone()),
            activity_action: resource_activity.as_ref().map(|activity| activity.action),
            activity_entity_type: resource_activity
                .as_ref()
                .map(|_| "project_resource_attachment"),
            details: resource_activity
                .map(|activity| activity.details)
                .unwrap_or(command.patch),
        },
        resource_attachment_response,
    )
    .await
}

async fn read_project_goals(
    tx: &mut transaction::Tx<'_>,
    command: &ProjectPatchCommand,
) -> Result<Vec<String>, StoreError> {
    let rows = sqlx::query(
        "SELECT org_id::text AS org_id, goal_id::text AS goal_id
         FROM project_goals
         WHERE project_id=$1::uuid
         ORDER BY goal_id
         FOR UPDATE",
    )
    .bind(&command.project_id)
    .fetch_all(&mut **tx)
    .await?;
    let mut goal_ids = Vec::with_capacity(rows.len());
    for row in rows {
        let row_org: String = row.try_get("org_id")?;
        let goal_id: String = row.try_get("goal_id")?;
        if row_org != command.organization_id {
            return Err(StoreError::InvalidProjection);
        }
        transaction::uuid(&goal_id)?;
        goal_ids.push(goal_id);
    }
    Ok(goal_ids)
}

async fn validate_project_patch_targets(
    tx: &mut transaction::Tx<'_>,
    command: &ProjectPatchCommand,
    patch: &Patch,
) -> Result<(), StoreError> {
    if let Some(goal_ids) = patch.goal_ids.as_deref() {
        let unique_goal_ids: HashSet<&str> = goal_ids.iter().map(String::as_str).collect();
        if unique_goal_ids.len() != goal_ids.len() {
            return Err(StoreError::InvalidInput);
        }
        if !goal_ids.is_empty() {
            let found: Vec<String> = sqlx::query_scalar(
                "SELECT id::text
                 FROM goals
                 WHERE org_id=$1::uuid AND id=ANY($2::text[]::uuid[])
                 ORDER BY id
                 FOR UPDATE",
            )
            .bind(&command.organization_id)
            .bind(goal_ids)
            .fetch_all(&mut **tx)
            .await?;
            if found.len() != goal_ids.len() {
                return Err(StoreError::InvalidInput);
            }
        }
    }
    if let Some(Some(agent_id)) = patch.lead_agent_id.as_ref() {
        let belongs: bool = sqlx::query_scalar(
            "SELECT EXISTS(
               SELECT 1 FROM agents WHERE id=$1::uuid AND org_id=$2::uuid
             )",
        )
        .bind(agent_id)
        .bind(&command.organization_id)
        .fetch_one(&mut **tx)
        .await?;
        if !belongs {
            return Err(StoreError::InvalidInput);
        }
    }
    Ok(())
}

async fn resolve_project_name(
    tx: &mut transaction::Tx<'_>,
    command: &ProjectPatchCommand,
    current_name: &str,
    requested_name: &str,
) -> Result<String, StoreError> {
    let current_key = normalize_project_url_key(current_name);
    let requested_key = normalize_project_url_key(requested_name);
    if requested_key.is_none() || current_key == requested_key {
        return Ok(requested_name.to_owned());
    }
    let rows = sqlx::query("SELECT id::text AS id, name FROM projects WHERE org_id=$1::uuid")
        .bind(&command.organization_id)
        .fetch_all(&mut **tx)
        .await?;
    let used: HashSet<String> = rows
        .into_iter()
        .filter_map(|row| {
            let id: String = row.try_get("id").ok()?;
            if id == command.project_id {
                return None;
            }
            let name: String = row.try_get("name").ok()?;
            normalize_project_url_key(&name)
        })
        .collect();
    if !requested_key.as_ref().is_some_and(|key| used.contains(key)) {
        return Ok(requested_name.to_owned());
    }
    for suffix in 2..10_000 {
        let candidate = format!("{requested_name} {suffix}");
        if normalize_project_url_key(&candidate).is_some_and(|key| !used.contains(&key)) {
            return Ok(candidate);
        }
    }
    Err(StoreError::InvalidInput)
}

fn normalize_project_url_key(value: &str) -> Option<String> {
    let mut output = String::new();
    let mut separator_pending = false;
    for lowered in value.trim().chars().flat_map(char::to_lowercase) {
        if lowered.is_ascii_alphanumeric() {
            if separator_pending && !output.is_empty() {
                output.push('-');
            }
            output.push(lowered);
            separator_pending = false;
        } else {
            separator_pending = true;
        }
    }
    (!output.is_empty()).then_some(output)
}

async fn replace_resources(
    tx: &mut transaction::Tx<'_>,
    command: &ProjectPatchCommand,
    patch: &Patch,
) -> Result<(), StoreError> {
    let mut attachments = if let Some(inputs) = patch.resource_attachments.as_ref() {
        inputs
            .iter()
            .map(|input| Attachment {
                resource_id: input.resource_id.clone(),
                role: input.role.clone().unwrap_or_else(|| "reference".to_owned()),
                note: normalize_nullable_text(input.note.as_deref()),
                sort_order: input.sort_order,
                is_primary: input.is_primary.unwrap_or(false),
            })
            .collect()
    } else {
        read_existing_attachments(tx, command).await?
    };

    for resource in patch.new_resources.as_deref().unwrap_or_default() {
        let resource_id = create_or_reuse_resource(tx, command, resource).await?;
        attachments.push(Attachment {
            resource_id,
            role: resource
                .role
                .clone()
                .unwrap_or_else(|| "reference".to_owned()),
            note: normalize_nullable_text(resource.note.as_deref()),
            sort_order: resource.sort_order,
            is_primary: resource.is_primary.unwrap_or(false),
        });
    }

    let mut seen = HashSet::new();
    attachments.retain(|attachment| seen.insert(attachment.resource_id.clone()));
    if attachments
        .iter()
        .filter(|attachment| attachment.is_primary)
        .count()
        > 1
    {
        return Err(StoreError::InvalidResource);
    }
    let max_sort_order = attachments
        .iter()
        .filter_map(|attachment| attachment.sort_order)
        .max()
        .unwrap_or(0);
    if max_sort_order > i32::MAX as u64 {
        return Err(StoreError::InvalidInput);
    }

    if !attachments.is_empty() {
        let resource_ids: Vec<String> = attachments
            .iter()
            .map(|attachment| attachment.resource_id.clone())
            .collect();
        let found: Vec<String> = sqlx::query_scalar(
            "SELECT id::text FROM organization_resources
             WHERE org_id=$1::uuid AND id=ANY($2::text[]::uuid[])",
        )
        .bind(&command.organization_id)
        .bind(&resource_ids)
        .fetch_all(&mut **tx)
        .await?;
        if found.len() != resource_ids.len() {
            return Err(StoreError::InvalidInput);
        }
    }

    sqlx::query(
        "DELETE FROM project_resource_attachments
         WHERE org_id=$1::uuid AND project_id=$2::uuid",
    )
    .bind(&command.organization_id)
    .bind(&command.project_id)
    .execute(&mut **tx)
    .await?;
    for (index, attachment) in attachments.into_iter().enumerate() {
        let sort_order = attachment
            .sort_order
            .map(i32::try_from)
            .transpose()
            .map_err(|_| StoreError::InvalidInput)?
            .unwrap_or(i32::try_from(index).map_err(|_| StoreError::InvalidInput)?);
        sqlx::query(
            "INSERT INTO project_resource_attachments
               (org_id, project_id, resource_id, role, note, sort_order, is_primary)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)",
        )
        .bind(&command.organization_id)
        .bind(&command.project_id)
        .bind(&attachment.resource_id)
        .bind(attachment.role)
        .bind(attachment.note)
        .bind(sort_order)
        .bind(attachment.is_primary)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn apply_resource_attachment_operation(
    tx: &mut transaction::Tx<'_>,
    command: &ProjectPatchCommand,
    operation: &ResourceAttachmentOperation,
) -> Result<ResourceAttachmentActivity, StoreError> {
    match operation {
        ResourceAttachmentOperation::Attach(input) => {
            let resource_exists = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(
                   SELECT 1 FROM organization_resources
                   WHERE org_id=$1::uuid AND id::text=$2
                 )",
            )
            .bind(&command.organization_id)
            .bind(&input.resource_id)
            .fetch_one(&mut **tx)
            .await?;
            if !resource_exists {
                return Err(StoreError::NotFound);
            }

            let existing = sqlx::query(
                "SELECT id::text AS attachment_id, role, note, sort_order, is_primary
                 FROM project_resource_attachments
                 WHERE org_id=$1::uuid AND project_id=$2::uuid AND resource_id::text=$3
                 FOR UPDATE",
            )
            .bind(&command.organization_id)
            .bind(&command.project_id)
            .bind(&input.resource_id)
            .fetch_optional(&mut **tx)
            .await?;

            let (attachment_id, role, is_primary) = if let Some(existing) = existing {
                let attachment_id: String = existing.try_get("attachment_id")?;
                let current_role: String = existing.try_get("role")?;
                let current_note: Option<String> = existing.try_get("note")?;
                let current_sort_order: i32 = existing.try_get("sort_order")?;
                let current_is_primary: bool = existing.try_get("is_primary")?;
                let role = input.role.clone().unwrap_or(current_role);
                let note = normalize_nullable_text(input.note.as_deref()).or(current_note);
                let sort_order = input
                    .sort_order
                    .map(i32::try_from)
                    .transpose()
                    .map_err(|_| StoreError::InvalidInput)?
                    .unwrap_or(current_sort_order);
                let is_primary = input.is_primary.unwrap_or(current_is_primary);
                if is_primary {
                    sqlx::query(
                        "UPDATE project_resource_attachments
                         SET is_primary=false, updated_at=now()
                         WHERE org_id=$1::uuid AND project_id=$2::uuid AND is_primary=true
                           AND id::text<>$3",
                    )
                    .bind(&command.organization_id)
                    .bind(&command.project_id)
                    .bind(&attachment_id)
                    .execute(&mut **tx)
                    .await?;
                }
                sqlx::query(
                    "UPDATE project_resource_attachments
                     SET role=$4, note=$5, sort_order=$6, is_primary=$7, updated_at=now()
                     WHERE org_id=$1::uuid AND project_id=$2::uuid AND id::text=$3",
                )
                .bind(&command.organization_id)
                .bind(&command.project_id)
                .bind(&attachment_id)
                .bind(&role)
                .bind(&note)
                .bind(sort_order)
                .bind(is_primary)
                .execute(&mut **tx)
                .await?;
                (attachment_id, role, is_primary)
            } else {
                let sort_order = match input.sort_order {
                    Some(sort_order) => {
                        i32::try_from(sort_order).map_err(|_| StoreError::InvalidInput)?
                    }
                    None => {
                        sqlx::query_scalar::<_, i32>(
                            "SELECT COALESCE(MAX(sort_order), -1) + 1
                         FROM project_resource_attachments
                         WHERE org_id=$1::uuid AND project_id=$2::uuid",
                        )
                        .bind(&command.organization_id)
                        .bind(&command.project_id)
                        .fetch_one(&mut **tx)
                        .await?
                    }
                };
                let role = input.role.clone().unwrap_or_else(|| "reference".to_owned());
                let note = normalize_nullable_text(input.note.as_deref());
                let is_primary = input.is_primary.unwrap_or(false);
                if is_primary {
                    sqlx::query(
                        "UPDATE project_resource_attachments
                         SET is_primary=false, updated_at=now()
                         WHERE org_id=$1::uuid AND project_id=$2::uuid AND is_primary=true",
                    )
                    .bind(&command.organization_id)
                    .bind(&command.project_id)
                    .execute(&mut **tx)
                    .await?;
                }
                let attachment_id: String = sqlx::query_scalar(
                    "INSERT INTO project_resource_attachments
                       (org_id, project_id, resource_id, role, note, sort_order, is_primary)
                     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)
                     RETURNING id::text",
                )
                .bind(&command.organization_id)
                .bind(&command.project_id)
                .bind(&input.resource_id)
                .bind(&role)
                .bind(&note)
                .bind(sort_order)
                .bind(is_primary)
                .fetch_one(&mut **tx)
                .await?;
                (attachment_id, role, is_primary)
            };
            let response = read_resource_attachment_response(tx, command, &attachment_id).await?;

            Ok(ResourceAttachmentActivity {
                action: "project.resource.attached",
                entity_id: attachment_id,
                details: json!({
                    "projectId": command.project_id,
                    "resourceId": input.resource_id,
                    "role": role,
                    "isPrimary": is_primary,
                }),
                response_status: 201,
                response,
            })
        }
        ResourceAttachmentOperation::Update {
            attachment_id,
            role,
            note,
            sort_order,
            is_primary,
        } => {
            let existing = sqlx::query(
                "SELECT role, note, sort_order, is_primary
                 FROM project_resource_attachments
                 WHERE org_id=$1::uuid AND project_id=$2::uuid AND id::text=$3
                 FOR UPDATE",
            )
            .bind(&command.organization_id)
            .bind(&command.project_id)
            .bind(attachment_id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or(StoreError::NotFound)?;
            let current_role: String = existing.try_get("role")?;
            let current_note: Option<String> = existing.try_get("note")?;
            let current_sort_order: i32 = existing.try_get("sort_order")?;
            let current_is_primary: bool = existing.try_get("is_primary")?;
            let next_role = role.clone().unwrap_or(current_role);
            let next_note = match note {
                Some(note) => normalize_nullable_text(note.as_deref()),
                None => current_note,
            };
            let next_sort_order = sort_order
                .map(i32::try_from)
                .transpose()
                .map_err(|_| StoreError::InvalidInput)?
                .unwrap_or(current_sort_order);
            let next_is_primary = is_primary.unwrap_or(current_is_primary);
            if next_is_primary {
                sqlx::query(
                    "UPDATE project_resource_attachments
                     SET is_primary=false, updated_at=now()
                     WHERE org_id=$1::uuid AND project_id=$2::uuid AND is_primary=true
                       AND id::text<>$3",
                )
                .bind(&command.organization_id)
                .bind(&command.project_id)
                .bind(attachment_id)
                .execute(&mut **tx)
                .await?;
            }
            sqlx::query(
                "UPDATE project_resource_attachments
                 SET role=$4, note=$5, sort_order=$6, is_primary=$7, updated_at=now()
                 WHERE org_id=$1::uuid AND project_id=$2::uuid AND id::text=$3",
            )
            .bind(&command.organization_id)
            .bind(&command.project_id)
            .bind(attachment_id)
            .bind(&next_role)
            .bind(&next_note)
            .bind(next_sort_order)
            .bind(next_is_primary)
            .execute(&mut **tx)
            .await?;
            let response = read_resource_attachment_response(tx, command, attachment_id).await?;

            let mut details = Map::new();
            if let Some(role) = role {
                details.insert("role".to_owned(), Value::String(role.clone()));
            }
            if let Some(note) = note {
                details.insert(
                    "note".to_owned(),
                    note.clone().map(Value::String).unwrap_or(Value::Null),
                );
            }
            if let Some(sort_order) = sort_order {
                details.insert("sortOrder".to_owned(), json!(sort_order));
            }
            if let Some(is_primary) = is_primary {
                details.insert("isPrimary".to_owned(), Value::Bool(*is_primary));
            }
            Ok(ResourceAttachmentActivity {
                action: "project.resource.updated",
                entity_id: attachment_id.clone(),
                details: Value::Object(details),
                response_status: 200,
                response,
            })
        }
        ResourceAttachmentOperation::Remove { attachment_id } => {
            let response = read_resource_attachment_response(tx, command, attachment_id).await?;
            let resource_id = response
                .get("resourceId")
                .and_then(Value::as_str)
                .ok_or(StoreError::InvalidProjection)?;
            sqlx::query(
                "DELETE FROM project_resource_attachments
                 WHERE org_id=$1::uuid AND project_id=$2::uuid AND id::text=$3",
            )
            .bind(&command.organization_id)
            .bind(&command.project_id)
            .bind(attachment_id)
            .execute(&mut **tx)
            .await?;
            Ok(ResourceAttachmentActivity {
                action: "project.resource.detached",
                entity_id: attachment_id.clone(),
                details: json!({ "resourceId": resource_id }),
                response_status: 200,
                response,
            })
        }
    }
}

async fn read_resource_attachment_response(
    tx: &mut transaction::Tx<'_>,
    command: &ProjectPatchCommand,
    attachment_id: &str,
) -> Result<Value, StoreError> {
    let row = sqlx::query(
        "SELECT a.id::text AS attachment_id,
                a.org_id::text AS attachment_org_id,
                a.project_id::text AS project_id,
                a.resource_id::text AS resource_id,
                a.role,
                a.note,
                a.sort_order,
                a.is_primary,
                to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS attachment_created_at,
                to_char(a.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS attachment_updated_at,
                r.org_id::text AS resource_org_id,
                r.name AS resource_name,
                r.kind AS resource_kind,
                r.source_type AS resource_source_type,
                r.locator AS resource_locator,
                r.description AS resource_description,
                r.metadata::text AS resource_metadata,
                to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS resource_created_at,
                to_char(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS resource_updated_at
         FROM project_resource_attachments a
         JOIN organization_resources r
           ON r.org_id=a.org_id AND r.id=a.resource_id
         WHERE a.org_id=$1::uuid AND a.project_id=$2::uuid AND a.id::text=$3
         FOR UPDATE OF a",
    )
    .bind(&command.organization_id)
    .bind(&command.project_id)
    .bind(attachment_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(StoreError::NotFound)?;
    let resource_metadata: Option<String> = row.try_get("resource_metadata")?;
    let resource_metadata = resource_metadata
        .map(|metadata| serde_json::from_str(&metadata).map_err(|_| StoreError::InvalidProjection))
        .transpose()?
        .unwrap_or(Value::Null);

    Ok(json!({
        "id": row.try_get::<String, _>("attachment_id")?,
        "orgId": row.try_get::<String, _>("attachment_org_id")?,
        "projectId": row.try_get::<String, _>("project_id")?,
        "resourceId": row.try_get::<String, _>("resource_id")?,
        "role": row.try_get::<String, _>("role")?,
        "note": row.try_get::<Option<String>, _>("note")?,
        "sortOrder": row.try_get::<i32, _>("sort_order")?,
        "isPrimary": row.try_get::<bool, _>("is_primary")?,
        "resource": {
            "id": row.try_get::<String, _>("resource_id")?,
            "orgId": row.try_get::<String, _>("resource_org_id")?,
            "name": row.try_get::<String, _>("resource_name")?,
            "kind": row.try_get::<String, _>("resource_kind")?,
            "sourceType": row.try_get::<String, _>("resource_source_type")?,
            "locator": row.try_get::<String, _>("resource_locator")?,
            "description": row.try_get::<Option<String>, _>("resource_description")?,
            "metadata": resource_metadata,
            "createdAt": row.try_get::<String, _>("resource_created_at")?,
            "updatedAt": row.try_get::<String, _>("resource_updated_at")?,
        },
        "createdAt": row.try_get::<String, _>("attachment_created_at")?,
        "updatedAt": row.try_get::<String, _>("attachment_updated_at")?,
    }))
}

async fn read_existing_attachments(
    tx: &mut transaction::Tx<'_>,
    command: &ProjectPatchCommand,
) -> Result<Vec<Attachment>, StoreError> {
    let rows = sqlx::query(
        "SELECT resource_id::text, role, note, sort_order, is_primary
         FROM project_resource_attachments
         WHERE org_id=$1::uuid AND project_id=$2::uuid
         ORDER BY sort_order, created_at
         FOR UPDATE",
    )
    .bind(&command.organization_id)
    .bind(&command.project_id)
    .fetch_all(&mut **tx)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(Attachment {
                resource_id: row.try_get("resource_id")?,
                role: row.try_get("role")?,
                note: row.try_get("note")?,
                sort_order: Some(
                    u64::try_from(row.try_get::<i32, _>("sort_order")?)
                        .map_err(|_| StoreError::InvalidInput)?,
                ),
                is_primary: row.try_get("is_primary")?,
            })
        })
        .collect()
}

async fn create_or_reuse_resource(
    tx: &mut transaction::Tx<'_>,
    command: &ProjectPatchCommand,
    input: &InlineResourceInput,
) -> Result<String, StoreError> {
    let source_type = input.source_type.as_deref().unwrap_or("external");
    let locator = input.locator.trim();
    if source_type == "library"
        && let Some(existing) = sqlx::query_scalar::<_, String>(
            "SELECT id::text FROM organization_resources
             WHERE org_id=$1::uuid AND source_type='library' AND locator=$2
             LIMIT 1 FOR UPDATE",
        )
        .bind(&command.organization_id)
        .bind(locator)
        .fetch_optional(&mut **tx)
        .await?
    {
        return Ok(existing);
    }
    let metadata = input
        .metadata
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|_| StoreError::InvalidInput)?;
    sqlx::query_scalar(
        "INSERT INTO organization_resources
           (org_id, name, kind, source_type, locator, description, metadata)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb)
         RETURNING id::text",
    )
    .bind(&command.organization_id)
    .bind(input.name.trim())
    .bind(&input.kind)
    .bind(source_type)
    .bind(locator)
    .bind(normalize_nullable_text(input.description.as_deref()))
    .bind(metadata)
    .fetch_one(&mut **tx)
    .await
    .map_err(StoreError::from)
}

fn normalize_nullable_text(value: Option<&str>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_owned())
    })
}

fn hex_digest(digest: impl IntoIterator<Item = u8>) -> String {
    digest
        .into_iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
