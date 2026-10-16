use super::{Result, http};
use uuid::Uuid;

pub(super) fn canonical_uuid(value: &str, field: &str) -> Result<String> {
    Uuid::parse_str(value)
        .map(|id| id.to_string())
        .map_err(|_| http(400, format!("Invalid {field}")))
}

pub(super) fn client_mutation_id(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 120 || value.chars().any(char::is_control) {
        return Err(http(400, "Invalid client mutation id"));
    }
    Ok(value.to_owned())
}

pub(super) fn body(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 20_000 {
        return Err(http(
            400,
            "Chat message body must contain 1 to 20000 characters",
        ));
    }
    Ok(value.to_owned())
}

pub(super) fn fingerprint(body: &str) -> String {
    use sha2::{Digest, Sha256};

    let digest = Sha256::digest(body.as_bytes());
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("native-chat-v1:{hex}")
}
