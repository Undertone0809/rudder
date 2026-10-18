use crate::runtime_bindings::Error;
use uuid::Uuid;

pub(super) type Result<T> = std::result::Result<T, Error>;

pub(super) fn http(status: u16, message: impl Into<String>) -> Error {
    Error::Http(status, message.into())
}

pub(super) fn canonical_uuid(value: &str, field: &str) -> Result<String> {
    Uuid::parse_str(value)
        .map(|value| value.to_string())
        .map_err(|_| http(400, format!("Invalid {field}")))
}

pub(super) fn owner_token(value: &str) -> Result<String> {
    if value.trim().is_empty() || value.len() > 1024 {
        return Err(http(400, "Invalid owner token"));
    }
    Ok(value.to_owned())
}

pub(super) fn completeness(value: &str) -> Result<&'static str> {
    match value {
        "complete" => Ok("complete"),
        "partial" => Ok("partial"),
        "terminal_only" => Ok("terminal_only"),
        "unknown" => Ok("unknown"),
        _ => Err(http(400, "Invalid span completeness")),
    }
}

pub(super) fn opaque_locator(value: &str, field: &str) -> Result<String> {
    if value.trim().is_empty() || value.len() > 4096 {
        return Err(http(400, format!("Invalid {field}")));
    }
    Ok(value.to_owned())
}

pub(super) fn optional_locator(value: Option<&str>, field: &str) -> Result<Option<String>> {
    value.map(|value| opaque_locator(value, field)).transpose()
}
