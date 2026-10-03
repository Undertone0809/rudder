use rudder_server_foundation_core::{
    PublicIngressConfig, ServerConfig, ServerRuntime, init_tracing,
};
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
    let ingress_config = PublicIngressConfig::from_env()?;
    let shutdown_signals = install_shutdown_signals()?;
    let runtime = ServerRuntime::bind(config.clone())?;
    let public = ingress_config
        .map(|config| runtime.bind_public_ingress(config))
        .transpose()?;
    let mut startup = serde_json::to_value(runtime.startup_receipt())?;
    if let Some(public) = public.as_ref() {
        startup["publicIngress"] = serde_json::json!({
            "boundAddr": public.bound_addr(), "publicListener": true,
            "directAuthorities": ["organization_member_directory"],
            "authenticationAuthority": "private-node-adapter",
            "unmigratedHttpAuthority": "explicit-private-node-proxy",
        });
    }
    println!("{}", serde_json::to_string(&startup)?);
    std::io::stdout().flush()?;

    let control = runtime.control();
    let public_control = public.as_ref().map(|runtime| runtime.control());
    let mut public_task = public.map(|runtime| tokio::spawn(async move { runtime.run().await }));
    let mut server_task = tokio::spawn(async move { runtime.run().await });
    tokio::select! {
        result = &mut server_task => {
            if let Some(public_control) = &public_control { public_control.stop(true).await; }
            if let Some(public_task) = &mut public_task { public_task.await??; }
            result??;
        }
        result = async {
            match &mut public_task {
                Some(task) => task.await,
                None => std::future::pending().await,
            }
        } => {
            control.shutdown().await;
            server_task.await??;
            result??;
        }
        reason = shutdown_signal(shutdown_signals) => {
            if let Some(public_control) = &public_control { public_control.stop(true).await; }
            control.shutdown().await;
            server_task.await??;
            if let Some(public_task) = &mut public_task { public_task.await??; }
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
