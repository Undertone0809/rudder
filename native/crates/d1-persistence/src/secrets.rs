//! Organization secret CRUD for the private, signed Rust foundation route.
//!
//! The private adapter signs its Board decision; public native callers revalidate
//! identity and organization access inside each mutation transaction. This owns
//! local provider encryption, version allocation under row locks, and the
//! activity/outbox receipts in the same transaction as each mutation.

use crate::{
    activity::{ActivityActor, write_activity},
    agent_core::{NativeAgentAccess, NativeAgentAuthorizer},
};
use base64::{Engine as _, engine::general_purpose};
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction, postgres::PgRow};
use std::{env, fs, fs::OpenOptions, io::Write, path::PathBuf};
use uuid::Uuid;

const SECRET_COLUMNS: &str = "id::text AS id, org_id::text AS org_id, name, provider, purpose, external_ref, latest_version, description, created_by_agent_id::text AS created_by_agent_id, created_by_user_id, to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at, to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at";
const PROVIDERS: &[(&str, &str, bool)] = &[
    ("local_encrypted", "Local encrypted (default)", false),
    ("aws_secrets_manager", "AWS Secrets Manager", true),
    ("gcp_secret_manager", "GCP Secret Manager", true),
    ("vault", "HashiCorp Vault", true),
];

#[derive(Debug, thiserror::Error)]
pub enum SecretsError {
    #[error("{1}")]
    Http(u16, String),
    #[error("secret database operation failed")]
    Database(#[from] sqlx::Error),
}

pub fn database_unavailable(error: &sqlx::Error) -> bool {
    match error {
        sqlx::Error::PoolTimedOut
        | sqlx::Error::PoolClosed
        | sqlx::Error::Io(_)
        | sqlx::Error::Tls(_) => true,
        sqlx::Error::Database(error) => error.code().is_some_and(|code| {
            code.starts_with("08") || matches!(code.as_ref(), "57P01" | "57P02" | "57P03")
        }),
        _ => false,
    }
}

fn http(status: u16, message: impl Into<String>) -> SecretsError {
    SecretsError::Http(status, message.into())
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn object(value: &Value) -> Result<&serde_json::Map<String, Value>, SecretsError> {
    value
        .as_object()
        .ok_or_else(|| http(400, "Validation error"))
}

fn reject_unknown_keys(value: &Value, allowed: &[&str]) -> Result<(), SecretsError> {
    let fields = object(value)?;
    if fields.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(http(400, "Validation error"));
    }
    Ok(())
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, SecretsError> {
    match value.get(key) {
        Some(Value::String(candidate)) if !candidate.is_empty() => Ok(candidate),
        _ => Err(http(400, "Validation error")),
    }
}

fn optional_string(value: &Value, key: &str) -> Result<Option<Option<String>>, SecretsError> {
    match value.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(candidate)) => Ok(Some(Some(candidate.clone()))),
        _ => Err(http(400, "Validation error")),
    }
}

fn parse_uuid(value: &str) -> Result<String, SecretsError> {
    Uuid::parse_str(value)
        .map(|parsed| parsed.to_string())
        .map_err(|_| http(404, "Secret not found"))
}

fn is_unique_violation(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .and_then(|database| database.code())
        .is_some_and(|code| code.as_ref() == "23505")
}

fn secret_json(row: &PgRow) -> Result<Value, SecretsError> {
    Ok(json!({
        "id": row.try_get::<String, _>("id")?,
        "orgId": row.try_get::<String, _>("org_id")?,
        "name": row.try_get::<String, _>("name")?,
        "provider": row.try_get::<String, _>("provider")?,
        "purpose": row.try_get::<String, _>("purpose")?,
        "externalRef": row.try_get::<Option<String>, _>("external_ref")?,
        "latestVersion": row.try_get::<i32, _>("latest_version")?,
        "description": row.try_get::<Option<String>, _>("description")?,
        "createdByAgentId": row.try_get::<Option<String>, _>("created_by_agent_id")?,
        "createdByUserId": row.try_get::<Option<String>, _>("created_by_user_id")?,
        "createdAt": row.try_get::<String, _>("created_at")?,
        "updatedAt": row.try_get::<String, _>("updated_at")?,
    }))
}

async fn write_secret_activity(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: &str,
    actor_id: &str,
    action: &str,
    secret_id: &str,
    details: &Value,
) -> Result<(), SecretsError> {
    write_activity(
        tx,
        org,
        &ActivityActor {
            actor_type: "user",
            actor_id: actor_id.to_owned(),
            run_id: None,
        },
        action,
        "secret",
        secret_id,
        Some(details),
    )
    .await?;
    Ok(())
}

fn decode_master_key(value: &str) -> Option<[u8; 32]> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        let mut key = [0u8; 32];
        for (index, pair) in value.as_bytes().as_chunks::<2>().0.iter().enumerate() {
            let pair = std::str::from_utf8(pair).ok()?;
            key[index] = u8::from_str_radix(pair, 16).ok()?;
        }
        return Some(key);
    }
    for engine in [
        &general_purpose::STANDARD,
        &general_purpose::STANDARD_NO_PAD,
        &general_purpose::URL_SAFE,
        &general_purpose::URL_SAFE_NO_PAD,
    ] {
        if let Ok(decoded) = engine.decode(value)
            && let Ok(key) = <[u8; 32]>::try_from(decoded.as_slice())
        {
            return Some(key);
        }
    }
    <[u8; 32]>::try_from(value.as_bytes()).ok()
}

fn read_key_file(path: &PathBuf) -> Result<[u8; 32], SecretsError> {
    let raw = fs::read_to_string(path).map_err(|_| http(500, "Secret provider unavailable"))?;
    decode_master_key(&raw)
        .ok_or_else(|| http(400, "Invalid secrets master key at configured file"))
}

fn key_file_path() -> Result<PathBuf, SecretsError> {
    if let Ok(configured) = env::var("RUDDER_SECRETS_MASTER_KEY_FILE")
        && !configured.trim().is_empty()
    {
        let path = PathBuf::from(configured.trim());
        return if path.is_absolute() {
            Ok(path)
        } else {
            env::current_dir()
                .map(|current| current.join(path))
                .map_err(|_| http(500, "Secret provider unavailable"))
        };
    }
    env::current_dir()
        .map(|current| current.join("data/secrets/master.key"))
        .map_err(|_| http(500, "Secret provider unavailable"))
}

fn load_master_key() -> Result<[u8; 32], SecretsError> {
    if let Ok(raw) = env::var("RUDDER_SECRETS_MASTER_KEY")
        && !raw.trim().is_empty()
    {
        return decode_master_key(&raw).ok_or_else(|| {
            http(
                400,
                "Invalid RUDDER_SECRETS_MASTER_KEY (expected 32-byte base64, 64-char hex, or raw 32-char string)",
            )
        });
    }

    let path = key_file_path()?;
    match read_key_file(&path) {
        Ok(key) => Ok(key),
        Err(SecretsError::Http(500, _)) if !path.exists() => create_master_key(&path),
        Err(error) => Err(error),
    }
}

fn create_master_key(path: &PathBuf) -> Result<[u8; 32], SecretsError> {
    let parent = path
        .parent()
        .ok_or_else(|| http(500, "Secret provider unavailable"))?;
    fs::create_dir_all(parent).map_err(|_| http(500, "Secret provider unavailable"))?;
    let mut key = [0u8; 32];
    getrandom::getrandom(&mut key).map_err(|_| http(500, "Secret provider unavailable"))?;
    let encoded = general_purpose::STANDARD.encode(key);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(path) {
        Ok(mut file) => {
            file.write_all(encoded.as_bytes())
                .and_then(|_| file.sync_all())
                .map_err(|_| http(500, "Secret provider unavailable"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                    .map_err(|_| http(500, "Secret provider unavailable"))?;
            }
            Ok(key)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => read_key_file(path),
        Err(_) => Err(http(500, "Secret provider unavailable")),
    }
}

fn encrypt_value_with_key(
    value: &str,
    key_bytes: &[u8; 32],
) -> Result<(Value, String), SecretsError> {
    let key = UnboundKey::new(&AES_256_GCM, key_bytes)
        .map(LessSafeKey::new)
        .map_err(|_| http(500, "Secret encryption failed"))?;
    let mut nonce_bytes = [0u8; 12];
    getrandom::getrandom(&mut nonce_bytes).map_err(|_| http(500, "Secret encryption failed"))?;
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);
    let mut ciphertext_and_tag = value.as_bytes().to_vec();
    key.seal_in_place_append_tag(nonce, Aad::empty(), &mut ciphertext_and_tag)
        .map_err(|_| http(500, "Secret encryption failed"))?;
    let tag_offset = ciphertext_and_tag.len() - 16;
    let tag = &ciphertext_and_tag[tag_offset..];
    let ciphertext = &ciphertext_and_tag[..tag_offset];
    let value_sha256 = Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok((
        json!({
            "scheme": "local_encrypted_v1",
            "iv": general_purpose::STANDARD.encode(nonce_bytes),
            "tag": general_purpose::STANDARD.encode(tag),
            "ciphertext": general_purpose::STANDARD.encode(ciphertext),
        }),
        value_sha256,
    ))
}

pub(crate) fn encrypt_value(value: &str) -> Result<(Value, String), SecretsError> {
    encrypt_value_with_key(value, &load_master_key()?)
}

fn decrypt_material_with_key(
    material: &Value,
    key_bytes: &[u8; 32],
) -> Result<String, SecretsError> {
    if material.get("scheme").and_then(Value::as_str) != Some("local_encrypted_v1") {
        return Err(http(400, "Invalid local_encrypted secret material"));
    }
    let decode_field = |key: &str| -> Result<Vec<u8>, SecretsError> {
        material
            .get(key)
            .and_then(Value::as_str)
            .and_then(|encoded| general_purpose::STANDARD.decode(encoded).ok())
            .ok_or_else(|| http(400, "Invalid local_encrypted secret material"))
    };
    let iv = decode_field("iv")?;
    let tag = decode_field("tag")?;
    let mut ciphertext = decode_field("ciphertext")?;
    let nonce_bytes = <[u8; 12]>::try_from(iv.as_slice())
        .map_err(|_| http(400, "Invalid local_encrypted secret material"))?;
    if tag.len() != 16 {
        return Err(http(400, "Invalid local_encrypted secret material"));
    }
    ciphertext.extend_from_slice(&tag);
    let key = UnboundKey::new(&AES_256_GCM, key_bytes)
        .map(LessSafeKey::new)
        .map_err(|_| http(400, "Invalid local_encrypted secret material"))?;
    let plaintext = key
        .open_in_place(
            Nonce::assume_unique_for_key(nonce_bytes),
            Aad::empty(),
            &mut ciphertext,
        )
        .map_err(|_| http(400, "Invalid local_encrypted secret material"))?;
    String::from_utf8(plaintext.to_vec())
        .map_err(|_| http(400, "Invalid local_encrypted secret material"))
}

/// Decrypt an already stored local secret for an in-process native runtime.
/// This is deliberately read-only: unlike secret creation it never creates a
/// master key, and it returns no diagnostic containing secret material.
pub(crate) fn decrypt_runtime_secret(material: &Value, expected_sha256: &str) -> Option<String> {
    let key = if let Ok(raw) = env::var("RUDDER_SECRETS_MASTER_KEY") {
        decode_master_key(&raw)?
    } else {
        let path = key_file_path().ok()?;
        if !path.is_file() {
            return None;
        }
        read_key_file(&path).ok()?
    };
    let value = decrypt_material_with_key(material, &key).ok()?;
    let actual = Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    (actual == expected_sha256).then_some(value)
}

/// Resolve a persisted secret reference for an in-process native workflow.
/// Only the existing local-encrypted provider can be materialized here;
/// external providers remain governed by their configured provider adapter.
pub(crate) async fn resolve_local_runtime_secret_reference(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    binding: &Value,
) -> Result<Option<String>, SecretsError> {
    let Some(secret_id) = binding.get("secretId").and_then(Value::as_str) else {
        return Ok(None);
    };
    let (latest, version) = match binding.get("version") {
        None => (true, 0),
        Some(Value::String(value)) if value == "latest" => (true, 0),
        Some(Value::Number(value)) => {
            let Some(version) = value
                .as_u64()
                .and_then(|version| i32::try_from(version).ok())
                .filter(|version| *version > 0)
            else {
                return Ok(None);
            };
            (false, version)
        }
        _ => return Ok(None),
    };
    let row = sqlx::query(
        "SELECT s.provider,s.purpose,v.material::text AS material,v.value_sha256,
                v.revoked_at IS NOT NULL AS revoked
         FROM organization_secrets s
         JOIN organization_secret_versions v ON v.secret_id=s.id
         WHERE s.org_id=$1::uuid AND s.id=$2::uuid
           AND v.version=CASE WHEN $3::boolean THEN s.latest_version ELSE $4::integer END
         FOR SHARE OF s,v",
    )
    .bind(org_id)
    .bind(secret_id)
    .bind(latest)
    .bind(version)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let provider: String = row.try_get("provider")?;
    if provider != "local_encrypted" {
        return Err(http(
            422,
            format!("{provider} provider is not configured in this deployment"),
        ));
    }
    if row.try_get::<String, _>("purpose")? != "user_managed"
        || row.try_get::<bool, _>("revoked")?
    {
        return Ok(None);
    }
    let material = row
        .try_get::<String, _>("material")
        .ok()
        .and_then(|value| serde_json::from_str::<Value>(&value).ok());
    let hash = row.try_get::<String, _>("value_sha256").ok();
    Ok(material
        .zip(hash)
        .and_then(|(material, hash)| decrypt_runtime_secret(&material, &hash)))
}

fn provider_list() -> Value {
    Value::Array(
        PROVIDERS
            .iter()
            .map(|(id, label, requires_external_ref)| {
                json!({"id":id,"label":label,"requiresExternalRef":requires_external_ref})
            })
            .collect(),
    )
}

fn provider_is_supported(provider: &str) -> bool {
    PROVIDERS.iter().any(|(id, _, _)| *id == provider)
}

async fn list_secrets(pool: &PgPool, org: &str) -> Result<Value, SecretsError> {
    let query = format!(
        "SELECT {SECRET_COLUMNS} FROM organization_secrets WHERE org_id=$1::uuid AND purpose='user_managed' ORDER BY created_at DESC"
    );
    let rows = sqlx::query(&query).bind(org).fetch_all(pool).await?;
    Ok(Value::Array(
        rows.iter()
            .map(secret_json)
            .collect::<Result<Vec<_>, _>>()?,
    ))
}

async fn create_secret(
    pool: &PgPool,
    authorizer: Option<&dyn NativeAgentAuthorizer>,
    org: &str,
    actor_id: &str,
    input: &Value,
) -> Result<Value, SecretsError> {
    reject_unknown_keys(
        input,
        &["name", "provider", "value", "description", "externalRef"],
    )?;
    let name = required_string(input, "name")?;
    let value = required_string(input, "value")?;
    let provider = match input.get("provider") {
        None => "local_encrypted",
        Some(Value::String(provider)) if provider_is_supported(provider) => provider.as_str(),
        _ => return Err(http(400, "Validation error")),
    };
    let description = optional_string(input, "description")?;
    // The current local provider deliberately discards external references.
    // Keep accepting the field for wire compatibility, but persist the
    // provider's normalized result rather than the caller's unused value.
    let _external_ref = optional_string(input, "externalRef")?;
    let mut tx = pool.begin().await?;
    revalidate_actor(&mut tx, org, authorizer).await?;
    if provider != "local_encrypted" {
        return Err(http(
            422,
            format!("{provider} provider is not configured in this deployment"),
        ));
    }
    let (material, value_sha256) = encrypt_value(value)?;
    let secret_id = match sqlx::query_scalar::<_, String>(
        "INSERT INTO organization_secrets (org_id,name,provider,purpose,external_ref,latest_version,description,created_by_user_id) VALUES ($1::uuid,$2,$3,'user_managed',$4,1,$5,$6) RETURNING id::text",
    )
    .bind(org)
    .bind(name)
    .bind(provider)
    .bind(Option::<String>::None)
    .bind(description.as_ref().and_then(Option::as_deref))
    .bind(actor_id)
    .fetch_one(&mut *tx)
    .await
    {
        Ok(id) => id,
        Err(error) if is_unique_violation(&error) => {
            let _ = tx.rollback().await;
            return Err(http(409, format!("Secret already exists: {name}")));
        }
        Err(error) => return Err(error.into()),
    };
    sqlx::query("INSERT INTO organization_secret_versions (secret_id,version,material,value_sha256,created_by_user_id) VALUES ($1::uuid,1,$2::jsonb,$3,$4)")
        .bind(&secret_id)
        .bind(material.to_string())
        .bind(value_sha256)
        .bind(actor_id)
        .execute(&mut *tx)
        .await?;
    let response = {
        let query = format!(
            "SELECT {SECRET_COLUMNS} FROM organization_secrets WHERE id=$1::uuid AND org_id=$2::uuid"
        );
        let row = sqlx::query(&query)
            .bind(&secret_id)
            .bind(org)
            .fetch_one(&mut *tx)
            .await?;
        secret_json(&row)?
    };
    let details = json!({"name":name,"provider":provider});
    write_secret_activity(
        &mut tx,
        org,
        actor_id,
        "secret.created",
        &secret_id,
        &details,
    )
    .await?;
    tx.commit().await?;
    Ok(response)
}

async fn lock_user_secret(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: &str,
    id: &str,
) -> Result<Option<PgRow>, SecretsError> {
    let query = format!(
        "SELECT {SECRET_COLUMNS} FROM organization_secrets WHERE id=$1::uuid AND org_id=$2::uuid AND purpose='user_managed' FOR UPDATE"
    );
    Ok(sqlx::query(&query)
        .bind(id)
        .bind(org)
        .fetch_optional(&mut **tx)
        .await?)
}

async fn rotate_secret(
    pool: &PgPool,
    authorizer: Option<&dyn NativeAgentAuthorizer>,
    org: &str,
    actor_id: &str,
    id: &str,
    input: &Value,
) -> Result<Value, SecretsError> {
    reject_unknown_keys(input, &["value", "externalRef"])?;
    let value = required_string(input, "value")?;
    let _requested_external_ref = optional_string(input, "externalRef")?;
    let mut tx = pool.begin().await?;
    revalidate_actor(&mut tx, org, authorizer).await?;
    let row = lock_user_secret(&mut tx, org, id)
        .await?
        .ok_or_else(|| http(404, "Secret not found"))?;
    let secret_id: String = row.try_get("id")?;
    let latest_version: i32 = row.try_get("latest_version")?;
    let provider: String = row.try_get("provider")?;
    if provider != "local_encrypted" {
        return Err(http(
            422,
            format!("{provider} provider is not configured in this deployment"),
        ));
    }
    let (material, value_sha256) = encrypt_value(value)?;
    let next_version = latest_version
        .checked_add(1)
        .ok_or_else(|| http(500, "Internal server error"))?;
    sqlx::query("INSERT INTO organization_secret_versions (secret_id,version,material,value_sha256,created_by_user_id) VALUES ($1::uuid,$2,$3::jsonb,$4,$5)")
        .bind(&secret_id)
        .bind(next_version)
        .bind(material.to_string())
        .bind(value_sha256)
        .bind(actor_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE organization_secrets SET latest_version=$3,external_ref=$4,updated_at=now() WHERE id=$1::uuid AND org_id=$2::uuid AND purpose='user_managed'")
        .bind(&secret_id)
        .bind(org)
        .bind(next_version)
        .bind(Option::<String>::None)
        .execute(&mut *tx)
        .await?;
    let response = {
        let query = format!(
            "SELECT {SECRET_COLUMNS} FROM organization_secrets WHERE id=$1::uuid AND org_id=$2::uuid"
        );
        let row = sqlx::query(&query)
            .bind(&secret_id)
            .bind(org)
            .fetch_one(&mut *tx)
            .await?;
        secret_json(&row)?
    };
    let details = json!({"version":next_version});
    write_secret_activity(
        &mut tx,
        org,
        actor_id,
        "secret.rotated",
        &secret_id,
        &details,
    )
    .await?;
    tx.commit().await?;
    Ok(response)
}

async fn update_secret(
    pool: &PgPool,
    authorizer: Option<&dyn NativeAgentAuthorizer>,
    org: &str,
    actor_id: &str,
    id: &str,
    input: &Value,
) -> Result<Value, SecretsError> {
    reject_unknown_keys(input, &["name", "description", "externalRef"])?;
    let name = match input.get("name") {
        None => None,
        Some(Value::String(name)) if !name.is_empty() => Some(name.as_str()),
        _ => return Err(http(400, "Validation error")),
    };
    let description = optional_string(input, "description")?;
    let external_ref = optional_string(input, "externalRef")?;
    let mut tx = pool.begin().await?;
    revalidate_actor(&mut tx, org, authorizer).await?;
    let row = lock_user_secret(&mut tx, org, id)
        .await?
        .ok_or_else(|| http(404, "Secret not found"))?;
    let secret_id: String = row.try_get("id")?;
    let current_name: String = row.try_get("name")?;
    let name = name.unwrap_or(&current_name);
    if name != current_name {
        let duplicate = sqlx::query_scalar::<_, String>(
            "SELECT id::text FROM organization_secrets WHERE org_id=$1::uuid AND name=$2 AND id<>$3::uuid LIMIT 1",
        )
        .bind(org)
        .bind(name)
        .bind(&secret_id)
        .fetch_optional(&mut *tx)
        .await?;
        if duplicate.is_some() {
            return Err(http(409, format!("Secret already exists: {name}")));
        }
    }
    let updated_description = description.as_ref().and_then(|value| value.as_ref());
    let updated_external_ref = external_ref.as_ref().and_then(|value| value.as_ref());
    let update_description = description.is_some();
    let update_external_ref = external_ref.is_some();
    if let Err(error) = sqlx::query("UPDATE organization_secrets SET name=$3, description=CASE WHEN $4 THEN $5 ELSE description END, external_ref=CASE WHEN $6 THEN $7 ELSE external_ref END, updated_at=now() WHERE id=$1::uuid AND org_id=$2::uuid AND purpose='user_managed'")
        .bind(&secret_id)
        .bind(org)
        .bind(name)
        .bind(update_description)
        .bind(updated_description)
        .bind(update_external_ref)
        .bind(updated_external_ref)
        .execute(&mut *tx)
        .await
    {
        if is_unique_violation(&error) {
            return Err(http(409, format!("Secret already exists: {name}")));
        }
        return Err(error.into());
    }
    let response = {
        let query = format!(
            "SELECT {SECRET_COLUMNS} FROM organization_secrets WHERE id=$1::uuid AND org_id=$2::uuid"
        );
        let row = sqlx::query(&query)
            .bind(&secret_id)
            .bind(org)
            .fetch_one(&mut *tx)
            .await?;
        secret_json(&row)?
    };
    let details = json!({"name":response["name"]});
    write_secret_activity(
        &mut tx,
        org,
        actor_id,
        "secret.updated",
        &secret_id,
        &details,
    )
    .await?;
    tx.commit().await?;
    Ok(response)
}

async fn delete_secret(
    pool: &PgPool,
    authorizer: Option<&dyn NativeAgentAuthorizer>,
    org: &str,
    actor_id: &str,
    id: &str,
) -> Result<Value, SecretsError> {
    let mut tx = pool.begin().await?;
    revalidate_actor(&mut tx, org, authorizer).await?;
    let row = lock_user_secret(&mut tx, org, id)
        .await?
        .ok_or_else(|| http(404, "Secret not found"))?;
    let secret_id: String = row.try_get("id")?;
    let name: String = row.try_get("name")?;
    sqlx::query("DELETE FROM organization_secrets WHERE id=$1::uuid AND org_id=$2::uuid AND purpose='user_managed'")
        .bind(&secret_id)
        .bind(org)
        .execute(&mut *tx)
        .await?;
    let details = json!({"name":name});
    write_secret_activity(
        &mut tx,
        org,
        actor_id,
        "secret.deleted",
        &secret_id,
        &details,
    )
    .await?;
    tx.commit().await?;
    Ok(json!({"ok":true}))
}

pub async fn execute_secrets(
    pool: &PgPool,
    organization_id: &str,
    actor_id: &str,
    request: &Value,
) -> Result<(u16, Value), SecretsError> {
    execute_secrets_with_authorizer(pool, organization_id, actor_id, request, None).await
}

/// Public native ingress supplies credential proof separately from client JSON.
/// The existing mutation checks it again on the same transaction as its writes.
pub async fn execute_secrets_for_actor(
    pool: &PgPool,
    organization_id: &str,
    actor_id: &str,
    request: &Value,
    authorizer: &dyn NativeAgentAuthorizer,
) -> Result<(u16, Value), SecretsError> {
    if !matches!(
        text(request, "operation"),
        Some("create" | "rotate" | "update" | "delete")
    ) {
        return Err(http(400, "Validation error"));
    }
    execute_secrets_with_authorizer(pool, organization_id, actor_id, request, Some(authorizer))
        .await
}

async fn revalidate_actor(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    authorizer: Option<&dyn NativeAgentAuthorizer>,
) -> Result<(), SecretsError> {
    if let Some(authorizer) = authorizer {
        match authorizer.revalidate(tx, organization_id).await? {
            NativeAgentAccess::Authorized => {}
            NativeAgentAccess::Unauthorized => return Err(http(401, "Unauthorized")),
            NativeAgentAccess::Forbidden => {
                return Err(http(403, "User does not have access to this organization"));
            }
        }
    }
    Ok(())
}

async fn execute_secrets_with_authorizer(
    pool: &PgPool,
    organization_id: &str,
    actor_id: &str,
    request: &Value,
    authorizer: Option<&dyn NativeAgentAuthorizer>,
) -> Result<(u16, Value), SecretsError> {
    reject_unknown_keys(request, &["operation", "id", "input"])?;
    let organization_id = Uuid::parse_str(organization_id)
        .map_err(|_| http(422, "Invalid organization id"))?
        .to_string();
    let operation = text(request, "operation").ok_or_else(|| http(400, "Validation error"))?;
    let response = match operation {
        "providers" => {
            if request.get("id").is_some() || request.get("input").is_some() {
                return Err(http(400, "Validation error"));
            }
            (200, provider_list())
        }
        "list" => {
            if request.get("id").is_some() || request.get("input").is_some() {
                return Err(http(400, "Validation error"));
            }
            (200, list_secrets(pool, &organization_id).await?)
        }
        "create" => {
            if request.get("id").is_some() {
                return Err(http(400, "Validation error"));
            }
            let input = request
                .get("input")
                .ok_or_else(|| http(400, "Validation error"))?;
            (
                201,
                create_secret(pool, authorizer, &organization_id, actor_id, input).await?,
            )
        }
        "rotate" => {
            let id = parse_uuid(text(request, "id").ok_or_else(|| http(400, "Validation error"))?)?;
            let input = request
                .get("input")
                .ok_or_else(|| http(400, "Validation error"))?;
            (
                200,
                rotate_secret(pool, authorizer, &organization_id, actor_id, &id, input).await?,
            )
        }
        "update" => {
            let id = parse_uuid(text(request, "id").ok_or_else(|| http(400, "Validation error"))?)?;
            let input = request
                .get("input")
                .ok_or_else(|| http(400, "Validation error"))?;
            (
                200,
                update_secret(pool, authorizer, &organization_id, actor_id, &id, input).await?,
            )
        }
        "delete" => {
            if request.get("input").is_some() {
                return Err(http(400, "Validation error"));
            }
            let id = parse_uuid(text(request, "id").ok_or_else(|| http(400, "Validation error"))?)?;
            (
                200,
                delete_secret(pool, authorizer, &organization_id, actor_id, &id).await?,
            )
        }
        _ => return Err(http(400, "Validation error")),
    };
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_KEY: &str = "01234567890123456789012345678901";

    #[test]
    fn local_material_matches_the_existing_node_provider_contract() {
        let key = *TEST_KEY.as_bytes().first_chunk::<32>().unwrap();
        let (material, digest) = encrypt_value_with_key("synthetic-secret-🌱", &key).unwrap();
        assert_eq!(material["scheme"], "local_encrypted_v1");
        assert!(!material.to_string().contains("synthetic-secret-🌱"));
        assert_eq!(
            digest,
            format!("{:x}", Sha256::digest("synthetic-secret-🌱".as_bytes()))
        );
        assert_eq!(
            decrypt_material_with_key(&material, &key).unwrap(),
            "synthetic-secret-🌱"
        );
    }

    #[test]
    fn only_approved_provider_ids_are_described() {
        assert_eq!(provider_list().as_array().unwrap().len(), 4);
        assert!(provider_is_supported("local_encrypted"));
        assert!(!provider_is_supported("unknown"));
    }
}
