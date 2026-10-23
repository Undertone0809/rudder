//! Read-only admission checks for the local runtimes supported by Native Chat.
//!
//! This endpoint validates the configuration that Rust's Native Chat resolver
//! will consume. It never launches a provider or sends a model request.

use super::*;
use rudder_d1_persistence::native_chat::config::{
    NativeRuntimeConfigError, NativeRuntimeConfigReadiness, check_native_runtime_config,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::Path;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const MAX_BODY_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeCheckInput {
    agent_runtime_type: String,
    #[serde(default)]
    agent_runtime_config: Option<Value>,
}

struct Check {
    code: &'static str,
    level: &'static str,
    message: &'static str,
    hint: Option<&'static str>,
}

impl Check {
    fn info(code: &'static str, message: &'static str) -> Self {
        Self {
            code,
            level: "info",
            message,
            hint: None,
        }
    }

    fn warn(code: &'static str, message: &'static str, hint: &'static str) -> Self {
        Self {
            code,
            level: "warn",
            message,
            hint: Some(hint),
        }
    }

    fn fail(code: &'static str, message: &'static str, hint: &'static str) -> Self {
        Self {
            code,
            level: "error",
            message,
            hint: Some(hint),
        }
    }

    fn to_json(&self) -> Value {
        let mut value = json!({
            "code": self.code,
            "level": self.level,
            "message": self.message,
        });
        if let Some(hint) = self.hint {
            value["hint"] = json!(hint);
        }
        value
    }
}

pub(super) async fn check(
    state: web::Data<IngressState>,
    request: HttpRequest,
    organization: web::Path<String>,
    body: web::Bytes,
) -> HttpResponse {
    let organization_id = organization.into_inner();
    if Uuid::parse_str(&organization_id)
        .ok()
        .is_none_or(|id| id.to_string() != organization_id)
        || request.uri().path() != format!("/api/orgs/{organization_id}/native-chat/runtime-check")
    {
        return error(StatusCode::NOT_FOUND, "route_not_found");
    }
    if !request.query_string().is_empty() {
        return error(StatusCode::BAD_REQUEST, "query_not_allowed");
    }
    if body.len() > MAX_BODY_BYTES {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "runtime_check_too_large");
    }
    if !request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .next()
                .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("application/json"))
        })
    {
        return error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "json_required");
    }

    // Scope the browser credential to this organization before checking Agent
    // configuration access or inspecting any runtime details.
    let (pool, actor, organization_id) =
        match browser_actor_for_org(&state, &request, &organization_id, true).await {
            Ok(value) => value,
            Err(response) => return *response,
        };
    match rudder_d1_persistence::agent_core::browser_user_can_read_configs(
        &pool,
        &organization_id,
        actor.user_id(),
        actor.source() == "local_implicit",
    )
    .await
    {
        Ok(true) => (),
        Ok(false) => return error(StatusCode::FORBIDDEN, "forbidden"),
        Err(_) => return unavailable(),
    }

    let input: RuntimeCheckInput = match serde_json::from_slice(&body) {
        Ok(input) => input,
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid_runtime_check"),
    };
    if input.agent_runtime_type.trim().is_empty()
        || input.agent_runtime_type.len() > 128
        || input.agent_runtime_type.chars().any(char::is_control)
    {
        return error(StatusCode::BAD_REQUEST, "invalid_runtime_check");
    }

    let mut checks = Vec::new();
    let config = input
        .agent_runtime_config
        .as_ref()
        .filter(|value| !value.is_null());
    if let Some(config) = config {
        if !matches!(
            input.agent_runtime_type.as_str(),
            "codex_local" | "hermes_local"
        ) {
            checks.push(Check::fail(
                "native_chat_runtime_unsupported",
                "This runtime is not supported by Native Chat readiness checks.",
                "Choose Codex (local) or Hermes.",
            ));
        } else if let Some(runtime) = state.config.native_chat_runtime.as_ref() {
            if !runtime_host_is_ready(&runtime.paths.process_host)
                || !runtime.paths.runtime_root.is_dir()
                || !runtime.paths.isolated_home.is_dir()
            {
                checks.push(Check::fail(
                    "native_chat_runtime_unavailable",
                    "The local Native Chat process host is unavailable.",
                    "Repair or reinstall the Rudder native runtime host.",
                ));
            } else {
                match check_native_runtime_config(
                &pool,
                &organization_id,
                &input.agent_runtime_type,
                config,
                &runtime.host,
            )
            .await
            {
                Ok(NativeRuntimeConfigReadiness::Ready) => checks.push(Check::info(
                    "native_chat_local_runtime_ready",
                    "The local runtime, selected profile, and Native Chat configuration are ready.",
                )),
                Ok(NativeRuntimeConfigReadiness::AgentProfileProvisionedOnCreate) => {
                    checks.push(Check::warn(
                        "native_chat_codex_profile_pending",
                        "The selected Codex profile will be provisioned when the Agent is saved.",
                        "Save the Agent before starting its first Native Chat.",
                    ))
                }
                Err(error) => checks.push(error_check(error)),
            }
            }
        } else {
            checks.push(Check::fail(
                "native_chat_runtime_unavailable",
                "The local Native Chat runtime host is unavailable.",
                "Enable and repair the Rudder native runtime host before using Native Chat.",
            ));
        }
    } else {
        checks.push(Check::fail(
            "native_chat_runtime_config_missing",
            "Agent runtime configuration is required for Native Chat readiness.",
            "Configure Codex or Hermes, then test again.",
        ));
    }

    // Readiness here is deliberately local-only. Do not claim that a model,
    // provider credential, or remote endpoint was contacted.
    checks.push(Check::info(
        "native_chat_provider_not_probed",
        "Provider connectivity and model credentials were not tested.",
    ));
    let status = if checks.iter().any(|check| check.level == "error") {
        "fail"
    } else if checks.iter().any(|check| check.level == "warn") {
        "warn"
    } else {
        "pass"
    };
    let tested_at = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned());
    HttpResponse::Ok()
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .json(json!({
            "agentRuntimeType": input.agent_runtime_type,
            "status": status,
            "checks": checks.iter().map(Check::to_json).collect::<Vec<_>>(),
            "testedAt": tested_at,
        }))
}

fn error_check(error: NativeRuntimeConfigError) -> Check {
    match error {
        NativeRuntimeConfigError::UnsupportedRuntime => Check::fail(
            "native_chat_runtime_unsupported",
            "This runtime is not supported by Native Chat readiness checks.",
            "Choose Codex (local) or Hermes.",
        ),
        NativeRuntimeConfigError::ConfigurationRejected => Check::fail(
            "native_chat_runtime_config_rejected",
            "The runtime configuration contains settings Native Chat cannot apply.",
            "Remove unsupported fields and select a supported profile configuration.",
        ),
        NativeRuntimeConfigError::RuntimeUnavailable => Check::fail(
            "native_chat_runtime_unavailable",
            "The selected local CLI or trusted executable path is unavailable.",
            "Install or repair the selected runtime, then retry this check.",
        ),
        NativeRuntimeConfigError::ProfileUnavailable => Check::fail(
            "native_chat_profile_unavailable",
            "The selected local runtime profile is missing or invalid.",
            "Choose an installed profile and retry this check.",
        ),
        NativeRuntimeConfigError::AcpBootstrapUnavailable => Check::fail(
            "native_chat_acp_bootstrap_unavailable",
            "The installed Hermes ACP bootstrap capability is unavailable.",
            "Install the supported Hermes version and retry this check.",
        ),
        NativeRuntimeConfigError::DependencyUnavailable => Check::fail(
            "native_chat_readiness_unavailable",
            "Native Chat could not verify required organization configuration.",
            "Check database availability and retry this check.",
        ),
    }
}

fn runtime_host_is_ready(process_host: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(process_host) else {
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
