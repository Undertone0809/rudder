use crate::value::StrictValue;
use crate::{MAX_FRAME_BYTES, ProtocolError};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::fmt;

const MAX_ID_BYTES: usize = 4096;
const MAX_METHOD_BYTES: usize = 256;

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(untagged)]
pub enum RequestId {
    Text(String),
    Number(i64),
}

impl RequestId {
    fn validate(&self) -> Result<(), ProtocolError> {
        if matches!(self, Self::Text(value) if value.is_empty() || value.len() > MAX_ID_BYTES) {
            return Err(ProtocolError::InvalidMessage);
        }
        Ok(())
    }
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// Payloads are private, bounded provider data. They must be decoded to typed
/// observations before crossing the persistence/public event boundary. Unknown
/// requests stay requests; no generic approval/default-success is synthesized.
#[derive(Clone, PartialEq)]
pub enum Message {
    Request {
        id: RequestId,
        method: String,
        params: Option<Value>,
    },
    Notification {
        method: String,
        params: Option<Value>,
    },
    Response {
        id: RequestId,
        result: Value,
    },
    Error {
        id: RequestId,
        error: RpcError,
    },
}

impl fmt::Debug for RpcError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RpcError")
            .field("code", &self.code)
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for Message {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Provider payloads may contain prompts, private paths or error strings
        // echoing credentials. Accidental debug logging must not expose them.
        let kind = match self {
            Self::Request { .. } => "Request",
            Self::Notification { .. } => "Notification",
            Self::Response { .. } => "Response",
            Self::Error { .. } => "Error",
        };
        formatter.debug_struct(kind).finish_non_exhaustive()
    }
}

impl Message {
    pub(crate) fn decode(frame: &[u8]) -> Result<Self, ProtocolError> {
        let StrictValue(value) =
            serde_json::from_slice(frame).map_err(|_| ProtocolError::InvalidFrame)?;
        let Value::Object(mut object) = value else {
            return Err(ProtocolError::InvalidMessage);
        };
        // Codex's generated JSONRPCMessage schema omits the JSON-RPC marker.
        // Accept the conventional marker as well, but never another version.
        if let Some(version) = object.remove("jsonrpc")
            && version != "2.0"
        {
            return Err(ProtocolError::InvalidMessage);
        }
        let id = match object.remove("id") {
            Some(id) => {
                let id: RequestId =
                    serde_json::from_value(id).map_err(|_| ProtocolError::InvalidMessage)?;
                id.validate()?;
                Some(id)
            }
            None => None,
        };
        if let Some(method) = object.remove("method") {
            let Value::String(method) = method else {
                return Err(ProtocolError::InvalidMessage);
            };
            validate_method(&method)?;
            let params = object.remove("params");
            if id.is_some() {
                validate_trace(object.remove("trace"))?;
            } else if let Some(emitted_at) = object.remove("emittedAtMs") {
                // ServerNotification adds this field outside JSONRPCMessage's
                // common envelope. Provider wall time is metadata, never an
                // ordering, lease, or terminal-state authority.
                if emitted_at.as_i64().is_none() {
                    return Err(ProtocolError::InvalidMessage);
                }
            }
            require_empty(&object)?;
            return Ok(match id {
                Some(id) => Self::Request { id, method, params },
                None => Self::Notification { method, params },
            });
        }
        let id = id.ok_or(ProtocolError::InvalidMessage)?;
        if let Some(result) = object.remove("result") {
            require_empty(&object)?;
            return Ok(Self::Response { id, result });
        }
        if let Some(error) = object.remove("error") {
            require_empty(&object)?;
            let error = serde_json::from_value(error).map_err(|_| ProtocolError::InvalidMessage)?;
            return Ok(Self::Error { id, error });
        }
        Err(ProtocolError::InvalidMessage)
    }
}

fn validate_trace(trace: Option<Value>) -> Result<(), ProtocolError> {
    match trace {
        None | Some(Value::Null) => Ok(()),
        Some(Value::Object(mut trace)) => {
            for key in ["traceparent", "tracestate"] {
                match trace.remove(key) {
                    None | Some(Value::Null) => {}
                    Some(Value::String(value)) if value.len() <= MAX_ID_BYTES => {}
                    _ => return Err(ProtocolError::InvalidMessage),
                }
            }
            require_empty(&trace)
        }
        _ => Err(ProtocolError::InvalidMessage),
    }
}

fn validate_method(method: &str) -> Result<(), ProtocolError> {
    if method.is_empty()
        || method.len() > MAX_METHOD_BYTES
        || method
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
    {
        return Err(ProtocolError::InvalidMessage);
    }
    Ok(())
}

fn require_empty(object: &Map<String, Value>) -> Result<(), ProtocolError> {
    if object.is_empty() {
        Ok(())
    } else {
        Err(ProtocolError::InvalidMessage)
    }
}

pub fn encode_request(
    id: &RequestId,
    method: &str,
    params: Value,
) -> Result<Vec<u8>, ProtocolError> {
    id.validate()?;
    validate_method(method)?;
    encode(json!({"id": id, "method": method, "params": params}))
}

pub fn encode_notification(method: &str, params: Value) -> Result<Vec<u8>, ProtocolError> {
    validate_method(method)?;
    encode(json!({"method": method, "params": params}))
}

fn encode(value: Value) -> Result<Vec<u8>, ProtocolError> {
    let mut frame = serde_json::to_vec(&value).map_err(|_| ProtocolError::InvalidMessage)?;
    if frame.len() > MAX_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge);
    }
    frame.push(b'\n');
    Ok(frame)
}
