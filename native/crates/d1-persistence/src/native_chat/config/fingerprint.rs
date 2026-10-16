use sha2::{Digest, Sha256};

pub(super) fn json_revision(value: &serde_json::Value) -> String {
    let encoded = serde_json::to_vec(value).expect("JSON values serialize");
    digest(&encoded)
}

pub(super) fn digest(bytes: &[u8]) -> String {
    let hash = Sha256::digest(bytes);
    let hex = hash
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("sha256:{hex}")
}
