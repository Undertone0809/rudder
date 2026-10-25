use crate::{
    constants::{POSTGRES_MAJOR, VERSION_TIMEOUT},
    error::OwnerError,
    platform::{ParentMonitor, directory_identity, postgres_command_path},
    process::supervised_spawn,
    protocol::{PROTOCOL_SCHEMA, StartRequest},
};
use std::{
    fs, io,
    net::TcpListener,
    path::{Path, PathBuf},
};
use tokio::{
    io::AsyncReadExt,
    process::Command,
    sync::watch,
    time::{Instant, sleep},
};

pub(crate) fn validate_request(request: &StartRequest) -> Result<(), OwnerError> {
    if request.schema != PROTOCOL_SCHEMA || request.op != "start" {
        return Err(OwnerError::new(
            "protocol_invalid_operation",
            "expected a start request with the supported schema",
        ));
    }
    if request.instance_id.trim().is_empty() || request.instance_id.len() > 256 {
        return Err(OwnerError::new(
            "invalid_instance_id",
            "instance_id must contain 1 to 256 characters",
        ));
    }
    if !request.data_dir.is_absolute() || !request.bin_dir.is_absolute() {
        return Err(OwnerError::new(
            "invalid_path",
            "data_dir and bin_dir must be absolute paths",
        ));
    }
    if request.password.is_empty() || request.password.contains(['\n', '\r', '\0']) {
        return Err(OwnerError::new(
            "invalid_password",
            "password must be non-empty and contain no line breaks or NUL",
        ));
    }
    if !is_safe_identifier(&request.user) || !is_safe_identifier(&request.database) {
        return Err(OwnerError::new(
            "invalid_identifier",
            "database and user must use letters, digits, and underscores, and start with a letter or underscore",
        ));
    }
    if request
        .fallback_passwords
        .iter()
        .any(|value| value.contains(['\n', '\r', '\0']))
    {
        return Err(OwnerError::new(
            "invalid_password",
            "fallback passwords cannot contain line breaks or NUL",
        ));
    }
    if request.parent_pid == Some(0) || request.parent_pid == Some(std::process::id()) {
        return Err(OwnerError::new(
            "invalid_parent",
            "parent_pid must identify the direct supervising process",
        ));
    }
    Ok(())
}

fn is_safe_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first.is_ascii_alphabetic())
        && chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

pub(crate) fn canonical_data_dir(path: &Path) -> Result<PathBuf, OwnerError> {
    let parent = path
        .parent()
        .ok_or_else(|| OwnerError::new("invalid_data_dir", "data_dir must have a parent"))?;
    let name = path
        .file_name()
        .ok_or_else(|| OwnerError::new("invalid_data_dir", "data_dir must name a directory"))?;
    if name.is_empty() || name == "." || name == ".." {
        return Err(OwnerError::new(
            "invalid_data_dir",
            "data_dir must name a directory",
        ));
    }
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(parent).map_err(|error| {
        OwnerError::io("invalid_data_dir", "cannot create data_dir parent", error)
    })?;
    let canonical_parent = parent.canonicalize().map_err(|error| {
        OwnerError::io("invalid_data_dir", "cannot resolve data_dir parent", error)
    })?;
    let candidate = canonical_parent.join(name);
    if candidate.exists() {
        let canonical = candidate.canonicalize().map_err(|error| {
            OwnerError::io("invalid_data_dir", "cannot resolve data_dir", error)
        })?;
        if !canonical.is_dir() {
            return Err(OwnerError::new(
                "invalid_data_dir",
                "data_dir is not a directory",
            ));
        }
        Ok(canonical)
    } else {
        Ok(candidate)
    }
}

pub(crate) fn create_staging_data_dir(data_dir: &Path) -> Result<tempfile::TempDir, OwnerError> {
    let parent = data_dir
        .parent()
        .ok_or_else(|| OwnerError::new("invalid_data_dir", "data_dir has no parent"))?;
    tempfile::Builder::new()
        .prefix(".rudder-postgres-initdb-")
        .tempdir_in(parent)
        .map_err(|error| {
            OwnerError::io(
                "initdb_staging_failed",
                "cannot create an isolated PostgreSQL initialization directory",
                error,
            )
        })
}

/// Publish a completed cluster by atomically renaming its sibling staging
/// directory into place. Only an existing empty target is removed, using the
/// non-recursive operation while the caller holds the PGDATA lease.
pub(crate) fn publish_staging_data_dir(
    staging: tempfile::TempDir,
    data_dir: &Path,
) -> Result<(), OwnerError> {
    let staging_path = staging.path().to_path_buf();
    if staging_path.parent() != data_dir.parent() {
        return Err(OwnerError::new(
            "initdb_publish_failed",
            "initialization staging directory is not a sibling of PGDATA",
        ));
    }

    let mut removed_empty_target = false;
    match fs::symlink_metadata(data_dir) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(OwnerError::new(
                "initdb_publish_failed",
                "PGDATA target changed to a non-directory during initialization",
            ));
        }
        Ok(metadata) => {
            let identity = directory_identity(data_dir, &metadata).ok_or_else(|| {
                OwnerError::new(
                    "initdb_publish_failed",
                    "cannot establish the OS identity of the empty PGDATA target",
                )
            })?;
            let mut entries = fs::read_dir(data_dir).map_err(|error| {
                OwnerError::io(
                    "initdb_publish_failed",
                    "cannot inspect PGDATA before publishing the initialized cluster",
                    error,
                )
            })?;
            if entries.next().is_some() {
                return Err(OwnerError::new(
                    "initdb_publish_failed",
                    "PGDATA became non-empty during initialization; existing files were preserved",
                ));
            }
            let current = fs::symlink_metadata(data_dir).map_err(|error| {
                OwnerError::io(
                    "initdb_publish_failed",
                    "cannot recheck PGDATA identity before publishing the initialized cluster",
                    error,
                )
            })?;
            if current.file_type().is_symlink()
                || !current.is_dir()
                || directory_identity(data_dir, &current) != Some(identity)
            {
                return Err(OwnerError::new(
                    "initdb_publish_failed",
                    "PGDATA target changed during initialization; existing files were preserved",
                ));
            }
            fs::remove_dir(data_dir).map_err(|error| {
                OwnerError::io(
                    "initdb_publish_failed",
                    "cannot atomically remove the verified empty PGDATA target",
                    error,
                )
            })?;
            removed_empty_target = true;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(OwnerError::io(
                "initdb_publish_failed",
                "cannot inspect PGDATA before publishing the initialized cluster",
                error,
            ));
        }
    }

    if let Err(error) = fs::rename(&staging_path, data_dir) {
        if removed_empty_target && !data_dir.exists() {
            let _ = fs::create_dir(data_dir);
        }
        // A complete cluster is more valuable than temporary-space cleanup if
        // publication lost a race with another writer.
        let _ = staging.keep();
        return Err(OwnerError::io(
            "initdb_publish_failed",
            "cannot atomically publish the initialized PostgreSQL cluster",
            error,
        ));
    }
    drop(staging);
    Ok(())
}

pub(crate) fn read_cluster_version(data_dir: &Path) -> Result<Option<u32>, OwnerError> {
    let version_path = data_dir.join("PG_VERSION");
    if !version_path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(version_path).map_err(|error| {
        OwnerError::io(
            "cluster_version_unreadable",
            "cannot read PG_VERSION",
            error,
        )
    })?;
    let version = content.trim().parse::<u32>().map_err(|_| {
        OwnerError::new(
            "cluster_version_invalid",
            "PG_VERSION is not a supported major version",
        )
    })?;
    Ok(Some(version))
}

#[derive(Clone, Debug)]
pub(crate) struct Binaries {
    pub(crate) initdb: PathBuf,
    pub(crate) postgres: PathBuf,
    pub(crate) pg_ctl: PathBuf,
}

fn executable_name(bin_dir: &Path, base: &str) -> PathBuf {
    if cfg!(windows) {
        bin_dir.join(format!("{base}.exe"))
    } else {
        bin_dir.join(base)
    }
}

pub(crate) fn resolve_binaries(bin_dir: &Path) -> Result<Binaries, OwnerError> {
    let binaries = Binaries {
        initdb: executable_name(bin_dir, "initdb"),
        postgres: executable_name(bin_dir, "postgres"),
        pg_ctl: executable_name(bin_dir, "pg_ctl"),
    };
    for path in [&binaries.initdb, &binaries.postgres, &binaries.pg_ctl] {
        let metadata = fs::metadata(path).map_err(|error| {
            OwnerError::io(
                "invalid_runtime",
                "required PostgreSQL binary is missing",
                error,
            )
        })?;
        if !metadata.is_file() {
            return Err(OwnerError::new(
                "invalid_runtime",
                "required PostgreSQL binary is not a file",
            ));
        }
    }
    Ok(binaries)
}

async fn command_version(
    path: &Path,
    parent: &ParentMonitor,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<String, OwnerError> {
    check_startup_control(parent, cancellation)?;
    let mut command = Command::new(postgres_command_path(path).as_ref());
    command
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = supervised_spawn(&mut command).map_err(|error| {
        OwnerError::new(
            "binary_version_failed",
            format!(
                "cannot supervise PostgreSQL binary version check ({})",
                error.code
            ),
        )
    })?;
    let mut stdout = child.child_mut().stdout.take().ok_or_else(|| {
        OwnerError::new(
            "binary_version_failed",
            "cannot capture PostgreSQL binary version",
        )
    })?;
    let mut stderr = child.child_mut().stderr.take().ok_or_else(|| {
        OwnerError::new(
            "binary_version_failed",
            "cannot capture PostgreSQL binary version",
        )
    })?;
    let stdout_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await.map(|_| bytes)
    });
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).await.map(|_| bytes)
    });
    let deadline = Instant::now() + VERSION_TIMEOUT;
    let status = loop {
        if let Err(error) = check_startup_control(parent, cancellation) {
            if let Err(cleanup) = child.terminate_and_wait().await {
                return Err(cleanup_failure(error.code, cleanup));
            }
            return Err(error);
        }
        let status = match child.child_mut().try_wait() {
            Ok(status) => status,
            Err(error) => {
                let original = OwnerError::io(
                    "binary_version_failed",
                    "cannot inspect PostgreSQL binary version process",
                    error,
                );
                if let Err(cleanup) = child.terminate_and_wait().await {
                    return Err(cleanup_failure(original.code, cleanup));
                }
                return Err(original);
            }
        };
        if let Some(status) = status {
            if let Err(original) = child.wait_tree_exit(VERSION_TIMEOUT).await {
                if let Err(cleanup) = child.terminate_and_wait().await {
                    return Err(cleanup_failure(original.code, cleanup));
                }
                return Err(original);
            }
            break status;
        }
        if Instant::now() >= deadline {
            child.terminate_and_wait().await?;
            return Err(OwnerError::new(
                "binary_version_timeout",
                "PostgreSQL binary version check timed out",
            ));
        }
        sleep(std::time::Duration::from_millis(25)).await;
    };
    let stdout = stdout_task
        .await
        .map_err(|_| OwnerError::new("binary_version_failed", "version output task failed"))?
        .map_err(|error| {
            OwnerError::io("binary_version_failed", "cannot read version output", error)
        })?;
    let stderr = stderr_task
        .await
        .map_err(|_| OwnerError::new("binary_version_failed", "version error output task failed"))?
        .map_err(|error| {
            OwnerError::io("binary_version_failed", "cannot read version output", error)
        })?;
    if !status.success() {
        return Err(OwnerError::new(
            "binary_version_failed",
            "PostgreSQL binary version check failed",
        ));
    }
    let text = String::from_utf8_lossy(&stdout).to_string() + &String::from_utf8_lossy(&stderr);
    parse_postgres_version(&text).ok_or_else(|| {
        OwnerError::new(
            "binary_version_invalid",
            "PostgreSQL binary did not report a valid version",
        )
    })
}

pub(crate) fn parse_postgres_version(text: &str) -> Option<String> {
    let words = text.split(|character: char| {
        !(character.is_ascii_alphanumeric() || character == '.' || character == '-')
    });
    for word in words {
        let word = word.trim_end_matches(|character: char| {
            character.is_ascii_alphabetic() || character == '-'
        });
        let Some((major, minor)) = word.split_once('.') else {
            continue;
        };
        if major.parse::<u32>().is_ok()
            && minor
                .chars()
                .next()
                .is_some_and(|character| character.is_ascii_digit())
        {
            let minor_digits = minor
                .chars()
                .take_while(|character| character.is_ascii_digit())
                .collect::<String>();
            return Some(format!("{major}.{minor_digits}"));
        }
    }
    None
}

pub(crate) async fn validate_binaries(
    binaries: &Binaries,
    parent: &ParentMonitor,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<String, OwnerError> {
    let versions = [
        command_version(&binaries.initdb, parent, cancellation).await?,
        command_version(&binaries.postgres, parent, cancellation).await?,
        command_version(&binaries.pg_ctl, parent, cancellation).await?,
    ];
    if versions.iter().any(|version| version != &versions[0]) {
        return Err(OwnerError::new(
            "runtime_version_mismatch",
            "initdb, postgres, and pg_ctl versions do not match",
        ));
    }
    let major = versions[0]
        .split('.')
        .next()
        .and_then(|part| part.parse::<u32>().ok());
    if major != Some(POSTGRES_MAJOR) {
        return Err(OwnerError::new(
            "unsupported_runtime_version",
            "PostgreSQL runtime must be major version 18",
        ));
    }
    Ok(versions[0].clone())
}

fn check_startup_control(
    parent: &ParentMonitor,
    cancellation: &watch::Receiver<bool>,
) -> Result<(), OwnerError> {
    if *cancellation.borrow() {
        return Err(OwnerError::new(
            "protocol_start_cancelled",
            "owner input closed before PostgreSQL became ready",
        ));
    }
    parent.ensure_alive()
}

fn cleanup_failure(original_code: &str, cleanup_error: OwnerError) -> OwnerError {
    let context = if original_code == "protocol_start_cancelled" {
        "startup cancellation cleanup could not be verified"
    } else if original_code == "parent_exited" {
        "parent-exit cleanup could not be verified"
    } else {
        "binary-check cleanup could not be verified"
    };
    OwnerError::new(
        "protocol_start_cancel_cleanup_failed",
        format!("{context} ({})", cleanup_error.code),
    )
}

pub(crate) fn resolve_template_dir(bin_dir: &Path) -> Result<PathBuf, OwnerError> {
    let candidates = [
        bin_dir.join("../share/postgresql"),
        bin_dir.join("../share"),
        bin_dir.join("../.."),
    ];
    for candidate in candidates {
        let candidate = match candidate.canonicalize() {
            Ok(path) => path,
            Err(_) => continue,
        };
        if candidate.join("postgres.bki").is_file()
            && candidate.join("postgresql.conf.sample").is_file()
        {
            return Ok(candidate);
        }
    }
    Err(OwnerError::new(
        "invalid_runtime",
        "PostgreSQL runtime has no matching initdb template files",
    ))
}

#[derive(Debug)]
pub(crate) struct PostmasterIdentity {
    pub(crate) pid: u32,
    pub(crate) port: u16,
}

pub(crate) fn read_postmaster_pid(
    path: &Path,
    expected_data_dir: &Path,
) -> Result<PostmasterIdentity, OwnerError> {
    let text = fs::read_to_string(path).map_err(|error| {
        OwnerError::io(
            "postmaster_identity_unreadable",
            "cannot read postmaster.pid",
            error,
        )
    })?;
    let lines = text.lines().collect::<Vec<_>>();
    let pid = lines
        .first()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|pid| *pid > 1)
        .ok_or_else(|| {
            OwnerError::new(
                "postmaster_identity_invalid",
                "postmaster.pid has no valid process identifier",
            )
        })?;
    let recorded_data_dir = lines
        .get(1)
        .map(|value| PathBuf::from(value.trim()))
        .ok_or_else(|| {
            OwnerError::new(
                "postmaster_identity_invalid",
                "postmaster.pid has no data directory",
            )
        })?;
    if !same_path(&recorded_data_dir, expected_data_dir) {
        return Err(OwnerError::new(
            "postmaster_identity_mismatch",
            "postmaster.pid does not identify the requested data directory",
        ));
    }
    let port = lines
        .get(3)
        .and_then(|value| value.trim().parse::<u16>().ok())
        .filter(|port| *port > 0)
        .ok_or_else(|| {
            OwnerError::new(
                "postmaster_identity_invalid",
                "postmaster.pid has no valid port",
            )
        })?;
    Ok(PostmasterIdentity { pid, port })
}

pub(crate) fn same_path(left: &Path, right: &Path) -> bool {
    let left = left.canonicalize().unwrap_or_else(|_| left.to_path_buf());
    let right = right.canonicalize().unwrap_or_else(|_| right.to_path_buf());
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

pub(crate) fn postgres_log_path(data_dir: &Path) -> PathBuf {
    let mut name = data_dir.as_os_str().to_os_string();
    name.push(".postgres.log");
    PathBuf::from(name)
}

pub(crate) fn select_port(configured: u16) -> Result<u16, OwnerError> {
    if configured == 0 {
        return bind_ephemeral_port();
    }
    for offset in 0..10u32 {
        let candidate = u32::from(configured) + offset;
        if candidate > u32::from(u16::MAX) {
            break;
        }
        match TcpListener::bind(("127.0.0.1", candidate as u16)) {
            Ok(listener) => {
                let port = listener
                    .local_addr()
                    .map_err(|error| {
                        OwnerError::io(
                            "port_selection_failed",
                            "cannot inspect selected port",
                            error,
                        )
                    })?
                    .port();
                drop(listener);
                return Ok(port);
            }
            Err(error) if error.kind() == io::ErrorKind::AddrInUse => {}
            Err(error) => {
                return Err(OwnerError::io(
                    "port_selection_failed",
                    "cannot probe configured PostgreSQL port",
                    error,
                ));
            }
        }
    }
    bind_ephemeral_port()
}

fn bind_ephemeral_port() -> Result<u16, OwnerError> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| {
        OwnerError::io(
            "port_selection_failed",
            "cannot select a local PostgreSQL port",
            error,
        )
    })?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|error| {
            OwnerError::io(
                "port_selection_failed",
                "cannot inspect selected port",
                error,
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_parent_creation_preserves_blocking_files_and_neighbor_data() {
        let root = tempfile::tempdir().unwrap();
        let blocker = root.path().join("blocked");
        fs::write(&blocker, "existing user data").unwrap();
        let neighbor = root.path().join("neighbor");
        fs::create_dir(&neighbor).unwrap();
        fs::write(neighbor.join("marker"), "preserved").unwrap();

        let error = canonical_data_dir(&blocker.join("instance/db")).unwrap_err();
        assert_eq!(error.code, "invalid_data_dir");
        assert_eq!(fs::read_to_string(&blocker).unwrap(), "existing user data");
        assert_eq!(
            fs::read_to_string(neighbor.join("marker")).unwrap(),
            "preserved"
        );
    }

    #[test]
    fn version_parser_accepts_supported_release_shapes() {
        assert_eq!(
            parse_postgres_version("postgres (PostgreSQL) 18.4"),
            Some("18.4".into())
        );
        assert_eq!(
            parse_postgres_version("PostgreSQL 18.1-beta1"),
            Some("18.1".into())
        );
        assert_eq!(
            parse_postgres_version("PostgreSQL 17.10"),
            Some("17.10".into())
        );
        assert_eq!(parse_postgres_version("not a postgres binary"), None);
    }

    #[test]
    fn incompatible_postmaster_identity_is_preserved() {
        let root = tempfile::tempdir().unwrap();
        let data_dir = root.path().join("cluster");
        fs::create_dir(&data_dir).unwrap();
        let pid_path = data_dir.join("postmaster.pid");
        let original = "321\n/elsewhere\n\n5432\n";
        fs::write(&pid_path, original).unwrap();
        let error = read_postmaster_pid(&pid_path, &data_dir).unwrap_err();
        assert_eq!(error.code, "postmaster_identity_mismatch");
        assert_eq!(fs::read_to_string(pid_path).unwrap(), original);
    }

    #[test]
    fn completed_staging_directory_publishes_over_only_an_empty_target() {
        let root = tempfile::tempdir().unwrap();
        let data_dir = root.path().join("cluster");
        fs::create_dir(&data_dir).unwrap();
        let staging = create_staging_data_dir(&data_dir).unwrap();
        fs::write(staging.path().join("PG_VERSION"), "18\n").unwrap();

        publish_staging_data_dir(staging, &data_dir).unwrap();

        assert_eq!(
            fs::read_to_string(data_dir.join("PG_VERSION")).unwrap(),
            "18\n"
        );
    }

    #[test]
    fn nonempty_pgdata_is_preserved_when_staged_publish_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        let data_dir = root.path().join("cluster");
        fs::create_dir(&data_dir).unwrap();
        fs::write(data_dir.join("user-marker"), "preserve me").unwrap();
        let staging = create_staging_data_dir(&data_dir).unwrap();
        fs::write(staging.path().join("PG_VERSION"), "18\n").unwrap();

        let error = publish_staging_data_dir(staging, &data_dir).unwrap_err();

        assert_eq!(error.code, "initdb_publish_failed");
        assert_eq!(
            fs::read_to_string(data_dir.join("user-marker")).unwrap(),
            "preserve me"
        );
    }

    #[test]
    fn request_validation_redacts_credentials_and_rejects_unsafe_paths() {
        let fixture_password = format!("fixture-redaction-{}", std::process::id());
        let request = StartRequest {
            schema: PROTOCOL_SCHEMA.into(),
            op: "start".into(),
            instance_id: "test".into(),
            data_dir: PathBuf::from("relative"),
            port: 5432,
            bin_dir: PathBuf::from("relative-bin"),
            database: "rudder".into(),
            user: "rudder".into(),
            password: fixture_password.clone(),
            fallback_passwords: vec![],
            parent_pid: None,
        };
        let error = validate_request(&request).unwrap_err();
        let serialized = serde_json::to_string(&error.response()).unwrap();
        assert_eq!(error.code, "invalid_path");
        assert!(!serialized.contains(&fixture_password));
    }

    #[test]
    fn identifiers_are_restricted_to_safe_sql_names() {
        assert!(is_safe_identifier("rudder_1"));
        assert!(!is_safe_identifier("bad-name"));
        assert!(!is_safe_identifier("1bad"));
    }
}
