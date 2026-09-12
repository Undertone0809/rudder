use serde::Serialize;

/// Describes the binary that produced a health or readiness receipt.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BuildIdentity {
    pub package: &'static str,
    pub version: &'static str,
    pub target: &'static str,
}

/// Explicit authority boundary for the non-product foundation process.
///
/// The foundation can answer its own health/readiness endpoints and perform a
/// bounded dependency probe, but the Node server remains authoritative for
/// product routes, commands, tools, schema, and migrations.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerIdentity {
    pub build_identity: BuildIdentity,
    pub schema_fingerprint: Option<&'static str>,
    pub route_authority: &'static str,
    pub command_authority: &'static str,
    pub tool_authority: &'static str,
    pub ownership_epoch: u64,
    pub migration_state: &'static str,
}

impl Default for ServerIdentity {
    fn default() -> Self {
        Self {
            build_identity: BuildIdentity {
                package: env!("CARGO_PKG_NAME"),
                version: env!("CARGO_PKG_VERSION"),
                target: native_target(),
            },
            // This process deliberately does not inspect or own the product
            // schema. Null is safer than publishing an unverified fingerprint.
            schema_fingerprint: None,
            route_authority: "node",
            command_authority: "node",
            tool_authority: "node",
            ownership_epoch: 0,
            migration_state: "node-authoritative",
        }
    }
}

fn native_target() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "x86_64-unknown-linux-gnu"
    } else {
        "unsupported"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn foundation_identity_is_explicitly_non_authoritative() {
        let identity = ServerIdentity::default();
        assert_eq!(
            identity.build_identity.package,
            "rudder-server-foundation-core"
        );
        assert!(!identity.build_identity.version.is_empty());
        assert!(!identity.build_identity.target.is_empty());
        assert_eq!(identity.schema_fingerprint, None);
        assert_eq!(identity.route_authority, "node");
        assert_eq!(identity.command_authority, "node");
        assert_eq!(identity.tool_authority, "node");
        assert_eq!(identity.ownership_epoch, 0);
        assert_eq!(identity.migration_state, "node-authoritative");
    }
}
