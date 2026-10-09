//! Shared transactional activity and non-null-FK outbox writer.
use serde_json::{Value, json};
use sqlx::Row;
use std::env;
use uuid::Uuid;

pub(crate) struct ActivityActor {
    pub actor_type: &'static str,
    pub actor_id: String,
    pub run_id: Option<String>,
}

pub(crate) async fn write_activity(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: &str,
    audit: &ActivityActor,
    action: &str,
    entity_type: &str,
    entity_id: &str,
    details: Option<&Value>,
) -> Result<(), sqlx::Error> {
    write_activity_options(
        tx,
        ActivityWrite {
            org,
            audit,
            action,
            entity_type,
            entity_id,
            details,
            options: ActivityOptions::default(),
        },
    )
    .await
    .map(|_| ())
}

#[derive(Default)]
pub(crate) struct ActivityOptions<'a> {
    pub agent_id: Option<&'a str>,
    pub effects: Option<&'a Value>,
    pub bind_run: bool,
}
pub(crate) struct ActivityWrite<'a> {
    pub org: &'a str,
    pub audit: &'a ActivityActor,
    pub action: &'a str,
    pub entity_type: &'a str,
    pub entity_id: &'a str,
    pub details: Option<&'a Value>,
    pub options: ActivityOptions<'a>,
}
pub(crate) async fn write_activity_options(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    request: ActivityWrite<'_>,
) -> Result<String, sqlx::Error> {
    let ActivityWrite {
        org,
        audit,
        action,
        entity_type,
        entity_id,
        details,
        options,
    } = request;
    let censor_username = sqlx::query_scalar::<_, bool>(
        "SELECT COALESCE((SELECT CASE WHEN general->>'censorUsernameInLogs'='true' THEN true ELSE false END FROM instance_settings WHERE singleton_key='default'),false)",
    )
    .fetch_one(&mut **tx)
    .await?;
    let sanitized_details = details.map(|value| sanitize_activity_value(value, censor_username));
    let run_id = if let Some(id) = audit.run_id.as_deref().and_then(normalize_run_id) {
        // Node falls back to an unlinked activity when a syntactically valid
        // run ID no longer exists. Lock the referenced row so it cannot vanish
        // between this check and the activity insert's foreign-key check.
        let visibility = crate::run_visibility::predicate("r", 6);
        let query = format!(
            "SELECT r.id::text FROM heartbeat_runs r WHERE r.id=$1::uuid AND (NOT $2 OR (r.org_id=$3::uuid AND ($4<>'agent' OR r.agent_id::text=$5) AND ($4='agent' OR {visibility}))) FOR KEY SHARE"
        );
        sqlx::query_scalar::<_, String>(&query)
            .bind(id)
            .bind(options.bind_run)
            .bind(org)
            .bind(audit.actor_type)
            .bind(&audit.actor_id)
            .bind((audit.actor_type == "user").then_some(audit.actor_id.as_str()))
            .fetch_optional(&mut **tx)
            .await?
    } else {
        None
    };
    let row = sqlx::query("INSERT INTO activity_log (org_id,actor_type,actor_id,action,entity_type,entity_id,agent_id,run_id,details) VALUES ($1::uuid,$2,$3,$4,$5,$6,$9::uuid,$7::uuid,$8::jsonb) RETURNING id::text")
        .bind(org).bind(audit.actor_type).bind(&audit.actor_id).bind(action).bind(entity_type).bind(entity_id)
        .bind(run_id.as_deref()).bind(sanitized_details.as_ref().map(Value::to_string)).bind(options.agent_id)
        .fetch_one(&mut **tx).await?;
    let activity_id: String = row.try_get("id")?;
    let mut payload = json!({"actorType":audit.actor_type,"actorId":audit.actor_id,"action":action,"entityType":entity_type,"entityId":entity_id,"agentId":options.agent_id,"runId":run_id,"details":sanitized_details});
    if let Some(effects) = options.effects {
        payload["agentRuntimeEffects"] = effects.clone();
    }
    sqlx::query("INSERT INTO organization_mutation_outbox (org_id,activity_id,event_type,payload) VALUES ($1::uuid,$2::uuid,'activity.logged',$3::jsonb)")
        .bind(org).bind(&activity_id).bind(payload.to_string())
        .execute(&mut **tx).await?;
    Ok(activity_id)
}

fn normalize_run_id(value: &str) -> Option<String> {
    let value = value.trim();
    let bytes = value.as_bytes();
    if bytes.len() != 36
        || [8, 13, 18, 23]
            .into_iter()
            .any(|index| bytes[index] != b'-')
        || !matches!(bytes[14], b'1'..=b'5')
        || !matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
        || !bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
    {
        return None;
    }
    Uuid::parse_str(value).ok().map(|id| id.to_string())
}

fn is_jwt(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    (parts.len() == 3 || parts.len() == 4)
        && parts.iter().all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        })
}

fn secret_payload_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase().replace(['-', '_'], "");
    [
        "apikey",
        "accesstoken",
        "auth",
        "authorization",
        "bearer",
        "secret",
        "passwd",
        "password",
        "credential",
        "jwt",
        "privatekey",
        "cookie",
        "connectionstring",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn mask_user_name(value: &str) -> String {
    let mut chars = value.trim().chars();
    let Some(first) = chars.next() else {
        return "*".to_owned();
    };
    format!("{first}{}", "*".repeat(chars.count().max(1)))
}

fn replace_bounded(input: &str, needle: &str, replacement: &str) -> String {
    if needle.is_empty() {
        return input.to_owned();
    }
    let boundary = |character: Option<char>| {
        character.is_none_or(|ch| !(ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-')))
    };
    let mut output = String::with_capacity(input.len());
    let mut offset = 0;
    while let Some(relative) = input[offset..].find(needle) {
        let start = offset + relative;
        let end = start + needle.len();
        let before = input[..start].chars().next_back();
        let after = input[end..].chars().next();
        output.push_str(&input[offset..start]);
        if boundary(before) && boundary(after) {
            output.push_str(replacement);
        } else {
            output.push_str(needle);
        }
        offset = end;
    }
    output.push_str(&input[offset..]);
    output
}

fn redact_current_user_text(input: &str) -> String {
    let mut names = ["USER", "LOGNAME", "USERNAME"]
        .iter()
        .filter_map(|key| env::var(key).ok())
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>();
    for key in ["HOME", "USERPROFILE"] {
        if let Some(home) = env::var(key).ok().filter(|value| !value.trim().is_empty())
            && let Some(name) = home
                .rsplit(['/', '\\'])
                .next()
                .filter(|name| !name.is_empty())
        {
            names.push(name.to_owned());
        }
    }
    names.sort_by_key(|name| std::cmp::Reverse(name.len()));
    names.dedup();

    let mut homes = ["HOME", "USERPROFILE"]
        .iter()
        .filter_map(|key| env::var(key).ok())
        .filter(|home| !home.trim().is_empty())
        .collect::<Vec<_>>();
    for name in &names {
        homes.extend([
            format!("/Users/{name}"),
            format!("/home/{name}"),
            format!("C:\\Users\\{name}"),
        ]);
    }
    homes.sort_by_key(|home| std::cmp::Reverse(home.len()));
    homes.dedup();

    let mut output = input.to_owned();
    for home in homes {
        let last = home.rsplit(['/', '\\']).next().unwrap_or(&home);
        let masked = mask_user_name(last);
        let replacement = home
            .rfind(['/', '\\'])
            .map(|index| format!("{}{masked}", &home[..=index]))
            .unwrap_or(masked);
        output = output.replace(&home, &replacement);
    }
    for name in names {
        output = replace_bounded(&output, &name, &mask_user_name(&name));
    }
    output
}

pub(crate) fn sanitize_activity_value(value: &Value, censor_username: bool) -> Value {
    match value {
        Value::String(text) if is_jwt(text) => Value::String("***REDACTED***".to_owned()),
        Value::String(text) if censor_username => Value::String(redact_current_user_text(text)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| sanitize_activity_value(item, censor_username))
                .collect(),
        ),
        Value::Object(items) => Value::Object(
            items
                .iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        if secret_payload_key(key) {
                            Value::String("***REDACTED***".to_owned())
                        } else {
                            sanitize_activity_value(value, censor_username)
                        },
                    )
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::{is_jwt, normalize_run_id};

    #[test]
    fn jwt_redaction_accepts_any_nonempty_three_or_four_base64url_segments() {
        assert!(is_jwt("h.p.s"));
        assert!(is_jwt("h.p.s.x"));
        assert!(is_jwt("header.payload.signature"));
        assert!(!is_jwt(".p.s"));
        assert!(!is_jwt("h..s"));
        assert!(!is_jwt("h.p.s."));
        assert!(!is_jwt("h.p.s$"));
        assert!(!is_jwt("h.p"));
    }

    #[test]
    fn activity_run_id_normalization_matches_the_legacy_uuid_contract() {
        assert_eq!(
            normalize_run_id("40000000-0000-4000-8000-000000000001"),
            Some("40000000-0000-4000-8000-000000000001".to_owned())
        );
        assert_eq!(
            normalize_run_id("40000000-0000-4000-8000-00000000000A"),
            Some("40000000-0000-4000-8000-00000000000a".to_owned())
        );
        assert_eq!(
            normalize_run_id("70000000-0000-7000-8000-000000000001"),
            None
        );
        assert_eq!(
            normalize_run_id("40000000-0000-4000-7000-000000000001"),
            None
        );
    }
}
