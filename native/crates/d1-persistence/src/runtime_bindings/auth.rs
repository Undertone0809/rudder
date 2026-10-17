use super::{Conversation, Result, Tx, http};
use crate::native_chat::{
    BrowserCredentialKind, NativeChatActor, NativeChatExecutionActor, execution::ExecutionFence,
};
use sha2::{Digest, Sha256};
use sqlx::Row;

use super::validation::canonical_uuid;

pub(super) async fn authorize_org(
    tx: &mut Tx<'_>,
    actor: &impl NativeChatActor,
    organization_id: &str,
) -> Result<()> {
    if actor.organization_id() != organization_id {
        return Err(http(403, "Organization access denied"));
    }
    if let Some(credential) = actor.browser_credential() {
        return authorize_browser_principal_org(tx, actor, credential, organization_id, true).await;
    }

    authorize_nonbrowser_org(tx, actor, organization_id, true).await
}

/// Check authorization without retaining credential or membership locks. This
/// is only a precheck before Native Chat's target advisory lock; callers must
/// run `authorize_org` again after the wait and before committing a mutation.
pub(super) async fn preauthorize_org(
    tx: &mut Tx<'_>,
    actor: &impl NativeChatActor,
    organization_id: &str,
) -> Result<()> {
    if actor.organization_id() != organization_id {
        return Err(http(403, "Organization access denied"));
    }
    if let Some(credential) = actor.browser_credential() {
        return authorize_browser_principal_org(tx, actor, credential, organization_id, false)
            .await;
    }

    authorize_nonbrowser_org(tx, actor, organization_id, false).await
}

async fn authorize_nonbrowser_org(
    tx: &mut Tx<'_>,
    actor: &impl NativeChatActor,
    organization_id: &str,
    lock_rows: bool,
) -> Result<()> {
    let local_implicit = actor.actor().kind == "user"
        && actor.actor().id == "local-board"
        && actor.session_id() == "local-implicit";
    authorize_identity_org(
        tx,
        &actor.actor().kind,
        &actor.actor().id,
        organization_id,
        local_implicit,
        lock_rows,
    )
    .await
}

pub(super) async fn preauthorize_execution_org(
    tx: &mut Tx<'_>,
    actor: &impl NativeChatExecutionActor,
    organization_id: &str,
    fence: &ExecutionFence,
) -> Result<()> {
    authorize_execution_identity(tx, actor, organization_id, fence, false).await
}

pub(super) async fn authorize_execution_org(
    tx: &mut Tx<'_>,
    actor: &impl NativeChatExecutionActor,
    organization_id: &str,
    fence: &ExecutionFence,
) -> Result<()> {
    authorize_execution_identity(tx, actor, organization_id, fence, true).await
}

async fn authorize_execution_identity(
    tx: &mut Tx<'_>,
    actor: &impl NativeChatExecutionActor,
    organization_id: &str,
    fence: &ExecutionFence,
    lock_rows: bool,
) -> Result<()> {
    if actor.organization_id() != organization_id {
        return Err(http(403, "Organization access denied"));
    }
    if !actor.matches_execution_fence(fence) {
        return Err(http(
            409,
            "Native Chat execution capability does not match its fence",
        ));
    }
    if actor.requires_user_record()
        && !authorize_execution_user_record(tx, &actor.actor().id, lock_rows).await?
    {
        return Err(http(403, "Organization access denied"));
    }
    authorize_identity_org(
        tx,
        &actor.actor().kind,
        &actor.actor().id,
        organization_id,
        actor.is_local_implicit(),
        lock_rows,
    )
    .await
}

async fn authorize_execution_user_record(
    tx: &mut Tx<'_>,
    user_id: &str,
    lock_row: bool,
) -> Result<bool> {
    if lock_row {
        let user = sqlx::query_scalar::<_, i32>(
            "/* native_chat_execution_user_lock */
             SELECT 1 FROM \"user\" WHERE id=$1 FOR SHARE",
        )
        .bind(user_id)
        .fetch_optional(&mut **tx)
        .await?;
        Ok(user.is_some())
    } else {
        let exists =
            sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM \"user\" WHERE id=$1)")
                .bind(user_id)
                .fetch_one(&mut **tx)
                .await?;
        Ok(exists)
    }
}

async fn authorize_identity_org(
    tx: &mut Tx<'_>,
    actor_kind: &str,
    actor_id: &str,
    organization_id: &str,
    local_implicit: bool,
    lock_rows: bool,
) -> Result<()> {
    if local_implicit {
        return Ok(());
    }
    let allowed = match actor_kind {
        "user" => {
            if lock_rows {
                authorize_user_membership_locked(tx, organization_id, actor_id).await?
            } else {
                authorize_user_membership(tx, organization_id, actor_id).await?
            }
        }
        "agent" => {
            let agent_id = canonical_uuid(actor_id, "agent actor id")
                .map_err(|_| http(401, "Agent authentication required"))?;
            if lock_rows {
                let status = sqlx::query_scalar::<_, String>(
                    "/* native_chat_execution_agent_lock */
                     SELECT status FROM agents
                     WHERE org_id=$1::uuid AND id=$2::uuid
                     FOR SHARE",
                )
                .bind(organization_id)
                .bind(agent_id)
                .fetch_optional(&mut **tx)
                .await?;
                status
                    .as_deref()
                    .is_some_and(|status| !matches!(status, "terminated" | "pending_approval"))
            } else {
                sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS(
                       SELECT 1 FROM agents
                       WHERE org_id=$1::uuid AND id=$2::uuid
                         AND status NOT IN ('terminated','pending_approval')
                     )",
                )
                .bind(organization_id)
                .bind(agent_id)
                .fetch_one(&mut **tx)
                .await?
            }
        }
        _ => return Err(http(401, "Unauthorized")),
    };
    if allowed {
        Ok(())
    } else {
        Err(http(403, "Organization access denied"))
    }
}

async fn authorize_browser_principal_org(
    tx: &mut Tx<'_>,
    actor: &impl NativeChatActor,
    credential: &crate::native_chat::BrowserCredentialBinding,
    organization_id: &str,
    lock_rows: bool,
) -> Result<()> {
    if actor.actor().kind != "user" {
        return Err(http(401, "Unauthorized"));
    }
    match credential.kind() {
        BrowserCredentialKind::LocalImplicit => {
            if actor.actor().id == "local-board" && actor.session_id() == "local-implicit" {
                Ok(())
            } else {
                Err(http(401, "Unauthorized"))
            }
        }
        BrowserCredentialKind::Session => {
            let row_id = credential
                .row_id()
                .ok_or_else(|| http(401, "Unauthorized"))?;
            if row_id != actor.session_id() {
                return Err(http(401, "Unauthorized"));
            }
            // The joined user row is part of the identity check; only the
            // post-target path locks it with the session row. Do not retain
            // this raw token beyond the transaction-local comparison below.
            let token = if lock_rows {
                sqlx::query_scalar::<_, String>(
                    "/* native_chat_browser_session_lock */
                     SELECT s.token FROM session s
                     JOIN \"user\" u ON u.id=s.user_id
                     WHERE s.id=$1 AND s.user_id=$2
                     FOR SHARE OF s,u",
                )
                .bind(row_id)
                .bind(&actor.actor().id)
                .fetch_optional(&mut **tx)
                .await?
            } else {
                sqlx::query_scalar::<_, String>(
                    "/* native_chat_browser_session_precheck */
                     SELECT s.token FROM session s
                     JOIN \"user\" u ON u.id=s.user_id
                     WHERE s.id=$1 AND s.user_id=$2",
                )
                .bind(row_id)
                .bind(&actor.actor().id)
                .fetch_optional(&mut **tx)
                .await?
            }
            .ok_or_else(|| http(401, "Unauthorized"))?;
            // Browser auth rejects ambiguous token reuse. The legacy session
            // table has no uniqueness constraint, so this only rejects
            // duplicates visible to this statement; it cannot promise global
            // uniqueness through commit. The proof remains bound to this exact
            // row, user, and token fingerprint.
            let matches =
                sqlx::query_scalar::<_, i64>("SELECT count(*)::bigint FROM session WHERE token=$1")
                    .bind(&token)
                    .fetch_one(&mut **tx)
                    .await?;
            if matches != 1 || !matches_token_fingerprint(&token, credential.fingerprint()) {
                return Err(http(401, "Unauthorized"));
            }
            let member = if lock_rows {
                authorize_user_membership_locked(tx, organization_id, &actor.actor().id).await?
            } else {
                authorize_user_membership(tx, organization_id, &actor.actor().id).await?
            };
            // This is deliberately a separate statement after FOR SHARE returns
            // and after membership lookup. A credential query or membership scan
            // may wait; transaction-start `now()` would be stale after that wait.
            let live = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(
                   SELECT 1 FROM session
                   WHERE id=$1 AND user_id=$2 AND token=$3
                     AND expires_at > clock_timestamp()
                 )",
            )
            .bind(row_id)
            .bind(&actor.actor().id)
            .bind(&token)
            .fetch_one(&mut **tx)
            .await?;
            if !live {
                return Err(http(401, "Unauthorized"));
            }
            if member {
                Ok(())
            } else {
                Err(http(403, "Organization access denied"))
            }
        }
        BrowserCredentialKind::BoardKey => {
            let row_id = credential
                .row_id()
                .ok_or_else(|| http(401, "Unauthorized"))?;
            let key_id =
                canonical_uuid(row_id, "board key id").map_err(|_| http(401, "Unauthorized"))?;
            if actor.session_id() != format!("board-key:{key_id}") {
                return Err(http(401, "Unauthorized"));
            }
            // The post-target path locks the key and user together. A deleted
            // user or key cannot be treated as a live browser principal.
            let key_hash = if lock_rows {
                sqlx::query_scalar::<_, String>(
                    "/* native_chat_browser_board_key_lock */
                     SELECT k.key_hash FROM board_api_keys k
                     JOIN \"user\" u ON u.id=k.user_id
                     WHERE k.id=$1::uuid AND k.user_id=$2
                     FOR SHARE OF k,u",
                )
                .bind(&key_id)
                .bind(&actor.actor().id)
                .fetch_optional(&mut **tx)
                .await?
            } else {
                sqlx::query_scalar::<_, String>(
                    "/* native_chat_browser_board_key_precheck */
                     SELECT k.key_hash FROM board_api_keys k
                     JOIN \"user\" u ON u.id=k.user_id
                     WHERE k.id=$1::uuid AND k.user_id=$2",
                )
                .bind(&key_id)
                .bind(&actor.actor().id)
                .fetch_optional(&mut **tx)
                .await?
            }
            .ok_or_else(|| http(401, "Unauthorized"))?;
            if !matches_hex_fingerprint(&key_hash, credential.fingerprint()) {
                return Err(http(401, "Unauthorized"));
            }
            let member = if lock_rows {
                authorize_user_membership_locked(tx, organization_id, &actor.actor().id).await?
            } else {
                authorize_user_membership(tx, organization_id, &actor.actor().id).await?
            };
            // Evaluate expiry/revocation with a fresh wall clock after the row
            // lock and membership lookup. This remains the final auth query
            // immediately before D1 commits a browser-authorized mutation.
            let live = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(
                   SELECT 1 FROM board_api_keys
                   WHERE id=$1::uuid AND user_id=$2 AND revoked_at IS NULL
                     AND (expires_at IS NULL OR expires_at > clock_timestamp())
                 )",
            )
            .bind(&key_id)
            .bind(&actor.actor().id)
            .fetch_one(&mut **tx)
            .await?;
            if !live {
                return Err(http(401, "Unauthorized"));
            }
            if member {
                Ok(())
            } else {
                Err(http(403, "Organization access denied"))
            }
        }
    }
}

fn matches_hex_fingerprint(value: &str, expected: Option<&[u8; 32]>) -> bool {
    let Some(expected) = expected else {
        return false;
    };
    let Some(actual) = decode_sha256_hex(value) else {
        return false;
    };
    actual == *expected
}

fn decode_sha256_hex(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let mut digest = [0u8; 32];
    for (index, pair) in value.as_bytes().as_chunks::<2>().0.iter().enumerate() {
        let high = (pair[0] as char).to_digit(16)? as u8;
        let low = (pair[1] as char).to_digit(16)? as u8;
        digest[index] = (high << 4) | low;
    }
    Some(digest)
}

fn matches_token_fingerprint(token: &str, expected: Option<&[u8; 32]>) -> bool {
    let Some(expected) = expected else {
        return false;
    };
    let actual = Sha256::digest(token.as_bytes());
    actual.as_slice() == &expected[..]
}

async fn authorize_user_membership(
    tx: &mut Tx<'_>,
    organization_id: &str,
    user_id: &str,
) -> Result<bool> {
    let allowed = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
           SELECT 1 FROM organization_memberships
           WHERE org_id=$1::uuid AND principal_type='user' AND principal_id=$2 AND status='active'
         ) OR EXISTS(
           SELECT 1 FROM instance_user_roles WHERE user_id=$2 AND role='instance_admin'
         )",
    )
    .bind(organization_id)
    .bind(user_id)
    .fetch_one(&mut **tx)
    .await?;
    Ok(allowed)
}

/// Lock the exact active grant used for this browser-authorized mutation. If
/// no organization membership exists, lock the instance-admin grant instead.
/// The D1 transaction holds this row lock through commit so revocation cannot
/// win after the post-target authorization check.
async fn authorize_user_membership_locked(
    tx: &mut Tx<'_>,
    organization_id: &str,
    user_id: &str,
) -> Result<bool> {
    let membership = sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM organization_memberships
         WHERE org_id=$1::uuid AND principal_type='user' AND principal_id=$2 AND status='active'
         LIMIT 1 FOR SHARE",
    )
    .bind(organization_id)
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?;
    if membership.is_some() {
        return Ok(true);
    }
    let admin = sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM instance_user_roles
         WHERE user_id=$1 AND role='instance_admin'
         LIMIT 1 FOR SHARE",
    )
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(admin.is_some())
}

pub(super) fn authorize_conversation(
    actor: &impl NativeChatActor,
    organization_id: &str,
    conversation: &Conversation,
    selected_agent_id: Option<&str>,
) -> Result<String> {
    let local_implicit = actor.actor().kind == "user"
        && actor.actor().id == "local-board"
        && actor.session_id() == "local-implicit";
    authorize_conversation_identity(
        &actor.actor().kind,
        &actor.actor().id,
        local_implicit,
        organization_id,
        conversation,
        selected_agent_id,
    )
}

pub(super) fn authorize_execution_conversation(
    actor: &impl NativeChatExecutionActor,
    organization_id: &str,
    conversation: &Conversation,
    selected_agent_id: Option<&str>,
) -> Result<String> {
    authorize_conversation_identity(
        &actor.actor().kind,
        &actor.actor().id,
        actor.is_local_implicit(),
        organization_id,
        conversation,
        selected_agent_id,
    )
}

fn authorize_conversation_identity(
    actor_kind: &str,
    actor_id: &str,
    local_implicit: bool,
    organization_id: &str,
    conversation: &Conversation,
    selected_agent_id: Option<&str>,
) -> Result<String> {
    let owner = conversation
        .owner_user_id
        .as_deref()
        .filter(|value| !value.is_empty());
    let principal_scope_ref = if conversation.kind == "side_chat" {
        let owner = owner.ok_or_else(|| http(404, "Chat conversation not found"))?;
        format!("user:{owner}")
    } else {
        format!("org:{organization_id}")
    };
    match actor_kind {
        "user" => {
            if conversation.kind == "side_chat" && owner != Some(actor_id) {
                return Err(http(404, "Chat conversation not found"));
            }
            if actor_id == "local-board" && !local_implicit {
                return Err(http(403, "Chat conversation access denied"));
            }
        }
        "agent" => {
            if conversation.kind == "side_chat" || selected_agent_id != Some(actor_id) {
                return Err(http(403, "Chat conversation access denied"));
            }
        }
        _ => return Err(http(401, "Unauthorized")),
    }
    Ok(principal_scope_ref)
}

pub(super) fn ensure_conversation_mutable(conversation: &Conversation) -> Result<()> {
    ensure_conversation_mutable_for_run(conversation, false)
}

pub(super) fn ensure_conversation_mutable_for_run(
    conversation: &Conversation,
    run_admitted_before_expiry: bool,
) -> Result<()> {
    if !matches!(conversation.kind.as_str(), "chat" | "side_chat") {
        return Err(http(404, "Chat conversation not found"));
    }
    if conversation.status != "active"
        || (conversation.kind == "side_chat"
            && !matches!(
                conversation.side_chat_state.as_deref(),
                Some("active" | "kept")
            ))
    {
        return Err(http(409, "Chat conversation is not active"));
    }
    if conversation.kind == "side_chat"
        && conversation.side_chat_state.as_deref() == Some("active")
        && conversation.side_chat_expired
        && !run_admitted_before_expiry
    {
        return Err(http(409, "Side Chat expired"));
    }
    Ok(())
}

pub(super) fn ensure_conversation_readable(conversation: &Conversation) -> Result<()> {
    if matches!(conversation.kind.as_str(), "chat" | "side_chat") {
        Ok(())
    } else {
        Err(http(404, "Chat conversation not found"))
    }
}

pub(super) async fn conversation(
    tx: &mut Tx<'_>,
    organization_id: &str,
    conversation_id: &str,
    lock: bool,
) -> Result<Option<Conversation>> {
    let suffix = if lock { " FOR UPDATE" } else { "" };
    let query = format!(
        "SELECT status, conversation_kind, side_chat_state, created_by_user_id,
                (side_chat_expires_at IS NULL OR side_chat_expires_at <= clock_timestamp()) AS side_chat_expired,
                preferred_agent_id::text AS preferred_agent_id,
                routed_agent_id::text AS routed_agent_id
         FROM chat_conversations
         WHERE org_id=$1::uuid AND id=$2::uuid{suffix}"
    );
    let Some(row) = sqlx::query(&query)
        .bind(organization_id)
        .bind(conversation_id)
        .fetch_optional(&mut **tx)
        .await?
    else {
        return Ok(None);
    };
    Ok(Some(Conversation {
        status: row.try_get("status")?,
        kind: row.try_get("conversation_kind")?,
        side_chat_state: row.try_get("side_chat_state")?,
        side_chat_expired: row.try_get("side_chat_expired")?,
        owner_user_id: row.try_get("created_by_user_id")?,
        preferred_agent_id: row.try_get("preferred_agent_id")?,
        routed_agent_id: row.try_get("routed_agent_id")?,
    }))
}
