//! Two domain tables only; typed PostgreSQL records retain their schema types.
use super::*;
fn snake(key: &str) -> String {
    let mut s = String::new();
    for c in key.chars() {
        if c.is_ascii_uppercase() {
            s.push('_');
            s.push(c.to_ascii_lowercase());
        } else {
            s.push(c);
        }
    }
    s
}
pub(crate) fn camel(key: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for c in key.chars() {
        if c == '_' {
            upper = true;
        } else if upper {
            out.push(c.to_ascii_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}
fn table(trigger: bool) -> &'static str {
    if trigger {
        "automation_triggers"
    } else {
        "automations"
    }
}
pub(crate) async fn automation(tx: &mut Tx<'_>, id: &str, lock: bool) -> Result<Option<Value>> {
    read(tx, id, false, lock).await
}
pub(crate) async fn trigger(tx: &mut Tx<'_>, id: &str, lock: bool) -> Result<Option<Value>> {
    read(tx, id, true, lock).await
}
async fn read(tx: &mut Tx<'_>, id: &str, trigger: bool, lock: bool) -> Result<Option<Value>> {
    let dates = if trigger {
        &[
            "created_at",
            "updated_at",
            "next_run_at",
            "last_fired_at",
            "last_rotated_at",
        ][..]
    } else {
        &[
            "created_at",
            "updated_at",
            "last_triggered_at",
            "last_enqueued_at",
        ][..]
    };
    let stamp = dates
        .iter()
        .map(|key| {
            format!(
                "'{key}',to_char(t.{key} AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let query = format!(
        "SELECT (to_jsonb(t)||jsonb_build_object({stamp}))::text FROM {} t WHERE id=$1::uuid{}",
        table(trigger),
        if lock { " FOR UPDATE" } else { "" }
    );
    let raw = sqlx::query_scalar::<_, String>(&query)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?;
    raw.map(|raw| {
        let row: serde_json::Map<String, Value> = serde_json::from_str(&raw)?;
        Ok(Value::Object(
            row.into_iter().map(|(k, v)| (camel(&k), v)).collect(),
        ))
    })
    .transpose()
}
pub(super) async fn write(
    tx: &mut Tx<'_>,
    org: &str,
    id: Option<&str>,
    trigger: bool,
    value: &Value,
) -> Result<String> {
    let mut row = serde_json::Map::new();
    for (key, value) in value
        .as_object()
        .ok_or_else(|| http(400, "Validation error"))?
    {
        row.insert(snake(key), value.clone());
    }
    row.insert("org_id".into(), json!(org));
    let fields = row.keys().cloned().collect::<Vec<_>>();
    let table = table(trigger);
    let query = if id.is_some() {
        format!(
            "UPDATE {table} t SET {} FROM jsonb_populate_record(NULL::{table},$1::jsonb) x WHERE t.id=$2::uuid AND t.org_id=$3::uuid RETURNING t.id::text",
            fields
                .iter()
                .map(|key| format!("{key}=x.{key}"))
                .collect::<Vec<_>>()
                .join(",")
        )
    } else {
        format!(
            "INSERT INTO {table} ({}) SELECT {} FROM jsonb_populate_record(NULL::{table},$1::jsonb) x RETURNING id::text",
            fields.join(","),
            fields
                .iter()
                .map(|key| format!("x.{key}"))
                .collect::<Vec<_>>()
                .join(",")
        )
    };
    let query = sqlx::query_scalar::<_, String>(&query).bind(Value::Object(row).to_string());
    Ok(if let Some(id) = id {
        query.bind(id).bind(org).fetch_one(&mut **tx).await?
    } else {
        query.fetch_one(&mut **tx).await?
    })
}
