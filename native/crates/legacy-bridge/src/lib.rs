//! Bounded private Unix transport for the legacy migration bridge.
//!
//! The bridge is deliberately narrower than a product listener: it accepts
//! only a private Unix socket, uses a bounded length-prefixed JSON codec, and
//! validates the authority-core envelope before invoking a caller-owned
//! dispatcher. It does not own credentials, database writes, or cutover.

#![cfg_attr(not(unix), allow(dead_code, unused_imports))]

use rudder_authority_core::{
    AUTHORITY_PROTOCOL_VERSION, ActorIdentity, AuthorityError, ComponentAuthority,
    LegacyBridgeRequestEnvelope, NonceReplayGuard, body_sha256,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use thiserror::Error;

pub const REQUEST_SCHEMA: &str = "rudder.migration.legacy-bridge.request.v1";
pub const RESPONSE_SCHEMA: &str = "rudder.migration.legacy-bridge.response.v1";
pub const FRAME_HEADER_BYTES: usize = 4;
pub const DEFAULT_MAX_FRAME_BYTES: usize = 256 * 1024;
pub const DEFAULT_MAX_BODY_BYTES: usize = 64 * 1024;
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_SOCKET_PATH_BYTES: usize = 104;

#[derive(Debug, Error)]
pub enum BridgeError {
    #[error("legacy bridge transport is unsupported on this platform")]
    UnsupportedPlatform,
    #[error("invalid bridge configuration: {reason}")]
    InvalidConfiguration { reason: &'static str },
    #[error("invalid private socket path: {reason}")]
    InvalidSocketPath { reason: &'static str },
    #[error("socket path is not private: {path}")]
    InsecureSocketPath { path: PathBuf },
    #[error("socket path already exists: {path}")]
    SocketPathAlreadyExists { path: PathBuf },
    #[error("socket path is not a Unix socket: {path}")]
    NotUnixSocket { path: PathBuf },
    #[error("unknown Unix peer uid {actual}; expected {expected}")]
    UnknownPeer { actual: u32, expected: u32 },
    #[error("bridge deadline exceeded")]
    DeadlineExceeded,
    #[error("I/O error in legacy bridge transport: {0}")]
    Io(#[source] std::io::Error),
    #[error("bridge frame has an invalid length prefix")]
    InvalidFrameLength,
    #[error("bridge frame is empty")]
    EmptyFrame,
    #[error("bridge frame has {length} bytes; limit is {max} bytes")]
    FrameTooLarge { length: usize, max: usize },
    #[error("bridge frame length does not match its payload")]
    FrameLengthMismatch,
    #[error("bridge JSON is malformed or has unknown fields: {0}")]
    MalformedJson(#[source] serde_json::Error),
    #[error("bridge request body JSON could not be encoded: {0}")]
    BodyEncoding(#[source] serde_json::Error),
    #[error("bridge request body has {length} bytes; limit is {max} bytes")]
    BodyTooLarge { length: usize, max: usize },
    #[error("authority-core rejected the bridge request: {0}")]
    Authority(#[source] AuthorityError),
    #[error("bridge replay guard is unavailable")]
    ReplayGuardUnavailable,
    #[error("bridge admission is invalid: {reason}")]
    InvalidAdmission { reason: &'static str },
    #[error("legacy bridge request is invalid: {field}")]
    InvalidRequest { field: &'static str },
    #[error("bridge response binding mismatch: {field}")]
    ResponseBindingMismatch { field: &'static str },
    #[error("bridge response is not a success or well-formed failure")]
    InvalidResponse,
}

impl BridgeError {
    pub fn is_timeout(&self) -> bool {
        matches!(self, Self::DeadlineExceeded)
    }
}

impl From<std::io::Error> for BridgeError {
    fn from(error: std::io::Error) -> Self {
        if matches!(
            error.kind(),
            std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
        ) {
            Self::DeadlineExceeded
        } else {
            Self::Io(error)
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BridgeLimits {
    max_frame_bytes: usize,
    max_body_bytes: usize,
}

impl BridgeLimits {
    pub fn new(max_frame_bytes: usize, max_body_bytes: usize) -> Result<Self, BridgeError> {
        if max_frame_bytes == 0 || max_frame_bytes > u32::MAX as usize {
            return Err(BridgeError::InvalidConfiguration {
                reason: "max frame bytes must fit a non-zero u32 length prefix",
            });
        }
        if max_body_bytes == 0 || max_body_bytes > max_frame_bytes {
            return Err(BridgeError::InvalidConfiguration {
                reason: "max body bytes must be non-zero and no greater than max frame bytes",
            });
        }
        Ok(Self {
            max_frame_bytes,
            max_body_bytes,
        })
    }

    pub fn max_frame_bytes(self) -> usize {
        self.max_frame_bytes
    }

    pub fn max_body_bytes(self) -> usize {
        self.max_body_bytes
    }
}

impl Default for BridgeLimits {
    fn default() -> Self {
        Self {
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES,
            max_body_bytes: DEFAULT_MAX_BODY_BYTES,
        }
    }
}

#[derive(Clone, Debug)]
pub struct BridgeConfig {
    limits: BridgeLimits,
    read_timeout: Duration,
    write_timeout: Duration,
    expected_peer_uid: Option<u32>,
    socket_dir: Option<PathBuf>,
}

impl BridgeConfig {
    pub fn new(
        limits: BridgeLimits,
        read_timeout: Duration,
        write_timeout: Duration,
    ) -> Result<Self, BridgeError> {
        let config = Self {
            limits,
            read_timeout,
            write_timeout,
            expected_peer_uid: current_uid(),
            socket_dir: None,
        };
        config.validate()?;
        Ok(config)
    }

    pub fn for_test() -> Self {
        Self {
            limits: BridgeLimits {
                max_frame_bytes: 16 * 1024,
                max_body_bytes: 4 * 1024,
            },
            read_timeout: Duration::from_millis(250),
            write_timeout: Duration::from_millis(250),
            expected_peer_uid: current_uid(),
            socket_dir: None,
        }
    }

    pub fn limits(&self) -> BridgeLimits {
        self.limits
    }

    pub fn read_timeout(&self) -> Duration {
        self.read_timeout
    }

    pub fn write_timeout(&self) -> Duration {
        self.write_timeout
    }

    pub fn expected_peer_uid(&self) -> Option<u32> {
        self.expected_peer_uid
    }

    pub fn with_expected_peer_uid(mut self, uid: u32) -> Self {
        self.expected_peer_uid = Some(uid);
        self
    }

    pub fn with_socket_dir(mut self, directory: impl Into<PathBuf>) -> Self {
        self.socket_dir = Some(directory.into());
        self
    }

    fn validate(&self) -> Result<(), BridgeError> {
        let _ = BridgeLimits::new(self.limits.max_frame_bytes, self.limits.max_body_bytes)?;
        if self.read_timeout.is_zero() || self.write_timeout.is_zero() {
            return Err(BridgeError::InvalidConfiguration {
                reason: "read and write deadlines must be non-zero",
            });
        }
        if self.expected_peer_uid.is_none() {
            return Err(BridgeError::InvalidConfiguration {
                reason: "an expected Unix peer uid is required",
            });
        }
        if let Some(directory) = &self.socket_dir {
            validate_socket_path_shape(directory)?;
        }
        Ok(())
    }
}

impl Default for BridgeConfig {
    fn default() -> Self {
        Self {
            limits: BridgeLimits::default(),
            read_timeout: DEFAULT_TIMEOUT,
            write_timeout: DEFAULT_TIMEOUT,
            expected_peer_uid: current_uid(),
            socket_dir: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrivateSocketPath(PathBuf);

impl PrivateSocketPath {
    pub fn new(path: impl Into<PathBuf>) -> Result<Self, BridgeError> {
        let path = path.into();
        validate_socket_path_shape(&path)?;
        Ok(Self(path))
    }

    pub fn as_path(&self) -> &Path {
        &self.0
    }
}

#[derive(Clone, Debug)]
pub struct BridgeAdmission {
    authority: ComponentAuthority,
    actor: ActorIdentity,
    organization_id: String,
    action: String,
    request_id: String,
    now: u64,
}

impl BridgeAdmission {
    pub fn new(
        authority: ComponentAuthority,
        actor: ActorIdentity,
        organization_id: impl Into<String>,
        action: impl Into<String>,
        request_id: impl Into<String>,
        now: u64,
    ) -> Result<Self, BridgeError> {
        let organization_id = organization_id.into();
        let action = action.into();
        let request_id = request_id.into();
        for (value, field) in [
            (organization_id.as_str(), "organization_id"),
            (action.as_str(), "action"),
            (request_id.as_str(), "request_id"),
        ] {
            if value.is_empty() || value.len() > 256 || value.bytes().any(|byte| byte == 0) {
                return Err(BridgeError::InvalidAdmission {
                    reason: match field {
                        "organization_id" => "organization id is invalid",
                        "action" => "action is invalid",
                        _ => "request id is invalid",
                    },
                });
            }
        }
        Ok(Self {
            authority,
            actor,
            organization_id,
            action,
            request_id,
            now,
        })
    }
}

#[derive(Clone, Default)]
pub struct ReplayGuard {
    inner: Arc<Mutex<NonceReplayGuard>>,
}

impl std::fmt::Debug for ReplayGuard {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ReplayGuard")
            .field("len", &self.len())
            .finish()
    }
}

impl ReplayGuard {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.inner.lock().map(|guard| guard.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, NonceReplayGuard>, BridgeError> {
        self.inner
            .lock()
            .map_err(|_| BridgeError::ReplayGuardUnavailable)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LegacyBridgeRequest {
    pub schema: String,
    pub protocol_version: u16,
    pub envelope: LegacyBridgeRequestEnvelope,
    pub body: Value,
}

impl LegacyBridgeRequest {
    pub fn new(envelope: LegacyBridgeRequestEnvelope, body: Value) -> Self {
        Self {
            schema: REQUEST_SCHEMA.to_owned(),
            protocol_version: AUTHORITY_PROTOCOL_VERSION,
            envelope,
            body,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn from_parts(
        authority: &ComponentAuthority,
        actor: ActorIdentity,
        organization_id: impl Into<String>,
        action: impl Into<String>,
        body: Value,
        request_id: impl Into<String>,
        nonce: impl Into<String>,
        expires_at: u64,
    ) -> Result<Self, BridgeError> {
        let body_bytes = serde_json::to_vec(&body).map_err(BridgeError::BodyEncoding)?;
        let envelope = LegacyBridgeRequestEnvelope::new(
            authority,
            actor,
            organization_id,
            action,
            &body_bytes,
            request_id,
            nonce,
            expires_at,
        )
        .map_err(BridgeError::Authority)?;
        Ok(Self::new(envelope, body))
    }

    pub fn body_bytes(&self) -> Result<Vec<u8>, BridgeError> {
        serde_json::to_vec(&self.body).map_err(BridgeError::BodyEncoding)
    }

    fn validate_shape(&self, limits: BridgeLimits) -> Result<Vec<u8>, BridgeError> {
        if self.schema != REQUEST_SCHEMA {
            return Err(BridgeError::InvalidRequest { field: "schema" });
        }
        if self.protocol_version != AUTHORITY_PROTOCOL_VERSION {
            return Err(BridgeError::Authority(
                AuthorityError::UnsupportedProtocolVersion {
                    actual: self.protocol_version,
                    expected: AUTHORITY_PROTOCOL_VERSION,
                },
            ));
        }
        let body = self.body_bytes()?;
        ensure_body_limit(body.len(), limits.max_body_bytes)?;
        Ok(body)
    }

    fn validate_for_admission(
        &self,
        limits: BridgeLimits,
        admission: &BridgeAdmission,
        replay: &ReplayGuard,
    ) -> Result<(), BridgeError> {
        let body = self.validate_shape(limits)?;
        let mut replay = replay.lock()?;
        self.envelope
            .validate(
                &admission.authority,
                &admission.actor,
                &admission.organization_id,
                &admission.action,
                &body,
                &admission.request_id,
                admission.now,
                &mut replay,
            )
            .map_err(BridgeError::Authority)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LegacyBridgeResponse {
    pub schema: String,
    pub protocol_version: u16,
    pub component: String,
    pub component_version: String,
    pub authority_epoch: u64,
    pub fencing_token: String,
    pub actor: ActorIdentity,
    pub organization_id: String,
    pub action: String,
    pub request_body_sha256: String,
    pub request_id: String,
    pub nonce: String,
    pub ok: bool,
    pub body: Option<Value>,
    pub error: Option<LegacyBridgeResponseError>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LegacyBridgeResponseError {
    pub code: String,
    pub message: String,
}

impl LegacyBridgeResponse {
    fn success(request: &LegacyBridgeRequest, body: Value) -> Result<Self, BridgeError> {
        let body_bytes = request.body_bytes()?;
        Ok(Self {
            schema: RESPONSE_SCHEMA.to_owned(),
            protocol_version: AUTHORITY_PROTOCOL_VERSION,
            component: request.envelope.component.clone(),
            component_version: request.envelope.component_version.clone(),
            authority_epoch: request.envelope.authority_epoch,
            fencing_token: request.envelope.fencing_token.clone(),
            actor: request.envelope.actor.clone(),
            organization_id: request.envelope.organization_id.clone(),
            action: request.envelope.action.clone(),
            request_body_sha256: body_sha256(&body_bytes),
            request_id: request.envelope.request_id.clone(),
            nonce: request.envelope.nonce.clone(),
            ok: true,
            body: Some(body),
            error: None,
        })
    }

    fn validate_for(&self, request: &LegacyBridgeRequest) -> Result<(), BridgeError> {
        if self.schema != RESPONSE_SCHEMA {
            return Err(BridgeError::ResponseBindingMismatch { field: "schema" });
        }
        if self.protocol_version != AUTHORITY_PROTOCOL_VERSION {
            return Err(BridgeError::ResponseBindingMismatch {
                field: "protocolVersion",
            });
        }
        let expected = &request.envelope;
        let bindings = [
            (
                self.component.as_str(),
                expected.component.as_str(),
                "component",
            ),
            (
                self.component_version.as_str(),
                expected.component_version.as_str(),
                "componentVersion",
            ),
            (
                self.fencing_token.as_str(),
                expected.fencing_token.as_str(),
                "fencingToken",
            ),
            (
                self.organization_id.as_str(),
                expected.organization_id.as_str(),
                "organizationId",
            ),
            (self.action.as_str(), expected.action.as_str(), "action"),
            (
                self.request_id.as_str(),
                expected.request_id.as_str(),
                "requestId",
            ),
            (self.nonce.as_str(), expected.nonce.as_str(), "nonce"),
        ];
        for (actual, expected, field) in bindings {
            if actual != expected {
                return Err(BridgeError::ResponseBindingMismatch { field });
            }
        }
        if self.authority_epoch != expected.authority_epoch || self.actor != expected.actor {
            return Err(BridgeError::ResponseBindingMismatch { field: "authority" });
        }
        let body = request.body_bytes()?;
        if self.request_body_sha256 != body_sha256(&body) {
            return Err(BridgeError::ResponseBindingMismatch {
                field: "requestBodySha256",
            });
        }
        if self.ok == self.error.is_some() || (self.ok && self.body.is_none()) {
            return Err(BridgeError::InvalidResponse);
        }
        Ok(())
    }
}

pub fn encode_frame<T: Serialize>(
    value: &T,
    max_frame_bytes: usize,
) -> Result<Vec<u8>, BridgeError> {
    if max_frame_bytes == 0 || max_frame_bytes > u32::MAX as usize {
        return Err(BridgeError::InvalidConfiguration {
            reason: "max frame bytes must fit a non-zero u32 length prefix",
        });
    }
    let payload = serde_json::to_vec(value).map_err(BridgeError::BodyEncoding)?;
    if payload.is_empty() {
        return Err(BridgeError::EmptyFrame);
    }
    if payload.len() > max_frame_bytes {
        return Err(BridgeError::FrameTooLarge {
            length: payload.len(),
            max: max_frame_bytes,
        });
    }
    let length = u32::try_from(payload.len()).map_err(|_| BridgeError::InvalidFrameLength)?;
    let mut frame = Vec::with_capacity(FRAME_HEADER_BYTES + payload.len());
    frame.extend_from_slice(&length.to_be_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

pub fn decode_frame<T: DeserializeOwned>(
    frame: &[u8],
    max_frame_bytes: usize,
) -> Result<T, BridgeError> {
    if frame.len() < FRAME_HEADER_BYTES {
        return Err(BridgeError::InvalidFrameLength);
    }
    let mut header = [0_u8; FRAME_HEADER_BYTES];
    header.copy_from_slice(&frame[..FRAME_HEADER_BYTES]);
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 {
        return Err(BridgeError::EmptyFrame);
    }
    if length > max_frame_bytes {
        return Err(BridgeError::FrameTooLarge {
            length,
            max: max_frame_bytes,
        });
    }
    if frame.len() - FRAME_HEADER_BYTES != length {
        return Err(BridgeError::FrameLengthMismatch);
    }
    serde_json::from_slice(&frame[FRAME_HEADER_BYTES..]).map_err(BridgeError::MalformedJson)
}

#[cfg(unix)]
#[derive(Debug)]
pub struct LegacyBridgeConnection {
    stream: std::os::unix::net::UnixStream,
    config: BridgeConfig,
}

#[cfg(not(unix))]
#[derive(Debug)]
pub struct LegacyBridgeConnection;

impl LegacyBridgeConnection {
    #[cfg(unix)]
    fn new(
        stream: std::os::unix::net::UnixStream,
        config: BridgeConfig,
    ) -> Result<Self, BridgeError> {
        configure_stream(&stream, &config)?;
        Ok(Self { stream, config })
    }

    pub fn read_request(&mut self) -> Result<LegacyBridgeRequest, BridgeError> {
        #[cfg(unix)]
        {
            read_json_frame(
                &mut self.stream,
                self.config.limits.max_frame_bytes,
                self.config.read_timeout,
            )
        }
        #[cfg(not(unix))]
        {
            Err(BridgeError::UnsupportedPlatform)
        }
    }

    pub fn write_request(&mut self, request: &LegacyBridgeRequest) -> Result<(), BridgeError> {
        #[cfg(unix)]
        {
            request.validate_shape(self.config.limits)?;
            write_json_frame(
                &mut self.stream,
                request,
                self.config.limits.max_frame_bytes,
                self.config.write_timeout,
            )
        }
        #[cfg(not(unix))]
        {
            let _ = request;
            Err(BridgeError::UnsupportedPlatform)
        }
    }

    pub fn read_response(&mut self) -> Result<LegacyBridgeResponse, BridgeError> {
        #[cfg(unix)]
        {
            read_json_frame(
                &mut self.stream,
                self.config.limits.max_frame_bytes,
                self.config.read_timeout,
            )
        }
        #[cfg(not(unix))]
        {
            Err(BridgeError::UnsupportedPlatform)
        }
    }

    pub fn write_response(&mut self, response: &LegacyBridgeResponse) -> Result<(), BridgeError> {
        #[cfg(unix)]
        {
            write_json_frame(
                &mut self.stream,
                response,
                self.config.limits.max_frame_bytes,
                self.config.write_timeout,
            )
        }
        #[cfg(not(unix))]
        {
            let _ = response;
            Err(BridgeError::UnsupportedPlatform)
        }
    }
}

#[cfg(unix)]
#[derive(Debug)]
pub struct LegacyBridgeListener {
    listener: std::os::unix::net::UnixListener,
    path: PrivateSocketPath,
}

#[cfg(not(unix))]
#[derive(Debug)]
pub struct LegacyBridgeListener;

impl LegacyBridgeListener {
    #[cfg(unix)]
    fn bind(path: PrivateSocketPath, config: &BridgeConfig) -> Result<Self, BridgeError> {
        validate_private_parent(path.as_path(), config)?;
        if std::fs::symlink_metadata(path.as_path()).is_ok() {
            return Err(BridgeError::SocketPathAlreadyExists {
                path: path.0.clone(),
            });
        }
        let listener = std::os::unix::net::UnixListener::bind(path.as_path())?;
        std::fs::set_permissions(path.as_path(), std::fs::Permissions::from_mode(0o600))?;
        validate_existing_socket(path.as_path(), config)?;
        Ok(Self { listener, path })
    }

    #[cfg(unix)]
    fn accept(&self, config: &BridgeConfig) -> Result<LegacyBridgeConnection, BridgeError> {
        let (stream, _) = self.listener.accept()?;
        verify_peer(&stream, config.expected_peer_uid)?;
        LegacyBridgeConnection::new(stream, config.clone())
    }
}

#[cfg(unix)]
impl Drop for LegacyBridgeListener {
    fn drop(&mut self) {
        let Ok(metadata) = std::fs::symlink_metadata(self.path.as_path()) else {
            return;
        };
        if metadata.file_type().is_socket() && metadata.uid() == current_uid().unwrap_or(u32::MAX) {
            let _ = std::fs::remove_file(self.path.as_path());
        }
    }
}

#[derive(Debug)]
pub struct LegacyBridgeServer {
    config: BridgeConfig,
    #[cfg(unix)]
    listener: LegacyBridgeListener,
}

impl LegacyBridgeServer {
    pub fn bind(path: impl Into<PathBuf>, config: BridgeConfig) -> Result<Self, BridgeError> {
        #[cfg(unix)]
        {
            config.validate()?;
            let path = PrivateSocketPath::new(path)?;
            validate_socket_dir(path.as_path(), &config)?;
            let listener = LegacyBridgeListener::bind(path, &config)?;
            Ok(Self { config, listener })
        }
        #[cfg(not(unix))]
        {
            let _ = (path, config);
            Err(BridgeError::UnsupportedPlatform)
        }
    }

    pub fn accept(&self) -> Result<LegacyBridgeConnection, BridgeError> {
        #[cfg(unix)]
        {
            self.listener.accept(&self.config)
        }
        #[cfg(not(unix))]
        {
            Err(BridgeError::UnsupportedPlatform)
        }
    }

    pub fn dispatch_once<F>(
        &self,
        admission: &BridgeAdmission,
        replay: &ReplayGuard,
        dispatch: F,
    ) -> Result<(), BridgeError>
    where
        F: FnOnce(&LegacyBridgeRequest) -> Result<Value, BridgeError>,
    {
        #[cfg(unix)]
        {
            let mut connection = self.accept()?;
            let request = connection.read_request()?;
            request.validate_for_admission(self.config.limits, admission, replay)?;
            let response_body = dispatch(&request)?;
            let response = LegacyBridgeResponse::success(&request, response_body)?;
            connection.write_response(&response)
        }
        #[cfg(not(unix))]
        {
            let _ = (admission, replay, dispatch);
            Err(BridgeError::UnsupportedPlatform)
        }
    }
}

#[derive(Debug)]
pub struct LegacyBridgeClient {
    config: BridgeConfig,
    #[cfg(unix)]
    connection: LegacyBridgeConnection,
}

impl LegacyBridgeClient {
    pub fn connect(path: impl Into<PathBuf>, config: BridgeConfig) -> Result<Self, BridgeError> {
        #[cfg(unix)]
        {
            config.validate()?;
            let path = PrivateSocketPath::new(path)?;
            validate_socket_dir(path.as_path(), &config)?;
            validate_existing_socket(path.as_path(), &config)?;
            let stream = std::os::unix::net::UnixStream::connect(path.as_path())?;
            verify_peer(&stream, config.expected_peer_uid)?;
            let connection = LegacyBridgeConnection::new(stream, config.clone())?;
            Ok(Self { config, connection })
        }
        #[cfg(not(unix))]
        {
            let _ = (path, config);
            Err(BridgeError::UnsupportedPlatform)
        }
    }

    pub fn request(
        &mut self,
        request: &LegacyBridgeRequest,
    ) -> Result<LegacyBridgeResponse, BridgeError> {
        #[cfg(unix)]
        {
            request.validate_shape(self.config.limits)?;
            self.connection.write_request(request)?;
            let response = self.connection.read_response()?;
            response.validate_for(request)?;
            Ok(response)
        }
        #[cfg(not(unix))]
        {
            let _ = request;
            Err(BridgeError::UnsupportedPlatform)
        }
    }
}

#[cfg(unix)]
fn current_uid() -> Option<u32> {
    Some(unsafe { libc::geteuid() })
}

#[cfg(not(unix))]
fn current_uid() -> Option<u32> {
    None
}

#[cfg(unix)]
fn configure_stream(
    stream: &std::os::unix::net::UnixStream,
    _config: &BridgeConfig,
) -> Result<(), BridgeError> {
    stream.set_nonblocking(true)?;
    Ok(())
}

#[cfg(unix)]
fn verify_peer(
    stream: &std::os::unix::net::UnixStream,
    expected_peer_uid: Option<u32>,
) -> Result<(), BridgeError> {
    let expected = expected_peer_uid.ok_or(BridgeError::InvalidConfiguration {
        reason: "an expected Unix peer uid is required",
    })?;
    let actual = peer_uid(stream)?;
    if actual != expected {
        return Err(BridgeError::UnknownPeer { actual, expected });
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn peer_uid(stream: &std::os::unix::net::UnixStream) -> Result<u32, BridgeError> {
    use std::mem::MaybeUninit;
    use std::os::unix::io::AsRawFd;

    let mut credentials = MaybeUninit::<libc::ucred>::uninit();
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            credentials.as_mut_ptr().cast(),
            &mut length,
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if length as usize != std::mem::size_of::<libc::ucred>() {
        return Err(BridgeError::InvalidConfiguration {
            reason: "Unix peer credentials had an unexpected size",
        });
    }
    let credentials = unsafe { credentials.assume_init() };
    Ok(credentials.uid)
}

#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd"
))]
fn peer_uid(stream: &std::os::unix::net::UnixStream) -> Result<u32, BridgeError> {
    use std::os::unix::io::AsRawFd;

    let mut effective_uid = 0;
    let mut effective_gid = 0;
    let result =
        unsafe { libc::getpeereid(stream.as_raw_fd(), &mut effective_uid, &mut effective_gid) };
    if result != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(effective_uid)
}

#[cfg(all(
    unix,
    not(any(
        target_os = "linux",
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd"
    ))
))]
fn peer_uid(_stream: &std::os::unix::net::UnixStream) -> Result<u32, BridgeError> {
    Err(BridgeError::UnsupportedPlatform)
}

#[cfg(unix)]
fn read_json_frame<T: DeserializeOwned>(
    stream: &mut std::os::unix::net::UnixStream,
    max_frame_bytes: usize,
    timeout: Duration,
) -> Result<T, BridgeError> {
    let deadline = Instant::now() + timeout;
    let mut header = [0_u8; FRAME_HEADER_BYTES];
    read_exact_deadline(stream, &mut header, deadline)?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 {
        return Err(BridgeError::EmptyFrame);
    }
    if length > max_frame_bytes {
        return Err(BridgeError::FrameTooLarge {
            length,
            max: max_frame_bytes,
        });
    }
    let mut payload = vec![0_u8; length];
    read_exact_deadline(stream, &mut payload, deadline)?;
    serde_json::from_slice(&payload).map_err(BridgeError::MalformedJson)
}

#[cfg(unix)]
fn write_json_frame<T: Serialize>(
    stream: &mut std::os::unix::net::UnixStream,
    value: &T,
    max_frame_bytes: usize,
    timeout: Duration,
) -> Result<(), BridgeError> {
    let frame = encode_frame(value, max_frame_bytes)?;
    let deadline = Instant::now() + timeout;
    write_all_deadline(stream, &frame, deadline)
}

#[cfg(unix)]
fn read_exact_deadline(
    stream: &mut std::os::unix::net::UnixStream,
    buffer: &mut [u8],
    deadline: Instant,
) -> Result<(), BridgeError> {
    use std::io::Read;
    let mut offset = 0;
    while offset < buffer.len() {
        wait_for_io(stream, libc::POLLIN, deadline)?;
        match stream.read(&mut buffer[offset..]) {
            Ok(0) => {
                return Err(BridgeError::Io(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "peer closed the legacy bridge before the frame was complete",
                )));
            }
            Ok(read) => offset += read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(unix)]
fn write_all_deadline(
    stream: &mut std::os::unix::net::UnixStream,
    buffer: &[u8],
    deadline: Instant,
) -> Result<(), BridgeError> {
    use std::io::Write;
    let mut offset = 0;
    while offset < buffer.len() {
        wait_for_io(stream, libc::POLLOUT, deadline)?;
        match stream.write(&buffer[offset..]) {
            Ok(0) => {
                return Err(BridgeError::Io(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "peer closed the legacy bridge while writing",
                )));
            }
            Ok(written) => offset += written,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(unix)]
fn wait_for_io(
    stream: &std::os::unix::net::UnixStream,
    events: libc::c_short,
    deadline: Instant,
) -> Result<(), BridgeError> {
    use std::os::fd::AsRawFd;

    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(BridgeError::DeadlineExceeded);
        }
        let timeout_millis = remaining.as_millis().clamp(1, i32::MAX as u128) as libc::c_int;
        let mut descriptor = libc::pollfd {
            fd: stream.as_raw_fd(),
            events,
            revents: 0,
        };
        let result = unsafe { libc::poll(&mut descriptor, 1, timeout_millis) };
        if result > 0 {
            if descriptor.revents & libc::POLLNVAL != 0 {
                return Err(BridgeError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "legacy bridge socket descriptor is invalid",
                )));
            }
            return Ok(());
        }
        if result == 0 {
            return Err(BridgeError::DeadlineExceeded);
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        return Err(error.into());
    }
}

fn ensure_body_limit(length: usize, max: usize) -> Result<(), BridgeError> {
    if length > max {
        return Err(BridgeError::BodyTooLarge { length, max });
    }
    Ok(())
}

fn validate_socket_path_shape(path: &Path) -> Result<(), BridgeError> {
    if !path.is_absolute() {
        return Err(BridgeError::InvalidSocketPath {
            reason: "socket path must be absolute",
        });
    }
    if path.as_os_str().len() > MAX_SOCKET_PATH_BYTES {
        return Err(BridgeError::InvalidSocketPath {
            reason: "socket path exceeds the Unix sockaddr path limit",
        });
    }
    if path.file_name().is_none() {
        return Err(BridgeError::InvalidSocketPath {
            reason: "socket path must name a socket",
        });
    }
    for component in path.components() {
        if matches!(
            component,
            Component::ParentDir | Component::CurDir | Component::Prefix(_)
        ) {
            return Err(BridgeError::InvalidSocketPath {
                reason: "socket path cannot contain traversal or platform prefixes",
            });
        }
    }
    Ok(())
}

#[cfg(unix)]
fn validate_socket_dir(path: &Path, config: &BridgeConfig) -> Result<(), BridgeError> {
    if config
        .socket_dir
        .as_ref()
        .is_some_and(|directory| !path.starts_with(directory))
    {
        return Err(BridgeError::InsecureSocketPath {
            path: path.to_path_buf(),
        });
    }
    validate_private_parent(path, config)
}

#[cfg(unix)]
fn validate_private_parent(path: &Path, _config: &BridgeConfig) -> Result<(), BridgeError> {
    let parent = path.parent().ok_or(BridgeError::InvalidSocketPath {
        reason: "socket path has no parent directory",
    })?;
    let metadata = std::fs::symlink_metadata(parent).map_err(BridgeError::from)?;
    if !metadata.is_dir()
        || metadata.uid() != current_uid().unwrap_or(u32::MAX)
        || metadata.permissions().mode() & 0o022 != 0
    {
        return Err(BridgeError::InsecureSocketPath {
            path: parent.to_path_buf(),
        });
    }
    Ok(())
}

#[cfg(unix)]
fn validate_existing_socket(path: &Path, _config: &BridgeConfig) -> Result<(), BridgeError> {
    let metadata = std::fs::symlink_metadata(path).map_err(BridgeError::from)?;
    if metadata.file_type().is_symlink() {
        return Err(BridgeError::InsecureSocketPath {
            path: path.to_path_buf(),
        });
    }
    if !metadata.file_type().is_socket() {
        return Err(BridgeError::NotUnixSocket {
            path: path.to_path_buf(),
        });
    }
    if metadata.uid() != current_uid().unwrap_or(u32::MAX)
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(BridgeError::InsecureSocketPath {
            path: path.to_path_buf(),
        });
    }
    Ok(())
}

#[cfg(unix)]
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};

pub type LegacyBridgeTransportError = BridgeError;
pub type LegacyBridgeRequestEnvelopeCodec = LegacyBridgeRequest;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codec_frames_json_with_a_bounded_length_prefix() {
        let frame = encode_frame(&json!({"ok": true}), 128).expect("frame");
        let decoded: Value = decode_frame(&frame, 128).expect("decode");
        assert_eq!(decoded, json!({"ok": true}));
        assert_eq!(
            u32::from_be_bytes(frame[..4].try_into().expect("header")) as usize,
            frame.len() - 4
        );
    }

    #[test]
    fn codec_rejects_oversized_and_malformed_frames() {
        let error = encode_frame(&"x".repeat(128), 16).expect_err("size limit");
        assert!(matches!(error, BridgeError::FrameTooLarge { .. }));
        let error = decode_frame::<Value>(&[0, 0, 0, 4, b'{', b'!'], 16).expect_err("length");
        assert!(matches!(error, BridgeError::FrameLengthMismatch));
    }
}
