use actix_web::{
    App, Error, HttpResponse, HttpServer,
    body::MessageBody,
    dev::ServiceRequest,
    http::{StatusCode, header::ContentType},
    middleware::{self, Next},
    web,
};
use serde::Serialize;
use sqlx::{Pool, Postgres, postgres::PgPoolOptions};
use std::{
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use thiserror::Error;
use tokio::{sync::Notify, time::timeout};
use tracing::{info, warn};

pub const HEALTH_SCHEMA: &str = "rudder.native.server.health.v1";
pub const READINESS_SCHEMA: &str = "rudder.native.server.readiness.v1";
pub const CAPABILITIES_SCHEMA: &str = "rudder.native.server.capabilities.v1";
pub const STARTUP_SCHEMA: &str = "rudder.native.server.startup.v1";
pub const SHUTDOWN_SCHEMA: &str = "rudder.native.server.shutdown.v1";
pub const PROTOCOL_VERSION: u32 = 1;

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
const READ_ONLY_AUTHORITIES: [&str; 1] = ["workspace_backup_list"];
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
    pub read_only_authorities: [&'static str; 1],
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
    read_only_authorities: [&'static str; 1],
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
    admission: Arc<RequestAdmission>,
    started_at: Instant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AdmissionError {
    QueueFull,
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
        Ok(Self {
            admission: Arc::new(RequestAdmission::new(
                config.workers,
                config.max_queue_depth,
            )),
            config: Arc::new(config),
            database,
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
            limits: self.config.limits(),
        };
        bounded_json(StatusCode::OK, &receipt, self.config.max_response_bytes)
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
}

fn bounded_json<T: Serialize>(status: StatusCode, value: &T, max_bytes: usize) -> HttpResponse {
    match serde_json::to_vec(value) {
        Ok(body) if body.len() <= max_bytes => HttpResponse::build(status)
            .insert_header(ContentType::json())
            .body(body),
        Ok(_) | Err(_) => {
            let body = if FALLBACK_ERROR_BODY.len() <= max_bytes {
                FALLBACK_ERROR_BODY.to_vec()
            } else {
                Vec::new()
            };
            HttpResponse::InternalServerError()
                .insert_header(ContentType::json())
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

async fn workspace_backups(state: web::Data<AppState>, org_id: web::Path<String>) -> HttpResponse {
    state.workspace_backups(org_id.as_str()).await
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
            database_authority: "read-only-product-data",
            read_only_authorities: READ_ONLY_AUTHORITIES,
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
}
