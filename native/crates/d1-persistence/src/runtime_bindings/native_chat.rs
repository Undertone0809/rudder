//! Transaction-borrowing binding access for trusted Native Chat admission.
//! These types are crate-private and never deserialize caller-provided binding
//! identities. The caller supplies configuration resolved by the Rust host.

use super::{IdentityInput, Result, Tx, http};
use crate::native_chat::NativeChatActor;
use rudder_runtime_core::native_chat::HermesSessionSelector;
use sqlx::Row;

/// Runtime types that are admitted through the Rust Native Chat path. Keep
/// this list aligned with `native_chat::config::resolve_native_config`; a
/// binding may be created for any configured local provider, but it must not
/// admit input if the worker has no Rust execution branch for that provider.
fn supports_native_chat_runtime(runtime_type: &str) -> bool {
    matches!(
        runtime_type,
        "codex_local"
            | "hermes_local"
            | "claude_local"
            | "cursor"
            | "cursor_local"
            | "opencode_local"
            | "pi_local"
    )
}

pub(crate) struct EnsuredNativeChatBinding {
    pub binding_id: String,
    pub segment_id: String,
    pub native_session_id: Option<String>,
    pub state: String,
}

/// Call after actor/org authorization, before acquiring Issue/Conversation or
/// any other row locks. All native admissions share the private ensure lock.
pub(crate) async fn lock_native_chat_target_tx(
    tx: &mut Tx<'_>,
    organization_id: &str,
    conversation_id: &str,
) -> Result<()> {
    super::locks::lock_target(tx, organization_id, conversation_id).await
}

pub(crate) async fn ensure_native_chat_binding_tx(
    tx: &mut Tx<'_>,
    actor: &impl NativeChatActor,
    organization_id: &str,
    conversation_id: &str,
    identity: &IdentityInput,
) -> Result<EnsuredNativeChatBinding> {
    let value =
        super::ensure::ensure_tx(tx, actor, organization_id, conversation_id, identity, true)
            .await?;
    locked_segment(tx, organization_id, &value).await
}

/// Revalidate the exact association without creating or rotating a binding.
/// Claim must acquire the target advisory lock before any row locks as well.
pub(crate) async fn read_native_chat_binding_tx(
    tx: &mut Tx<'_>,
    actor: &impl NativeChatActor,
    organization_id: &str,
    conversation_id: &str,
    identity: &IdentityInput,
    binding_id: &str,
    segment_id: &str,
) -> Result<EnsuredNativeChatBinding> {
    let value =
        super::ensure::ensure_tx(tx, actor, organization_id, conversation_id, identity, false)
            .await?;
    if value["binding"]["id"].as_str() != Some(binding_id)
        || value["segment"]["id"].as_str() != Some(segment_id)
    {
        return Err(http(409, "Native Chat binding or segment changed"));
    }
    locked_segment(tx, organization_id, &value).await
}

async fn locked_segment(
    tx: &mut Tx<'_>,
    organization_id: &str,
    value: &serde_json::Value,
) -> Result<EnsuredNativeChatBinding> {
    let binding_id = value["binding"]["id"]
        .as_str()
        .ok_or_else(|| http(409, "Native Chat binding identity is missing"))?;
    let segment_id = value["segment"]["id"]
        .as_str()
        .ok_or_else(|| http(409, "Native Chat current segment is missing"))?;
    let row = sqlx::query(
        "SELECT s.state, s.native_session_id, s.runtime_type,
                s.sealed_at IS NOT NULL AS sealed, b.continuity
         FROM native_segments s
         JOIN runtime_bindings b ON b.org_id=s.org_id AND b.id=s.binding_id
         WHERE s.org_id=$1::uuid AND s.binding_id=$2::uuid AND s.id=$3::uuid
           AND b.current_segment_id=s.id AND b.status='active'
         FOR UPDATE OF s",
    )
    .bind(organization_id)
    .bind(binding_id)
    .bind(segment_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(409, "Native Chat current segment changed"))?;
    let state: String = row.try_get("state")?;
    let native_session_id: Option<String> = row.try_get("native_session_id")?;
    let runtime_type: String = row.try_get("runtime_type")?;
    let sealed: bool = row.try_get("sealed")?;
    let continuity: String = row.try_get("continuity")?;
    if continuity != "native" {
        return Err(http(409, "Native Chat requires native binding continuity"));
    }
    let valid = match (
        runtime_type.as_str(),
        state.as_str(),
        native_session_id.as_deref(),
    ) {
        (_, "pending", None) => true,
        ("codex_local", "open", Some(id)) => !id.trim().is_empty() && id.len() <= 4096,
        ("hermes_local", "open", Some(id)) => HermesSessionSelector::from_persisted(id).is_ok(),
        _ => false,
    };
    if !valid || sealed || !supports_native_chat_runtime(&runtime_type) {
        return Err(http(409, "Native Chat segment cannot admit new input"));
    }
    Ok(EnsuredNativeChatBinding {
        binding_id: binding_id.to_owned(),
        segment_id: segment_id.to_owned(),
        native_session_id,
        state,
    })
}

#[cfg(test)]
mod tests {
    use super::supports_native_chat_runtime;

    #[test]
    fn all_rust_native_chat_runtimes_are_admissible() {
        for runtime in [
            "codex_local",
            "hermes_local",
            "claude_local",
            "cursor",
            "cursor_local",
            "opencode_local",
            "pi_local",
        ] {
            assert!(supports_native_chat_runtime(runtime), "{runtime}");
        }
        for runtime in ["process", "openclaw_gateway", "gemini_cli", ""] {
            assert!(!supports_native_chat_runtime(runtime), "{runtime}");
        }
    }
}
