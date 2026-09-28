//! Bounded, private Project↔Goal hierarchy link mutation contract core.
//!
//! This crate owns only deterministic validation and fenced state transitions.
//! A later SQLx adapter must bind the returned fingerprint, organization scope,
//! version and fence epoch in one transaction. It performs no I/O and is not a
//! public writer.

use hmac::{Hmac, Mac};
use rudder_auth_core::VerifiedActor;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;

/// Maximum UTF-8 byte length of an organization, actor, project, or goal id.
pub const MAX_IDENTIFIER_BYTES: usize = 256;
/// Maximum UTF-8 byte length of an idempotency key.
pub const MAX_IDEMPOTENCY_KEY_BYTES: usize = 256;
/// Maximum number of idempotency receipts retained by one link state.
pub const MAX_APPLIED_RECEIPTS: usize = 1024;
/// Maximum number of goals that may be attached to one project mutation.
pub const MAX_GOAL_SET_SIZE: usize = 1024;
/// Number of hexadecimal characters in a SHA-256 digest.
pub const SHA256_HEX_LENGTH: usize = 64;
/// Domain separator for deterministic Project-Goal link identifiers.
pub const LINK_IDENTIFIER_SCHEMA: &str = "rudder.project-goal-link.v1";
/// Domain separator for deterministic mutation fingerprints.
pub const FINGERPRINT_SCHEMA: &str = "rudder.project-goal-link-mutation.v3";
/// Domain separator for complete Project goal-set replacement fingerprints.
pub const GOAL_SET_FINGERPRINT_SCHEMA: &str = "rudder.project-goal-set-replacement.v1";
/// Domain separator for actor authorization bindings.
const ACTOR_BINDING_SCHEMA: &str = "rudder.project-goal-link-actor-binding.v1";
/// Domain separator for serialized link-state integrity bindings.
const STATE_INTEGRITY_SCHEMA: &str = "rudder.project-goal-link-state.v1";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Actor {
    Board {
        organization_id: String,
        principal_id: String,
    },
    CeoAgent {
        organization_id: String,
        principal_id: String,
    },
    Agent {
        organization_id: String,
        principal_id: String,
    },
}

impl Actor {
    fn organization_id(&self) -> &str {
        match self {
            Self::Board {
                organization_id, ..
            }
            | Self::CeoAgent {
                organization_id, ..
            }
            | Self::Agent {
                organization_id, ..
            } => organization_id,
        }
    }

    fn principal_id(&self) -> &str {
        match self {
            Self::Board { principal_id, .. }
            | Self::CeoAgent { principal_id, .. }
            | Self::Agent { principal_id, .. } => principal_id,
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Self::Board { .. } => "board",
            Self::CeoAgent { .. } => "ceo_agent",
            Self::Agent { .. } => "agent",
        }
    }

    fn can_mutate(&self) -> bool {
        matches!(self, Self::Board { .. } | Self::CeoAgent { .. })
    }
}

/// Untrusted actor identity plus an authority-issued proof.
///
/// The identity is intentionally still serde-compatible for transport. It is
/// not accepted by a mutation command until [`ActorAuthority::verify`] has
/// produced an opaque [`ValidatedActor`].
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorBinding {
    actor: Actor,
    proof: String,
}

/// HMAC authority used by the trusted adapter boundary to verify actor bindings.
///
/// Verification-only authority construction is public for a trusted adapter;
/// proof minting remains crate-private. An external consumer can verify a
/// binding with a provisioned secret, but cannot mint a privileged actor
/// binding through this crate's API.
#[derive(Debug)]
pub struct ActorAuthority {
    secret: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedActor {
    actor: Actor,
    proof: String,
}

/// Read-only identity view for a successfully HMAC-verified actor.
///
/// The proof remains private. Adapters only need the bound identity for scoped
/// SQL and activity attribution; they must use the command fingerprint for
/// idempotency and never mint or replace this actor through the view.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ActorView<'a> {
    actor: &'a Actor,
}

impl ActorView<'_> {
    pub fn organization_id(&self) -> &str {
        self.actor.organization_id()
    }

    pub fn principal_id(&self) -> &str {
        self.actor.principal_id()
    }

    pub fn kind(&self) -> &'static str {
        self.actor.kind()
    }
}

impl ValidatedActor {
    pub fn as_integration_view(&self) -> ActorView<'_> {
        ActorView { actor: &self.actor }
    }
}

impl ActorAuthority {
    /// Construct an authority for verification only.
    ///
    /// The secret must come from the trusted adapter's configured authority.
    /// This constructor intentionally exposes no public binding issuer; an
    /// external consumer can verify a binding and create a validated context,
    /// but cannot mint one through this crate's API.
    pub fn verification_only(secret: impl AsRef<[u8]>) -> Result<Self, LinkMutationError> {
        let secret = secret.as_ref();
        if secret.is_empty() {
            return Err(LinkMutationError::InvalidActorBinding);
        }
        Ok(Self {
            secret: secret.to_vec(),
        })
    }

    /// Issue a binding after the surrounding adapter has authenticated the
    /// actor. Verification is still required before a command can use it.
    #[allow(dead_code)]
    pub(crate) fn issue(&self, actor: Actor) -> Result<ActorBinding, LinkMutationError> {
        validate_actor_shape(&actor)?;
        let proof = self.proof(&actor)?;
        Ok(ActorBinding { actor, proof })
    }

    pub fn verify(&self, binding: &ActorBinding) -> Result<ValidatedActor, LinkMutationError> {
        validate_actor_shape(&binding.actor)?;
        let proof =
            decode_hex_digest(&binding.proof).ok_or(LinkMutationError::InvalidActorBinding)?;
        let mut mac = self.mac()?;
        mac.update(&canonical_actor_binding_bytes(&binding.actor));
        mac.verify_slice(&proof)
            .map_err(|_| LinkMutationError::InvalidActorBinding)?;
        Ok(ValidatedActor {
            actor: binding.actor.clone(),
            proof: binding.proof.clone(),
        })
    }

    #[allow(dead_code)]
    fn proof(&self, actor: &Actor) -> Result<String, LinkMutationError> {
        let mut mac = self.mac()?;
        mac.update(&canonical_actor_binding_bytes(actor));
        Ok(hex_digest(mac.finalize().into_bytes()))
    }

    fn mac(&self) -> Result<ActorBindingMac, LinkMutationError> {
        let mac = ActorBindingMac::new_from_slice(&self.secret)
            .map_err(|_| LinkMutationError::InvalidActorBinding)?;
        Ok(mac)
    }
}

type ActorBindingMac = Hmac<Sha256>;

/// Adapter-owned target existence and organization-boundary check.
pub trait TargetVerifier {
    fn target_exists_in_organization(
        &self,
        organization_id: &str,
        project_org_id: &str,
        goal_org_id: &str,
        project_id: &str,
        goal_id: &str,
    ) -> bool;
}

/// Adapter-owned validation for the complete Project goal-set target.
///
/// The verifier is intentionally synchronous and read-only. A SQLx adapter
/// must repeat this check while holding its PostgreSQL row locks before it
/// writes, so this context is an authorization/shape boundary rather than a
/// substitute for the transaction's target validation.
pub trait GoalSetTargetVerifier {
    fn goal_set_exists_in_organization(
        &self,
        organization_id: &str,
        project_id: &str,
        goal_ids: &[String],
    ) -> bool;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedGoalSetContext {
    actor: ValidatedActor,
    organization_id: String,
    project_id: String,
    goal_ids: Vec<String>,
    primary_goal_after: Option<String>,
}

impl ValidatedGoalSetContext {
    /// Validate the server-issued actor binding and the adapter's target
    /// snapshot before constructing a complete replacement command.
    pub fn from_target_snapshot(
        binding: &ActorBinding,
        authority: &ActorAuthority,
        target_verifier: &impl GoalSetTargetVerifier,
        organization_id: impl Into<String>,
        project_id: impl Into<String>,
        goal_ids: Vec<String>,
        primary_goal_after: Option<String>,
    ) -> Result<Self, LinkMutationError> {
        let organization_id = organization_id.into();
        let project_id = project_id.into();
        validate_identifier(&organization_id)?;
        validate_identifier(&project_id)?;
        validate_goal_set(&goal_ids, primary_goal_after.as_deref())?;

        let actor = authority.verify(binding)?;
        if actor.actor.organization_id() != organization_id || !actor.actor.can_mutate() {
            return Err(if actor.actor.organization_id() != organization_id {
                LinkMutationError::CrossOrganization
            } else {
                LinkMutationError::Unauthorized
            });
        }
        if !target_verifier.goal_set_exists_in_organization(
            &organization_id,
            &project_id,
            &goal_ids,
        ) {
            return Err(LinkMutationError::GoalSetTargetNotFound);
        }

        Ok(Self {
            actor,
            organization_id,
            project_id,
            goal_ids,
            primary_goal_after,
        })
    }

    /// Bind a complete goal-set command to an actor token that already passed
    /// the signed request-envelope boundary. The SQLx adapter must still
    /// repeat project/goal existence and organization checks in its write
    /// transaction; this method only creates the opaque command context.
    pub fn from_verified_actor(
        verified_actor: &VerifiedActor,
        target_verifier: &impl GoalSetTargetVerifier,
        organization_id: impl Into<String>,
        project_id: impl Into<String>,
        goal_ids: Vec<String>,
        primary_goal_after: Option<String>,
    ) -> Result<Self, LinkMutationError> {
        let organization_id = organization_id.into();
        let project_id = project_id.into();
        validate_identifier(&organization_id)?;
        validate_identifier(&project_id)?;
        validate_goal_set(&goal_ids, primary_goal_after.as_deref())?;
        if verified_actor.organization_id() != organization_id {
            return Err(LinkMutationError::CrossOrganization);
        }
        let actor = match verified_actor.actor().kind.as_str() {
            "user" => Actor::Board {
                organization_id: organization_id.clone(),
                principal_id: verified_actor.actor().id.clone(),
            },
            "agent" => Actor::CeoAgent {
                organization_id: organization_id.clone(),
                principal_id: verified_actor.actor().id.clone(),
            },
            _ => return Err(LinkMutationError::Unauthorized),
        };
        validate_actor_shape(&actor)?;
        if !target_verifier.goal_set_exists_in_organization(
            &organization_id,
            &project_id,
            &goal_ids,
        ) {
            return Err(LinkMutationError::GoalSetTargetNotFound);
        }

        Ok(Self {
            actor: ValidatedActor {
                actor,
                proof: verified_actor.signature().to_owned(),
            },
            organization_id,
            project_id,
            goal_ids,
            primary_goal_after,
        })
    }

    fn validate(&self) -> Result<(), LinkMutationError> {
        validate_actor_shape(&self.actor.actor)?;
        validate_identifier(&self.organization_id)?;
        validate_identifier(&self.project_id)?;
        validate_goal_set(&self.goal_ids, self.primary_goal_after.as_deref())?;
        if self.actor.actor.organization_id() != self.organization_id {
            return Err(LinkMutationError::CrossOrganization);
        }
        if !self.actor.actor.can_mutate() {
            return Err(LinkMutationError::Unauthorized);
        }
        Ok(())
    }

    /// Expose only the verified values consumed by a trusted persistence
    /// adapter. The view cannot be deserialized or constructed externally.
    pub fn as_integration_view(
        &self,
    ) -> Result<ValidatedGoalSetContextView<'_>, LinkMutationError> {
        self.validate()?;
        Ok(ValidatedGoalSetContextView { context: self })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ValidatedGoalSetContextView<'a> {
    context: &'a ValidatedGoalSetContext,
}

impl<'a> ValidatedGoalSetContextView<'a> {
    pub fn actor(&self) -> ActorView<'a> {
        self.context.actor.as_integration_view()
    }

    pub fn organization_id(&self) -> &str {
        &self.context.organization_id
    }

    pub fn project_id(&self) -> &str {
        &self.context.project_id
    }

    pub fn goal_ids(&self) -> &[String] {
        &self.context.goal_ids
    }

    pub fn primary_goal_after(&self) -> Option<&str> {
        self.context.primary_goal_after.as_deref()
    }
}

/// An opaque command for atomically replacing the complete Project goal set.
///
/// It is deliberately not serializable: callers must first verify the
/// server-issued actor binding and an adapter-owned target snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectGoalSetReplacementCommand {
    context: ValidatedGoalSetContext,
    expected_version: u64,
    fence_epoch: u64,
    idempotency_key: String,
    run_id: Option<String>,
}

impl ProjectGoalSetReplacementCommand {
    pub fn from_validated_context(
        context: ValidatedGoalSetContext,
        expected_version: u64,
        fence_epoch: u64,
        idempotency_key: impl Into<String>,
    ) -> Self {
        Self {
            context,
            expected_version,
            fence_epoch,
            idempotency_key: idempotency_key.into(),
            run_id: None,
        }
    }

    /// Bind optional agent-run provenance after the authenticated request has
    /// been checked against the current organization and agent.
    pub fn with_run_id(mut self, run_id: Option<String>) -> Result<Self, LinkMutationError> {
        if let Some(run_id) = run_id.as_deref() {
            validate_identifier(run_id)?;
        }
        self.run_id = run_id;
        Ok(self)
    }

    pub fn fingerprint(&self) -> Result<String, LinkMutationError> {
        self.context.validate()?;
        validate_idempotency_key(&self.idempotency_key)?;
        let bytes = canonical_goal_set_fingerprint_bytes(self);
        Ok(hex_digest(Sha256::digest(bytes)))
    }

    pub fn as_integration_view(
        &self,
    ) -> Result<ProjectGoalSetReplacementCommandView<'_>, LinkMutationError> {
        self.context.validate()?;
        validate_idempotency_key(&self.idempotency_key)?;
        Ok(ProjectGoalSetReplacementCommandView { command: self })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProjectGoalSetReplacementCommandView<'a> {
    command: &'a ProjectGoalSetReplacementCommand,
}

impl<'a> ProjectGoalSetReplacementCommandView<'a> {
    pub fn context(&self) -> ValidatedGoalSetContextView<'a> {
        ValidatedGoalSetContextView {
            context: &self.command.context,
        }
    }

    pub fn expected_version(&self) -> u64 {
        self.command.expected_version
    }

    pub fn fence_epoch(&self) -> u64 {
        self.command.fence_epoch
    }

    pub fn idempotency_key(&self) -> &str {
        &self.command.idempotency_key
    }

    pub fn run_id(&self) -> Option<&str> {
        self.command.run_id.as_deref()
    }

    pub fn fingerprint(&self) -> Result<String, LinkMutationError> {
        self.command.fingerprint()
    }

    pub fn resulting_state(
        &self,
        resulting_version: u64,
        resulting_fence_epoch: u64,
    ) -> Result<ProjectGoalSetState, LinkMutationError> {
        let expected_version = self
            .expected_version()
            .checked_add(1)
            .ok_or(LinkMutationError::VersionOverflow)?;
        if resulting_version != expected_version {
            return Err(LinkMutationError::StaleVersion);
        }
        if resulting_fence_epoch != self.fence_epoch() {
            return Err(LinkMutationError::StaleFence);
        }
        Ok(ProjectGoalSetState::new(
            self.context().organization_id(),
            self.context().project_id(),
            self.context().goal_ids().to_owned(),
            self.context().primary_goal_after().map(str::to_owned),
            resulting_version,
            resulting_fence_epoch,
        ))
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGoalSetState {
    pub organization_id: String,
    pub project_id: String,
    pub goal_ids: Vec<String>,
    pub primary_goal_after: Option<String>,
    pub version: u64,
    pub fence_epoch: u64,
    integrity: String,
}

impl ProjectGoalSetState {
    pub fn new(
        organization_id: impl Into<String>,
        project_id: impl Into<String>,
        goal_ids: Vec<String>,
        primary_goal_after: Option<String>,
        version: u64,
        fence_epoch: u64,
    ) -> Self {
        let mut state = Self {
            organization_id: organization_id.into(),
            project_id: project_id.into(),
            goal_ids,
            primary_goal_after,
            version,
            fence_epoch,
            integrity: String::new(),
        };
        state.refresh_integrity();
        state
    }

    pub fn state_integrity(&self) -> &str {
        &self.integrity
    }

    pub fn validate_persisted(&self) -> Result<(), LinkMutationError> {
        validate_identifier(&self.organization_id)?;
        validate_identifier(&self.project_id)?;
        validate_goal_set(&self.goal_ids, self.primary_goal_after.as_deref())?;
        if !is_sha256_hex(&self.integrity) || self.integrity != self.computed_integrity() {
            return Err(LinkMutationError::InvalidReceipt);
        }
        Ok(())
    }

    fn computed_integrity(&self) -> String {
        hex_digest(Sha256::digest(canonical_goal_set_state_bytes(self)))
    }

    fn refresh_integrity(&mut self) {
        self.integrity = self.computed_integrity();
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Attach,
    Detach,
    Cancel,
}

impl Operation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Attach => "attach",
            Self::Detach => "detach",
            Self::Cancel => "cancel",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedLinkContext {
    state: ProjectGoalLinkState,
    actor: ValidatedActor,
    organization_id: String,
    project_org_id: String,
    goal_org_id: String,
    project_id: String,
    goal_id: String,
    version: u64,
    fence_epoch: u64,
    linked: bool,
    cancelled: bool,
    state_integrity: String,
}

impl ValidatedLinkContext {
    fn validate(&self) -> Result<(), LinkMutationError> {
        validate_actor_shape(&self.actor.actor)?;
        validate_identifier(&self.organization_id)?;
        validate_identifier(&self.project_org_id)?;
        validate_identifier(&self.goal_org_id)?;
        validate_identifier(&self.project_id)?;
        validate_identifier(&self.goal_id)?;
        if !is_sha256_hex(&self.actor.proof) || !is_sha256_hex(&self.state_integrity) {
            return Err(LinkMutationError::InvalidTargetContext);
        }
        if self.actor.actor.organization_id() != self.organization_id {
            return Err(LinkMutationError::CrossOrganization);
        }
        if self.project_org_id != self.organization_id || self.goal_org_id != self.organization_id {
            return Err(LinkMutationError::CrossOrganization);
        }
        if !self.actor.actor.can_mutate() {
            return Err(LinkMutationError::Unauthorized);
        }
        Ok(())
    }

    /// Expose only the verified context values needed by a persistence
    /// adapter. The returned view carries no serde implementation or authority
    /// and cannot be constructed outside this crate.
    pub fn as_integration_view(&self) -> Result<ValidatedLinkContextView<'_>, LinkMutationError> {
        self.validate()?;
        Ok(ValidatedLinkContextView { context: self })
    }
}

/// Read-only view of an HMAC-verified, target-validated link context.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ValidatedLinkContextView<'a> {
    context: &'a ValidatedLinkContext,
}

impl<'a> ValidatedLinkContextView<'a> {
    pub fn actor(&self) -> ActorView<'a> {
        self.context.actor.as_integration_view()
    }

    pub fn organization_id(&self) -> &str {
        &self.context.organization_id
    }

    pub fn project_organization_id(&self) -> &str {
        &self.context.project_org_id
    }

    pub fn goal_organization_id(&self) -> &str {
        &self.context.goal_org_id
    }

    pub fn project_id(&self) -> &str {
        &self.context.project_id
    }

    pub fn goal_id(&self) -> &str {
        &self.context.goal_id
    }

    pub fn version(&self) -> u64 {
        self.context.version
    }

    pub fn fence_epoch(&self) -> u64 {
        self.context.fence_epoch
    }

    pub fn linked(&self) -> bool {
        self.context.linked
    }

    pub fn cancelled(&self) -> bool {
        self.context.cancelled
    }

    pub fn state_integrity(&self) -> &str {
        &self.context.state_integrity
    }
}

/// A mutation command can only be created from an actor- and target-validated
/// context. It deliberately has no serde implementation: untrusted JSON must
/// enter through [`ActorBinding`] and an adapter-owned [`TargetVerifier`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectGoalLinkCommand {
    context: ValidatedLinkContext,
    operation: Operation,
    expected_version: u64,
    fence_epoch: u64,
    idempotency_key: String,
}

impl ProjectGoalLinkCommand {
    pub fn from_validated_context(
        context: ValidatedLinkContext,
        operation: Operation,
        expected_version: u64,
        fence_epoch: u64,
        idempotency_key: impl Into<String>,
    ) -> Self {
        Self {
            context,
            operation,
            expected_version,
            fence_epoch,
            idempotency_key: idempotency_key.into(),
        }
    }

    fn validate(&self, state: &ProjectGoalLinkState) -> Result<(), LinkMutationError> {
        state.validate()?;
        self.context.validate()?;
        validate_idempotency_key(&self.idempotency_key)?;

        if state.organization_id != self.context.organization_id
            || state.project_org_id != self.context.organization_id
            || state.goal_org_id != self.context.organization_id
        {
            return Err(LinkMutationError::CrossOrganization);
        }
        if state.project_id != self.context.project_id || state.goal_id != self.context.goal_id {
            return Err(LinkMutationError::TargetMismatch);
        }
        Ok(())
    }

    pub fn link_identifier(&self) -> Result<String, LinkMutationError> {
        deterministic_link_identifier(
            &self.context.organization_id,
            &self.context.project_id,
            &self.context.goal_id,
        )
    }

    /// Return the fingerprint for this already validated actor and target
    /// snapshot. The context carries the verified organization, target,
    /// state-version, fence, and state-integrity binding.
    pub fn fingerprint(&self) -> Result<String, LinkMutationError> {
        self.context.validate()?;
        validate_idempotency_key(&self.idempotency_key)?;
        let bytes = canonical_fingerprint_bytes(self);
        Ok(hex_digest(Sha256::digest(bytes)))
    }

    /// Expose a validated command to a trusted persistence adapter without
    /// adding serde or making the opaque command constructible from JSON.
    pub fn as_integration_view(&self) -> Result<ProjectGoalLinkCommandView<'_>, LinkMutationError> {
        self.context.validate()?;
        validate_idempotency_key(&self.idempotency_key)?;
        if self.expected_version != self.context.version {
            return Err(LinkMutationError::StaleVersion);
        }
        if self.fence_epoch != self.context.fence_epoch {
            return Err(LinkMutationError::StaleFence);
        }
        Ok(ProjectGoalLinkCommandView { command: self })
    }
}

/// Read-only binding surface for a trusted Project↔Goal persistence adapter.
///
/// The source command remains borrowed and its fields remain private. The
/// adapter can bind the exact verified context, operation, concurrency values,
/// idempotency key, and derived identities in one transaction, but cannot
/// replace the HMAC-validated actor or construct a command from this view.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProjectGoalLinkCommandView<'a> {
    command: &'a ProjectGoalLinkCommand,
}

impl<'a> ProjectGoalLinkCommandView<'a> {
    pub fn context(&self) -> ValidatedLinkContextView<'a> {
        ValidatedLinkContextView {
            context: &self.command.context,
        }
    }

    pub fn operation(&self) -> Operation {
        self.command.operation
    }

    pub fn expected_version(&self) -> u64 {
        self.command.expected_version
    }

    pub fn fence_epoch(&self) -> u64 {
        self.command.fence_epoch
    }

    pub fn idempotency_key(&self) -> &str {
        &self.command.idempotency_key
    }

    pub fn link_identifier(&self) -> Result<String, LinkMutationError> {
        self.command.link_identifier()
    }

    pub fn fingerprint(&self) -> Result<String, LinkMutationError> {
        self.command.fingerprint()
    }

    /// Apply this trusted command to the exact validated state snapshot and
    /// return the resulting state for a persistence adapter to store.
    pub fn resulting_state(&self) -> Result<ProjectGoalLinkState, LinkMutationError> {
        let mut state = self.command.context.state.clone();
        state.apply(self.command.clone())?;
        Ok(state)
    }

    /// Return the core transition outcome for this trusted command.
    pub fn resulting_outcome(&self) -> Result<LinkMutationOutcome, LinkMutationError> {
        let mut state = self.command.context.state.clone();
        state.apply(self.command.clone())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum AppliedReceiptOutcome {
    Applied,
    Noop,
}

impl AppliedReceiptOutcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::Noop => "noop",
        }
    }
}

#[derive(Clone, Copy)]
struct LinkStateSnapshot {
    version: u64,
    fence_epoch: u64,
    linked: bool,
    cancelled: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppliedReceipt {
    idempotency_key: String,
    operation: Operation,
    outcome: AppliedReceiptOutcome,
    target_version: u64,
    target_fence_epoch: u64,
    target_integrity: String,
    previous_version: u64,
    previous_fence_epoch: u64,
    previous_linked: bool,
    previous_cancelled: bool,
    version: u64,
    fence_epoch: u64,
    linked: bool,
    cancelled: bool,
    link_id: String,
    fingerprint: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGoalLinkState {
    pub organization_id: String,
    pub project_org_id: String,
    pub goal_org_id: String,
    pub project_id: String,
    pub goal_id: String,
    pub version: u64,
    pub fence_epoch: u64,
    pub linked: bool,
    pub cancelled: bool,
    applied_idempotency: BTreeMap<String, AppliedReceipt>,
    integrity: String,
}

impl ProjectGoalLinkState {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        organization_id: impl Into<String>,
        project_org_id: impl Into<String>,
        goal_org_id: impl Into<String>,
        project_id: impl Into<String>,
        goal_id: impl Into<String>,
        version: u64,
        fence_epoch: u64,
        linked: bool,
    ) -> Self {
        let mut state = Self {
            organization_id: organization_id.into(),
            project_org_id: project_org_id.into(),
            goal_org_id: goal_org_id.into(),
            project_id: project_id.into(),
            goal_id: goal_id.into(),
            version,
            fence_epoch,
            linked,
            cancelled: false,
            applied_idempotency: BTreeMap::new(),
            integrity: String::new(),
        };
        state.refresh_integrity();
        state
    }

    /// Construct the explicit legacy-projection genesis used by a persistence
    /// adapter when no project-goal receipt exists yet. The adapter must hold
    /// the organization and target locks while deriving this baseline.
    #[allow(clippy::too_many_arguments)]
    pub fn bootstrap(
        organization_id: impl Into<String>,
        project_org_id: impl Into<String>,
        goal_org_id: impl Into<String>,
        project_id: impl Into<String>,
        goal_id: impl Into<String>,
        version: u64,
        fence_epoch: u64,
        linked: bool,
    ) -> Self {
        Self::new(
            organization_id,
            project_org_id,
            goal_org_id,
            project_id,
            goal_id,
            version,
            fence_epoch,
            linked,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn for_target(
        organization_id: impl Into<String>,
        project_id: impl Into<String>,
        goal_id: impl Into<String>,
        project_org_id: impl Into<String>,
        goal_org_id: impl Into<String>,
        version: u64,
        fence_epoch: u64,
        linked: bool,
    ) -> Self {
        Self::new(
            organization_id,
            project_org_id,
            goal_org_id,
            project_id,
            goal_id,
            version,
            fence_epoch,
            linked,
        )
    }

    pub fn link_identifier(&self) -> Result<String, LinkMutationError> {
        deterministic_link_identifier(&self.organization_id, &self.project_id, &self.goal_id)
    }

    /// Return the integrity binding that covers this complete state,
    /// including its retained idempotency receipts.
    pub fn state_integrity(&self) -> &str {
        &self.integrity
    }

    /// Rebind a persisted link snapshot to a newer organization mutation
    /// scope after unrelated mutations advanced the shared version or fence.
    pub fn rebase_scope(&self, version: u64, fence_epoch: u64) -> Result<Self, LinkMutationError> {
        if version < self.version || fence_epoch < self.fence_epoch {
            return Err(LinkMutationError::InvalidReceipt);
        }
        let mut rebased = self.clone();
        rebased.version = version;
        rebased.fence_epoch = fence_epoch;
        rebased.refresh_integrity();
        rebased.validate()?;
        Ok(rebased)
    }

    /// Validate a state loaded from an immutable persistence receipt.
    pub fn validate_persisted(&self) -> Result<(), LinkMutationError> {
        self.validate()
    }

    /// Bind an immutable adapter receipt row to the corresponding core
    /// idempotency entry in the persisted snapshot.
    #[allow(clippy::too_many_arguments)]
    pub fn validate_persisted_receipt(
        &self,
        idempotency_key: &str,
        fingerprint: &str,
        operation: Operation,
        target_version: u64,
        target_fence_epoch: u64,
        version: u64,
        fence_epoch: u64,
        linked: bool,
        cancelled: bool,
        target_integrity: &str,
        outcome: &str,
    ) -> Result<(), LinkMutationError> {
        self.validate()?;
        let receipt = self
            .applied_idempotency
            .get(idempotency_key)
            .ok_or(LinkMutationError::InvalidReceipt)?;
        if receipt.fingerprint != fingerprint
            || receipt.operation != operation
            || receipt.target_version != target_version
            || receipt.target_fence_epoch != target_fence_epoch
            || receipt.version != version
            || receipt.fence_epoch != fence_epoch
            || receipt.linked != linked
            || receipt.cancelled != cancelled
            || receipt.target_integrity != target_integrity
            || receipt.outcome.as_str() != outcome
        {
            return Err(LinkMutationError::InvalidReceipt);
        }
        Ok(())
    }

    /// Validate that this snapshot is the exact successor of a previous
    /// persisted snapshot, including the target-integrity chain and receipt
    /// map continuity.
    #[allow(clippy::too_many_arguments)]
    pub fn validate_persisted_successor(
        &self,
        previous: &ProjectGoalLinkState,
        idempotency_key: &str,
        fingerprint: &str,
        operation: Operation,
        target_version: u64,
        target_fence_epoch: u64,
        target_integrity: &str,
        outcome: &str,
    ) -> Result<(), LinkMutationError> {
        self.validate()?;
        previous.validate()?;
        if self.organization_id != previous.organization_id
            || self.project_org_id != previous.project_org_id
            || self.goal_org_id != previous.goal_org_id
            || self.project_id != previous.project_id
            || self.goal_id != previous.goal_id
            || self.applied_idempotency.len() != previous.applied_idempotency.len() + 1
        {
            return Err(LinkMutationError::InvalidReceipt);
        }
        for (key, receipt) in &previous.applied_idempotency {
            if self.applied_idempotency.get(key) != Some(receipt) {
                return Err(LinkMutationError::InvalidReceipt);
            }
        }
        let rebased_previous = previous.rebase_scope(target_version, target_fence_epoch)?;
        if target_integrity != rebased_previous.integrity.as_str() {
            return Err(LinkMutationError::InvalidReceipt);
        }
        let receipt = self
            .applied_idempotency
            .get(idempotency_key)
            .ok_or(LinkMutationError::InvalidReceipt)?;
        if receipt.target_version != rebased_previous.version
            || receipt.target_fence_epoch != rebased_previous.fence_epoch
            || receipt.previous_version != rebased_previous.version
            || receipt.previous_fence_epoch != rebased_previous.fence_epoch
            || receipt.previous_linked != rebased_previous.linked
            || receipt.previous_cancelled != rebased_previous.cancelled
        {
            return Err(LinkMutationError::InvalidReceipt);
        }
        self.validate_persisted_receipt(
            idempotency_key,
            fingerprint,
            operation,
            target_version,
            target_fence_epoch,
            self.version,
            self.fence_epoch,
            self.linked,
            self.cancelled,
            target_integrity,
            outcome,
        )
    }

    /// Validate and return the original result for an idempotent replay.
    pub fn validate_replay(
        &self,
        command: &ProjectGoalLinkCommand,
    ) -> Result<LinkMutationOutcome, LinkMutationError> {
        self.validate()?;
        let fingerprint = command.fingerprint()?;
        let link_id = command.link_identifier()?;
        let receipt = self
            .applied_idempotency
            .get(&command.idempotency_key)
            .ok_or(LinkMutationError::InvalidReceipt)?;
        if receipt.fingerprint != fingerprint || receipt.link_id != link_id {
            return Err(LinkMutationError::InvalidReceipt);
        }
        validate_replay_receipt(self, command, receipt, &fingerprint, &link_id)?;
        Ok(LinkMutationOutcome::AlreadyApplied {
            version: receipt.version,
            fence_epoch: receipt.fence_epoch,
            linked: receipt.linked,
            cancelled: receipt.cancelled,
            link_id,
            fingerprint,
        })
    }

    /// Validate the authenticated actor and the adapter's current target
    /// snapshot before constructing a mutation command.
    pub fn validated_context(
        &self,
        binding: &ActorBinding,
        authority: &ActorAuthority,
        target_verifier: &impl TargetVerifier,
    ) -> Result<ValidatedLinkContext, LinkMutationError> {
        self.validate()?;
        let actor = authority.verify(binding)?;

        if actor.actor.organization_id() != self.organization_id
            || self.project_org_id != self.organization_id
            || self.goal_org_id != self.organization_id
        {
            return Err(LinkMutationError::CrossOrganization);
        }
        if !target_verifier.target_exists_in_organization(
            &self.organization_id,
            &self.project_org_id,
            &self.goal_org_id,
            &self.project_id,
            &self.goal_id,
        ) {
            return Err(LinkMutationError::TargetNotFound);
        }
        if !actor.actor.can_mutate() {
            return Err(LinkMutationError::Unauthorized);
        }

        Ok(ValidatedLinkContext {
            state: self.clone(),
            actor,
            organization_id: self.organization_id.clone(),
            project_org_id: self.project_org_id.clone(),
            goal_org_id: self.goal_org_id.clone(),
            project_id: self.project_id.clone(),
            goal_id: self.goal_id.clone(),
            version: self.version,
            fence_epoch: self.fence_epoch,
            linked: self.linked,
            cancelled: self.cancelled,
            state_integrity: self.integrity.clone(),
        })
    }

    fn validate(&self) -> Result<(), LinkMutationError> {
        validate_identifier(&self.organization_id)?;
        validate_identifier(&self.project_org_id)?;
        validate_identifier(&self.goal_org_id)?;
        validate_identifier(&self.project_id)?;
        validate_identifier(&self.goal_id)?;
        let link_id = self.link_identifier()?;
        if !is_sha256_hex(&self.integrity) || self.integrity != self.computed_integrity() {
            return Err(LinkMutationError::InvalidReceipt);
        }
        if self.applied_idempotency.len() > MAX_APPLIED_RECEIPTS {
            return Err(LinkMutationError::ReceiptCapacityExceeded);
        }
        let mut cancellation_receipt = None;
        for (key, receipt) in &self.applied_idempotency {
            validate_idempotency_key(key)?;
            validate_receipt(key, receipt, &link_id)?;
            if receipt.version > self.version || receipt.fence_epoch > self.fence_epoch {
                return Err(LinkMutationError::InvalidReceipt);
            }
            if matches!(receipt.operation, Operation::Cancel)
                && cancellation_receipt.replace(receipt).is_some()
            {
                return Err(LinkMutationError::InvalidReceipt);
            }
        }
        if self.cancelled {
            let Some(receipt) = cancellation_receipt else {
                return Err(LinkMutationError::InvalidReceipt);
            };
            if receipt.version > self.version
                || receipt.fence_epoch > self.fence_epoch
                || receipt.linked != self.linked
                || !receipt.cancelled
            {
                return Err(LinkMutationError::InvalidReceipt);
            }
            if self.applied_idempotency.values().any(|candidate| {
                !matches!(candidate.operation, Operation::Cancel)
                    && candidate.version >= receipt.version
            }) {
                return Err(LinkMutationError::InvalidReceipt);
            }
        } else if cancellation_receipt.is_some() {
            return Err(LinkMutationError::InvalidReceipt);
        }
        Ok(())
    }

    fn computed_integrity(&self) -> String {
        hex_digest(Sha256::digest(canonical_state_integrity_bytes(self)))
    }

    fn refresh_integrity(&mut self) {
        self.integrity = self.computed_integrity();
    }

    fn snapshot(&self) -> LinkStateSnapshot {
        LinkStateSnapshot {
            version: self.version,
            fence_epoch: self.fence_epoch,
            linked: self.linked,
            cancelled: self.cancelled,
        }
    }

    fn record_receipt(
        &mut self,
        command: &ProjectGoalLinkCommand,
        outcome: AppliedReceiptOutcome,
        previous: LinkStateSnapshot,
        fingerprint: &str,
        link_id: &str,
    ) {
        let key = command.idempotency_key.clone();
        self.applied_idempotency.insert(
            key.clone(),
            AppliedReceipt {
                idempotency_key: key,
                operation: command.operation,
                outcome,
                target_version: command.context.version,
                target_fence_epoch: command.context.fence_epoch,
                target_integrity: command.context.state_integrity.clone(),
                previous_version: previous.version,
                previous_fence_epoch: previous.fence_epoch,
                previous_linked: previous.linked,
                previous_cancelled: previous.cancelled,
                version: self.version,
                fence_epoch: self.fence_epoch,
                linked: self.linked,
                cancelled: self.cancelled,
                link_id: link_id.to_owned(),
                fingerprint: fingerprint.to_owned(),
            },
        );
        self.refresh_integrity();
    }

    pub fn applied_receipt_count(&self) -> usize {
        self.applied_idempotency.len()
    }

    pub fn apply(
        &mut self,
        command: ProjectGoalLinkCommand,
    ) -> Result<LinkMutationOutcome, LinkMutationError> {
        command.validate(self)?;
        let fingerprint = command.fingerprint()?;
        let link_id = command.link_identifier()?;
        if let Some(previous) = self.applied_idempotency.get(&command.idempotency_key) {
            if previous.fingerprint == fingerprint && previous.link_id == link_id {
                validate_replay_receipt(self, &command, previous, &fingerprint, &link_id)?;
                return Ok(LinkMutationOutcome::AlreadyApplied {
                    version: previous.version,
                    fence_epoch: previous.fence_epoch,
                    linked: previous.linked,
                    cancelled: previous.cancelled,
                    link_id,
                    fingerprint,
                });
            }
            return Err(LinkMutationError::IdempotencyConflict);
        }
        if command.fence_epoch != self.fence_epoch {
            return Err(LinkMutationError::StaleFence);
        }
        if command.expected_version != self.version {
            return Err(LinkMutationError::StaleVersion);
        }
        if command.context.version != self.version
            || command.context.fence_epoch != self.fence_epoch
            || command.context.linked != self.linked
            || command.context.cancelled != self.cancelled
            || command.context.state_integrity != self.integrity
        {
            return Err(LinkMutationError::TargetStateMismatch);
        }
        if self.cancelled {
            return Err(LinkMutationError::Cancelled);
        }
        if self.applied_idempotency.len() >= MAX_APPLIED_RECEIPTS {
            return Err(LinkMutationError::ReceiptCapacityExceeded);
        }

        let previous = self.snapshot();

        if matches!(command.operation, Operation::Cancel) {
            let next_version = self
                .version
                .checked_add(1)
                .ok_or(LinkMutationError::VersionOverflow)?;
            let next_fence_epoch = self
                .fence_epoch
                .checked_add(1)
                .ok_or(LinkMutationError::FenceOverflow)?;
            self.version = next_version;
            self.fence_epoch = next_fence_epoch;
            self.cancelled = true;
            self.record_receipt(
                &command,
                AppliedReceiptOutcome::Applied,
                previous,
                &fingerprint,
                &link_id,
            );
            return Ok(LinkMutationOutcome::Applied {
                version: self.version,
                fence_epoch: self.fence_epoch,
                linked: self.linked,
                cancelled: self.cancelled,
                link_id,
                fingerprint,
            });
        }

        let requested_linked = matches!(command.operation, Operation::Attach);
        if requested_linked == self.linked {
            self.record_receipt(
                &command,
                AppliedReceiptOutcome::Noop,
                previous,
                &fingerprint,
                &link_id,
            );
            return Ok(LinkMutationOutcome::Noop {
                version: self.version,
                fence_epoch: self.fence_epoch,
                linked: self.linked,
                cancelled: self.cancelled,
                link_id,
                fingerprint,
            });
        }

        let next_version = self
            .version
            .checked_add(1)
            .ok_or(LinkMutationError::VersionOverflow)?;
        self.linked = requested_linked;
        self.version = next_version;
        self.record_receipt(
            &command,
            AppliedReceiptOutcome::Applied,
            previous,
            &fingerprint,
            &link_id,
        );
        Ok(LinkMutationOutcome::Applied {
            version: self.version,
            fence_epoch: self.fence_epoch,
            linked: self.linked,
            cancelled: self.cancelled,
            link_id,
            fingerprint,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkMutationOutcome {
    Applied {
        version: u64,
        fence_epoch: u64,
        linked: bool,
        cancelled: bool,
        link_id: String,
        fingerprint: String,
    },
    Noop {
        version: u64,
        fence_epoch: u64,
        linked: bool,
        cancelled: bool,
        link_id: String,
        fingerprint: String,
    },
    AlreadyApplied {
        version: u64,
        fence_epoch: u64,
        linked: bool,
        cancelled: bool,
        link_id: String,
        fingerprint: String,
    },
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum LinkMutationError {
    #[error("mutation contains an empty, malformed, or oversized field")]
    InvalidField,
    #[error("actor binding proof is invalid")]
    InvalidActorBinding,
    #[error("project and goal must belong to the mutation organization")]
    CrossOrganization,
    #[error("mutation target does not exist in the organization")]
    TargetNotFound,
    #[error("project goal-set target does not exist in the organization")]
    GoalSetTargetNotFound,
    #[error("mutation target does not match the bound project-goal pair")]
    TargetMismatch,
    #[error("validated mutation target context is malformed or stale")]
    InvalidTargetContext,
    #[error("validated mutation target state no longer matches the command context")]
    TargetStateMismatch,
    #[error("actor is not authorized for project-goal mutations")]
    Unauthorized,
    #[error("project-goal link is cancelled")]
    Cancelled,
    #[error("project-goal idempotency key was reused with a different command")]
    IdempotencyConflict,
    #[error("project-goal version is stale")]
    StaleVersion,
    #[error("project-goal fence epoch is stale")]
    StaleFence,
    #[error("project-goal version overflowed")]
    VersionOverflow,
    #[error("project-goal fence epoch overflowed")]
    FenceOverflow,
    #[error("project-goal idempotency receipt capacity was exceeded")]
    ReceiptCapacityExceeded,
    #[error("project-goal idempotency receipt is malformed")]
    InvalidReceipt,
    #[error("project-goal fingerprint could not be encoded")]
    FingerprintFailed,
    #[error("project goal set exceeds its bounded size")]
    GoalSetTooLarge,
    #[error("project goal set contains a duplicate goal")]
    DuplicateGoal,
    #[error("project goal projection is not a member of the complete goal set")]
    InvalidPrimaryGoal,
}

/// Hash the canonical scoped target `(organization_id, project_id, goal_id)`.
/// The project/goal pair is intentionally typed and ordered; IDs are never
/// lexicographically swapped because the two sides have different meanings.
pub fn deterministic_link_identifier(
    organization_id: &str,
    project_id: &str,
    goal_id: &str,
) -> Result<String, LinkMutationError> {
    let bytes = canonical_target_bytes(organization_id, project_id, goal_id)?;
    Ok(hex_digest(Sha256::digest(bytes)))
}

fn canonical_target_bytes(
    organization_id: &str,
    project_id: &str,
    goal_id: &str,
) -> Result<Vec<u8>, LinkMutationError> {
    validate_identifier(organization_id)?;
    validate_identifier(project_id)?;
    validate_identifier(goal_id)?;

    let fields = [organization_id, project_id, goal_id];
    let mut output = Vec::with_capacity(
        LINK_IDENTIFIER_SCHEMA.len() + fields.iter().map(|field| field.len() + 8).sum::<usize>(),
    );
    append_domain_separator(&mut output, LINK_IDENTIFIER_SCHEMA);
    for field in fields {
        append_length_prefixed(&mut output, field);
    }
    Ok(output)
}

fn canonical_actor_binding_bytes(actor: &Actor) -> Vec<u8> {
    let fields = [actor.kind(), actor.organization_id(), actor.principal_id()];
    let mut output = Vec::with_capacity(
        ACTOR_BINDING_SCHEMA.len() + fields.iter().map(|field| field.len() + 8).sum::<usize>(),
    );
    append_domain_separator(&mut output, ACTOR_BINDING_SCHEMA);
    for field in fields {
        append_length_prefixed(&mut output, field);
    }
    output
}

fn canonical_fingerprint_bytes(command: &ProjectGoalLinkCommand) -> Vec<u8> {
    let context = &command.context;
    let fields = [
        context.organization_id.as_str(),
        context.project_org_id.as_str(),
        context.goal_org_id.as_str(),
        context.project_id.as_str(),
        context.goal_id.as_str(),
        context.actor.actor.kind(),
        context.actor.actor.principal_id(),
        context.actor.proof.as_str(),
        command.operation.as_str(),
        command.idempotency_key.as_str(),
        context.state_integrity.as_str(),
    ];
    let mut output = Vec::with_capacity(
        FINGERPRINT_SCHEMA.len() + fields.iter().map(|field| field.len() + 8).sum::<usize>() + 48,
    );
    append_domain_separator(&mut output, FINGERPRINT_SCHEMA);
    for field in fields {
        append_length_prefixed(&mut output, field);
    }
    output.extend_from_slice(&command.expected_version.to_be_bytes());
    output.extend_from_slice(&command.fence_epoch.to_be_bytes());
    output.extend_from_slice(&context.version.to_be_bytes());
    output.extend_from_slice(&context.fence_epoch.to_be_bytes());
    append_bool(&mut output, context.linked);
    append_bool(&mut output, context.cancelled);
    output
}

fn canonical_goal_set_fingerprint_bytes(command: &ProjectGoalSetReplacementCommand) -> Vec<u8> {
    let context = &command.context;
    let mut output = Vec::new();
    append_domain_separator(&mut output, GOAL_SET_FINGERPRINT_SCHEMA);
    for field in [
        context.organization_id.as_str(),
        context.project_id.as_str(),
        context.actor.actor.kind(),
        context.actor.actor.principal_id(),
        command.idempotency_key.as_str(),
    ] {
        append_length_prefixed(&mut output, field);
    }
    match command.run_id.as_deref() {
        Some(run_id) => {
            append_bool(&mut output, true);
            append_length_prefixed(&mut output, run_id);
        }
        None => append_bool(&mut output, false),
    }
    output.extend_from_slice(&command.expected_version.to_be_bytes());
    output.extend_from_slice(&command.fence_epoch.to_be_bytes());
    output.extend_from_slice(&(context.goal_ids.len() as u64).to_be_bytes());
    for goal_id in &context.goal_ids {
        append_length_prefixed(&mut output, goal_id);
    }
    match context.primary_goal_after.as_deref() {
        Some(primary) => {
            append_bool(&mut output, true);
            append_length_prefixed(&mut output, primary);
        }
        None => append_bool(&mut output, false),
    }
    output
}

fn canonical_goal_set_state_bytes(state: &ProjectGoalSetState) -> Vec<u8> {
    let mut output = Vec::new();
    append_domain_separator(&mut output, GOAL_SET_FINGERPRINT_SCHEMA);
    for field in [state.organization_id.as_str(), state.project_id.as_str()] {
        append_length_prefixed(&mut output, field);
    }
    output.extend_from_slice(&(state.goal_ids.len() as u64).to_be_bytes());
    for goal_id in &state.goal_ids {
        append_length_prefixed(&mut output, goal_id);
    }
    match state.primary_goal_after.as_deref() {
        Some(primary) => {
            append_bool(&mut output, true);
            append_length_prefixed(&mut output, primary);
        }
        None => append_bool(&mut output, false),
    }
    output.extend_from_slice(&state.version.to_be_bytes());
    output.extend_from_slice(&state.fence_epoch.to_be_bytes());
    output
}

fn canonical_state_integrity_bytes(state: &ProjectGoalLinkState) -> Vec<u8> {
    let mut output = Vec::new();
    append_domain_separator(&mut output, STATE_INTEGRITY_SCHEMA);
    for field in [
        state.organization_id.as_str(),
        state.project_org_id.as_str(),
        state.goal_org_id.as_str(),
        state.project_id.as_str(),
        state.goal_id.as_str(),
    ] {
        append_length_prefixed(&mut output, field);
    }
    output.extend_from_slice(&state.version.to_be_bytes());
    output.extend_from_slice(&state.fence_epoch.to_be_bytes());
    append_bool(&mut output, state.linked);
    append_bool(&mut output, state.cancelled);
    for (key, receipt) in &state.applied_idempotency {
        append_length_prefixed(&mut output, key);
        append_length_prefixed(&mut output, &receipt.idempotency_key);
        append_length_prefixed(&mut output, receipt.operation.as_str());
        append_length_prefixed(&mut output, receipt.outcome.as_str());
        output.extend_from_slice(&receipt.target_version.to_be_bytes());
        output.extend_from_slice(&receipt.target_fence_epoch.to_be_bytes());
        append_length_prefixed(&mut output, &receipt.target_integrity);
        output.extend_from_slice(&receipt.previous_version.to_be_bytes());
        output.extend_from_slice(&receipt.previous_fence_epoch.to_be_bytes());
        append_bool(&mut output, receipt.previous_linked);
        append_bool(&mut output, receipt.previous_cancelled);
        output.extend_from_slice(&receipt.version.to_be_bytes());
        output.extend_from_slice(&receipt.fence_epoch.to_be_bytes());
        append_bool(&mut output, receipt.linked);
        append_bool(&mut output, receipt.cancelled);
        append_length_prefixed(&mut output, &receipt.link_id);
        append_length_prefixed(&mut output, &receipt.fingerprint);
    }
    output
}

fn append_domain_separator(output: &mut Vec<u8>, schema: &str) {
    output.extend_from_slice(schema.as_bytes());
    output.push(0);
}

fn append_length_prefixed(output: &mut Vec<u8>, field: &str) {
    output.extend_from_slice(&(field.len() as u64).to_be_bytes());
    output.extend_from_slice(field.as_bytes());
}

fn append_bool(output: &mut Vec<u8>, value: bool) {
    output.push(u8::from(value));
}

fn validate_identifier(value: &str) -> Result<(), LinkMutationError> {
    if value.is_empty()
        || value.trim() != value
        || value.len() > MAX_IDENTIFIER_BYTES
        || value
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_control())
    {
        return Err(LinkMutationError::InvalidField);
    }
    Ok(())
}

fn validate_goal_set(
    goal_ids: &[String],
    primary_goal_after: Option<&str>,
) -> Result<(), LinkMutationError> {
    if goal_ids.len() > MAX_GOAL_SET_SIZE {
        return Err(LinkMutationError::GoalSetTooLarge);
    }
    let mut unique = BTreeSet::<String>::new();
    for goal_id in goal_ids {
        validate_identifier(goal_id)?;
        if !unique.insert(goal_id.clone()) {
            return Err(LinkMutationError::DuplicateGoal);
        }
    }
    match (goal_ids.is_empty(), primary_goal_after) {
        (true, None) => Ok(()),
        (true, Some(_)) => Err(LinkMutationError::InvalidPrimaryGoal),
        (false, Some(primary)) if unique.iter().any(|goal_id| goal_id.as_str() == primary) => {
            Ok(())
        }
        (false, _) => Err(LinkMutationError::InvalidPrimaryGoal),
    }
}

fn validate_idempotency_key(value: &str) -> Result<(), LinkMutationError> {
    if value.len() > MAX_IDEMPOTENCY_KEY_BYTES {
        return Err(LinkMutationError::InvalidField);
    }
    validate_identifier(value)
}

fn validate_actor_shape(actor: &Actor) -> Result<(), LinkMutationError> {
    validate_identifier(actor.organization_id())?;
    validate_identifier(actor.principal_id())
}

fn decode_hex_digest(value: &str) -> Option<[u8; 32]> {
    if !is_sha256_hex(value) {
        return None;
    }
    let mut bytes = [0_u8; 32];
    let (pairs, remainder) = value.as_bytes().as_chunks::<2>();
    debug_assert!(remainder.is_empty());
    for (index, pair) in pairs.iter().enumerate() {
        bytes[index] = (hex_value(pair[0])? << 4) | hex_value(pair[1])?;
    }
    Some(bytes)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

fn validate_receipt(
    key: &str,
    receipt: &AppliedReceipt,
    link_id: &str,
) -> Result<(), LinkMutationError> {
    if receipt.idempotency_key != key
        || receipt.link_id != link_id
        || !is_sha256_hex(&receipt.link_id)
        || !is_sha256_hex(&receipt.fingerprint)
        || !is_sha256_hex(&receipt.target_integrity)
        || receipt.target_version != receipt.previous_version
        || receipt.target_fence_epoch != receipt.previous_fence_epoch
    {
        return Err(LinkMutationError::InvalidReceipt);
    }

    let valid = match (receipt.operation, receipt.outcome) {
        (Operation::Attach | Operation::Detach, AppliedReceiptOutcome::Noop) => {
            receipt.previous_version == receipt.version
                && receipt.previous_fence_epoch == receipt.fence_epoch
                && match receipt.operation {
                    Operation::Attach => receipt.previous_linked && receipt.linked,
                    Operation::Detach => !receipt.previous_linked && !receipt.linked,
                    Operation::Cancel => false,
                }
                && receipt.previous_cancelled == receipt.cancelled
                && !receipt.cancelled
        }
        (Operation::Attach | Operation::Detach, AppliedReceiptOutcome::Applied) => {
            receipt
                .previous_version
                .checked_add(1)
                .is_some_and(|version| version == receipt.version)
                && receipt.previous_fence_epoch == receipt.fence_epoch
                && match receipt.operation {
                    Operation::Attach => !receipt.previous_linked && receipt.linked,
                    Operation::Detach => receipt.previous_linked && !receipt.linked,
                    Operation::Cancel => false,
                }
                && receipt.previous_cancelled == receipt.cancelled
                && !receipt.cancelled
        }
        (Operation::Cancel, AppliedReceiptOutcome::Applied) => {
            receipt
                .previous_version
                .checked_add(1)
                .is_some_and(|version| version == receipt.version)
                && receipt
                    .previous_fence_epoch
                    .checked_add(1)
                    .is_some_and(|fence_epoch| fence_epoch == receipt.fence_epoch)
                && receipt.previous_linked == receipt.linked
                && !receipt.previous_cancelled
                && receipt.cancelled
        }
        (Operation::Cancel, AppliedReceiptOutcome::Noop) => false,
    };
    if !valid {
        return Err(LinkMutationError::InvalidReceipt);
    }
    Ok(())
}

fn validate_replay_receipt(
    state: &ProjectGoalLinkState,
    command: &ProjectGoalLinkCommand,
    receipt: &AppliedReceipt,
    fingerprint: &str,
    link_id: &str,
) -> Result<(), LinkMutationError> {
    if receipt.idempotency_key != command.idempotency_key
        || receipt.operation != command.operation
        || receipt.fingerprint != fingerprint
        || receipt.link_id != link_id
        || receipt.target_version != command.context.version
        || receipt.target_fence_epoch != command.context.fence_epoch
        || receipt.target_integrity != command.context.state_integrity
        || receipt.previous_version != command.expected_version
        || receipt.previous_fence_epoch != command.fence_epoch
    {
        return Err(LinkMutationError::InvalidReceipt);
    }

    if receipt.version > state.version || receipt.fence_epoch > state.fence_epoch {
        return Err(LinkMutationError::InvalidReceipt);
    }
    if matches!(command.operation, Operation::Cancel) && !state.cancelled {
        return Err(LinkMutationError::InvalidReceipt);
    }

    let exact_outcome = match (command.operation, receipt.outcome) {
        (Operation::Attach, AppliedReceiptOutcome::Applied) => {
            !receipt.previous_linked && receipt.linked && !receipt.cancelled
        }
        (Operation::Attach, AppliedReceiptOutcome::Noop) => {
            receipt.previous_linked && receipt.linked && !receipt.cancelled
        }
        (Operation::Detach, AppliedReceiptOutcome::Applied) => {
            receipt.previous_linked && !receipt.linked && !receipt.cancelled
        }
        (Operation::Detach, AppliedReceiptOutcome::Noop) => {
            !receipt.previous_linked && !receipt.linked && !receipt.cancelled
        }
        (Operation::Cancel, AppliedReceiptOutcome::Applied) => {
            receipt.previous_linked == receipt.linked && receipt.cancelled
        }
        (Operation::Cancel, AppliedReceiptOutcome::Noop) => false,
    };
    if !exact_outcome {
        return Err(LinkMutationError::InvalidReceipt);
    }
    Ok(())
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == SHA256_HEX_LENGTH
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn hex_digest(digest: impl IntoIterator<Item = u8>) -> String {
    digest
        .into_iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct ExistingTarget;

    impl TargetVerifier for ExistingTarget {
        fn target_exists_in_organization(
            &self,
            organization_id: &str,
            project_org_id: &str,
            goal_org_id: &str,
            project_id: &str,
            goal_id: &str,
        ) -> bool {
            organization_id == "org-a"
                && project_org_id == "org-a"
                && goal_org_id == "org-a"
                && project_id == "project-a"
                && goal_id == "goal-a"
        }
    }

    struct ExistingGoalSetTarget;

    impl GoalSetTargetVerifier for ExistingGoalSetTarget {
        fn goal_set_exists_in_organization(
            &self,
            organization_id: &str,
            project_id: &str,
            goal_ids: &[String],
        ) -> bool {
            organization_id == "org-a"
                && project_id == "project-a"
                && goal_ids
                    .iter()
                    .all(|goal_id| matches!(goal_id.as_str(), "goal-a" | "goal-b"))
        }
    }

    fn authority() -> ActorAuthority {
        ActorAuthority::verification_only("unit-test-authority").unwrap()
    }

    fn binding(actor: Actor) -> ActorBinding {
        authority().issue(actor).unwrap()
    }

    fn context(state: &ProjectGoalLinkState, actor: Actor) -> ValidatedLinkContext {
        let authority = authority();
        let binding = authority.issue(actor).unwrap();
        state
            .validated_context(&binding, &authority, &ExistingTarget)
            .unwrap()
    }

    fn state() -> ProjectGoalLinkState {
        ProjectGoalLinkState::new(
            "org-a",
            "org-a",
            "org-a",
            "project-a",
            "goal-a",
            2,
            4,
            false,
        )
    }

    fn make_command(
        state: &ProjectGoalLinkState,
        actor: Actor,
        operation: Operation,
        expected_version: u64,
        fence_epoch: u64,
        key: &str,
    ) -> ProjectGoalLinkCommand {
        ProjectGoalLinkCommand::from_validated_context(
            context(state, actor),
            operation,
            expected_version,
            fence_epoch,
            key,
        )
    }

    fn board(operation: Operation, key: &str) -> ProjectGoalLinkCommand {
        let state = state();
        make_command(
            &state,
            Actor::Board {
                organization_id: "org-a".to_owned(),
                principal_id: "board-a".to_owned(),
            },
            operation,
            2,
            4,
            key,
        )
    }

    fn goal_set(
        goal_ids: Vec<String>,
        primary_goal_after: Option<String>,
        key: &str,
    ) -> ProjectGoalSetReplacementCommand {
        let authority = authority();
        let binding = authority
            .issue(Actor::Board {
                organization_id: "org-a".to_owned(),
                principal_id: "board-a".to_owned(),
            })
            .unwrap();
        let context = ValidatedGoalSetContext::from_target_snapshot(
            &binding,
            &authority,
            &ExistingGoalSetTarget,
            "org-a",
            "project-a",
            goal_ids,
            primary_goal_after,
        )
        .unwrap();
        ProjectGoalSetReplacementCommand::from_validated_context(context, 2, 4, key)
    }

    #[test]
    fn complete_goal_set_replacement_binds_target_order_and_legacy_primary() {
        let command = goal_set(
            vec!["goal-a".to_owned(), "goal-b".to_owned()],
            Some("goal-a".to_owned()),
            "goal-set-apply",
        );
        let view = command.as_integration_view().unwrap();
        let context = view.context();

        assert_eq!(context.organization_id(), "org-a");
        assert_eq!(context.project_id(), "project-a");
        assert_eq!(context.goal_ids(), ["goal-a", "goal-b"]);
        assert_eq!(context.primary_goal_after(), Some("goal-a"));
        assert_eq!(context.actor().kind(), "board");
        assert_eq!(view.expected_version(), 2);
        assert_eq!(view.fence_epoch(), 4);

        let state = view.resulting_state(3, 4).unwrap();
        assert_eq!(state.goal_ids, ["goal-a", "goal-b"]);
        assert_eq!(state.primary_goal_after.as_deref(), Some("goal-a"));
        assert_eq!(state.version, 3);
        assert_eq!(state.fence_epoch, 4);
        assert_eq!(state.state_integrity().len(), SHA256_HEX_LENGTH);
        assert!(state.validate_persisted().is_ok());
    }

    #[test]
    fn goal_set_fingerprint_excludes_rotating_request_envelope_proof() {
        let original = goal_set(
            vec!["goal-a".to_owned(), "goal-b".to_owned()],
            Some("goal-a".to_owned()),
            "goal-set-replay",
        );
        let mut reauthenticated = goal_set(
            vec!["goal-a".to_owned(), "goal-b".to_owned()],
            Some("goal-a".to_owned()),
            "goal-set-replay",
        );
        reauthenticated.context.actor.proof = "f".repeat(SHA256_HEX_LENGTH);

        assert_eq!(
            original.fingerprint().unwrap(),
            reauthenticated.fingerprint().unwrap()
        );
    }

    #[test]
    fn complete_goal_set_replacement_rejects_duplicate_or_invalid_projection() {
        let authority = authority();
        let binding = authority
            .issue(Actor::Board {
                organization_id: "org-a".to_owned(),
                principal_id: "board-a".to_owned(),
            })
            .unwrap();

        assert_eq!(
            ValidatedGoalSetContext::from_target_snapshot(
                &binding,
                &authority,
                &ExistingGoalSetTarget,
                "org-a",
                "project-a",
                vec!["goal-a".to_owned(), "goal-a".to_owned()],
                Some("goal-a".to_owned()),
            )
            .unwrap_err(),
            LinkMutationError::DuplicateGoal
        );
        assert_eq!(
            ValidatedGoalSetContext::from_target_snapshot(
                &binding,
                &authority,
                &ExistingGoalSetTarget,
                "org-a",
                "project-a",
                vec!["goal-a".to_owned()],
                None,
            )
            .unwrap_err(),
            LinkMutationError::InvalidPrimaryGoal
        );
        assert_eq!(
            ValidatedGoalSetContext::from_target_snapshot(
                &binding,
                &authority,
                &ExistingGoalSetTarget,
                "org-a",
                "project-a",
                vec![],
                Some("goal-a".to_owned()),
            )
            .unwrap_err(),
            LinkMutationError::InvalidPrimaryGoal
        );
    }

    #[test]
    fn complete_goal_set_replacement_rejects_tampered_state_and_cross_org_actor() {
        let command = goal_set(
            vec!["goal-a".to_owned()],
            Some("goal-a".to_owned()),
            "tamper",
        );
        let view = command.as_integration_view().unwrap();
        let mut encoded = serde_json::to_value(view.resulting_state(3, 4).unwrap()).unwrap();
        encoded["goalIds"] = serde_json::json!(["goal-b"]);
        encoded["primaryGoalAfter"] = serde_json::json!("goal-b");
        let tampered: ProjectGoalSetState = serde_json::from_value(encoded).unwrap();
        assert_eq!(
            tampered.validate_persisted(),
            Err(LinkMutationError::InvalidReceipt)
        );

        let authority = authority();
        let foreign_binding = authority
            .issue(Actor::Board {
                organization_id: "org-b".to_owned(),
                principal_id: "board-b".to_owned(),
            })
            .unwrap();
        assert_eq!(
            ValidatedGoalSetContext::from_target_snapshot(
                &foreign_binding,
                &authority,
                &ExistingGoalSetTarget,
                "org-a",
                "project-a",
                vec!["goal-a".to_owned()],
                Some("goal-a".to_owned()),
            )
            .unwrap_err(),
            LinkMutationError::CrossOrganization
        );
    }

    #[test]
    fn trusted_integration_view_exposes_verified_context_and_derived_identities() {
        let command = board(Operation::Attach, "integration-attach");
        let view = command.as_integration_view().unwrap();
        let context = view.context();

        assert_eq!(context.organization_id(), "org-a");
        assert_eq!(context.project_organization_id(), "org-a");
        assert_eq!(context.goal_organization_id(), "org-a");
        assert_eq!(context.project_id(), "project-a");
        assert_eq!(context.goal_id(), "goal-a");
        assert_eq!(context.actor().kind(), "board");
        assert_eq!(context.actor().principal_id(), "board-a");
        assert_eq!(context.version(), 2);
        assert_eq!(context.fence_epoch(), 4);
        assert!(!context.linked());
        assert!(!context.cancelled());
        assert_eq!(context.state_integrity().len(), SHA256_HEX_LENGTH);

        assert_eq!(view.operation(), Operation::Attach);
        assert_eq!(view.expected_version(), 2);
        assert_eq!(view.fence_epoch(), 4);
        assert_eq!(view.idempotency_key(), "integration-attach");
        assert_eq!(
            view.link_identifier().unwrap(),
            command.link_identifier().unwrap()
        );
        assert_eq!(view.fingerprint().unwrap(), command.fingerprint().unwrap());
    }

    #[test]
    fn integration_view_keeps_the_hmac_proof_out_of_the_adapter_surface() {
        let command = board(Operation::Attach, "integration-proof");
        let actor = command.as_integration_view().unwrap().context().actor();

        assert_eq!(actor.organization_id(), "org-a");
        assert_eq!(actor.principal_id(), "board-a");
        assert_eq!(actor.kind(), "board");
    }

    #[test]
    fn integration_view_rejects_command_concurrency_values_not_bound_to_context() {
        let mut stale_version = board(Operation::Attach, "integration-stale-version");
        stale_version.expected_version = 3;
        assert_eq!(
            stale_version.as_integration_view(),
            Err(LinkMutationError::StaleVersion)
        );

        let mut stale_fence = board(Operation::Attach, "integration-stale-fence");
        stale_fence.fence_epoch = 5;
        assert_eq!(
            stale_fence.as_integration_view(),
            Err(LinkMutationError::StaleFence)
        );
    }

    #[test]
    fn attach_advances_version_and_sets_linked() {
        let mut state = state();
        let outcome = state.apply(board(Operation::Attach, "attach-1")).unwrap();
        assert!(matches!(
            outcome,
            LinkMutationOutcome::Applied {
                version: 3,
                linked: true,
                ..
            }
        ));
        assert_eq!(state.version, 3);
        assert!(state.linked);
    }

    #[test]
    fn detach_advances_version_and_clears_linked() {
        let mut state =
            ProjectGoalLinkState::new("org-a", "org-a", "org-a", "project-a", "goal-a", 2, 4, true);
        let command = make_command(
            &state,
            Actor::Board {
                organization_id: "org-a".to_owned(),
                principal_id: "board-a".to_owned(),
            },
            Operation::Detach,
            2,
            4,
            "detach-1",
        );
        let outcome = state.apply(command).unwrap();
        assert!(matches!(
            outcome,
            LinkMutationOutcome::Applied {
                version: 3,
                linked: false,
                ..
            }
        ));
    }

    #[test]
    fn cross_organization_project_or_goal_fails_closed() {
        let mut project_foreign = ProjectGoalLinkState::new(
            "org-a",
            "org-b",
            "org-a",
            "project-a",
            "goal-a",
            2,
            4,
            false,
        );
        assert_eq!(
            project_foreign.apply(board(Operation::Attach, "cross-project")),
            Err(LinkMutationError::CrossOrganization)
        );
        let mut goal_foreign = ProjectGoalLinkState::new(
            "org-a",
            "org-a",
            "org-b",
            "project-a",
            "goal-a",
            2,
            4,
            false,
        );
        assert_eq!(
            goal_foreign.apply(board(Operation::Attach, "cross-goal")),
            Err(LinkMutationError::CrossOrganization)
        );
    }

    #[test]
    fn verified_ceo_agent_can_create_a_mutation_command() {
        let mut state = state();
        let command = make_command(
            &state,
            Actor::CeoAgent {
                organization_id: "org-a".to_owned(),
                principal_id: "ceo-a".to_owned(),
            },
            Operation::Attach,
            2,
            4,
            "ceo-attach",
        );

        assert!(matches!(
            state.apply(command),
            Ok(LinkMutationOutcome::Applied {
                version: 3,
                linked: true,
                cancelled: false,
                ..
            })
        ));
    }

    #[test]
    fn forged_actor_binding_is_rejected_before_context_creation() {
        let authority = authority();
        let forged = ActorBinding {
            actor: Actor::CeoAgent {
                organization_id: "org-a".to_owned(),
                principal_id: "ceo-a".to_owned(),
            },
            proof: "0".repeat(SHA256_HEX_LENGTH),
        };

        assert_eq!(
            state().validated_context(&forged, &authority, &ExistingTarget),
            Err(LinkMutationError::InvalidActorBinding)
        );
    }

    #[test]
    fn non_ceo_agent_fails_without_mutating_state() {
        let state = state();
        let authority = authority();
        let agent = authority
            .issue(Actor::Agent {
                organization_id: "org-a".to_owned(),
                principal_id: "agent-a".to_owned(),
            })
            .unwrap();
        assert_eq!(
            state.validated_context(&agent, &authority, &ExistingTarget),
            Err(LinkMutationError::Unauthorized)
        );
        assert_eq!(state.version, 2);
        assert!(!state.linked);
    }

    #[test]
    fn stale_version_and_fence_are_rejected() {
        let mut stale_version = state();
        let command = make_command(
            &stale_version,
            Actor::Board {
                organization_id: "org-a".to_owned(),
                principal_id: "board-a".to_owned(),
            },
            Operation::Attach,
            1,
            4,
            "stale-version",
        );
        assert_eq!(
            stale_version.apply(command),
            Err(LinkMutationError::StaleVersion)
        );

        let mut stale_fence = state();
        let command = make_command(
            &stale_fence,
            Actor::Board {
                organization_id: "org-a".to_owned(),
                principal_id: "board-a".to_owned(),
            },
            Operation::Attach,
            2,
            3,
            "stale-fence",
        );
        assert_eq!(
            stale_fence.apply(command),
            Err(LinkMutationError::StaleFence)
        );
    }

    #[test]
    fn replay_is_idempotent_and_conflict_is_rejected() {
        let mut state = state();
        let first = state.apply(board(Operation::Attach, "same-key")).unwrap();
        let replay = state.apply(board(Operation::Attach, "same-key")).unwrap();
        assert!(matches!(
            first,
            LinkMutationOutcome::Applied { version: 3, .. }
        ));
        assert!(matches!(
            replay,
            LinkMutationOutcome::AlreadyApplied {
                version: 3,
                linked: true,
                ..
            }
        ));
        let conflict = make_command(
            &state,
            Actor::Board {
                organization_id: "org-a".to_owned(),
                principal_id: "board-a".to_owned(),
            },
            Operation::Detach,
            3,
            4,
            "same-key",
        );
        assert_eq!(
            state.apply(conflict),
            Err(LinkMutationError::IdempotencyConflict)
        );
    }

    #[test]
    fn replay_returns_original_result_after_a_later_mutation() {
        let mut state = state();
        let original = board(Operation::Attach, "original");
        let original_fingerprint = match state.apply(original.clone()).unwrap() {
            LinkMutationOutcome::Applied {
                version: 3,
                linked: true,
                fingerprint,
                ..
            } => fingerprint,
            outcome => panic!("unexpected original outcome: {outcome:?}"),
        };

        let later = make_command(
            &state,
            Actor::Board {
                organization_id: "org-a".to_owned(),
                principal_id: "board-a".to_owned(),
            },
            Operation::Detach,
            3,
            4,
            "later",
        );
        assert!(matches!(
            state.apply(later).unwrap(),
            LinkMutationOutcome::Applied {
                version: 4,
                linked: false,
                ..
            }
        ));

        assert!(matches!(
            state.apply(original).unwrap(),
            LinkMutationOutcome::AlreadyApplied {
                version: 3,
                linked: true,
                fingerprint,
                ..
            } if fingerprint == original_fingerprint
        ));
        assert_eq!(state.version, 4);
        assert!(!state.linked);
    }

    #[test]
    fn repeated_attach_and_detach_are_noops() {
        let mut attached =
            ProjectGoalLinkState::new("org-a", "org-a", "org-a", "project-a", "goal-a", 2, 4, true);
        assert!(matches!(
            attached
                .apply(make_command(
                    &attached,
                    Actor::Board {
                        organization_id: "org-a".to_owned(),
                        principal_id: "board-a".to_owned(),
                    },
                    Operation::Attach,
                    2,
                    4,
                    "already-attached",
                ))
                .unwrap(),
            LinkMutationOutcome::Noop {
                version: 2,
                linked: true,
                ..
            }
        ));
        let mut detached = state();
        assert!(matches!(
            detached
                .apply(board(Operation::Detach, "already-detached"))
                .unwrap(),
            LinkMutationOutcome::Noop {
                version: 2,
                linked: false,
                ..
            }
        ));
    }

    #[test]
    fn version_overflow_leaves_state_unchanged_on_retry() {
        let mut state = ProjectGoalLinkState::new(
            "org-a",
            "org-a",
            "org-a",
            "project-a",
            "goal-a",
            u64::MAX,
            4,
            false,
        );
        let command = make_command(
            &state,
            Actor::Board {
                organization_id: "org-a".to_owned(),
                principal_id: "board-a".to_owned(),
            },
            Operation::Attach,
            u64::MAX,
            4,
            "overflow",
        );
        let expected_state = state.clone();

        assert_eq!(
            state.apply(command.clone()),
            Err(LinkMutationError::VersionOverflow)
        );
        assert_eq!(state, expected_state);
        assert_eq!(state.version, u64::MAX);
        assert!(!state.linked);
        assert!(state.applied_idempotency.is_empty());

        assert_eq!(
            state.apply(command),
            Err(LinkMutationError::VersionOverflow)
        );
        assert_eq!(state, expected_state);
    }

    #[test]
    fn target_identity_rejects_same_organization_pair_replays() {
        let mut state = state();
        let original = board(Operation::Attach, "pair-key");
        state.apply(original).unwrap();
        let expected_state = state.clone();

        let mut wrong_project = ProjectGoalLinkState::new(
            "org-a",
            "org-a",
            "org-a",
            "project-b",
            "goal-a",
            state.version,
            state.fence_epoch,
            true,
        );
        assert_eq!(
            wrong_project.apply(make_command(
                &state,
                Actor::Board {
                    organization_id: "org-a".to_owned(),
                    principal_id: "board-a".to_owned(),
                },
                Operation::Attach,
                state.version,
                state.fence_epoch,
                "pair-key",
            )),
            Err(LinkMutationError::TargetMismatch)
        );

        let mut wrong_goal = ProjectGoalLinkState::new(
            "org-a",
            "org-a",
            "org-a",
            "project-a",
            "goal-b",
            state.version,
            state.fence_epoch,
            true,
        );
        assert_eq!(
            wrong_goal.apply(make_command(
                &state,
                Actor::Board {
                    organization_id: "org-a".to_owned(),
                    principal_id: "board-a".to_owned(),
                },
                Operation::Attach,
                state.version,
                state.fence_epoch,
                "pair-key",
            )),
            Err(LinkMutationError::TargetMismatch)
        );
        assert_eq!(state, expected_state);
    }

    #[test]
    fn canonical_pair_order_has_a_deterministic_link_identifier() {
        let first = deterministic_link_identifier("org-a", "project-a", "goal-a").unwrap();
        let second = deterministic_link_identifier("org-a", "project-a", "goal-a").unwrap();
        let swapped = deterministic_link_identifier("org-a", "goal-a", "project-a").unwrap();

        assert_eq!(first, second);
        assert_eq!(first.len(), SHA256_HEX_LENGTH);
        assert_ne!(first, swapped);

        let mut attach_state = state();
        let attach = attach_state
            .apply(board(Operation::Attach, "canonical"))
            .unwrap();
        let detach_state = ProjectGoalLinkState::for_target(
            "org-a",
            "project-a",
            "goal-a",
            "org-a",
            "org-a",
            attach_state.version,
            attach_state.fence_epoch,
            true,
        );
        assert_eq!(attach_state.link_identifier().unwrap(), first);
        assert_eq!(detach_state.link_identifier().unwrap(), first);
        assert!(matches!(attach, LinkMutationOutcome::Applied { link_id, .. } if link_id == first));
    }

    #[test]
    fn identifiers_keys_and_receipts_are_bounded() {
        assert_eq!(
            ProjectGoalLinkState::new(
                "org-a",
                "org-a",
                "org-a",
                "x".repeat(MAX_IDENTIFIER_BYTES + 1),
                "goal-a",
                2,
                4,
                false,
            )
            .validated_context(
                &binding(Actor::Board {
                    organization_id: "org-a".to_owned(),
                    principal_id: "board-a".to_owned(),
                }),
                &authority(),
                &ExistingTarget,
            ),
            Err(LinkMutationError::InvalidField)
        );

        assert_eq!(
            state().apply(make_command(
                &state(),
                Actor::Board {
                    organization_id: "org-a".to_owned(),
                    principal_id: "board-a".to_owned(),
                },
                Operation::Attach,
                2,
                4,
                &"k".repeat(MAX_IDEMPOTENCY_KEY_BYTES + 1),
            )),
            Err(LinkMutationError::InvalidField)
        );

        let mut full = state();
        let link_id = full.link_identifier().unwrap();
        for index in 0..MAX_APPLIED_RECEIPTS {
            full.applied_idempotency.insert(
                format!("receipt-{index}"),
                AppliedReceipt {
                    idempotency_key: format!("receipt-{index}"),
                    operation: Operation::Detach,
                    outcome: AppliedReceiptOutcome::Noop,
                    target_version: 2,
                    target_fence_epoch: 4,
                    target_integrity: full.integrity.clone(),
                    previous_version: 2,
                    previous_fence_epoch: 4,
                    previous_linked: false,
                    previous_cancelled: false,
                    version: 2,
                    fence_epoch: 4,
                    linked: false,
                    cancelled: false,
                    link_id: link_id.clone(),
                    fingerprint: "1".repeat(SHA256_HEX_LENGTH),
                },
            );
        }
        full.refresh_integrity();
        let expected_state = full.clone();
        assert_eq!(
            full.apply(make_command(
                &full,
                Actor::Board {
                    organization_id: "org-a".to_owned(),
                    principal_id: "board-a".to_owned(),
                },
                Operation::Attach,
                2,
                4,
                "receipt-overflow",
            )),
            Err(LinkMutationError::ReceiptCapacityExceeded)
        );
        assert_eq!(full, expected_state);
    }

    #[test]
    fn fence_overflow_leaves_state_unchanged_on_retry() {
        let mut state = ProjectGoalLinkState::new(
            "org-a",
            "org-a",
            "org-a",
            "project-a",
            "goal-a",
            2,
            u64::MAX,
            false,
        );
        let command = make_command(
            &state,
            Actor::Board {
                organization_id: "org-a".to_owned(),
                principal_id: "board-a".to_owned(),
            },
            Operation::Cancel,
            2,
            u64::MAX,
            "fence-overflow",
        );
        let expected_state = state.clone();

        assert_eq!(
            state.apply(command.clone()),
            Err(LinkMutationError::FenceOverflow)
        );
        assert_eq!(state, expected_state);
        assert_eq!(state.apply(command), Err(LinkMutationError::FenceOverflow));
        assert_eq!(state, expected_state);
    }

    #[test]
    fn tampered_replay_receipt_fails_closed_after_json_round_trip() {
        let mut state = state();
        state
            .apply(board(Operation::Attach, "tampered-receipt"))
            .unwrap();

        let mut encoded = serde_json::to_value(&state).unwrap();
        encoded["appliedIdempotency"]["tampered-receipt"]["version"] = serde_json::json!(99);
        let mut restored: ProjectGoalLinkState = serde_json::from_value(encoded).unwrap();
        restored.refresh_integrity();

        assert_eq!(
            restored.apply(board(Operation::Attach, "tampered-receipt")),
            Err(LinkMutationError::InvalidReceipt)
        );
    }

    #[test]
    fn persisted_successor_binds_receipt_to_rebased_previous_snapshot() {
        let previous =
            ProjectGoalLinkState::new("org-a", "org-a", "org-a", "project-a", "goal-a", 2, 4, true);
        let rebased_previous = previous.rebase_scope(7, 9).unwrap();
        let command = make_command(
            &rebased_previous,
            Actor::Board {
                organization_id: "org-a".to_owned(),
                principal_id: "board-a".to_owned(),
            },
            Operation::Attach,
            7,
            9,
            "forged-successor",
        );
        let fingerprint = command.fingerprint().unwrap();
        let link_id = command.link_identifier().unwrap();
        let mut successor = rebased_previous.clone();
        successor.version = 8;
        successor.applied_idempotency.insert(
            "forged-successor".to_owned(),
            AppliedReceipt {
                idempotency_key: "forged-successor".to_owned(),
                operation: Operation::Attach,
                outcome: AppliedReceiptOutcome::Applied,
                target_version: 7,
                target_fence_epoch: 9,
                target_integrity: rebased_previous.state_integrity().to_owned(),
                previous_version: 7,
                previous_fence_epoch: 9,
                previous_linked: false,
                previous_cancelled: false,
                version: 8,
                fence_epoch: 9,
                linked: true,
                cancelled: false,
                link_id,
                fingerprint,
            },
        );
        successor.refresh_integrity();

        assert_eq!(
            successor.validate_persisted_successor(
                &previous,
                "forged-successor",
                &command.fingerprint().unwrap(),
                Operation::Attach,
                7,
                9,
                rebased_previous.state_integrity(),
                "applied",
            ),
            Err(LinkMutationError::InvalidReceipt)
        );
    }

    #[test]
    fn valid_json_round_trip_preserves_replay_and_cancel_receipts() {
        let mut state = state();
        let attach = board(Operation::Attach, "json-attach");
        state.apply(attach.clone()).unwrap();

        let encoded = serde_json::to_string(&state).unwrap();
        let mut restored: ProjectGoalLinkState = serde_json::from_str(&encoded).unwrap();
        assert!(matches!(
            restored.apply(attach),
            Ok(LinkMutationOutcome::AlreadyApplied {
                version: 3,
                fence_epoch: 4,
                linked: true,
                cancelled: false,
                ..
            })
        ));

        let cancel = make_command(
            &restored,
            Actor::Board {
                organization_id: "org-a".to_owned(),
                principal_id: "board-a".to_owned(),
            },
            Operation::Cancel,
            3,
            4,
            "json-cancel",
        );
        restored.apply(cancel.clone()).unwrap();

        let cancel_json = serde_json::to_string(&restored).unwrap();
        let mut restored_again: ProjectGoalLinkState = serde_json::from_str(&cancel_json).unwrap();
        assert!(matches!(
            restored_again.apply(cancel),
            Ok(LinkMutationOutcome::AlreadyApplied {
                version: 4,
                fence_epoch: 5,
                linked: true,
                cancelled: true,
                ..
            })
        ));
    }

    #[test]
    fn idempotency_key_is_bound_to_fingerprint_and_receipt_map_key() {
        let used = board(Operation::Attach, "used-key");
        let unused = board(Operation::Attach, "unused-key");
        assert_ne!(used.fingerprint(), unused.fingerprint());

        let mut state = state();
        state.apply(used).unwrap();

        let mut encoded = serde_json::to_value(&state).unwrap();
        let receipt = encoded["appliedIdempotency"]
            .as_object_mut()
            .unwrap()
            .remove("used-key")
            .unwrap();
        encoded["appliedIdempotency"]
            .as_object_mut()
            .unwrap()
            .insert("unused-key".to_owned(), receipt);
        let mut restored: ProjectGoalLinkState = serde_json::from_value(encoded).unwrap();
        restored.refresh_integrity();

        assert_eq!(
            restored.apply(board(Operation::Attach, "unused-key")),
            Err(LinkMutationError::InvalidReceipt)
        );
    }

    #[test]
    fn tampered_attach_and_detach_noop_receipts_cannot_replay_as_applied() {
        for (operation, linked, key) in [
            (Operation::Attach, true, "noop-attach"),
            (Operation::Detach, false, "noop-detach"),
        ] {
            let mut state = ProjectGoalLinkState::new(
                "org-a",
                "org-a",
                "org-a",
                "project-a",
                "goal-a",
                2,
                4,
                linked,
            );
            let original_command = make_command(
                &state,
                Actor::Board {
                    organization_id: "org-a".to_owned(),
                    principal_id: "board-a".to_owned(),
                },
                operation,
                2,
                4,
                key,
            );
            state.apply(original_command.clone()).unwrap();

            let mut encoded = serde_json::to_value(&state).unwrap();
            encoded["appliedIdempotency"][key]["outcome"] = serde_json::json!("applied");
            let mut restored: ProjectGoalLinkState = serde_json::from_value(encoded).unwrap();
            restored.refresh_integrity();
            assert_eq!(
                restored.apply(original_command),
                Err(LinkMutationError::InvalidReceipt)
            );
        }
    }

    #[test]
    fn tampered_attach_noop_version_cannot_replay_as_version_increment() {
        let mut state =
            ProjectGoalLinkState::new("org-a", "org-a", "org-a", "project-a", "goal-a", 2, 4, true);
        let original_command = make_command(
            &state,
            Actor::Board {
                organization_id: "org-a".to_owned(),
                principal_id: "board-a".to_owned(),
            },
            Operation::Attach,
            2,
            4,
            "noop-version",
        );
        state.apply(original_command.clone()).unwrap();

        let mut encoded = serde_json::to_value(&state).unwrap();
        encoded["appliedIdempotency"]["noop-version"]["version"] = serde_json::json!(3);
        let mut restored: ProjectGoalLinkState = serde_json::from_value(encoded).unwrap();
        restored.refresh_integrity();
        assert_eq!(
            restored.apply(original_command),
            Err(LinkMutationError::InvalidReceipt)
        );
    }

    #[test]
    fn tampered_cancelled_state_cannot_reopen_terminal_link() {
        let mut state = state();
        state
            .apply(board(Operation::Cancel, "cancel-state"))
            .unwrap();
        let reopen = make_command(
            &state,
            Actor::Board {
                organization_id: "org-a".to_owned(),
                principal_id: "board-a".to_owned(),
            },
            Operation::Attach,
            3,
            5,
            "reopen-terminal",
        );

        let mut encoded = serde_json::to_value(&state).unwrap();
        encoded["cancelled"] = serde_json::json!(false);
        let mut restored: ProjectGoalLinkState = serde_json::from_value(encoded).unwrap();
        restored.refresh_integrity();
        assert_eq!(
            restored.apply(reopen),
            Err(LinkMutationError::InvalidReceipt)
        );
        assert_eq!(restored.version, 3);
        assert!(!restored.linked);
    }

    #[test]
    fn fingerprint_and_receipt_are_deterministic_across_equal_states() {
        let mut first_state = state();
        let mut second_state = state();
        let first = first_state
            .apply(board(Operation::Attach, "deterministic"))
            .unwrap();
        let second = second_state
            .apply(board(Operation::Attach, "deterministic"))
            .unwrap();

        assert_eq!(first, second);
        assert_eq!(
            serde_json::to_vec(&first_state).unwrap(),
            serde_json::to_vec(&second_state).unwrap()
        );
    }

    #[test]
    fn cancellation_is_terminal_and_fences_old_commands() {
        let mut state = state();
        let old_command = board(Operation::Attach, "old-command");
        let cancel = board(Operation::Cancel, "cancel-command");
        let outcome = state.apply(cancel.clone()).unwrap();
        assert!(matches!(
            outcome,
            LinkMutationOutcome::Applied {
                version: 3,
                fence_epoch: 5,
                linked: false,
                cancelled: true,
                ..
            }
        ));
        assert_eq!(state.version, 3);
        assert_eq!(state.fence_epoch, 5);
        assert!(state.cancelled);

        assert_eq!(state.apply(old_command), Err(LinkMutationError::StaleFence));
        let current_command = make_command(
            &state,
            Actor::Board {
                organization_id: "org-a".to_owned(),
                principal_id: "board-a".to_owned(),
            },
            Operation::Attach,
            3,
            5,
            "current-command",
        );
        assert_eq!(
            state.apply(current_command),
            Err(LinkMutationError::Cancelled)
        );

        assert!(matches!(
            state.apply(cancel).unwrap(),
            LinkMutationOutcome::AlreadyApplied {
                version: 3,
                fence_epoch: 5,
                cancelled: true,
                ..
            }
        ));
    }
}
