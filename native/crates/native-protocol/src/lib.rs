use serde::{Deserialize, Serialize};

pub const PROTOCOL_MAJOR: u16 = 1;
pub const PROTOCOL_MINOR: u16 = 0;
pub const PROTOCOL_VERSION: &str = "1.0";
#[cfg(unix)]
pub const CAPABILITIES: &[&str] = &[
    "process_spawn",
    "process_group_cleanup",
    "parent_eof_cleanup",
    "listener_owner_attestation",
    "owner_receipt",
    "output_order_index",
    "stdout_relay",
    "stderr_relay",
];
#[cfg(windows)]
pub const CAPABILITIES: &[&str] = &[
    "process_spawn",
    "parent_eof_cleanup",
    "stdout_relay",
    "stderr_relay",
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

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Command {
    Start {
        #[serde(rename = "protocolVersion", default)]
        protocol_version: Option<ProtocolVersion>,
        #[serde(rename = "requestId", default)]
        request_id: Option<String>,
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
    Stop {
        #[serde(rename = "protocolVersion", default)]
        protocol_version: Option<ProtocolVersion>,
        #[serde(rename = "requestId", default)]
        request_id: Option<String>,
    },
}

impl Command {
    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::Start {
                protocol_version,
                request_id,
                executable,
                argv,
                cwd,
                env,
                owner_token,
                port,
                runtime_root,
            } => {
                if protocol_version.is_none() {
                    return Err("protocol_version_required");
                }
                if request_id.is_none() {
                    return Err("request_id_required");
                }
                if protocol_version.as_ref().is_some_and(|version| {
                    version.major != PROTOCOL_MAJOR || version.minor > PROTOCOL_MINOR
                }) {
                    return Err("protocol_version_mismatch");
                }
                if request_id
                    .as_ref()
                    .is_some_and(|id| id.is_empty() || id.len() > 256)
                {
                    return Err("invalid_request_id");
                }
                if executable.is_empty() || executable.len() > 4_096 {
                    return Err("invalid_executable");
                }
                if cwd.is_empty() || cwd.len() > 4_096 {
                    return Err("invalid_cwd");
                }
                if !std::path::Path::new(executable).is_absolute()
                    || !std::path::Path::new(cwd).is_absolute()
                {
                    return Err("paths_must_be_absolute");
                }
                if argv.len() > 64 || argv.iter().any(|item| item.len() > 4_096) {
                    return Err("invalid_arguments");
                }
                if env.len() > 64
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
                if port.is_none() {
                    return Err("port_required");
                }
                let Some(runtime_root) = runtime_root.as_ref() else {
                    return Err("runtime_root_required");
                };
                if runtime_root.is_empty()
                    || runtime_root.len() > 4_096
                    || !std::path::Path::new(runtime_root).is_absolute()
                {
                    return Err("invalid_runtime_root");
                }
                Ok(())
            }
            Self::Stop {
                protocol_version,
                request_id,
            } => {
                if protocol_version.is_none() {
                    return Err("protocol_version_required");
                }
                if request_id.is_none() {
                    return Err("request_id_required");
                }
                if protocol_version.as_ref().is_some_and(|version| {
                    version.major != PROTOCOL_MAJOR || version.minor > PROTOCOL_MINOR
                }) {
                    return Err("protocol_version_mismatch");
                }
                if request_id
                    .as_ref()
                    .is_some_and(|id| id.is_empty() || id.len() > 256)
                {
                    return Err("invalid_request_id");
                }
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_start_with_camel_case_fields() {
        let command: Command = serde_json::from_str(
            r#"{"type":"start","protocolVersion":{"major":1,"minor":0},"requestId":"test","executable":"/bin/sh","argv":["-c","exit 0"],"cwd":"/tmp","env":{"RUDDER_TEST":"1"},"ownerToken":"opaque","port":43123,"runtimeRoot":"/tmp/rudder-runtime"}"#,
        )
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
            executable: "node".into(),
            argv: Vec::new(),
            cwd: "/tmp".into(),
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
        };
        assert_eq!(command.validate(), Err("protocol_version_required"));

        let command = Command::Stop {
            protocol_version: Some(ProtocolVersion::default()),
            request_id: None,
        };
        assert_eq!(command.validate(), Err("request_id_required"));
    }

    #[test]
    fn rejects_incompatible_protocol_versions() {
        let command = Command::Stop {
            protocol_version: Some(ProtocolVersion {
                major: PROTOCOL_MAJOR + 1,
                minor: 0,
            }),
            request_id: Some("test".into()),
        };
        assert_eq!(command.validate(), Err("protocol_version_mismatch"));
    }

    #[test]
    fn rejects_missing_or_empty_owner_tokens() {
        let base = |owner_token| Command::Start {
            protocol_version: Some(ProtocolVersion::default()),
            request_id: Some("test".into()),
            executable: "/bin/sh".into(),
            argv: vec!["-c".into(), "exit 0".into()],
            cwd: "/tmp".into(),
            env: Default::default(),
            owner_token,
            port: Some(43123),
            runtime_root: Some("/tmp/rudder-runtime".into()),
        };
        assert_eq!(base(None).validate(), Err("owner_token_required"));
        assert_eq!(
            base(Some(String::new())).validate(),
            Err("invalid_owner_token")
        );
    }

    #[test]
    fn rejects_owner_tokens_that_are_not_single_safe_path_components() {
        for token in [
            ".",
            "..",
            "../outside",
            "nested/path",
            "nested\\path",
            "bad\0token",
        ] {
            let command = Command::Start {
                protocol_version: Some(ProtocolVersion::default()),
                request_id: Some("test".into()),
                executable: "/bin/sh".into(),
                argv: Vec::new(),
                cwd: "/tmp".into(),
                env: Default::default(),
                owner_token: Some(token.into()),
                port: Some(43_123),
                runtime_root: Some("/tmp/rudder-runtime".into()),
            };
            assert_eq!(
                command.validate(),
                Err("invalid_owner_token"),
                "token={token:?}"
            );
        }
    }
}
