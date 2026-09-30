use crate::{
    COMMAND_KIND_ORGANIZATION_RESOURCE, CommittedMutation, OrganizationResourceCommand,
    OrganizationResourceOperation, Outcome, Receipt, ResultState, StoreError, transaction,
};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};

const RECEIPT_FORMAT: i32 = 1;
const MAX_COMMAND_BYTES: usize = transaction::MAX_RESULT_BYTES / 2;

#[derive(Clone, Debug, Eq, PartialEq)]
enum PatchField<T> {
    Unset,
    Set(T),
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ResourcePatch {
    name: Option<String>,
    kind: Option<String>,
    source_type: Option<String>,
    locator: Option<String>,
    description: PatchField<Option<String>>,
    metadata: PatchField<Option<Value>>,
}

#[derive(Clone, Debug)]
struct ResourceRow {
    id: String,
    org_id: String,
    name: String,
    kind: String,
    source_type: String,
    locator: String,
    description: Option<String>,
    metadata: Option<Value>,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, Debug)]
struct ResourceAuthority {
    owner: String,
    version: u64,
    fence_epoch: u64,
    fence_token: String,
}

pub(crate) async fn mutate(
    pool: &PgPool,
    command: OrganizationResourceCommand,
) -> Result<CommittedMutation, StoreError> {
    let organization_id = canonical_uuid(&command.organization_id)?;
    let resource_id = canonical_uuid(&command.resource_id)?;
    if command.actor_kind != "board" || command.actor_id.is_empty() {
        return Err(StoreError::Unauthorized);
    }
    if command.actor_id.len() > 256
        || command
            .actor_id
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_control())
    {
        return Err(StoreError::InvalidInput);
    }
    if command.idempotency_key.is_empty()
        || command.idempotency_key.len() > 256
        || command
            .idempotency_key
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_control())
    {
        return Err(StoreError::InvalidInput);
    }
    let run_id = command.run_id.as_deref().map(canonical_uuid).transpose()?;
    let patch = match command.operation {
        OrganizationResourceOperation::Update => Some(ResourcePatch::parse(&command.data)?),
        OrganizationResourceOperation::Delete => {
            if command
                .data
                .as_object()
                .is_none_or(|object| !object.is_empty())
            {
                return Err(StoreError::InvalidResource);
            }
            None
        }
    };
    let fingerprint = command_fingerprint(
        &organization_id,
        &resource_id,
        &command.actor_id,
        run_id.as_deref(),
        &command.idempotency_key,
        command.operation,
        &command.data,
    )?;

    let mut tx = transaction::begin(pool).await?;
    let result = apply(
        &mut tx,
        &command,
        &organization_id,
        &resource_id,
        run_id.as_deref(),
        patch,
        &fingerprint,
    )
    .await;
    transaction::finish(tx, result).await
}

async fn apply(
    tx: &mut transaction::Tx<'_>,
    command: &OrganizationResourceCommand,
    organization_id: &str,
    resource_id: &str,
    run_id: Option<&str>,
    patch: Option<ResourcePatch>,
    fingerprint: &str,
) -> Result<CommittedMutation, StoreError> {
    lock_organization(tx, organization_id).await?;
    if let Some(receipt) = replay(
        tx,
        organization_id,
        resource_id,
        &command.idempotency_key,
        command.operation,
        fingerprint,
    )
    .await?
    {
        return Ok(receipt);
    }

    let authority = lock_resource_authority(tx, organization_id, resource_id).await?;
    let rust_project_attached =
        lock_attached_project_owners(tx, organization_id, resource_id).await?;
    if authority.owner != "rust" && !rust_project_attached {
        return Err(StoreError::NotOwned);
    }

    let current = load_resource(tx, organization_id, resource_id)
        .await?
        .ok_or(StoreError::NotFound)?;
    let (response, details, action) = match command.operation {
        OrganizationResourceOperation::Update => {
            let next = apply_update(
                tx,
                organization_id,
                resource_id,
                current,
                patch.ok_or(StoreError::InvalidInput)?,
            )
            .await?;
            (
                resource_response(&next),
                command.data.clone(),
                "organization.resource.updated",
            )
        }
        OrganizationResourceOperation::Delete => {
            let deleted = sqlx::query(
                "DELETE FROM organization_resources
                 WHERE id=$1::uuid AND org_id=$2::uuid",
            )
            .bind(resource_id)
            .bind(organization_id)
            .execute(&mut **tx)
            .await?;
            if deleted.rows_affected() != 1 {
                return Err(StoreError::NotFound);
            }
            (
                resource_response(&current),
                json!({ "name": current.name }),
                "organization.resource.deleted",
            )
        }
    };

    let next_version = authority
        .version
        .checked_add(1)
        .ok_or(StoreError::VersionRange)?;
    let next_fence_epoch = if authority.owner == "rust" {
        authority.fence_epoch
    } else {
        authority
            .fence_epoch
            .checked_add(1)
            .ok_or(StoreError::VersionRange)?
    };
    transaction::signed(next_version)?;
    transaction::signed(next_fence_epoch)?;
    let fenced = sqlx::query(
        "UPDATE organization_resource_mutation_state
         SET owner='rust',
             mutation_version=$4,
             fence_epoch=$5,
             fence_token=CASE WHEN owner <> 'rust' THEN gen_random_uuid() ELSE fence_token END,
             updated_at=now()
         WHERE resource_id=$1::uuid
           AND org_id=$2::uuid
           AND owner=$3
           AND mutation_version=$6
           AND fence_epoch=$7
           AND fence_token=$8::uuid",
    )
    .bind(resource_id)
    .bind(organization_id)
    .bind(&authority.owner)
    .bind(transaction::signed(next_version)?)
    .bind(transaction::signed(next_fence_epoch)?)
    .bind(transaction::signed(authority.version)?)
    .bind(transaction::signed(authority.fence_epoch)?)
    .bind(&authority.fence_token)
    .execute(&mut **tx)
    .await?;
    if fenced.rows_affected() != 1 {
        return Err(StoreError::StaleFence);
    }

    let activity_id: String = sqlx::query_scalar(
        "INSERT INTO activity_log
          (org_id, actor_type, actor_id, action, entity_type, entity_id,
           agent_id, run_id, details, idempotency_key)
         VALUES ($1::uuid, 'user', $2, $3, 'organization_resource', $4,
                 NULL, $5::uuid, $6::jsonb, $7)
         RETURNING id::text",
    )
    .bind(organization_id)
    .bind(&command.actor_id)
    .bind(action)
    .bind(resource_id)
    .bind(run_id)
    .bind(serde_json::to_string(&details).map_err(|_| StoreError::InvalidReceipt)?)
    .bind(activity_idempotency_key(&command.idempotency_key))
    .fetch_one(&mut **tx)
    .await?;

    let receipt = Receipt {
        organization_id: organization_id.to_owned(),
        version: next_version,
        fence_epoch: next_fence_epoch,
        fingerprint: fingerprint.to_owned(),
        activity_id: Some(activity_id.clone()),
        outcome: Outcome::Applied,
        result: ResultState::OrganizationResourceMutated {
            resource_id: resource_id.to_owned(),
            response,
            operation: command.operation,
        },
    };
    validate_receipt(
        &receipt,
        organization_id,
        resource_id,
        command.operation,
        fingerprint,
    )?;
    let receipt_json = serde_json::to_string(&receipt).map_err(|_| StoreError::InvalidReceipt)?;
    if receipt_json.len() > transaction::MAX_RESULT_BYTES {
        return Err(StoreError::InvalidInput);
    }
    sqlx::query(
        "INSERT INTO organization_mutation_receipts
          (org_id, idempotency_key, command_kind, command_fingerprint,
           receipt_format, outcome, resulting_version, fence_epoch,
           activity_id, result)
         VALUES ($1::uuid, $2, $3, $4, $5, 'applied', $6, $7, $8::uuid, $9::jsonb)",
    )
    .bind(organization_id)
    .bind(&command.idempotency_key)
    .bind(COMMAND_KIND_ORGANIZATION_RESOURCE)
    .bind(fingerprint)
    .bind(RECEIPT_FORMAT)
    .bind(transaction::signed(next_version)?)
    .bind(transaction::signed(next_fence_epoch)?)
    .bind(&activity_id)
    .bind(&receipt_json)
    .execute(&mut **tx)
    .await?;

    let event_payload = json!({
        "actorType": "user",
        "actorId": command.actor_id,
        "action": action,
        "entityType": "organization_resource",
        "entityId": resource_id,
        "agentId": null,
        "runId": run_id,
        "details": details,
    });
    ensure_json_size(&event_payload)?;
    sqlx::query(
        "INSERT INTO organization_mutation_outbox
          (org_id, activity_id, event_type, payload)
         VALUES ($1::uuid, $2::uuid, 'activity.logged', $3::jsonb)",
    )
    .bind(organization_id)
    .bind(activity_id)
    .bind(serde_json::to_string(&event_payload).map_err(|_| StoreError::InvalidReceipt)?)
    .execute(&mut **tx)
    .await?;

    Ok(CommittedMutation {
        replayed: false,
        receipt,
    })
}

impl ResourcePatch {
    fn parse(data: &Value) -> Result<Self, StoreError> {
        let object = data.as_object().ok_or(StoreError::InvalidResource)?;
        if object.keys().any(|key| {
            !matches!(
                key.as_str(),
                "name" | "kind" | "sourceType" | "locator" | "description" | "metadata"
            )
        }) {
            return Err(StoreError::InvalidResource);
        }
        let name = optional_nonempty_text(object, "name")?;
        let kind = optional_enum(
            object,
            "kind",
            &["file", "directory", "url", "connector_object"],
        )?;
        let source_type = optional_enum(object, "sourceType", &["external", "library"])?;
        let locator = optional_nonempty_text(object, "locator")?;
        let description = match object.get("description") {
            None => PatchField::Unset,
            Some(Value::Null) => PatchField::Set(None),
            Some(Value::String(value)) => PatchField::Set(normalize_nullable_text(value)),
            _ => return Err(StoreError::InvalidResource),
        };
        let metadata = match object.get("metadata") {
            None => PatchField::Unset,
            Some(Value::Null) => PatchField::Set(None),
            Some(Value::Object(value)) => PatchField::Set(Some(Value::Object(value.clone()))),
            _ => return Err(StoreError::InvalidResource),
        };
        Ok(Self {
            name,
            kind,
            source_type,
            locator,
            description,
            metadata,
        })
    }
}

fn optional_nonempty_text(
    object: &Map<String, Value>,
    key: &str,
) -> Result<Option<String>, StoreError> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::String(value)) if !value.is_empty() => Ok(Some(value.trim().to_owned())),
        _ => Err(StoreError::InvalidResource),
    }
}

fn optional_enum(
    object: &Map<String, Value>,
    key: &str,
    allowed: &[&str],
) -> Result<Option<String>, StoreError> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::String(value)) if allowed.contains(&value.as_str()) => Ok(Some(value.clone())),
        _ => Err(StoreError::InvalidResource),
    }
}

async fn apply_update(
    tx: &mut transaction::Tx<'_>,
    organization_id: &str,
    resource_id: &str,
    current: ResourceRow,
    patch: ResourcePatch,
) -> Result<ResourceRow, StoreError> {
    let name = patch.name.unwrap_or(current.name).trim().to_owned();
    let kind = patch.kind.unwrap_or(current.kind);
    let source_type = patch.source_type.unwrap_or(current.source_type);
    let locator = patch.locator.unwrap_or(current.locator).trim().to_owned();
    let description = match patch.description {
        PatchField::Unset => current.description,
        PatchField::Set(value) => value,
    };
    let metadata = match patch.metadata {
        PatchField::Unset => current.metadata,
        PatchField::Set(value) => value,
    };
    validate_library_resource(&source_type, &kind, &locator)?;
    if source_type == "library" {
        let duplicate = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS (
               SELECT 1 FROM organization_resources
               WHERE org_id=$1::uuid AND source_type='library' AND locator=$2 AND id<>$3::uuid
             )",
        )
        .bind(organization_id)
        .bind(&locator)
        .bind(resource_id)
        .fetch_one(&mut **tx)
        .await?;
        if duplicate {
            return Err(StoreError::ResourceConflict);
        }
    }
    let metadata_json = metadata
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|_| StoreError::InvalidResource)?;
    let updated = sqlx::query(
        "UPDATE organization_resources
         SET name=$3, kind=$4, source_type=$5, locator=$6,
             description=$7, metadata=$8::jsonb, updated_at=now()
         WHERE id=$1::uuid AND org_id=$2::uuid
         RETURNING id::text AS id, org_id::text AS org_id, name, kind, source_type,
                   locator, description, metadata,
                   to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at,
                   to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at",
    )
    .bind(resource_id)
    .bind(organization_id)
    .bind(name)
    .bind(kind)
    .bind(source_type)
    .bind(locator)
    .bind(description)
    .bind(metadata_json)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(StoreError::NotFound)?;
    resource_row(updated)
}

async fn lock_organization(
    tx: &mut transaction::Tx<'_>,
    organization_id: &str,
) -> Result<(), StoreError> {
    let row = sqlx::query(
        "SELECT org_id FROM organization_mutation_state WHERE org_id=$1::uuid FOR UPDATE",
    )
    .bind(organization_id)
    .fetch_optional(&mut **tx)
    .await?;
    if row.is_some() {
        return Ok(());
    }
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM organizations WHERE id=$1::uuid)",
    )
    .bind(organization_id)
    .fetch_one(&mut **tx)
    .await?;
    Err(if exists {
        StoreError::NotOwned
    } else {
        StoreError::NotFound
    })
}

async fn lock_resource_authority(
    tx: &mut transaction::Tx<'_>,
    organization_id: &str,
    resource_id: &str,
) -> Result<ResourceAuthority, StoreError> {
    sqlx::query(
        "INSERT INTO organization_resource_mutation_state (resource_id, org_id)
         SELECT id, org_id FROM organization_resources
         WHERE id=$1::uuid AND org_id=$2::uuid
         ON CONFLICT (resource_id) DO NOTHING",
    )
    .bind(resource_id)
    .bind(organization_id)
    .execute(&mut **tx)
    .await?;
    let row = sqlx::query(
        "SELECT org_id::text AS org_id, owner, mutation_version, fence_epoch,
                fence_token::text AS fence_token
         FROM organization_resource_mutation_state
         WHERE resource_id=$1::uuid
         FOR UPDATE",
    )
    .bind(resource_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(row) = row else {
        let exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM organization_resources WHERE id=$1::uuid AND org_id=$2::uuid)",
        )
        .bind(resource_id)
        .bind(organization_id)
        .fetch_one(&mut **tx)
        .await?;
        return Err(if exists {
            StoreError::NotOwned
        } else {
            StoreError::NotFound
        });
    };
    let state_org: String = row.try_get("org_id")?;
    if state_org != organization_id {
        return Err(StoreError::NotFound);
    }
    let owner: String = row.try_get("owner")?;
    if owner != "node" && owner != "rust" {
        return Err(StoreError::InvalidReceipt);
    }
    let version = transaction::unsigned(row.try_get("mutation_version")?)?;
    let fence_epoch = transaction::unsigned(row.try_get("fence_epoch")?)?;
    let fence_token: String = row.try_get("fence_token")?;
    transaction::uuid(&fence_token)?;
    Ok(ResourceAuthority {
        owner,
        version,
        fence_epoch,
        fence_token,
    })
}

async fn lock_attached_project_owners(
    tx: &mut transaction::Tx<'_>,
    organization_id: &str,
    resource_id: &str,
) -> Result<bool, StoreError> {
    let attachment_count = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM project_resource_attachments WHERE org_id=$1::uuid AND resource_id=$2::uuid",
    )
    .bind(organization_id)
    .bind(resource_id)
    .fetch_one(&mut **tx)
    .await?;
    let rows = sqlx::query(
        "SELECT a.project_id::text AS project_id, p.org_id::text AS project_org_id, s.owner
         FROM project_resource_attachments a
         JOIN projects p ON p.id=a.project_id
         JOIN project_goal_mutation_state s ON s.project_id=a.project_id AND s.org_id=a.org_id
         WHERE a.org_id=$1::uuid AND a.resource_id=$2::uuid
         ORDER BY a.project_id
         FOR UPDATE OF s",
    )
    .bind(organization_id)
    .bind(resource_id)
    .fetch_all(&mut **tx)
    .await?;
    if i64::try_from(rows.len()).map_err(|_| StoreError::InvalidReceipt)? != attachment_count {
        return Err(StoreError::NotOwned);
    }
    let mut rust_owned = false;
    for row in rows {
        let project_org: String = row.try_get("project_org_id")?;
        if project_org != organization_id {
            return Err(StoreError::NotFound);
        }
        match row.try_get::<String, _>("owner")?.as_str() {
            "node" => {}
            "rust" => rust_owned = true,
            _ => return Err(StoreError::InvalidReceipt),
        }
    }
    Ok(rust_owned)
}

async fn load_resource(
    tx: &mut transaction::Tx<'_>,
    organization_id: &str,
    resource_id: &str,
) -> Result<Option<ResourceRow>, StoreError> {
    let row = sqlx::query(
        "SELECT id::text AS id, org_id::text AS org_id, name, kind, source_type,
                locator, description, metadata,
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at,
                to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at
         FROM organization_resources
         WHERE id=$1::uuid AND org_id=$2::uuid
         FOR UPDATE",
    )
    .bind(resource_id)
    .bind(organization_id)
    .fetch_optional(&mut **tx)
    .await?;
    row.map(resource_row).transpose()
}

fn resource_row(row: sqlx::postgres::PgRow) -> Result<ResourceRow, StoreError> {
    Ok(ResourceRow {
        id: row.try_get("id")?,
        org_id: row.try_get("org_id")?,
        name: row.try_get("name")?,
        kind: row.try_get("kind")?,
        source_type: row.try_get("source_type")?,
        locator: row.try_get("locator")?,
        description: row.try_get("description")?,
        metadata: row.try_get("metadata")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn resource_response(row: &ResourceRow) -> Value {
    json!({
        "id": row.id,
        "orgId": row.org_id,
        "name": row.name,
        "kind": row.kind,
        "sourceType": row.source_type,
        "locator": row.locator,
        "description": row.description,
        "metadata": row.metadata,
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
    })
}

fn validate_library_resource(
    source_type: &str,
    kind: &str,
    locator: &str,
) -> Result<(), StoreError> {
    if source_type != "library" {
        return Ok(());
    }
    if kind != "file" && kind != "directory" {
        return Err(StoreError::InvalidResource);
    }
    let trimmed = locator.trim();
    let has_scheme = trimmed.split_once(':').is_some_and(|(scheme, _)| {
        !scheme.is_empty()
            && scheme
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"+.-".contains(&byte))
    });
    if trimmed.is_empty()
        || has_scheme
        || trimmed.starts_with('/')
        || trimmed.starts_with('\\')
        || trimmed.starts_with('~')
        || trimmed.contains('\\')
    {
        return Err(StoreError::InvalidResource);
    }
    let parts = trimmed.split('/').collect::<Vec<_>>();
    if parts.first() != Some(&"projects")
        || parts
            .iter()
            .any(|part| part.is_empty() || *part == "." || *part == "..")
        || (kind == "directory" && parts.len() < 2)
        || (kind == "file" && parts.len() < 3)
    {
        return Err(StoreError::InvalidResource);
    }
    Ok(())
}

async fn replay(
    tx: &mut transaction::Tx<'_>,
    organization_id: &str,
    resource_id: &str,
    idempotency_key: &str,
    operation: OrganizationResourceOperation,
    fingerprint: &str,
) -> Result<Option<CommittedMutation>, StoreError> {
    let row = sqlx::query(
        "SELECT command_kind, command_fingerprint, receipt_format, outcome,
                resulting_version, fence_epoch, activity_id::text AS activity_id,
                CASE WHEN octet_length(result::text) <= $3 THEN result::text ELSE NULL END AS result_text
         FROM organization_mutation_receipts
         WHERE org_id=$1::uuid AND idempotency_key=$2",
    )
    .bind(organization_id)
    .bind(idempotency_key)
    .bind(i64::try_from(transaction::MAX_RESULT_BYTES).expect("receipt bound fits BIGINT"))
    .fetch_optional(&mut **tx)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    if row.try_get::<String, _>("command_kind")? != COMMAND_KIND_ORGANIZATION_RESOURCE
        || row.try_get::<String, _>("command_fingerprint")? != fingerprint
    {
        return Err(StoreError::IdempotencyConflict);
    }
    if row.try_get::<i32, _>("receipt_format")? != RECEIPT_FORMAT {
        return Err(StoreError::InvalidReceipt);
    }
    let result_text: Option<String> = row.try_get("result_text")?;
    let stored: Value = serde_json::from_str(&result_text.ok_or(StoreError::InvalidReceipt)?)
        .map_err(|_| StoreError::InvalidReceipt)?;
    let receipt: Receipt =
        serde_json::from_value(stored.clone()).map_err(|_| StoreError::InvalidReceipt)?;
    if serde_json::to_value(&receipt).map_err(|_| StoreError::InvalidReceipt)? != stored {
        return Err(StoreError::InvalidReceipt);
    }
    if receipt.activity_id.as_deref() != row.try_get::<Option<String>, _>("activity_id")?.as_deref()
        || receipt.version != transaction::unsigned(row.try_get("resulting_version")?)?
        || receipt.fence_epoch != transaction::unsigned(row.try_get("fence_epoch")?)?
        || receipt.outcome != Outcome::Applied
    {
        return Err(StoreError::InvalidReceipt);
    }
    validate_receipt(
        &receipt,
        organization_id,
        resource_id,
        operation,
        fingerprint,
    )?;
    Ok(Some(CommittedMutation {
        replayed: true,
        receipt,
    }))
}

fn validate_receipt(
    receipt: &Receipt,
    organization_id: &str,
    resource_id: &str,
    operation: OrganizationResourceOperation,
    fingerprint: &str,
) -> Result<(), StoreError> {
    let ResultState::OrganizationResourceMutated {
        resource_id: result_resource_id,
        response,
        operation: result_operation,
    } = &receipt.result
    else {
        return Err(StoreError::InvalidReceipt);
    };
    if receipt.organization_id != organization_id
        || receipt.fingerprint != fingerprint
        || receipt.activity_id.as_deref().is_none_or(str::is_empty)
        || *result_resource_id != resource_id
        || *result_operation != operation
        || response.get("id").and_then(Value::as_str) != Some(resource_id)
        || response.get("orgId").and_then(Value::as_str) != Some(organization_id)
        || receipt.version == 0
        || receipt.fence_epoch == 0
    {
        return Err(StoreError::InvalidReceipt);
    }
    ensure_json_size(response)?;
    Ok(())
}

fn command_fingerprint(
    organization_id: &str,
    resource_id: &str,
    actor_id: &str,
    run_id: Option<&str>,
    idempotency_key: &str,
    operation: OrganizationResourceOperation,
    data: &Value,
) -> Result<String, StoreError> {
    let identity = json!({
        "adapter_format": 1,
        "kind": COMMAND_KIND_ORGANIZATION_RESOURCE,
        "organization_id": organization_id,
        "resource_id": resource_id,
        "actor_kind": "board",
        "actor_id": actor_id,
        "run_id": run_id,
        "idempotency_key": idempotency_key,
        "operation": match operation {
            OrganizationResourceOperation::Update => "update",
            OrganizationResourceOperation::Delete => "delete",
        },
        "data": data,
    });
    ensure_command_size(&identity)?;
    Ok(hex_digest(Sha256::digest(
        serde_json::to_vec(&identity).map_err(|_| StoreError::InvalidInput)?,
    )))
}

fn canonical_uuid(value: &str) -> Result<String, StoreError> {
    let canonical = value.to_ascii_lowercase();
    transaction::uuid(&canonical)?;
    Ok(canonical)
}

fn normalize_nullable_text(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn ensure_command_size(value: &Value) -> Result<(), StoreError> {
    let bytes = serde_json::to_vec(value).map_err(|_| StoreError::InvalidInput)?;
    if bytes.len() > MAX_COMMAND_BYTES {
        return Err(StoreError::InvalidInput);
    }
    Ok(())
}

fn ensure_json_size(value: &Value) -> Result<(), StoreError> {
    let bytes = serde_json::to_vec(value).map_err(|_| StoreError::InvalidReceipt)?;
    if bytes.len() > transaction::MAX_RESULT_BYTES {
        return Err(StoreError::InvalidInput);
    }
    Ok(())
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn activity_idempotency_key(key: &str) -> String {
    format!("rust-d1:{}", hex_digest(Sha256::digest(key.as_bytes())))
}

#[cfg(test)]
mod tests {
    use super::{ResourcePatch, command_fingerprint, validate_library_resource};
    use crate::OrganizationResourceOperation;
    use serde_json::json;

    #[test]
    fn resource_patch_preserves_nullable_metadata_and_normalizes_description() {
        let patch =
            ResourcePatch::parse(&json!({ "metadata": null, "description": "  " })).unwrap();
        assert_eq!(patch.metadata, super::PatchField::Set(None));
        assert_eq!(patch.description, super::PatchField::Set(None));
    }

    #[test]
    fn resource_patch_rejects_unknown_fields_and_non_object_metadata() {
        assert!(ResourcePatch::parse(&json!({ "metadata": [] })).is_err());
        assert!(ResourcePatch::parse(&json!({ "unexpected": true })).is_err());
    }

    #[test]
    fn library_resource_paths_match_the_project_library_contract() {
        assert!(validate_library_resource("library", "file", "projects/shared/README.md").is_ok());
        assert!(validate_library_resource("library", "directory", "projects/shared").is_ok());
        assert!(validate_library_resource("library", "file", "projects/../secret").is_err());
        assert!(validate_library_resource("library", "url", "projects/shared/resource").is_err());
    }

    #[test]
    fn resource_command_fingerprint_binds_operation_and_payload() {
        let common = (
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
            "33333333-3333-4333-8333-333333333333",
            None,
            "resource-key",
        );
        let update = command_fingerprint(
            common.0,
            common.1,
            common.2,
            common.3,
            common.4,
            OrganizationResourceOperation::Update,
            &json!({ "name": "one" }),
        )
        .unwrap();
        let changed = command_fingerprint(
            common.0,
            common.1,
            common.2,
            common.3,
            common.4,
            OrganizationResourceOperation::Update,
            &json!({ "name": "two" }),
        )
        .unwrap();
        let delete = command_fingerprint(
            common.0,
            common.1,
            common.2,
            common.3,
            common.4,
            OrganizationResourceOperation::Delete,
            &json!({}),
        )
        .unwrap();
        assert_ne!(update, changed);
        assert_ne!(update, delete);
    }
}
