//! Test-only launcher for browser workflows against the real Rust authority.
//! It accepts only a disposable local fixture, never an operator profile. This
//! example is not the installed server entry point or an activation flag.
use rudder_auth_core::SigningKey;
use rudder_d1_persistence::native_chat::config::LocalHostContext;
use rudder_native_chat_executor::HostPaths;
use rudder_server_foundation_core::{
    NativeChatPublicRuntime, PublicIngressConfig, ServerConfig, ServerRuntime,
    browser_auth::{BrowserAuthConfig, BrowserMutationPolicy},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{io::Write, net::SocketAddr, path::PathBuf, time::Duration};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FixtureConfig {
    fixture_root: PathBuf,
    database_url: String,
    node_upstream: String,
    listen_addr: SocketAddr,
    process_host: PathBuf,
}

impl FixtureConfig {
    fn validate(&self) -> Result<(), Box<dyn std::error::Error>> {
        let root = self.fixture_root.canonicalize()?;
        let temporary = std::env::temp_dir().canonicalize()?;
        if root != self.fixture_root
            || !root.starts_with(&temporary)
            || !root
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("rudder-native-chat-e2e-"))
            || !self.listen_addr.ip().is_loopback()
            || self.listen_addr.port() == 0
        {
            return Err(
                "a canonical disposable fixture and fixed loopback listener are required".into(),
            );
        }
        let database = url::Url::parse(&self.database_url)?;
        if !matches!(database.scheme(), "postgres" | "postgresql")
            || !database
                .host_str()
                .and_then(|host| host.parse::<std::net::IpAddr>().ok())
                .is_some_and(|host| host.is_loopback())
            || database.port().is_none_or(|port| port == 0)
        {
            return Err("an explicit loopback disposable PostgreSQL port is required".into());
        }
        // No path can escape to a real user's profile through a fixture symlink.
        for relative in [
            "instance",
            "workspaces",
            "previous-documents",
            "profiles",
            "operator-home",
            "isolated-home",
            "runtime-root",
            "agent-cwd",
            "bin/provider",
        ] {
            let path = root.join(relative);
            if !path.canonicalize()?.starts_with(&root) {
                return Err("fixture path escapes its disposable root".into());
            }
        }
        Ok(())
    }

    fn provider_fixture_sha256(&self) -> Result<String, Box<dyn std::error::Error>> {
        let source = std::fs::read(self.fixture_root.join("bin/provider"))?;
        let newline = source
            .iter()
            .position(|byte| *byte == b'\n')
            .ok_or("synthetic provider requires one absolute interpreter shebang")?;
        let (interpreter, body) = (&source[..newline], &source[newline + 1..]);
        let interpreter = std::str::from_utf8(interpreter)?
            .strip_prefix("#!")
            .ok_or("synthetic provider requires one absolute interpreter shebang")?;
        let interpreter = PathBuf::from(interpreter);
        if !interpreter.is_absolute()
            || !interpreter.canonicalize()?.is_file()
            || body != include_bytes!("../../native-chat-executor/tests/fixtures/fake_codex.py")
        {
            return Err("provider must match the compiled synthetic Codex fixture".into());
        }
        Ok(format!("{:x}", Sha256::digest(&source)))
    }
}

#[actix_web::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let config_path = args.next().ok_or("pass one disposable fixture JSON path")?;
    if args.next().is_some() {
        return Err("pass exactly one disposable fixture JSON path".into());
    }
    let config: FixtureConfig = serde_json::from_slice(&std::fs::read(config_path)?)?;
    config.validate()?;
    let provider_fixture_sha256 = config.provider_fixture_sha256()?;
    let root = &config.fixture_root;
    // An accidental connection to another local database must fail before any
    // Foundation worker can write. The test support creates this marker only
    // in its newly allocated disposable database.
    let verification = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(&config.database_url)
        .await?;
    let markers = sqlx::query_scalar::<_, String>(
        "SELECT fixture_root FROM rudder_native_chat_browser_fixture",
    )
    .fetch_all(&verification)
    .await?;
    verification.close().await;
    if markers.len() != 1 || Some(markers[0].as_str()) != root.to_str() {
        return Err("database does not belong to this disposable browser fixture".into());
    }
    let host = LocalHostContext::from_rust_host(
        "native-chat-browser-fixture".into(),
        root.join("instance"),
        root.join("workspaces"),
        root.join("previous-documents"),
        false,
        root.join("profiles"),
        root.join("operator-home"),
        root.join("bin/provider"),
    )?;
    let paths = HostPaths {
        process_host: config.process_host.canonicalize()?,
        runtime_root: root.join("runtime-root").canonicalize()?,
        isolated_home: root.join("isolated-home").canonicalize()?,
    };
    let native = NativeChatPublicRuntime::new(host, paths, Duration::from_secs(60))?;
    let origin = format!("http://{}", config.listen_addr);
    let ingress = PublicIngressConfig::new(
        config.listen_addr,
        &config.node_upstream,
        "native-chat-browser-fixture-ingress-key",
    )?
    .with_browser_auth(BrowserAuthConfig::local_implicit(
        config.listen_addr,
        "local_trusted",
        "private",
        "optional",
    )?)?
    .with_native_chat_mutation_policy(BrowserMutationPolicy::new(&[origin])?)
    .with_native_chat_runtime(native);
    let runtime = ServerRuntime::bind(ServerConfig {
        database_url: Some(config.database_url),
        actor_envelope_key: Some(SigningKey::new(
            b"native-chat-browser-fixture-envelope-key",
        )?),
        workers: 1,
        ..ServerConfig::default()
    })?;
    let public = runtime.bind_public_ingress(ingress)?;
    let receipt = serde_json::json!({
        "fixture": "native-chat-browser/v1",
        "publicUrl": format!("http://{}", public.bound_addr()),
        "privateAddr": runtime.startup_receipt().bound_addr,
        "fixtureRoot": root,
        "syntheticProvider": true,
        "providerFixtureSha256": provider_fixture_sha256,
        "providerInterpreterEvidence": "caller-supplied absolute executable; behavior not attested",
        "selectedProfileAcceptance": false,
    });
    println!("{}", serde_json::to_string(&receipt)?);
    std::io::stdout().flush()?;
    let control = runtime.control();
    let public_control = public.control();
    let mut private_task = actix_web::rt::spawn(runtime.run());
    let mut public_task = actix_web::rt::spawn(public.run());
    tokio::select! {
        result = &mut private_task => {
            public_control.stop(true).await;
            public_task.await??;
            result??;
        }
        result = &mut public_task => {
            control.shutdown().await;
            private_task.await??;
            result??;
        }
        _ = shutdown() => {
            control.begin_shutdown();
            public_control.stop(true).await;
            control.shutdown().await;
            private_task.await??;
            public_task.await??;
        }
    }
    Ok(())
}

async fn shutdown() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut terminate = signal(SignalKind::terminate()).expect("fixture SIGTERM handler");
        tokio::select! {
            _ = terminate.recv() => {},
            _ = tokio::signal::ctrl_c() => {},
            _ = tokio::time::sleep(Duration::from_secs(300)) => {},
        }
    }
    #[cfg(not(unix))]
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        _ = tokio::time::sleep(Duration::from_secs(300)) => {},
    }
}
