//! Verified actor adapter for the shared SQL visibility authority.
use crate::VerifiedActor;

pub(super) fn owner(actor: &VerifiedActor) -> Option<&str> {
    (actor.actor().kind == "user").then_some(actor.actor().id.as_str())
}
