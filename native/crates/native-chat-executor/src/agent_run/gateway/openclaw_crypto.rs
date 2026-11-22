use super::*;
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};

pub(super) struct Identity {
    pair: Ed25519KeyPair,
    pub id: String,
    pub public: String,
}
impl Identity {
    pub fn new(config: &Value) -> Result<Option<Self>, Error> {
        if boolean(&config["disableDeviceAuth"], false) {
            return Ok(None);
        }
        let generated;
        let configured;
        let bytes = if let Some(pem) = nonempty(&config["devicePrivateKeyPem"]) {
            let encoded: String = pem
                .lines()
                .filter(|line| !line.starts_with("-----"))
                .collect();
            configured = STANDARD
                .decode(encoded)
                .map_err(|_| Error::Failed("Invalid OpenClaw device private key".into()))?;
            configured.as_slice()
        } else {
            generated = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
                .map_err(|_| Error::Failed("OpenClaw device key generation failed".into()))?;
            generated.as_ref()
        };
        // Node's exported PKCS8 may be V1 (private seed only), as well as V2.
        let pair = Ed25519KeyPair::from_pkcs8_maybe_unchecked(bytes)
            .map_err(|_| Error::Failed("Invalid OpenClaw Ed25519 device key".into()))?;
        let raw = pair.public_key().as_ref();
        let id: String = ring::digest::digest(&ring::digest::SHA256, raw)
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let public = URL_SAFE_NO_PAD.encode(raw);
        Ok(Some(Self { pair, id, public }))
    }
    pub fn device(
        &self,
        config: &Value,
        scopes: &[String],
        token: Option<&str>,
        nonce: &str,
        signed_at: u128,
    ) -> Value {
        let signed = payload(&self.id, config, scopes, token, nonce, signed_at);
        json!({"id":self.id,"publicKey":self.public,"signature":URL_SAFE_NO_PAD.encode(self.pair.sign(signed.as_bytes()).as_ref()),"signedAt":signed_at,"nonce":nonce})
    }
}
pub(super) fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}
fn payload(
    id: &str,
    config: &Value,
    scopes: &[String],
    token: Option<&str>,
    nonce: &str,
    signed_at: u128,
) -> String {
    [
        "v3".to_owned(),
        id.to_owned(),
        configured(config, "clientId", "gateway-client"),
        configured(config, "clientMode", "backend"),
        configured(config, "role", "operator"),
        scopes.join(","),
        signed_at.to_string(),
        token.unwrap_or("").to_owned(),
        nonce.to_owned(),
        platform().to_owned(),
        configured(config, "deviceFamily", ""),
    ]
    .join("|")
}
