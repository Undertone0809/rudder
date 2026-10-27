use super::*;
#[derive(Debug)]
pub(super) enum BoardRead {
    Secret(bool),
    Calendar(&'static str, Option<String>),
    Saved(Option<String>),
    Backup(Option<(String, &'static str)>),
}
#[derive(Debug)]
pub(super) enum Endpoint {
    LiveOrg(String),
    LiveIssue(String),
    Board(String, BoardRead),
}
pub(super) fn endpoint(path: &str, method: &Method) -> Option<Endpoint> {
    if !matches!(*method, Method::GET | Method::HEAD) {
        return None;
    }
    let path = path.strip_prefix('/')?;
    let raw = path
        .strip_suffix('/')
        .unwrap_or(path)
        .split('/')
        .collect::<Vec<_>>();
    if raw.iter().any(|part| part.is_empty()) {
        return None;
    }
    let lower = raw
        .iter()
        .map(|p| p.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let parts = lower.iter().map(String::as_str).collect::<Vec<_>>();
    match parts.as_slice() {
        ["api", "issues", _, "live-runs"] => Some(Endpoint::LiveIssue(raw[2].into())),
        ["api", "orgs", _, tail @ ..] => {
            let read = match *tail {
                ["live-runs"] => return Some(Endpoint::LiveOrg(raw[2].into())),
                ["secret-providers"] => BoardRead::Secret(true),
                ["secrets"] => BoardRead::Secret(false),
                ["calendar", "sources"] => BoardRead::Calendar("source.list", None),
                ["calendar", "events"] => BoardRead::Calendar("event.list", None),
                ["calendar", "events", _] => {
                    BoardRead::Calendar("event.detail", Some(raw[5].into()))
                }
                ["messenger", "saved-views"] => BoardRead::Saved(None),
                ["messenger", "saved-views", _] => BoardRead::Saved(Some(raw[5].into())),
                ["workspace", "backups"] => BoardRead::Backup(None),
                ["workspace", "backups", _, "files"] => {
                    BoardRead::Backup(Some((raw[5].into(), "files")))
                }
                ["workspace", "backups", _, "file"] => {
                    BoardRead::Backup(Some((raw[5].into(), "file")))
                }
                ["workspace", "backups", _, "download"] => {
                    BoardRead::Backup(Some((raw[5].into(), "download")))
                }
                _ => return None,
            };
            Some(Endpoint::Board(raw[2].into(), read))
        }
        _ => None,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reserves_thirteen_shapes_and_leaves_writes_oauth_and_messenger_aggregates() {
        for path in [
            "/api/issues/i/live-runs",
            "/api/orgs/o/live-runs",
            "/api/orgs/o/secret-providers",
            "/api/orgs/o/secrets",
            "/api/orgs/o/calendar/sources",
            "/api/orgs/o/calendar/events",
            "/api/orgs/o/calendar/events/e",
            "/api/orgs/o/messenger/saved-views",
            "/api/orgs/o/messenger/saved-views/s",
            "/api/orgs/o/workspace/backups",
            "/api/orgs/o/workspace/backups/b/files",
            "/api/orgs/o/workspace/backups/b/file",
            "/api/orgs/o/workspace/backups/b/download",
        ] {
            assert!(endpoint(path, &Method::GET).is_some(), "{path}");
            assert!(endpoint(&format!("{}/", path.to_uppercase()), &Method::HEAD).is_some());
            assert!(endpoint(path, &Method::POST).is_none());
        }
        for path in [
            "/api/orgs/o/calendar/google/config",
            "/api/orgs/o/messenger/groups",
            "/api/chats/c/messages",
            "/api/orgs/o/workspace/backups/b/restore",
        ] {
            assert!(endpoint(path, &Method::GET).is_none())
        }
    }
}
