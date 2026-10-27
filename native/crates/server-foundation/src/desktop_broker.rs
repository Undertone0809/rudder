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
        let url = url::Url::parse(endpoint).map_err(|_| invalid())?;
        if url.scheme() != "http"
            || !matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "::1"))
            || url.port().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(invalid());
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
            return Err(invalid());
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
                if retired == Some("revoked") {
                    format!(
                        "{} Broker registration was revoked and must reconnect.",
                        self.kind.title()
                    )
                } else {
                    format!("{} Broker registration is stale.", self.kind.title())
                },
            ));
        }
        if let Some(active) = state.active.as_mut() {
            if refresh && active.key() != key {
                return Err(BrokerError::new(
                    self.kind,
                    "broker_stale_registration",
                    format!("{} Broker registration is stale.", self.kind.title()),
                ));
            }
            if next.owner.is_none() && active.owner.is_some() {
                return Err(BrokerError::new(
                    self.kind,
                    "broker_stale_registration",
                    format!(
                        "Legacy {} Broker registration cannot replace an owned Desktop lifecycle.",
                        self.kind.title()
                    ),
                ));
            }
            if active.owner.is_some() && active.owner == next.owner {
                if next.generation < active.generation
                    || (next.generation == active.generation && next.token != active.token)
                {
                    return Err(BrokerError::new(
                        self.kind,
                        "broker_stale_registration",
                        format!("{} Broker registration was superseded.", self.kind.title()),
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
    pub(crate) fn revoke(&self) {
        if let Ok(mut state) = self.state.lock() {
            self.retire(&mut state, "revoked");
        }
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
                        format!(
                            "Rudder Desktop {} Broker could not be reached.",
                            self.kind.title()
                        ),
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
                    format!(
                        "{} Broker response exceeded the size limit.",
                        self.kind.title()
                    ),
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
                    format!("{} Broker returned an invalid response.", self.kind.title()),
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
                    format!("{} Broker returned an invalid response.", self.kind.title()),
                )
            })?;
            if !success || payload["ok"] != true {
                let prefix = format!("{}_", self.kind.prefix());
                let code = payload["error"]["code"]
                    .as_str()
                    .filter(|s| {
                        s.starts_with(&prefix)
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
                    .unwrap_or_else(|| format!("{} action failed.", self.kind.title()));
                return Err(BrokerError { code, message });
            }
            Ok(payload
                .get("result")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or_else(|| json!({})))
        };
        tokio::select! {
            result=tokio::time::timeout(Duration::from_secs(40),request)=>result.unwrap_or_else(|_|Err(BrokerError::new(self.kind,if self.kind==Kind::Browser{"unavailable"}else{"timeout"},format!("{} action timed out.",self.kind.title())))),
            _=changed.changed()=>Err(BrokerError::new(self.kind,"unavailable",format!("{} Broker registration changed.",self.kind.title())))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
