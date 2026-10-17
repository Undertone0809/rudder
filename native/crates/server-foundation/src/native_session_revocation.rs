//! Process-local effects for revoking authenticated local-account WebSockets.
//!
//! This registry does not authorize a request or mutate session storage. The
//! caller publishes only after its session-revocation transaction commits.

use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex, MutexGuard},
};

use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::sync::oneshot;

const MAX_TRACKED_UPGRADES: usize = 2_048;
const MAX_PENDING_UPGRADES: usize = 512;
const MAX_REVOCATION_EVENTS: usize = 4_096;

type UserKey = [u8; 32];

#[derive(Clone, Default)]
pub struct NativeSessionRevocationRegistry {
    inner: Arc<Mutex<RegistryState>>,
}

#[derive(Default)]
struct RegistryState {
    sequence: u128,
    next_registration_id: u128,
    pending_upgrades: usize,
    active_upgrades: usize,
    events: VecDeque<RevocationEvent>,
    active_by_user: HashMap<UserKey, HashMap<u128, oneshot::Sender<()>>>,
}

struct RevocationEvent {
    sequence: u128,
    user_key: UserKey,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub(crate) enum SessionRevocationUpgradeError {
    #[error("session revocation upgrade capacity is exhausted")]
    CapacityExceeded,
    #[error("the local account session changed while its websocket was authorizing")]
    RevokedDuringAuthorization,
    #[error("the session revocation history expired during websocket authorization")]
    RevocationHistoryExpired,
}

impl NativeSessionRevocationRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts tracking before any asynchronous authentication work begins.
    /// The ticket is bounded and must be bound to a verified local-account
    /// user before it can register an active connection.
    pub(crate) fn begin_upgrade(
        &self,
    ) -> Result<PendingSessionUpgrade, SessionRevocationUpgradeError> {
        let mut state = lock(&self.inner);
        if state.pending_upgrades >= MAX_PENDING_UPGRADES
            || state.pending_upgrades + state.active_upgrades >= MAX_TRACKED_UPGRADES
        {
            return Err(SessionRevocationUpgradeError::CapacityExceeded);
        }
        state.pending_upgrades += 1;
        Ok(PendingSessionUpgrade {
            inner: self.inner.clone(),
            sequence: state.sequence,
            pending: true,
        })
    }

    /// Publishes a committed sign-out effect. Only active sockets for this
    /// user are cancelled; a bounded sequence journal protects upgrades whose
    /// identity is still being resolved.
    pub fn publish_user_revocation(&self, user_id: &str) -> usize {
        if user_id.is_empty() {
            return 0;
        }
        let user_key = user_key(user_id);
        let senders = {
            let mut state = lock(&self.inner);
            state.sequence = state
                .sequence
                .checked_add(1)
                .expect("session revocation sequence exhausted");
            let sequence = state.sequence;
            if state.events.len() == MAX_REVOCATION_EVENTS {
                state.events.pop_front();
            }
            state
                .events
                .push_back(RevocationEvent { sequence, user_key });

            let senders = state.active_by_user.remove(&user_key).unwrap_or_default();
            state.active_upgrades = state.active_upgrades.saturating_sub(senders.len());
            senders.into_values().collect::<Vec<_>>()
        };

        let count = senders.len();
        for sender in senders {
            let _ = sender.send(());
        }
        count
    }
}

pub(crate) struct PendingSessionUpgrade {
    inner: Arc<Mutex<RegistryState>>,
    sequence: u128,
    pending: bool,
}

impl PendingSessionUpgrade {
    /// Atomically checks revocations since `begin_upgrade` and registers the
    /// live connection. A revocation racing with authentication therefore
    /// either rejects this bind or cancels the returned registration.
    pub(crate) fn bind(
        mut self,
        user_id: &str,
    ) -> Result<SessionRevocationRegistration, SessionRevocationUpgradeError> {
        let user_key = user_key(user_id);
        let mut state = lock(&self.inner);
        state.pending_upgrades = state.pending_upgrades.saturating_sub(1);
        self.pending = false;

        if history_missed_since(&state, self.sequence) {
            return Err(SessionRevocationUpgradeError::RevocationHistoryExpired);
        }
        if state
            .events
            .iter()
            .any(|event| event.sequence > self.sequence && event.user_key == user_key)
        {
            return Err(SessionRevocationUpgradeError::RevokedDuringAuthorization);
        }

        let id = state.next_registration_id;
        state.next_registration_id = state
            .next_registration_id
            .checked_add(1)
            .expect("session revocation registration sequence exhausted");
        let (cancel_sender, cancel_receiver) = oneshot::channel();
        state
            .active_by_user
            .entry(user_key)
            .or_default()
            .insert(id, cancel_sender);
        state.active_upgrades += 1;

        Ok(SessionRevocationRegistration {
            inner: self.inner.clone(),
            user_key,
            id,
            cancel_receiver,
        })
    }
}

impl Drop for PendingSessionUpgrade {
    fn drop(&mut self) {
        if self.pending {
            let mut state = lock(&self.inner);
            state.pending_upgrades = state.pending_upgrades.saturating_sub(1);
        }
    }
}

pub(crate) struct SessionRevocationRegistration {
    inner: Arc<Mutex<RegistryState>>,
    user_key: UserKey,
    id: u128,
    cancel_receiver: oneshot::Receiver<()>,
}

impl SessionRevocationRegistration {
    pub(crate) async fn cancelled(&mut self) {
        let _ = (&mut self.cancel_receiver).await;
    }

    pub(crate) fn is_cancelled(&mut self) -> bool {
        match self.cancel_receiver.try_recv() {
            Ok(()) | Err(oneshot::error::TryRecvError::Closed) => true,
            Err(oneshot::error::TryRecvError::Empty) => false,
        }
    }
}

impl Drop for SessionRevocationRegistration {
    fn drop(&mut self) {
        let mut state = lock(&self.inner);
        let (removed, empty) = match state.active_by_user.get_mut(&self.user_key) {
            Some(registrations) => {
                let removed = registrations.remove(&self.id).is_some();
                (removed, registrations.is_empty())
            }
            None => (false, false),
        };
        if removed {
            state.active_upgrades = state.active_upgrades.saturating_sub(1);
        }
        if empty {
            state.active_by_user.remove(&self.user_key);
        }
    }
}

fn history_missed_since(state: &RegistryState, sequence: u128) -> bool {
    if state.sequence <= sequence {
        return false;
    }
    let Some(oldest) = state.events.front() else {
        return true;
    };
    oldest.sequence > sequence.saturating_add(1)
}

fn user_key(user_id: &str) -> UserKey {
    Sha256::digest(user_id.as_bytes()).into()
}

fn lock(mutex: &Mutex<RegistryState>) -> MutexGuard<'_, RegistryState> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_REVOCATION_EVENTS, NativeSessionRevocationRegistry, SessionRevocationUpgradeError,
    };

    #[test]
    fn revocation_during_async_authorization_rejects_only_the_target_user() {
        let registry = NativeSessionRevocationRegistry::new();
        let first = registry.begin_upgrade().unwrap();
        let second = registry.begin_upgrade().unwrap();

        registry.publish_user_revocation("signed-out-user");

        assert_eq!(
            first.bind("signed-out-user").err().unwrap(),
            SessionRevocationUpgradeError::RevokedDuringAuthorization
        );
        assert!(second.bind("other-user").is_ok());
    }

    #[test]
    fn revocation_cancels_all_and_only_registered_sockets_for_that_user() {
        let registry = NativeSessionRevocationRegistry::new();
        let mut first = registry
            .begin_upgrade()
            .unwrap()
            .bind("signed-out-user")
            .unwrap();
        let mut second = registry
            .begin_upgrade()
            .unwrap()
            .bind("signed-out-user")
            .unwrap();
        let mut other = registry
            .begin_upgrade()
            .unwrap()
            .bind("other-user")
            .unwrap();

        assert_eq!(registry.publish_user_revocation("signed-out-user"), 2);
        assert!(first.is_cancelled());
        assert!(second.is_cancelled());
        assert!(!other.is_cancelled());
    }

    #[test]
    fn revocation_journal_is_bounded_and_old_pending_tickets_fail_closed() {
        let registry = NativeSessionRevocationRegistry::new();
        let pending = registry.begin_upgrade().unwrap();

        for index in 0..=MAX_REVOCATION_EVENTS {
            registry.publish_user_revocation(&format!("user-{index}"));
        }

        assert_eq!(
            pending.bind("unrelated-user").err().unwrap(),
            SessionRevocationUpgradeError::RevocationHistoryExpired
        );
    }

    #[test]
    fn dropping_pending_ticket_releases_capacity() {
        let registry = NativeSessionRevocationRegistry::new();
        let pending = registry.begin_upgrade().unwrap();
        drop(pending);

        let pending = registry.begin_upgrade().unwrap();
        assert!(pending.bind("user").is_ok());
    }
}
