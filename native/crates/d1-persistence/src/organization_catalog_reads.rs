//! Organization resource catalogs and effective intelligence defaults. The
//! default profile migration is a read projection only; it never persists state.
use crate::{
    StoreError,
    issue_metadata_reads::{
        append_field, decoded_json_column, json_column, projection, timestamp_value,
    },
    legacy_read_json::normalize_legacy_read_json,
};
use serde::Deserialize;
use serde::de::Error as _;
use sqlx::{PgPool, Row};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum OrganizationCatalogReadOperation {
    Resources,
    IntelligenceProfiles,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OrganizationCatalogReadInput {
    pub operation: OrganizationCatalogReadOperation,
    pub legacy_date_timezone: Option<String>,
}
impl OrganizationCatalogReadInput {
    pub fn validate(&self) -> Result<(), StoreError> {
        if self.legacy_date_timezone.as_ref().is_some_and(|zone| {
            zone.is_empty() || zone.len() > 256 || zone.chars().any(char::is_control)
        }) {
            return Err(StoreError::InvalidInput);
        }
        Ok(())
    }
}
#[derive(Debug, thiserror::Error)]
pub enum OrganizationCatalogReadError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Sql(#[from] sqlx::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

fn decode_string_token(token: &str) -> Result<Vec<u16>, serde_json::Error> {
    let fail = || serde_json::Error::custom("invalid JSON string token");
    if token.len() < 2 || !token.starts_with('"') || !token.ends_with('"') {
        return Err(fail());
    }
    let mut units = Vec::new();
    let mut chars = token[1..token.len() - 1].chars();
    while let Some(character) = chars.next() {
        if character == '\\' {
            let escaped = chars.next().ok_or_else(fail)?;
            let unit = match escaped {
                '"' => 0x22,
                '\\' => 0x5c,
                '/' => 0x2f,
                'b' => 8,
                'f' => 12,
                'n' => 10,
                'r' => 13,
                't' => 9,
                'u' => {
                    let mut unit = 0;
                    for _ in 0..4 {
                        unit = unit * 16
                            + chars
                                .next()
                                .and_then(|value| value.to_digit(16))
                                .ok_or_else(fail)? as u16;
                    }
                    unit
                }
                _ => return Err(fail()),
            };
            units.push(unit);
        } else {
            if character == '"' || character <= '\u{001f}' {
                return Err(fail());
            }
            units.extend_from_slice(character.encode_utf16(&mut [0; 2]));
        }
    }
    Ok(units)
}

fn write_string(output: &mut String, units: &[u16]) {
    use std::fmt::Write as _;
    output.push('"');
    for character in char::decode_utf16(units.iter().copied()) {
        match character {
            Ok('"') => output.push_str("\\\""),
            Ok('\\') => output.push_str("\\\\"),
            Ok(c) if c <= '\u{001f}' => {
                write!(output, "\\u{:04x}", c as u32).unwrap();
            }
            Ok(c) => output.push(c),
            Err(e) => {
                write!(output, "\\u{:04x}", e.unpaired_surrogate()).unwrap();
            }
        }
    }
    output.push('"');
}
fn encoded(units: &[u16]) -> String {
    let mut value = String::new();
    write_string(&mut value, units);
    value
}
fn key_is(key: &[u16], name: &str) -> bool {
    key.iter().copied().eq(name.encode_utf16())
}
fn whitespace(unit: u16) -> bool {
    matches!(unit, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
fn trimmed(units: &[u16]) -> &[u16] {
    let start = units
        .iter()
        .position(|u| !whitespace(*u))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|u| !whitespace(*u))
        .map_or(start, |i| i + 1);
    &units[start..end]
}
// Only the top level participates in object spread. Nested JSON remains raw,
// so deep imported configs never meet a recursive Value/depth limit.
fn end_of_value(raw: &[u8], start: usize) -> usize {
    let mut i = start;
    let mut depth = 0usize;
    let mut quoted = false;
    while i < raw.len() {
        let b = raw[i];
        if quoted {
            if b == b'\\' {
                i += 2;
                continue;
            }
            if b == b'"' {
                quoted = false;
                if depth == 0 {
                    return i + 1;
                }
            }
        } else {
            match b {
                b'"' => quoted = true,
                b'{' | b'[' => depth += 1,
                b'}' | b']' => {
                    if depth == 0 {
                        return i;
                    }
                    depth -= 1;
                    if depth == 0 {
                        return i + 1;
                    }
                }
                b',' | b' ' | b'\r' | b'\n' | b'\t' if depth == 0 => return i,
                _ => (),
            }
        }
        i += 1;
    }
    i
}
fn spread_config(raw: &str) -> Result<Vec<(Vec<u16>, String)>, serde_json::Error> {
    let raw = raw.trim();
    let bytes = raw.as_bytes();
    let mut fields = Vec::new();
    if raw.starts_with('"') {
        for (index, unit) in decode_string_token(raw)?.into_iter().enumerate() {
            fields.push((index.to_string().encode_utf16().collect(), encoded(&[unit])));
        }
    } else if matches!(bytes.first(), Some(b'{') | Some(b'[')) {
        let object = bytes[0] == b'{';
        let mut i = 1;
        let mut index = 0;
        while i < bytes.len() - 1 {
            while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b',') {
                i += 1;
            }
            if i >= bytes.len() - 1 {
                break;
            }
            let key = if object {
                let end = end_of_value(bytes, i);
                let key = decode_string_token(&raw[i..end])?;
                i = end;
                while bytes[i].is_ascii_whitespace() || bytes[i] == b':' {
                    i += 1;
                }
                key
            } else {
                let key = index.to_string().encode_utf16().collect();
                index += 1;
                key
            };
            let end = end_of_value(bytes, i);
            let value = raw[i..end].to_owned();
            i = end;
            if let Some((_, old)) = fields.iter_mut().find(|(existing, _)| *existing == key) {
                *old = value;
            } else {
                fields.push((key, value));
            }
        }
    }
    Ok(fields)
}
fn field_string(fields: &[(Vec<u16>, String)], name: &str) -> Option<Vec<u16>> {
    fields
        .iter()
        .find(|(key, _)| key_is(key, name))
        .and_then(|(_, value)| decode_string_token(value).ok())
}
fn render_fields(fields: &[(Vec<u16>, String)]) -> String {
    format!(
        "{{{}}}",
        fields
            .iter()
            .map(|(key, value)| format!("{}:{value}", encoded(key)))
            .collect::<Vec<_>>()
            .join(",")
    )
}
fn config_projection(
    raw: &str,
    legacy: bool,
    codex: bool,
) -> Result<(String, bool), serde_json::Error> {
    let decoded = decoded_json_column(raw);
    // Nullish coalescing happens before JSON.stringify converts Infinity to null.
    let config = normalize_legacy_read_json(if decoded.trim() == "null" {
        "{}"
    } else {
        &decoded
    })?;
    if !codex && !legacy {
        return Ok((config, false));
    }
    let mut fields = spread_config(&config)?;
    if !codex {
        return Ok((render_fields(&fields), false));
    }
    let model = field_string(&fields, "model").unwrap_or_default();
    let model = trimmed(&model);
    let replace = model.is_empty()
        || ["gpt-5.5", "gpt-5.4-mini", "gpt-5.6-luna"]
            .iter()
            .any(|value| key_is(model, value));
    if !replace {
        return Ok((
            if legacy {
                render_fields(&fields)
            } else {
                config
            },
            false,
        ));
    }
    let effort = ["modelReasoningEffort", "reasoningEffort"]
        .iter()
        .filter_map(|name| field_string(&fields, name))
        .find(|value| !trimmed(value).is_empty())
        .map(|value| trimmed(&value).to_vec())
        .unwrap_or_else(|| "medium".encode_utf16().collect());
    fields.retain(|(key, _)| {
        !["model", "modelReasoningEffort", "reasoningEffort"]
            .iter()
            .any(|name| key_is(key, name))
    });
    fields.push((
        "model".encode_utf16().collect(),
        "\"gpt-6-luna\"".to_owned(),
    ));
    fields.push((
        "modelReasoningEffort".encode_utf16().collect(),
        encoded(&effort),
    ));
    Ok((render_fields(&fields), true))
}
fn profile_date_rank() -> String {
    let stamp = timestamp_value("t.updated_at");
    format!(
        "(SELECT CASE WHEN stamp IS NULL OR extract(epoch FROM date_trunc('milliseconds',stamp))>8640000000000 THEN 0 ELSE extract(epoch FROM date_trunc('milliseconds',stamp))*1000 END FROM (SELECT {stamp} AS stamp) profile_date)"
    )
}

pub async fn read_organization_catalog(
    pool: &PgPool,
    org: &str,
    input: &OrganizationCatalogReadInput,
) -> Result<String, OrganizationCatalogReadError> {
    input.validate()?;
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    if let Some(zone) = &input.legacy_date_timezone {
        sqlx::query("SELECT set_config('TimeZone',$1,true)")
            .bind(zone)
            .execute(&mut *tx)
            .await?;
    }
    let output = match input.operation {
        OrganizationCatalogReadOperation::Resources => {
            let value = projection(
                &[
                    ("id", "t.id"),
                    ("orgId", "t.org_id"),
                    ("name", "t.name"),
                    ("kind", "t.kind"),
                    ("sourceType", "coalesce(t.source_type,'external')"),
                    ("locator", "t.locator"),
                    ("description", "t.description"),
                ],
                &[("createdAt", "t.created_at"), ("updatedAt", "t.updated_at")],
            );
            let query = format!(
                "SELECT {value} AS value,t.metadata::text AS metadata FROM organization_resources t WHERE t.org_id=$1::uuid ORDER BY t.created_at ASC,t.id ASC"
            );
            let mut values = Vec::new();
            for row in sqlx::query(&query).bind(org).fetch_all(&mut *tx).await? {
                let raw: String = row.try_get("value")?;
                let metadata: Option<String> = row.try_get("metadata")?;
                values.push(append_field(
                    normalize_legacy_read_json(&raw)?,
                    "metadata",
                    &json_column(metadata.as_deref().unwrap_or("null"))?,
                ));
            }
            format!("[{}]", values.join(","))
        }
        OrganizationCatalogReadOperation::IntelligenceProfiles => {
            let value = projection(
                &[
                    ("id", "t.id"),
                    ("orgId", "t.org_id"),
                    ("purpose", "'default'::text"),
                    ("agentRuntimeType", "t.agent_runtime_type"),
                    ("status", "t.status"),
                    ("lastError", "t.last_error"),
                ],
                &[
                    ("lastVerifiedAt", "t.last_verified_at"),
                    ("createdAt", "t.created_at"),
                    ("updatedAt", "t.updated_at"),
                ],
            );
            let query = format!(
                "SELECT {value} AS value,t.purpose,t.agent_runtime_type,t.agent_runtime_config::text AS config FROM organization_intelligence_profiles t WHERE t.org_id=$1::uuid AND t.purpose IN ('default','lightweight','reasoning') ORDER BY (t.purpose='default') DESC,(t.status='configured') DESC,{} DESC,(t.purpose='reasoning') DESC LIMIT 1",
                profile_date_rank()
            );
            if let Some(row) = sqlx::query(&query)
                .bind(org)
                .fetch_optional(&mut *tx)
                .await?
            {
                let raw: String = row.try_get("value")?;
                let config: String = row.try_get("config")?;
                let legacy = row.try_get::<String, _>("purpose")? != "default";
                let codex = row.try_get::<String, _>("agent_runtime_type")? == "codex_local";
                let (config, migrated) = config_projection(&config, legacy, codex)?;
                let mut value: serde_json::Value = serde_json::from_str(&raw)?;
                if migrated {
                    value["status"] = serde_json::json!("disabled");
                    value["lastVerifiedAt"] = serde_json::Value::Null;
                    value["lastError"] = serde_json::json!(
                        "Model defaults changed. Test the runtime chain before enabling."
                    );
                }
                format!(
                    "[{}]",
                    append_field(
                        serde_json::to_string(&value)?,
                        "agentRuntimeConfig",
                        &config
                    )
                )
            } else {
                "[null]".to_owned()
            }
        }
    };
    tx.commit().await?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profile_config_spread_is_specific_to_legacy_and_codex_upgrade() {
        for (raw, canonical, legacy) in [
            ("false", "false", "{}"),
            ("1e400", "null", "{}"),
            ("null", "{}", "{}"),
            ("[1,false]", "[1,false]", r#"{"0":1,"1":false}"#),
        ] {
            assert_eq!(
                config_projection(raw, false, false).unwrap(),
                (canonical.into(), false)
            );
            assert_eq!(
                config_projection(raw, true, false).unwrap(),
                (legacy.into(), false)
            );
        }
        let (migrated,changed)=config_projection(r#"{"model":"gpt-5.5","modelReasoningEffort":"\ufeffhigh\ufeff","reasoningEffort":"low","__proto__":{"keep":true}}"#,false,true).unwrap();
        assert!(changed);
        let value: serde_json::Value = serde_json::from_str(&migrated).unwrap();
        assert_eq!(value["model"], "gpt-6-luna");
        assert_eq!(value["modelReasoningEffort"], "high");
        assert!(value.get("reasoningEffort").is_none());
        assert_eq!(value["__proto__"]["keep"], true);
    }
    #[test]
    fn profile_config_keeps_deep_payloads_sentinels_and_utf16_units() {
        let raw = format!(
            "{}{}{}",
            "{\"nested\":".repeat(600),
            r#"{"$serde_json::private::RawValue":"keep","big":9007199254740993}"#,
            "}".repeat(600)
        );
        let encoded = serde_json::to_string(&raw).unwrap();
        let (value, changed) = config_projection(&encoded, false, false).unwrap();
        assert!(!changed);
        assert!(value.contains("9007199254740992"));
        assert!(value.contains("$serde_json::private::RawValue"));
        let (spread, _) = config_projection(r#""\ud800""#, true, false).unwrap();
        assert_eq!(spread, r#"{"0":"\ud800"}"#);
        let (effort, _) = config_projection(
            r#"{"model":"gpt-5.5","modelReasoningEffort":"\u0085"}"#,
            false,
            true,
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_str(&effort).unwrap();
        assert_eq!(value["modelReasoningEffort"], "\u{0085}");
    }
}
