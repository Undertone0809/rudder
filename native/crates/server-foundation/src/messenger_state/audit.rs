use super::{protocol::AuditContext, store::*};
use serde_json::Value;

fn mask(value: &str) -> String {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return "*".into();
    };
    format!("{first}{}", "*".repeat(chars.count().max(1)))
}
fn word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"._-".contains(&b)
}
fn redact_text(value: &str, context: &AuditContext) -> String {
    let mut value = value.to_owned();
    let mut homes = context.home_dirs.clone();
    homes.sort_by_key(|s| std::cmp::Reverse(s.len()));
    homes.dedup();
    for home in homes.iter().filter(|s| !s.is_empty()) {
        let trimmed = home.trim_end_matches(['/', '\\']);
        let replacement = match trimmed.rfind(['/', '\\']) {
            Some(i) => format!("{}{}", &trimmed[..i + 1], mask(&trimmed[i + 1..])),
            None => mask(trimmed),
        };
        value = value.replace(home, &replacement);
    }
    let mut names = context.user_names.clone();
    names.sort_by_key(|s| std::cmp::Reverse(s.len()));
    names.dedup();
    for name in names.iter().filter(|s| !s.is_empty()) {
        let mut next = String::new();
        let mut copied = 0;
        for (i, _) in value.match_indices(name) {
            let end = i + name.len();
            if (i == 0 || !word_byte(value.as_bytes()[i - 1]))
                && (end == value.len() || !word_byte(value.as_bytes()[end]))
            {
                next.push_str(&value[copied..i]);
                next.push_str(&mask(name));
                copied = end;
            }
        }
        next.push_str(&value[copied..]);
        value = next;
    }
    value
}
fn redact(value: &mut Value, context: &AuditContext) {
    match value {
        Value::String(s) => *s = redact_text(s, context),
        Value::Array(items) => {
            for item in items {
                redact(item, context)
            }
        }
        Value::Object(items) => {
            for item in items.values_mut() {
                redact(item, context)
            }
        }
        _ => (),
    }
}
// Match normalizeGeneralSettings: a malformed or unknown setting falls back
// to defaults for the entire object; legacy gitIdentity alone is ignored.
fn censorship_enabled(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.get("censorUsernameInLogs") == Some(&Value::Bool(true))
        && object.iter().all(|(key, value)| match key.as_str() {
            "gitIdentity" => true,
            "censorUsernameInLogs"
            | "showDeveloperDiagnostics"
            | "experimentalPluginsEnabled"
            | "experimentalSitesEnabled"
            | "experimentalGoalsEnabled"
            | "experimentalComputerUseEnabled" => value.is_boolean(),
            "locale" => matches!(value.as_str(), Some("en" | "zh-CN")),
            "productAnalyticsMode" => {
                matches!(value.as_str(), Some("off" | "anonymous" | "account_linked"))
            }
            "productAnalyticsConsentEpoch" => value
                .as_f64()
                .is_some_and(|n| n.is_finite() && n.fract() == 0.0 && n >= 1.0),
            _ => false,
        })
}

/// Audit details here have a closed vocabulary of identifiers/flags, never
/// user text or arbitrary target JSON. The only free identifier is resourceKey;
/// preserve the legacy host-username censorship using signed host context.
pub(super) struct Activity<'a> {
    pub action: &'a str,
    pub entity_type: &'a str,
    pub entity_id: &'a str,
    pub details: Value,
    pub idempotency_key: Option<&'a str>,
    pub event: bool,
}
pub(super) async fn activity(tx: &mut Tx<'_>, s: &Scope<'_>, activity: Activity<'_>) -> Result<()> {
    let Activity {
        action,
        entity_type,
        entity_id,
        mut details,
        idempotency_key: key,
        event,
    } = activity;
    if event {
        let general = sqlx::query_scalar::<_, String>(
            "SELECT general::text FROM instance_settings WHERE singleton_key='default'",
        )
        .fetch_optional(&mut **tx)
        .await?;
        let general = match general {
            Some(general) => general,
            None => sqlx::query_scalar::<_, String>("INSERT INTO instance_settings(singleton_key,browser,general,notifications,created_at,updated_at) VALUES('default','{}','{}','{}',clock_timestamp(),clock_timestamp()) ON CONFLICT(singleton_key) DO UPDATE SET updated_at=EXCLUDED.updated_at RETURNING general::text")
                .fetch_one(&mut **tx).await?,
        };
        let enabled = censorship_enabled(&decode(&general)?);
        if enabled {
            redact(&mut details, s.audit);
        }
    }
    let id=sqlx::query_scalar::<_,String>("INSERT INTO activity_log(org_id,actor_type,actor_id,action,entity_type,entity_id,details,idempotency_key) VALUES($1::uuid,'user',$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT DO NOTHING RETURNING id::text")
        .bind(s.org).bind(s.user).bind(action).bind(entity_type).bind(entity_id).bind(encode(&details)?).bind(key).fetch_optional(&mut **tx).await?;
    if let Some(id) = id.filter(|_| event) {
        let payload = serde_json::json!({"actorType":"user","actorId":s.user,"action":action,"entityType":entity_type,"entityId":entity_id,"agentId":null,"runId":null,"details":details});
        sqlx::query("INSERT INTO organization_mutation_outbox(org_id,activity_id,event_type,payload) VALUES($1::uuid,$2::uuid,'activity.logged',$3::jsonb)")
            .bind(s.org).bind(id).bind(encode(&payload)?).execute(&mut **tx).await?;
    }
    Ok(())
}
