//! Native ownership of the existing Desktop browser/computer broker lease.
//! Electron executes the UI primitive; registration, revocation, deadlines and
//! bounded forwarding remain server responsibilities and never run in Node.
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::sync::watch;

pub(crate) use rudder_agent_request_planner::desktop_contract::DesktopSurface as Kind;
#[derive(Debug)]
pub(crate) struct BrokerError {
    pub code: String,
    pub message: String,
}
impl BrokerError {
    fn new(kind: Kind, suffix: &str, message: impl Into<String>) -> Self {
        Self {
            code: format!("{}_{suffix}", kind.prefix()),
            message: message.into(),
        }
    }
}
#[derive(Clone)]
struct Registration {
    endpoint: String,
    token: String,
    owner: Option<String>,
    generation: Option<u64>,
    last_seen: Instant,
}
impl Registration {
    fn key(&self) -> Option<String> {
        Some(format!(
            "{}:{}:{}",
            self.owner.as_deref()?,
            self.generation?,
            self.token
        ))
    }
}
struct State {
    active: Option<Registration>,
    retired: VecDeque<(String, &'static str)>,
}
pub(crate) struct DesktopBroker {
    kind: Kind,
    state: Mutex<State>,
    changed: watch::Sender<u64>,
    client: reqwest::Client,
}
impl DesktopBroker {
    pub(crate) fn new(kind: Kind) -> Result<Self, reqwest::Error> {
        let (changed, _) = watch::channel(0);
        Ok(Self {
            kind,
            state: Mutex::new(State {
                active: None,
                retired: VecDeque::new(),
            }),
            changed,
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .build()?,
        })
    }
    fn retire(&self, state: &mut State, reason: &'static str) {
        if let Some(key) = state.active.as_ref().and_then(Registration::key) {
            state.retired.push_back((key, reason));
            if self.kind == Kind::Browser && state.retired.len() > 64 {
                state.retired.pop_front();
            }
        }
        state.active = None;
        self.changed
            .send_modify(|version| *version = version.wrapping_add(1));
    }
    fn expire(&self, state: &mut State) {
        if self.kind == Kind::Computer
            && state
                .active
                .as_ref()
                .is_some_and(|r| r.last_seen.elapsed() > Duration::from_secs(20))
        {
            // Expiration permits the same owner to refresh; it is not revocation.
            state.active = None;
            self.changed
                .send_modify(|version| *version = version.wrapping_add(1));
        }
    }
    pub(crate) fn register(&self, input: &Value) -> Result<(), BrokerError> {
        let invalid = || {
            BrokerError::new(
                self.kind,
                "broker_invalid_registration",
                format!("{} Broker registration is invalid.", self.kind.title()),
            )
        };
        let object = input.as_object().ok_or_else(invalid)?;
        if object.keys().any(|key| {
            !matches!(
                key.as_str(),
                "endpoint" | "token" | "ownerId" | "generation" | "refresh"
            )
        }) {
            return Err(invalid());
        }
        let endpoint = object
            .get("endpoint")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 2048)
            .ok_or_else(invalid)?;
        let endpoint_error =
            |message| BrokerError::new(self.kind, "broker_invalid_registration", message);
        let url = url::Url::parse(endpoint).map_err(|_| {
            endpoint_error(match self.kind {
                Kind::Browser => "Browser Broker endpoint must be a valid loopback HTTP URL.",
                Kind::Computer => "Computer Broker endpoint is invalid.",
            })
        })?;
        if self.kind == Kind::Browser {
            if url.scheme() != "http"
                || !matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "::1"))
            {
                return Err(endpoint_error(
                    "Browser Broker endpoint must use loopback HTTP.",
                ));
            }
            if url.port().is_none() {
                return Err(endpoint_error(
                    "Browser Broker endpoint must use an explicit loopback port.",
                ));
            }
            if !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(endpoint_error(
                    "Browser Broker endpoint cannot contain credentials, query parameters, or a fragment.",
                ));
            }
        } else if url.scheme() != "http"
            || !matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "::1"))
            || url.port().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(endpoint_error(
                "Computer Broker endpoint must be an explicit loopback HTTP URL.",
            ));
        }
        let raw_token = object
            .get("token")
            .and_then(Value::as_str)
            .filter(|s| (32..=512).contains(&s.encode_utf16().count()))
            .ok_or_else(invalid)?;
        let token = raw_token.trim();
        if !(32..=512).contains(&token.encode_utf16().count())
            || token.chars().any(char::is_whitespace)
        {
            return Err(BrokerError::new(
                self.kind,
                "broker_invalid_registration",
                format!("{} Broker credential is invalid.", self.kind.title()),
            ));
        }
        let owner = match object.get("ownerId") {
            None => None,
            Some(Value::String(value)) if uuid::Uuid::parse_str(value).is_ok() => {
                Some(value.clone())
            }
            _ => return Err(invalid()),
        };
        let generation = match object.get("generation") {
            None => None,
            Some(value) => Some(
                value
                    .as_u64()
                    .filter(|n| *n >= 1 && *n <= 9_007_199_254_740_991)
                    .ok_or_else(invalid)?,
            ),
        };
        if owner.is_some() != generation.is_some() {
            return Err(invalid());
        }
        let refresh = match object.get("refresh") {
            None => false,
            Some(Value::Bool(value)) => *value,
            _ => return Err(invalid()),
        };
        if refresh && owner.is_none() {
            return Err(invalid());
        }
        let next = Registration {
            endpoint: url.to_string(),
            token: token.to_owned(),
            owner,
            generation,
            last_seen: Instant::now(),
        };
        let mut state = self.state.lock().map_err(|_| {
            BrokerError::new(
                self.kind,
                "unavailable",
                "Desktop Broker registry is unavailable.",
            )
        })?;
        self.expire(&mut state);
        let key = next.key();
        let retired = key.as_ref().and_then(|key| {
            state
                .retired
                .iter()
                .rev()
                .find(|(old, _)| old == key)
                .map(|(_, reason)| *reason)
        });
        if refresh && retired.is_some() {
            return Err(BrokerError::new(
                self.kind,
                if retired == Some("revoked") {
                    "broker_revoked_registration"
                } else {
                    "broker_stale_registration"
                },
                match self.kind {
                    Kind::Computer => {
                        "Computer Broker registration no longer owns the Desktop lifecycle."
                            .to_owned()
                    }
                    Kind::Browser if retired == Some("revoked") => {
                        "Browser Broker registration was revoked and must reconnect.".to_owned()
                    }
                    Kind::Browser => {
                        "Browser Broker refresh no longer owns the active Desktop lifecycle."
                            .to_owned()
                    }
                },
            ));
        }
        if let Some(active) = state.active.as_mut() {
            if refresh && active.key() != key {
                return Err(BrokerError::new(
                    self.kind,
                    "broker_stale_registration",
                    match self.kind {
                        Kind::Browser => {
                            "Browser Broker refresh no longer owns the active Desktop lifecycle."
                        }
                        Kind::Computer => "Computer Broker registration is stale.",
                    },
                ));
            }
            if next.owner.is_none() && active.owner.is_some() {
                return Err(BrokerError::new(
                    self.kind,
                    "broker_stale_registration",
                    match self.kind {
                        Kind::Browser => {
                            "Legacy Browser Broker registration cannot replace an owned Desktop lifecycle."
                        }
                        Kind::Computer => "Legacy registration cannot replace Desktop ownership.",
                    },
                ));
            }
            if active.owner.is_some() && active.owner == next.owner {
                if next.generation < active.generation
                    || (next.generation == active.generation && next.token != active.token)
                {
                    return Err(BrokerError::new(
                        self.kind,
                        "broker_stale_registration",
                        match self.kind {
                            Kind::Browser => {
                                "Browser Broker registration was superseded by a newer Desktop lifecycle."
                            }
                            Kind::Computer => "Computer Broker registration was superseded.",
                        },
                    ));
                }
                if next.generation == active.generation && next.token == active.token {
                    if self.kind == Kind::Computer {
                        active.last_seen = Instant::now();
                    }
                    return Ok(());
                }
            }
        }
        self.retire(&mut state, "superseded");
        state.active = Some(next);
        Ok(())
    }
    pub(crate) fn unregister(&self, token: &str) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if !state.active.as_ref().is_some_and(|r| r.token == token) {
            return false;
        }
        self.retire(&mut state, "revoked");
        true
    }
    pub(crate) fn is_available(&self) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        self.expire(&mut state);
        state.active.is_some()
    }
    pub(crate) async fn forward(&self, command: &Value) -> Result<Value, BrokerError> {
        let (registration, mut changed) = {
            let mut state = self.state.lock().map_err(|_| {
                BrokerError::new(
                    self.kind,
                    "unavailable",
                    "Desktop Broker registry is unavailable.",
                )
            })?;
            self.expire(&mut state);
            let registration = state.active.clone().ok_or_else(|| {
                BrokerError::new(
                    self.kind,
                    "unavailable",
                    match self.kind {
                        Kind::Browser => {
                            "Rudder Browser is unavailable because Desktop is not connected."
                        }
                        Kind::Computer => "Rudder Desktop Computer Use is not connected.",
                    },
                )
            })?;
            (registration, self.changed.subscribe())
        };
        let request = async {
            let mut response = self
                .client
                .post(&registration.endpoint)
                .bearer_auth(&registration.token)
                .header("accept", "application/json")
                .json(command)
                .send()
                .await
                .map_err(|_| {
                    BrokerError::new(
                        self.kind,
                        "unavailable",
                        match self.kind {
                            Kind::Browser => "Rudder Browser Desktop Broker could not be reached.",
                            Kind::Computer => {
                                "Rudder Desktop Computer Broker could not be reached."
                            }
                        },
                    )
                })?;
            let limit = self.kind.max_response();
            let oversized = || {
                BrokerError::new(
                    self.kind,
                    if self.kind == Kind::Browser {
                        "broker_protocol_error"
                    } else {
                        "result_too_large"
                    },
                    match self.kind {
                        Kind::Browser => {
                            "Rudder Browser Desktop Broker response exceeded the size limit."
                        }
                        Kind::Computer => "Computer Broker response exceeded the size limit.",
                    },
                )
            };
            if response
                .content_length()
                .is_some_and(|size| size > limit as u64)
            {
                return Err(oversized());
            }
            let success = response.status().is_success();
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| {
                BrokerError::new(
                    self.kind,
                    "broker_protocol_error",
                    match self.kind {
                        Kind::Browser => {
                            "Rudder Browser Desktop Broker returned an invalid response."
                        }
                        Kind::Computer => "Computer Broker returned an invalid response.",
                    },
                )
            })? {
                if bytes.len().saturating_add(chunk.len()) > limit {
                    return Err(oversized());
                }
                bytes.extend_from_slice(&chunk);
            }
            let payload: Value = serde_json::from_slice(&bytes).map_err(|_| {
                BrokerError::new(
                    self.kind,
                    "broker_protocol_error",
                    match self.kind {
                        Kind::Browser => {
                            "Rudder Browser Desktop Broker returned an invalid response."
                        }
                        Kind::Computer => "Computer Broker returned an invalid response.",
                    },
                )
            })?;
            if !success || payload["ok"] != true {
                let prefix = format!("{}_", self.kind.prefix());
                let code = payload["error"]["code"]
                    .as_str()
                    .filter(|s| {
                        s.starts_with(&prefix)
                            && s.len() > prefix.len()
                            && s[prefix.len()..]
                                .chars()
                                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
                    })
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("{}_broker_error", self.kind.prefix()));
                let message = payload["error"]["message"]
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.chars().take(300).collect())
                    .unwrap_or_else(|| match self.kind {
                        Kind::Browser => "Rudder Browser action failed.".to_owned(),
                        Kind::Computer => "Computer Use action failed.".to_owned(),
                    });
                return Err(BrokerError { code, message });
            }
            Ok(payload
                .get("result")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or_else(|| json!({})))
        };
        tokio::select! {
            result=tokio::time::timeout(Duration::from_secs(40),request)=>result.unwrap_or_else(|_|Err(BrokerError::new(self.kind,if self.kind==Kind::Browser{"unavailable"}else{"timeout"},match self.kind {Kind::Browser=>"Rudder Browser Desktop Broker timed out.",Kind::Computer=>"Computer Use action timed out."}))),
            _=changed.changed()=>Err(BrokerError::new(self.kind,"unavailable",match self.kind {Kind::Browser=>"Rudder Browser Desktop Broker could not be reached.",Kind::Computer=>"Rudder Desktop Computer Broker could not be reached."}))
        }
    }
}

pub(crate) struct DesktopBrokers {
    pub browser: std::sync::Arc<DesktopBroker>,
    pub computer: std::sync::Arc<DesktopBroker>,
}
impl DesktopBrokers {
    pub(crate) fn new() -> Result<Self, reqwest::Error> {
        Ok(Self {
            browser: std::sync::Arc::new(DesktopBroker::new(Kind::Browser)?),
            computer: std::sync::Arc::new(DesktopBroker::new(Kind::Computer)?),
        })
    }
    pub(crate) fn get(&self, kind: Kind) -> &DesktopBroker {
        match kind {
            Kind::Browser => &self.browser,
            Kind::Computer => &self.computer,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registration_errors_preserve_existing_public_broker_messages() {
        let token = "a".repeat(32);
        for (kind, endpoint, expected) in [
            (
                Kind::Browser,
                "invalid",
                "Browser Broker endpoint must be a valid loopback HTTP URL.",
            ),
            (
                Kind::Browser,
                "https://127.0.0.1:12345/",
                "Browser Broker endpoint must use loopback HTTP.",
            ),
            (
                Kind::Browser,
                "http://127.0.0.1/",
                "Browser Broker endpoint must use an explicit loopback port.",
            ),
            (
                Kind::Browser,
                "http://127.0.0.1:12345/?q=1",
                "Browser Broker endpoint cannot contain credentials, query parameters, or a fragment.",
            ),
            (
                Kind::Computer,
                "invalid",
                "Computer Broker endpoint is invalid.",
            ),
            (
                Kind::Computer,
                "https://127.0.0.1:12345/",
                "Computer Broker endpoint must be an explicit loopback HTTP URL.",
            ),
        ] {
            let broker = DesktopBroker::new(kind).unwrap();
            let error = broker
                .register(&json!({"endpoint":endpoint,"token":token}))
                .unwrap_err();
            assert_eq!(
                error.code,
                format!("{}_broker_invalid_registration", kind.prefix())
            );
            assert_eq!(error.message, expected);
        }
        for kind in [Kind::Browser, Kind::Computer] {
            let broker = DesktopBroker::new(kind).unwrap();
            let error = broker.register(&json!({"endpoint":"http://127.0.0.1:12345/","token":"a aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"})).unwrap_err();
            assert_eq!(
                error.message,
                format!("{} Broker credential is invalid.", kind.title())
            );
        }
    }

    #[test]
    fn expired_computer_registration_releases_its_old_generation() {
        let broker = DesktopBroker::new(Kind::Computer).unwrap();
        let owner = uuid::Uuid::new_v4().to_string();
        let token = "a".repeat(32);
        broker.register(&json!({"endpoint":"http://127.0.0.1:12345/","token":token,"ownerId":owner,"generation":2})).unwrap();
        broker
            .state
            .lock()
            .unwrap()
            .active
            .as_mut()
            .unwrap()
            .last_seen -= Duration::from_secs(21);
        broker.register(&json!({"endpoint":"http://127.0.0.1:12345/","token":token,"ownerId":owner,"generation":1})).unwrap();
        assert!(broker.is_available());
    }

    #[test]
    fn revoked_owner_cannot_refresh_and_old_owner_cannot_replace_current_desktop() {
        let broker = DesktopBroker::new(Kind::Browser).unwrap();
        let token = "a".repeat(32);
        let owner = uuid::Uuid::new_v4().to_string();
        let original = json!({"endpoint":"http://127.0.0.1:12345/","token":token,"ownerId":owner,"generation":1});
        broker.register(&original).unwrap();
        assert!(broker.is_available());
        assert!(!broker.unregister(&"b".repeat(32)));
        assert!(broker.is_available());
        assert!(broker.unregister(&token));
        assert!(!broker.is_available());
        let mut refresh = original.clone();
        refresh["refresh"] = json!(true);
        assert_eq!(
            broker.register(&refresh).unwrap_err().code,
            "browser_broker_revoked_registration"
        );
        let mut replacement = original.clone();
        replacement["generation"] = json!(2);
        replacement["token"] = json!("b".repeat(32));
        broker.register(&replacement).unwrap();
        assert_eq!(
            broker.register(&original).unwrap_err().code,
            "browser_broker_stale_registration"
        );
    }
    #[test]
    fn broker_registration_never_accepts_remote_hosts_credentials_or_unpaired_generations() {
        let broker = DesktopBroker::new(Kind::Computer).unwrap();
        for endpoint in [
            "https://127.0.0.1:1234/",
            "http://example.com:1234/",
            "http://127.0.0.1/",
            "http://user:pass@127.0.0.1:1234/",
            "http://127.0.0.1:1234/?token=secret",
        ] {
            assert!(
                broker
                    .register(&json!({"endpoint":endpoint,"token":"a".repeat(32)}))
                    .is_err()
            );
        }
        assert!(broker.register(&json!({"endpoint":"http://127.0.0.1:1234/","token":"a".repeat(32),"generation":1})).is_err());
    }
}
