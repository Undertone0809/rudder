//! Existing Messenger projections inside an authenticated mutation transaction.
//! The caller owns credential revalidation and lock order; no new pool/commit.
use super::*;

fn context<'a>(org: &'a str, user: &'a str, locale: &str) -> Result<Context<'a>> {
    let locale = locale
        .parse::<icu_locale_core::Locale>()
        .map_err(|_| http(500, "Host locale is unavailable"))?;
    Ok(Context {
        org,
        user,
        collator: icu_collator::Collator::try_new(locale.into(), Default::default())
            .map_err(|_| http(500, "Host collation is unavailable"))?,
    })
}
/// None selects the full directory; Some selects arbitrary keys without the
/// directory's split-Issue page cap. Old grouped Issues remain usable.
pub async fn items(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    user: &str,
    locale: &str,
    keys: Option<&[String]>,
) -> Result<Vec<Value>> {
    let c = context(org, user, locale)?;
    let ids = keys.map(|keys| {
        keys.iter()
            .filter_map(|k| k.strip_prefix("chat:").map(str::to_owned))
            .collect::<Vec<_>>()
    });
    let mut items = chat::summaries(tx, &c, ids.as_deref()).await?;
    if keys.is_none_or(|keys| {
        keys.iter()
            .any(|key| key == "issues" || key.starts_with("issue:"))
    }) {
        let mut issues = issues::read(tx, &c, None, None, false).await?;
        if issues["itemCount"].as_u64().unwrap_or(0) > 0 {
            items.push(issues["summary"].clone());
        }
        if let Some(keys) = keys {
            issues["_entries"].as_array_mut().unwrap().retain(|entry| {
                keys.iter()
                    .any(|key| key.strip_prefix("issue:") == Some(text(entry, "id")))
            });
            items.extend(issues::split(tx, &c, &issues).await?);
        }
    }
    for key in ["approvals", "failed-runs", "budget-alerts", "join-requests"] {
        if keys.is_some_and(|keys| !keys.iter().any(|k| k == key)) {
            continue;
        }
        let data = if key == "approvals" {
            requests::read(tx, &c, false).await?
        } else {
            signals::read(tx, &c, key, false).await?
        };
        if data["itemCount"].as_u64().unwrap_or(0) > 0 {
            items.push(data["summary"].clone());
        }
    }
    if let Some(keys) = keys {
        items.retain(|v| keys.iter().any(|key| key == text(v, "threadKey")));
    }
    Ok(items)
}
pub async fn issue_attention(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    user: &str,
    locale: &str,
    issue: Option<&str>,
) -> Result<Option<String>> {
    let c = context(org, user, locale)?;
    let data = issues::read(tx, &c, None, None, false).await?;
    Ok(data["_entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| issue.is_none_or(|id| text(v, "id") == id))
        .filter_map(|v| {
            nanos(&v["_attentionRaw"])
                .map(|at| (at, v["_attentionRaw"].as_str().unwrap().to_owned()))
        })
        .max_by_key(|(at, _)| *at)
        .map(|(_, at)| at))
}
