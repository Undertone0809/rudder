//! Trusted, read-only resolution of persisted Agent and Chat settings for the
//! local Codex runtime. These Rust-only types are not wire DTOs.

mod fingerprint;
mod hermes;
mod host;
mod resolve;
mod runtime;

pub use hermes::HermesLocalConfig;
pub(crate) use hermes::resolve_hermes_config;
pub use host::LocalHostContext;
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

/// Resolve the provider from the selected Agent row, then use that provider's
/// strict configuration reader. The result remains in the historical carrier
/// for source compatibility; `identity.runtime_type` and `hermes` select the
/// closed execution branch.
pub(crate) async fn resolve_native_config(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    organization_id: &str,
    conversation_id: &str,
    host: &LocalHostContext,
) -> std::result::Result<ResolvedCodexConfig, Error> {
    use sqlx::Row;
    let row = sqlx::query(
        "SELECT a.agent_runtime_type
         FROM chat_conversations c
         JOIN agents a ON a.org_id=c.org_id
           AND a.id=COALESCE(c.preferred_agent_id,c.routed_agent_id)
         WHERE c.org_id=$1::uuid AND c.id=$2::uuid",
    )
    .bind(organization_id)
    .bind(conversation_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| invalid("selected Agent is unavailable"))?;
    let runtime_type: String = row.try_get("agent_runtime_type")?;
    match runtime_type.as_str() {
        "codex_local" => resolve_codex_config(tx, organization_id, conversation_id, host).await,
        "hermes_local" => resolve_hermes_config(tx, organization_id, conversation_id, host).await,
        _ => Err(unsupported(
            "selected local runtime is not supported by Native Chat",
        )),
    }
}
