use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const PROTOCOL_MAJOR: u16 = 1;
pub const PROTOCOL_MINOR: u16 = 0;
pub const PROTOCOL_VERSION: &str = "1.0";
pub const V2_PROTOCOL_MAJOR: u16 = 2;
pub const V2_PROTOCOL_MINOR: u16 = 0;
pub const V2_PROTOCOL_VERSION: &str = "2.0";
pub const AUTHORITY_ENVELOPE_VERSION: u16 = 1;
pub const AUTHORITY_ENVELOPE_SCHEMA: &str = "rudder.native.process-authority.v2";
const MAX_AUTHORITY_TEXT_BYTES: usize = 256;
const MAX_AUTHORITY_LEASE_MILLIS: u64 = 24 * 60 * 60 * 1_000;
const MAX_AUTHORITY_ATTEMPT: u32 = 1_000_000;
pub const BINDING_DIGEST_BYTES: usize = 64;
#[cfg(unix)]
pub const CAPABILITIES: &[&str] = &[
    "process_spawn",
    "process_group_cleanup",
    "parent_eof_cleanup",
    "listener_owner_attestation",
    "owner_receipt",
    "output_order_index",
    "pty",
    "pty_input",
    "pty_resize",
    "stdout_relay",
    "stderr_relay",
    "authority_v2",
];
#[cfg(windows)]
pub const CAPABILITIES: &[&str] = &[
    "process_spawn",
    "process_group_cleanup",
    "parent_eof_cleanup",
    "listener_owner_attestation",
    "owner_receipt",
    "output_order_index",
    "pty",
    "pty_input",
    "pty_resize",
    "stdout_relay",
    "stderr_relay",
    "authority_v2",
];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolVersion {
    pub major: u16,
    pub minor: u16,
}

impl Default for ProtocolVersion {
    fn default() -> Self {
        Self {
            major: PROTOCOL_MAJOR,
            minor: PROTOCOL_MINOR,
        }
    }
}

/// Server/runtime-owned identity carried by the versioned process authority.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProcessRuntimeIdentity {
    pub organization_id: String,
    pub agent_id: String,
    pub run_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProcessOwnership {
    pub epoch: u64,
    pub fence: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProcessLease {
    pub owner: String,
    pub issued_at_millis: u64,
    pub expires_at_millis: u64,
}

/// The host-owned receipt location bound to the authority envelope.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReceiptContext {
    pub runtime_root: String,
    pub owner_token: String,
}

/// Bounded authority for a v2 process-host lifecycle.
///
/// The digest is an integrity/binding receipt, not an authentication primitive.
/// Issuance and authentication remain server/runtime-owned.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AuthorityEnvelope {
    pub authority_version: u16,
    pub runtime_identity: ProcessRuntimeIdentity,
    pub ownership: ProcessOwnership,
    pub lease: ProcessLease,
    pub attempt: u32,
    pub request_id: String,
    pub binding_digest: String,
    pub receipt_context: ReceiptContext,
}

impl AuthorityEnvelope {
    pub fn new(
        runtime_identity: ProcessRuntimeIdentity,
        ownership: ProcessOwnership,
        lease: ProcessLease,
        attempt: u32,
        request_id: impl Into<String>,
        receipt_context: ReceiptContext,
    ) -> Result<Self, &'static str> {
        let mut envelope = Self {
            authority_version: AUTHORITY_ENVELOPE_VERSION,
            runtime_identity,
            ownership,
            lease,
            attempt,
            request_id: request_id.into(),
            binding_digest: "0".repeat(BINDING_DIGEST_BYTES),
            receipt_context,
        };
        envelope.validate_shape()?;
        envelope.binding_digest = envelope.expected_binding_digest();
        Ok(envelope)
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        self.validate_shape()?;
        if self.binding_digest != self.expected_binding_digest() {
            return Err("binding_digest_mismatch");
        }
        Ok(())
    }

    pub fn validate_at(&self, now_millis: u64) -> Result<(), &'static str> {
        self.validate()?;
        if now_millis < self.lease.issued_at_millis || now_millis >= self.lease.expires_at_millis {
            return Err("lease_expired");
        }
        Ok(())
    }

    pub fn expected_binding_digest(&self) -> String {
        let mut material = String::new();
        for value in [
            AUTHORITY_ENVELOPE_SCHEMA,
            &self.authority_version.to_string(),
            &self.runtime_identity.organization_id,
            &self.runtime_identity.agent_id,
            &self.runtime_identity.run_id,
            &self.ownership.epoch.to_string(),
            &self.ownership.fence,
            &self.lease.owner,
            &self.lease.issued_at_millis.to_string(),
            &self.lease.expires_at_millis.to_string(),
            &self.attempt.to_string(),
            &self.request_id,
            &self.receipt_context.runtime_root,
            &self.receipt_context.owner_token,
        ] {
            material.push_str(&value.len().to_string());
            material.push(':');
            material.push_str(value);
            material.push('|');
        }
        format!("{:x}", Sha256::digest(material.as_bytes()))
    }

    fn validate_shape(&self) -> Result<(), &'static str> {
        if self.authority_version != AUTHORITY_ENVELOPE_VERSION {
            return Err("authority_version_mismatch");
        }
        for value in [
            &self.runtime_identity.organization_id,
            &self.runtime_identity.agent_id,
            &self.runtime_identity.run_id,
            &self.ownership.fence,
            &self.lease.owner,
        ] {
            if value.trim().is_empty() || value.len() > MAX_AUTHORITY_TEXT_BYTES {
                return Err("invalid_authority_identity");
            }
        }
        if self.ownership.epoch == 0 || self.ownership.fence.contains('\0') {
            return Err("invalid_authority_ownership");
        }
        if self.lease.expires_at_millis <= self.lease.issued_at_millis
            || self
                .lease
                .expires_at_millis
                .saturating_sub(self.lease.issued_at_millis)
                > MAX_AUTHORITY_LEASE_MILLIS
        {
            return Err("invalid_authority_lease");
        }
        if self.attempt == 0 || self.attempt > MAX_AUTHORITY_ATTEMPT {
            return Err("invalid_authority_attempt");
        }
        if self.request_id.trim().is_empty() || self.request_id.len() > MAX_AUTHORITY_TEXT_BYTES {
            return Err("invalid_authority_request");
        }
        if self.binding_digest.len() != BINDING_DIGEST_BYTES
            || !self
                .binding_digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("invalid_authority_digest");
        }
        if self.receipt_context.runtime_root.trim().is_empty()
            || self.receipt_context.runtime_root.len() > 4_096
            || !std::path::Path::new(&self.receipt_context.runtime_root).is_absolute()
            || self.receipt_context.owner_token.trim().is_empty()
            || self.receipt_context.owner_token.len() > MAX_AUTHORITY_TEXT_BYTES
            || self.receipt_context.owner_token == "."
            || self.receipt_context.owner_token == ".."
            || self.receipt_context.owner_token.contains('/')
            || self.receipt_context.owner_token.contains('\\')
            || self.receipt_context.owner_token.contains('\0')
        {
            return Err("invalid_authority_receipt_context");
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Command {
    Start {
        #[serde(rename = "protocolVersion", default)]
        protocol_version: Option<ProtocolVersion>,
        #[serde(rename = "requestId", default)]
        request_id: Option<String>,
        #[serde(default)]
        authority: Option<AuthorityEnvelope>,
        executable: String,
        #[serde(default)]
        argv: Vec<String>,
        cwd: String,
        #[serde(default)]
        env: std::collections::BTreeMap<String, String>,
        #[serde(default)]
        #[serde(rename = "ownerToken")]
        owner_token: Option<String>,
        #[serde(default)]
        port: Option<u16>,
        #[serde(rename = "runtimeRoot", default)]
        runtime_root: Option<String>,
    },
    StartProcess {
        #[serde(rename = "protocolVersion", default)]
        protocol_version: Option<ProtocolVersion>,
        #[serde(rename = "requestId", default)]
        request_id: Option<String>,
        #[serde(default)]
        authority: Option<AuthorityEnvelope>,
        executable: String,
        #[serde(default)]
        argv: Vec<String>,
        cwd: String,
        #[serde(default)]
        env: std::collections::BTreeMap<String, String>,
        #[serde(default)]
        #[serde(rename = "ownerToken")]
        owner_token: Option<String>,
        #[serde(rename = "runtimeRoot", default)]
        runtime_root: Option<String>,
        #[serde(default)]
        stdin: Option<String>,
        #[serde(rename = "graceMs", default)]
        grace_ms: Option<u64>,
    },
    Stop {
        #[serde(rename = "protocolVersion", default)]
        protocol_version: Option<ProtocolVersion>,
        #[serde(rename = "requestId", default)]
        request_id: Option<String>,
        #[serde(default)]
        authority: Option<AuthorityEnvelope>,
        #[serde(rename = "graceMs", default)]
        grace_ms: Option<u64>,
    },
    StartTerminal {
        #[serde(rename = "protocolVersion", default)]
        protocol_version: Option<ProtocolVersion>,
        #[serde(rename = "requestId", default)]
        request_id: Option<String>,
        #[serde(default)]
        authority: Option<AuthorityEnvelope>,
        executable: String,
        #[serde(default)]
        argv: Vec<String>,
        cwd: String,
        #[serde(default)]
        env: std::collections::BTreeMap<String, String>,
        #[serde(default)]
        #[serde(rename = "ownerToken")]
        owner_token: Option<String>,
        cols: u16,
        rows: u16,
    },
    Input {
        #[serde(rename = "protocolVersion", default)]
        protocol_version: Option<ProtocolVersion>,
        #[serde(rename = "requestId", default)]
        request_id: Option<String>,
        #[serde(default)]
        authority: Option<AuthorityEnvelope>,
        data: String,
    },
    Resize {
        #[serde(rename = "protocolVersion", default)]
        protocol_version: Option<ProtocolVersion>,
        #[serde(rename = "requestId", default)]
        request_id: Option<String>,
        #[serde(default)]
        authority: Option<AuthorityEnvelope>,
        cols: u16,
        rows: u16,
    },
}

impl Command {
    pub fn validate(&self) -> Result<(), &'static str> {
        self.validate_at_internal(None)
    }

    pub fn validate_at(&self, now_millis: u64) -> Result<(), &'static str> {
        self.validate_at_internal(Some(now_millis))
    }

    pub fn authority(&self) -> Option<&AuthorityEnvelope> {
        match self {
            Self::Start { authority, .. }
            | Self::StartProcess { authority, .. }
            | Self::Stop { authority, .. }
            | Self::StartTerminal { authority, .. }
            | Self::Input { authority, .. }
            | Self::Resize { authority, .. } => authority.as_ref(),
        }
    }

    pub fn is_v2(&self) -> bool {
        match self {
            Self::Start {
                protocol_version, ..
            }
            | Self::StartProcess {
                protocol_version, ..
            }
            | Self::Stop {
                protocol_version, ..
            }
            | Self::StartTerminal {
                protocol_version, ..
            }
            | Self::Input {
                protocol_version, ..
            }
            | Self::Resize {
                protocol_version, ..
            } => protocol_version
                .as_ref()
                .is_some_and(|version| version.major == V2_PROTOCOL_MAJOR),
        }
    }

    fn validate_at_internal(&self, now_millis: Option<u64>) -> Result<(), &'static str> {
        match self {
            Self::Start {
                protocol_version,
                request_id,
                authority,
                executable,
                argv,
                cwd,
                env,
                owner_token,
                port,
                runtime_root,
            } => {
                validate_protocol_identity(protocol_version, request_id, authority, now_millis)?;
                validate_launch(executable, argv, cwd, env, owner_token)?;
                if port.is_none() {
                    return Err("port_required");
                }
                let Some(runtime_root) = runtime_root.as_ref() else {
                    return Err("runtime_root_required");
                };
                validate_runtime_root(runtime_root)?;
                validate_authority_receipt_binding(authority, owner_token, Some(runtime_root))
            }
            Self::StartTerminal {
                protocol_version,
                request_id,
                authority,
                executable,
                argv,
                cwd,
                env,
                owner_token,
                cols,
                rows,
            } => {
                validate_protocol_identity(protocol_version, request_id, authority, now_millis)?;
                validate_launch(executable, argv, cwd, env, owner_token)?;
                validate_size(*cols, *rows)?;
                validate_authority_receipt_binding(authority, owner_token, None)
            }
            Self::StartProcess {
                protocol_version,
                request_id,
                authority,
                executable,
                argv,
                cwd,
                env,
                owner_token,
                runtime_root,
                stdin,
                grace_ms,
            } => {
                validate_protocol_identity(protocol_version, request_id, authority, now_millis)?;
                validate_launch(executable, argv, cwd, env, owner_token)?;
                let Some(runtime_root) = runtime_root.as_ref() else {
                    return Err("runtime_root_required");
                };
                validate_runtime_root(runtime_root)?;
                if stdin
                    .as_ref()
                    .is_some_and(|value| value.len() > 4 * 1024 * 1024)
                {
                    return Err("stdin_too_large");
                }
                if grace_ms.is_some_and(|value| value > 60_000) {
                    return Err("invalid_grace_ms");
                }
                validate_authority_receipt_binding(authority, owner_token, Some(runtime_root))
            }
            Self::Stop {
                protocol_version,
                request_id,
                authority,
                grace_ms,
            } => {
                validate_protocol_identity(protocol_version, request_id, authority, now_millis)?;
                if grace_ms.is_some_and(|value| value > 60_000) {
                    return Err("invalid_grace_ms");
                }
                Ok(())
            }
            Self::Input {
                protocol_version,
                request_id,
                authority,
                data,
            } => {
                validate_protocol_identity(protocol_version, request_id, authority, now_millis)?;
                if data.len() > 48 * 1024 || data.contains('\0') {
                    return Err("invalid_terminal_input");
                }
                Ok(())
            }
            Self::Resize {
                protocol_version,
                request_id,
                authority,
                cols,
                rows,
            } => {
                validate_protocol_identity(protocol_version, request_id, authority, now_millis)?;
                validate_size(*cols, *rows)
            }
        }
    }
}

fn validate_protocol_identity(
    protocol_version: &Option<ProtocolVersion>,
    request_id: &Option<String>,
    authority: &Option<AuthorityEnvelope>,
    now_millis: Option<u64>,
) -> Result<(), &'static str> {
    let Some(version) = protocol_version.as_ref() else {
        return Err("protocol_version_required");
    };
    let Some(request_id) = request_id.as_ref() else {
        return Err("request_id_required");
    };
    if request_id.is_empty() || request_id.len() > 256 {
        return Err("invalid_request_id");
    }
    if version.major == PROTOCOL_MAJOR {
        if version.minor > PROTOCOL_MINOR || authority.is_some() {
            return Err("protocol_version_mismatch");
        }
        return Ok(());
    }
    if version.major != V2_PROTOCOL_MAJOR || version.minor > V2_PROTOCOL_MINOR {
        return Err("protocol_version_mismatch");
    }
    let Some(authority) = authority.as_ref() else {
        return Err("authority_required");
    };
    if authority.request_id != *request_id {
        return Err("request_id_mismatch");
    }
    match now_millis {
        Some(now_millis) => authority.validate_at(now_millis)?,
        None => authority.validate()?,
    }
    Ok(())
}

fn validate_runtime_root(runtime_root: &str) -> Result<(), &'static str> {
    if runtime_root.is_empty()
        || runtime_root.len() > 4_096
        || !std::path::Path::new(runtime_root).is_absolute()
    {
        return Err("invalid_runtime_root");
    }
    Ok(())
}

fn validate_authority_receipt_binding(
    authority: &Option<AuthorityEnvelope>,
    owner_token: &Option<String>,
    runtime_root: Option<&String>,
) -> Result<(), &'static str> {
    let Some(authority) = authority.as_ref() else {
        return Ok(());
    };
    if authority.receipt_context.owner_token != owner_token.as_deref().unwrap_or_default() {
        return Err("receipt_context_mismatch");
    }
    if runtime_root
        .is_some_and(|runtime_root| runtime_root != &authority.receipt_context.runtime_root)
    {
        return Err("receipt_context_mismatch");
    }
    Ok(())
}

fn validate_launch(
    executable: &str,
    argv: &[String],
    cwd: &str,
    env: &std::collections::BTreeMap<String, String>,
    owner_token: &Option<String>,
) -> Result<(), &'static str> {
    const MAX_ARGUMENT_BYTES: usize = 256 * 1024;
    const MAX_ARGUMENT_TOTAL_BYTES: usize = 1024 * 1024;
    const MAX_ENV_TOTAL_BYTES: usize = 2 * 1024 * 1024;
    if executable.is_empty() || executable.len() > 4_096 {
        return Err("invalid_executable");
    }
    if cwd.is_empty() || cwd.len() > 4_096 {
        return Err("invalid_cwd");
    }
    if !std::path::Path::new(executable).is_absolute() || !std::path::Path::new(cwd).is_absolute() {
        return Err("paths_must_be_absolute");
    }
    if argv.len() > 64
        || argv.iter().any(|item| item.len() > MAX_ARGUMENT_BYTES)
        || argv.iter().map(String::len).sum::<usize>() > MAX_ARGUMENT_TOTAL_BYTES
    {
        return Err("invalid_arguments");
    }
    if env.len() > 512
        || env
            .iter()
            .map(|(name, value)| name.len() + value.len())
            .sum::<usize>()
            > MAX_ENV_TOTAL_BYTES
        || env.iter().any(|(name, value)| {
            name.is_empty()
                || name.len() > 256
                || value.len() > 16_384
                || name.contains('=')
                || name.contains('\0')
                || value.contains('\0')
        })
    {
        return Err("invalid_environment");
    }
    let Some(owner_token) = owner_token.as_ref() else {
        return Err("owner_token_required");
    };
    if owner_token.is_empty()
        || owner_token.len() > 256
        || owner_token == "."
        || owner_token == ".."
        || owner_token.contains('/')
        || owner_token.contains('\\')
        || owner_token.contains('\0')
    {
        return Err("invalid_owner_token");
    }
    Ok(())
}

fn validate_size(cols: u16, rows: u16) -> Result<(), &'static str> {
    if !(2..=1_000).contains(&cols) || !(1..=1_000).contains(&rows) {
        return Err("invalid_terminal_size");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_executable() -> &'static str {
        #[cfg(windows)]
        {
            r"C:\Windows\System32\cmd.exe"
        }
        #[cfg(not(windows))]
        {
            "/bin/sh"
        }
    }

    fn fixture_cwd() -> &'static str {
        #[cfg(windows)]
        {
            r"C:\"
        }
        #[cfg(not(windows))]
        {
            "/tmp"
        }
    }

    fn fixture_runtime_root() -> &'static str {
        #[cfg(windows)]
        {
            r"C:\rudder-runtime"
        }
        #[cfg(not(windows))]
        {
            "/tmp/rudder-runtime"
        }
    }

    #[test]
    fn parses_start_with_camel_case_fields() {
        let command: Command = serde_json::from_value(serde_json::json!({
            "type": "start",
            "protocolVersion": {"major": 1, "minor": 0},
            "requestId": "test",
            "executable": fixture_executable(),
            "argv": ["-c", "exit 0"],
            "cwd": fixture_cwd(),
            "env": {"RUDDER_TEST": "1"},
            "ownerToken": "opaque",
            "port": 43123,
            "runtimeRoot": fixture_runtime_root(),
        }))
        .expect("valid command");
        assert!(command.validate().is_ok());
        assert!(matches!(
            command,
            Command::Start {
                port: Some(43123),
                ..
            }
        ));
    }

    #[test]
    fn rejects_relative_launch_paths() {
        let command = Command::Start {
            protocol_version: Some(ProtocolVersion::default()),
            request_id: Some("test".into()),
            authority: None,
            executable: "node".into(),
            argv: Vec::new(),
            cwd: fixture_cwd().into(),
            env: Default::default(),
            owner_token: None,
            port: None,
            runtime_root: None,
        };
        assert_eq!(command.validate(), Err("paths_must_be_absolute"));
    }

    #[test]
    fn rejects_missing_protocol_identity() {
        let command = Command::Stop {
            protocol_version: None,
            request_id: Some("test".into()),
            authority: None,
            grace_ms: None,
        };
        assert_eq!(command.validate(), Err("protocol_version_required"));

        let command = Command::Stop {
            protocol_version: Some(ProtocolVersion::default()),
            request_id: None,
            authority: None,
            grace_ms: None,
        };
        assert_eq!(command.validate(), Err("request_id_required"));
    }

    #[test]
    fn rejects_incompatible_protocol_versions() {
        let command = Command::Stop {
            protocol_version: Some(ProtocolVersion {
                major: PROTOCOL_MAJOR + 2,
                minor: 0,
            }),
            request_id: Some("test".into()),
            authority: None,
            grace_ms: None,
        };
        assert_eq!(command.validate(), Err("protocol_version_mismatch"));
    }

    #[test]
    fn rejects_missing_or_empty_owner_tokens() {
        let base = |owner_token| Command::Start {
            protocol_version: Some(ProtocolVersion::default()),
            request_id: Some("test".into()),
            authority: None,
            executable: fixture_executable().into(),
            argv: vec!["-c".into(), "exit 0".into()],
            cwd: fixture_cwd().into(),
            env: Default::default(),
            owner_token,
            port: None,
            runtime_root: Some(fixture_runtime_root().into()),
        };
        assert_eq!(base(None).validate(), Err("owner_token_required"));
        assert_eq!(
            base(Some(String::new())).validate(),
            Err("invalid_owner_token")
        );
    }

    #[test]
    fn validates_terminal_commands() {
        let start: Command = serde_json::from_value(serde_json::json!({
            "type": "startTerminal",
            "protocolVersion": {"major": 1, "minor": 0},
            "requestId": "terminal-1",
            "executable": fixture_executable(),
            "argv": ["-l"],
            "cwd": fixture_cwd(),
            "env": {"TERM": "xterm-256color"},
            "ownerToken": "opaque",
            "cols": 80,
            "rows": 24,
        }))
        .expect("valid terminal start");
        assert_eq!(start.validate(), Ok(()));

        let resize: Command = serde_json::from_str(
            r#"{"type":"resize","protocolVersion":{"major":1,"minor":0},"requestId":"terminal-1","cols":1,"rows":24}"#,
        )
        .expect("parse resize");
        assert_eq!(resize.validate(), Err("invalid_terminal_size"));

        let input: Command = serde_json::from_str(
            "{\"type\":\"input\",\"protocolVersion\":{\"major\":1,\"minor\":0},\"requestId\":\"terminal-1\",\"data\":\"bad\\u0000input\"}",
        )
        .expect("parse input");
        assert_eq!(input.validate(), Err("invalid_terminal_input"));
    }

    #[test]
    fn accepts_large_bounded_arguments_and_rejects_total_overflow() {
        let base = |argument: String| Command::StartProcess {
            protocol_version: Some(ProtocolVersion::default()),
            request_id: Some("test".into()),
            authority: None,
            executable: fixture_executable().into(),
            argv: vec![argument],
            cwd: fixture_cwd().into(),
            env: Default::default(),
            owner_token: Some("opaque".into()),
            runtime_root: Some(fixture_runtime_root().into()),
            stdin: None,
            grace_ms: None,
        };
        assert_eq!(base("x".repeat(70_000)).validate(), Ok(()));
        assert_eq!(
            base("x".repeat(256 * 1024 + 1)).validate(),
            Err("invalid_arguments")
        );
    }

    fn authority(request_id: &str) -> AuthorityEnvelope {
        AuthorityEnvelope::new(
            ProcessRuntimeIdentity {
                organization_id: "org-1".into(),
                agent_id: "agent-1".into(),
                run_id: "run-1".into(),
            },
            ProcessOwnership {
                epoch: 7,
                fence: "fence-7".into(),
            },
            ProcessLease {
                owner: "worker-1".into(),
                issued_at_millis: 100,
                expires_at_millis: 2_000,
            },
            2,
            request_id,
            ReceiptContext {
                runtime_root: fixture_runtime_root().into(),
                owner_token: "owner-1".into(),
            },
        )
        .expect("valid authority envelope")
    }

    fn v2_start(authority: AuthorityEnvelope) -> serde_json::Value {
        serde_json::json!({
            "type": "startProcess",
            "protocolVersion": {"major": 2, "minor": 0},
            "requestId": "request-1",
            "executable": fixture_executable(),
            "argv": ["-c", "exit 0"],
            "cwd": fixture_cwd(),
            "env": {},
            "ownerToken": "owner-1",
            "runtimeRoot": fixture_runtime_root(),
            "authority": authority,
        })
    }

    #[test]
    fn v2_authority_is_versioned_bounded_and_bound_to_request_and_receipt() {
        let command: Command =
            serde_json::from_value(v2_start(authority("request-1"))).expect("valid v2 command");
        assert_eq!(command.validate(), Ok(()));
        assert_eq!(command.validate_at(1_000), Ok(()));

        let mut mismatched_request = v2_start(authority("different-request"));
        mismatched_request["authority"]["requestId"] = serde_json::json!("different-request");
        assert_eq!(
            serde_json::from_value::<Command>(mismatched_request)
                .expect("parse mismatched request")
                .validate(),
            Err("request_id_mismatch")
        );

        let mut mismatched_digest = v2_start(authority("request-1"));
        mismatched_digest["authority"]["bindingDigest"] = serde_json::json!("0".repeat(64));
        assert_eq!(
            serde_json::from_value::<Command>(mismatched_digest)
                .expect("parse mismatched digest")
                .validate(),
            Err("binding_digest_mismatch")
        );

        let mut missing_authority = v2_start(authority("request-1"));
        missing_authority
            .as_object_mut()
            .expect("command object")
            .remove("authority");
        assert_eq!(
            serde_json::from_value::<Command>(missing_authority)
                .expect("parse missing authority")
                .validate(),
            Err("authority_required")
        );
    }

    #[test]
    fn v2_rejects_old_unknown_expired_and_out_of_bounds_authority() {
        let mut old = v2_start(authority("request-1"));
        old["protocolVersion"] = serde_json::json!({"major": 1, "minor": 0});
        assert_eq!(
            serde_json::from_value::<Command>(old)
                .expect("parse old command")
                .validate(),
            Err("protocol_version_mismatch")
        );

        let mut unknown = v2_start(authority("request-1"));
        unknown["protocolVersion"] = serde_json::json!({"major": 99, "minor": 0});
        assert_eq!(
            serde_json::from_value::<Command>(unknown)
                .expect("parse unknown command")
                .validate(),
            Err("protocol_version_mismatch")
        );

        let expired = serde_json::from_value::<Command>(v2_start(authority("request-1")))
            .expect("parse expired fixture");
        assert_eq!(expired.validate_at(2_000), Err("lease_expired"));

        let mut bounded = authority("request-1");
        bounded.attempt = 0;
        assert_eq!(bounded.validate(), Err("invalid_authority_attempt"));
    }
}
