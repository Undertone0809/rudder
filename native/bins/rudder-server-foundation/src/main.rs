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
    let browser_session_authentication = ingress_config
        .as_ref()
        .is_some_and(PublicIngressConfig::browser_session_authentication_enabled);
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
            "nativeAuthentication": {
                "authority": "native-pcp-bearer-resolver",
                "recognizedBearerPrefix": "pcp_",
                "supportedCredentialStores": ["board_api_keys", "agent_api_keys"],
                "directRoutes": ["organization_member_directory"],
                "recognizedInvalidCredentialsFailClosed": true,
            },
            "compatibilityAuthentication": {
                "authority": "private-node-adapter",
                "credentialForms": [
                    "Better Auth cookie sessions",
                    "local Agent JWTs",
                    "local-trusted and local-implicit identities",
                    "non-pcp_ bearer credentials",
                ],
            },
            "browserSessionAuthentication": {
                "enabled": browser_session_authentication,
                "route": "GET /api/auth/get-session",
                "authority": if browser_session_authentication { "native-browser-session-resolver" } else { "private-node-adapter" },
                "nativeFailureFallback": false,
                "scope": "session-read-only; other compatibility routes retain their existing authentication",
            },
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
            control.begin_shutdown();
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
            control.begin_shutdown();
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
