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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn node_pkcs8_v1_and_v3_signature_roundtrip() {
        // Fixed synthetic seed; never a user key. Node crypto exports this V1 prefix.
        let mut bytes = vec![
            0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22,
            0x04, 0x20,
        ];
        bytes.extend_from_slice(&[7u8; 32]);
        let config = json!({"devicePrivateKeyPem":format!("-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----",STANDARD.encode(bytes))});
        let id = Identity::new(&config).unwrap().unwrap();
        let scopes = vec!["operator.read".into(), "operator.write".into()];
        let signed = payload(&id.id, &config, &scopes, Some("token"), "nonce", 1234);
        assert_eq!(
            signed,
            format!(
                "v3|{}|gateway-client|backend|operator|operator.read,operator.write|1234|token|nonce|{}|",
                id.id,
                platform()
            )
        );
        let device = id.device(&config, &scopes, Some("token"), "nonce", 1234);
        ring::signature::UnparsedPublicKey::new(
            &ring::signature::ED25519,
            URL_SAFE_NO_PAD.decode(&id.public).unwrap(),
        )
        .verify(
            signed.as_bytes(),
            &URL_SAFE_NO_PAD
                .decode(device["signature"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(Identity::new(&config).unwrap().unwrap().id, id.id);
    }
}
