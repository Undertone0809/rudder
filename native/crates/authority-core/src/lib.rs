//! Fail-closed authority and private legacy-bridge primitives for Rust cutover.
//!
//! This crate models the transaction boundary without opening a listener or
//! owning product routes. A caller supplies its route inventory and uses the
//! returned decision to dispatch to the one current writer. Epochs and fencing
//! tokens make an old writer unusable after a handoff; bridge envelopes bind
//! every request value that crosses to a private legacy process.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;

pub const AUTHORITY_PROTOCOL_VERSION: u16 = 1;
pub const AUTHORITY_SCHEMA: &str = "rudder.migration.authority.v1";
pub const LEGACY_BRIDGE_SCHEMA: &str = "rudder.migration.legacy-bridge.v1";
pub const RUST_OWNER: &str = "rust";
pub const LEGACY_OWNER: &str = "legacy";

const MAX_IDENTIFIER_BYTES: usize = 256;
const FENCING_TOKEN_BYTES: usize = 64;

/// Errors returned by authority construction, handoff, and bridge validation.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum AuthorityError {
    #[error("invalid {field}")]
    InvalidField { field: &'static str },
    #[error("unsupported authority protocol version {actual}; expected {expected}")]
    UnsupportedProtocolVersion { actual: u16, expected: u16 },
    #[error("unknown owner {owner}")]
    UnknownOwner { owner: OwnerId },
    #[error("unknown component {component}")]
    UnknownComponent { component: String },
    #[error("dual ownership at {scope}")]
    DualOwnership { scope: String },
    #[error("route {route} is bound to a different owner")]
    RouteOwnerMismatch { route: String },
    #[error("component {component} is bound to a different owner")]
    ComponentOwnerMismatch { component: String },
    #[error("route {route} is not registered")]
    UnknownRoute { route: String },
    #[error("stale epoch {provided}; current epoch is {current}")]
    StaleEpoch { provided: u64, current: u64 },
    #[error("future epoch {provided}; current epoch is {current}")]
    FutureEpoch { provided: u64, current: u64 },
    #[error("fencing token does not match the current authority")]
    FencingTokenMismatch,
    #[error("handoff must change the owner")]
    SameOwnerHandoff,
    #[error("authority epoch cannot increase further")]
    EpochOverflow,
    #[error("bridge envelope is not for the legacy owner")]
    WrongAuthorityOwner,
    #[error("bridge envelope component does not match the authority")]
    ComponentMismatch,
    #[error("bridge envelope component version does not match the authority")]
    ComponentVersionMismatch,
    #[error("bridge actor does not match the authenticated actor")]
    ActorMismatch,
    #[error("bridge organization does not match the request organization")]
    OrganizationMismatch,
    #[error("bridge action does not match the requested action")]
    ActionMismatch,
    #[error("bridge request id does not match the request")]
    RequestIdMismatch,
    #[error("bridge body hash does not match the request body")]
    BodyHashMismatch,
    #[error("bridge envelope has expired")]
    Expired,
    #[error("bridge nonce has already been used")]
    Replay,
}

/// An owner identity is deliberately opaque; only the two migration owners
/// are dispatchable by this crate.
#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct OwnerId(String);

impl OwnerId {
    pub fn new(value: impl Into<String>) -> Result<Self, AuthorityError> {
        let value = value.into();
        validate_text(&value, "owner")?;
        Ok(Self(value))
    }

    pub fn rust() -> Self {
        Self(RUST_OWNER.to_owned())
    }

    pub fn legacy() -> Self {
        Self(LEGACY_OWNER.to_owned())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn is_dispatchable(&self) -> bool {
        matches!(self.as_str(), RUST_OWNER | LEGACY_OWNER)
    }
}

impl AsRef<str> for OwnerId {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl std::fmt::Display for OwnerId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// A component authority is the persisted one-writer record for a component.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ComponentAuthority {
    pub protocol_version: u16,
    pub component: String,
    pub component_version: String,
    pub owner: OwnerId,
    pub epoch: u64,
    pub fencing_token: String,
}

impl ComponentAuthority {
    /// Build the first authority record for a component at epoch one.
    pub fn new(
        component: impl Into<String>,
        component_version: impl Into<String>,
        owner: OwnerId,
    ) -> Result<Self, AuthorityError> {
        Self::at_epoch(component, component_version, owner, 1)
    }

    /// Build an authority at an explicit epoch for loading persisted state.
    pub fn at_epoch(
        component: impl Into<String>,
        component_version: impl Into<String>,
        owner: OwnerId,
        epoch: u64,
    ) -> Result<Self, AuthorityError> {
        let component = component.into();
        let component_version = component_version.into();
        validate_text(&component, "component")?;
        validate_text(&component_version, "componentVersion")?;
        validate_owner(&owner)?;
        if epoch == 0 {
            return Err(AuthorityError::InvalidField { field: "epoch" });
        }
        let fencing_token = derive_fencing_token(&component, &component_version, &owner, epoch);
        Ok(Self {
            protocol_version: AUTHORITY_PROTOCOL_VERSION,
            component,
            component_version,
            owner,
            epoch,
            fencing_token,
        })
    }

    fn validate(&self) -> Result<(), AuthorityError> {
        if self.protocol_version != AUTHORITY_PROTOCOL_VERSION {
            return Err(AuthorityError::UnsupportedProtocolVersion {
                actual: self.protocol_version,
                expected: AUTHORITY_PROTOCOL_VERSION,
            });
        }
        validate_text(&self.component, "component")?;
        validate_text(&self.component_version, "componentVersion")?;
        validate_owner(&self.owner)?;
        if self.epoch == 0 {
            return Err(AuthorityError::InvalidField { field: "epoch" });
        }
        if self.fencing_token.len() != FENCING_TOKEN_BYTES
            || !self
                .fencing_token
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(AuthorityError::InvalidField {
                field: "fencingToken",
            });
        }
        Ok(())
    }
}

/// One route's declared owner. Duplicate route claims are rejected as dual
/// ownership rather than choosing an arbitrary declaration.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RouteClaim {
    pub route: String,
    pub component: String,
    pub owner: OwnerId,
}

impl RouteClaim {
    pub fn new(
        route: impl Into<String>,
        component: impl Into<String>,
        owner: OwnerId,
    ) -> Result<Self, AuthorityError> {
        let route = route.into();
        let component = component.into();
        validate_text(&route, "route")?;
        validate_text(&component, "component")?;
        validate_owner(&owner)?;
        Ok(Self {
            route,
            component,
            owner,
        })
    }

    fn validate(&self) -> Result<(), AuthorityError> {
        validate_text(&self.route, "route")?;
        validate_text(&self.component, "component")?;
        validate_owner(&self.owner)
    }
}

/// The route result is a decision only. It does not bind a socket or perform
/// a dispatch, so callers cannot accidentally create a second public listener.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum RouteDecision {
    Rust { authority: ComponentAuthority },
    PrivateLegacyBridge { authority: ComponentAuthority },
    Reject { reason: RouteRejection },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RouteRejection {
    UnknownRoute { route: String },
    UnknownComponent { component: String },
    UnknownOwner { owner: OwnerId },
    DualOwnership { scope: String },
    OwnerMismatch { route: String },
    InvalidAuthority { component: String },
    UnsupportedProtocolVersion { actual: u16 },
}

/// A serializable authority inventory and its route ownership declarations.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MigrationAuthority {
    pub protocol_version: u16,
    pub authorities: Vec<ComponentAuthority>,
    pub routes: Vec<RouteClaim>,
}

impl MigrationAuthority {
    pub fn from_parts(authorities: Vec<ComponentAuthority>, routes: Vec<RouteClaim>) -> Self {
        Self {
            protocol_version: AUTHORITY_PROTOCOL_VERSION,
            authorities,
            routes,
        }
    }

    pub fn validate(&self) -> Result<(), AuthorityError> {
        if self.protocol_version != AUTHORITY_PROTOCOL_VERSION {
            return Err(AuthorityError::UnsupportedProtocolVersion {
                actual: self.protocol_version,
                expected: AUTHORITY_PROTOCOL_VERSION,
            });
        }

        let mut components = BTreeMap::new();
        for authority in &self.authorities {
            authority.validate()?;
            if !authority.owner.is_dispatchable() {
                return Err(AuthorityError::UnknownOwner {
                    owner: authority.owner.clone(),
                });
            }
            if components
                .insert(authority.component.clone(), authority)
                .is_some()
            {
                return Err(AuthorityError::DualOwnership {
                    scope: format!("component:{}", authority.component),
                });
            }
        }

        let mut routes = BTreeSet::new();
        for claim in &self.routes {
            claim.validate()?;
            if !routes.insert(claim.route.clone()) {
                return Err(AuthorityError::DualOwnership {
                    scope: format!("route:{}", claim.route),
                });
            }
            if !claim.owner.is_dispatchable() {
                return Err(AuthorityError::UnknownOwner {
                    owner: claim.owner.clone(),
                });
            }
            let Some(authority) = components.get(&claim.component) else {
                return Err(AuthorityError::UnknownComponent {
                    component: claim.component.clone(),
                });
            };
            if authority.owner != claim.owner {
                return Err(AuthorityError::RouteOwnerMismatch {
                    route: claim.route.clone(),
                });
            }
        }
        Ok(())
    }

    /// Return a route decision, rejecting the entire malformed inventory.
    pub fn route_decision(&self, route: &str) -> RouteDecision {
        if let Err(error) = self.validate() {
            return RouteDecision::Reject {
                reason: route_rejection(error),
            };
        }
        let Some(claim) = self.routes.iter().find(|claim| claim.route == route) else {
            return RouteDecision::Reject {
                reason: RouteRejection::UnknownRoute {
                    route: route.to_owned(),
                },
            };
        };
        let Some(authority) = self
            .authorities
            .iter()
            .find(|authority| authority.component == claim.component)
        else {
            return RouteDecision::Reject {
                reason: RouteRejection::UnknownComponent {
                    component: claim.component.clone(),
                },
            };
        };
        match authority.owner.as_str() {
            RUST_OWNER => RouteDecision::Rust {
                authority: authority.clone(),
            },
            LEGACY_OWNER => RouteDecision::PrivateLegacyBridge {
                authority: authority.clone(),
            },
            _ => RouteDecision::Reject {
                reason: RouteRejection::UnknownOwner {
                    owner: authority.owner.clone(),
                },
            },
        }
    }

    pub fn current_authority(&self, component: &str) -> Option<&ComponentAuthority> {
        let mut matches = self
            .authorities
            .iter()
            .filter(|authority| authority.component == component);
        let authority = matches.next()?;
        if matches.next().is_some() {
            None
        } else {
            Some(authority)
        }
    }

    /// Atomically advance one component's epoch and update every route bound
    /// to it. Validation happens on a cloned candidate before it replaces the
    /// current state, so a rejected stale writer cannot partially cut over.
    pub fn handoff(
        &mut self,
        request: HandoffRequest,
    ) -> Result<ComponentAuthority, AuthorityError> {
        self.validate()?;
        validate_text(&request.component, "component")?;
        validate_text(&request.to_component_version, "componentVersion")?;
        validate_owner(&request.from_owner)?;
        validate_owner(&request.to_owner)?;
        if !request.to_owner.is_dispatchable() {
            return Err(AuthorityError::UnknownOwner {
                owner: request.to_owner,
            });
        }

        let index = self
            .authorities
            .iter()
            .position(|authority| authority.component == request.component)
            .ok_or_else(|| AuthorityError::UnknownComponent {
                component: request.component.clone(),
            })?;
        let current = &self.authorities[index];
        if request.from_epoch < current.epoch {
            return Err(AuthorityError::StaleEpoch {
                provided: request.from_epoch,
                current: current.epoch,
            });
        }
        if request.from_epoch > current.epoch {
            return Err(AuthorityError::FutureEpoch {
                provided: request.from_epoch,
                current: current.epoch,
            });
        }
        if request.from_owner != current.owner {
            return Err(AuthorityError::ComponentOwnerMismatch {
                component: request.component,
            });
        }
        if request.from_fencing_token != current.fencing_token {
            return Err(AuthorityError::FencingTokenMismatch);
        }
        if request.to_owner == current.owner {
            return Err(AuthorityError::SameOwnerHandoff);
        }
        let next_epoch = current
            .epoch
            .checked_add(1)
            .ok_or(AuthorityError::EpochOverflow)?;
        let next = ComponentAuthority::at_epoch(
            current.component.clone(),
            request.to_component_version,
            request.to_owner,
            next_epoch,
        )?;

        let mut candidate = self.clone();
        candidate.authorities[index] = next.clone();
        for claim in &mut candidate.routes {
            if claim.component == current.component {
                if claim.owner != current.owner {
                    return Err(AuthorityError::DualOwnership {
                        scope: format!("route:{}", claim.route),
                    });
                }
                claim.owner = next.owner.clone();
            }
        }
        candidate.validate()?;
        *self = candidate;
        Ok(next)
    }
}

/// A request to replace the current writer for one component.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HandoffRequest {
    pub component: String,
    pub from_owner: OwnerId,
    pub from_epoch: u64,
    pub from_fencing_token: String,
    pub to_owner: OwnerId,
    pub to_component_version: String,
}

impl HandoffRequest {
    pub fn new(
        component: impl Into<String>,
        from_owner: OwnerId,
        from_epoch: u64,
        from_fencing_token: impl Into<String>,
        to_owner: OwnerId,
        to_component_version: impl Into<String>,
    ) -> Self {
        Self {
            component: component.into(),
            from_owner,
            from_epoch,
            from_fencing_token: from_fencing_token.into(),
            to_owner,
            to_component_version: to_component_version.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ActorIdentity {
    pub kind: String,
    pub id: String,
}

impl ActorIdentity {
    pub fn new(kind: impl Into<String>, id: impl Into<String>) -> Result<Self, AuthorityError> {
        let kind = kind.into();
        let id = id.into();
        validate_text(&kind, "actorKind")?;
        validate_text(&id, "actorId")?;
        Ok(Self { kind, id })
    }

    fn validate(&self) -> Result<(), AuthorityError> {
        validate_text(&self.kind, "actorKind")?;
        validate_text(&self.id, "actorId")
    }
}

/// A private legacy request envelope. It contains no credential; its fence is
/// only useful when compared with the current authority record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LegacyBridgeRequestEnvelope {
    pub schema: String,
    pub protocol_version: u16,
    pub component: String,
    pub component_version: String,
    pub authority_epoch: u64,
    pub fencing_token: String,
    pub actor: ActorIdentity,
    pub organization_id: String,
    pub action: String,
    pub body_sha256: String,
    pub request_id: String,
    pub nonce: String,
    pub expires_at: u64,
}

impl LegacyBridgeRequestEnvelope {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        authority: &ComponentAuthority,
        actor: ActorIdentity,
        organization_id: impl Into<String>,
        action: impl Into<String>,
        body: &[u8],
        request_id: impl Into<String>,
        nonce: impl Into<String>,
        expires_at: u64,
    ) -> Result<Self, AuthorityError> {
        authority.validate()?;
        if authority.owner != OwnerId::legacy() {
            return Err(AuthorityError::WrongAuthorityOwner);
        }
        actor.validate()?;
        let organization_id = organization_id.into();
        let action = action.into();
        let request_id = request_id.into();
        let nonce = nonce.into();
        validate_text(&organization_id, "organizationId")?;
        validate_text(&action, "action")?;
        validate_text(&request_id, "requestId")?;
        validate_text(&nonce, "nonce")?;
        if expires_at == 0 {
            return Err(AuthorityError::InvalidField { field: "expiresAt" });
        }
        Ok(Self {
            schema: LEGACY_BRIDGE_SCHEMA.to_owned(),
            protocol_version: AUTHORITY_PROTOCOL_VERSION,
            component: authority.component.clone(),
            component_version: authority.component_version.clone(),
            authority_epoch: authority.epoch,
            fencing_token: authority.fencing_token.clone(),
            actor,
            organization_id,
            action,
            body_sha256: body_sha256(body),
            request_id,
            nonce,
            expires_at,
        })
    }

    /// Validate all request bindings before atomically consuming the nonce.
    #[allow(clippy::too_many_arguments)]
    pub fn validate(
        &self,
        authority: &ComponentAuthority,
        actor: &ActorIdentity,
        organization_id: &str,
        action: &str,
        body: &[u8],
        request_id: &str,
        now: u64,
        replay: &mut NonceReplayGuard,
    ) -> Result<(), AuthorityError> {
        authority.validate()?;
        if self.schema != LEGACY_BRIDGE_SCHEMA {
            return Err(AuthorityError::InvalidField { field: "schema" });
        }
        if self.protocol_version != AUTHORITY_PROTOCOL_VERSION {
            return Err(AuthorityError::UnsupportedProtocolVersion {
                actual: self.protocol_version,
                expected: AUTHORITY_PROTOCOL_VERSION,
            });
        }
        if self.component != authority.component {
            return Err(AuthorityError::ComponentMismatch);
        }
        if self.authority_epoch < authority.epoch {
            return Err(AuthorityError::StaleEpoch {
                provided: self.authority_epoch,
                current: authority.epoch,
            });
        }
        if self.authority_epoch > authority.epoch {
            return Err(AuthorityError::FutureEpoch {
                provided: self.authority_epoch,
                current: authority.epoch,
            });
        }
        if self.fencing_token != authority.fencing_token {
            return Err(AuthorityError::FencingTokenMismatch);
        }
        if authority.owner != OwnerId::legacy() {
            return Err(AuthorityError::WrongAuthorityOwner);
        }
        if self.component_version != authority.component_version {
            return Err(AuthorityError::ComponentVersionMismatch);
        }
        actor.validate()?;
        if &self.actor != actor {
            return Err(AuthorityError::ActorMismatch);
        }
        if self.organization_id != organization_id {
            return Err(AuthorityError::OrganizationMismatch);
        }
        if self.action != action {
            return Err(AuthorityError::ActionMismatch);
        }
        if self.request_id != request_id {
            return Err(AuthorityError::RequestIdMismatch);
        }
        if self.expires_at == 0 || now >= self.expires_at {
            return Err(AuthorityError::Expired);
        }
        if self.body_sha256 != body_sha256(body) {
            return Err(AuthorityError::BodyHashMismatch);
        }
        if self.nonce.is_empty() {
            return Err(AuthorityError::InvalidField { field: "nonce" });
        }
        replay.claim(&self.nonce)
    }
}

/// Process-local single-use nonce storage for bridge envelopes. A production
/// bridge must provide an equivalent atomic durable/peer-local store; this
/// crate intentionally does not open that private transport.
#[derive(Clone, Debug, Default)]
pub struct NonceReplayGuard {
    used: BTreeSet<String>,
}

impl NonceReplayGuard {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.used.len()
    }

    pub fn is_empty(&self) -> bool {
        self.used.is_empty()
    }

    fn claim(&mut self, nonce: &str) -> Result<(), AuthorityError> {
        if !self.used.insert(nonce.to_owned()) {
            return Err(AuthorityError::Replay);
        }
        Ok(())
    }
}

pub fn body_sha256(body: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(body);
    format!("{:x}", hash.finalize())
}

pub fn hash_body(body: &[u8]) -> String {
    body_sha256(body)
}

fn derive_fencing_token(
    component: &str,
    component_version: &str,
    owner: &OwnerId,
    epoch: u64,
) -> String {
    let mut hash = Sha256::new();
    hash.update(AUTHORITY_SCHEMA.as_bytes());
    hash.update([0]);
    hash.update(component.as_bytes());
    hash.update([0]);
    hash.update(component_version.as_bytes());
    hash.update([0]);
    hash.update(owner.as_str().as_bytes());
    hash.update([0]);
    hash.update(epoch.to_be_bytes());
    format!("{:x}", hash.finalize())
}

fn validate_owner(owner: &OwnerId) -> Result<(), AuthorityError> {
    validate_text(owner.as_str(), "owner")
}

fn validate_text(value: &str, field: &'static str) -> Result<(), AuthorityError> {
    if value.is_empty()
        || value.len() > MAX_IDENTIFIER_BYTES
        || value
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_control())
    {
        return Err(AuthorityError::InvalidField { field });
    }
    Ok(())
}

fn route_rejection(error: AuthorityError) -> RouteRejection {
    match error {
        AuthorityError::UnsupportedProtocolVersion { actual, .. } => {
            RouteRejection::UnsupportedProtocolVersion { actual }
        }
        AuthorityError::UnknownOwner { owner } => RouteRejection::UnknownOwner { owner },
        AuthorityError::UnknownComponent { component } => {
            RouteRejection::UnknownComponent { component }
        }
        AuthorityError::DualOwnership { scope } => RouteRejection::DualOwnership { scope },
        AuthorityError::RouteOwnerMismatch { route } => RouteRejection::OwnerMismatch { route },
        AuthorityError::ComponentOwnerMismatch { component } => {
            RouteRejection::InvalidAuthority { component }
        }
        _ => RouteRejection::InvalidAuthority {
            component: "registry".to_owned(),
        },
    }
}
