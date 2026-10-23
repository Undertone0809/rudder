//! Explicit operator entrypoint; never starts implicitly from preflight.
use std::io::{self, Read};
use std::{future::Future, path::PathBuf, pin::Pin};
use tokio_util::sync::CancellationToken;

const SCHEMA: &str = "rudder.migration-apply/v1";
const MAX_INPUT: u64 = 256 * 1024;
const CANCEL_FILE_ENV: &str = "RUDDER_MIGRATION_APPLY_CANCEL_FILE";

#[tokio::main]
async fn main() {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("migration-apply {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let result = run_cancellable().await;
    let failed = result.is_err();
    let output = match result {
        Ok(response) => response,
        // Do not emit SQL, connection strings, subprocess stderr or secrets.
        Err(code) => {
            serde_json::json!({"schema": SCHEMA, "protocolVersion": 1, "status": "error", "error": {"code": code}})
        }
    };
    println!("{output}");
    if failed {
        std::process::exit(2);
    }
}

async fn run_cancellable() -> Result<serde_json::Value, &'static str> {
    let cancellation = CancellationToken::new();
    let operation = run(cancellation.clone());
    tokio::pin!(operation);
    let mut cancellation_monitor: Pin<Box<dyn Future<Output = Result<(), &'static str>> + Send>> =
        match std::env::var_os(CANCEL_FILE_ENV) {
            Some(path) => Box::pin(wait_for_cancel_file(PathBuf::from(path))),
            None => Box::pin(std::future::pending()),
        };
    #[cfg(unix)]
    {
        use rudder_migration_service::ParentProcessMonitor;
        use tokio::signal::unix::{SignalKind, signal};

        // Install both handlers before starting the operation. Keep `run()`
        // pinned so cancellation can explicitly stop its owned PostgreSQL
        // backend and wait for transaction and lock cleanup before exiting.
        let supervisor =
            ParentProcessMonitor::from_env().map_err(|_| "supervisor_monitor_unavailable")?;
        let mut terminate =
            signal(SignalKind::terminate()).map_err(|_| "signal_handler_unavailable")?;
        let mut interrupt =
            signal(SignalKind::interrupt()).map_err(|_| "signal_handler_unavailable")?;
        if let Some(supervisor) = supervisor {
            tokio::select! {
                biased;
                _ = terminate.recv() => cancel_and_drain(&cancellation, operation.as_mut(), "operation_aborted").await,
                _ = interrupt.recv() => cancel_and_drain(&cancellation, operation.as_mut(), "operation_aborted").await,
                result = cancellation_monitor.as_mut() => {
                    let code = result.err().unwrap_or("operation_aborted");
                    cancel_and_drain(&cancellation, operation.as_mut(), code).await
                }
                result = supervisor.wait_for_exit() => {
                    let code = if result.is_ok() { "supervisor_exited" } else { "supervisor_monitor_failed" };
                    cancel_and_drain(&cancellation, operation.as_mut(), code).await
                }
                result = operation.as_mut() => {
                    if supervisor.has_exited() {
                        Err("supervisor_exited")
                    } else {
                        result
                    }
                }
            }
        } else {
            tokio::select! {
                biased;
                result = operation.as_mut() => result,
                _ = terminate.recv() => cancel_and_drain(&cancellation, operation.as_mut(), "operation_aborted").await,
                _ = interrupt.recv() => cancel_and_drain(&cancellation, operation.as_mut(), "operation_aborted").await,
                result = cancellation_monitor.as_mut() => {
                    let code = result.err().unwrap_or("operation_aborted");
                    cancel_and_drain(&cancellation, operation.as_mut(), code).await
                }
            }
        }
    }
    #[cfg(windows)]
    {
        use rudder_migration_service::ParentProcessMonitor;

        let supervisor =
            ParentProcessMonitor::from_env().map_err(|_| "supervisor_monitor_unavailable")?;
        let interrupt = tokio::signal::ctrl_c();
        if let Some(supervisor) = supervisor {
            tokio::select! {
                biased;
                signal = interrupt => {
                    let code = if signal.is_ok() { "operation_aborted" } else { "signal_handler_unavailable" };
                    cancel_and_drain(&cancellation, operation.as_mut(), code).await
                }
                result = cancellation_monitor.as_mut() => {
                    let code = result.err().unwrap_or("operation_aborted");
                    cancel_and_drain(&cancellation, operation.as_mut(), code).await
                }
                result = supervisor.wait_for_exit() => {
                    let code = if result.is_ok() { "supervisor_exited" } else { "supervisor_monitor_failed" };
                    cancel_and_drain(&cancellation, operation.as_mut(), code).await
                }
                result = operation.as_mut() => {
                    match supervisor.has_exited() {
                        Ok(true) => Err("supervisor_exited"),
                        Ok(false) => result,
                        Err(_) => Err("supervisor_monitor_failed"),
                    }
                }
            }
        } else {
            tokio::select! {
                biased;
                signal = interrupt => {
                    let code = if signal.is_ok() { "operation_aborted" } else { "signal_handler_unavailable" };
                    cancel_and_drain(&cancellation, operation.as_mut(), code).await
                }
                result = cancellation_monitor.as_mut() => {
                    let code = result.err().unwrap_or("operation_aborted");
                    cancel_and_drain(&cancellation, operation.as_mut(), code).await
                }
                result = operation.as_mut() => result,
            }
        }
    }
    #[cfg(all(not(unix), not(windows)))]
    {
        let interrupt = tokio::signal::ctrl_c();
        tokio::select! {
            biased;
            result = interrupt => {
                let code = if result.is_ok() { "operation_aborted" } else { "signal_handler_unavailable" };
                cancel_and_drain(&cancellation, operation.as_mut(), code).await
            },
            result = cancellation_monitor.as_mut() => {
                let code = result.err().unwrap_or("operation_aborted");
                cancel_and_drain(&cancellation, operation.as_mut(), code).await
            },
            result = operation.as_mut() => result,
        }
    }
}

async fn cancel_and_drain<F>(
    cancellation: &CancellationToken,
    operation: Pin<&mut F>,
    code: &'static str,
) -> Result<serde_json::Value, &'static str>
where
    F: Future<Output = Result<serde_json::Value, &'static str>>,
{
    cancellation.cancel();
    match operation.await {
        Ok(_) => Err(code),
        // The operation reports the generic cancellation it observed, but the
        // caller knows which event initiated the drain (for example, the
        // managed supervisor exiting). Preserve that more useful cause while
        // still returning stronger cleanup failures unchanged.
        Err("operation_aborted") => Err(code),
        Err(operation_error) => Err(operation_error),
    }
}

async fn wait_for_cancel_file(path: PathBuf) -> Result<(), &'static str> {
    loop {
        match tokio::fs::try_exists(&path).await {
            Ok(true) => return Ok(()),
            Ok(false) => tokio::time::sleep(std::time::Duration::from_millis(25)).await,
            Err(_) => return Err("cancel_monitor_failed"),
        }
    }
}

async fn run(cancellation: CancellationToken) -> Result<serde_json::Value, &'static str> {
    // `Read::read_to_end` blocks the async executor while stdin is open. Read
    // on Tokio's blocking pool so the managed-parent monitor remains live even
    // before the request arrives (or if a caller leaves stdin open).
    let input_read = tokio::task::spawn_blocking(|| {
        let mut input = Vec::new();
        io::stdin()
            .lock()
            .take(MAX_INPUT + 1)
            .read_to_end(&mut input)
            .map_err(|_| "stdin_read_failed")?;
        if input.len() as u64 > MAX_INPUT {
            return Err("input_too_large");
        }
        Ok(input)
    })
    .await;
    // Parent death can close stdin while the supervisor monitor cancels us.
    // Do not replace that observed cancellation with an empty/failed request;
    // no database work or cleanup has started at this point.
    if cancellation.is_cancelled() {
        return Err("operation_aborted");
    }
    let input = input_read.map_err(|_| "stdin_read_failed")??;
    // Validate the request and inspect its pinned source before consulting
    // database credentials so malformed or unsafe input has deterministic
    // precedence over a missing runtime configuration.
    let mode = rudder_migration_service::validate_operator_mode(&input)?;
    let database_url =
        std::env::var("RUDDER_MIGRATION_APPLY_DATABASE_URL").map_err(|_| "database_url_missing")?;
    if mode == rudder_migration_service::OperatorInputMode::StartupGate {
        let outcome = rudder_migration_service::startup_operator_cancellable(
            &input,
            &database_url,
            cancellation,
        )
        .await?;
        return Ok(serde_json::json!({
            "schema": SCHEMA,
            "protocolVersion": 1,
            "status": "startup",
            "outcome": outcome,
        }));
    }
    let validate_only = mode == rudder_migration_service::OperatorInputMode::ValidateOnly;
    let report = if validate_only {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err("operation_aborted"),
            result = rudder_migration_service::validate_operator(&input, &database_url) => result?,
        }
    } else {
        rudder_migration_service::apply_operator_cancellable(&input, &database_url, cancellation)
            .await?
    };
    Ok(serde_json::json!({
        "schema": SCHEMA,
        "protocolVersion": 1,
        "status": if validate_only { "validated" } else { "applied" },
        "report": report,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn cancellation_file_watcher_observes_the_owned_marker() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("cancel");
        let watcher = wait_for_cancel_file(marker.clone());
        tokio::pin!(watcher);

        assert!(
            tokio::time::timeout(Duration::from_millis(50), watcher.as_mut())
                .await
                .is_err()
        );
        tokio::fs::write(&marker, "cancel\n").await.unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), watcher.as_mut())
                .await
                .unwrap(),
            Ok(())
        );
    }

    #[tokio::test]
    async fn cancel_drain_preserves_unconfirmed_database_cleanup() {
        let cancellation = CancellationToken::new();
        let operation =
            async { Err::<serde_json::Value, &'static str>("cancellation_cleanup_unconfirmed") };
        tokio::pin!(operation);

        assert!(matches!(
            cancel_and_drain(&cancellation, operation.as_mut(), "operation_aborted").await,
            Err("cancellation_cleanup_unconfirmed")
        ));
        assert!(cancellation.is_cancelled());
    }

    #[tokio::test]
    async fn cancel_drain_preserves_the_supervisor_exit_cause() {
        let cancellation = CancellationToken::new();
        let operation = async { Err::<serde_json::Value, &'static str>("operation_aborted") };
        tokio::pin!(operation);

        assert_eq!(
            cancel_and_drain(&cancellation, operation.as_mut(), "supervisor_exited").await,
            Err("supervisor_exited")
        );
        assert!(cancellation.is_cancelled());
    }
}
