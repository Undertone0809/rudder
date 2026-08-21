use rudder_server_foundation_core::{ServerConfig, ServerRuntime, init_tracing};
use std::io::Write;

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
    let runtime = ServerRuntime::bind(config.clone())?;
    println!("{}", serde_json::to_string(&runtime.startup_receipt())?);
    std::io::stdout().flush()?;

    let control = runtime.control();
    let mut server_task = tokio::spawn(async move { runtime.run().await });
    tokio::select! {
        result = &mut server_task => {
            result??;
        }
        reason = shutdown_signal() => {
            control.shutdown().await;
            server_task.await??;
            println!("{}", serde_json::to_string(&ServerRuntime::shutdown_receipt(reason))?);
            std::io::stdout().flush()?;
        }
    }
    Ok(())
}

async fn shutdown_signal() -> &'static str {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut terminate = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => "ctrl_c",
            _ = terminate.recv() => "sigterm",
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
        "ctrl_c"
    }
}
