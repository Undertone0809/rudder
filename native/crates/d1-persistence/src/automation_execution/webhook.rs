use super::*;
use ring::hmac;

/// Headers and exact request bytes; never serialize or log this input.
pub struct PublicFireInput<'a> {
    pub authorization: Option<&'a str>,
    pub signature: Option<&'a str>,
    pub timestamp: Option<&'a str>,
    pub idempotency_key: Option<&'a str>,
    pub raw_body: &'a [u8],
    pub payload: Option<&'a Value>,
}
pub async fn fire_public(
    pool: &PgPool,
    public_id: &str,
    input: PublicFireInput<'_>,
    host: &Host<'_>,
) -> Result<Value> {
    let mut tx = pool.begin().await?;
    let target=sqlx::query_as::<_,(String,String)>("SELECT id::text,automation_id::text FROM automation_triggers WHERE public_id=$1 AND kind='webhook'")
        .bind(public_id).fetch_optional(&mut *tx).await?.ok_or_else(||http(404,"Automation trigger not found"))?;
    let automation = automation_management::projection::automation(&mut tx, &target.1, true)
        .await?
        .ok_or_else(|| http(404, "Automation not found"))?;
    let trigger = automation_management::projection::trigger(&mut tx, &target.0, true)
        .await?
        .ok_or_else(|| http(404, "Automation trigger not found"))?;
    if trigger["publicId"] != public_id
        || trigger["automationId"] != automation["id"]
        || trigger["orgId"] != automation["orgId"]
    {
        return Err(http(404, "Automation trigger not found"));
    }
    if trigger["enabled"] != true || automation["status"] != "active" {
        return Err(http(409, "Automation trigger is not active"));
    }
    let org = text(&automation, "orgId").unwrap_or_default().to_owned();
    let secret_id = text(&trigger, "secretId")
        .ok_or_else(|| http(404, "Automation trigger secret not found"))?;
    let secret = crate::secrets::resolve_local_runtime_secret_reference(
        &mut tx,
        &org,
        &json!({"secretId":secret_id,"version":"latest"}),
    )
    .await?
    .ok_or_else(|| http(404, "Automation trigger secret not found"))?;
    let now = (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64;
    verify(&trigger, &secret, &input, now)?;
    let run = dispatch::dispatch(
        &mut tx,
        automation,
        Some(&trigger),
        "webhook",
        input.payload,
        input.idempotency_key,
        host,
    )
    .await?;
    dispatch::audit(&mut tx, &org, "system", "automation-webhook", None, &run).await?;
    tx.commit().await?;
    Ok(run)
}
fn verify(trigger: &Value, secret: &str, input: &PublicFireInput<'_>, now: i64) -> Result<()> {
    let unauthorized = || http(401, "Unauthorized");
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    if trigger["signingMode"] == "bearer" {
        let expected = format!("Bearer {secret}");
        let provided = input.authorization.unwrap_or_default().trim();
        let tag = hmac::sign(&key, expected.as_bytes());
        hmac::verify(&key, provided.as_bytes(), tag.as_ref()).map_err(|_| unauthorized())?;
    } else {
        let stamp = input.timestamp.unwrap_or_default().trim();
        let signature = input.signature.unwrap_or_default().trim();
        if stamp.is_empty() || signature.is_empty() {
            return Err(unauthorized());
        }
        let timestamp = stamp
            .parse::<f64>()
            .ok()
            .filter(|v| v.is_finite())
            .ok_or_else(unauthorized)?;
        let timestamp = if timestamp > 1e12 {
            timestamp
        } else {
            timestamp * 1000.0
        };
        let window = trigger["replayWindowSec"].as_f64().unwrap_or(300.0) * 1000.0;
        if (now as f64 - timestamp).abs() > window {
            return Err(unauthorized());
        }
        let signature = signature.strip_prefix("sha256=").unwrap_or(signature);
        if signature.len() != 64 {
            return Err(unauthorized());
        }
        let bytes = signature
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let a = (pair[0] as char).to_digit(16)?;
                let b = (pair[1] as char).to_digit(16)?;
                Some(((a << 4) | b) as u8)
            })
            .collect::<Option<Vec<_>>>()
            .ok_or_else(unauthorized)?;
        // Node compares its lower-case hexadecimal wire representation.
        if signature.bytes().any(|b| b.is_ascii_uppercase()) {
            return Err(unauthorized());
        }
        let mut signed = stamp.as_bytes().to_vec();
        signed.push(b'.');
        signed.extend_from_slice(input.raw_body);
        hmac::verify(&key, &signed, &bytes).map_err(|_| unauthorized())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signatures_bind_exact_bytes_timestamp_window_and_rotated_secret() {
        let raw = b"{\"fixture\": 1}";
        let stamp = "1793100000";
        let trigger = json!({"signingMode":"hmac_sha256","replayWindowSec":300});
        let key = hmac::Key::new(hmac::HMAC_SHA256, b"synthetic-webhook-secret");
        let tag = hmac::sign(
            &key,
            format!("{stamp}.{}", std::str::from_utf8(raw).unwrap()).as_bytes(),
        );
        let signature = tag
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let input = PublicFireInput {
            authorization: None,
            signature: Some(&signature),
            timestamp: Some(stamp),
            idempotency_key: None,
            raw_body: raw,
            payload: None,
        };
        assert!(
            verify(
                &trigger,
                "synthetic-webhook-secret",
                &input,
                1_793_100_000_000
            )
            .is_ok()
        );
        assert!(verify(&trigger, "rotated-secret", &input, 1_793_100_000_000).is_err());
        assert!(
            verify(
                &trigger,
                "synthetic-webhook-secret",
                &input,
                1_793_100_300_001
            )
            .is_err()
        );
        let changed = PublicFireInput {
            raw_body: b"{\"fixture\":1}",
            ..input
        };
        assert!(
            verify(
                &trigger,
                "synthetic-webhook-secret",
                &changed,
                1_793_100_000_000
            )
            .is_err()
        );
    }
}
