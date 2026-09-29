use crate::{CommittedMutation, StoreError, project_patches::Patch, transaction};
use serde_json::{Value, json};
use sqlx::Row;
use std::{collections::HashSet, future::Future, pin::Pin};
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct ProjectCreateCommand {
    pub organization_id: String,
    pub actor_kind: String,
    pub actor_id: String,
    pub run_id: Option<String>,
    pub idempotency_key: String,
    /// The complete existing service input, before mutable default resolution.
    pub data: Value,
    pub activity_details: Value,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectCreateProvisionRequest {
    pub organization_id: String,
    pub project_id: String,
    pub project_name: String,
    pub project_url_key: String,
    pub idempotency_key: String,
    pub request_fingerprint: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectCreateProvisioned {
    pub organization_workspace_root: String,
}

/// Required synchronous readiness boundary, supplied by the native host.
/// Implementations must be retry-safe across rolled-back SQL transactions and
/// process restarts. A failed hook rolls back every SQL effect; it cannot roll
/// back filesystem effects. Receipt replay never calls this hook.
/// Before touching shared Library paths, bind the full resolved intent in
/// host-private durable storage. Changed bindings must return
/// `StoreError::ProvisioningConflict`, allowing HTTP adapters to return 409.
pub trait ProjectCreateProvisioner: Send + Sync {
    fn provision<'a>(
        &'a self,
        request: &'a ProjectCreateProvisionRequest,
    ) -> Pin<Box<dyn Future<Output = Result<ProjectCreateProvisioned, StoreError>> + Send + 'a>>;
}

pub(crate) struct Input {
    patch: Patch,
    pause_reason: Option<String>,
    paused_at: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

impl Input {
    pub(crate) fn parse(data: &Value) -> Result<Self, StoreError> {
        let mut fields = data.as_object().ok_or(StoreError::InvalidInput)?.clone();
        if let Some(id) = fields.remove("id") {
            input_uuid(id.as_str().ok_or(StoreError::InvalidInput)?)?;
        }
        fn text(
            fields: &mut serde_json::Map<String, Value>,
            key: &str,
            nullable: bool,
        ) -> Result<Option<String>, StoreError> {
            match fields.remove(key) {
                None => Ok(None),
                Some(Value::Null) if nullable => Ok(None),
                Some(Value::String(value)) => Ok(Some(value)),
                _ => Err(StoreError::InvalidInput),
            }
        }
        let pause_reason = text(&mut fields, "pauseReason", true)?;
        let paused_at = text(&mut fields, "pausedAt", true)?;
        let created_at = text(&mut fields, "createdAt", false)?;
        let updated_at = text(&mut fields, "updatedAt", false)?;
        if fields.contains_key("resourceAttachmentOperation") {
            return Err(StoreError::InvalidInput);
        }
        let mut patch = Patch::parse(&Value::Object(fields))?;
        // Public UUID validators and PostgreSQL accept uppercase references;
        // compare and return PostgreSQL's canonical lowercase representation.
        for id in patch.goal_ids.iter_mut().flatten() {
            *id = input_uuid(id)?;
        }
        if let Some(Some(id)) = &mut patch.lead_agent_id {
            *id = input_uuid(id)?;
        }
        for attachment in patch.resource_attachments.iter_mut().flatten() {
            attachment.resource_id = input_uuid(&attachment.resource_id)?;
        }
        if patch.name.is_none() {
            return Err(StoreError::InvalidInput);
        }
        Ok(Self {
            patch,
            pause_reason,
            paused_at,
            created_at,
            updated_at,
        })
    }
}

/// Namespace- and command-derived UUIDv5: an uncommitted retry must reach the
/// same identity without a second business transaction.
/// Shared URL resolvers currently recognize only UUID versions 1 through 5.
/// The full request/actor binding is checked separately in the receipt/marker.
pub(crate) fn project_id(command: &ProjectCreateCommand) -> Result<String, StoreError> {
    if let Some(id) = command.data.get("id") {
        return input_uuid(id.as_str().ok_or(StoreError::InvalidInput)?);
    }
    let identity = json!([
        "rudder.project-create.id.v1",
        command.organization_id,
        command.idempotency_key
    ]);
    let name = serde_json::to_vec(&identity).map_err(|_| StoreError::InvalidInput)?;
    Ok(Uuid::new_v5(&Uuid::NAMESPACE_URL, &name).to_string())
}

fn input_uuid(value: &str) -> Result<String, StoreError> {
    let canonical = value.to_ascii_lowercase();
    transaction::uuid(&canonical)?;
    Ok(canonical)
}

pub(crate) async fn apply(
    tx: &mut transaction::Tx<'_>,
    command: ProjectCreateCommand,
    input: Input,
    metadata: &transaction::Metadata,
    provisioner: &dyn ProjectCreateProvisioner,
) -> Result<CommittedMutation, StoreError> {
    transaction::lock_organization_boundary(tx, metadata).await?;
    transaction::authorize_project_delete_caller(tx, metadata).await?;
    if let Some(receipt) = transaction::replay(tx, metadata).await? {
        return Ok(receipt);
    }
    // Serialize against organization deletion without claiming its ownership.
    let exists = sqlx::query("SELECT id FROM organizations WHERE id=$1::uuid FOR UPDATE")
        .bind(&metadata.org)
        .fetch_optional(&mut **tx)
        .await?;
    if exists.is_none() {
        return Err(StoreError::NotFound);
    }
    let id = metadata
        .project_id
        .as_deref()
        .ok_or(StoreError::InvalidInput)?;
    let patch = &input.patch;
    let goal_ids = patch.goal_ids.as_deref().unwrap_or_default();
    let mut seen = HashSet::new();
    for goal in goal_ids {
        transaction::uuid(goal)?;
        if !seen.insert(goal) {
            return Err(StoreError::InvalidInput);
        }
    }
    let goals = sqlx::query("SELECT id::text, title FROM goals WHERE org_id=$1::uuid AND id=ANY($2::text[]::uuid[]) ORDER BY id FOR UPDATE")
        .bind(&metadata.org).bind(goal_ids).fetch_all(&mut **tx).await?;
    if goals.len() != goal_ids.len() {
        return Err(StoreError::InvalidInput);
    }
    if let Some(Some(agent)) = &patch.lead_agent_id {
        transaction::uuid(agent)?;
        let found = sqlx::query(
            "SELECT id FROM agents WHERE org_id=$1::uuid AND id=$2::uuid FOR KEY SHARE",
        )
        .bind(&metadata.org)
        .bind(agent)
        .fetch_optional(&mut **tx)
        .await?;
        if found.is_none() {
            return Err(StoreError::InvalidInput);
        }
    }
    let existing = sqlx::query("SELECT name, color FROM projects WHERE org_id=$1::uuid")
        .bind(&metadata.org)
        .fetch_all(&mut **tx)
        .await?;
    let names: Vec<String> = existing
        .iter()
        .map(|row| row.try_get("name"))
        .collect::<Result<_, _>>()?;
    let colors: Vec<Option<String>> = existing
        .iter()
        .map(|row| row.try_get("color"))
        .collect::<Result<_, _>>()?;
    let name = resolve_name(
        patch.name.as_deref().ok_or(StoreError::InvalidInput)?,
        &names,
    );
    let color = patch
        .color
        .as_ref()
        .and_then(Option::as_deref)
        .filter(|color| !color.is_empty())
        .unwrap_or_else(|| default_color(&colors));
    let icon = patch
        .icon
        .as_ref()
        .and_then(Option::as_deref)
        .unwrap_or("folder");
    let policy = patch
        .execution_workspace_policy
        .as_ref()
        .and_then(Option::as_ref)
        .map(serde_json::to_string)
        .transpose()
        .map_err(|_| StoreError::InvalidInput)?;
    sqlx::query(
        "INSERT INTO projects (id, org_id, goal_id, name, description, status, lead_agent_id,
          target_date, color, icon, pause_reason, paused_at, execution_workspace_policy,
          archived_at, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid, $8::date, $9, $10,
          $11, $12::timestamptz, $13::jsonb, $14::timestamptz,
          COALESCE($15::timestamptz, now()), COALESCE($16::timestamptz, now()))",
    )
    .bind(id)
    .bind(&metadata.org)
    .bind(goal_ids.first())
    .bind(&name)
    .bind(patch.description.as_ref().and_then(Option::as_deref))
    .bind(patch.status.as_deref().unwrap_or("backlog"))
    .bind(patch.lead_agent_id.as_ref().and_then(Option::as_deref))
    .bind(patch.target_date.as_ref().and_then(Option::as_deref))
    .bind(color)
    .bind(icon)
    .bind(&input.pause_reason)
    .bind(&input.paused_at)
    .bind(policy)
    .bind(patch.archived_at.as_ref().and_then(Option::as_deref))
    .bind(&input.created_at)
    .bind(&input.updated_at)
    .execute(&mut **tx)
    .await?;
    // Only the newly inserted incarnation may be adopted. Never upsert a
    // Project or steal an existing component when an explicit UUID conflicts.
    let adopted = sqlx::query(
        "UPDATE project_goal_mutation_state SET owner='rust', mutation_version=1,
         fence_epoch=1, fence_token=gen_random_uuid(), updated_at=now()
         WHERE org_id=$1::uuid AND project_id=$2::uuid AND owner='node'
           AND mutation_version=0 AND fence_epoch=0",
    )
    .bind(&metadata.org)
    .bind(id)
    .execute(&mut **tx)
    .await?;
    if adopted.rows_affected() != 1 {
        return Err(StoreError::NotOwned);
    }
    for goal in goal_ids {
        sqlx::query("INSERT INTO project_goals (org_id, project_id, goal_id) VALUES ($1::uuid,$2::uuid,$3::uuid)")
            .bind(&metadata.org).bind(id).bind(goal).execute(&mut **tx).await?;
    }
    create_resources(tx, &metadata.org, id, patch).await?;
    let url_key = normalize_key(&name).unwrap_or_else(|| id.to_owned());
    let provisioned = provisioner
        .provision(&ProjectCreateProvisionRequest {
            organization_id: metadata.org.clone(),
            project_id: id.to_owned(),
            project_name: name.clone(),
            project_url_key: url_key.clone(),
            idempotency_key: metadata.key.clone(),
            request_fingerprint: metadata.fingerprint.clone(),
        })
        .await?;
    if provisioned.organization_workspace_root.is_empty() {
        return Err(StoreError::Provisioning(
            "missing organization workspace root".to_owned(),
        ));
    }
    let mut response = project_response(tx, &metadata.org, id).await?;
    let goal_refs: Vec<Value> = goal_ids.iter().map(|goal| {
        let row = goals.iter().find(|row| row.get::<String, _>("id") == *goal).expect("validated goal");
        json!({"id": goal, "shortRef": format!("gol_{}", &goal[..8]), "title": row.get::<String, _>("title")})
    }).collect();
    response["shortRef"] = json!(format!("prj_{}", &id[..8]));
    response["urlKey"] = json!(url_key);
    response["goalIds"] = json!(goal_ids);
    response["goals"] = json!(goal_refs);
    response["executionWorkspacePolicy"] = normalize_policy(&response["executionWorkspacePolicy"]);
    response["resources"] = resource_response(tx, &metadata.org, id).await?;
    response["workspaces"] = json!([]);
    response["primaryWorkspace"] = Value::Null;
    response["codebase"] = json!({
        "configured": true, "scope": "organization", "workspaceId": null, "repoUrl": null,
        "repoRef": null, "defaultRef": null, "repoName": null,
        "localFolder": provisioned.organization_workspace_root,
        "managedFolder": provisioned.organization_workspace_root,
        "effectiveLocalFolder": provisioned.organization_workspace_root, "origin": "local_folder",
    });
    let mut details = command.activity_details;
    details["name"] = json!(name);
    transaction::persist_project_create(tx, metadata, response, details).await
}

const COLORS: &[&str] = &[
    "linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)",
    "linear-gradient(135deg, #7c3aed 0%, #d946ef 100%)",
    "linear-gradient(135deg, #db2777 0%, #f97316 100%)",
    "linear-gradient(135deg, #ef4444 0%, #f59e0b 100%)",
    "linear-gradient(135deg, #f97316 0%, #facc15 100%)",
    "linear-gradient(135deg, #10b981 0%, #84cc16 100%)",
    "linear-gradient(135deg, #059669 0%, #14b8a6 100%)",
    "linear-gradient(135deg, #0d9488 0%, #06b6d4 100%)",
    "linear-gradient(135deg, #0284c7 0%, #2563eb 100%)",
    "linear-gradient(135deg, #2563eb 0%, #4f46e5 100%)",
    "linear-gradient(135deg, #f43f5e 0%, #ec4899 100%)",
    "linear-gradient(135deg, #be123c 0%, #7c2d12 100%)",
    "linear-gradient(135deg, #a16207 0%, #ca8a04 100%)",
    "linear-gradient(135deg, #16a34a 0%, #0f766e 100%)",
    "linear-gradient(135deg, #0891b2 0%, #4338ca 100%)",
    "linear-gradient(135deg, #6d28d9 0%, #be185d 100%)",
    "linear-gradient(135deg, #475569 0%, #0f766e 100%)",
    "linear-gradient(135deg, #334155 0%, #7c3aed 100%)",
];

fn default_color(colors: &[Option<String>]) -> &'static str {
    COLORS
        .iter()
        .copied()
        .find(|color| !colors.iter().any(|used| used.as_deref() == Some(color)))
        .unwrap_or(COLORS[colors.len() % COLORS.len()])
}

fn normalize_key(name: &str) -> Option<String> {
    let mut key = String::new();
    let mut separator = false;
    for ch in name.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            if separator && !key.is_empty() {
                key.push('-');
            }
            key.push(ch);
            separator = false;
        } else {
            separator = true;
        }
    }
    (!key.is_empty()).then_some(key)
}

fn resolve_name(name: &str, existing: &[String]) -> String {
    let used: HashSet<_> = existing
        .iter()
        .filter_map(|name| normalize_key(name))
        .collect();
    if normalize_key(name).is_none_or(|key| !used.contains(&key)) {
        return name.to_owned();
    }
    for suffix in 2..10_000 {
        let candidate = format!("{name} {suffix}");
        if normalize_key(&candidate).is_some_and(|key| !used.contains(&key)) {
            return candidate;
        }
    }
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{name} {millis}")
}

fn nullable_text(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

async fn create_resources(
    tx: &mut transaction::Tx<'_>,
    org: &str,
    project: &str,
    patch: &Patch,
) -> Result<(), StoreError> {
    let mut attachments = patch.resource_attachments.clone().unwrap_or_default();
    for resource in patch.new_resources.as_deref().unwrap_or_default() {
        let source = resource.source_type.as_deref().unwrap_or("external");
        let locator = resource.locator.trim();
        let existing = if source == "library" {
            sqlx::query_scalar::<_, String>("SELECT id::text FROM organization_resources WHERE org_id=$1::uuid AND source_type='library' AND locator=$2 LIMIT 1 FOR UPDATE")
                .bind(org).bind(locator).fetch_optional(&mut **tx).await?
        } else {
            None
        };
        let id = if let Some(id) = existing {
            id
        } else {
            let metadata = resource
                .metadata
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|_| StoreError::InvalidInput)?;
            sqlx::query_scalar("INSERT INTO organization_resources (org_id, name, kind, source_type, locator, description, metadata) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id::text")
                .bind(org).bind(resource.name.trim()).bind(&resource.kind).bind(source).bind(locator)
                .bind(nullable_text(resource.description.as_deref())).bind(metadata).fetch_one(&mut **tx).await?
        };
        attachments.push(crate::project_patches::ResourceAttachmentInput {
            resource_id: id,
            role: resource.role.clone(),
            note: resource.note.clone(),
            sort_order: resource.sort_order,
            is_primary: resource.is_primary,
        });
    }
    let mut seen = HashSet::new();
    attachments.retain(|attachment| seen.insert(attachment.resource_id.clone()));
    if attachments
        .iter()
        .filter(|attachment| attachment.is_primary == Some(true))
        .count()
        > 1
    {
        return Err(StoreError::InvalidResource);
    }
    let ids = attachments
        .iter()
        .map(|attachment| transaction::uuid(&attachment.resource_id).map(str::to_owned))
        .collect::<Result<Vec<_>, _>>()?;
    let found = sqlx::query("SELECT id FROM organization_resources WHERE org_id=$1::uuid AND id=ANY($2::text[]::uuid[]) ORDER BY id FOR KEY SHARE")
        .bind(org).bind(&ids).fetch_all(&mut **tx).await?;
    if found.len() != ids.len() {
        return Err(StoreError::InvalidInput);
    }
    for (index, attachment) in attachments.iter().enumerate() {
        let order = i32::try_from(attachment.sort_order.unwrap_or(index as u64))
            .map_err(|_| StoreError::InvalidInput)?;
        sqlx::query("INSERT INTO project_resource_attachments (org_id, project_id, resource_id, role, note, sort_order, is_primary) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7)")
            .bind(org).bind(project).bind(&attachment.resource_id).bind(attachment.role.as_deref().unwrap_or("reference"))
            .bind(nullable_text(attachment.note.as_deref())).bind(order).bind(attachment.is_primary.unwrap_or(false))
            .execute(&mut **tx).await?;
    }
    Ok(())
}

fn camel_row(raw: &str) -> Result<Value, StoreError> {
    let source: serde_json::Map<String, Value> =
        serde_json::from_str(raw).map_err(|_| StoreError::InvalidReceipt)?;
    let mut result = serde_json::Map::new();
    for (key, value) in source {
        let mut parts = key.split('_');
        let mut camel = parts.next().unwrap_or_default().to_owned();
        for part in parts {
            let mut chars = part.chars();
            if let Some(first) = chars.next() {
                camel.extend(first.to_uppercase());
            }
            camel.extend(chars);
        }
        result.insert(camel, value);
    }
    Ok(Value::Object(result))
}

async fn project_response(
    tx: &mut transaction::Tx<'_>,
    org: &str,
    project: &str,
) -> Result<Value, StoreError> {
    let raw: String = sqlx::query_scalar(
        "SELECT (to_jsonb(p) || jsonb_build_object(
          'created_at', to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
          'updated_at', to_char(p.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
          'paused_at', to_char(p.paused_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
          'archived_at', to_char(p.archived_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
         ))::text FROM projects p WHERE p.org_id=$1::uuid AND p.id=$2::uuid")
        .bind(org).bind(project).fetch_one(&mut **tx).await?;
    camel_row(&raw)
}

async fn resource_response(
    tx: &mut transaction::Tx<'_>,
    org: &str,
    project: &str,
) -> Result<Value, StoreError> {
    let rows = sqlx::query(
        "SELECT (to_jsonb(a) || jsonb_build_object(
          'created_at', to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
          'updated_at', to_char(a.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')))::text AS attachment,
         (to_jsonb(r) || jsonb_build_object(
          'created_at', to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
          'updated_at', to_char(r.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')))::text AS resource
         FROM project_resource_attachments a JOIN organization_resources r ON r.id=a.resource_id AND r.org_id=a.org_id
         WHERE a.org_id=$1::uuid AND a.project_id=$2::uuid ORDER BY a.sort_order, a.created_at")
        .bind(org).bind(project).fetch_all(&mut **tx).await?;
    rows.iter()
        .map(|row| {
            let mut attachment = camel_row(&row.try_get::<String, _>("attachment")?)?;
            attachment["resource"] = camel_row(&row.try_get::<String, _>("resource")?)?;
            Ok(attachment)
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Value::Array)
}

fn normalize_policy(raw: &Value) -> Value {
    let Some(source) = raw.as_object().filter(|object| !object.is_empty()) else {
        return Value::Null;
    };
    let mut result =
        json!({"enabled": source.get("enabled").and_then(Value::as_bool).unwrap_or(false)});
    if let Some(mode) = source.get("defaultMode").and_then(Value::as_str) {
        let normalized = match mode {
            "project_primary" => "shared_workspace",
            "isolated" => "isolated_workspace",
            other => other,
        };
        if matches!(
            normalized,
            "shared_workspace" | "isolated_workspace" | "operator_branch" | "adapter_default"
        ) {
            result["defaultMode"] = json!(normalized);
        }
    }
    if let Some(value) = source
        .get("allowIssueOverride")
        .filter(|value| value.is_boolean())
    {
        result["allowIssueOverride"] = value.clone();
    }
    if let Some(value) = source
        .get("defaultProjectWorkspaceId")
        .filter(|value| value.as_str().is_some_and(|value| !value.is_empty()))
    {
        result["defaultProjectWorkspaceId"] = value.clone();
    }
    for key in [
        "workspaceRuntime",
        "branchPolicy",
        "pullRequestPolicy",
        "runtimePolicy",
        "cleanupPolicy",
    ] {
        if let Some(value) = source.get(key).filter(|value| value.is_object()) {
            result[key] = value.clone();
        }
    }
    if let Some(strategy) = source.get("workspaceStrategy").and_then(Value::as_object)
        && strategy
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| {
                matches!(
                    kind,
                    "project_primary" | "git_worktree" | "adapter_managed" | "cloud_sandbox"
                )
            })
    {
        let mut normalized = json!({"type": strategy["type"]});
        for key in [
            "baseRef",
            "branchTemplate",
            "worktreeParentDir",
            "provisionCommand",
            "teardownCommand",
        ] {
            if let Some(value) = strategy.get(key).filter(|value| value.is_string()) {
                normalized[key] = value.clone();
            }
        }
        result["workspaceStrategy"] = normalized;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_identity_is_restart_stable_but_receipt_binds_raw_request_and_actor() {
        let command = ProjectCreateCommand {
            organization_id: "10000000-0000-4000-8000-000000000001".to_owned(),
            actor_kind: "board".to_owned(),
            actor_id: "synthetic".to_owned(),
            run_id: None,
            idempotency_key: "create-key".to_owned(),
            data: json!({"name":"Plan"}),
            activity_details: json!({}),
        };
        let base = transaction::Metadata::project_create(&command).unwrap();
        let id = project_id(&command).unwrap();
        assert_eq!(transaction::uuid(&id).unwrap(), id);
        assert_eq!(id, "8dfeea11-635c-54e9-918b-889aa60d0f68");
        assert_eq!(Uuid::parse_str(&id).unwrap().get_version_num(), 5);
        assert_eq!(project_id(&command).unwrap(), id);
        for field in ["data", "actor", "run", "audit", "org", "key"] {
            let mut changed = command.clone();
            match field {
                "data" => changed.data["name"] = json!("Changed"),
                "actor" => changed.actor_id = "another".to_owned(),
                "run" => changed.run_id = Some("20000000-0000-4000-8000-000000000001".to_owned()),
                "audit" => changed.activity_details = json!({"source":"other"}),
                "org" => {
                    changed.organization_id = "10000000-0000-4000-8000-000000000002".to_owned()
                }
                "key" => changed.idempotency_key = "another-key".to_owned(),
                _ => unreachable!(),
            }
            assert_ne!(
                transaction::Metadata::project_create(&changed)
                    .unwrap()
                    .fingerprint,
                base.fingerprint
            );
            if !matches!(field, "org" | "key") {
                assert_eq!(project_id(&changed).unwrap(), id);
            } else {
                assert_ne!(project_id(&changed).unwrap(), id);
            }
        }
        assert!(Input::parse(&json!({"name":"Plan","orgId":command.organization_id})).is_err());
        assert!(Input::parse(&json!({"name":"Plan","resourceAttachmentOperation":{}})).is_err());
    }

    #[test]
    fn create_defaults_precedence_and_legacy_policy() {
        let input =
            Input::parse(&json!({"name":"Synthetic", "goalId":"unused", "goalIds":[]})).unwrap();
        assert_eq!(input.patch.goal_ids, Some(vec![]));
        assert_eq!(
            resolve_name("Plan", &["plan".to_owned(), "Plan 2".to_owned()]),
            "Plan 3"
        );
        assert_eq!(resolve_name("東京", &["東京".to_owned()]), "東京");
        assert_eq!(default_color(&[Some(COLORS[0].to_owned())]), COLORS[1]);
        assert_eq!(
            normalize_policy(
                &json!({"defaultMode":"isolated", "workspaceStrategy":{"type":"git_worktree","baseRef":null}})
            ),
            json!({"enabled":false,"defaultMode":"isolated_workspace","workspaceStrategy":{"type":"git_worktree"}})
        );
    }
}
