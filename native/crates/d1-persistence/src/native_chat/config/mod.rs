//! Trusted, read-only resolution of persisted Agent and Chat settings for the
//! local Codex runtime. These Rust-only types are not wire DTOs.

mod claude;
mod cursor;
mod fingerprint;
mod hermes;
mod host;
mod opencode;
mod pi;
mod readiness;
mod resolve;
mod runtime;
mod transport;
pub use transport::TransportConfig;

pub use claude::ClaudeLocalConfig;
pub(crate) use claude::{resolve_claude_config, resolve_goal_claude_config};
pub use cursor::CursorLocalConfig;
pub(crate) use cursor::resolve_cursor_config;
pub use hermes::HermesLocalConfig;
pub(crate) use hermes::{resolve_agent_env, resolve_hermes_config};
pub use host::LocalHostContext;
pub use opencode::OpenCodeLocalConfig;
pub(crate) use opencode::resolve_opencode_config;
pub use pi::PiLocalConfig;
pub(crate) use pi::resolve_pi_config;
pub use readiness::{
    NativeRuntimeConfigError, NativeRuntimeConfigReadiness, check_native_runtime_config,
};
pub use resolve::historical_codex_profile_home;
pub(crate) use resolve::resolve_codex_config;
pub use resolve::{ManagedCodexProfile, ResolvedCodexConfig, RuntimeBindingIdentity};

#[cfg(test)]
mod tests;

use super::{Error, http};

type Result<T> = std::result::Result<T, Error>;

fn unsupported(detail: &'static str) -> Error {
    http(
        409,
        format!("Native Codex Chat configuration is unsupported: {detail}"),
    )
}

fn invalid(detail: &'static str) -> Error {
    http(
        409,
        format!("Native Codex Chat configuration is invalid: {detail}"),
    )
}

#[doc(hidden)]
pub struct ResolvedModelAttempt {
    pub index: usize,
    pub plan_revision: String,
}

/// Resolve the provider from the selected Agent row, then use that provider's
/// strict configuration reader. The result remains in the historical carrier
/// for source compatibility; `identity.runtime_type` and the provider
/// extension select the closed execution branch.
pub(crate) async fn resolve_native_config(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    organization_id: &str,
    conversation_id: &str,
    host: &LocalHostContext,
) -> std::result::Result<ResolvedCodexConfig, Error> {
    resolve_model_attempt_config(tx, organization_id, conversation_id, host, 0)
        .await?
        .ok_or_else(|| invalid("primary model attempt is unavailable"))
}

/// Derive the effective attempt only from the locked selected Agent and Chat.
/// Provider readers retain their own validation, profile, workspace and secrets.
/// The generic planner supplies only ordering and provider-specific projection.
pub(crate) async fn resolve_model_attempt_config(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    organization_id: &str,
    conversation_id: &str,
    host: &LocalHostContext,
    index: usize,
) -> std::result::Result<Option<ResolvedCodexConfig>, Error> {
    use sqlx::Row;
    let row = sqlx::query("SELECT a.agent_runtime_type,a.agent_runtime_config,c.model_override FROM chat_conversations c JOIN agents a ON a.org_id=c.org_id AND a.id=COALESCE(c.preferred_agent_id,c.routed_agent_id) WHERE c.org_id=$1::uuid AND c.id=$2::uuid FOR UPDATE OF c FOR SHARE OF a NOWAIT")
        .bind(organization_id).bind(conversation_id).fetch_optional(&mut **tx).await?
        .ok_or_else(|| invalid("selected Agent is unavailable"))?;
    let runtime: String = row.try_get("agent_runtime_type")?;
    let mut raw: serde_json::Value = row.try_get("agent_runtime_config")?;
    if !raw.is_object() {
        return Err(invalid("Agent runtime configuration must be an object"));
    }
    if let Some(model) = row
        .try_get::<Option<String>, _>("model_override")?
        .filter(|v| !v.trim().is_empty())
    {
        raw["model"] = serde_json::json!(model);
    }
    let revision = fingerprint::json_revision(&serde_json::json!({"runtime":runtime,"config":raw}));
    let mut plan = crate::agent_execution::model_attempts::build(&raw, &runtime);
    if index >= plan.len() {
        return Ok(None);
    }
    let mut selected = plan.swap_remove(index);
    // The planner has already consumed the complete fallback policy. Provider
    // settings are validated once for this attempt without silently retrying.
    selected
        .config
        .as_object_mut()
        .expect("validated configuration")
        .remove("modelFallbacks");
    let mut attempt_host = host.clone();
    attempt_host.model_attempt = Some((selected.runtime_type.clone(), selected.config, index > 0));
    let mut result = resolve_selected_config(
        tx,
        organization_id,
        conversation_id,
        &attempt_host,
        &selected.runtime_type,
    )
    .await?;
    result.model_attempt = Some(ResolvedModelAttempt {
        index,
        plan_revision: revision,
    });
    Ok(Some(result))
}

async fn resolve_selected_config(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    organization_id: &str,
    conversation_id: &str,
    host: &LocalHostContext,
    runtime_type: &str,
) -> std::result::Result<ResolvedCodexConfig, Error> {
    match runtime_type {
        "codex_local" => resolve_codex_config(tx, organization_id, conversation_id, host).await,
        "hermes_local" => resolve_hermes_config(tx, organization_id, conversation_id, host).await,
        "claude_local" => resolve_claude_config(tx, organization_id, conversation_id, host).await,
        "cursor" | "cursor_local" => {
            resolve_cursor_config(tx, organization_id, conversation_id, host).await
        }
        "opencode_local" => {
            resolve_opencode_config(tx, organization_id, conversation_id, host).await
        }
        "pi_local" => resolve_pi_config(tx, organization_id, conversation_id, host).await,
        _ => transport::resolve_transport_config(tx, organization_id, conversation_id, host).await,
    }
}
