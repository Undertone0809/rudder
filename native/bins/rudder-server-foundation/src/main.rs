use rudder_server_foundation_core::{ServerConfig, ServerRuntime, init_tracing};
use std::io::{self, Write};

#[tokio::main]
async fn main() {
    init_tracing();
    if let Err(error) = run().await {
        eprintln!("rudder-server-foundation failed: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let config = ServerConfig::from_env()?;
    let shutdown_signals = install_shutdown_signals()?;
    let runtime = ServerRuntime::bind(config.clone())?;
    println!("{}", serde_json::to_string(&runtime.startup_receipt())?);
    std::io::stdout().flush()?;

    let control = runtime.control();
    let mut server_task = tokio::spawn(async move { runtime.run().await });
    tokio::select! {
        result = &mut server_task => {
            result??;
        }
        reason = shutdown_signal(shutdown_signals) => {
            control.shutdown().await;
            server_task.await??;
            println!("{}", serde_json::to_string(&ServerRuntime::shutdown_receipt(reason))?);
            std::io::stdout().flush()?;
        }
    }
    Ok(())
}

#[cfg(unix)]
struct ShutdownSignals {
    terminate: tokio::signal::unix::Signal,
    interrupt: tokio::signal::unix::Signal,
}

#[cfg(not(unix))]
struct ShutdownSignals;

#[cfg(unix)]
fn install_shutdown_signals() -> io::Result<ShutdownSignals> {
    use tokio::signal::unix::{SignalKind, signal};
    Ok(ShutdownSignals {
        terminate: signal(SignalKind::terminate())?,
        interrupt: signal(SignalKind::interrupt())?,
    })
}

#[cfg(not(unix))]
fn install_shutdown_signals() -> io::Result<ShutdownSignals> {
    Ok(ShutdownSignals)
}

#[cfg(unix)]
async fn shutdown_signal(mut signals: ShutdownSignals) -> &'static str {
    tokio::select! {
        _ = signals.interrupt.recv() => "ctrl_c",
        _ = signals.terminate.recv() => "sigterm",
    }
}

#[cfg(not(unix))]
async fn shutdown_signal(_signals: ShutdownSignals) -> &'static str {
    let _ = tokio::signal::ctrl_c().await;
    "ctrl_c"
}
