//! Read-only preflight for the local runtimes used by Native Chat.
//!
//! This deliberately checks Rust's strict runtime config and trusted local
//! installation facts. It never launches a provider or submits a prompt.

use super::{LocalHostContext, hermes, resolve, runtime};
use crate::runtime_bindings::Error;
use rudder_hermes_acp::resolve_instruction_bootstrap;
use serde_json::Value;
use sqlx::PgPool;
use std::{fs, path::Path};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeRuntimeConfigReadiness {
    Ready,
    AgentProfileProvisionedOnCreate,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeRuntimeConfigError {
    UnsupportedRuntime,
    ConfigurationRejected,
    RuntimeUnavailable,
    ProfileUnavailable,
    AcpBootstrapUnavailable,
    DependencyUnavailable,
}

/// Validate exactly the native Codex/Hermes config and profile admission used
/// by Native Chat. Hermes Secret references are resolved read-only so a valid
/// shape cannot hide a missing or out-of-organization Secret.
pub async fn check_native_runtime_config(
    pool: &PgPool,
    organization_id: &str,
    runtime_type: &str,
    config: &Value,
    host: &LocalHostContext,
) -> Result<NativeRuntimeConfigReadiness, NativeRuntimeConfigError> {
    match runtime_type {
        "codex_local" => check_codex(config, host),
        "hermes_local" => check_hermes(pool, organization_id, config, host).await,
        _ => Err(NativeRuntimeConfigError::UnsupportedRuntime),
    }
}

fn check_codex(
    config: &Value,
    host: &LocalHostContext,
) -> Result<NativeRuntimeConfigReadiness, NativeRuntimeConfigError> {
    let executable = host
        .codex_executable()
        .ok_or(NativeRuntimeConfigError::RuntimeUnavailable)?;
    if !host.uses_native_codex_profile()
        || !host.has_trusted_executable_search_path()
        || !is_executable(executable)
    {
        return Err(NativeRuntimeConfigError::RuntimeUnavailable);
    }
    let settings = runtime::parse_agent_config_with_profile_defaults(
        config.clone(),
        None,
        None,
        false,
        host.operator_home(),
        true,
    )
    .map_err(|_| NativeRuntimeConfigError::ConfigurationRejected)?;
    if let Some(command) = settings.command.as_deref() {
        let configured = command
            .canonicalize()
            .map_err(|_| NativeRuntimeConfigError::ConfigurationRejected)?;
        if configured != executable {
            return Err(NativeRuntimeConfigError::ConfigurationRejected);
        }
    }
    match resolve::resolve_native_codex_profile_home(host, &settings.profile_id, None, None)
        .map_err(|_| NativeRuntimeConfigError::ProfileUnavailable)?
    {
        None => Ok(NativeRuntimeConfigReadiness::AgentProfileProvisionedOnCreate),
        Some(home) => {
            resolve::codex_profile_config_revision(&home)
                .map_err(|_| NativeRuntimeConfigError::ProfileUnavailable)?;
            Ok(NativeRuntimeConfigReadiness::Ready)
        }
    }
}

async fn check_hermes(
    pool: &PgPool,
    organization_id: &str,
    config: &Value,
    host: &LocalHostContext,
) -> Result<NativeRuntimeConfigReadiness, NativeRuntimeConfigError> {
    let executable = host
        .hermes_executable()
        .filter(|path| is_executable(path))
        .ok_or(NativeRuntimeConfigError::RuntimeUnavailable)?;
    let profile_root = host
        .hermes_profiles_root()
        .filter(|root| root.is_dir())
        .ok_or(NativeRuntimeConfigError::RuntimeUnavailable)?;
    if !host.has_trusted_executable_search_path() {
        return Err(NativeRuntimeConfigError::RuntimeUnavailable);
    }

    let settings = hermes::parse_runtime_settings(config, None, None, false)
        .map_err(|_| NativeRuntimeConfigError::ConfigurationRejected)?;
    let profile = hermes::resolve_profile_home(profile_root, &settings.profile_id)
        .map_err(|_| NativeRuntimeConfigError::ProfileUnavailable)?;
    hermes::hermes_profile_revision(&profile)
        .map_err(|_| NativeRuntimeConfigError::ProfileUnavailable)?;
    resolve_instruction_bootstrap(executable)
        .map_err(|_| NativeRuntimeConfigError::AcpBootstrapUnavailable)?;

    // Match Native Chat's organization-scoped Secret admission without
    // returning, serializing, or logging the resolved environment values.
    let mut tx = pool
        .begin()
        .await
        .map_err(|_| NativeRuntimeConfigError::DependencyUnavailable)?;
    let env = super::resolve_agent_env(&mut tx, organization_id, settings.env.as_ref())
        .await
        .map_err(|error| match error {
            Error::Database(_) => NativeRuntimeConfigError::DependencyUnavailable,
            Error::Http(_, _) => NativeRuntimeConfigError::ConfigurationRejected,
        })?;
    drop(env);
    tx.commit()
        .await
        .map_err(|_| NativeRuntimeConfigError::DependencyUnavailable)?;
    Ok(NativeRuntimeConfigReadiness::Ready)
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}
