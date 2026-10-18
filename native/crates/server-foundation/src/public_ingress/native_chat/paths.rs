//! Routing ownership for the Rust Chat stream namespace.
//!
//! Call `reserved_path` before the compatibility proxy, independently of the
//! request method. Exact handlers must additionally compare the raw URI path
//! with their canonical path before reading input or performing a mutation.

/// Includes the existing-chat send, checkpoint, Stop and replay namespace, and
/// the organization-scoped first-send namespace. Future suffixes remain owned
/// by Rust even before a handler is available.
pub(super) fn reserved_path(path: &str) -> bool {
    // Actix/Express decode route literals and captures once. Decode the full
    // path here as well so encoded slashes cannot escape namespace ownership.
    // Empty components are ignored only for reservation, never for admission.
    let decoded = percent_encoding::percent_decode_str(path).decode_utf8_lossy();
    let parts: Vec<_> = decoded.split('/').filter(|part| !part.is_empty()).collect();
    if !part(&parts, 0, "api") {
        return false;
    }
    (parts.len() >= 5
        && part(&parts, 1, "chats")
        && part(&parts, 3, "messages")
        && part(&parts, 4, "stream"))
        || (parts.len() >= 6
            && part(&parts, 1, "orgs")
            && part(&parts, 3, "chats")
            && part(&parts, 4, "messages")
            && part(&parts, 5, "stream"))
}

/// Keep capability negotiation out of the Node compatibility proxy even when
/// Native Chat is disabled. An exact `route_not_found` is the only signal that
/// lets an older ingress select its legacy first-send path.
pub(super) fn capability_path(path: &str) -> bool {
    let decoded = percent_encoding::percent_decode_str(path).decode_utf8_lossy();
    let parts: Vec<_> = decoded.split('/').filter(|part| !part.is_empty()).collect();
    parts.len() == 3
        && part(&parts, 0, "api")
        && part(&parts, 1, "native-chat")
        && part(&parts, 2, "capabilities")
}

fn part(parts: &[&str], index: usize, expected: &str) -> bool {
    parts
        .get(index)
        .is_some_and(|value| value.eq_ignore_ascii_case(expected))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_and_alias_stream_routes_never_fall_back() {
        for path in [
            "/api/chats/chat/messages/stream",
            "/api/chats/chat/messages/stream/stop",
            "/api/chats/chat/messages/stream/checkpoint",
            "/api/chats/chat/messages/stream/events",
            "/api/chats/chat/messages/stream/reconcile",
            "/api/chats/chat/messages/stream/unknown/suffix",
            "/API/CHATS/chat/MESSAGES/STREAM/STOP/",
            "/api//chats/chat//messages/stream/",
            "/%61pi/ch%61ts/chat/messages/str%65am/stop",
            "/api/chats/chat/messages%2fstream%2fstop",
            "/api/orgs/org/chats/messages/stream",
            "/api/orgs/org/chats/messages/stream/unknown",
            "/API/ORGS/org/CHATS/MESSAGES/STREAM/",
            "/api/orgs/org/chats/messages%2Fstream",
        ] {
            assert!(reserved_path(path), "{path}");
        }
    }

    #[test]
    fn adjacent_routes_keep_their_existing_owner() {
        for path in [
            "/api/chats/chat/messages",
            "/api/chats/chat/messages/streaming",
            "/api/chats/chat/messages/stream-extra",
            "/api/chats/chat/runtime-binding",
            "/api/orgs/org/chats",
            "/api/orgs/org/chats/messages/streaming",
            "/other/api/chats/chat/messages/stream",
            "/api/projects/project/messages/stream",
            "/api/chats/messages/stream",
            "",
        ] {
            assert!(!reserved_path(path), "{path}");
        }
    }
}
