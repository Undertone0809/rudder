//! Standalone Asset persistence shares the Issue attachment storage and native authorizer.
use crate::{
    StoreError,
    activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_options},
    agent_core::{NativeAgentAccess, NativeAgentAuthorizer},
    issue_attachments::{IssueAttachmentActor, IssueAttachmentError},
    issue_core_writes::IssueAssetStorage,
    legacy_read_json::normalize_legacy_read_json,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

type Error = IssueAttachmentError;

pub struct AssetUpload<'a> {
    pub org_id: &'a str,
    pub namespace: &'a str,
    pub filename: Option<&'a str>,
    pub content_type: &'a str,
    pub body: &'a [u8],
    pub logo: bool,
}
pub struct AssetContent {
    pub org_id: String,
    pub object_key: String,
    pub content_type: String,
    pub byte_size: i32,
    pub filename: Option<String>,
}

pub async fn authorize(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    authorizer: &dyn NativeAgentAuthorizer,
) -> Result<(), Error> {
    match authorizer.revalidate(tx, org).await? {
        NativeAgentAccess::Authorized => Ok(()),
        NativeAgentAccess::Unauthorized => Err(Error::Http(401, "Unauthorized".into())),
        NativeAgentAccess::Forbidden => Err(Error::Http(
            403,
            "User does not have access to this organization".into(),
        )),
    }
}

pub async fn validate_access(
    pool: &PgPool,
    org: &str,
    authorizer: &dyn NativeAgentAuthorizer,
) -> Result<(), Error> {
    let mut tx = pool.begin().await?;
    authorize(&mut tx, org, authorizer).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn create(
    pool: &PgPool,
    actor: &IssueAttachmentActor<'_>,
    input: AssetUpload<'_>,
    storage: &dyn IssueAssetStorage,
) -> Result<String, Error> {
    let mut tx = pool.begin().await?;
    authorize(&mut tx, input.org_id, actor.authorizer).await?;
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM organizations WHERE id=$1::uuid)")
            .bind(input.org_id)
            .fetch_one(&mut *tx)
            .await?;
    if !exists {
        return Err(StoreError::NotFound.into());
    }
    let date = OffsetDateTime::now_utc();
    let (stem, extension) = crate::issue_attachments::split_filename(input.filename);
    let namespace = input
        .namespace
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    let key = format!(
        "{}/{}/{:04}/{:02}/{:02}/{}-{stem}{extension}",
        input.org_id,
        namespace,
        date.year(),
        u8::from(date.month()),
        date.day(),
        Uuid::new_v4()
    );
    storage
        .put_object(input.org_id, &key, input.content_type, input.body)
        .await
        .map_err(|error| {
            tracing::warn!(%error, "Asset storage failed");
            Error::Http(500, "Internal server error".into())
        })?;
    let result = async {
        let size = i32::try_from(input.body.len()).map_err(|_| Error::Http(422,"Image is too large".into()))?;
        let asset_id: String = sqlx::query_scalar("INSERT INTO assets (org_id,provider,object_key,content_type,byte_size,sha256,original_filename,created_by_agent_id,created_by_user_id) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::uuid,$9) RETURNING id::text")
            .bind(input.org_id).bind(storage.provider()).bind(&key).bind(input.content_type).bind(size)
            .bind(format!("{:x}",Sha256::digest(input.body))).bind(input.filename)
            .bind(actor.agent_id).bind((actor.kind=="user").then_some(actor.id)).fetch_one(&mut *tx).await?;
        let mut details = json!({"originalFilename":input.filename,"contentType":input.content_type,"byteSize":size});
        if input.logo { details["namespace"] = json!("assets/orgs"); }
        write_activity_options(&mut tx,ActivityWrite {
            org:input.org_id,
            audit:&ActivityActor {actor_type:if actor.kind=="agent" {"agent"} else {"user"},actor_id:actor.id.into(),run_id:actor.run_id.map(str::to_owned)},
            action:"asset.created",entity_type:"asset",entity_id:&asset_id,details:Some(&details),
            options:ActivityOptions{agent_id:actor.agent_id,effects:None,bind_run:true},
        }).await?;
        let projection = format!("SELECT json_build_object('assetId',id,'orgId',org_id,'provider',provider,'objectKey',object_key,'contentType',content_type,'byteSize',byte_size,'sha256',sha256,'originalFilename',original_filename,'createdByAgentId',created_by_agent_id,'createdByUserId',created_by_user_id,'createdAt',{},'updatedAt',{},'contentPath','/api/assets/'||id||'/content')::text FROM assets WHERE id=$1::uuid", crate::issue_metadata_reads::timestamp("created_at"),crate::issue_metadata_reads::timestamp("updated_at"));
        let raw: String = sqlx::query_scalar(&projection)
            .bind(&asset_id).fetch_one(&mut *tx).await?;
        Ok::<_,Error>(normalize_legacy_read_json(&raw)?)
    }.await;
    match result {
        Ok(response) => {
            tx.commit().await?;
            Ok(response)
        }
        Err(error) => {
            let _ = tx.rollback().await;
            if let Err(cleanup) = storage.delete_object(input.org_id, &key).await {
                tracing::warn!(%cleanup,"Asset rollback storage cleanup failed");
            }
            Err(error)
        }
    }
}

pub async fn content(
    pool: &PgPool,
    id: &str,
    authorizer: &dyn NativeAgentAuthorizer,
) -> Result<Option<AssetContent>, Error> {
    use sqlx::Row;
    let mut tx = pool.begin().await?;
    let row = sqlx::query("SELECT org_id::text,object_key,content_type,byte_size,original_filename FROM assets WHERE id=$1::uuid")
        .bind(id).fetch_optional(&mut *tx).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let org: String = row.try_get("org_id")?;
    authorize(&mut tx, &org, authorizer).await?;
    let content = AssetContent {
        org_id: org,
        object_key: row.try_get("object_key")?,
        content_type: row.try_get("content_type")?,
        byte_size: row.try_get("byte_size")?,
        filename: row.try_get("original_filename")?,
    };
    tx.commit().await?;
    Ok(Some(content))
}
