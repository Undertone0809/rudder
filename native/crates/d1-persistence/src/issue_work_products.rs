//! Public Issue Work Product writes. The linked Issue, primary projection,
//! Work Product row, and activity evidence are committed together.

use crate::{
    StoreError,
    activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_options},
    agent_core::{NativeAgentAccess, NativeAgentAuthorizer},
    goal_writes::lock_organization,
    issue_metadata_reads::{IssueMetadataReadError, project_work_product_for_write},
};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::collections::BTreeMap;
use uuid::Uuid;

type Tx<'a> = Transaction<'a, Postgres>;

pub struct IssueWorkProductWriteActor<'a> {
    pub kind: &'a str,
    pub id: &'a str,
    pub org_id: Option<&'a str>,
    pub agent_id: Option<&'a str>,
    pub run_id: Option<&'a str>,
    pub authorizer: &'a dyn NativeAgentAuthorizer,
}

#[derive(Debug, thiserror::Error)]
pub enum IssueWorkProductWriteError {
    #[error("{1}")]
    Http(u16, String),
    #[error("Request validation failed")]
    Validation(Vec<Value>),
    #[error("Issue not found")]
    IssueNotFound,
    #[error("Work product not found")]
    WorkProductNotFound,
    #[error("Invalid work product reference: {0}")]
    InvalidReference(&'static str),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Projection(#[from] IssueMetadataReadError),
}

type Result<T> = std::result::Result<T, IssueWorkProductWriteError>;

const TYPES: [&str; 7] = [
    "preview_url",
    "runtime_service",
    "pull_request",
    "branch",
    "commit",
    "artifact",
    "document",
];
const STATUSES: [&str; 9] = [
    "active",
    "ready_for_review",
    "approved",
    "changes_requested",
    "merged",
    "closed",
    "failed",
    "archived",
    "draft",
];
const REVIEW_STATES: [&str; 4] = [
    "none",
    "needs_board_review",
    "approved",
    "changes_requested",
];
const HEALTH_STATES: [&str; 3] = ["unknown", "healthy", "unhealthy"];

/// Create a Work Product for an already-resolved Issue. The Issue's current
/// project is used when `projectId` is absent or null, matching Node's route.
pub async fn create_with_native_auth(
    pool: &PgPool,
    actor: &IssueWorkProductWriteActor<'_>,
    org_id: &str,
    issue_id: &str,
    input: &Value,
) -> Result<Value> {
    validate_actor(actor)?;
    let fields = validate_payload(input, true)?;
    let org = canonical_uuid(org_id).ok_or(IssueWorkProductWriteError::IssueNotFound)?;
    let issue = canonical_uuid(issue_id).ok_or(IssueWorkProductWriteError::IssueNotFound)?;
    let mut tx = pool.begin().await?;
    let result = async {
        authorize_org(&mut tx, actor, &org).await?;
        let issue_project_id = sqlx::query_scalar::<_, Option<String>>(
            "SELECT project_id::text FROM issues WHERE id=$1::uuid AND org_id=$2::uuid FOR UPDATE",
        )
        .bind(&issue)
        .bind(&org)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(IssueWorkProductWriteError::IssueNotFound)?;
        validate_related_references(&mut tx, &org, &fields).await?;
        let project_id = fields
            .get("projectId")
            .and_then(Value::as_str)
            .or(issue_project_id.as_deref());
        let work_product_id = Uuid::new_v4().to_string();
        let product_type = field_string(&fields, "type");
        let is_primary = field_bool(&fields, "isPrimary");
        if is_primary {
            sqlx::query(
                "UPDATE issue_work_products SET is_primary=false,updated_at=now() WHERE org_id=$1::uuid AND issue_id=$2::uuid AND type=$3",
            )
            .bind(&org)
            .bind(&issue)
            .bind(product_type)
            .execute(&mut *tx)
            .await?;
        }
        sqlx::query(
            "INSERT INTO issue_work_products (id,org_id,project_id,issue_id,execution_workspace_id,runtime_service_id,type,provider,external_id,title,url,status,review_state,is_primary,health_status,summary,metadata,created_by_run_id) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::uuid)",
        )
        .bind(&work_product_id)
        .bind(&org)
        .bind(project_id)
        .bind(&issue)
        .bind(field_uuid(&fields, "executionWorkspaceId"))
        .bind(field_uuid(&fields, "runtimeServiceId"))
        .bind(product_type)
        .bind(field_string(&fields, "provider"))
        .bind(field_string_opt(&fields, "externalId"))
        .bind(field_string(&fields, "title"))
        .bind(field_string_opt(&fields, "url"))
        .bind(field_string(&fields, "status"))
        .bind(field_string(&fields, "reviewState"))
        .bind(is_primary)
        .bind(field_string(&fields, "healthStatus"))
        .bind(field_string_opt(&fields, "summary"))
        .bind(field_json_opt(&fields, "metadata"))
        .bind(field_uuid(&fields, "createdByRunId"))
        .execute(&mut *tx)
        .await?;
        let body = project_body(&mut tx, &org, &work_product_id).await?;
        write_activity(
            &mut tx,
            actor,
            &org,
            "issue.work_product_created",
            "issue",
            &issue,
            json!({
                "workProductId": work_product_id,
                "type": product_type,
                "provider": field_string(&fields, "provider"),
            }),
        )
        .await?;
        Ok(body)
    }
    .await;
    finish_transaction(tx, result).await
}

/// Patch a Work Product under the existing organization mutex and native actor.
pub async fn update_with_native_auth(
    pool: &PgPool,
    actor: &IssueWorkProductWriteActor<'_>,
    work_product_id: &str,
    input: &Value,
) -> Result<Value> {
    validate_actor(actor)?;
    let fields = validate_payload(input, false)?;
    let Some(work_product_id) = canonical_uuid(work_product_id) else {
        return Err(IssueWorkProductWriteError::WorkProductNotFound);
    };
    let org = sqlx::query_scalar::<_, String>(
        "SELECT org_id::text FROM issue_work_products WHERE id=$1::uuid",
    )
    .bind(&work_product_id)
    .fetch_optional(pool)
    .await?
    .ok_or(IssueWorkProductWriteError::WorkProductNotFound)?;
    let mut tx = pool.begin().await?;
    let result = async {
        authorize_org(&mut tx, actor, &org).await?;
        let product = sqlx::query_as::<_, (String, String)>(
            "SELECT issue_id::text,type FROM issue_work_products WHERE id=$1::uuid AND org_id=$2::uuid FOR UPDATE",
        )
        .bind(&work_product_id)
        .bind(&org)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(IssueWorkProductWriteError::WorkProductNotFound)?;
        let (issue, current_type) = product;
        validate_related_references(&mut tx, &org, &fields).await?;
        if field_bool_opt(&fields, "isPrimary") == Some(true) {
            sqlx::query(
                "UPDATE issue_work_products SET is_primary=false,updated_at=now() WHERE org_id=$1::uuid AND issue_id=$2::uuid AND type=$3",
            )
            .bind(&org)
            .bind(&issue)
            .bind(&current_type)
            .execute(&mut *tx)
            .await?;
        }
        update_fields(&mut tx, &org, &work_product_id, &fields).await?;
        let body = project_body(&mut tx, &org, &work_product_id).await?;
        let changed_keys = fields.keys().cloned().collect::<Vec<_>>();
        write_activity(
            &mut tx,
            actor,
            &org,
            "issue.work_product_updated",
            "issue",
            &issue,
            json!({"workProductId":work_product_id,"changedKeys":changed_keys}),
        )
        .await?;
        Ok(body)
    }
    .await;
    finish_transaction(tx, result).await
}

/// Delete a Work Product and return its pre-delete public projection.
pub async fn delete_with_native_auth(
    pool: &PgPool,
    actor: &IssueWorkProductWriteActor<'_>,
    work_product_id: &str,
) -> Result<Value> {
    validate_actor(actor)?;
    let Some(work_product_id) = canonical_uuid(work_product_id) else {
        return Err(IssueWorkProductWriteError::WorkProductNotFound);
    };
    let existing = sqlx::query_as::<_, (String, String)>(
        "SELECT org_id::text,issue_id::text FROM issue_work_products WHERE id=$1::uuid",
    )
    .bind(&work_product_id)
    .fetch_optional(pool)
    .await?
    .ok_or(IssueWorkProductWriteError::WorkProductNotFound)?;
    let (org, issue) = existing;
    let mut tx = pool.begin().await?;
    let result = async {
        authorize_org(&mut tx, actor, &org).await?;
        let body = project_body(&mut tx, &org, &work_product_id).await?;
        let removed = sqlx::query(
            "DELETE FROM issue_work_products WHERE id=$1::uuid AND org_id=$2::uuid RETURNING type",
        )
        .bind(&work_product_id)
        .bind(&org)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(IssueWorkProductWriteError::WorkProductNotFound)?;
        let product_type: String = removed.try_get("type")?;
        write_activity(
            &mut tx,
            actor,
            &org,
            "issue.work_product_deleted",
            "issue",
            &issue,
            json!({"workProductId":work_product_id,"type":product_type}),
        )
        .await?;
        Ok(body)
    }
    .await;
    finish_transaction(tx, result).await
}

async fn authorize_org(
    tx: &mut Tx<'_>,
    actor: &IssueWorkProductWriteActor<'_>,
    org: &str,
) -> Result<()> {
    if actor.kind == "agent" && actor.org_id != Some(org) {
        return Err(StoreError::PublicIdentityForbidden.into());
    }
    lock_organization(tx, org).await?;
    match actor.authorizer.revalidate(tx, org).await? {
        NativeAgentAccess::Authorized => Ok(()),
        NativeAgentAccess::Unauthorized => Err(StoreError::PublicIdentityUnauthorized.into()),
        NativeAgentAccess::Forbidden => Err(StoreError::PublicIdentityForbidden.into()),
    }
}

async fn validate_related_references(
    tx: &mut Tx<'_>,
    org: &str,
    fields: &BTreeMap<String, Value>,
) -> Result<()> {
    for field in [
        "projectId",
        "executionWorkspaceId",
        "runtimeServiceId",
        "createdByRunId",
    ] {
        let Some(id) = field_uuid(fields, field) else {
            continue;
        };
        let belongs_to_org = match field {
            "projectId" => {
                sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS(SELECT 1 FROM projects WHERE org_id=$1::uuid AND id=$2::uuid)",
                )
                .bind(org)
                .bind(&id)
                .fetch_one(&mut **tx)
                .await?
            }
            "executionWorkspaceId" => {
                sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS(SELECT 1 FROM execution_workspaces WHERE org_id=$1::uuid AND id=$2::uuid)",
                )
                .bind(org)
                .bind(&id)
                .fetch_one(&mut **tx)
                .await?
            }
            "runtimeServiceId" => {
                sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS(SELECT 1 FROM workspace_runtime_services WHERE org_id=$1::uuid AND id=$2::uuid)",
                )
                .bind(org)
                .bind(&id)
                .fetch_one(&mut **tx)
                .await?
            }
            "createdByRunId" => {
                sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS(SELECT 1 FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid)",
                )
                .bind(org)
                .bind(&id)
                .fetch_one(&mut **tx)
                .await?
            }
            _ => unreachable!("related reference fields are fixed above"),
        };
        if !belongs_to_org {
            return Err(IssueWorkProductWriteError::InvalidReference(field));
        }
    }
    Ok(())
}

async fn write_activity(
    tx: &mut Tx<'_>,
    actor: &IssueWorkProductWriteActor<'_>,
    org: &str,
    action: &str,
    entity_type: &str,
    entity_id: &str,
    details: Value,
) -> Result<()> {
    let audit = ActivityActor {
        actor_type: if actor.kind == "agent" {
            "agent"
        } else {
            "user"
        },
        actor_id: actor.id.to_owned(),
        run_id: actor.run_id.map(str::to_owned),
    };
    write_activity_options(
        tx,
        ActivityWrite {
            org,
            audit: &audit,
            action,
            entity_type,
            entity_id,
            details: Some(&details),
            options: ActivityOptions {
                agent_id: actor.agent_id,
                effects: None,
                bind_run: true,
            },
        },
    )
    .await?;
    Ok(())
}

async fn project_body(tx: &mut Tx<'_>, org: &str, id: &str) -> Result<Value> {
    let raw = project_work_product_for_write(tx, org, id)
        .await?
        .ok_or(IssueWorkProductWriteError::WorkProductNotFound)?;
    Ok(serde_json::from_str(&raw)?)
}

async fn update_fields(
    tx: &mut Tx<'_>,
    org: &str,
    id: &str,
    fields: &BTreeMap<String, Value>,
) -> Result<()> {
    sqlx::query(
        "UPDATE issue_work_products SET project_id=CASE WHEN $3 THEN $4::uuid ELSE project_id END, execution_workspace_id=CASE WHEN $5 THEN $6::uuid ELSE execution_workspace_id END, runtime_service_id=CASE WHEN $7 THEN $8::uuid ELSE runtime_service_id END, type=CASE WHEN $9 THEN $10 ELSE type END, provider=CASE WHEN $11 THEN $12 ELSE provider END, external_id=CASE WHEN $13 THEN $14 ELSE external_id END, title=CASE WHEN $15 THEN $16 ELSE title END, url=CASE WHEN $17 THEN $18 ELSE url END, status=CASE WHEN $19 THEN $20 ELSE status END, review_state=CASE WHEN $21 THEN $22 ELSE review_state END, is_primary=CASE WHEN $23 THEN $24 ELSE is_primary END, health_status=CASE WHEN $25 THEN $26 ELSE health_status END, summary=CASE WHEN $27 THEN $28 ELSE summary END, metadata=CASE WHEN $29 THEN $30::jsonb ELSE metadata END, created_by_run_id=CASE WHEN $31 THEN $32::uuid ELSE created_by_run_id END, updated_at=now() WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(org)
    .bind(id)
    .bind(fields.contains_key("projectId"))
    .bind(field_uuid_opt(fields, "projectId"))
    .bind(fields.contains_key("executionWorkspaceId"))
    .bind(field_uuid_opt(fields, "executionWorkspaceId"))
    .bind(fields.contains_key("runtimeServiceId"))
    .bind(field_uuid_opt(fields, "runtimeServiceId"))
    .bind(fields.contains_key("type"))
    .bind(field_string_opt(fields, "type"))
    .bind(fields.contains_key("provider"))
    .bind(field_string_opt(fields, "provider"))
    .bind(fields.contains_key("externalId"))
    .bind(field_string_opt(fields, "externalId"))
    .bind(fields.contains_key("title"))
    .bind(field_string_opt(fields, "title"))
    .bind(fields.contains_key("url"))
    .bind(field_string_opt(fields, "url"))
    .bind(fields.contains_key("status"))
    .bind(field_string_opt(fields, "status"))
    .bind(fields.contains_key("reviewState"))
    .bind(field_string_opt(fields, "reviewState"))
    .bind(fields.contains_key("isPrimary"))
    .bind(field_bool_opt(fields, "isPrimary"))
    .bind(fields.contains_key("healthStatus"))
    .bind(field_string_opt(fields, "healthStatus"))
    .bind(fields.contains_key("summary"))
    .bind(field_string_opt(fields, "summary"))
    .bind(fields.contains_key("metadata"))
    .bind(field_json_opt(fields, "metadata"))
    .bind(fields.contains_key("createdByRunId"))
    .bind(field_uuid_opt(fields, "createdByRunId"))
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn finish_transaction<T>(tx: Tx<'_>, result: Result<T>) -> Result<T> {
    match result {
        Ok(value) => {
            tx.commit().await?;
            Ok(value)
        }
        Err(error) => {
            tx.rollback().await?;
            Err(error)
        }
    }
}

fn validate_actor(actor: &IssueWorkProductWriteActor<'_>) -> Result<()> {
    if !matches!(actor.kind, "user" | "agent")
        || actor.id.trim().is_empty()
        || (actor.kind == "agent" && (actor.agent_id != Some(actor.id) || actor.org_id.is_none()))
    {
        return Err(StoreError::PublicIdentityUnauthorized.into());
    }
    Ok(())
}

fn validate_payload(input: &Value, create: bool) -> Result<BTreeMap<String, Value>> {
    let Some(input) = input.as_object() else {
        return Err(validation_error("Expected object, received non-object"));
    };
    let mut fields = BTreeMap::new();
    let mut errors = Vec::new();
    let allowed = [
        "projectId",
        "runWorkspaceId",
        "executionWorkspaceId",
        "runtimeServiceId",
        "type",
        "provider",
        "externalId",
        "title",
        "url",
        "status",
        "reviewState",
        "isPrimary",
        "healthStatus",
        "summary",
        "metadata",
        "createdByRunId",
    ];
    for key in allowed {
        if let Some(value) = input.get(key) {
            fields.insert(key.to_owned(), value.clone());
        }
    }
    let workspace_alias_conflict = match (
        input.get("runWorkspaceId"),
        input.get("executionWorkspaceId"),
    ) {
        (Some(canonical), Some(legacy)) => {
            let canonical = if canonical.is_null() {
                Value::Null
            } else {
                canonical.clone()
            };
            let legacy = if legacy.is_null() {
                Value::Null
            } else {
                legacy.clone()
            };
            canonical != legacy
        }
        _ => false,
    };
    if create {
        fields.entry("status".to_owned()).or_insert(json!("active"));
        fields
            .entry("reviewState".to_owned())
            .or_insert(json!("none"));
        fields.entry("isPrimary".to_owned()).or_insert(json!(false));
        fields
            .entry("healthStatus".to_owned())
            .or_insert(json!("unknown"));
    }

    for key in [
        "projectId",
        "runWorkspaceId",
        "executionWorkspaceId",
        "runtimeServiceId",
        "createdByRunId",
    ] {
        match fields.get(key) {
            Some(Value::String(value)) => match canonical_uuid(value) {
                Some(canonical) => {
                    fields.insert(key.to_owned(), Value::String(canonical));
                }
                None => errors.push(invalid_string_issue(key, "uuid", "Invalid uuid")),
            },
            Some(Value::Null) | None => {}
            Some(value) => errors.push(invalid_type_issue(key, "string", Some(value))),
        }
    }
    for key in ["provider", "title"] {
        if create || fields.contains_key(key) {
            match fields.get(key) {
                Some(Value::String(value)) if !value.is_empty() => {}
                Some(Value::String(_)) => errors.push(json!({
                    "code":"too_small",
                    "minimum":1,
                    "type":"string",
                    "inclusive":true,
                    "exact":false,
                    "path":[key],
                    "message":"String must contain at least 1 character(s)"
                })),
                Some(value) => errors.push(invalid_type_issue(key, "string", Some(value))),
                None => errors.push(invalid_type_issue(key, "string", None)),
            }
        }
    }
    for (key, values) in [
        ("type", &TYPES[..]),
        ("status", &STATUSES[..]),
        ("reviewState", &REVIEW_STATES[..]),
        ("healthStatus", &HEALTH_STATES[..]),
    ] {
        if create || fields.contains_key(key) {
            match fields.get(key).and_then(Value::as_str) {
                Some(value) if values.contains(&value) => {}
                Some(_) => {
                    let received = fields.get(key).cloned().unwrap_or(Value::Null);
                    errors.push(json!({
                        "received":received,
                        "code":"invalid_enum_value",
                        "options":values,
                        "path":[key],
                        "message":"Invalid enum value"
                    }));
                }
                None => {
                    let expected = values
                        .iter()
                        .map(|value| format!("'{value}'"))
                        .collect::<Vec<_>>()
                        .join(" | ");
                    errors.push(invalid_type_issue(key, &expected, fields.get(key)));
                }
            }
        }
    }
    for key in ["externalId", "summary"] {
        if fields
            .get(key)
            .is_some_and(|value| !value.is_null() && !value.is_string())
        {
            errors.push(invalid_type_issue(key, "string", fields.get(key)));
        }
    }
    if let Some(value) = fields.get("url") {
        match value {
            Value::Null => {}
            Value::String(text) if url::Url::parse(text).is_ok() => {}
            Value::String(_) => errors.push(invalid_string_issue("url", "url", "Invalid url")),
            _ => errors.push(invalid_type_issue("url", "string", Some(value))),
        }
    }
    if fields
        .get("isPrimary")
        .is_some_and(|value| !value.is_boolean())
    {
        errors.push(invalid_type_issue(
            "isPrimary",
            "boolean",
            fields.get("isPrimary"),
        ));
    }
    if fields
        .get("metadata")
        .is_some_and(|value| !value.is_null() && !value.is_object())
    {
        errors.push(invalid_type_issue(
            "metadata",
            "object",
            fields.get("metadata"),
        ));
    }
    if !errors.is_empty() {
        errors.sort_by_key(|issue| {
            let field = issue
                .get("path")
                .and_then(Value::as_array)
                .and_then(|path| path.first())
                .and_then(Value::as_str);
            allowed
                .iter()
                .position(|allowed_field| Some(*allowed_field) == field)
                .unwrap_or(usize::MAX)
        });
        return Err(IssueWorkProductWriteError::Validation(errors));
    }

    if workspace_alias_conflict {
        return Err(IssueWorkProductWriteError::Http(
            422,
            "runWorkspaceId conflicts with deprecated executionWorkspaceId".to_owned(),
        ));
    }
    if fields.contains_key("runWorkspaceId") {
        if !fields.contains_key("executionWorkspaceId") {
            let value = fields.get("runWorkspaceId").cloned().unwrap_or(Value::Null);
            fields.insert("executionWorkspaceId".to_owned(), value);
        }
        fields.remove("runWorkspaceId");
    }
    if create {
        fields.entry("metadata".to_owned()).or_insert(Value::Null);
    }
    Ok(fields)
}

fn validation_error(message: &str) -> IssueWorkProductWriteError {
    IssueWorkProductWriteError::Validation(vec![
        json!({"code":"invalid_type","expected":"object","received":"non-object","path":[],"message":message}),
    ])
}

fn invalid_type_issue(field: &str, expected: &str, value: Option<&Value>) -> Value {
    let Some(value) = value else {
        return json!({
            "code":"invalid_type",
            "expected":expected,
            "received":"undefined",
            "path":[field],
            "message":"Required"
        });
    };
    let received = match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    };
    json!({
        "code":"invalid_type",
        "expected":expected,
        "received":received,
        "path":[field],
        "message":format!("Expected {expected}, received {received}")
    })
}

fn invalid_string_issue(field: &str, validation: &str, message: &str) -> Value {
    json!({
        "validation":validation,
        "code":"invalid_string",
        "path":[field],
        "message":message
    })
}

fn canonical_uuid(raw: &str) -> Option<String> {
    let id = Uuid::parse_str(raw).ok()?;
    let canonical = id.hyphenated().to_string();
    (raw.eq_ignore_ascii_case(&canonical)).then_some(canonical)
}

fn field_string<'a>(fields: &'a BTreeMap<String, Value>, key: &str) -> &'a str {
    fields.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn field_string_opt(fields: &BTreeMap<String, Value>, key: &str) -> Option<String> {
    fields.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn field_uuid(fields: &BTreeMap<String, Value>, key: &str) -> Option<String> {
    field_uuid_opt(fields, key)
}

fn field_uuid_opt(fields: &BTreeMap<String, Value>, key: &str) -> Option<String> {
    fields.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn field_bool(fields: &BTreeMap<String, Value>, key: &str) -> bool {
    field_bool_opt(fields, key).unwrap_or(false)
}

fn field_bool_opt(fields: &BTreeMap<String, Value>, key: &str) -> Option<bool> {
    fields.get(key).and_then(Value::as_bool)
}

fn field_json_opt(fields: &BTreeMap<String, Value>, key: &str) -> Option<String> {
    fields
        .get(key)
        .filter(|value| !value.is_null())
        .map(Value::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn validation_errors(input: &Value, create: bool) -> Vec<Value> {
        match validate_payload(input, create) {
            Err(IssueWorkProductWriteError::Validation(errors)) => errors,
            Err(error) => panic!("expected validation errors, got {error}"),
            Ok(_) => panic!("expected validation errors"),
        }
    }

    #[test]
    fn create_missing_required_fields_match_node_issue_order_and_shape() {
        assert_eq!(
            validation_errors(&json!({}), true),
            vec![
                json!({
                    "code":"invalid_type",
                    "expected":"'preview_url' | 'runtime_service' | 'pull_request' | 'branch' | 'commit' | 'artifact' | 'document'",
                    "received":"undefined",
                    "path":["type"],
                    "message":"Required"
                }),
                json!({
                    "code":"invalid_type",
                    "expected":"string",
                    "received":"undefined",
                    "path":["provider"],
                    "message":"Required"
                }),
                json!({
                    "code":"invalid_type",
                    "expected":"string",
                    "received":"undefined",
                    "path":["title"],
                    "message":"Required"
                }),
            ]
        );
    }

    #[test]
    fn non_string_related_ids_and_urls_match_node_issue_order_and_shape() {
        assert_eq!(
            validation_errors(
                &json!({
                    "type":"preview_url",
                    "provider":"custom",
                    "title":"Preview",
                    "projectId":42,
                    "url":7
                }),
                true,
            ),
            vec![
                json!({
                    "code":"invalid_type",
                    "expected":"string",
                    "received":"number",
                    "path":["projectId"],
                    "message":"Expected string, received number"
                }),
                json!({
                    "code":"invalid_type",
                    "expected":"string",
                    "received":"number",
                    "path":["url"],
                    "message":"Expected string, received number"
                }),
            ]
        );
    }
}
