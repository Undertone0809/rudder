use super::*;
use actix_multipart::Multipart;
use actix_web::http::header;
use futures_util::{StreamExt, stream};
use rudder_d1_persistence::{
    issue_attachments::{
        IssueAttachmentActor, IssueAttachmentCreate, IssueAttachmentError, create_with_native_auth,
        delete_with_native_auth, read_with_native_auth,
        validate_attachment_target_with_native_auth,
    },
    issue_core_writes::IssueAssetStorage,
};
use serde_json::{Value, json};
use std::path::{Component, Path, PathBuf};

const DEFAULT_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
const MULTIPART_OVERHEAD_BYTES: usize = 64 * 1024;
const MAX_METADATA_FIELD_BYTES: usize = 1024 * 1024;

struct UploadForm {
    filename: Option<String>,
    content_type: String,
    body: Vec<u8>,
    issue_comment_id: Option<String>,
    usage: Option<String>,
}

pub(super) fn request_body_limit() -> usize {
    attachment_max_bytes().saturating_add(MULTIPART_OVERHEAD_BYTES)
}

pub(super) async fn upload(
    state: web::Data<IngressState>,
    request: HttpRequest,
    mut payload: web::Payload,
    org_id: &str,
    issue_id: &str,
) -> HttpResponse {
    let (identity, actor, session_id, run_id) =
        match super::public_issue_actor(&state, &request).await {
            Ok(actor) => actor,
            Err(response) => return response,
        };
    let Some(org_id) = super::canonical_org_id(org_id) else {
        return super::not_found("Organization not found");
    };
    let Some(authorizer) =
        super::agent_core::native_authorizer(&identity, &actor, &session_id, &state)
    else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    let Some(pool) = super::configured_pool(&state) else {
        return super::unavailable();
    };
    if let Err(error) =
        validate_attachment_target_with_native_auth(pool, &org_id, issue_id, &authorizer).await
    {
        return attachment_error(error);
    }
    let Some(storage) = state.config.issue_asset_storage.as_deref() else {
        return storage_unavailable();
    };
    let body = match read_upload_body(&mut payload).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let form = match parse_upload_form(&request, body).await {
        Ok(form) => form,
        Err(response) => return response,
    };
    let Some(form) = form else {
        return HttpResponse::BadRequest().json(json!({"error":"Missing file field 'file'"}));
    };
    if form.body.is_empty() {
        return HttpResponse::UnprocessableEntity().json(json!({"error":"Attachment is empty"}));
    }
    if !is_allowed_content_type(&form.content_type) {
        return HttpResponse::UnprocessableEntity().json(json!({
            "error":format!("Unsupported attachment type: {}", if form.content_type.is_empty() { "unknown" } else { &form.content_type })
        }));
    }
    let usage = form.usage.as_deref().unwrap_or("issue");
    if ![
        "issue",
        "description_inline",
        "document_inline",
        "comment_inline",
        "comment_attachment",
    ]
    .contains(&usage)
        || form
            .issue_comment_id
            .as_deref()
            .is_some_and(|value| !is_uuid(value))
    {
        return invalid_attachment_metadata();
    }
    let actor_agent_id = (actor.kind == "agent").then_some(actor.id.as_str());
    let write_actor = IssueAttachmentActor {
        kind: &actor.kind,
        id: &actor.id,
        agent_id: actor_agent_id,
        run_id: run_id.as_deref(),
        authorizer: &authorizer,
    };
    let input = IssueAttachmentCreate {
        org_id: &org_id,
        issue_id,
        issue_comment_id: form.issue_comment_id.as_deref(),
        usage,
        original_filename: form.filename.as_deref().filter(|value| !value.is_empty()),
        content_type: &form.content_type,
        body: &form.body,
        workspace_path: None,
    };
    match create_with_native_auth(pool, &write_actor, &input, storage).await {
        Ok(body) => attachment_json(StatusCode::CREATED, &body),
        Err(error) => attachment_error(error),
    }
}

pub(super) async fn import_workspace_file(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: &web::Bytes,
    org_id: &str,
    issue_id: &str,
) -> HttpResponse {
    let path = match validated_workspace_path(body) {
        Ok(path) => path,
        Err(response) => return response,
    };
    let (identity, actor, session_id, run_id) =
        match super::public_issue_actor(&state, &request).await {
            Ok(actor) => actor,
            Err(response) => return response,
        };
    let Some(org_id) = super::canonical_org_id(org_id) else {
        return super::not_found("Organization not found");
    };
    let Some(authorizer) =
        super::agent_core::native_authorizer(&identity, &actor, &session_id, &state)
    else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    let Some(pool) = super::configured_pool(&state) else {
        return super::unavailable();
    };
    if let Err(error) =
        validate_attachment_target_with_native_auth(pool, &org_id, issue_id, &authorizer).await
    {
        return attachment_error(error);
    }
    let Some(storage) = state.config.issue_asset_storage.as_deref() else {
        return storage_unavailable();
    };
    let workspace_root = match super::agent_core::ensure_organization_workspace_root(&org_id) {
        Ok(path) => PathBuf::from(path),
        Err(()) => return super::internal_error(),
    };
    let workspace_file = match read_library_attachment_file(&workspace_root, &path).await {
        Ok(file) => file,
        Err((status, message)) => {
            return HttpResponse::build(status).json(json!({"error":message}));
        }
    };
    if workspace_file.body.is_empty() {
        return HttpResponse::UnprocessableEntity().json(json!({"error":"Attachment is empty"}));
    }
    if workspace_file.body.len() > attachment_max_bytes() {
        return HttpResponse::UnprocessableEntity().json(json!({
            "error":format!("Attachment exceeds {} bytes", attachment_max_bytes())
        }));
    }
    if !is_allowed_content_type(&workspace_file.content_type) {
        return HttpResponse::UnprocessableEntity().json(json!({
            "error":format!("Unsupported attachment type: {}", if workspace_file.content_type.is_empty() { "unknown" } else { &workspace_file.content_type })
        }));
    }
    let actor_agent_id = (actor.kind == "agent").then_some(actor.id.as_str());
    let write_actor = IssueAttachmentActor {
        kind: &actor.kind,
        id: &actor.id,
        agent_id: actor_agent_id,
        run_id: run_id.as_deref(),
        authorizer: &authorizer,
    };
    let input = IssueAttachmentCreate {
        org_id: &org_id,
        issue_id,
        issue_comment_id: None,
        usage: "issue",
        original_filename: Some(&workspace_file.filename),
        content_type: &workspace_file.content_type,
        body: &workspace_file.body,
        workspace_path: Some(&workspace_file.normalized_path),
    };
    match create_with_native_auth(pool, &write_actor, &input, storage).await {
        Ok(body) => attachment_json(StatusCode::CREATED, &body),
        Err(error) => attachment_error(error),
    }
}

pub(super) async fn content(
    state: web::Data<IngressState>,
    request: HttpRequest,
    attachment_id: &str,
) -> HttpResponse {
    let (identity, actor, session_id, _) = match super::public_issue_actor(&state, &request).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let Some(authorizer) =
        super::agent_core::native_authorizer(&identity, &actor, &session_id, &state)
    else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    let Some(pool) = super::configured_pool(&state) else {
        return super::unavailable();
    };
    let Some(attachment) = (match read_with_native_auth(pool, attachment_id, &authorizer).await {
        Ok(attachment) => attachment,
        Err(error) => return attachment_error(error),
    }) else {
        return super::not_found("Attachment not found");
    };
    let Some(storage) = state.config.issue_asset_storage.as_deref() else {
        return storage_unavailable();
    };
    let object = match storage
        .get_object(&attachment.org_id, &attachment.object_key)
        .await
    {
        Ok(object) => object,
        Err(error) => {
            tracing::warn!(%error, attachment_id, "failed to read Issue attachment object");
            return super::internal_error();
        }
    };
    let content_type = if attachment.content_type.is_empty() {
        object
            .content_type
            .as_deref()
            .unwrap_or("application/octet-stream")
    } else {
        &attachment.content_type
    };
    let filename = attachment
        .original_filename
        .as_deref()
        .unwrap_or("attachment")
        .replace('"', "");
    let disposition = format!("inline; filename=\"{filename}\"");
    let Ok(disposition) = header::HeaderValue::from_str(&disposition) else {
        return super::internal_error();
    };
    let mut response = HttpResponse::Ok();
    response
        .insert_header((header::CONTENT_TYPE, content_type))
        .insert_header((header::CACHE_CONTROL, "private, max-age=60"))
        .insert_header((header::CONTENT_DISPOSITION, disposition));
    // Let Actix infer the representation length from the same bytes used by
    // GET. Its HTTP/1 encoder suppresses HEAD payload bytes while preserving
    // the representation's Content-Length.
    response.body(object.body)
}

pub(super) async fn delete(
    state: web::Data<IngressState>,
    request: HttpRequest,
    attachment_id: &str,
) -> HttpResponse {
    let (identity, actor, session_id, run_id) =
        match super::public_issue_actor(&state, &request).await {
            Ok(actor) => actor,
            Err(response) => return response,
        };
    let Some(authorizer) =
        super::agent_core::native_authorizer(&identity, &actor, &session_id, &state)
    else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    let Some(pool) = super::configured_pool(&state) else {
        return super::unavailable();
    };
    let actor_agent_id = (actor.kind == "agent").then_some(actor.id.as_str());
    let write_actor = IssueAttachmentActor {
        kind: &actor.kind,
        id: &actor.id,
        agent_id: actor_agent_id,
        run_id: run_id.as_deref(),
        authorizer: &authorizer,
    };
    match delete_with_native_auth(
        pool,
        &write_actor,
        attachment_id,
        state
            .config
            .issue_asset_storage
            .as_deref()
            .map(|storage| storage as &dyn IssueAssetStorage),
    )
    .await
    {
        Ok(true) => HttpResponse::Ok().json(json!({"ok":true})),
        Ok(false) => super::not_found("Attachment not found"),
        Err(error) => attachment_error(error),
    }
}

#[allow(clippy::result_large_err)]
async fn read_upload_body(payload: &mut web::Payload) -> Result<web::Bytes, HttpResponse> {
    let max_bytes = request_body_limit();
    let mut body = Vec::new();
    while let Some(chunk) = payload.next().await {
        let Ok(chunk) = chunk else {
            return Err(HttpResponse::BadRequest().json(json!({"error":"Invalid request body"})));
        };
        if body.len().saturating_add(chunk.len()) > max_bytes {
            return Err(HttpResponse::UnprocessableEntity().json(json!({
                "error":format!("Attachment exceeds {} bytes", attachment_max_bytes())
            })));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(web::Bytes::from(body))
}

#[allow(clippy::result_large_err)]
async fn parse_upload_form(
    request: &HttpRequest,
    body: web::Bytes,
) -> Result<Option<UploadForm>, HttpResponse> {
    let mut multipart = Multipart::new(
        request.headers(),
        stream::once(async move { Ok::<_, actix_web::error::PayloadError>(body) }),
    );
    let mut filename = None;
    let mut content_type = None;
    let mut file_body = None;
    let mut issue_comment_id = None;
    let mut usage = None;
    while let Some(field) = multipart.next().await {
        let Ok(mut field) = field else {
            return Err(HttpResponse::BadRequest().json(json!({"error":"Invalid attachment form"})));
        };
        let name = field.name().unwrap_or_default().to_owned();
        let field_filename = field
            .content_disposition()
            .and_then(|value| value.get_filename())
            .map(ToOwned::to_owned);
        if let Some(field_filename) = field_filename {
            if name != "file" || file_body.is_some() {
                return Err(HttpResponse::BadRequest().json(json!({"error":"Unexpected field"})));
            }
            let field_type = field
                .content_type()
                .map(|value| value.essence_str().to_ascii_lowercase())
                .unwrap_or_else(|| "application/octet-stream".to_owned());
            let bytes = match field.bytes(attachment_max_bytes()).await {
                Err(_) => {
                    return Err(HttpResponse::UnprocessableEntity().json(json!({
                        "error":format!("Attachment exceeds {} bytes", attachment_max_bytes())
                    })));
                }
                Ok(Err(_)) => {
                    return Err(
                        HttpResponse::BadRequest().json(json!({"error":"Invalid attachment form"}))
                    );
                }
                Ok(Ok(bytes)) => bytes,
            };
            filename = Some(field_filename);
            content_type = Some(field_type);
            file_body = Some(bytes.to_vec());
            continue;
        }
        let bytes =
            match field.bytes(MAX_METADATA_FIELD_BYTES).await {
                Err(_) => {
                    return Err(HttpResponse::BadRequest()
                        .json(json!({"error":"Invalid attachment metadata"})));
                }
                Ok(Err(_)) => {
                    return Err(HttpResponse::BadRequest()
                        .json(json!({"error":"Invalid attachment metadata"})));
                }
                Ok(Ok(bytes)) => bytes,
            };
        if !matches!(name.as_str(), "issueCommentId" | "usage") {
            continue;
        }
        let value = String::from_utf8_lossy(&bytes).into_owned();
        let target = if name == "issueCommentId" {
            &mut issue_comment_id
        } else {
            &mut usage
        };
        if target.replace(value).is_some() {
            return Err(invalid_attachment_metadata_response());
        }
    }
    Ok(file_body.map(|body| UploadForm {
        filename: filename.filter(|value| !value.is_empty()),
        content_type: content_type.unwrap_or_else(|| "application/octet-stream".to_owned()),
        body,
        issue_comment_id,
        usage,
    }))
}

#[allow(clippy::result_large_err)]
fn validated_workspace_path(body: &[u8]) -> Result<String, HttpResponse> {
    let value: Value = serde_json::from_slice(body).map_err(|_| {
        HttpResponse::BadRequest().json(json!({"error":"Validation error","details":[]}))
    })?;
    let path = value
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.encode_utf16().count() <= 2048)
        .ok_or_else(|| {
            HttpResponse::BadRequest().json(json!({"error":"Validation error","details":[{
                "code":"invalid_type","expected":"string","received":"undefined","path":["path"],"message":"Required"
            }]}))
        })?;
    Ok(path.to_owned())
}

struct WorkspaceFile {
    normalized_path: String,
    filename: String,
    content_type: String,
    body: Vec<u8>,
}

async fn read_library_attachment_file(
    root: &Path,
    file_path: &str,
) -> Result<WorkspaceFile, (StatusCode, String)> {
    let requested = file_path.trim();
    if requested.contains('\\')
        || requested.starts_with('/')
        || requested
            .split('/')
            .any(|segment| matches!(segment, "." | ".."))
    {
        return Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            "Requested path must stay inside the organization Library root".to_owned(),
        ));
    }
    let root_metadata = tokio::fs::symlink_metadata(root).await.map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            "The shared Library root is not available on this machine yet.".to_owned(),
        )
    })?;
    if root_metadata.file_type().is_symlink() {
        return Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            "The organization Library root cannot be a symbolic link".to_owned(),
        ));
    }
    if !root_metadata.is_dir() {
        return Err((
            StatusCode::NOT_FOUND,
            "The shared Library root is not available on this machine yet.".to_owned(),
        ));
    }
    let normalized_root = lexical_normalize(root);
    let candidate = lexical_normalize(&normalized_root.join(requested));
    let normalized_path = candidate
        .strip_prefix(&normalized_root)
        .map(portable_relative_path)
        .map_err(|_| {
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                "Requested path must stay inside the organization Library root".to_owned(),
            )
        })?;
    let canonical_root = tokio::fs::canonicalize(&normalized_root)
        .await
        .map_err(|_| {
            (
                StatusCode::NOT_FOUND,
                "The shared Library root is not available on this machine yet.".to_owned(),
            )
        })?;
    let canonical_target = tokio::fs::canonicalize(&candidate).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            (
                StatusCode::NOT_FOUND,
                "File not found inside the organization Library".to_owned(),
            )
        } else {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Internal server error".to_owned(),
            )
        }
    })?;
    let canonical_relative = canonical_target
        .strip_prefix(&canonical_root)
        .map(portable_relative_path)
        .map_err(|_| {
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                "Requested path must stay inside the organization Library root".to_owned(),
            )
        })?;
    if is_protected_library_path(&canonical_relative)
        && !is_protected_library_path(&normalized_path)
    {
        return Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            "Requested path cannot alias a protected organization Library root".to_owned(),
        ));
    }
    let metadata = tokio::fs::metadata(&canonical_target).await.map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            "File not found inside the organization Library".to_owned(),
        )
    })?;
    if !metadata.is_file() {
        return Err((
            StatusCode::NOT_FOUND,
            "File not found inside the organization Library".to_owned(),
        ));
    }
    if metadata.len() > attachment_max_bytes() as u64 {
        return Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("Attachment exceeds {} bytes", attachment_max_bytes()),
        ));
    }
    let filename = candidate
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    let body = tokio::fs::read(&canonical_target).await.map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error".to_owned(),
        )
    })?;
    let content_type = workspace_content_type(&normalized_path, &body);
    Ok(WorkspaceFile {
        normalized_path,
        filename,
        content_type,
        body,
    })
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => result.push(prefix.as_os_str()),
            Component::RootDir => result.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            Component::Normal(value) => result.push(value),
        }
    }
    result
}

fn portable_relative_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn is_protected_library_path(path: &str) -> bool {
    matches!(path.split('/').next(), Some("agents" | "skills"))
}

fn workspace_content_type(path: &str, body: &[u8]) -> String {
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let content_type = match extension.as_str() {
        "md" | "markdown" => "text/markdown",
        "txt" => "text/plain",
        "json" => "application/json",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "jpeg" | "jpg" => "image/jpeg",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "mp4" => "video/mp4",
        "m4v" => "video/x-m4v",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "avi" => "video/x-msvideo",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "wav" => "audio/wav",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        _ if body.contains(&0) => "application/octet-stream",
        _ => "text/plain",
    };
    content_type.to_owned()
}

fn attachment_max_bytes() -> usize {
    std::env::var("RUDDER_ATTACHMENT_MAX_BYTES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_ATTACHMENT_BYTES)
}

fn allowed_attachment_types() -> Vec<String> {
    const DEFAULTS: &[&str] = &[
        "image/png",
        "image/jpeg",
        "image/jpg",
        "image/webp",
        "image/gif",
        "application/pdf",
        "text/markdown",
        "text/plain",
        "application/json",
        "text/csv",
        "text/html",
    ];
    let Some(raw) = std::env::var("RUDDER_ALLOWED_ATTACHMENT_TYPES").ok() else {
        return DEFAULTS.iter().map(|value| (*value).to_owned()).collect();
    };
    let parsed = raw
        .split(',')
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if parsed.is_empty() {
        DEFAULTS.iter().map(|value| (*value).to_owned()).collect()
    } else {
        parsed
    }
}

fn is_allowed_content_type(content_type: &str) -> bool {
    let content_type = content_type.to_ascii_lowercase();
    allowed_attachment_types().iter().any(|pattern| {
        if pattern == "*" {
            true
        } else if pattern.ends_with("/*") || pattern.ends_with(".*") {
            content_type.starts_with(&pattern[..pattern.len() - 1])
        } else {
            content_type == *pattern
        }
    })
}

fn is_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok()
}

fn invalid_attachment_metadata() -> HttpResponse {
    invalid_attachment_metadata_response()
}

fn invalid_attachment_metadata_response() -> HttpResponse {
    HttpResponse::BadRequest().json(json!({
        "error":"Invalid attachment metadata",
        "details":[]
    }))
}

fn attachment_json(status: StatusCode, body: &str) -> HttpResponse {
    match serde_json::from_str::<Value>(body) {
        Ok(value) => HttpResponse::build(status).json(value),
        Err(_) => super::internal_error(),
    }
}

fn attachment_error(error: IssueAttachmentError) -> HttpResponse {
    match error {
        IssueAttachmentError::Http(status, message) => HttpResponse::build(
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        )
        .json(json!({"error":message})),
        IssueAttachmentError::Store(rudder_d1_persistence::StoreError::NotFound) => {
            super::not_found("Issue not found")
        }
        IssueAttachmentError::Store(
            rudder_d1_persistence::StoreError::PublicIdentityUnauthorized,
        )
        | IssueAttachmentError::Store(rudder_d1_persistence::StoreError::Unauthorized) => {
            HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}))
        }
        IssueAttachmentError::Store(rudder_d1_persistence::StoreError::PublicIdentityForbidden)
        | IssueAttachmentError::Store(rudder_d1_persistence::StoreError::GoalForbidden) => {
            HttpResponse::Forbidden()
                .json(json!({"error":"User does not have access to this organization"}))
        }
        error => {
            tracing::warn!(error = %error, "public Issue attachment operation failed");
            super::internal_error()
        }
    }
}

fn storage_unavailable() -> HttpResponse {
    HttpResponse::ServiceUnavailable()
        .json(json!({"error":"Issue attachment storage is unavailable"}))
}
