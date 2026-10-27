//! Messenger aggregate read authority and its two legacy GET effects.
//! Visibility precedes hydration/paging. User-state initialization and stale
//! group cleanup remain idempotent transactions with the existing lock order.
mod chat;
mod groups;
mod issues;
mod ordering;
mod projection;
mod requests;
mod signals;
mod store;
use crate::agent_core::{NativeAgentAccess, NativeAgentAuthorizer};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};
use store::*;

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Read {
    Threads {
        paged: bool,
        limit: Option<u32>,
        cursor: Option<String>,
        #[serde(default)]
        split_issues: bool,
    },
    Groups,
    Chat {
        conversation_id: String,
    },
    Issues {
        limit: Option<u32>,
        cursor: Option<String>,
    },
    Approvals,
    System {
        kind: String,
    },
}
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{1}")]
    Http(u16, String),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
type Result<T> = std::result::Result<T, Error>;
type Tx<'a> = Transaction<'a, Postgres>;
struct Context<'a> {
    org: &'a str,
    user: &'a str,
    collator: icu_collator::CollatorBorrowed<'static>,
}

pub async fn read(
    pool: &PgPool,
    org: &str,
    user: &str,
    locale: &str,
    input: &Read,
    auth: &dyn NativeAgentAuthorizer,
) -> Result<Value> {
    let locale = locale
        .parse::<icu_locale_core::Locale>()
        .map_err(|_| http(500, "Host locale is unavailable"))?;
    let collator = icu_collator::Collator::try_new(locale.into(), Default::default())
        .map_err(|_| http(500, "Host collation is unavailable"))?;
    let c = Context {
        org,
        user,
        collator,
    };
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL TIME ZONE 'UTC'")
        .execute(&mut *tx)
        .await?;
    match auth.revalidate(&mut tx, org).await? {
        NativeAgentAccess::Authorized => (),
        NativeAgentAccess::Unauthorized => return Err(http(401, "Unauthorized")),
        NativeAgentAccess::Forbidden => {
            return Err(http(403, "User does not have access to this organization"));
        }
    }
    let mut result = match input {
        Read::Groups => groups::read(&mut tx, &c).await?,
        Read::Chat { conversation_id } => chat::detail(&mut tx, &c, conversation_id).await?,
        Read::Issues { limit, cursor } => {
            issues::read(&mut tx, &c, *limit, cursor.as_deref(), true).await?
        }
        Read::Approvals => requests::read(&mut tx, &c, true).await?,
        Read::System { kind } => signals::read(&mut tx, &c, kind, true).await?,
        Read::Threads {
            paged,
            limit,
            cursor,
            split_issues,
        } => {
            threads(
                &mut tx,
                &c,
                *paged,
                *limit,
                cursor.as_deref(),
                *split_issues,
            )
            .await?
        }
    };
    if let Some(object) = result.as_object_mut() {
        object.remove("itemCount");
        object.remove("_entries");
    }
    tx.commit().await?;
    Ok(result)
}
async fn threads(
    tx: &mut Tx<'_>,
    c: &Context<'_>,
    paged: bool,
    limit: Option<u32>,
    cursor: Option<&str>,
    split: bool,
) -> Result<Value> {
    let mut items = Vec::new();
    let mut issue_data = issues::read(tx, c, Some(100), None, false).await?;
    if split {
        issue_data["_entries"].as_array_mut().unwrap().truncate(100);
        items.extend(issues::split(tx, c, &issue_data).await?)
    } else if issue_data["itemCount"].as_u64().unwrap_or(0) > 0 {
        items.push(issue_data["summary"].clone());
    }
    for data in [
        requests::read(tx, c, false).await?,
        signals::read(tx, c, "failed-runs", false).await?,
        signals::read(tx, c, "budget-alerts", false).await?,
        signals::read(tx, c, "join-requests", false).await?,
    ] {
        if data["itemCount"].as_u64().unwrap_or(0) > 0 {
            items.push(data["summary"].clone())
        }
    }
    let limit = limit.unwrap_or(40).clamp(1, 100) as usize;
    let cursor = ordering::decode_thread(cursor);
    if paged {
        if let Some(cursor) = cursor.as_ref() {
            items.retain(|item| ordering::compare(c, item, cursor, true, false).is_gt());
        }
        items.extend(chat::page_summaries(tx, c, limit + items.len() + 1, cursor.as_ref()).await?);
        if let Some(cursor) = cursor.as_ref() {
            items.retain(|item| ordering::compare(c, item, cursor, true, false).is_gt());
        }
    } else {
        items.extend(chat::summaries(tx, c, None).await?);
    }
    items.sort_by(|a, b| ordering::compare(c, a, b, true, false));
    if !paged {
        return Ok(json!(items));
    }
    let more = items.len() > limit;
    items.truncate(limit);
    let next = if more {
        items.last().map(ordering::encode_thread)
    } else {
        None
    };
    Ok(json!({"items":items,"pageInfo":{"limit":limit,"hasMore":more,"nextCursor":next}}))
}

/// Public adapters reuse the existing Date parser while the domain retains the
/// cursor envelope and operation-specific invalid-cursor behavior.
pub fn normalize_cursor_date(
    raw: &str,
    normalize: impl FnOnce(&str) -> Option<String>,
) -> Option<String> {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    let mut cursor = ordering::decode(raw)?;
    let date = normalize(cursor["activityAt"].as_str()?)?;
    cursor["activityAt"] = json!(date);
    Some(URL_SAFE_NO_PAD.encode(cursor.to_string()))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn context(locale: &str) -> Context<'static> {
        Context {
            org: "org",
            user: "user",
            collator: icu_collator::Collator::try_new(
                locale.parse::<icu_locale_core::Locale>().unwrap().into(),
                Default::default(),
            )
            .unwrap(),
        }
    }
    #[test]
    fn real_titles_use_the_host_locale_and_pins_precede_time() {
        let a = json!({"title":"Ångström","threadKey":"chat:a","latestActivityAt":"2026-10-01T00:00:00.000Z"});
        let z = json!({"title":"Zebra","threadKey":"chat:z","latestActivityAt":"2026-10-01T00:00:00.000Z"});
        assert!(ordering::compare(&context("en-US"), &a, &z, true, false).is_lt());
        assert!(ordering::compare(&context("sv-SE"), &a, &z, true, false).is_gt());
        let mut pinned = z.clone();
        pinned["isPinned"] = json!(true);
        pinned["latestActivityAt"] = json!("2000-01-01T00:00:00.000Z");
        assert!(ordering::compare(&context("en-US"), &pinned, &a, true, false).is_lt());
    }
    #[test]
    fn projections_keep_human_preview_and_raw_cursor_precision() {
        assert_eq!(
            projection::preview(Some("# Progress\nThe useful **reply**"), 140),
            "Progress: The useful reply"
        );
        assert_eq!(
            projection::preview(Some("https://example.com/release_notes.html"), 140),
            "example.com · release notes"
        );
        let row = camel(
            json!({"created_at":"0044-01-02T03:04:05.123456Z","_activityCursorRaw":"0044-01-02T03:04:05.123456Z"}),
        );
        assert_eq!(row["createdAt"], "0044-01-02T03:04:05.123Z");
        assert_eq!(row["_activityCursorRaw"], "0044-01-02T03:04:05.123456Z");
        assert_eq!(
            object_keys(&json!({"longest":1,"b":2,"10":3,"2":4})),
            vec!["2", "10", "b", "longest"]
        );
    }
}
