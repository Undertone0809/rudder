#[cfg(unix)]
use crate::platform::current_parent_pid;
use crate::{
    bootstrap::{create_staging_data_dir, postgres_log_path, read_postmaster_pid},
    constants::{INITDB_TIMEOUT, POLL_INTERVAL, STARTUP_TIMEOUT, STOP_TIMEOUT},
    database::{ConnectionConfig, VerifiedConnection, connect_verified},
    error::OwnerError,
    platform::{ParentMonitor, postgres_command_path},
};
#[cfg(unix)]
use std::fs;
use std::{
    fs::OpenOptions,
    io::{self, Write},
    net::TcpStream,
    path::Path,
    process::{ExitStatus, Stdio},
    time::Duration,
};
use tokio::{
    process::{Child, Command},
    sync::watch,
    time::{Instant, sleep, timeout},
};

pub(crate) struct OwnedPostgresProcess {
    child: Child,
    process_group: u32,
    #[cfg(windows)]
    job: ChildJob,
    armed: bool,
}

impl OwnedPostgresProcess {
    pub(crate) fn child_mut(&mut self) -> &mut Child {
        &mut self.child
    }

    pub(crate) fn process_id(&self) -> u32 {
        self.process_group
    }

    pub(crate) async fn terminate_and_wait(&mut self) -> Result<(), OwnerError> {
        self.signal_tree(false)?;
        if self.wait_tree_exit(Duration::from_secs(3)).await.is_ok() {
            return Ok(());
        }
        self.signal_tree(true)?;
        self.wait_tree_exit(STOP_TIMEOUT).await
    }

    pub(crate) async fn wait_tree_exit(&mut self, limit: Duration) -> Result<(), OwnerError> {
        if self
            .child
            .try_wait()
            .map_err(|error| {
                OwnerError::io(
                    "postgres_wait_failed",
                    "cannot inspect owned child process",
                    error,
                )
            })?
            .is_none()
        {
            timeout(limit, self.child.wait())
                .await
                .map_err(|_| {
                    OwnerError::new("postgres_stop_timeout", "owned child process did not exit")
                })?
                .map_err(|error| {
                    OwnerError::io(
                        "postgres_stop_failed",
                        "cannot wait for owned child process",
                        error,
                    )
                })?;
        }
        self.wait_tree_empty(limit).await?;
        self.disarm();
        Ok(())
    }

    async fn wait_tree_empty(&self, limit: Duration) -> Result<(), OwnerError> {
        let deadline = Instant::now() + limit;
        loop {
            if !self.tree_has_processes()? {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(OwnerError::new(
                    "postgres_stop_timeout",
                    "owned PostgreSQL process tree did not fully exit",
                ));
            }
            sleep(POLL_INTERVAL).await;
        }
    }

    fn tree_has_processes(&self) -> Result<bool, OwnerError> {
        #[cfg(unix)]
        {
            let group = i32::try_from(self.process_group).map_err(|_| {
                OwnerError::new("postgres_stop_failed", "owned process group ID is invalid")
            })?;
            let result = unsafe { libc::kill(-group, 0) };
            if result == 0 {
                return Ok(true);
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                Ok(false)
            } else if error.raw_os_error() == Some(libc::EPERM) {
                Ok(true)
            } else {
                Err(OwnerError::io(
                    "postgres_stop_failed",
                    "cannot verify owned process group exit",
                    error,
                ))
            }
        }
        #[cfg(windows)]
        {
            self.job.active_processes()
        }
        #[cfg(not(any(unix, windows)))]
        {
            Ok(false)
        }
    }

    fn signal_tree(&mut self, force: bool) -> Result<(), OwnerError> {
        #[cfg(unix)]
        {
            let group = i32::try_from(self.process_group).map_err(|_| {
                OwnerError::new("postgres_stop_failed", "owned process group ID is invalid")
            })?;
            let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
            if unsafe { libc::kill(-group, signal) } != 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    return Err(OwnerError::io(
                        "postgres_stop_failed",
                        "cannot signal owned PostgreSQL process group",
                        error,
                    ));
                }
            }
        }
        #[cfg(windows)]
        {
            if force {
                self.job.terminate()?;
            } else {
                self.child.start_kill().map_err(|error| {
                    OwnerError::io(
                        "postgres_stop_failed",
                        "cannot terminate owned PostgreSQL",
                        error,
                    )
                })?;
            }
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = force;
            self.child.start_kill().map_err(|error| {
                OwnerError::io(
                    "postgres_stop_failed",
                    "cannot terminate owned PostgreSQL",
                    error,
                )
            })?;
        }
        Ok(())
    }

    pub(crate) fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for OwnedPostgresProcess {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.signal_tree(true);
            let _ = self.child.start_kill();
        }
    }
}

#[cfg(windows)]
struct ChildJob {
    handle: usize,
}

#[cfg(windows)]
impl ChildJob {
    fn assign(child: &Child) -> Result<Self, OwnerError> {
        use std::{mem, ptr};
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                SetInformationJobObject,
            },
        };
        let child_handle = child.raw_handle().ok_or_else(|| {
            OwnerError::new(
                "process_tree_unavailable",
                "cannot retrieve PostgreSQL child process handle",
            )
        })?;
        let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if job.is_null() {
            return Err(OwnerError::io(
                "process_tree_unavailable",
                "cannot create PostgreSQL child job",
                io::Error::last_os_error(),
            ));
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        let assigned =
            configured != 0 && unsafe { AssignProcessToJobObject(job, child_handle as _) } != 0;
        if !assigned {
            let error = io::Error::last_os_error();
            unsafe { CloseHandle(job) };
            return Err(OwnerError::io(
                "process_tree_unavailable",
                "cannot place PostgreSQL child in its cleanup job",
                error,
            ));
        }
        Ok(Self {
            handle: job as usize,
        })
    }

    fn terminate(&self) -> Result<(), OwnerError> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        if unsafe { TerminateJobObject(self.handle as _, 1) } == 0 {
            return Err(OwnerError::io(
                "postgres_stop_failed",
                "cannot terminate owned PostgreSQL child job",
                io::Error::last_os_error(),
            ));
        }
        Ok(())
    }

    fn active_processes(&self) -> Result<bool, OwnerError> {
        use std::{mem, ptr};
        use windows_sys::Win32::System::JobObjects::{
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JobObjectBasicAccountingInformation,
            QueryInformationJobObject,
        };
        let mut information = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let result = unsafe {
            QueryInformationJobObject(
                self.handle as _,
                JobObjectBasicAccountingInformation,
                (&mut information as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                ptr::null_mut(),
            )
        };
        if result == 0 {
            return Err(OwnerError::io(
                "postgres_stop_failed",
                "cannot verify PostgreSQL child job exit",
                io::Error::last_os_error(),
            ));
        }
        Ok(information.ActiveProcesses > 0)
    }
}

#[cfg(windows)]
impl Drop for ChildJob {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle as _) };
    }
}

pub(crate) fn supervised_spawn(command: &mut Command) -> Result<OwnedPostgresProcess, OwnerError> {
    configure_child_process(command)?;
    let child = command.spawn().map_err(|error| {
        OwnerError::io(
            "postgres_start_failed",
            "cannot start PostgreSQL child process",
            error,
        )
    })?;
    let process_group = child.id().ok_or_else(|| {
        OwnerError::new(
            "postgres_start_failed",
            "owned child process has no process ID",
        )
    })?;
    #[cfg(windows)]
    let job = ChildJob::assign(&child)?;
    Ok(OwnedPostgresProcess {
        child,
        process_group,
        #[cfg(windows)]
        job,
        armed: true,
    })
}

fn configure_child_process(_command: &mut Command) -> Result<(), OwnerError> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let expected_parent = std::process::id();
        unsafe {
            _command.as_std_mut().process_group(0).pre_exec(move || {
                #[cfg(target_os = "linux")]
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 {
                    return Err(io::Error::last_os_error());
                }
                if current_parent_pid() != expected_parent {
                    return Err(io::Error::new(
                        io::ErrorKind::Interrupted,
                        "owner exited before PostgreSQL child spawn",
                    ));
                }
                Ok(())
            });
        }
    }
    Ok(())
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

pub(crate) async fn run_initdb(
    initdb: &Path,
    template_dir: &Path,
    data_dir: &Path,
    user: &str,
    password: &str,
    parent: &ParentMonitor,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<tempfile::TempDir, OwnerError> {
    check_startup_control(parent, cancellation)?;
    let staging = create_staging_data_dir(data_dir)?;
    let mut password_file = tempfile::Builder::new()
        .prefix("rudder-postgres-password-")
        .tempfile()
        .map_err(|error| {
            OwnerError::io(
                "password_file_failed",
                "cannot create private PostgreSQL password file",
                error,
            )
        })?;
    password_file
        .write_all(password.as_bytes())
        .and_then(|_| password_file.write_all(b"\n"))
        .and_then(|_| password_file.as_file().sync_all())
        .map_err(|error| {
            OwnerError::io(
                "password_file_failed",
                "cannot write private PostgreSQL password file",
                error,
            )
        })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(password_file.path(), fs::Permissions::from_mode(0o600)).map_err(
            |error| {
                OwnerError::io(
                    "password_file_failed",
                    "cannot protect PostgreSQL password file",
                    error,
                )
            },
        )?;
    }
    let args = [
        "-D".to_owned(),
        postgres_command_path(staging.path())
            .to_string_lossy()
            .into_owned(),
        "-U".to_owned(),
        user.to_owned(),
        "--auth=scram-sha-256".to_owned(),
        "--pwfile".to_owned(),
        postgres_command_path(password_file.path())
            .to_string_lossy()
            .into_owned(),
        "--encoding=UTF8".to_owned(),
        "--locale=C".to_owned(),
        "-L".to_owned(),
        postgres_command_path(template_dir)
            .to_string_lossy()
            .into_owned(),
    ];
    let mut diagnostic_file = tempfile::tempfile().map_err(|error| {
        OwnerError::io(
            "postgres_diagnostic_failed",
            "cannot create private PostgreSQL startup diagnostic file",
            error,
        )
    })?;
    let stdout = diagnostic_file.try_clone().map_err(|error| {
        OwnerError::io(
            "postgres_diagnostic_failed",
            "cannot duplicate private PostgreSQL startup diagnostic file",
            error,
        )
    })?;
    let mut command = Command::new(postgres_command_path(initdb).as_ref());
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(diagnostic_file.try_clone().map_err(
            |error| {
                OwnerError::io(
                    "postgres_diagnostic_failed",
                    "cannot duplicate private PostgreSQL startup diagnostic file",
                    error,
                )
            },
        )?))
        .kill_on_drop(true);
    let mut child = supervised_spawn(&mut command).map_err(|error| {
        OwnerError::new(
            "initdb_start_failed",
            format!("cannot supervise initdb ({})", error.code),
        )
    })?;
    if let Err(error) =
        wait_command(&mut child, INITDB_TIMEOUT, parent, cancellation, "initdb").await
    {
        let error = error.with_diagnostic_file(&mut diagnostic_file, &[password]);
        if !matches!(
            error.code,
            "protocol_start_cancelled"
                | "parent_exited"
                | "postgres_command_failed"
                | "postgres_command_timeout"
        ) {
            // If process-tree exit was not proven, keep its private write target
            // so TempDir cleanup cannot race an initdb process still writing.
            let _ = staging.keep();
        }
        return Err(error);
    }
    drop(password_file);
    Ok(staging)
}

async fn wait_command(
    child: &mut OwnedPostgresProcess,
    limit: Duration,
    parent: &ParentMonitor,
    cancellation: &mut watch::Receiver<bool>,
    phase: &str,
) -> Result<ExitStatus, OwnerError> {
    let deadline = Instant::now() + limit;
    loop {
        if let Err(error) = check_startup_control(parent, cancellation) {
            if let Err(cleanup) = child.terminate_and_wait().await {
                return Err(cleanup_failure(error.code, cleanup));
            }
            child.disarm();
            return Err(error);
        }
        let status = match child.child_mut().try_wait() {
            Ok(status) => status,
            Err(error) => {
                let original = OwnerError::io(
                    "process_wait_failed",
                    "cannot inspect PostgreSQL setup process",
                    error,
                );
                if let Err(cleanup) = child.terminate_and_wait().await {
                    return Err(cleanup_failure(original.code, cleanup));
                }
                child.disarm();
                return Err(original);
            }
        };
        if let Some(status) = status {
            if let Err(original) = child.wait_tree_exit(STOP_TIMEOUT).await {
                if let Err(cleanup) = child.terminate_and_wait().await {
                    return Err(cleanup_failure(original.code, cleanup));
                }
                child.disarm();
                return Err(original);
            }
            child.disarm();
            if status.success() {
                return Ok(status);
            }
            return Err(OwnerError::new(
                "postgres_command_failed",
                format!("{phase} exited unsuccessfully"),
            ));
        }
        if Instant::now() >= deadline {
            child.terminate_and_wait().await?;
            child.disarm();
            return Err(OwnerError::new(
                "postgres_command_timeout",
                format!("{phase} exceeded its time limit"),
            ));
        }
        sleep(POLL_INTERVAL).await;
    }
}

pub(crate) fn spawn_postgres(
    postgres: &Path,
    data_dir: &Path,
    port: u16,
    bin_dir: &Path,
    log_path: &Path,
) -> Result<OwnedPostgresProcess, OwnerError> {
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|error| {
            OwnerError::io("postgres_log_failed", "cannot open PostgreSQL log", error)
        })?;
    let stdout = log.try_clone().map_err(|error| {
        OwnerError::io(
            "postgres_log_failed",
            "cannot duplicate PostgreSQL log handle",
            error,
        )
    })?;
    let mut command = Command::new(postgres_command_path(postgres).as_ref());
    command
        .arg("-D")
        .arg(postgres_command_path(data_dir).as_ref())
        .arg("-h")
        .arg("127.0.0.1")
        .arg("-p")
        .arg(port.to_string())
        .env("PATH", joined_path(bin_dir, std::env::var_os("PATH")))
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(log))
        .kill_on_drop(true);
    supervised_spawn(&mut command).map_err(|error| {
        OwnerError::new(
            "postgres_start_failed",
            format!("cannot start PostgreSQL child process ({})", error.code),
        )
    })
}

fn joined_path(bin_dir: &Path, current: Option<std::ffi::OsString>) -> std::ffi::OsString {
    let mut paths = vec![bin_dir.to_path_buf()];
    if let Some(current) = current {
        paths.extend(std::env::split_paths(&current));
    }
    std::env::join_paths(paths).unwrap_or_else(|_| bin_dir.as_os_str().to_os_string())
}

pub(crate) async fn wait_until_ready(
    child: &mut OwnedPostgresProcess,
    config: ConnectionConfig<'_>,
    parent: &ParentMonitor,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<VerifiedConnection, OwnerError> {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    let mut identity_mismatch = false;
    let diagnostic_path = postgres_log_path(config.data_dir);
    let mut secrets = Vec::with_capacity(config.fallbacks.len() + 1);
    secrets.push(config.password);
    secrets.extend(config.fallbacks.iter().map(String::as_str));
    loop {
        check_startup_control(parent, cancellation)?;
        if let Some(status) = child.child_mut().try_wait().map_err(|error| {
            OwnerError::io(
                "postgres_wait_failed",
                "cannot inspect PostgreSQL process",
                error,
            )
        })? {
            return Err(OwnerError::new(
                "postgres_start_failed",
                format!(
                    "PostgreSQL exited during startup (status {})",
                    status
                        .code()
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| "signal".to_owned())
                ),
            )
            .with_diagnostic_path(&diagnostic_path, &secrets));
        }
        match connect_verified(
            ConnectionConfig {
                port: config.port,
                data_dir: config.data_dir,
                user: config.user,
                password: config.password,
                fallbacks: config.fallbacks,
                normalize_fallback: config.normalize_fallback,
            },
            Some(parent),
            Some(cancellation),
        )
        .await
        {
            Ok(verified) => {
                check_startup_control(parent, cancellation)?;
                return Ok(verified);
            }
            Err(error) if error.code == "protocol_start_cancelled" => return Err(error),
            Err(error)
                if error.code == "server_identity_mismatch"
                    || error.code == "incompatible_server" =>
            {
                identity_mismatch = true
            }
            Err(_) => {}
        }
        if Instant::now() >= deadline {
            let _ = TcpStream::connect(("127.0.0.1", config.port));
            let error = if identity_mismatch {
                OwnerError::new(
                    "server_identity_mismatch",
                    "PostgreSQL port is occupied by a server using another data directory",
                )
            } else {
                OwnerError::new(
                    "postgres_ready_timeout",
                    "PostgreSQL did not become ready before the startup deadline",
                )
            };
            return Err(error.with_diagnostic_path(&diagnostic_path, &secrets));
        }
        tokio::select! {
            _ = sleep(POLL_INTERVAL) => {}
            changed = cancellation.changed() => {
                if changed.is_ok() && *cancellation.borrow() {
                    return Err(OwnerError::new(
                        "protocol_start_cancelled",
                        "owner input closed before PostgreSQL became ready",
                    ));
                }
            }
        }
    }
}

pub(crate) async fn stop_child(
    child: &mut OwnedPostgresProcess,
    pg_ctl: &Path,
    data_dir: &Path,
    port: u16,
) -> Result<(), OwnerError> {
    if child
        .child_mut()
        .try_wait()
        .map_err(|error| {
            OwnerError::io(
                "postgres_wait_failed",
                "cannot inspect owned PostgreSQL process",
                error,
            )
        })?
        .is_some()
    {
        child.wait_tree_exit(STOP_TIMEOUT).await?;
        return Ok(());
    }
    let identity = read_postmaster_pid(&data_dir.join("postmaster.pid"), data_dir)?;
    if identity.pid != child.process_id() || identity.port != port {
        return Err(OwnerError::new(
            "owned_process_identity_mismatch",
            "postmaster.pid no longer identifies the PostgreSQL process owned by this lease",
        ));
    }
    let fast = run_pg_ctl_stop(pg_ctl, data_dir, "fast").await;
    if fast.is_err() {
        let _ = run_pg_ctl_stop(pg_ctl, data_dir, "immediate").await;
    }
    match timeout(STOP_TIMEOUT, child.child_mut().wait()).await {
        Ok(Ok(_status)) => {}
        Ok(Err(error)) => {
            return Err(OwnerError::io(
                "postgres_stop_failed",
                "cannot wait for owned PostgreSQL process",
                error,
            ));
        }
        Err(_) => {
            // The child PID and port were checked against postmaster.pid above.
            // Its dedicated process group contains this PostgreSQL tree, so a
            // final forced cleanup cannot affect another application process.
            if child
                .child_mut()
                .try_wait()
                .map_err(|error| {
                    OwnerError::io(
                        "postgres_wait_failed",
                        "cannot inspect owned PostgreSQL process before forced cleanup",
                        error,
                    )
                })?
                .is_none()
            {
                child.signal_tree(true)?;
            }
            child.wait_tree_exit(STOP_TIMEOUT).await?;
        }
    }
    child.wait_tree_exit(STOP_TIMEOUT).await
}

pub(crate) async fn cleanup_failed_start(
    child: &mut OwnedPostgresProcess,
    pg_ctl: &Path,
    data_dir: &Path,
    port: u16,
    reason: &str,
) -> Result<(), OwnerError> {
    if matches!(reason, "protocol_start_cancelled" | "parent_exited") {
        return child.terminate_and_wait().await;
    }
    match stop_child(child, pg_ctl, data_dir, port).await {
        Ok(()) => Ok(()),
        Err(stop_error) => {
            child.signal_tree(true)?;
            child.wait_tree_exit(STOP_TIMEOUT).await.map_err(|_| {
                OwnerError::new(
                    "postgres_cleanup_unverified",
                    format!(
                        "owned PostgreSQL process tree did not exit ({})",
                        stop_error.code
                    ),
                )
            })
        }
    }
}

async fn run_pg_ctl_stop(pg_ctl: &Path, data_dir: &Path, mode: &str) -> Result<(), OwnerError> {
    let mut command = Command::new(postgres_command_path(pg_ctl).as_ref());
    command
        .arg("-D")
        .arg(postgres_command_path(data_dir).as_ref())
        .arg("-m")
        .arg(mode)
        .arg("-w")
        .arg("-t")
        .arg("10")
        .arg("stop")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = supervised_spawn(&mut command).map_err(|error| {
        OwnerError::new(
            "postgres_stop_failed",
            format!("cannot supervise pg_ctl shutdown ({})", error.code),
        )
    })?;
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(status) = child.child_mut().try_wait().map_err(|error| {
            OwnerError::io(
                "postgres_stop_failed",
                "cannot inspect pg_ctl shutdown process",
                error,
            )
        })? {
            child.wait_tree_exit(STOP_TIMEOUT).await?;
            return if status.success() {
                Ok(())
            } else {
                Err(OwnerError::new(
                    "postgres_stop_failed",
                    "pg_ctl could not stop the owned PostgreSQL cluster",
                ))
            };
        }
        if Instant::now() >= deadline {
            child.terminate_and_wait().await?;
            return Err(OwnerError::new(
                "postgres_stop_timeout",
                "pg_ctl shutdown timed out",
            ));
        }
        sleep(POLL_INTERVAL).await;
    }
}
