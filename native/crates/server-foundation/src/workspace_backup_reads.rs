//! Default public backup reads cross this signed private boundary. The old
//! experimental public-ingress routes remain separate; they cannot authorize
//! calls here or substitute for Node's Board/organization authentication.
use crate::workspace_backup_files::{
    ArtifactError, DownloadArtifact, file_list_receipt, file_read_receipt, load_entries,
    normalize_directory_path, prepare_download, read_file,
};
use crate::{ActorEnvelopeVerificationError, AppState, DatabaseState, DownloadCancellation};
use actix_web::{
    HttpRequest, HttpResponse,
    http::{StatusCode, header},
    web,
};
use futures_util::StreamExt;
use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
};
use tokio_util::io::ReaderStream;

pub const WORKSPACE_BACKUP_READ_ACTION: &str = "organization.workspace.backup.read";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupReadRequest {
    backup_id: String,
    operation: Operation,
    path: String,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Operation {
    Files,
    File,
    Download,
}

fn error(status: StatusCode, message: impl AsRef<str>) -> HttpResponse {
    HttpResponse::build(status).json(serde_json::json!({"error": message.as_ref()}))
}

fn artifact_error(reason: ArtifactError, archive: &Path, path: &str) -> HttpResponse {
    match reason {
        ArtifactError::NotFound => {
            error(StatusCode::NOT_FOUND, "Workspace backup artifact not found")
        }
        ArtifactError::FileNotFound => error(
            StatusCode::NOT_FOUND,
            "File not found inside the workspace backup",
        ),
        ArtifactError::ArchiveChecksumMismatch => error(
            StatusCode::UNPROCESSABLE_ENTITY,
            if archive
                .extension()
                .is_some_and(|value| value.eq_ignore_ascii_case("zip"))
            {
                "Workspace backup v2 artifact is invalid: Workspace backup artifact checksum does not match the recorded backup metadata"
            } else {
                "Workspace backup artifact checksum does not match the recorded backup metadata"
            },
        ),
        ArtifactError::OrganizationMismatch => error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Workspace backup v2 artifact is invalid: organization identity mismatch",
        ),
        ArtifactError::FileChecksumMismatch => error(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("Workspace backup checksum mismatch: {path}"),
        ),
        ArtifactError::Invalid => error(
            StatusCode::UNPROCESSABLE_ENTITY,
            if archive
                .extension()
                .is_some_and(|value| value.eq_ignore_ascii_case("zip"))
            {
                "Workspace backup v2 artifact is invalid"
            } else {
                "Workspace backup artifact is invalid"
            },
        ),
        ArtifactError::Cancelled => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Rust workspace backup reads are unavailable",
        ),
    }
}

pub(super) async fn workspace_backup_reads(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Bytes,
    org_id: web::Path<String>,
) -> HttpResponse {
    let actor = match state.verify_actor_envelope(
        &request,
        org_id.as_str(),
        WORKSPACE_BACKUP_READ_ACTION,
        None,
        &body,
    ) {
        Ok(actor) => actor,
        Err(ActorEnvelopeVerificationError::Unconfigured) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Rust workspace backup reads are unavailable",
            );
        }
        Err(ActorEnvelopeVerificationError::Invalid) => {
            return error(StatusCode::UNAUTHORIZED, "Unauthorized");
        }
    };
    if actor.actor().kind != "user" {
        return error(StatusCode::FORBIDDEN, "Board access required");
    }
    let input = match serde_json::from_slice::<BackupReadRequest>(&body) {
        Ok(input) => input,
        Err(_) => {
            return error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "Invalid workspace backup read request",
            );
        }
    };
    let DatabaseState::Configured(pool) = &state.database else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Rust workspace backup reads are unavailable",
        );
    };
    // Scope selection in SQL, including deleted rows. There is no unscoped
    // artifact lookup and no filesystem path supplied by the public caller.
    let row = sqlx::query_as::<_, (String, String, Option<String>, String, Option<String>)>(
        "SELECT org_id::text, artifact_ref, archive_sha256, status, error FROM workspace_backups \
         WHERE org_id = $1::uuid AND id = $2::uuid AND status <> 'deleted' LIMIT 1",
    )
    .bind(org_id.as_str())
    .bind(&input.backup_id)
    .fetch_optional(pool)
    .await;
    let (canonical_org_id, artifact_ref, archive_sha256, status, failure) = match row {
        Ok(Some(row)) => row,
        Ok(None) => return error(StatusCode::NOT_FOUND, "Workspace backup not found"),
        Err(_) => return error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
    };
    if status == "running" {
        return error(
            StatusCode::CONFLICT,
            "Workspace backup is still running and cannot be browsed yet",
        );
    }
    if status == "failed" {
        return error(
            StatusCode::UNPROCESSABLE_ENTITY,
            match failure.filter(|value| !value.is_empty()) {
                Some(failure) => format!("Workspace backup failed: {failure}"),
                None => "Workspace backup failed".to_owned(),
            },
        );
    }
    let artifact_path = PathBuf::from(artifact_ref);
    let normalized_path = match normalize_directory_path(&input.path) {
        Ok(path) => path,
        Err(_) => {
            return error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "Backup path must stay inside the organization Library root",
            );
        }
    };
    // PostgreSQL accepts canonical, uppercase and compact UUID forms. Match
    // artifact identity against the stored canonical UUID just as Node did.
    let org_id = canonical_org_id;
    let path_for_read = artifact_path.clone();
    match input.operation {
        Operation::Files => {
            let entries = tokio::task::spawn_blocking(move || {
                load_entries(&path_for_read, &org_id, archive_sha256.as_deref())
            })
            .await;
            match entries {
                Ok(Ok(entries)) => HttpResponse::Ok().json(file_list_receipt(
                    &entries,
                    normalized_path,
                    &input.backup_id,
                )),
                Ok(Err(reason)) => artifact_error(reason, &artifact_path, &normalized_path),
                Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
            }
        }
        Operation::File => {
            let file_path = normalized_path.clone();
            let content = tokio::task::spawn_blocking(move || {
                read_file(
                    &path_for_read,
                    &org_id,
                    archive_sha256.as_deref(),
                    &file_path,
                )
            })
            .await;
            match content {
                Ok(Ok(content)) => HttpResponse::Ok().json(file_read_receipt(
                    &content,
                    normalized_path,
                    &input.backup_id,
                )),
                Ok(Err(reason)) => artifact_error(reason, &artifact_path, &normalized_path),
                Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
            }
        }
        Operation::Download => {
            let permit = match state.download_admission.clone().acquire_owned().await {
                Ok(permit) => permit,
                Err(_) => {
                    return error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Rust workspace backup reads are unavailable",
                    );
                }
            };
            let cancelled = Arc::new(AtomicBool::new(false));
            let cancellation = DownloadCancellation(cancelled.clone());
            let download = tokio::task::spawn_blocking(move || {
                // If the caller disconnects during blocking validation, this
                // task still owns admission until its work actually stops.
                let result = prepare_download(
                    &path_for_read,
                    &org_id,
                    archive_sha256.as_deref(),
                    &cancelled,
                );
                (result, permit)
            })
            .await;
            drop(cancellation);
            let (download, permit) = match download {
                Ok((Ok(download), permit)) => (download, permit),
                Ok((Err(reason), _permit)) => {
                    return artifact_error(reason, &artifact_path, &normalized_path);
                }
                Err(_) => return error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"),
            };
            let stem = artifact_path
                .file_stem()
                .and_then(|name| name.to_str())
                .filter(|name| !name.is_empty())
                .unwrap_or("workspace-backup")
                .replace('"', "");
            let response = |byte_size: u64, sha256: Option<&str>| {
                let mut builder = HttpResponse::Ok();
                builder
                    .insert_header((header::CONTENT_TYPE, "application/zip"))
                    .insert_header((header::CONTENT_LENGTH, byte_size.to_string()))
                    .insert_header((header::CACHE_CONTROL, "private, max-age=60"))
                    .insert_header((header::X_CONTENT_TYPE_OPTIONS, "nosniff"))
                    .insert_header((
                        header::CONTENT_DISPOSITION,
                        format!("attachment; filename=\"{stem}.zip\""),
                    ));
                if let Some(hash) = sha256 {
                    builder.insert_header(("x-rudder-archive-sha256", hash));
                }
                builder
            };
            match download {
                DownloadArtifact::File {
                    file,
                    byte_size,
                    sha256,
                } => response(byte_size, sha256.as_deref()).streaming(
                    ReaderStream::new(tokio::fs::File::from_std(file)).map(move |chunk| {
                        let _admission = &permit;
                        chunk
                    }),
                ),
                DownloadArtifact::Bytes { bytes, sha256 } => {
                    response(bytes.len() as u64, Some(&sha256))
                        .streaming(legacy_download_stream(bytes, permit))
                }
            }
        }
    }
}

fn legacy_download_stream(
    bytes: Vec<u8>,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> impl futures_util::Stream<Item = Result<web::Bytes, std::io::Error>> {
    // Retain admission while a slow reader retains the archive. Copy bounded
    // chunks rather than slicing shared Bytes: a queued final 64 KiB slice must
    // not retain the entire 100 MiB archive after admission has been released.
    futures_util::stream::unfold(
        (bytes, 0usize, permit),
        |(bytes, offset, permit)| async move {
            if offset == bytes.len() {
                return None;
            }
            let end = (offset + 64 * 1024).min(bytes.len());
            let chunk = web::Bytes::copy_from_slice(&bytes[offset..end]);
            Some((Ok(chunk), (bytes, end, permit)))
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ACTOR_ENVELOPE_AUDIENCE, ACTOR_ENVELOPE_HEADER, ACTOR_ENVELOPE_REQUEST_ID_HEADER,
        ActorEnvelope, ActorIdentity, ServerConfig, SigningKey, unix_time_seconds,
    };
    use actix_web::test::TestRequest;

    const ORG: &str = "10000000-0000-4000-8000-000000000001";
    const PATH: &str = "/internal/orgs/10000000-0000-4000-8000-000000000001/workspace/backup-reads";
    const KEY: &[u8] = b"synthetic-backup-read-test-key";

    fn state() -> web::Data<AppState> {
        web::Data::new(
            AppState::new(ServerConfig {
                actor_envelope_key: Some(SigningKey::new(KEY).unwrap()),
                ..ServerConfig::default()
            })
            .unwrap(),
        )
    }
    fn body() -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"backupId":"20000000-0000-4000-8000-000000000001", "operation":"files", "path":""})).unwrap()
    }
    fn signed(body: &[u8], actor: &str, change: &str) -> HttpRequest {
        let now = unix_time_seconds();
        let mut envelope = ActorEnvelope::new(
            ActorIdentity::new(actor, "synthetic").unwrap(),
            ORG,
            "session",
            1,
            ACTOR_ENVELOPE_AUDIENCE,
            "POST",
            PATH,
            WORKSPACE_BACKUP_READ_ACTION,
            body,
            "request",
            format!("nonce-{actor}-{change}"),
            now,
            now + 60,
        )
        .unwrap();
        match change {
            "org" => envelope.organization_id = "10000000-0000-4000-8000-000000000002".to_owned(),
            "action" => envelope.action = "organization.workspace.backups.list".to_owned(),
            "path" => envelope.path = format!("{PATH}?injected=true"),
            "method" => envelope.method = "GET".to_owned(),
            "request" => envelope.request_id = "other".to_owned(),
            _ => (),
        }
        let envelope = envelope.sign(KEY).unwrap();
        TestRequest::post()
            .uri(PATH)
            .insert_header((
                ACTOR_ENVELOPE_HEADER,
                serde_json::to_string(&envelope).unwrap(),
            ))
            .insert_header((ACTOR_ENVELOPE_REQUEST_ID_HEADER, "request"))
            .to_http_request()
    }
    async fn call(state: web::Data<AppState>, request: HttpRequest, body: Vec<u8>) -> HttpResponse {
        workspace_backup_reads(
            state,
            request,
            web::Bytes::from(body),
            web::Path::from(ORG.to_owned()),
        )
        .await
    }

    #[actix_web::test]
    async fn download_admission_lives_until_slow_body_is_consumed_or_disconnected() {
        let admission = Arc::new(tokio::sync::Semaphore::new(1));
        let permit = admission.clone().acquire_owned().await.unwrap();
        let mut stream = Box::pin(legacy_download_stream(vec![7; 150_000], permit));
        assert_eq!(admission.available_permits(), 0);
        let first = stream.next().await.unwrap().unwrap();
        assert_eq!(first.len(), 64 * 1024);
        assert_eq!(admission.available_permits(), 0);
        assert!(admission.clone().try_acquire_owned().is_err());
        // Dropping a partially consumed body models a client disconnect.
        drop(stream);
        assert_eq!(admission.available_permits(), 1);
        assert_eq!(first[0], 7);
        let permit = admission.clone().acquire_owned().await.unwrap();
        let mut stream = Box::pin(legacy_download_stream(vec![9; 150_000], permit));
        let mut received = 0;
        while let Some(chunk) = stream.next().await {
            received += chunk.unwrap().len();
            assert_eq!(admission.available_permits(), 0);
        }
        assert_eq!(received, 150_000);
        assert_eq!(admission.available_permits(), 1);
    }

    #[actix_web::test]
    async fn authenticates_before_body_parsing_and_never_accepts_unscoped_calls() {
        let bad_body = b"not json".to_vec();
        assert_eq!(
            call(
                state(),
                TestRequest::post().uri(PATH).to_http_request(),
                bad_body
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
        for change in ["org", "action", "path", "method", "request"] {
            let body = body();
            assert_eq!(
                call(state(), signed(&body, "user", change), body)
                    .await
                    .status(),
                StatusCode::UNAUTHORIZED,
                "{change}"
            );
        }
        let body = body();
        assert_eq!(
            call(state(), signed(&body, "agent", "valid"), body)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
    }

    #[actix_web::test]
    async fn binds_operation_and_rejects_replay_and_unknown_fields() {
        let data = state();
        let body = body();
        let request = signed(&body, "user", "valid");
        assert_eq!(
            call(data.clone(), request.clone(), body.clone())
                .await
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            call(data, request, body.clone()).await.status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            call(
                state(),
                signed(&body, "user", "tampered"),
                br#"{"backupId":"other","operation":"download","path":""}"#.to_vec()
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
        for malformed in [
            br#"{"backupId":"x","operation":"delete","path":""}"#.as_slice(),
            br#"{"backupId":"x","operation":"files","path":"","artifactRef":"/etc/passwd"}"#
                .as_slice(),
            br#"{"backupId":"x","operation":"files"}"#.as_slice(),
        ] {
            assert_eq!(
                call(
                    state(),
                    signed(malformed, "user", "invalid"),
                    malformed.to_vec()
                )
                .await
                .status(),
                StatusCode::UNPROCESSABLE_ENTITY
            );
        }
    }
}
