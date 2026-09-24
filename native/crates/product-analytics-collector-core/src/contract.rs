use crate::error::CollectorError;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

pub const MAX_BATCH_EVENTS: usize = 100;
pub const MAX_BATCH_BYTES: usize = 64 * 1024;
pub const MAX_EVENT_BYTES: usize = 2 * 1024;
pub const MAX_FUTURE_SKEW_SECONDS: i64 = 24 * 60 * 60;
pub const MAX_LATE_EVENT_SECONDS: i64 = 30 * 24 * 60 * 60;

pub const EVENT_NAMES: &[&str] = &[
    "organization_created",
    "issue_created",
    "chat_created",
    "human_work_started",
    "run_started",
    "run_succeeded",
    "run_failed",
    "output_ready",
    "review_decision_recorded",
    "account_created",
    "desktop_authorized",
    "local_server_connected",
    "first_agent_ready",
    "work_loop_completed",
    "work_loop_invalidated",
];

const REQUIRED_EVENT_KEYS: &[&str] = &[
    "eventId",
    "eventName",
    "schemaVersion",
    "occurredAt",
    "environment",
    "appVersion",
    "releaseChannel",
    "deploymentMode",
    "actorKind",
    "origin",
    "pseudonymousInstallationId",
    "pseudonymousOrgId",
    "pseudonymousWorkId",
    "pseudonymousWorkCycleId",
    "pseudonymousRootRunId",
    "pseudonymousRunId",
    "completionRevision",
    "properties",
    "confidence",
    "isBackfill",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Authorization {
    pub installation_id: String,
    pub mode: AuthorizationMode,
    pub consent_version: String,
    pub consent_epoch: u64,
    pub analytics_subject: Option<String>,
    pub pseudonymous_installation_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorizationMode {
    Anonymous,
    AccountLinked,
}

#[derive(Clone, Debug)]
pub struct ValidatedEvent {
    pub event_id: String,
    pub event_name: String,
    pub occurred_at: OffsetDateTime,
    pub occurred_at_raw: String,
    pub environment: String,
    pub app_version: String,
    pub release_channel: String,
    pub deployment_mode: String,
    pub actor_kind: String,
    pub origin: String,
    pub pseudonymous_installation_id: String,
    pub pseudonymous_org_id: Option<String>,
    pub pseudonymous_work_id: Option<String>,
    pub pseudonymous_work_cycle_id: Option<String>,
    pub pseudonymous_root_run_id: Option<String>,
    pub pseudonymous_run_id: Option<String>,
    pub completion_revision: Option<i32>,
    pub properties: Map<String, Value>,
    pub confidence: String,
    pub is_backfill: bool,
    pub late: bool,
    pub payload_sha256: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventAck {
    pub event_id: String,
    pub status: AckStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<AckErrorCode>,
    pub late: bool,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AckStatus {
    Accepted,
    Duplicate,
    Rejected,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AckErrorCode {
    InvalidSchema,
    InvalidEvent,
    FutureEvent,
    Revoked,
    Conflict,
    TooLarge,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResponse {
    pub accepted: usize,
    pub duplicate: usize,
    pub rejected: Vec<EventAck>,
    pub received_at: String,
}

pub fn validate_event(value: &Value, now: OffsetDateTime) -> Result<ValidatedEvent, EventAck> {
    let object = match value.as_object() {
        Some(value) => value,
        None => return Err(rejected("unknown", AckErrorCode::InvalidSchema, false)),
    };
    let mut actual = object.keys().map(String::as_str).collect::<Vec<_>>();
    actual.sort_unstable();
    let mut required = REQUIRED_EVENT_KEYS.to_vec();
    required.sort_unstable();
    let event_id_for_error = object
        .get("eventId")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    if actual != required {
        return Err(rejected(
            event_id_for_error,
            AckErrorCode::InvalidSchema,
            false,
        ));
    }
    let event_id = match object.get("eventId").and_then(Value::as_str) {
        Some(value) if is_uuid_like(value) => value.to_owned(),
        _ => return Err(rejected("unknown", AckErrorCode::InvalidSchema, false)),
    };
    let event_name = required_string(object, "eventName").unwrap_or_default();
    if !EVENT_NAMES.contains(&event_name.as_str())
        || object.get("schemaVersion").and_then(Value::as_i64) != Some(1)
    {
        return Err(rejected(&event_id, AckErrorCode::InvalidEvent, false));
    }
    let occurred_at_raw = match required_string(object, "occurredAt") {
        Some(value) => value,
        None => return Err(rejected(&event_id, AckErrorCode::InvalidEvent, false)),
    };
    let occurred_at = match OffsetDateTime::parse(&occurred_at_raw, &Rfc3339) {
        Ok(value) => value,
        Err(_) => return Err(rejected(&event_id, AckErrorCode::InvalidEvent, false)),
    };
    let late = (now - occurred_at).whole_seconds() > MAX_LATE_EVENT_SECONDS;
    if occurred_at > now + time::Duration::seconds(MAX_FUTURE_SKEW_SECONDS) {
        return Err(rejected(&event_id, AckErrorCode::FutureEvent, late));
    }
    let environment = required_string(object, "environment").unwrap_or_default();
    let release_channel = required_string(object, "releaseChannel").unwrap_or_default();
    let deployment_mode = required_string(object, "deploymentMode").unwrap_or_default();
    let actor_kind = required_string(object, "actorKind").unwrap_or_default();
    let origin = required_string(object, "origin").unwrap_or_default();
    let confidence = required_string(object, "confidence").unwrap_or_default();
    if !["production", "development", "test"].contains(&environment.as_str())
        || !["development", "preview", "canary", "stable"].contains(&release_channel.as_str())
        || !["desktop_local", "self_hosted", "remote_server"].contains(&deployment_mode.as_str())
        || !["user", "agent", "system", "automation"].contains(&actor_kind.as_str())
        || !["human", "automation", "retry", "recovery", "system"].contains(&origin.as_str())
        || !["exact", "derived", "unknown"].contains(&confidence.as_str())
        || object
            .get("appVersion")
            .and_then(Value::as_str)
            .is_none_or(|value| value.len() > 80)
        || object.get("isBackfill").and_then(Value::as_bool).is_none()
    {
        return Err(rejected(&event_id, AckErrorCode::InvalidEvent, late));
    }
    let optional_ids = [
        "pseudonymousOrgId",
        "pseudonymousWorkId",
        "pseudonymousWorkCycleId",
        "pseudonymousRootRunId",
        "pseudonymousRunId",
    ];
    for key in optional_ids {
        if let Some(value) = object.get(key).filter(|value| !value.is_null())
            && value.as_str().is_none_or(|value| value.len() > 128)
        {
            return Err(rejected(&event_id, AckErrorCode::InvalidEvent, late));
        }
    }
    let completion_revision = match object.get("completionRevision") {
        Some(Value::Null) => None,
        Some(Value::Number(value)) => match value.as_i64() {
            Some(value) if (1..=i32::MAX as i64).contains(&value) => Some(value as i32),
            _ => return Err(rejected(&event_id, AckErrorCode::InvalidEvent, late)),
        },
        _ => return Err(rejected(&event_id, AckErrorCode::InvalidEvent, late)),
    };
    let properties = match object.get("properties").and_then(Value::as_object) {
        Some(value) => value.clone(),
        None => return Err(rejected(&event_id, AckErrorCode::InvalidEvent, late)),
    };
    for (key, value) in &properties {
        if !property_allowed(&event_name, key)
            || is_sensitive_key(key)
            || !is_scalar(value)
            || value.as_str().is_some_and(|value| value.len() > 80)
            || value.as_f64().is_some_and(|value| !value.is_finite())
        {
            return Err(rejected(&event_id, AckErrorCode::InvalidEvent, late));
        }
    }
    let pseudonymous_installation_id = match object
        .get("pseudonymousInstallationId")
        .and_then(Value::as_str)
    {
        Some(value) if !value.is_empty() && value.len() <= 128 => value.to_owned(),
        _ => return Err(rejected(&event_id, AckErrorCode::InvalidEvent, late)),
    };
    let serialized = serde_json::to_vec(value)
        .map_err(|_| rejected(&event_id, AckErrorCode::InvalidSchema, late))?;
    if serialized.len() > MAX_EVENT_BYTES {
        return Err(rejected(&event_id, AckErrorCode::TooLarge, late));
    }
    Ok(ValidatedEvent {
        event_id,
        event_name,
        occurred_at,
        occurred_at_raw,
        environment,
        app_version: required_string(object, "appVersion").unwrap_or_default(),
        release_channel,
        deployment_mode,
        actor_kind,
        origin,
        pseudonymous_installation_id,
        pseudonymous_org_id: optional_string(object, "pseudonymousOrgId"),
        pseudonymous_work_id: optional_string(object, "pseudonymousWorkId"),
        pseudonymous_work_cycle_id: optional_string(object, "pseudonymousWorkCycleId"),
        pseudonymous_root_run_id: optional_string(object, "pseudonymousRootRunId"),
        pseudonymous_run_id: optional_string(object, "pseudonymousRunId"),
        completion_revision,
        properties,
        confidence,
        is_backfill: object
            .get("isBackfill")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        late,
        payload_sha256: hash_payload(value),
    })
}

pub fn hash_payload(value: &Value) -> String {
    let mut digest = Sha256::new();
    digest.update(canonical_json(value).as_bytes());
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => {
            let text = value.to_string();
            text.strip_suffix(".0").unwrap_or(&text).to_owned()
        }
        Value::String(value) => {
            serde_json::to_string(value).expect("string serialization cannot fail")
        }
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        canonical_json(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

pub fn rejected(event_id: &str, error_code: AckErrorCode, late: bool) -> EventAck {
    EventAck {
        event_id: event_id.to_owned(),
        status: AckStatus::Rejected,
        error_code: Some(error_code),
        late,
    }
}

pub fn duplicate(event_id: &str, late: bool) -> EventAck {
    EventAck {
        event_id: event_id.to_owned(),
        status: AckStatus::Duplicate,
        error_code: None,
        late,
    }
}

pub fn accepted(event_id: &str, late: bool) -> EventAck {
    EventAck {
        event_id: event_id.to_owned(),
        status: AckStatus::Accepted,
        error_code: None,
        late,
    }
}

pub fn batch_size(events: &[Value]) -> Result<usize, CollectorError> {
    serde_json::to_vec(events)
        .map(|bytes| bytes.len())
        .map_err(|_| CollectorError::InvalidRequest("invalid_json"))
}

fn required_string(object: &Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn optional_string(object: &Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .filter(|value| !value.is_null())
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn is_scalar(value: &Value) -> bool {
    matches!(
        value,
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
    )
}

fn is_sensitive_key(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    [
        "prompt",
        "transcript",
        "title",
        "description",
        "body",
        "content",
        "url",
        "token",
        "secret",
        "password",
        "credential",
        "email",
        "hostname",
        "username",
    ]
    .iter()
    .any(|part| value.contains(part))
}

fn property_allowed(event_name: &str, key: &str) -> bool {
    let allowed: &[&str] = match event_name {
        "organization_created" => &[
            "creation_path",
            "template_kind",
            "is_first_organization",
            "is_user_initiated",
        ],
        "issue_created" => &[
            "creation_path",
            "has_goal_link",
            "has_project_link",
            "is_sub_issue",
        ],
        "chat_created" => &["creation_path", "initial_role", "plan_mode"],
        "human_work_started" => &["work_surface", "origin"],
        "run_started" | "run_succeeded" => &["run_kind", "runtime", "attempt_kind"],
        "run_failed" => &["run_kind", "runtime", "attempt_kind", "terminal_status"],
        "output_ready" => &["output_kind"],
        "review_decision_recorded" => &["decision", "review_surface"],
        "account_created" => &["auth_method", "is_migrated", "acquisition_source"],
        "desktop_authorized" => &[
            "client_kind",
            "release_channel",
            "coarse_platform",
            "authorization_kind",
        ],
        "local_server_connected" => &["connection_kind"],
        "first_agent_ready" => &[
            "runtime_adapter",
            "is_default_agent",
            "preflight_result_code",
            "is_first_for_installation",
        ],
        "work_loop_completed" => &[
            "work_surface",
            "origin",
            "review_required",
            "attempt_count",
            "duration_bucket",
            "cost_bucket",
            "output_kind",
            "is_first_loop",
        ],
        "work_loop_invalidated" => &["reason_code", "duration_bucket"],
        _ => &[],
    };
    allowed.contains(&key)
}

fn is_uuid_like(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
        && matches!(bytes[14], b'1' | b'2' | b'3' | b'4' | b'5')
        && matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
}

pub fn installation_header_matches(authorization: &Authorization, header: Option<&str>) -> bool {
    header.is_some_and(|value| value == authorization.installation_id)
}

pub fn event_ids(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .map(|value| {
            value
                .get("eventId")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event() -> Value {
        serde_json::json!({
            "eventId": "00000000-0000-4000-8000-000000000001",
            "eventName": "issue_created",
            "schemaVersion": 1,
            "occurredAt": "2026-09-23T00:00:00Z",
            "environment": "production",
            "appVersion": "1.0.0",
            "releaseChannel": "stable",
            "deploymentMode": "self_hosted",
            "actorKind": "user",
            "origin": "human",
            "pseudonymousInstallationId": "a".repeat(64),
            "pseudonymousOrgId": null,
            "pseudonymousWorkId": null,
            "pseudonymousWorkCycleId": null,
            "pseudonymousRootRunId": null,
            "pseudonymousRunId": null,
            "completionRevision": null,
            "properties": {"has_goal_link": true},
            "confidence": "exact",
            "isBackfill": false
        })
    }

    #[test]
    fn canonical_hash_is_object_order_independent() {
        let left = serde_json::json!({"b": 2, "a": {"z": true, "y": 1}});
        let right = serde_json::json!({"a": {"y": 1, "z": true}, "b": 2});
        assert_eq!(hash_payload(&left), hash_payload(&right));
    }

    #[test]
    fn validates_allowlist_and_uuid() {
        let now = OffsetDateTime::parse("2026-09-23T00:00:00Z", &Rfc3339).unwrap();
        assert!(validate_event(&event(), now).is_ok());
        let mut invalid = event();
        invalid["properties"] = serde_json::json!({"title": "private"});
        assert_eq!(
            validate_event(&invalid, now).unwrap_err().error_code,
            Some(AckErrorCode::InvalidEvent)
        );
    }
}
