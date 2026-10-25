use crate::{
    constants::{POLL_INTERVAL, POSTGRES_MAJOR},
    error::OwnerError,
    lease::{LeaseLock, LeaseMetadata},
    platform::{ParentMonitor, ProcessIdStatus, process_id_status},
    postgres::*,
    protocol::{PROTOCOL_SCHEMA, ReadyResponse, StartRequest, StoppedResponse},
};
use std::{fs, path::PathBuf, time::Duration};
use tokio::{
    io::AsyncBufReadExt,
    net::TcpStream,
    sync::watch,
    time::{Instant, sleep},
};
use uuid::Uuid;

/// A session owns the lock for its entire protocol lifetime. `child` is set
/// only for a PostgreSQL process started by this owner; a verified reused
/// server is never stopped when the session ends.
pub struct OwnerSession {
    pub(crate) ready: ReadyResponse,
    lock: Option<LeaseLock>,
    parent: ParentMonitor,
    child: Option<OwnedPostgresProcess>,
    pg_ctl_binary: PathBuf,
    pub(crate) stopped: bool,
}

impl OwnerSession {
    pub async fn start(
        request: StartRequest,
        mut cancellation: watch::Receiver<bool>,
    ) -> Result<Self, OwnerError> {
        validate_request(&request)?;
        let parent = ParentMonitor::new(request.parent_pid)?;
        check_startup_control(&parent, &cancellation)?;

        let bin_dir = request.bin_dir.canonicalize().map_err(|error| {
            OwnerError::io(
                "invalid_runtime",
                "cannot resolve PostgreSQL runtime directory",
                error,
            )
        })?;
        if !bin_dir.is_dir() {
            return Err(OwnerError::new(
                "invalid_runtime",
                "PostgreSQL runtime directory is not a directory",
            ));
        }
        let binaries = resolve_binaries(&bin_dir)?;
        validate_binaries(&binaries, &parent, &mut cancellation).await?;
        check_startup_control(&parent, &cancellation)?;
        let template_dir = resolve_template_dir(&bin_dir)?;

        // A fresh profile has no instance parent yet. Create it in Rust only
        // after the runtime and supervising process have been validated.
        let data_dir = canonical_data_dir(&request.data_dir)?;
        check_startup_control(&parent, &cancellation)?;

        let lease_id = Uuid::new_v4().to_string();
        let mut lock = match LeaseLock::acquire(&data_dir) {
            Ok(lock) => lock,
            Err(error) if error.code == "owner_busy" => {
                return attach_to_active_owner(
                    request,
                    parent,
                    data_dir,
                    bin_dir,
                    binaries,
                    lease_id,
                    &mut cancellation,
                )
                .await;
            }
            Err(error) => return Err(error),
        };
        check_startup_control(&parent, &cancellation)?;
        match fs::symlink_metadata(&data_dir) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(OwnerError::new(
                    "invalid_data_dir",
                    "PostgreSQL data path is not a real directory",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(OwnerError::io(
                    "invalid_data_dir",
                    "cannot inspect PostgreSQL data path",
                    error,
                ));
            }
        }

        let cluster_version = read_cluster_version(&data_dir)?;
        let pid_file = data_dir.join("postmaster.pid");
        let pid_file_exists = pid_file.exists();
        if let Some(cluster_major) = cluster_version {
            if cluster_major != POSTGRES_MAJOR {
                return Err(OwnerError::new(
                    "incompatible_cluster",
                    format!(
                        "data directory uses PostgreSQL major version {cluster_major}; this owner supports {POSTGRES_MAJOR}"
                    ),
                ));
            }
        } else if data_dir.exists() {
            let mut entries = fs::read_dir(&data_dir).map_err(|error| {
                OwnerError::io(
                    "data_dir_read_failed",
                    "cannot inspect PostgreSQL data directory",
                    error,
                )
            })?;
            if entries.next().is_some() {
                return Err(OwnerError::new(
                    if pid_file_exists {
                        "unverified_postmaster"
                    } else {
                        "incomplete_cluster"
                    },
                    "data directory is non-empty without a compatible PG_VERSION; it was preserved",
                ));
            }
        }

        let mut stale_recovery_port = None;
        if pid_file_exists {
            let recorded = read_postmaster_pid(&pid_file, &data_dir)?;
            let pid_status = process_id_status(recorded.pid);
            if pid_status == ProcessIdStatus::Absent {
                // First allow a live server that already recovered or rewrote
                // postmaster.pid to prove this exact PGDATA through SQL.
                if let Ok(mut verified) = connect_verified(
                    ConnectionConfig {
                        port: recorded.port,
                        data_dir: &data_dir,
                        user: &request.user,
                        password: &request.password,
                        fallbacks: &request.fallback_passwords,
                        normalize_fallback: true,
                    },
                    Some(&parent),
                    Some(&mut cancellation),
                )
                .await
                {
                    check_startup_control(&parent, &cancellation)?;
                    let database_created =
                        ensure_database(&mut verified.connection, &request.database).await?;
                    check_startup_control(&parent, &cancellation)?;
                    let ready = make_ready(
                        &request,
                        ReadyDetails {
                            lease_id: &lease_id,
                            data_dir: data_dir.clone(),
                            bin_dir,
                            port: recorded.port,
                            server_version: verified.server_version,
                            password: verified.password,
                            cluster_created: false,
                            owned: false,
                            database_created,
                        },
                    )?;
                    lock.write_metadata(&LeaseMetadata {
                        schema: PROTOCOL_SCHEMA,
                        lease_id: &lease_id,
                        instance_id: &request.instance_id,
                        owner_pid: std::process::id(),
                        data_dir: &data_dir,
                        port: recorded.port,
                        owned: false,
                    })?;
                    return Ok(Self::new(ready, Some(lock), parent, None, binaries));
                }
                if TcpStream::connect(("127.0.0.1", recorded.port))
                    .await
                    .is_ok()
                {
                    return Err(OwnerError::new(
                        "unverified_postmaster",
                        "the stale postmaster PID has an unverified listener on its recorded port; PGDATA was preserved",
                    ));
                }
                stale_recovery_port = Some(recorded.port);
            } else {
                // A live or identity-unknown PID is protected. Attach only if
                // it proves this exact canonical PGDATA through SQL.
                lock.write_metadata(&LeaseMetadata {
                    schema: PROTOCOL_SCHEMA,
                    lease_id: &lease_id,
                    instance_id: &request.instance_id,
                    owner_pid: std::process::id(),
                    data_dir: &data_dir,
                    port: recorded.port,
                    owned: false,
                })?;
                match connect_verified_until_ready(
                    ConnectionConfig {
                        port: recorded.port,
                        data_dir: &data_dir,
                        user: &request.user,
                        password: &request.password,
                        fallbacks: &request.fallback_passwords,
                        normalize_fallback: true,
                    },
                    &parent,
                    &mut cancellation,
                )
                .await
                {
                    Ok(mut verified) => {
                        check_startup_control(&parent, &cancellation)?;
                        let database_created =
                            ensure_database(&mut verified.connection, &request.database).await?;
                        check_startup_control(&parent, &cancellation)?;
                        let ready = make_ready(
                            &request,
                            ReadyDetails {
                                lease_id: &lease_id,
                                data_dir: data_dir.clone(),
                                bin_dir,
                                port: recorded.port,
                                server_version: verified.server_version,
                                password: verified.password,
                                cluster_created: false,
                                owned: false,
                                database_created,
                            },
                        )?;
                        lock.write_metadata(&LeaseMetadata {
                            schema: PROTOCOL_SCHEMA,
                            lease_id: &lease_id,
                            instance_id: &request.instance_id,
                            owner_pid: std::process::id(),
                            data_dir: &data_dir,
                            port: recorded.port,
                            owned: false,
                        })?;
                        return Ok(Self::new(ready, Some(lock), parent, None, binaries));
                    }
                    Err(error) => {
                        return Err(OwnerError::new(
                            "unverified_postmaster",
                            format!(
                                "live or identity-unknown postmaster PID could not be verified against PGDATA ({})",
                                error.code
                            ),
                        ));
                    }
                }
            }
        }

        // A server can be reachable before or after a PID-file write. Reuse it
        // only after the live SQL identity proves this exact canonical PGDATA.
        if cluster_version.is_some()
            && stale_recovery_port.is_none()
            && let Ok(mut verified) = connect_verified(
                ConnectionConfig {
                    port: request.port,
                    data_dir: &data_dir,
                    user: &request.user,
                    password: &request.password,
                    fallbacks: &request.fallback_passwords,
                    normalize_fallback: true,
                },
                Some(&parent),
                Some(&mut cancellation),
            )
            .await
        {
            check_startup_control(&parent, &cancellation)?;
            let database_created =
                ensure_database(&mut verified.connection, &request.database).await?;
            check_startup_control(&parent, &cancellation)?;
            let ready = make_ready(
                &request,
                ReadyDetails {
                    lease_id: &lease_id,
                    data_dir: data_dir.clone(),
                    bin_dir,
                    port: request.port,
                    server_version: verified.server_version,
                    password: verified.password,
                    cluster_created: false,
                    owned: false,
                    database_created,
                },
            )?;
            lock.write_metadata(&LeaseMetadata {
                schema: PROTOCOL_SCHEMA,
                lease_id: &lease_id,
                instance_id: &request.instance_id,
                owner_pid: std::process::id(),
                data_dir: &data_dir,
                port: request.port,
                owned: false,
            })?;
            return Ok(Self::new(ready, Some(lock), parent, None, binaries));
        }

        // A stale PID is never deleted by Rudder. When the OS proves that its
        // numeric PID is absent, matching-major PostgreSQL gets the final
        // authority to validate and recover the canonical data directory.
        let port = match stale_recovery_port {
            Some(port) => port,
            None => select_port(request.port)?,
        };
        lock.write_metadata(&LeaseMetadata {
            schema: PROTOCOL_SCHEMA,
            lease_id: &lease_id,
            instance_id: &request.instance_id,
            owner_pid: std::process::id(),
            data_dir: &data_dir,
            port,
            owned: true,
        })?;
        check_startup_control(&parent, &cancellation)?;

        let cluster_created = cluster_version.is_none();
        if cluster_created {
            let staging = run_initdb(
                &binaries.initdb,
                &template_dir,
                &data_dir,
                &request.user,
                &request.password,
                &parent,
                &mut cancellation,
            )
            .await?;
            // Validate the isolated output before publishing it. Cancellation
            // or initdb failure leaves the canonical PGDATA untouched.
            if read_cluster_version(staging.path())? != Some(POSTGRES_MAJOR) {
                return Err(OwnerError::new(
                    "initdb_incomplete",
                    "initdb exited without a compatible PG_VERSION; canonical PGDATA was preserved",
                ));
            }
            check_startup_control(&parent, &cancellation)?;
            publish_staging_data_dir(staging, &data_dir)?;
        }
        check_startup_control(&parent, &cancellation)?;

        let log_path = postgres_log_path(&data_dir);
        let mut child = spawn_postgres(
            &binaries.postgres,
            &binaries.pg_ctl,
            &data_dir,
            port,
            &bin_dir,
            &log_path,
        )?;
        let ready_result = wait_until_ready(
            &mut child,
            ConnectionConfig {
                port,
                data_dir: &data_dir,
                user: &request.user,
                password: &request.password,
                fallbacks: &request.fallback_passwords,
                normalize_fallback: true,
            },
            &parent,
            &mut cancellation,
        )
        .await;
        let mut verified = match ready_result {
            Ok(verified) => verified,
            Err(error) => {
                if let Err(cleanup_error) =
                    cleanup_failed_start(&mut child, &binaries.pg_ctl, &data_dir, port, error.code)
                        .await
                {
                    return Err(cleanup_failure(error.code, cleanup_error));
                }
                return Err(error);
            }
        };
        if let Err(error) = check_startup_control(&parent, &cancellation) {
            if let Err(cleanup_error) =
                cleanup_failed_start(&mut child, &binaries.pg_ctl, &data_dir, port, error.code)
                    .await
            {
                return Err(cleanup_failure(error.code, cleanup_error));
            }
            return Err(error);
        }

        let database_created = match ensure_database(&mut verified.connection, &request.database)
            .await
        {
            Ok(created) => created,
            Err(error) => {
                if let Err(cleanup_error) =
                    cleanup_failed_start(&mut child, &binaries.pg_ctl, &data_dir, port, error.code)
                        .await
                {
                    return Err(cleanup_failure(error.code, cleanup_error));
                }
                return Err(error);
            }
        };
        if let Err(error) = check_startup_control(&parent, &cancellation) {
            if let Err(cleanup_error) =
                cleanup_failed_start(&mut child, &binaries.pg_ctl, &data_dir, port, error.code)
                    .await
            {
                return Err(cleanup_failure(error.code, cleanup_error));
            }
            return Err(error);
        }

        let ready = make_ready(
            &request,
            ReadyDetails {
                lease_id: &lease_id,
                data_dir: data_dir.clone(),
                bin_dir,
                port,
                server_version: verified.server_version,
                password: verified.password,
                cluster_created,
                owned: true,
                database_created,
            },
        )?;
        lock.write_metadata(&LeaseMetadata {
            schema: PROTOCOL_SCHEMA,
            lease_id: &lease_id,
            instance_id: &request.instance_id,
            owner_pid: std::process::id(),
            data_dir: &data_dir,
            port,
            owned: true,
        })?;
        Ok(Self::new(ready, Some(lock), parent, Some(child), binaries))
    }

    fn new(
        ready: ReadyResponse,
        lock: Option<LeaseLock>,
        parent: ParentMonitor,
        child: Option<OwnedPostgresProcess>,
        binaries: Binaries,
    ) -> Self {
        Self {
            ready,
            lock,
            parent,
            child,
            pg_ctl_binary: binaries.pg_ctl,
            stopped: false,
        }
    }

    pub fn ready(&self) -> &ReadyResponse {
        &self.ready
    }

    pub fn parent_exited(&self) -> bool {
        self.parent.has_exited()
    }

    /// Stops only a process this owner created. For reuse, closing the lease
    /// leaves the pre-existing server untouched.
    pub async fn stop(&mut self, lease_id: &str) -> Result<(), OwnerError> {
        if lease_id != self.ready.lease_id {
            return Err(OwnerError::new(
                "lease_mismatch",
                "stop request does not own the active PostgreSQL lease",
            ));
        }
        if self.stopped {
            return Ok(());
        }
        if let Some(child) = self.child.as_mut() {
            stop_child(
                child,
                &self.pg_ctl_binary,
                &self.ready.data_dir,
                self.ready.port,
            )
            .await?;
            child.disarm();
        }
        if let Some(lock) = self.lock.as_mut() {
            lock.clear_metadata()?;
        }
        self.lock.take();
        self.child.take();
        self.stopped = true;
        Ok(())
    }

    pub async fn stop_for_parent_exit(&mut self) -> Result<(), OwnerError> {
        self.stop(&self.ready.lease_id.clone()).await
    }

    pub async fn wait_for_input_or_parent<R: AsyncBufReadExt + Unpin>(
        &mut self,
        input: &mut R,
        line: &mut String,
    ) -> Result<Option<usize>, OwnerError> {
        loop {
            if self.parent_exited() {
                self.stop_for_parent_exit().await?;
                return Ok(None);
            }
            tokio::select! {
                result = input.read_line(line) => {
                    return result.map(Some).map_err(|error| OwnerError::io("protocol_read_failed", "cannot read owner protocol", error));
                }
                _ = sleep(POLL_INTERVAL) => {}
            }
        }
    }

    pub fn stopped_response(&self) -> StoppedResponse {
        StoppedResponse {
            schema: PROTOCOL_SCHEMA,
            op: "stopped",
            lease_id: self.ready.lease_id.clone(),
        }
    }
}

async fn attach_to_active_owner(
    request: StartRequest,
    parent: ParentMonitor,
    data_dir: PathBuf,
    bin_dir: PathBuf,
    binaries: Binaries,
    lease_id: String,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<OwnerSession, OwnerError> {
    if read_cluster_version(&data_dir)? != Some(POSTGRES_MAJOR) {
        return Err(OwnerError::new(
            "owner_busy",
            "another owner holds the data-directory lease and no compatible cluster is ready to attach",
        ));
    }
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        check_startup_control(&parent, cancellation)?;
        let port = if data_dir.join("postmaster.pid").exists() {
            read_postmaster_pid(&data_dir.join("postmaster.pid"), &data_dir)
                .ok()
                .map(|identity| identity.port)
                .unwrap_or(request.port)
        } else {
            request.port
        };
        if port > 0
            && let Ok(mut verified) = connect_verified(
                ConnectionConfig {
                    port,
                    data_dir: &data_dir,
                    user: &request.user,
                    password: &request.password,
                    fallbacks: &request.fallback_passwords,
                    normalize_fallback: false,
                },
                Some(&parent),
                Some(cancellation),
            )
            .await
            && database_exists(&mut verified.connection, &request.database)
                .await
                .unwrap_or(false)
        {
            check_startup_control(&parent, cancellation)?;
            let ready = make_ready(
                &request,
                ReadyDetails {
                    lease_id: &lease_id,
                    data_dir,
                    bin_dir,
                    port,
                    server_version: verified.server_version,
                    password: verified.password,
                    cluster_created: false,
                    owned: false,
                    database_created: false,
                },
            )?;
            return Ok(OwnerSession::new(ready, None, parent, None, binaries));
        }
        if Instant::now() >= deadline {
            return Err(OwnerError::new(
                "owner_busy",
                "another owner holds the data-directory lease but its PostgreSQL server could not be safely attached",
            ));
        }
        tokio::select! {
            _ = sleep(POLL_INTERVAL) => {}
            changed = cancellation.changed() => {
                if changed.is_ok() && *cancellation.borrow() {
                    return Err(OwnerError::new(
                        "protocol_start_cancelled",
                        "owner input closed before PostgreSQL became ready; no PostgreSQL process was owned",
                    ));
                }
            }
        }
    }
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
        "failed-start cleanup could not be verified"
    };
    OwnerError::new(
        "protocol_start_cancel_cleanup_failed",
        format!("{context} ({})", cleanup_error.code),
    )
}
