//! Native file-backed Run and workspace-operation log pages.
use super::*;
use rudder_run_evidence_core::{EvidenceReadPage, read_run_log_range_with_limit};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

#[allow(clippy::too_many_arguments)]
pub(super) async fn read(
    pool: &sqlx::PgPool,
    identity: &NativeIngressIdentity,
    auth: &MemberDirectoryNativeAuth<'_>,
    request: &HttpRequest,
    org: &str,
    id: &str,
    workspace: bool,
    missing_entity: &'static str,
) -> HttpResponse {
    let owner = match crate::run_reads::native_run_owner(identity) {
        Ok(owner) => owner,
        Err(response) => return response,
    };
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(error) => return db_error(error),
    };
    match auth.revalidate(&mut tx, org).await {
        Ok(MemberDirectoryNativeAccess::Authorized) => {}
        Ok(MemberDirectoryNativeAccess::Unauthorized) => {
            return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
        }
        Ok(MemberDirectoryNativeAccess::Forbidden) => {
            return json_error(
                StatusCode::FORBIDDEN,
                match identity {
                    NativeIngressIdentity::AgentKey { .. } | NativeIngressIdentity::AgentJwt(_) => {
                        "Agent key cannot access another organization"
                    }
                    _ => "User does not have access to this organization",
                },
            );
        }
        Err(error) => return db_error(error),
    }
    let query = if workspace {
        let unbound = crate::run_visibility::unbound_workspace_visible("w");
        format!(
            "SELECT w.log_store,w.log_ref FROM workspace_operations w WHERE w.org_id=$1::uuid AND w.id=$2::uuid AND ((w.heartbeat_run_id IS NOT NULL AND EXISTS(SELECT 1 FROM visible_runs admitted WHERE admitted.id=w.heartbeat_run_id)) OR (w.heartbeat_run_id IS NULL AND ({unbound})))"
        )
    } else {
        "SELECT r.log_store,r.log_ref FROM heartbeat_runs r WHERE r.org_id=$1::uuid AND r.id=$2::uuid".to_owned()
    };
    let query = crate::run_visibility::scoped_query(&query, 3);
    let row = match sqlx::query(&query)
        .bind(org)
        .bind(id)
        .bind(owner)
        .fetch_optional(&mut *tx)
        .await
    {
        Ok(Some(row)) => row,
        Ok(None) => return not_found(missing_entity),
        Err(error) => return db_error(error),
    };
    if let Err(error) = tx.commit().await {
        return db_error(error);
    }
    let missing_log = if workspace {
        "Workspace operation log not found"
    } else {
        "Run log not found"
    };
    let (store, log_ref) = match (
        row.try_get::<Option<String>, _>("log_store"),
        row.try_get::<Option<String>, _>("log_ref"),
    ) {
        (Ok(Some(store)), Ok(Some(log_ref))) if store == "local_file" && !log_ref.is_empty() => {
            (store, log_ref)
        }
        (Ok(_), Ok(_)) => return not_found(missing_log),
        _ => return internal_error(),
    };
    let base = match log_base(org, workspace) {
        Ok(base) => base,
        Err(()) => return internal_error(),
    };
    let query = query_values(request.query_string());
    let offset = number_query(&query, "offset", 0.0);
    let limit = number_query(&query, "limitBytes", 256_000.0);
    let file_ref = log_ref.clone();
    let page = match tokio::task::spawn_blocking(move || {
        read_page(&base, &file_ref, offset, limit, workspace)
    })
    .await
    {
        Ok(Ok(page)) => page,
        Ok(Err(LogError::Missing)) => return not_found(missing_log),
        Ok(Err(LogError::Invalid)) | Err(_) => return internal_error(),
    };
    let mut redaction: crate::run_reads::redaction::Redaction =
        match serde_json::from_value(run_read_redaction()) {
            Ok(value) => value,
            Err(_) => return internal_error(),
        };
    redaction.enabled = match crate::run_reads::log_redaction_enabled(pool).await {
        Ok(enabled) => enabled,
        Err(error) => return db_error(error),
    };
    let mut result = json!({"store":store,"logRef":log_ref,"content":page.content,
        "endOffset":page.end_offset,"eof":page.eof});
    result[if workspace { "operationId" } else { "runId" }] = json!(id);
    if let Some(next) = page.next_offset {
        result["nextOffset"] = json!(next);
    }
    // Reuse the existing Rust string masker, preserving byte offsets from disk.
    let content = serde_json::to_string(&result["content"]).expect("JSON value serialization");
    result["content"] = match crate::run_reads::redaction::redact_json(&content, &redaction, false)
        .and_then(|raw| serde_json::from_str(&raw))
    {
        Ok(value) => value,
        Err(_) => return internal_error(),
    };
    HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-cache, no-store, must-revalidate"))
        .json(result)
}

fn log_base(org: &str, workspace: bool) -> Result<PathBuf, ()> {
    let variable = if workspace {
        "WORKSPACE_OPERATION_LOG_BASE_PATH"
    } else {
        "RUN_LOG_BASE_PATH"
    };
    if let Some(value) = std::env::var_os(variable) {
        return Ok(PathBuf::from(value));
    }
    Ok(PathBuf::from(agent_core::instance_root(org)?)
        .join("data")
        .join(if workspace {
            "workspace-operation-logs"
        } else {
            "run-logs"
        }))
}

#[derive(Debug)]
enum LogError {
    Missing,
    Invalid,
}

fn read_page(
    base: &Path,
    reference: &str,
    offset: f64,
    limit: f64,
    workspace: bool,
) -> Result<EvidenceReadPage, LogError> {
    let base = base.canonicalize().map_err(|_| LogError::Missing)?;
    let path = base
        .join(reference)
        .canonicalize()
        .map_err(|_| LogError::Missing)?;
    if !path.starts_with(&base) {
        return Err(LogError::Invalid);
    }
    let metadata = path.metadata().map_err(|_| LogError::Missing)?;
    if !metadata.is_file() {
        return Err(LogError::Invalid);
    }
    let size = metadata.len();
    let start = offset.max(0.0).min(size as f64);
    if size == 0 || start >= size as f64 {
        return Ok(EvidenceReadPage {
            content: String::new(),
            end_offset: size,
            eof: true,
            next_offset: None,
        });
    }
    let end = (start + limit.max(if workspace { 1.0 } else { 4.0 }) - 1.0)
        .min((size - 1) as f64)
        .max(start);
    // Node's stream rejects fractional start/end after clamping to file size.
    if start.fract() != 0.0 || end.fract() != 0.0 {
        return Err(LogError::Invalid);
    }
    let start = start as u64;
    let count = end as u64 + 1 - start;
    if !workspace {
        return read_run_log_range_with_limit(&path, start, count, u64::MAX)
            .map_err(|_| LogError::Invalid);
    }
    let mut file = File::open(path).map_err(|_| LogError::Invalid)?;
    file.seek(SeekFrom::Start(start))
        .map_err(|_| LogError::Invalid)?;
    let mut bytes = vec![0; usize::try_from(count).map_err(|_| LogError::Invalid)?];
    file.read_exact(&mut bytes).map_err(|_| LogError::Invalid)?;
    let end_offset = start + count;
    Ok(EvidenceReadPage {
        content: String::from_utf8_lossy(&bytes).into_owned(),
        end_offset,
        eof: end_offset >= size,
        next_offset: (end_offset < size).then_some(end_offset),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn log_pages_preserve_utf8_offsets_large_limits_and_workspace_raw_bytes() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("run"), "😀hello").unwrap();
        let page = read_page(root.path(), "run", 1.0, 1.0, false).unwrap();
        assert_eq!(page.content, "h");
        assert_eq!(page.next_offset, Some(5));
        let page = read_page(root.path(), "run", 0.0, 1.0, true).unwrap();
        assert_eq!(page.content, "�");
        assert_eq!(page.next_offset, Some(1));
        assert!(read_page(root.path(), "run", 0.5, 2.0, false).is_err());
        let page = read_page(root.path(), "run", 1e20, 0.0, false).unwrap();
        assert!(page.eof);
        std::fs::write(root.path().join("large"), vec![b'x'; 1_000_008]).unwrap();
        let page = read_page(root.path(), "large", -1.0, 2_000_000.0, false).unwrap();
        assert_eq!(page.content.len(), 1_000_008);
        assert!(page.eof);
    }
    #[test]
    fn log_pages_reject_escape_and_report_missing_files() {
        let root = tempfile::tempdir().unwrap();
        let nested = root.path().join("logs");
        std::fs::create_dir(&nested).unwrap();
        std::fs::write(root.path().join("outside"), "secret").unwrap();
        assert!(matches!(
            read_page(&nested, "../outside", 0.0, 4.0, false),
            Err(LogError::Invalid)
        ));
        assert!(matches!(
            read_page(&nested, "missing", 0.0, 4.0, false),
            Err(LogError::Missing)
        ));
    }
}
