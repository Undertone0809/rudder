use actix_web::{
    App, Error, HttpRequest, HttpResponse, HttpServer,
    body::MessageBody,
    dev::ServiceRequest,
    http::{StatusCode, header},
    middleware::{self, Next},
    web,
};
use base64::Engine;
pub use rudder_auth_core::{ActorEnvelope, ActorIdentity, VerifiedActor};
use rudder_auth_core::{NonceReplayGuard, RequestContext, SigningKey};
use rudder_d1_persistence::{MutationStore, StoreError};
use rudder_organization_mutation_core::{Actor as OrganizationActor, OrganizationBrandingPatch};
use rudder_project_goal_link_core::{
    GoalSetTargetVerifier, ProjectGoalSetReplacementCommand, ValidatedGoalSetContext,
};
use serde::{Deserialize, Serialize};
use sqlx::{Pool, Postgres, postgres::PgPoolOptions};
use std::{
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering as AtomicOrdering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use thiserror::Error;
use tokio::{
    sync::{Notify, Semaphore},
    time::timeout,
};
use tokio_util::io::ReaderStream;
use tracing::{info, warn};

mod workspace_backup_files;

use workspace_backup_files::{
    ArtifactError as BackupArtifactError, DownloadArtifact, WorkspaceBackupFilesQuery,
    file_list_receipt, file_read_receipt, load_entries, normalize_directory_path, prepare_download,
    read_file as read_backup_file,
};

pub const HEALTH_SCHEMA: &str = "rudder.native.server.health.v1";
pub const READINESS_SCHEMA: &str = "rudder.native.server.readiness.v1";
pub const CAPABILITIES_SCHEMA: &str = "rudder.native.server.capabilities.v1";
pub const STARTUP_SCHEMA: &str = "rudder.native.server.startup.v1";
pub const SHUTDOWN_SCHEMA: &str = "rudder.native.server.shutdown.v1";
pub const PROTOCOL_VERSION: u32 = 1;
pub const ACTOR_ENVELOPE_HEADER: &str = "x-rudder-actor-envelope";
pub const ACTOR_ENVELOPE_REQUEST_ID_HEADER: &str = "x-rudder-request-id";
pub const IDEMPOTENCY_KEY_HEADER: &str = "x-rudder-idempotency-key";
pub const ACTOR_ENVELOPE_AUDIENCE: &str = "rudder-server-foundation";
pub const MEMBER_DIRECTORY_ACTION: &str = "organization.members.directory.read";
pub const ORGANIZATION_BRANDING_ACTION: &str = "organization.branding.update";
pub const PROJECT_GOAL_SET_ACTION: &str = "project.goal_set.replace";

const PRIVATE_MUTATION_AUTHORITIES: &[&str] =
    &["organization_branding", "project_goal_set_replacement"];

const DEFAULT_REQUEST_BYTES: usize = 1024 * 1024;
const DEFAULT_RESPONSE_BYTES: usize = 256 * 1024;
const DEFAULT_WEBSOCKET_MESSAGE_BYTES: usize = 1024 * 1024;
const DEFAULT_QUEUE_DEPTH: usize = 64;
const DEFAULT_DATABASE_CONNECTIONS: u32 = 8;
const DEFAULT_WORKERS: usize = 1;
const DEFAULT_SHUTDOWN_GRACE: Duration = Duration::from_secs(10);
const DEFAULT_DATABASE_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(2);
const DEFAULT_READINESS_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_DATABASE_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_READINESS_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_SHUTDOWN_GRACE: Duration = Duration::from_secs(120);

const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_WEBSOCKET_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_QUEUE_DEPTH: usize = 1024;
const MAX_DATABASE_CONNECTIONS: u32 = 64;
const MAX_WORKERS: usize = 32;
const READ_ONLY_AUTHORITIES: &[&str] = &[
    "workspace_backup_list",
    "workspace_backup_files_list",
    "workspace_backup_file_read",
    "workspace_backup_download",
    "organization_member_directory",
];
const FALLBACK_ERROR_BODY: &[u8] =
    br#"{"schema":"rudder.native.server.error.v1","status":"error","reason":"response_limit"}"#;

const WORKSPACE_BACKUP_LIST_SQL: &str = r#"
SELECT jsonb_build_object(
  'id', id::text,
  'orgId', org_id::text,
  'status', status,
  'triggerSource', trigger_source,
  'artifactProvider', 'local_file',
  'artifactRef', artifact_ref,
  'archiveSha256', archive_sha256,
  'treeSha256', tree_sha256,
  'fileCount', file_count,
  'byteSize', byte_size,
  'compressedSize', compressed_size,
  'manifest', manifest,
  'warnings', CASE WHEN jsonb_typeof(warnings) = 'array' THEN warnings ELSE '[]'::jsonb END,
  'error', error,
  'startedAt', CASE WHEN started_at IS NULL THEN NULL ELSE to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
  'finishedAt', CASE WHEN finished_at IS NULL THEN NULL ELSE to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
  'expiresAt', to_char(COALESCE(expires_at, created_at + interval '30 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'restoredFromBackupId', restored_from_backup_id::text,
  'createdByUserId', created_by_user_id,
  'createdAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'updatedAt', to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
)::text
FROM workspace_backups
WHERE org_id::text = $1 AND status <> 'deleted'
ORDER BY created_at DESC
"#;

const WORKSPACE_BACKUP_FILES_SQL: &str = r#"
SELECT artifact_ref, archive_sha256, status
FROM workspace_backups
WHERE org_id::text = $1 AND id::text = $2 AND status <> 'deleted'
LIMIT 1
"#;

const MEMBER_DIRECTORY_FROM_SQL: &str = r#"
FROM organization_memberships AS om
LEFT JOIN agents AS a
  ON om.principal_type = 'agent'
 AND a.id::text = om.principal_id
 AND a.org_id = om.org_id
LEFT JOIN "user" AS u
  ON om.principal_type = 'user'
 AND u.id = om.principal_id
LEFT JOIN operator_profiles AS op
  ON op.user_id = u.id
"#;

fn member_directory_name_sql() -> &'static str {
    r#"CASE
        WHEN om.principal_type = 'agent'
          THEN coalesce(nullif(btrim(a.name), ''), 'Agent')
        ELSE coalesce(
          nullif(btrim(op.nickname), ''),
          nullif(btrim(u.name), ''),
          'Human'
        )
      END"#
}

fn member_directory_type_sql() -> &'static str {
    "CASE WHEN om.principal_type = 'agent' THEN 'agent' ELSE 'human' END"
}

fn visible_member_human_sql() -> &'static str {
    "(om.principal_type = 'user' AND om.principal_id <> 'local-board' AND u.id IS NOT NULL)"
}

fn visible_member_agent_sql() -> &'static str {
    "(om.principal_type = 'agent' AND a.id IS NOT NULL AND a.status NOT IN ('terminated', 'suspended', 'pending', 'pending_approval') AND coalesce(a.metadata->>'hidden', 'false') <> 'true' AND coalesce(a.metadata->>'systemManaged', '') <> 'rudder_copilot')"
}

fn parse_member_directory_org_id(value: &str) -> Option<&str> {
    let bytes = value.as_bytes();
    if bytes.len() != 36
        || ![8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        || bytes.iter().enumerate().any(|(index, byte)| {
            [8, 13, 18, 23].contains(&index) && *byte != b'-'
                || ![8, 13, 18, 23].contains(&index) && !byte.is_ascii_hexdigit()
        })
    {
        return None;
    }
    Some(value)
}

fn member_directory_filters_sql(with_cursor: bool) -> String {
    let human = visible_member_human_sql();
    let agent = visible_member_agent_sql();
    let name = member_directory_name_sql();
    let member_type = member_directory_type_sql();
    let cursor = if with_cursor {
        format!(
            r#"
  AND (
    $4::text IS NULL
    OR {name} > $4
    OR ({name} = $4 AND {member_type} > $5)
    OR ({name} = $4 AND {member_type} = $5 AND om.principal_id > $6)
  )"#,
        )
    } else {
        String::new()
    };
    format!(
        r#"
WHERE om.org_id = $1::uuid
  AND om.status = 'active'
  AND (
    ($2 = 'all' AND ({human} OR {agent}))
    OR ($2 = 'human' AND {human})
    OR ($2 = 'agent' AND {agent})
  )
  AND ($3::text IS NULL OR {name} ILIKE ('%' || $3 || '%'))
  {cursor}
"#,
    )
}

const MEMBER_DIRECTORY_COUNT_SQL_PREFIX: &str = "SELECT count(*)::bigint";

#[derive(Clone, Debug, Deserialize)]
struct MemberDirectoryQuery {
    #[serde(rename = "type")]
    member_type: Option<String>,
    query: Option<String>,
    limit: Option<String>,
    cursor: Option<String>,
    #[serde(rename = "fullIds")]
    full_ids: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct MemberCursor {
    name: String,
    #[serde(rename = "type")]
    member_type: String,
    #[serde(rename = "principalId")]
    principal_id: String,
}

#[derive(Clone, Debug)]
struct MemberDirectoryOptions {
    member_type: String,
    query: Option<String>,
    limit: i64,
    cursor: Option<MemberCursor>,
    full_ids: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemberDirectoryItem {
    name: String,
    #[serde(rename = "type")]
    member_type: String,
    role: String,
    #[serde(rename = "ref")]
    member_ref: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemberDirectoryPage {
    total: i64,
    items: Vec<MemberDirectoryItem>,
    next_cursor: Option<String>,
    has_more: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ProjectGoalSetRequest {
    goal_ids: Vec<String>,
    #[serde(default, alias = "primaryGoalAfter")]
    primary_goal_id: Option<String>,
    #[serde(default)]
    run_id: Option<String>,
}

#[derive(Clone, Copy, Debug)]
struct GoalSetTargetSnapshot {
    exists: bool,
}

impl GoalSetTargetVerifier for GoalSetTargetSnapshot {
    fn goal_set_exists_in_organization(
        &self,
        _organization_id: &str,
        _project_id: &str,
        _goal_ids: &[String],
    ) -> bool {
        self.exists
    }
}

const DEFAULT_MEMBER_DIRECTORY_LIMIT: i64 = 50;
const MAX_MEMBER_DIRECTORY_LIMIT: i64 = 100;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MemberDirectoryQueryError {
    InvalidType,
    InvalidLimit,
    InvalidCursor,
}

fn parse_member_directory_query(
    query: MemberDirectoryQuery,
) -> Result<MemberDirectoryOptions, MemberDirectoryQueryError> {
    let member_type = query
        .member_type
        .unwrap_or_else(|| "all".to_owned())
        .trim()
        .to_ascii_lowercase();
    if !matches!(member_type.as_str(), "all" | "human" | "agent") {
        return Err(MemberDirectoryQueryError::InvalidType);
    }

    let limit = match query.limit.as_deref().map(str::trim) {
        None | Some("") => DEFAULT_MEMBER_DIRECTORY_LIMIT,
        Some(value) => {
            let parsed = parse_member_directory_number(value)
                .filter(|parsed| parsed.is_finite() && parsed.fract() == 0.0)
                .filter(|parsed| (1.0..=MAX_MEMBER_DIRECTORY_LIMIT as f64).contains(parsed))
                .ok_or(MemberDirectoryQueryError::InvalidLimit)?;
            parsed as i64
        }
    };

    let cursor = match query.cursor.as_deref().filter(|value| !value.is_empty()) {
        Some(value) => Some(decode_member_cursor(value)?),
        None => None,
    };
    let full_ids = matches!(query.full_ids.as_deref(), Some("true" | "1"));
    let query = query
        .query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    Ok(MemberDirectoryOptions {
        member_type,
        query,
        limit,
        cursor,
        full_ids,
    })
}

fn parse_member_directory_number(value: &str) -> Option<f64> {
    let (radix, digits) = if let Some(value) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        (16, value)
    } else if let Some(value) = value
        .strip_prefix("0b")
        .or_else(|| value.strip_prefix("0B"))
    {
        (2, value)
    } else if let Some(value) = value
        .strip_prefix("0o")
        .or_else(|| value.strip_prefix("0O"))
    {
        (8, value)
    } else {
        return value.parse::<f64>().ok();
    };
    u64::from_str_radix(digits, radix)
        .ok()
        .map(|value| value as f64)
}

fn decode_member_cursor(value: &str) -> Result<MemberCursor, MemberDirectoryQueryError> {
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(value)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(value))
        .map_err(|_| MemberDirectoryQueryError::InvalidCursor)?;
    let cursor: MemberCursor =
        serde_json::from_slice(&decoded).map_err(|_| MemberDirectoryQueryError::InvalidCursor)?;
    if !matches!(cursor.member_type.as_str(), "human" | "agent")
        || cursor.principal_id.trim().is_empty()
    {
        return Err(MemberDirectoryQueryError::InvalidCursor);
    }
    Ok(cursor)
}

fn encode_member_cursor(cursor: &MemberCursor) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(cursor).expect("member cursor serialization must succeed"))
}

fn short_member_ref(member_type: &str, principal_id: &str, full_ids: bool) -> String {
    if full_ids {
        return principal_id.to_owned();
    }
    let prefix = if member_type == "agent" { "agt" } else { "usr" };
    let compact: String = principal_id
        .trim()
        .chars()
        .filter(|character| *character != '-')
        .take(8)
        .flat_map(|character| character.to_lowercase())
        .collect();
    if compact.chars().count() >= 8 {
        return format!("{prefix}_{compact}");
    }
    let fallback: String = principal_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(8)
        .flat_map(|character| character.to_lowercase())
        .collect();
    format!(
        "{prefix}_{}",
        if fallback.is_empty() {
            "unknown"
        } else {
            &fallback
        }
    )
}

#[derive(Clone, Debug)]
pub struct ServerConfig {
    pub listen_addr: SocketAddr,
    pub max_request_bytes: usize,
    pub max_response_bytes: usize,
    pub max_websocket_message_bytes: usize,
    pub max_queue_depth: usize,
    pub max_database_connections: u32,
    pub database_acquire_timeout: Duration,
    pub readiness_timeout: Duration,
    pub shutdown_grace: Duration,
    pub database_url: Option<String>,
    pub database_required: bool,
    pub actor_envelope_key: Option<SigningKey>,
    pub workers: usize,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            listen_addr: SocketAddr::new(IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 0),
            max_request_bytes: DEFAULT_REQUEST_BYTES,
            max_response_bytes: DEFAULT_RESPONSE_BYTES,
            max_websocket_message_bytes: DEFAULT_WEBSOCKET_MESSAGE_BYTES,
            max_queue_depth: DEFAULT_QUEUE_DEPTH,
            max_database_connections: DEFAULT_DATABASE_CONNECTIONS,
            database_acquire_timeout: DEFAULT_DATABASE_ACQUIRE_TIMEOUT,
            readiness_timeout: DEFAULT_READINESS_TIMEOUT,
            shutdown_grace: DEFAULT_SHUTDOWN_GRACE,
            database_url: None,
            database_required: false,
            actor_envelope_key: None,
            workers: DEFAULT_WORKERS,
        }
    }
}

impl ServerConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        let mut config = Self::default();
        if let Some(value) = optional_env("RUDDER_NATIVE_LISTEN")? {
            config.listen_addr = value
                .parse()
                .map_err(|_| ConfigError::invalid("RUDDER_NATIVE_LISTEN", "socket address"))?;
        }
        config.max_request_bytes = bounded_usize(
            "RUDDER_NATIVE_MAX_REQUEST_BYTES",
            optional_env("RUDDER_NATIVE_MAX_REQUEST_BYTES")?,
            DEFAULT_REQUEST_BYTES,
            1,
            MAX_REQUEST_BYTES,
        )?;
        config.max_response_bytes = bounded_usize(
            "RUDDER_NATIVE_MAX_RESPONSE_BYTES",
            optional_env("RUDDER_NATIVE_MAX_RESPONSE_BYTES")?,
            DEFAULT_RESPONSE_BYTES,
            1,
            MAX_RESPONSE_BYTES,
        )?;
        config.max_websocket_message_bytes = bounded_usize(
            "RUDDER_NATIVE_MAX_WEBSOCKET_MESSAGE_BYTES",
            optional_env("RUDDER_NATIVE_MAX_WEBSOCKET_MESSAGE_BYTES")?,
            DEFAULT_WEBSOCKET_MESSAGE_BYTES,
            1,
            MAX_WEBSOCKET_MESSAGE_BYTES,
        )?;
        config.max_queue_depth = bounded_usize(
            "RUDDER_NATIVE_MAX_QUEUE_DEPTH",
            optional_env("RUDDER_NATIVE_MAX_QUEUE_DEPTH")?,
            DEFAULT_QUEUE_DEPTH,
            1,
            MAX_QUEUE_DEPTH,
        )?;
        config.max_database_connections = bounded_u32(
            "RUDDER_NATIVE_MAX_DATABASE_CONNECTIONS",
            optional_env("RUDDER_NATIVE_MAX_DATABASE_CONNECTIONS")?,
            DEFAULT_DATABASE_CONNECTIONS,
            1,
            MAX_DATABASE_CONNECTIONS,
        )?;
        config.workers = bounded_usize(
            "RUDDER_NATIVE_WORKERS",
            optional_env("RUDDER_NATIVE_WORKERS")?,
            DEFAULT_WORKERS,
            1,
            MAX_WORKERS,
        )?;
        config.database_acquire_timeout = duration_millis(
            "RUDDER_NATIVE_DATABASE_ACQUIRE_TIMEOUT_MS",
            optional_env("RUDDER_NATIVE_DATABASE_ACQUIRE_TIMEOUT_MS")?,
            DEFAULT_DATABASE_ACQUIRE_TIMEOUT,
            MAX_DATABASE_ACQUIRE_TIMEOUT,
        )?;
        config.readiness_timeout = duration_millis(
            "RUDDER_NATIVE_READINESS_TIMEOUT_MS",
            optional_env("RUDDER_NATIVE_READINESS_TIMEOUT_MS")?,
            DEFAULT_READINESS_TIMEOUT,
            MAX_READINESS_TIMEOUT,
        )?;
        config.shutdown_grace = duration_millis(
            "RUDDER_NATIVE_SHUTDOWN_GRACE_MS",
            optional_env("RUDDER_NATIVE_SHUTDOWN_GRACE_MS")?,
            DEFAULT_SHUTDOWN_GRACE,
            MAX_SHUTDOWN_GRACE,
        )?;
        config.database_url = optional_env("RUDDER_NATIVE_DATABASE_URL")?;
        config.database_required =
            optional_bool("RUDDER_NATIVE_DATABASE_REQUIRED")?.unwrap_or(false);
        config.actor_envelope_key = optional_env("RUDDER_NATIVE_ACTOR_ENVELOPE_KEY")?
            .map(|value| {
                SigningKey::new(value.as_bytes()).map_err(|_| {
                    ConfigError::invalid("RUDDER_NATIVE_ACTOR_ENVELOPE_KEY", "non-empty UTF-8 text")
                })
            })
            .transpose()?;
        config.validate()?;
        Ok(config)
    }

    fn validate(&self) -> Result<(), ConfigError> {
        if !self.listen_addr.ip().is_loopback() {
            return Err(ConfigError::invalid(
                "RUDDER_NATIVE_LISTEN",
                "server foundation must bind to a loopback address",
            ));
        }
        if !(1..=MAX_REQUEST_BYTES).contains(&self.max_request_bytes)
            || !(1..=MAX_RESPONSE_BYTES).contains(&self.max_response_bytes)
            || !(1..=MAX_WEBSOCKET_MESSAGE_BYTES).contains(&self.max_websocket_message_bytes)
            || !(1..=MAX_QUEUE_DEPTH).contains(&self.max_queue_depth)
            || !(1..=MAX_DATABASE_CONNECTIONS).contains(&self.max_database_connections)
            || !(1..=MAX_WORKERS).contains(&self.workers)
            || self.database_acquire_timeout.is_zero()
            || self.database_acquire_timeout > MAX_DATABASE_ACQUIRE_TIMEOUT
            || self.readiness_timeout.is_zero()
            || self.readiness_timeout > MAX_READINESS_TIMEOUT
            || self.shutdown_grace.is_zero()
            || !self.shutdown_grace.as_millis().is_multiple_of(1000)
            || self.shutdown_grace > MAX_SHUTDOWN_GRACE
        {
            return Err(ConfigError::invalid(
                "RUDDER_NATIVE_LIMITS",
                "one or more limits are outside the bounded range or shutdown grace is not whole seconds",
            ));
        }
        if self.database_required && self.database_url.is_none() {
            return Err(ConfigError::invalid(
                "RUDDER_NATIVE_DATABASE_REQUIRED",
                "database URL is required when database readiness is enabled",
            ));
        }
        Ok(())
    }

    pub fn limits(&self) -> LimitsReceipt {
        LimitsReceipt {
            max_request_bytes: self.max_request_bytes,
            max_response_bytes: self.max_response_bytes,
            max_websocket_message_bytes: self.max_websocket_message_bytes,
            max_queue_depth: self.max_queue_depth,
            max_concurrent_requests: self.workers,
            max_database_connections: self.max_database_connections,
        }
    }
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("invalid {field}: {reason}")]
    Invalid { field: String, reason: String },
    #[error("database URL could not be parsed")]
    DatabaseUrl,
}

impl ConfigError {
    fn invalid(field: &str, reason: &str) -> Self {
        Self::Invalid {
            field: field.to_owned(),
            reason: reason.to_owned(),
        }
    }
}

fn optional_env(name: &str) -> Result<Option<String>, ConfigError> {
    std::env::var(name).map(Some).or_else(|error| match error {
        std::env::VarError::NotPresent => Ok(None),
        std::env::VarError::NotUnicode(_) => Err(ConfigError::invalid(name, "UTF-8 text")),
    })
}

fn bounded_usize(
    name: &str,
    value: Option<String>,
    default: usize,
    minimum: usize,
    maximum: usize,
) -> Result<usize, ConfigError> {
    let Some(value) = value else {
        return Ok(default);
    };
    let parsed = value
        .parse::<usize>()
        .map_err(|_| ConfigError::invalid(name, "positive integer"))?;
    if !(minimum..=maximum).contains(&parsed) {
        return Err(ConfigError::invalid(
            name,
            "value is outside the bounded range",
        ));
    }
    Ok(parsed)
}

fn bounded_u32(
    name: &str,
    value: Option<String>,
    default: u32,
    minimum: u32,
    maximum: u32,
) -> Result<u32, ConfigError> {
    let Some(value) = value else {
        return Ok(default);
    };
    let parsed = value
        .parse::<u32>()
        .map_err(|_| ConfigError::invalid(name, "positive integer"))?;
    if !(minimum..=maximum).contains(&parsed) {
        return Err(ConfigError::invalid(
            name,
            "value is outside the bounded range",
        ));
    }
    Ok(parsed)
}

fn duration_millis(
    name: &str,
    value: Option<String>,
    default: Duration,
    maximum: Duration,
) -> Result<Duration, ConfigError> {
    let Some(value) = value else {
        return Ok(default);
    };
    let millis = value
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| ConfigError::invalid(name, "positive integer milliseconds"))?;
    let duration = Duration::from_millis(millis);
    if duration > maximum {
        return Err(ConfigError::invalid(
            name,
            "value is outside the bounded range",
        ));
    }
    Ok(duration)
}

fn optional_bool(name: &str) -> Result<Option<bool>, ConfigError> {
    let Some(value) = optional_env(name)? else {
        return Ok(None);
    };
    match value.as_str() {
        "1" | "true" | "TRUE" | "yes" | "YES" => Ok(Some(true)),
        "0" | "false" | "FALSE" | "no" | "NO" => Ok(Some(false)),
        _ => Err(ConfigError::invalid(name, "boolean")),
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LimitsReceipt {
    pub max_request_bytes: usize,
    pub max_response_bytes: usize,
    pub max_websocket_message_bytes: usize,
    pub max_queue_depth: usize,
    pub max_concurrent_requests: usize,
    pub max_database_connections: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupReceipt {
    pub schema: &'static str,
    pub component: &'static str,
    pub protocol_version: u32,
    pub bound_addr: SocketAddr,
    pub public_listener: bool,
    pub product_write_authority: bool,
    pub database_authority: &'static str,
    pub read_only_authorities: &'static [&'static str],
    pub private_mutation_authorities: &'static [&'static str],
    pub limits: LimitsReceipt,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShutdownReceipt {
    pub schema: &'static str,
    pub component: &'static str,
    pub protocol_version: u32,
    pub state: &'static str,
    pub reason: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthReceipt {
    schema: &'static str,
    component: &'static str,
    protocol_version: u32,
    status: &'static str,
    authority: &'static str,
    uptime_ms: u128,
    limits: LimitsReceipt,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DependencyReceipt {
    state: &'static str,
    reason: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadinessReceipt {
    schema: &'static str,
    component: &'static str,
    protocol_version: u32,
    status: &'static str,
    ready: bool,
    dependencies: ReadinessDependencies,
    limits: LimitsReceipt,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadinessDependencies {
    runtime: DependencyReceipt,
    database: DependencyReceipt,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CapabilitiesReceipt {
    schema: &'static str,
    component: &'static str,
    protocol_version: u32,
    effective_engine: &'static str,
    public_listener: bool,
    product_write_authority: bool,
    websocket_supported: bool,
    read_only_authorities: &'static [&'static str],
    private_mutation_authorities: &'static [&'static str],
    limits: LimitsReceipt,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceBackupListReceipt {
    backups: Vec<serde_json::Value>,
}

#[derive(Clone)]
enum DatabaseState {
    Disabled,
    Configured(Pool<Postgres>),
}

#[derive(Clone)]
struct AppState {
    config: Arc<ServerConfig>,
    database: DatabaseState,
    d1_mutations: Option<MutationStore>,
    admission: Arc<RequestAdmission>,
    download_admission: Arc<Semaphore>,
    actor_envelope_replay: Arc<Mutex<NonceReplayGuard>>,
    started_at: Instant,
}

struct DownloadCancellation(Arc<AtomicBool>);

impl Drop for DownloadCancellation {
    fn drop(&mut self) {
        self.0.store(true, AtomicOrdering::Relaxed);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AdmissionError {
    QueueFull,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActorEnvelopeVerificationError {
    Unconfigured,
    Invalid,
}

fn unix_time_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Default)]
struct AdmissionState {
    active: usize,
    queued: usize,
}

// Workers bound active handlers; max_queue_depth bounds additional waiters.
struct RequestAdmission {
    max_active: usize,
    max_queue_depth: usize,
    state: Mutex<AdmissionState>,
    notify: Notify,
}

struct QueueReservation {
    admission: Arc<RequestAdmission>,
    registered: bool,
}

struct RequestPermit {
    admission: Arc<RequestAdmission>,
}

impl RequestAdmission {
    fn new(max_active: usize, max_queue_depth: usize) -> Self {
        Self {
            max_active,
            max_queue_depth,
            state: Mutex::new(AdmissionState::default()),
            notify: Notify::new(),
        }
    }

    fn lock_state(&self) -> MutexGuard<'_, AdmissionState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    async fn acquire(self: &Arc<Self>) -> Result<RequestPermit, AdmissionError> {
        loop {
            let notified = self.notify.notified();
            let should_wait = {
                let mut state = self.lock_state();
                if state.active < self.max_active && state.queued == 0 {
                    state.active += 1;
                    false
                } else {
                    if state.queued >= self.max_queue_depth {
                        return Err(AdmissionError::QueueFull);
                    }
                    state.queued += 1;
                    true
                }
            };

            if !should_wait {
                return Ok(RequestPermit {
                    admission: self.clone(),
                });
            }

            let reservation = QueueReservation {
                admission: self.clone(),
                registered: true,
            };
            notified.await;
            if let Some(permit) = reservation.promote() {
                return Ok(permit);
            }
        }
    }

    #[cfg(test)]
    fn counts(&self) -> (usize, usize) {
        let state = self.lock_state();
        (state.active, state.queued)
    }
}

impl QueueReservation {
    fn promote(mut self) -> Option<RequestPermit> {
        let admission = self.admission.clone();
        let mut state = admission.lock_state();
        state.queued = state.queued.saturating_sub(1);
        self.registered = false;
        let promoted = if state.active < admission.max_active {
            state.active += 1;
            true
        } else {
            false
        };
        drop(state);
        promoted.then_some(RequestPermit { admission })
    }
}

impl Drop for QueueReservation {
    fn drop(&mut self) {
        if !self.registered {
            return;
        }
        let mut state = self.admission.lock_state();
        state.queued = state.queued.saturating_sub(1);
        drop(state);
        self.admission.notify.notify_one();
    }
}

impl Drop for RequestPermit {
    fn drop(&mut self) {
        let mut state = self.admission.lock_state();
        state.active = state.active.saturating_sub(1);
        drop(state);
        self.admission.notify.notify_one();
    }
}

impl AppState {
    fn new(config: ServerConfig) -> Result<Self, ConfigError> {
        config.validate()?;
        let database = match config.database_url.as_deref() {
            Some(url) => {
                let pool = PgPoolOptions::new()
                    .max_connections(config.max_database_connections)
                    .min_connections(0)
                    .acquire_timeout(config.database_acquire_timeout)
                    .connect_lazy(url)
                    .map_err(|_| ConfigError::DatabaseUrl)?;
                DatabaseState::Configured(pool)
            }
            None => DatabaseState::Disabled,
        };
        let d1_mutations = match &database {
            DatabaseState::Configured(pool) => Some(MutationStore::new(pool.clone())),
            DatabaseState::Disabled => None,
        };
        Ok(Self {
            admission: Arc::new(RequestAdmission::new(
                config.workers,
                config.max_queue_depth,
            )),
            download_admission: Arc::new(Semaphore::new(config.workers)),
            actor_envelope_replay: Arc::new(Mutex::new(NonceReplayGuard::new())),
            config: Arc::new(config),
            database,
            d1_mutations,
            started_at: Instant::now(),
        })
    }

    fn json_error(&self, status: StatusCode, reason: &'static str) -> HttpResponse {
        let body = serde_json::json!({
            "schema": "rudder.native.server.error.v1",
            "status": "error",
            "reason": reason,
        });
        bounded_json(status, &body, self.config.max_response_bytes)
    }

    fn mutation_error(&self, error: StoreError) -> HttpResponse {
        let (status, reason) = match error {
            StoreError::NotFound => (StatusCode::NOT_FOUND, "mutation_target_not_found"),
            StoreError::NotOwned => (StatusCode::CONFLICT, "mutation_not_owned"),
            StoreError::Unauthorized => (StatusCode::FORBIDDEN, "mutation_unauthorized"),
            StoreError::InvalidInput | StoreError::Branding(_) | StoreError::Link(_) => {
                (StatusCode::UNPROCESSABLE_ENTITY, "mutation_invalid")
            }
            StoreError::InvalidProjection => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "mutation_invalid_projection",
            ),
            StoreError::StaleVersion => (StatusCode::CONFLICT, "mutation_stale_version"),
            StoreError::StaleFence => (StatusCode::CONFLICT, "mutation_stale_fence"),
            StoreError::VersionRange => {
                (StatusCode::UNPROCESSABLE_ENTITY, "mutation_version_range")
            }
            StoreError::IdempotencyConflict => {
                (StatusCode::CONFLICT, "mutation_idempotency_conflict")
            }
            StoreError::InvalidReceipt => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "mutation_invalid_receipt",
            ),
            StoreError::Database(_) => (StatusCode::INTERNAL_SERVER_ERROR, "mutation_failed"),
        };
        self.json_error(status, reason)
    }

    fn health(&self) -> HttpResponse {
        let receipt = HealthReceipt {
            schema: HEALTH_SCHEMA,
            component: "server-foundation",
            protocol_version: PROTOCOL_VERSION,
            status: "ok",
            authority: "foundation-only",
            uptime_ms: self.started_at.elapsed().as_millis(),
            limits: self.config.limits(),
        };
        bounded_json(StatusCode::OK, &receipt, self.config.max_response_bytes)
    }

    async fn readiness(&self) -> HttpResponse {
        let database = match &self.database {
            DatabaseState::Disabled => DependencyReceipt {
                state: "disabled",
                reason: None,
            },
            DatabaseState::Configured(pool) => match timeout(
                self.config.readiness_timeout,
                sqlx::query("SELECT 1").execute(pool),
            )
            .await
            {
                Ok(Ok(_)) => DependencyReceipt {
                    state: "ready",
                    reason: None,
                },
                Ok(Err(_)) => DependencyReceipt {
                    state: "notReady",
                    reason: Some("probe_failed"),
                },
                Err(_) => DependencyReceipt {
                    state: "notReady",
                    reason: Some("probe_timeout"),
                },
            },
        };
        let runtime = DependencyReceipt {
            state: "ready",
            reason: None,
        };
        let ready = database.state == "ready" || database.state == "disabled";
        let receipt = ReadinessReceipt {
            schema: READINESS_SCHEMA,
            component: "server-foundation",
            protocol_version: PROTOCOL_VERSION,
            status: if ready { "ready" } else { "notReady" },
            ready,
            dependencies: ReadinessDependencies { runtime, database },
            limits: self.config.limits(),
        };
        bounded_json(
            if ready {
                StatusCode::OK
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            },
            &receipt,
            self.config.max_response_bytes,
        )
    }

    fn capabilities(&self) -> HttpResponse {
        let receipt = CapabilitiesReceipt {
            schema: CAPABILITIES_SCHEMA,
            component: "server-foundation",
            protocol_version: PROTOCOL_VERSION,
            effective_engine: "rust",
            public_listener: false,
            product_write_authority: false,
            websocket_supported: false,
            read_only_authorities: READ_ONLY_AUTHORITIES,
            private_mutation_authorities: PRIVATE_MUTATION_AUTHORITIES,
            limits: self.config.limits(),
        };
        bounded_json(StatusCode::OK, &receipt, self.config.max_response_bytes)
    }

    fn verify_actor_envelope(
        &self,
        request: &HttpRequest,
        org_id: &str,
        action: &str,
        idempotency_key: Option<&str>,
        body: &[u8],
    ) -> Result<VerifiedActor, ActorEnvelopeVerificationError> {
        // The trusted Node bridge authorizes actor/org access before signing.
        // Rust accepts no client actor fields and binds that signed decision to
        // this route, method, canonical path, body, request id, and org.
        let Some(key) = self.config.actor_envelope_key.as_ref() else {
            return Err(ActorEnvelopeVerificationError::Unconfigured);
        };
        let envelope_header = request
            .headers()
            .get(ACTOR_ENVELOPE_HEADER)
            .ok_or(ActorEnvelopeVerificationError::Invalid)?;
        let envelope_text = envelope_header
            .to_str()
            .map_err(|_| ActorEnvelopeVerificationError::Invalid)?;
        let envelope: ActorEnvelope = serde_json::from_str(envelope_text)
            .map_err(|_| ActorEnvelopeVerificationError::Invalid)?;
        let request_id = request
            .headers()
            .get(ACTOR_ENVELOPE_REQUEST_ID_HEADER)
            .and_then(|value| value.to_str().ok())
            .ok_or(ActorEnvelopeVerificationError::Invalid)?;
        let actor = envelope.actor.clone();
        if !matches!(actor.kind.as_str(), "user" | "agent") {
            return Err(ActorEnvelopeVerificationError::Invalid);
        }

        let request_target = request.uri().to_string();
        let context = RequestContext::new(
            &actor,
            org_id,
            &envelope.session_id,
            envelope.auth_epoch,
            ACTOR_ENVELOPE_AUDIENCE,
            request.method().as_str(),
            &request_target,
            action,
            body,
            request_id,
            unix_time_seconds(),
        );
        let context = match idempotency_key {
            Some(key) => context.with_idempotency_key(key),
            None => context,
        };
        let mut replay = self
            .actor_envelope_replay
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        envelope
            .verify_with_key_to_actor(key, &context, &mut replay)
            .map_err(|_| ActorEnvelopeVerificationError::Invalid)
    }

    fn verify_member_directory_actor(
        &self,
        request: &HttpRequest,
        org_id: &str,
        body: &[u8],
    ) -> Result<(), ActorEnvelopeVerificationError> {
        self.verify_actor_envelope(request, org_id, MEMBER_DIRECTORY_ACTION, None, body)
            .map(|_| ())
    }

    async fn organization_member_directory(
        &self,
        request: &HttpRequest,
        org_id: &str,
        query: MemberDirectoryQuery,
        body: &[u8],
    ) -> HttpResponse {
        match self.verify_member_directory_actor(request, org_id, body) {
            Ok(()) => {}
            Err(ActorEnvelopeVerificationError::Unconfigured) => {
                return self.json_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "actor_envelope_unconfigured",
                );
            }
            Err(ActorEnvelopeVerificationError::Invalid) => {
                return self.json_error(StatusCode::UNAUTHORIZED, "actor_envelope_invalid");
            }
        }
        let Some(org_id) = parse_member_directory_org_id(org_id) else {
            return self.json_error(StatusCode::NOT_FOUND, "organization_not_found");
        };

        let options = match parse_member_directory_query(query) {
            Ok(options) => options,
            Err(MemberDirectoryQueryError::InvalidType) => {
                return self.json_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "member_directory_invalid_type",
                );
            }
            Err(MemberDirectoryQueryError::InvalidLimit) => {
                return self.json_error(StatusCode::BAD_REQUEST, "member_directory_invalid_limit");
            }
            Err(MemberDirectoryQueryError::InvalidCursor) => {
                return self.json_error(StatusCode::BAD_REQUEST, "member_directory_invalid_cursor");
            }
        };

        let DatabaseState::Configured(pool) = &self.database else {
            return self.json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
        };
        let count_sql = format!(
            "{MEMBER_DIRECTORY_COUNT_SQL_PREFIX} {MEMBER_DIRECTORY_FROM_SQL} {}",
            member_directory_filters_sql(false)
        );
        let count = sqlx::query_as::<_, (i64,)>(&count_sql)
            // $1 org, $2 type, $3 query; count deliberately has no cursor.
            .bind(org_id)
            .bind(&options.member_type)
            .bind(options.query.as_deref())
            .fetch_one(pool)
            .await;
        let total = match count {
            Ok((total,)) => total,
            Err(_) => {
                return self.json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "member_directory_query_failed",
                );
            }
        };

        let name = member_directory_name_sql();
        let member_type = member_directory_type_sql();
        let role = r#"CASE
            WHEN om.principal_type = 'agent'
              THEN coalesce(nullif(btrim(a.role), ''), 'agent')
            ELSE coalesce(nullif(btrim(om.membership_role), ''), 'member')
          END"#;
        let page_sql = format!(
            "SELECT {name} AS name, {member_type} AS member_type, {role} AS role, om.principal_id AS principal_id {MEMBER_DIRECTORY_FROM_SQL} {} ORDER BY name ASC, member_type ASC, principal_id ASC LIMIT $7",
            member_directory_filters_sql(true)
        );
        let cursor_name = options.cursor.as_ref().map(|cursor| cursor.name.as_str());
        let cursor_type = options
            .cursor
            .as_ref()
            .map(|cursor| cursor.member_type.as_str());
        let cursor_principal_id = options
            .cursor
            .as_ref()
            .map(|cursor| cursor.principal_id.as_str());
        let rows = sqlx::query_as::<_, (String, String, String, String)>(&page_sql)
            // $1 org, $2 type, $3 query, $4..$6 cursor, $7 limit.
            .bind(org_id)
            .bind(&options.member_type)
            .bind(options.query.as_deref())
            .bind(cursor_name)
            .bind(cursor_type)
            .bind(cursor_principal_id)
            .bind(options.limit + 1)
            .fetch_all(pool)
            .await;
        let rows = match rows {
            Ok(rows) => rows,
            Err(_) => {
                return self.json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "member_directory_query_failed",
                );
            }
        };
        let has_more = rows.len() > options.limit as usize;
        let page_rows = if has_more {
            &rows[..options.limit as usize]
        } else {
            rows.as_slice()
        };
        let items = page_rows
            .iter()
            .map(
                |(name, member_type, role, principal_id)| MemberDirectoryItem {
                    name: name.clone(),
                    member_type: member_type.clone(),
                    role: role.clone(),
                    member_ref: short_member_ref(member_type, principal_id, options.full_ids),
                },
            )
            .collect::<Vec<_>>();
        let next_cursor = has_more.then(|| {
            let last = page_rows.last().expect("a non-empty page has a last row");
            encode_member_cursor(&MemberCursor {
                name: last.0.clone(),
                member_type: last.1.clone(),
                principal_id: last.3.clone(),
            })
        });
        bounded_json(
            StatusCode::OK,
            &MemberDirectoryPage {
                total,
                items,
                next_cursor,
                has_more,
            },
            self.config.max_response_bytes,
        )
    }

    async fn organization_branding(
        &self,
        request: &HttpRequest,
        org_id: &str,
        body: &[u8],
    ) -> HttpResponse {
        let Some(idempotency_key) = request
            .headers()
            .get(IDEMPOTENCY_KEY_HEADER)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return self.json_error(StatusCode::BAD_REQUEST, "idempotency_key_required");
        };
        let actor = match self.verify_actor_envelope(
            request,
            org_id,
            ORGANIZATION_BRANDING_ACTION,
            Some(idempotency_key),
            body,
        ) {
            Ok(actor) => actor,
            Err(ActorEnvelopeVerificationError::Unconfigured) => {
                return self.json_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "actor_envelope_unconfigured",
                );
            }
            Err(ActorEnvelopeVerificationError::Invalid) => {
                return self.json_error(StatusCode::UNAUTHORIZED, "actor_envelope_invalid");
            }
        };
        let patch = match serde_json::from_slice::<OrganizationBrandingPatch>(body) {
            Ok(patch) => patch,
            Err(_) => return self.json_error(StatusCode::UNPROCESSABLE_ENTITY, "branding_invalid"),
        };
        if patch.name.is_some()
            || patch.description.is_some()
            || patch.logo_asset_id.is_some()
            || patch.brand_color.is_none()
        {
            return self.json_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "branding_scalar_brand_color_required",
            );
        }
        let Some(store) = self.d1_mutations.as_ref() else {
            return self.json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
        };
        let scope = match store
            .organization_branding_scope_for_idempotency(org_id, idempotency_key)
            .await
        {
            Ok(scope) => scope,
            Err(error) => return self.mutation_error(error),
        };
        if scope.owner != "rust" {
            return self.json_error(StatusCode::CONFLICT, "mutation_not_owned");
        }
        let core_actor = match actor.actor().kind.as_str() {
            "user" => OrganizationActor::Board {
                organization_id: org_id.to_owned(),
                principal_id: actor.actor().id.clone(),
            },
            "agent" => OrganizationActor::CeoAgent {
                organization_id: org_id.to_owned(),
                principal_id: actor.actor().id.clone(),
            },
            _ => return self.json_error(StatusCode::UNAUTHORIZED, "actor_envelope_invalid"),
        };
        let command = match patch.into_command(
            org_id.to_owned(),
            core_actor,
            idempotency_key.to_owned(),
            scope.version,
            scope.fence_epoch,
        ) {
            Ok(command) => command,
            Err(_) => return self.json_error(StatusCode::UNPROCESSABLE_ENTITY, "branding_invalid"),
        };
        match store.branding(command).await {
            Ok(committed) => bounded_json(
                StatusCode::OK,
                &committed.receipt,
                self.config.max_response_bytes,
            ),
            Err(error) => self.mutation_error(error),
        }
    }

    async fn project_goal_set(
        &self,
        request: &HttpRequest,
        org_id: &str,
        project_id: &str,
        body: &[u8],
    ) -> HttpResponse {
        let Some(idempotency_key) = request
            .headers()
            .get(IDEMPOTENCY_KEY_HEADER)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return self.json_error(StatusCode::BAD_REQUEST, "idempotency_key_required");
        };
        let actor = match self.verify_actor_envelope(
            request,
            org_id,
            PROJECT_GOAL_SET_ACTION,
            Some(idempotency_key),
            body,
        ) {
            Ok(actor) => actor,
            Err(ActorEnvelopeVerificationError::Unconfigured) => {
                return self.json_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "actor_envelope_unconfigured",
                );
            }
            Err(ActorEnvelopeVerificationError::Invalid) => {
                return self.json_error(StatusCode::UNAUTHORIZED, "actor_envelope_invalid");
            }
        };
        let input = match serde_json::from_slice::<ProjectGoalSetRequest>(body) {
            Ok(input) => input,
            Err(_) => {
                return self
                    .json_error(StatusCode::UNPROCESSABLE_ENTITY, "project_goal_set_invalid");
            }
        };
        let Some(store) = self.d1_mutations.as_ref() else {
            return self.json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
        };
        let scope = match store
            .project_scope_for_idempotency(project_id, idempotency_key)
            .await
        {
            Ok(scope) => scope,
            Err(error) => return self.mutation_error(error),
        };
        if scope.organization_id != org_id {
            return self.json_error(StatusCode::NOT_FOUND, "project_not_found");
        }
        if scope.owner != "rust" {
            return self.json_error(StatusCode::CONFLICT, "mutation_not_owned");
        }
        let DatabaseState::Configured(pool) = &self.database else {
            return self.json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
        };
        let project_exists = match sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(
               SELECT 1 FROM projects WHERE id=$1::uuid AND org_id=$2::uuid
             )",
        )
        .bind(project_id)
        .bind(org_id)
        .fetch_one(pool)
        .await
        {
            Ok(exists) => exists,
            Err(_) => return self.json_error(StatusCode::INTERNAL_SERVER_ERROR, "mutation_failed"),
        };
        if !project_exists {
            return self.json_error(StatusCode::NOT_FOUND, "project_not_found");
        }
        let goals_exist = if input.goal_ids.is_empty() {
            true
        } else {
            match sqlx::query_scalar::<_, i64>(
                "SELECT count(*)::bigint
                 FROM goals
                 WHERE org_id=$1::uuid AND id=ANY($2::text[]::uuid[])",
            )
            .bind(org_id)
            .bind(&input.goal_ids)
            .fetch_one(pool)
            .await
            {
                Ok(count) => count == input.goal_ids.len() as i64,
                Err(_) => {
                    return self
                        .json_error(StatusCode::UNPROCESSABLE_ENTITY, "project_goal_set_invalid");
                }
            }
        };
        let target = GoalSetTargetSnapshot {
            exists: project_exists && goals_exist,
        };
        let context = match ValidatedGoalSetContext::from_verified_actor(
            &actor,
            &target,
            org_id.to_owned(),
            project_id.to_owned(),
            input.goal_ids,
            input.primary_goal_id,
        ) {
            Ok(context) => context,
            Err(_) => {
                return self
                    .json_error(StatusCode::UNPROCESSABLE_ENTITY, "project_goal_set_invalid");
            }
        };
        let run_id = if let Some(run_id) = input.run_id.as_deref() {
            let valid = if actor.actor().kind == "agent" {
                sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS(
                       SELECT 1 FROM heartbeat_runs
                       WHERE id=$1::uuid AND org_id=$2::uuid AND agent_id=$3::uuid
                     )",
                )
                .bind(run_id)
                .bind(org_id)
                .bind(&actor.actor().id)
                .fetch_one(pool)
                .await
            } else {
                sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS(
                       SELECT 1 FROM heartbeat_runs
                       WHERE id=$1::uuid AND org_id=$2::uuid
                     )",
                )
                .bind(run_id)
                .bind(org_id)
                .fetch_one(pool)
                .await
            };
            match valid {
                Ok(true) => Some(run_id.to_owned()),
                Ok(false) | Err(_) => {
                    return self
                        .json_error(StatusCode::UNPROCESSABLE_ENTITY, "project_goal_set_invalid");
                }
            }
        } else {
            None
        };
        let command = ProjectGoalSetReplacementCommand::from_validated_context(
            context,
            scope.version,
            scope.fence_epoch,
            idempotency_key.to_owned(),
        );
        let command = match command.with_run_id(run_id) {
            Ok(command) => command,
            Err(_) => {
                return self
                    .json_error(StatusCode::UNPROCESSABLE_ENTITY, "project_goal_set_invalid");
            }
        };
        match store.project_goal_set(command).await {
            Ok(committed) => bounded_json(
                StatusCode::OK,
                &committed.receipt,
                self.config.max_response_bytes,
            ),
            Err(error) => self.mutation_error(error),
        }
    }

    async fn workspace_backups(&self, org_id: &str) -> HttpResponse {
        let DatabaseState::Configured(pool) = &self.database else {
            return self.json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
        };

        let organization_exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM organizations WHERE id::text = $1)",
        )
        .bind(org_id)
        .fetch_one(pool)
        .await;
        match organization_exists {
            Ok(false) => {
                return self.json_error(StatusCode::NOT_FOUND, "organization_not_found");
            }
            Err(_) => {
                return self.json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "workspace_backup_list_failed",
                );
            }
            Ok(true) => {}
        }

        match sqlx::query_scalar::<_, String>(WORKSPACE_BACKUP_LIST_SQL)
            .bind(org_id)
            .fetch_all(pool)
            .await
        {
            Ok(rows) => match rows
                .into_iter()
                .map(|row| serde_json::from_str::<serde_json::Value>(&row))
                .collect::<Result<Vec<_>, _>>()
            {
                Ok(backups) => bounded_json(
                    StatusCode::OK,
                    &WorkspaceBackupListReceipt { backups },
                    self.config.max_response_bytes,
                ),
                Err(_) => self.json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "workspace_backup_list_failed",
                ),
            },
            Err(_) => self.json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "workspace_backup_list_failed",
            ),
        }
    }

    async fn workspace_backup_files(
        &self,
        org_id: &str,
        backup_id: &str,
        directory_path: &str,
    ) -> HttpResponse {
        let DatabaseState::Configured(pool) = &self.database else {
            return self.json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
        };

        let normalized_directory = match normalize_directory_path(directory_path) {
            Ok(path) => path,
            Err(reason) => return self.json_error(StatusCode::UNPROCESSABLE_ENTITY, reason),
        };
        let row = sqlx::query_as::<_, (String, Option<String>, String)>(WORKSPACE_BACKUP_FILES_SQL)
            .bind(org_id)
            .bind(backup_id)
            .fetch_optional(pool)
            .await;
        let (artifact_ref, archive_sha256, status) = match row {
            Ok(Some(row)) => row,
            Ok(None) => {
                return self.json_error(StatusCode::NOT_FOUND, "workspace_backup_not_found");
            }
            Err(_) => {
                return self.json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "workspace_backup_files_list_failed",
                );
            }
        };
        if status == "running" {
            return self.json_error(StatusCode::CONFLICT, "workspace_backup_running");
        }
        if status == "failed" {
            return self.json_error(StatusCode::UNPROCESSABLE_ENTITY, "workspace_backup_failed");
        }

        let org_id = org_id.to_owned();
        let artifact_path = PathBuf::from(artifact_ref);
        let entries = tokio::task::spawn_blocking(move || {
            load_entries(&artifact_path, &org_id, archive_sha256.as_deref())
        })
        .await;
        let entries = match entries {
            Ok(Ok(entries)) => entries,
            Ok(Err(BackupArtifactError::NotFound)) => {
                return self
                    .json_error(StatusCode::NOT_FOUND, "workspace_backup_artifact_not_found");
            }
            Ok(Err(BackupArtifactError::FileNotFound)) => {
                return self.json_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "workspace_backup_artifact_invalid",
                );
            }
            Ok(Err(BackupArtifactError::Invalid)) => {
                return self.json_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "workspace_backup_artifact_invalid",
                );
            }
            Ok(Err(BackupArtifactError::Cancelled)) => {
                return self.json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "workspace_backup_files_list_failed",
                );
            }
            Err(_) => {
                return self.json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "workspace_backup_files_list_failed",
                );
            }
        };
        let receipt = file_list_receipt(&entries, normalized_directory, backup_id);
        bounded_json(StatusCode::OK, &receipt, self.config.max_response_bytes)
    }

    async fn workspace_backup_file(
        &self,
        org_id: &str,
        backup_id: &str,
        file_path: &str,
    ) -> HttpResponse {
        let DatabaseState::Configured(pool) = &self.database else {
            return self.json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
        };

        let normalized_file_path = match normalize_directory_path(file_path) {
            Ok(path) => path,
            Err(reason) => return self.json_error(StatusCode::UNPROCESSABLE_ENTITY, reason),
        };
        let row = sqlx::query_as::<_, (String, Option<String>, String)>(WORKSPACE_BACKUP_FILES_SQL)
            .bind(org_id)
            .bind(backup_id)
            .fetch_optional(pool)
            .await;
        let (artifact_ref, archive_sha256, status) = match row {
            Ok(Some(row)) => row,
            Ok(None) => {
                return self.json_error(StatusCode::NOT_FOUND, "workspace_backup_not_found");
            }
            Err(_) => {
                return self.json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "workspace_backup_file_read_failed",
                );
            }
        };
        if status == "running" {
            return self.json_error(StatusCode::CONFLICT, "workspace_backup_running");
        }
        if status == "failed" {
            return self.json_error(StatusCode::UNPROCESSABLE_ENTITY, "workspace_backup_failed");
        }

        let org_id = org_id.to_owned();
        let backup_id = backup_id.to_owned();
        let artifact_path = PathBuf::from(artifact_ref);
        let read_path = normalized_file_path.clone();
        let bytes = tokio::task::spawn_blocking(move || {
            read_backup_file(
                &artifact_path,
                &org_id,
                archive_sha256.as_deref(),
                &read_path,
            )
        })
        .await;
        let bytes = match bytes {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(BackupArtifactError::NotFound)) => {
                return self
                    .json_error(StatusCode::NOT_FOUND, "workspace_backup_artifact_not_found");
            }
            Ok(Err(BackupArtifactError::FileNotFound)) => {
                return self.json_error(StatusCode::NOT_FOUND, "workspace_backup_file_not_found");
            }
            Ok(Err(BackupArtifactError::Invalid)) => {
                return self.json_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "workspace_backup_artifact_invalid",
                );
            }
            Ok(Err(BackupArtifactError::Cancelled)) => {
                return self.json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "workspace_backup_file_read_failed",
                );
            }
            Err(_) => {
                return self.json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "workspace_backup_file_read_failed",
                );
            }
        };
        let receipt = file_read_receipt(&bytes, normalized_file_path, &backup_id);
        bounded_json(StatusCode::OK, &receipt, self.config.max_response_bytes)
    }

    async fn workspace_backup_download(&self, org_id: &str, backup_id: &str) -> HttpResponse {
        let DatabaseState::Configured(pool) = &self.database else {
            return self.json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
        };
        let row = sqlx::query_as::<_, (String, Option<String>, String)>(WORKSPACE_BACKUP_FILES_SQL)
            .bind(org_id)
            .bind(backup_id)
            .fetch_optional(pool)
            .await;
        let (artifact_ref, archive_sha256, status) = match row {
            Ok(Some(row)) => row,
            Ok(None) => {
                return self.json_error(StatusCode::NOT_FOUND, "workspace_backup_not_found");
            }
            Err(_) => {
                return self.json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "workspace_backup_download_failed",
                );
            }
        };
        if status == "running" {
            return self.json_error(StatusCode::CONFLICT, "workspace_backup_running");
        }
        if status == "failed" {
            return self.json_error(StatusCode::UNPROCESSABLE_ENTITY, "workspace_backup_failed");
        }

        let artifact_path = PathBuf::from(&artifact_ref);
        let path_for_validation = artifact_path.clone();
        let org_id = org_id.to_owned();
        let permit = match self.download_admission.clone().acquire_owned().await {
            Ok(permit) => permit,
            Err(_) => {
                return self.json_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "workspace_backup_download_unavailable",
                );
            }
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancellation = DownloadCancellation(cancelled.clone());
        let download = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            prepare_download(
                &path_for_validation,
                &org_id,
                archive_sha256.as_deref(),
                &cancelled,
            )
        })
        .await;
        drop(cancellation);
        let download = match download {
            Ok(Ok(download)) => download,
            Ok(Err(BackupArtifactError::NotFound)) => {
                return self
                    .json_error(StatusCode::NOT_FOUND, "workspace_backup_artifact_not_found");
            }
            Ok(Err(BackupArtifactError::FileNotFound | BackupArtifactError::Invalid)) => {
                return self.json_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "workspace_backup_artifact_invalid",
                );
            }
            Ok(Err(BackupArtifactError::Cancelled)) => {
                return self.json_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "workspace_backup_download_cancelled",
                );
            }
            Err(_) => {
                return self.json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "workspace_backup_download_failed",
                );
            }
        };
        let stem = artifact_path
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("workspace-backup")
            .replace('"', "");
        let disposition = format!("attachment; filename=\"{stem}.zip\"");
        let response = |byte_size: u64, sha256: Option<&str>| {
            let mut builder = HttpResponse::Ok();
            builder
                .insert_header((header::CONTENT_TYPE, "application/zip"))
                .insert_header((header::CONTENT_LENGTH, byte_size.to_string()))
                .insert_header((header::CACHE_CONTROL, "private, max-age=60"))
                .insert_header((header::X_CONTENT_TYPE_OPTIONS, "nosniff"))
                .insert_header((header::CONTENT_DISPOSITION, disposition.clone()));
            if let Some(sha256) = sha256 {
                builder.insert_header(("x-rudder-archive-sha256", sha256));
            }
            builder
        };
        match download {
            DownloadArtifact::File {
                file,
                byte_size,
                sha256,
            } => response(byte_size, sha256.as_deref())
                .streaming(ReaderStream::new(tokio::fs::File::from_std(file))),
            DownloadArtifact::Bytes { bytes, sha256 } => {
                response(bytes.len() as u64, Some(&sha256)).body(bytes)
            }
        }
    }
}

fn bounded_json<T: Serialize>(status: StatusCode, value: &T, max_bytes: usize) -> HttpResponse {
    match serde_json::to_vec(value) {
        Ok(body) if body.len() <= max_bytes => HttpResponse::build(status)
            .insert_header(header::ContentType::json())
            .body(body),
        Ok(_) | Err(_) => {
            let body = if FALLBACK_ERROR_BODY.len() <= max_bytes {
                FALLBACK_ERROR_BODY.to_vec()
            } else {
                Vec::new()
            };
            HttpResponse::InternalServerError()
                .insert_header(header::ContentType::json())
                .body(body)
        }
    }
}

async fn request_guard(
    state: web::Data<AppState>,
    payload: web::Payload,
    mut req: ServiceRequest,
    next: Next<impl MessageBody + 'static>,
) -> Result<actix_web::dev::ServiceResponse<impl MessageBody>, Error> {
    let permit = match state.admission.acquire().await {
        Ok(permit) => permit,
        Err(AdmissionError::QueueFull) => {
            return Ok(req
                .into_response(
                    state.json_error(StatusCode::SERVICE_UNAVAILABLE, "request_queue_full"),
                )
                .map_into_right_body());
        }
    };

    // Buffer once at the admission boundary so routes that ignore their body cannot bypass the cap.
    let body = match payload
        .to_bytes_limited(state.config.max_request_bytes)
        .await
    {
        Ok(Ok(body)) => body,
        Ok(Err(_)) => {
            return Ok(req
                .into_response(state.json_error(StatusCode::BAD_REQUEST, "request_body_invalid"))
                .map_into_right_body());
        }
        Err(_) => {
            return Ok(req
                .into_response(state.json_error(StatusCode::PAYLOAD_TOO_LARGE, "request_too_large"))
                .map_into_right_body());
        }
    };
    req.set_payload(body.into());

    let response = next.call(req).await?.map_into_left_body();
    drop(permit);
    Ok(response)
}

async fn health(state: web::Data<AppState>) -> HttpResponse {
    state.health()
}

async fn readiness(state: web::Data<AppState>) -> HttpResponse {
    state.readiness().await
}

async fn capabilities(state: web::Data<AppState>) -> HttpResponse {
    state.capabilities()
}

async fn organization_member_directory(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Bytes,
    org_id: web::Path<String>,
    query: web::Query<MemberDirectoryQuery>,
) -> HttpResponse {
    state
        .organization_member_directory(&request, org_id.as_str(), query.into_inner(), body.as_ref())
        .await
}

async fn organization_branding(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Bytes,
    org_id: web::Path<String>,
) -> HttpResponse {
    state
        .organization_branding(&request, org_id.as_str(), body.as_ref())
        .await
}

async fn project_goal_set(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Bytes,
    route: web::Path<(String, String)>,
) -> HttpResponse {
    let (org_id, project_id) = route.into_inner();
    state
        .project_goal_set(&request, &org_id, &project_id, body.as_ref())
        .await
}

async fn workspace_backups(state: web::Data<AppState>, org_id: web::Path<String>) -> HttpResponse {
    state.workspace_backups(org_id.as_str()).await
}

async fn workspace_backup_files(
    state: web::Data<AppState>,
    route: web::Path<(String, String)>,
    query: web::Query<WorkspaceBackupFilesQuery>,
) -> HttpResponse {
    let (org_id, backup_id) = route.into_inner();
    state
        .workspace_backup_files(&org_id, &backup_id, &query.path)
        .await
}

async fn workspace_backup_file(
    state: web::Data<AppState>,
    route: web::Path<(String, String)>,
    query: web::Query<WorkspaceBackupFilesQuery>,
) -> HttpResponse {
    let (org_id, backup_id) = route.into_inner();
    state
        .workspace_backup_file(&org_id, &backup_id, &query.path)
        .await
}

async fn workspace_backup_download(
    state: web::Data<AppState>,
    route: web::Path<(String, String)>,
) -> HttpResponse {
    let (org_id, backup_id) = route.into_inner();
    state.workspace_backup_download(&org_id, &backup_id).await
}

pub struct ServerRuntime {
    server: Option<actix_web::dev::Server>,
    control: ServerControl,
    bound_addr: SocketAddr,
}

#[derive(Clone)]
pub struct ServerControl {
    handle: actix_web::dev::ServerHandle,
    state: Arc<AppState>,
}

impl ServerRuntime {
    pub fn bind(config: ServerConfig) -> Result<Self, ServerError> {
        let state = Arc::new(AppState::new(config.clone())?);
        let app_state = web::Data::from(state.clone());
        let max_request_bytes = config.max_request_bytes;
        let http_server = HttpServer::new(move || {
            App::new()
                .app_data(app_state.clone())
                .app_data(web::PayloadConfig::new(max_request_bytes))
                .app_data(web::JsonConfig::default().limit(max_request_bytes))
                .wrap(middleware::from_fn(request_guard))
                .route("/healthz", web::get().to(health))
                .route("/readyz", web::get().to(readiness))
                .route("/v1/capabilities", web::get().to(capabilities))
                .route(
                    "/api/orgs/{org_id}/workspace/backups",
                    web::get().to(workspace_backups),
                )
                .route(
                    "/api/orgs/{org_id}/workspace/backups/{backup_id}/files",
                    web::get().to(workspace_backup_files),
                )
                .route(
                    "/api/orgs/{org_id}/workspace/backups/{backup_id}/file",
                    web::get().to(workspace_backup_file),
                )
                .route(
                    "/api/orgs/{org_id}/workspace/backups/{backup_id}/download",
                    web::get().to(workspace_backup_download),
                )
                .route(
                    "/api/orgs/{org_id}/members/directory",
                    web::get().to(organization_member_directory),
                )
                .route(
                    "/api/orgs/{org_id}/branding",
                    web::patch().to(organization_branding),
                )
                .route(
                    "/api/orgs/{org_id}/projects/{project_id}/goal-set",
                    web::patch().to(project_goal_set),
                )
        })
        .workers(config.workers)
        .disable_signals()
        .shutdown_timeout(config.shutdown_grace.as_secs())
        .bind(config.listen_addr)?;
        let bound_addr = http_server
            .addrs()
            .first()
            .copied()
            .ok_or(ServerError::NoBoundAddress)?;
        let server = http_server.run();
        let handle = server.handle();
        info!(
            event = "server_bound",
            component = "server-foundation",
            authority = "foundation-only"
        );
        Ok(Self {
            server: Some(server),
            control: ServerControl { handle, state },
            bound_addr,
        })
    }

    pub fn bound_addr(&self) -> SocketAddr {
        self.bound_addr
    }

    pub fn control(&self) -> ServerControl {
        self.control.clone()
    }

    pub fn startup_receipt(&self) -> StartupReceipt {
        StartupReceipt {
            schema: STARTUP_SCHEMA,
            component: "server-foundation",
            protocol_version: PROTOCOL_VERSION,
            bound_addr: self.bound_addr,
            public_listener: false,
            product_write_authority: false,
            database_authority: "read-and-private-d1-mutations",
            read_only_authorities: READ_ONLY_AUTHORITIES,
            private_mutation_authorities: PRIVATE_MUTATION_AUTHORITIES,
            limits: self.control.state.config.limits(),
        }
    }

    pub async fn run(mut self) -> std::io::Result<()> {
        self.server
            .take()
            .ok_or_else(|| std::io::Error::other("server runtime already consumed"))?
            .await
    }

    pub async fn shutdown(&self) {
        self.control.shutdown().await;
    }

    pub fn shutdown_receipt(reason: &'static str) -> ShutdownReceipt {
        ShutdownReceipt {
            schema: SHUTDOWN_SCHEMA,
            component: "server-foundation",
            protocol_version: PROTOCOL_VERSION,
            state: "stopped",
            reason,
        }
    }
}

impl ServerControl {
    pub async fn shutdown(&self) {
        warn!(
            event = "server_shutdown_requested",
            component = "server-foundation"
        );
        self.handle.stop(true).await;
    }
}

#[derive(Debug, Error)]
pub enum ServerError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error("server bind failed: {0}")]
    Bind(#[from] std::io::Error),
    #[error("server did not expose a bound address")]
    NoBoundAddress,
}

pub fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .json()
        .with_writer(std::io::stderr)
        .with_target(false)
        .with_current_span(false)
        .with_span_list(false)
        .with_env_filter(filter)
        .try_init();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_local_and_bounded() {
        let config = ServerConfig::default();
        assert_eq!(
            config.listen_addr.ip(),
            IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
        );
        assert_eq!(config.listen_addr.port(), 0);
        assert_eq!(config.workers, 1);
        assert_eq!(config.limits().max_queue_depth, DEFAULT_QUEUE_DEPTH);
        assert_eq!(config.limits().max_concurrent_requests, DEFAULT_WORKERS);
        assert!(!config.database_required);
    }

    #[test]
    fn shutdown_grace_uses_actix_compatible_whole_seconds() {
        let config = ServerConfig {
            shutdown_grace: Duration::from_millis(1_500),
            ..ServerConfig::default()
        };
        assert!(config.validate().is_err());
    }

    #[tokio::test]
    async fn request_admission_bounds_active_and_waiting_requests() {
        let admission = Arc::new(RequestAdmission::new(1, 1));
        let first = admission.acquire().await.unwrap();
        let waiting_admission = admission.clone();
        let waiting = tokio::spawn(async move { waiting_admission.acquire().await.unwrap() });

        for _ in 0..10 {
            if admission.counts() == (1, 1) {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(admission.counts(), (1, 1));
        assert!(matches!(
            admission.acquire().await,
            Err(AdmissionError::QueueFull)
        ));

        drop(first);
        let second = timeout(Duration::from_millis(100), waiting)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(admission.counts(), (1, 0));
        drop(second);
        assert_eq!(admission.counts(), (0, 0));
    }

    #[tokio::test]
    async fn multiple_queued_requests_are_promoted_after_release() {
        let admission = Arc::new(RequestAdmission::new(1, 2));
        let first = admission.acquire().await.unwrap();

        let (acquired_one_tx, mut acquired_one_rx) = tokio::sync::oneshot::channel();
        let (release_one_tx, release_one_rx) = tokio::sync::oneshot::channel();
        let first_waiter_admission = admission.clone();
        let first_waiter = tokio::spawn(async move {
            let permit = first_waiter_admission.acquire().await.unwrap();
            acquired_one_tx.send(()).unwrap();
            release_one_rx.await.unwrap();
            drop(permit);
        });

        for _ in 0..10 {
            if admission.counts() == (1, 1) {
                break;
            }
            tokio::task::yield_now().await;
        }

        let (acquired_two_tx, mut acquired_two_rx) = tokio::sync::oneshot::channel();
        let (release_two_tx, release_two_rx) = tokio::sync::oneshot::channel();
        let second_waiter_admission = admission.clone();
        let second_waiter = tokio::spawn(async move {
            let permit = second_waiter_admission.acquire().await.unwrap();
            acquired_two_tx.send(()).unwrap();
            release_two_rx.await.unwrap();
            drop(permit);
        });

        for _ in 0..10 {
            if admission.counts() == (1, 2) {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(admission.counts(), (1, 2));

        drop(first);
        let winner = tokio::select! {
            result = &mut acquired_one_rx => {
                result.unwrap();
                1
            }
            result = &mut acquired_two_rx => {
                result.unwrap();
                2
            }
        };
        assert_eq!(admission.counts(), (1, 1));

        if winner == 1 {
            release_one_tx.send(()).unwrap();
            tokio::time::timeout(Duration::from_millis(100), &mut acquired_two_rx)
                .await
                .unwrap()
                .unwrap();
            release_two_tx.send(()).unwrap();
        } else {
            release_two_tx.send(()).unwrap();
            tokio::time::timeout(Duration::from_millis(100), &mut acquired_one_rx)
                .await
                .unwrap()
                .unwrap();
            release_one_tx.send(()).unwrap();
        }

        first_waiter.await.unwrap();
        second_waiter.await.unwrap();
        assert_eq!(admission.counts(), (0, 0));
    }

    #[tokio::test]
    async fn download_work_has_dedicated_bounded_capacity() {
        let state = AppState::new(ServerConfig {
            workers: 1,
            ..ServerConfig::default()
        })
        .unwrap();
        let first = state
            .download_admission
            .clone()
            .try_acquire_owned()
            .expect("first download permit");
        assert!(
            state
                .download_admission
                .clone()
                .try_acquire_owned()
                .is_err(),
            "abandoned blocking work must retain the dedicated capacity permit"
        );
        drop(first);
        assert!(
            state.download_admission.clone().try_acquire_owned().is_ok(),
            "capacity must recover when the blocking work ends"
        );
    }

    #[actix_web::test]
    async fn response_limit_fallback_never_exceeds_configured_limit() {
        let response = bounded_json(StatusCode::OK, &serde_json::json!({"large": true}), 1);
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = actix_web::body::to_bytes(response.into_body())
            .await
            .unwrap();
        assert!(body.len() <= 1);
    }

    #[test]
    fn refuses_a_non_loopback_listener() {
        let config = ServerConfig {
            listen_addr: "0.0.0.0:0".parse().unwrap(),
            ..ServerConfig::default()
        };
        let error = ServerRuntime::bind(config)
            .err()
            .expect("non-loopback bind should fail");
        assert!(error.to_string().contains("loopback"));
    }

    #[test]
    fn health_and_capabilities_are_read_only() {
        let state = AppState::new(ServerConfig::default()).unwrap();
        assert_eq!(state.health().status(), StatusCode::OK);
        assert_eq!(state.capabilities().status(), StatusCode::OK);
    }

    #[actix_web::test]
    async fn workspace_backup_list_fails_closed_without_database() {
        let state = AppState::new(ServerConfig::default()).unwrap();
        let response = state.workspace_backups("organization-1").await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = actix_web::body::to_bytes(response.into_body())
            .await
            .unwrap();
        assert!(String::from_utf8_lossy(&body).contains("database_disabled"));
    }

    #[test]
    fn workspace_backup_list_query_is_organization_scoped_and_read_only() {
        let normalized = WORKSPACE_BACKUP_LIST_SQL.to_ascii_lowercase();
        assert!(normalized.contains("where org_id::text = $1"));
        assert!(normalized.contains("status <> 'deleted'"));
        assert!(normalized.contains("order by created_at desc"));
        for mutation in ["insert ", "update ", "delete ", "truncate "] {
            assert!(!normalized.contains(mutation), "query contains {mutation}");
        }
    }

    #[test]
    fn workspace_backup_files_query_is_organization_scoped_and_read_only() {
        let normalized = WORKSPACE_BACKUP_FILES_SQL.to_ascii_lowercase();
        assert!(normalized.contains("where org_id::text = $1 and id::text = $2"));
        assert!(normalized.contains("status <> 'deleted'"));
        for mutation in ["insert ", "update ", "delete ", "truncate "] {
            assert!(!normalized.contains(mutation), "query contains {mutation}");
        }
    }
}
