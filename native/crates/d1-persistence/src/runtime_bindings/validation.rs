use super::{Result, http};
use uuid::Uuid;

pub(super) fn canonical_uuid(value: &str, field: &str) -> Result<String> {
    Uuid::parse_str(value)
        .map(|value| value.to_string())
        .map_err(|_| http(400, format!("Invalid {field}")))
}

pub(super) fn canonical_ref(value: Option<&str>, default: &str, field: &str) -> Result<String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        if default.is_empty() {
            return Err(http(409, format!("Agent has an invalid {field}")));
        }
        return Ok(default.to_owned());
    };
    if value.len() > 256
        || value == "."
        || value == ".."
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return Err(http(400, format!("Invalid {field}")));
    }
    Ok(value.to_owned())
}

pub(super) fn canonical_optional_ref(value: Option<&str>, field: &str) -> Result<Option<String>> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    canonical_ref(Some(value), "", field).map(Some)
}
