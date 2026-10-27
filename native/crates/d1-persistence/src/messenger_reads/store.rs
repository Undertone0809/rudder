use super::*;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
pub(super) fn http(status: u16, message: &str) -> Error {
    Error::Http(status, message.into())
}
pub(super) fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
pub(super) fn string(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}
pub(super) fn truth(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}
pub(super) fn nanos(v: &Value) -> Option<i128> {
    v.as_str()
        .and_then(|s| OffsetDateTime::parse(s, &Rfc3339).ok())
        .map(|d| d.unix_timestamp_nanos())
}
pub(super) fn millis(v: &Value) -> Option<i128> {
    v.as_str()
        .and_then(|s| OffsetDateTime::parse(s, &Rfc3339).ok())
        .map(|date| date.unix_timestamp_nanos().div_euclid(1_000_000))
}
pub(super) fn latest(values: &[&Value]) -> Value {
    values
        .iter()
        .filter_map(|v| millis(v).map(|ms| (ms, (*v).clone())))
        .max_by_key(|(ms, _)| *ms)
        .map(|(_, v)| v)
        .unwrap_or(Value::Null)
}
pub(super) fn camel(value: Value) -> Value {
    let Value::Object(fields) = value else {
        return value;
    };
    Value::Object(
        fields
            .into_iter()
            .map(|(key, mut value)| {
                if key.ends_with("_at") || key.ends_with("At") {
                    if let Some(raw) = value.as_str() {
                        value = OffsetDateTime::parse(raw, &Rfc3339)
                            .ok()
                            .and_then(|date| {
                                Some(json!(format!(
                                    "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
                                    date.year(),
                                    u8::from(date.month()),
                                    date.day(),
                                    date.hour(),
                                    date.minute(),
                                    date.second(),
                                    date.millisecond()
                                )))
                            })
                            .unwrap_or(Value::Null);
                    }
                }
                if key.starts_with('_') {
                    return (key, value);
                }
                let mut out = String::new();
                let mut upper = false;
                for ch in key.chars() {
                    if ch == '_' {
                        upper = true
                    } else if upper {
                        out.extend(ch.to_uppercase());
                        upper = false
                    } else {
                        out.push(ch)
                    }
                }
                (out, value)
            })
            .collect(),
    )
}
pub(super) async fn rows(tx: &mut Tx<'_>, sql: &str, args: &[&str]) -> Result<Vec<Value>> {
    let mut query = sqlx::query_scalar::<_, String>(sql);
    for arg in args {
        query = query.bind(*arg)
    }
    query
        .fetch_all(&mut **tx)
        .await?
        .into_iter()
        .map(|raw| {
            crate::legacy_read_json::parse_legacy_read_json(&raw)
                .map(camel)
                .map_err(Error::from)
        })
        .collect()
}
pub(super) async fn state(tx: &mut Tx<'_>, c: &Context<'_>, key: &str) -> Result<Value> {
    Ok(rows(tx,"SELECT to_jsonb(s)::text FROM messenger_thread_user_states s WHERE org_id=$1::uuid AND user_id=$2 AND thread_key=$3",&[c.org,c.user,key]).await?.pop().unwrap_or(Value::Null))
}
pub(super) fn summary(
    key: &str,
    title: &str,
    count: usize,
    at: Value,
    last: Value,
    unread: usize,
    empty: &str,
    preview: Value,
) -> Value {
    let (kind, href) = if key == "issues" || key == "approvals" {
        (key, format!("/messenger/{key}"))
    } else {
        (key, format!("/messenger/system/{key}"))
    };
    let subtitle = if count == 0 {
        empty.to_owned()
    } else {
        format!(
            "{count} {}{}",
            if key == "issues" {
                "tracked issue"
            } else if key == "approvals" {
                "request"
            } else {
                "item"
            },
            if count == 1 { "" } else { "s" }
        )
    };
    let preview = if count == 0 {
        json!(if key == "issues" {
            "Create or follow issues to populate this feed"
        } else if key == "approvals" {
            "No requests in this organization"
        } else {
            empty
        })
    } else if preview.is_null() {
        json!(if key == "issues" {
            "Cross-issue activity feed"
        } else if key == "approvals" {
            "Review requests needing your input"
        } else {
            "Aggregate operational updates"
        })
    } else {
        preview
    };
    json!({"threadKey":key,"kind":kind,"title":title,"subtitle":subtitle,"preview":preview,"latestActivityAt":at,"lastReadAt":last,"unreadCount":unread,"needsAttention":unread>0,"isPinned":false,"href":href})
}
pub(super) fn unread(items: &[Value], last: &Value) -> usize {
    items
        .iter()
        .filter(|item| {
            millis(&item["latestActivityAt"])
                .is_some_and(|ms| millis(last).is_none_or(|read| ms > read))
        })
        .count()
}
pub(super) fn action(label: &str, href: Value, method: &str) -> Value {
    json!({"label":label,"href":href,"method":method})
}

/// JSONB is emitted in byte-length/key order; JavaScript enumerates canonical
/// integer-index properties first. Preserve that order where keys become text.
pub(super) fn object_keys(value: &Value) -> Vec<&str> {
    fn index(key: &str) -> Option<u32> {
        let n = key.parse::<u32>().ok()?;
        (n < u32::MAX && n.to_string() == key).then_some(n)
    }
    let mut keys = value
        .as_object()
        .map(|m| m.keys().map(String::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    keys.sort_by(|a, b| match (index(a), index(b)) {
        (Some(a), Some(b)) => a.cmp(&b),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        _ => a
            .len()
            .cmp(&b.len())
            .then_with(|| a.as_bytes().cmp(b.as_bytes())),
    });
    keys
}
