//! Verified actor adapter for the shared SQL visibility authority.
use crate::VerifiedActor;
pub(super) use rudder_d1_persistence::run_visibility::{scoped_query, unbound_workspace_visible};

pub(super) fn owner(actor: &VerifiedActor) -> Option<&str> {
    (actor.actor().kind == "user").then_some(actor.actor().id.as_str())
}
