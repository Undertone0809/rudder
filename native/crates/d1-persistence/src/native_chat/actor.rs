//! Rust-only actor boundary for request-scoped Native Chat authorization.
//!
//! Browser principals carry only a credential row identity and a digest. They
//! are never accepted from JSON and are revalidated by D1 inside the operation
//! transaction. A claimed Native Chat worker receives a separate move-only
//! execution principal; other existing worker APIs continue to take
//! `VerifiedActor`.

use super::execution::ExecutionFence;
use rudder_auth_core::{ActorIdentity, VerifiedActor};
use uuid::Uuid;

mod sealed {
    pub trait Sealed {}
    pub trait ExecutionSealed {}

    impl Sealed for rudder_auth_core::VerifiedActor {}
    impl Sealed for super::BrowserPrincipal {}
    impl Sealed for crate::native_chat::automation::AutomationChatActor {}
    impl ExecutionSealed for rudder_auth_core::VerifiedActor {}
    impl ExecutionSealed for super::NativeChatExecutionPrincipal {}
}

/// Actor values accepted by Native Chat and its transaction-scoped binding
/// helpers. This trait is sealed so a request DTO cannot implement its own
/// authorization identity.
#[allow(private_bounds)]
pub trait NativeChatActor: sealed::Sealed {
    fn actor(&self) -> &ActorIdentity;
    fn organization_id(&self) -> &str;
    fn session_id(&self) -> &str;

    /// Present only for a Foundation-authenticated browser request. D1 must
    /// revalidate this evidence against the live credential row in its own
    /// transaction before granting organization access.
    fn browser_credential(&self) -> Option<&BrowserCredentialBinding> {
        None
    }
}

/// Actor authority for already-claimed execution continuations. This is a
/// separate sealed boundary from request admission and public Chat reads.
/// BrowserPrincipal deliberately does not implement it.
#[allow(private_bounds)]
pub trait NativeChatExecutionActor: sealed::ExecutionSealed {
    fn actor(&self) -> &ActorIdentity;
    fn organization_id(&self) -> &str;
    fn is_local_implicit(&self) -> bool;
    /// Whether continuation authorization must prove the backing user row is
    /// still present. Request-scoped compatibility actors do not carry that
    /// persisted-identity contract; claimed browser user principals do.
    fn requires_user_record(&self) -> bool;
    fn matches_execution_fence(&self, fence: &ExecutionFence) -> bool;
}

impl NativeChatActor for VerifiedActor {
    fn actor(&self) -> &ActorIdentity {
        VerifiedActor::actor(self)
    }

    fn organization_id(&self) -> &str {
        VerifiedActor::organization_id(self)
    }

    fn session_id(&self) -> &str {
        VerifiedActor::session_id(self)
    }
}

impl NativeChatExecutionActor for VerifiedActor {
    fn actor(&self) -> &ActorIdentity {
        VerifiedActor::actor(self)
    }

    fn organization_id(&self) -> &str {
        VerifiedActor::organization_id(self)
    }

    fn is_local_implicit(&self) -> bool {
        let identity = VerifiedActor::actor(self);
        identity.kind == "user"
            && identity.id == "local-board"
            && VerifiedActor::session_id(self) == "local-implicit"
    }

    fn requires_user_record(&self) -> bool {
        false
    }

    // Compatibility for existing trusted server callers. Browser requests
    // cannot construct a VerifiedActor and new workers use the claim principal.
    fn matches_execution_fence(&self, _fence: &ExecutionFence) -> bool {
        true
    }
}

/// Move-only execution authority minted only by a successful D1 first claim.
/// It is bound to the complete owner fence and contains no browser credential.
/// It deliberately has no Clone, Debug, Serialize, or Deserialize impl.
pub struct NativeChatExecutionPrincipal {
    actor: ActorIdentity,
    organization_id: String,
    local_implicit: bool,
    fence: ExecutionFence,
}

impl NativeChatExecutionPrincipal {
    pub(crate) fn from_claim(actor: &impl NativeChatActor, fence: ExecutionFence) -> Option<Self> {
        let identity = fence.identity();
        if actor.organization_id() != identity.organization_id
            || !matches!(actor.actor().kind.as_str(), "user" | "agent")
        {
            return None;
        }
        let local_implicit = actor.actor().kind == "user"
            && actor.actor().id == "local-board"
            && actor.session_id() == "local-implicit"
            && actor
                .browser_credential()
                .is_none_or(|credential| credential.kind() == BrowserCredentialKind::LocalImplicit);
        if actor.actor().kind == "user" && actor.actor().id == "local-board" && !local_implicit {
            return None;
        }
        Some(Self {
            actor: actor.actor().clone(),
            organization_id: actor.organization_id().to_owned(),
            local_implicit,
            fence,
        })
    }
}

impl NativeChatExecutionActor for NativeChatExecutionPrincipal {
    fn actor(&self) -> &ActorIdentity {
        &self.actor
    }

    fn organization_id(&self) -> &str {
        &self.organization_id
    }

    fn is_local_implicit(&self) -> bool {
        self.local_implicit
    }

    fn requires_user_record(&self) -> bool {
        self.actor.kind == "user" && !self.local_implicit
    }

    fn matches_execution_fence(&self, fence: &ExecutionFence) -> bool {
        self.fence.eq(fence)
    }
}

/// Credential proof copied from a Foundation-authenticated BrowserActor.
/// Fields stay private and this type deliberately has no serde or Debug impl.
pub struct BrowserCredentialBinding {
    kind: BrowserCredentialKind,
    row_id: Option<String>,
    fingerprint: Option<[u8; 32]>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum BrowserCredentialKind {
    Session,
    BoardKey,
    LocalImplicit,
}

impl BrowserCredentialBinding {
    /// Bind a Better Auth session row to the SHA-256 digest of the exact cookie
    /// token whose signature Foundation verified. The raw token is not retained.
    pub fn session(row_id: impl Into<String>, token_fingerprint: [u8; 32]) -> Self {
        Self {
            kind: BrowserCredentialKind::Session,
            row_id: Some(row_id.into()),
            fingerprint: Some(token_fingerprint),
        }
    }

    /// Bind a board API-key row to the persisted SHA-256 token digest.
    pub fn board_key(row_id: impl Into<String>, key_fingerprint: [u8; 32]) -> Self {
        Self {
            kind: BrowserCredentialKind::BoardKey,
            row_id: Some(row_id.into()),
            fingerprint: Some(key_fingerprint),
        }
    }

    /// Marker used only after validated local-implicit browser configuration.
    pub fn local_implicit() -> Self {
        Self {
            kind: BrowserCredentialKind::LocalImplicit,
            row_id: None,
            fingerprint: None,
        }
    }

    pub(crate) fn kind(&self) -> BrowserCredentialKind {
        self.kind
    }

    pub(crate) fn row_id(&self) -> Option<&str> {
        self.row_id.as_deref()
    }

    pub(crate) fn fingerprint(&self) -> Option<&[u8; 32]> {
        self.fingerprint.as_ref()
    }
}

/// Non-serializable browser identity bound to one organization and one current
/// credential. The constructor is Rust-only; the browser request must first
/// pass Foundation cookie-signature / bearer-key authentication. D1 treats all
/// fields as hints and independently revalidates the credential and user row.
pub struct BrowserPrincipal {
    actor: ActorIdentity,
    organization_id: String,
    session_id: String,
    credential: BrowserCredentialBinding,
}

#[derive(Debug, thiserror::Error)]
#[error("invalid authenticated browser principal")]
pub struct BrowserPrincipalError;

impl BrowserPrincipal {
    /// Construct an adapter from trusted Rust browser-auth state. Do not call
    /// this with values deserialized from an HTTP request.
    pub fn from_trusted_browser_auth(
        user_id: &str,
        organization_id: &str,
        session_id: &str,
        credential: BrowserCredentialBinding,
    ) -> Result<Self, BrowserPrincipalError> {
        let user_id = ActorIdentity::new("user", user_id).map_err(|_| BrowserPrincipalError)?;
        let organization_id = Uuid::parse_str(organization_id)
            .map_err(|_| BrowserPrincipalError)?
            .to_string();
        if !valid_ref(session_id) {
            return Err(BrowserPrincipalError);
        }
        match credential.kind {
            BrowserCredentialKind::Session => {
                let row_id = credential.row_id.as_deref().ok_or(BrowserPrincipalError)?;
                if row_id != session_id || credential.fingerprint.is_none() {
                    return Err(BrowserPrincipalError);
                }
            }
            BrowserCredentialKind::BoardKey => {
                let row_id = credential.row_id.as_deref().ok_or(BrowserPrincipalError)?;
                let canonical_id = Uuid::parse_str(row_id)
                    .map_err(|_| BrowserPrincipalError)?
                    .to_string();
                if canonical_id != row_id
                    || session_id != format!("board-key:{row_id}")
                    || credential.fingerprint.is_none()
                {
                    return Err(BrowserPrincipalError);
                }
            }
            BrowserCredentialKind::LocalImplicit => {
                if user_id.id != "local-board"
                    || session_id != "local-implicit"
                    || credential.row_id.is_some()
                    || credential.fingerprint.is_some()
                {
                    return Err(BrowserPrincipalError);
                }
            }
        }
        Ok(Self {
            actor: user_id,
            organization_id,
            session_id: session_id.to_owned(),
            credential,
        })
    }
}

impl NativeChatActor for BrowserPrincipal {
    fn actor(&self) -> &ActorIdentity {
        &self.actor
    }

    fn organization_id(&self) -> &str {
        &self.organization_id
    }

    fn session_id(&self) -> &str {
        &self.session_id
    }

    fn browser_credential(&self) -> Option<&BrowserCredentialBinding> {
        Some(&self.credential)
    }
}

fn valid_ref(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && !value.chars().any(char::is_control)
        && !value.trim().is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORG: &str = "10000000-0000-4000-8000-000000000001";

    #[test]
    fn browser_principal_is_bound_to_organization_and_credential_shape() {
        let session = BrowserPrincipal::from_trusted_browser_auth(
            "user-1",
            ORG,
            "session-row-1",
            BrowserCredentialBinding::session("session-row-1", [7; 32]),
        )
        .unwrap();
        assert_eq!(session.actor().kind, "user");
        assert_eq!(session.actor().id, "user-1");
        assert_eq!(session.organization_id(), ORG);
        assert_eq!(session.session_id(), "session-row-1");
        assert!(session.browser_credential().is_some());

        let key = "50000000-0000-4000-8000-000000000001";
        let board_key = BrowserPrincipal::from_trusted_browser_auth(
            "user-1",
            ORG,
            &format!("board-key:{key}"),
            BrowserCredentialBinding::board_key(key, [9; 32]),
        )
        .unwrap();
        assert_eq!(board_key.session_id(), format!("board-key:{key}").as_str());

        let local = BrowserPrincipal::from_trusted_browser_auth(
            "local-board",
            ORG,
            "local-implicit",
            BrowserCredentialBinding::local_implicit(),
        )
        .unwrap();
        assert_eq!(local.actor().id, "local-board");
    }

    #[test]
    fn browser_principal_rejects_mismatched_or_unscoped_evidence() {
        assert!(
            BrowserPrincipal::from_trusted_browser_auth(
                "user-1",
                ORG,
                "different-session",
                BrowserCredentialBinding::session("session-row-1", [7; 32]),
            )
            .is_err()
        );
        assert!(
            BrowserPrincipal::from_trusted_browser_auth(
                "user-1",
                "not-an-org",
                "session-row-1",
                BrowserCredentialBinding::session("session-row-1", [7; 32]),
            )
            .is_err()
        );
        assert!(
            BrowserPrincipal::from_trusted_browser_auth(
                "user-1",
                ORG,
                "local-implicit",
                BrowserCredentialBinding::local_implicit(),
            )
            .is_err()
        );
    }
}
