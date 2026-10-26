//! Public Issue attachment persistence and scoped storage effects.

use crate::{
    StoreError,
    activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_options},
    agent_core::{NativeAgentAccess, NativeAgentAuthorizer},
    goal_writes::lock_organization,
    issue_core_writes::IssueAssetStorage,
    issue_metadata_reads::attachment_projection,
    legacy_read_json::normalize_legacy_read_json,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::path::Path;
use time::OffsetDateTime;
use uuid::Uuid;

type Tx<'a> = Transaction<'a, Postgres>;

const USAGES: [&str; 5] = [
    "issue",
    "description_inline",
    "document_inline",
    "comment_inline",
    "comment_attachment",
];

pub struct IssueAttachmentActor<'a> {
    pub kind: &'a str,
    pub id: &'a str,
    pub agent_id: Option<&'a str>,
    pub run_id: Option<&'a str>,
    pub authorizer: &'a dyn NativeAgentAuthorizer,
}

pub struct IssueAttachmentCreate<'a> {
    pub org_id: &'a str,
    pub issue_id: &'a str,
    pub issue_comment_id: Option<&'a str>,
    pub usage: &'a str,
    pub original_filename: Option<&'a str>,
    pub content_type: &'a str,
    pub body: &'a [u8],
    pub workspace_path: Option<&'a str>,
}

pub struct IssueAttachmentContent {
    pub id: String,
    pub org_id: String,
    pub issue_id: String,
    pub object_key: String,
    pub content_type: String,
    pub byte_size: i32,
    pub original_filename: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum IssueAttachmentError {
    #[error("{1}")]
    Http(u16, String),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

/// Validate the organization and Issue before consuming an upload body or
/// reading a Library file. The create operation revalidates in its write tx.
pub async fn validate_attachment_target_with_native_auth(
    pool: &PgPool,
    org_id: &str,
    issue_id: &str,
    authorizer: &dyn NativeAgentAuthorizer,
) -> Result<(), IssueAttachmentError> {
    let org = canonical_uuid(org_id)?;
    let issue = canonical_uuid(issue_id)?;
    let mut tx = pool.begin().await?;
    lock_organization(&mut tx, &org).await?;
    revalidate(&mut tx, &org, authorizer).await?;
    ensure_issue_scope(&mut tx, &org, &issue).await?;
    tx.commit().await?;
    Ok(())
}

/// Store an object, its Asset and Issue attachment, and the matching activity.
/// SQL failure rolls the rows back and removes a successfully staged object.
pub async fn create_with_native_auth(
    pool: &PgPool,
    actor: &IssueAttachmentActor<'_>,
    input: &IssueAttachmentCreate<'_>,
    storage: &dyn IssueAssetStorage,
) -> Result<String, IssueAttachmentError> {
    let org = canonical_uuid(input.org_id)?;
    let issue = canonical_uuid(input.issue_id)?;
    let comment = input.issue_comment_id.map(canonical_uuid).transpose()?;
    if !matches!(actor.kind, "user" | "agent") || actor.id.trim().is_empty() {
        return Err(http(401, "Unauthorized"));
    }
    if actor.kind == "agent" && actor.agent_id != Some(actor.id) {
        return Err(http(401, "Unauthorized"));
    }
    if input.body.is_empty() {
        return Err(http(422, "Attachment is empty"));
    }
    if !USAGES.contains(&input.usage) {
        return Err(http(400, "Invalid attachment metadata"));
    }

    let mut staged_object_key = None;
    let mut tx = pool.begin().await?;
    let result = async {
        lock_organization(&mut tx, &org).await?;
        revalidate(&mut tx, &org, actor.authorizer).await?;
        ensure_issue_scope(&mut tx, &org, &issue).await?;
        if let Some(comment_id) = comment.as_deref() {
            ensure_comment_scope(&mut tx, &org, &issue, comment_id).await?;
        }

        let content_type = input.content_type.trim().to_ascii_lowercase();
        let object_key = issue_attachment_object_key(
            &org,
            &issue,
            input.original_filename,
        );
        storage
            .put_object(&org, &object_key, &content_type, input.body)
            .await
            .map_err(|error| {
                tracing::warn!(%error, org_id = org, object_key, "failed to store Issue attachment object");
                http(500, "Attachment storage failed")
            })?;
        staged_object_key = Some(object_key.clone());

        let byte_size = i32::try_from(input.body.len())
            .map_err(|_| http(422, "Attachment is too large"))?;
        let sha256 = format!("{:x}", Sha256::digest(input.body));
        let created_by_agent_id = actor.agent_id.filter(|_| actor.kind == "agent");
        let created_by_user_id = (actor.kind == "user").then_some(actor.id);
        let asset_id = sqlx::query_scalar::<_, String>(
            "INSERT INTO assets (org_id,provider,object_key,content_type,byte_size,sha256,original_filename,created_by_agent_id,created_by_user_id) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::uuid,$9) RETURNING id::text",
        )
        .bind(&org)
        .bind(storage.provider())
        .bind(&object_key)
        .bind(&content_type)
        .bind(byte_size)
        .bind(sha256)
        .bind(input.original_filename.filter(|value| !value.is_empty()))
        .bind(created_by_agent_id)
        .bind(created_by_user_id)
        .fetch_one(&mut *tx)
        .await?;
        let attachment_id = sqlx::query_scalar::<_, String>(
            "INSERT INTO issue_attachments (org_id,issue_id,asset_id,issue_comment_id,usage) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5) RETURNING id::text",
        )
        .bind(&org)
        .bind(&issue)
        .bind(&asset_id)
        .bind(comment.as_deref())
        .bind(input.usage)
        .fetch_one(&mut *tx)
        .await?;

        if input.usage == "issue" {
            let audit = ActivityActor {
                actor_type: activity_actor_type(actor.kind),
                actor_id: actor.id.to_owned(),
                run_id: actor.run_id.map(ToOwned::to_owned),
            };
            let details = json!({
                "attachmentId": attachment_id,
                "usage": input.usage,
                "originalFilename": input.original_filename,
                "contentType": content_type,
                "byteSize": byte_size,
                "workspacePath": input.workspace_path,
            });
            let details = if input.workspace_path.is_some() {
                details
            } else {
                let mut details = details;
                details.as_object_mut().expect("attachment activity object").remove("workspacePath");
                details
            };
            write_activity_options(
                &mut tx,
                ActivityWrite {
                    org: &org,
                    audit: &audit,
                    action: "issue.attachment_added",
                    entity_type: "issue",
                    entity_id: &issue,
                    details: Some(&details),
                    options: ActivityOptions {
                        agent_id: actor.agent_id,
                        effects: None,
                        bind_run: true,
                    },
                },
            )
            .await?;
        }

        let query = format!(
            "SELECT {} FROM issue_attachments t JOIN assets a ON a.org_id=t.org_id AND a.id=t.asset_id WHERE t.org_id=$1::uuid AND t.id=$2::uuid",
            attachment_projection()
        );
        let raw = sqlx::query_scalar::<_, String>(&query)
            .bind(&org)
            .bind(&attachment_id)
            .fetch_one(&mut *tx)
            .await?;
        let response = normalize_legacy_read_json(&raw)?;
        Ok::<_, IssueAttachmentError>(response)
    }
    .await;

    match result {
        Ok(response) => {
            // An unknown COMMIT outcome does not prove the object is unused.
            tx.commit().await?;
            Ok(response)
        }
        Err(error) => {
            if let Err(rollback_error) = tx.rollback().await {
                tracing::warn!(%rollback_error, org_id = org, "failed to roll back Issue attachment creation");
            }
            if let Some(object_key) = staged_object_key.as_deref()
                && let Err(cleanup_error) = storage.delete_object(&org, object_key).await
            {
                tracing::warn!(%cleanup_error, org_id = org, object_key, "failed to clean up staged Issue attachment object");
            }
            Err(error)
        }
    }
}

/// Read an attachment under the organization identity resolved from its row.
pub async fn read_with_native_auth(
    pool: &PgPool,
    attachment_id: &str,
    authorizer: &dyn NativeAgentAuthorizer,
) -> Result<Option<IssueAttachmentContent>, IssueAttachmentError> {
    let Some(id) = canonical_uuid_or_none(attachment_id) else {
        return Ok(None);
    };
    let mut tx = pool.begin().await?;
    let actual_org = sqlx::query_scalar::<_, String>(
        "SELECT org_id::text FROM issue_attachments WHERE id=$1::uuid",
    )
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(org) = actual_org else {
        tx.commit().await?;
        return Ok(None);
    };
    revalidate(&mut tx, &org, authorizer).await?;
    let row = sqlx::query(
        "SELECT t.id::text AS id,t.org_id::text AS org_id,t.issue_id::text AS issue_id,a.object_key,a.content_type,a.byte_size,a.original_filename FROM issue_attachments t JOIN assets a ON a.org_id=t.org_id AND a.id=t.asset_id WHERE t.org_id=$1::uuid AND t.id=$2::uuid",
    )
    .bind(&org)
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    row.map(|row| {
        Ok(IssueAttachmentContent {
            id: row.try_get("id")?,
            org_id: row.try_get("org_id")?,
            issue_id: row.try_get("issue_id")?,
            object_key: row.try_get("object_key")?,
            content_type: row.try_get("content_type")?,
            byte_size: row.try_get("byte_size")?,
            original_filename: row.try_get("original_filename")?,
        })
    })
    .transpose()
}

/// Delete the Asset and Issue attachment atomically with audit. Object deletion
/// follows the legacy best-effort behavior after the database transaction.
pub async fn delete_with_native_auth(
    pool: &PgPool,
    actor: &IssueAttachmentActor<'_>,
    attachment_id: &str,
    storage: Option<&dyn IssueAssetStorage>,
) -> Result<bool, IssueAttachmentError> {
    let Some(id) = canonical_uuid_or_none(attachment_id) else {
        return Ok(false);
    };
    let mut tx = pool.begin().await?;
    let actual_org = sqlx::query_scalar::<_, String>(
        "SELECT org_id::text FROM issue_attachments WHERE id=$1::uuid",
    )
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(org) = actual_org else {
        tx.commit().await?;
        return Ok(false);
    };
    lock_organization(&mut tx, &org).await?;
    revalidate(&mut tx, &org, actor.authorizer).await?;
    let row = sqlx::query(
        "SELECT t.issue_id::text AS issue_id,a.object_key,a.id::text AS asset_id FROM issue_attachments t JOIN assets a ON a.org_id=t.org_id AND a.id=t.asset_id WHERE t.org_id=$1::uuid AND t.id=$2::uuid FOR UPDATE OF t,a",
    )
    .bind(&org)
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = row else {
        tx.commit().await?;
        return Ok(false);
    };
    let issue_id: String = row.try_get("issue_id")?;
    let object_key: String = row.try_get("object_key")?;
    let asset_id: String = row.try_get("asset_id")?;
    sqlx::query("DELETE FROM issue_attachments WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(&org)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM assets WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(&org)
        .bind(&asset_id)
        .execute(&mut *tx)
        .await?;
    let audit = ActivityActor {
        actor_type: activity_actor_type(actor.kind),
        actor_id: actor.id.to_owned(),
        run_id: actor.run_id.map(ToOwned::to_owned),
    };
    write_activity_options(
        &mut tx,
        ActivityWrite {
            org: &org,
            audit: &audit,
            action: "issue.attachment_removed",
            entity_type: "issue",
            entity_id: &issue_id,
            details: Some(&json!({"attachmentId": id})),
            options: ActivityOptions {
                agent_id: actor.agent_id,
                effects: None,
                bind_run: true,
            },
        },
    )
    .await?;
    tx.commit().await?;
    if let Some(storage) = storage {
        if let Err(error) = storage.delete_object(&org, &object_key).await {
            tracing::warn!(%error, attachment_id = id, "storage delete failed while removing Issue attachment");
        }
    } else {
        tracing::warn!(
            org_id = org,
            attachment_id = id,
            object_key,
            "Issue attachment object could not be deleted because storage is unavailable"
        );
    }
    Ok(true)
}

async fn ensure_issue_scope(
    tx: &mut Tx<'_>,
    org: &str,
    issue_id: &str,
) -> Result<(), IssueAttachmentError> {
    let actual_org =
        sqlx::query_scalar::<_, String>("SELECT org_id::text FROM issues WHERE id=$1::uuid")
            .bind(issue_id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or(StoreError::NotFound)?;
    if actual_org != org {
        return Err(http(422, "Issue does not belong to organization"));
    }
    Ok(())
}

async fn ensure_comment_scope(
    tx: &mut Tx<'_>,
    org: &str,
    issue_id: &str,
    comment_id: &str,
) -> Result<(), IssueAttachmentError> {
    let row = sqlx::query(
        "SELECT org_id::text AS org_id,issue_id::text AS issue_id FROM issue_comments WHERE id=$1::uuid",
    )
    .bind(comment_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(404, "Issue comment not found"))?;
    let comment_org: String = row.try_get("org_id")?;
    let comment_issue: String = row.try_get("issue_id")?;
    if comment_org != org || comment_issue != issue_id {
        return Err(http(
            422,
            "Attachment comment must belong to same issue and organization",
        ));
    }
    Ok(())
}

async fn revalidate(
    tx: &mut Tx<'_>,
    org: &str,
    authorizer: &dyn NativeAgentAuthorizer,
) -> Result<(), IssueAttachmentError> {
    match authorizer.revalidate(tx, org).await? {
        NativeAgentAccess::Authorized => Ok(()),
        NativeAgentAccess::Unauthorized => Err(http(401, "Unauthorized")),
        NativeAgentAccess::Forbidden => {
            Err(http(403, "User does not have access to this organization"))
        }
    }
}

fn issue_attachment_object_key(org: &str, issue: &str, filename: Option<&str>) -> String {
    let (stem, extension) = split_filename(filename);
    let date = OffsetDateTime::now_utc();
    format!(
        "{org}/issues/{issue}/{:04}/{:02}/{:02}/{}-{stem}{extension}",
        date.year(),
        u8::from(date.month()),
        date.day(),
        Uuid::new_v4()
    )
}

fn split_filename(filename: Option<&str>) -> (String, String) {
    let basename = filename
        .filter(|value| !value.is_empty())
        .and_then(|value| Path::new(value).file_name())
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_owned());
    let path = Path::new(&basename);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    let stem = if extension.is_empty() {
        basename.as_str()
    } else {
        basename.strip_suffix(&extension).unwrap_or(&basename)
    };
    let mut sanitized = String::new();
    for character in stem.trim().chars() {
        let next = if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
            character
        } else {
            '_'
        };
        if next != '_' || !sanitized.ends_with('_') {
            sanitized.push(next);
        }
    }
    let stem = sanitized.trim_matches('_');
    let stem = if stem.is_empty() { "file" } else { stem };
    let stem = stem.chars().take(120).collect::<String>();
    let extension = extension
        .to_ascii_lowercase()
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '.')
        .take(16)
        .collect::<String>();
    (stem, extension)
}

fn canonical_uuid(value: &str) -> Result<String, IssueAttachmentError> {
    Uuid::parse_str(value)
        .map(|value| value.to_string())
        .map_err(|_| http(422, "Invalid Issue attachment request"))
}

fn canonical_uuid_or_none(value: &str) -> Option<String> {
    Uuid::parse_str(value).ok().map(|value| value.to_string())
}

fn activity_actor_type(kind: &str) -> &'static str {
    match kind {
        "user" => "user",
        "agent" => "agent",
        _ => "system",
    }
}

fn http(status: u16, message: &str) -> IssueAttachmentError {
    IssueAttachmentError::Http(status, message.to_owned())
}

#[cfg(test)]
mod tests {
    use super::{issue_attachment_object_key, split_filename};

    #[test]
    fn object_keys_keep_issue_scope_date_and_sanitized_filename() {
        let key = issue_attachment_object_key(
            "org-id",
            "issue-id",
            Some("../Quarterly notes (final).PDF"),
        );
        assert!(key.starts_with("org-id/issues/issue-id/"));
        assert!(key.ends_with("-Quarterly_notes_final.pdf"));
        assert!(!key.contains(".."));
    }

    #[test]
    fn split_filename_uses_node_storage_filename_fallback() {
        assert_eq!(split_filename(None), ("file".to_owned(), String::new()));
        assert_eq!(
            split_filename(Some("note.txt")),
            ("note".to_owned(), ".txt".to_owned())
        );
        assert_eq!(
            split_filename(Some(".env")),
            (".env".to_owned(), String::new())
        );
    }
}
