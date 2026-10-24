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
    runtime_type: Option<String>,
}

impl FixtureConfig {
    fn validate(&self) -> Result<(), Box<dyn std::error::Error>> {
        if !matches!(
            self.runtime_type.as_deref(),
            None | Some("codex_local") | Some("hermes_local")
        ) {
            return Err("unsupported synthetic runtime".into());
        }
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
        let mut relative_paths = vec![
            "instance",
            "workspaces",
            "previous-documents",
            "profiles",
            "operator-home",
            "isolated-home",
            "runtime-root",
            "agent-cwd",
            "bin/provider",
        ];
        if self.runtime_type.as_deref() == Some("hermes_local") {
            relative_paths.extend([
                "hermes-install/venv/bin/hermes",
                "hermes-install/venv/bin/python3",
                "hermes-install/hermes_bootstrap.py",
                "hermes-install/hermes_cli/__init__.py",
                "hermes-install/hermes_cli/main.py",
                "hermes-install/acp_adapter/entry.py",
                "hermes-install/acp_adapter/events.py",
                "hermes-install/acp_adapter/tools.py",
                "hermes-install/acp_adapter/session.py",
                "hermes-install/agent/agent_init.py",
                "hermes-install/agent/chat_completion_helpers.py",
            ]);
        }
        for relative in relative_paths {
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
            || body
                != if self.runtime_type.as_deref() == Some("hermes_local") {
                    &include_bytes!("../../../../tests/e2e/fixtures/fake-hermes.py")[..]
                } else {
                    &include_bytes!("../../native-chat-executor/tests/fixtures/fake_codex.py")[..]
                }
        {
            return Err("provider must match the compiled synthetic Codex fixture".into());
        }
        if self.runtime_type.as_deref() != Some("hermes_local") {
            return Ok(format!("{:x}", Sha256::digest(&source)));
        }

        // The Hermes hash covers the exact synthetic installation wrapper and
        // its pinned adapter source as well as the separately verified fake
        // ACP process. This remains fixture evidence, never selected-profile
        // acceptance for an installed Hermes runtime.
        const WRAPPER: &str = "#!/bin/sh\n'''exec' \"$(dirname -- \"$(realpath -- \"$0\")\")\"/'python3' \"$0\" \"$@\"\n' '''\n# -*- coding: utf-8 -*-\nimport sys\nfrom hermes_cli.main import main\nif __name__ == \"__main__\":\n    sys.exit(main())\n";
        let mut digest = Sha256::new();
        digest.update(b"rudder-native-chat-hermes-browser-fixture-v1\0");
        digest_fixture_bytes(&mut digest, "bin/provider", &source);
        let install = self.fixture_root.join("hermes-install");
        let expected_python_shim = format!(
            "#!/bin/sh\nPYTHONPATH={} exec {} \"$@\"\n",
            shell_quote(&install),
            shell_quote(&interpreter),
        );
        let provider_path = self.fixture_root.join("bin/provider");
        let provider_python_literal =
            serde_json::to_string(&provider_path.to_string_lossy().to_string())?;
        let expected_entry = format!(
            "import runpy\n\ndef main(argv=None):\n    runpy.run_path({provider_python_literal}, run_name=\"__main__\")\n"
        );
        let expected_files = [
            ("hermes-install/venv/bin/hermes", WRAPPER.to_owned()),
            (
                "hermes-install/venv/bin/python3",
                expected_python_shim,
            ),
            (
                "hermes-install/hermes_bootstrap.py",
                "def harden_import_path(source_root):\n    return None\n".to_owned(),
            ),
            (
                "hermes-install/hermes_cli/__init__.py",
                "__version__ = \"0.21.0\"\n".to_owned(),
            ),
            (
                "hermes-install/hermes_cli/main.py",
                "from acp_adapter.entry import main\n".to_owned(),
            ),
            ("hermes-install/acp_adapter/entry.py", expected_entry),
            (
                "hermes-install/acp_adapter/events.py",
                "def build_tool_complete(tool_call_id, tool_name, result=None, function_args=None, snapshot=None):\n    return None\n\ndef make_step_cb(*args, **kwargs):\n    return None\n".to_owned(),
            ),
            (
                "hermes-install/acp_adapter/tools.py",
                "import json\n\ndef coerce_tool_args(raw):\n    if isinstance(raw, str):\n        raw = json.loads(raw)\n    return raw if isinstance(raw, dict) else {}\n".to_owned(),
            ),
            (
                "hermes-install/acp_adapter/session.py",
                "class SessionManager:\n    def _make_agent(self, session_id, cwd, model, requested_provider, base_url, api_mode):\n        return type('Agent', (), {'ephemeral_system_prompt': None})()\n".to_owned(),
            ),
            (
                "hermes-install/agent/agent_init.py",
                "# synthetic Hermes 0.21 adapter fixture\n".to_owned(),
            ),
            (
                "hermes-install/agent/chat_completion_helpers.py",
                "# synthetic Hermes 0.21 adapter fixture\n".to_owned(),
            ),
        ];
        for (relative, expected) in expected_files {
            let bytes = read_fixture_file(&self.fixture_root, relative)?;
            // The restart regression has one explicit harmless formatter
            // revision. Accept only these exact fixture bytes, and hash the
            // selected version along with every imported adapter module.
            let known_formatter_update = relative == "hermes-install/acp_adapter/events.py"
                && bytes == format!("{expected}\n# updated transport formatter\n").as_bytes();
            if bytes != expected.as_bytes() && !known_formatter_update {
                return Err(
                    "synthetic Hermes installation does not match its pinned fixture".into(),
                );
            }
            digest_fixture_bytes(&mut digest, relative, &bytes);
        }
        Ok(format!("{:x}", digest.finalize()))
    }
}

fn shell_quote(path: &std::path::Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

fn read_fixture_file(
    root: &std::path::Path,
    relative: &str,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let path = root.join(relative);
    let metadata = std::fs::symlink_metadata(&path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("synthetic Hermes fixture files must be regular files".into());
    }
    let canonical = path.canonicalize()?;
    if !canonical.starts_with(root) {
        return Err("synthetic Hermes fixture path escapes its root".into());
    }
    let bytes = std::fs::read(&canonical)?;
    if bytes.len() as u64 != metadata.len() {
        return Err("synthetic Hermes fixture changed while hashing".into());
    }
    Ok(bytes)
}

fn digest_fixture_bytes(digest: &mut Sha256, relative: &str, bytes: &[u8]) {
    digest.update(relative.as_bytes());
    digest.update([0]);
    digest.update((bytes.len() as u64).to_be_bytes());
    digest.update(bytes);
    digest.update([0]);
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
    let host = if config.runtime_type.as_deref() == Some("hermes_local") {
        let hermes_executable = root.join("hermes-install/venv/bin/hermes");
        host.with_executable_search_path("/usr/bin:/bin".into())?
            .with_hermes_runtime(hermes_executable, root.join("operator-home/hermes-profile"))?
    } else {
        host
    };
    let paths = HostPaths {
        process_host: config.process_host.canonicalize()?,
        runtime_root: root.join("runtime-root").canonicalize()?,
        isolated_home: root.join("isolated-home").canonicalize()?,
    };
    let native = NativeChatPublicRuntime::new(host, paths, Duration::from_secs(60))?;
    let origin = format!("http://{}", config.listen_addr);
    // Use production identity admission for Agent configuration reads as well
    // as Chat controls. The caller supplies per-fixture loopback-only secrets.
    let ingress = PublicIngressConfig::from_env()?
        .ok_or("fixture public ingress identity configuration is required")?;
    if ingress.listen_addr != config.listen_addr
        || ingress.node_upstream().trim_end_matches('/')
            != config.node_upstream.trim_end_matches('/')
    {
        return Err("fixture public ingress does not match its isolated runtime".into());
    }
    let ingress = ingress
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
        "providerFixtureHashIncludesHermesWrapper": config.runtime_type.as_deref() == Some("hermes_local"),
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
