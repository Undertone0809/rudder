use super::*;
use std::collections::{HashMap, HashSet};
const SYNTHETIC: [&str; 5] = [
    "issues",
    "approvals",
    "failed-runs",
    "budget-alerts",
    "join-requests",
];

pub(super) async fn read(tx: &mut Tx<'_>, c: &Context<'_>) -> Result<Value> {
    let mut groups=rows(tx,"SELECT to_jsonb(g)::text FROM messenger_custom_groups g WHERE org_id=$1::uuid AND user_id=$2 ORDER BY pinned_at IS NULL,sort_order,created_at",&[c.org,c.user]).await?;
    let entries=rows(tx,"SELECT to_jsonb(e)::text FROM messenger_custom_group_entries e WHERE org_id=$1::uuid AND user_id=$2 ORDER BY sort_order,created_at",&[c.org,c.user]).await?;
    // Legacy malformed item keys fail before cleanup; a read must never turn
    // a validation error into destructive membership removal.
    for entry in &entries {
        let key = text(entry, "threadKey");
        if let Some(id) = key.strip_prefix("saved-view:")
            && (id.len() != 36 || uuid::Uuid::parse_str(id).is_err())
        {
            return Err(http(400, "Invalid Messenger Saved View item key"));
        }
        for prefix in ["chat:", "issue:"] {
            if let Some(id) = key.strip_prefix(prefix).filter(|id| !id.trim().is_empty())
                && uuid::Uuid::parse_str(id).is_err()
            {
                return Err(http(500, "Internal server error"));
            }
        }
    }
    let saved=rows(tx,"SELECT to_jsonb(s)::text FROM messenger_saved_views s WHERE org_id=$1::uuid AND user_id=$2",&[c.org,c.user]).await?;
    let ids = entries
        .iter()
        .filter_map(|e| text(e, "threadKey").strip_prefix("chat:"))
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut summaries: HashMap<String, Value> = chat::summaries(tx, c, Some(&ids))
        .await?
        .into_iter()
        .map(|v| (text(&v, "threadKey").to_owned(), v))
        .collect();
    let issue_keys = entries
        .iter()
        .filter_map(|e| text(e, "threadKey").strip_prefix("issue:"))
        .collect::<HashSet<_>>();
    if !issue_keys.is_empty() || entries.iter().any(|e| e["threadKey"] == "issues") {
        let mut data = issues::read(tx, c, None, None, false).await?;
        if data["itemCount"].as_u64().unwrap_or(0) > 0 {
            summaries.insert("issues".into(), data["summary"].clone());
        }
        // A grouped Issue may be older than the directory's 100 split cards.
        data["_entries"]
            .as_array_mut()
            .unwrap()
            .retain(|v| issue_keys.contains(text(v, "id")));
        for summary in issues::split(tx, c, &data).await? {
            summaries.insert(text(&summary, "threadKey").to_owned(), summary);
        }
    }
    for key in SYNTHETIC
        .into_iter()
        .filter(|key| *key != "issues" && entries.iter().any(|e| text(e, "threadKey") == *key))
    {
        let data = if key == "approvals" {
            requests::read(tx, c, false).await?
        } else {
            signals::read(tx, c, key, false).await?
        };
        if data["itemCount"].as_u64().unwrap_or(0) > 0 {
            summaries.insert(key.into(), data["summary"].clone());
        }
    }
    let mut stale = Vec::new();
    let mut hydrated: HashMap<String, Vec<Value>> = HashMap::new();
    for entry in entries {
        let key = text(&entry, "threadKey");
        let mut output = entry.clone();
        let item = if let Some(id) = key
            .strip_prefix("saved-view:")
            .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        {
            let Some(saved) = saved.iter().find(|v| text(v, "id") == id) else {
                stale.push(entry);
                continue;
            };
            if !saved["hiddenAt"].is_null() {
                continue;
            }
            output.as_object_mut().unwrap().remove("threadKey");
            json!({"type":"saved_view","itemKey":key,"title":saved["title"],"savedView":saved})
        } else if let Some(summary) = summaries.get(key) {
            output["thread"] = summary.clone();
            json!({"type":"thread","itemKey":key,"title":summary["title"],"thread":summary})
        } else {
            if !SYNTHETIC.contains(&key) {
                stale.push(entry)
            }
            continue;
        };
        output["itemKey"] = json!(key);
        output["item"] = item;
        hydrated
            .entry(text(&output, "groupId").into())
            .or_default()
            .push(output);
    }
    let deleted = cleanup(tx, c, &stale).await?;
    groups.retain(|g| !deleted.contains(text(g, "id")));
    for group in &mut groups {
        group["entries"] = json!(hydrated.remove(text(group, "id")).unwrap_or_default());
    }
    Ok(json!({"groups":groups}))
}
async fn cleanup(tx: &mut Tx<'_>, c: &Context<'_>, stale: &[Value]) -> Result<HashSet<String>> {
    let mut deleted = HashSet::new();
    if stale.is_empty() {
        return Ok(deleted);
    }
    // These are the existing Saved View owner/group locks, shared with legacy
    // writes and native state mutations. Owner always precedes sorted groups.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!(
            "messenger-saved-views:{}:{}",
            c.org.to_lowercase(),
            c.user
        ))
        .execute(&mut **tx)
        .await?;
    let ids = json!(stale.iter().map(|v| text(v, "id")).collect::<Vec<_>>()).to_string();
    let current=rows(tx,"SELECT to_jsonb(e)::text FROM messenger_custom_group_entries e WHERE org_id=$1::uuid AND user_id=$2 AND id::text IN (SELECT jsonb_array_elements_text($3::jsonb))",&[c.org,c.user,&ids]).await?;
    let mut groups = stale
        .iter()
        .chain(current.iter())
        .map(|e| text(e, "groupId").to_owned())
        .collect::<Vec<_>>();
    groups.sort();
    groups.dedup();
    for group in &groups {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
            .bind(format!(
                "messenger-custom-group:{}:{}:{}",
                c.org.to_lowercase(),
                c.user,
                group.to_lowercase()
            ))
            .execute(&mut **tx)
            .await?;
    }
    for entry in current {
        if !stale.iter().any(|v| {
            v["id"] == entry["id"]
                && v["groupId"] == entry["groupId"]
                && v["threadKey"] == entry["threadKey"]
        }) {
            continue;
        }
        sqlx::query("DELETE FROM messenger_custom_group_entries WHERE org_id=$1::uuid AND user_id=$2 AND id=$3::uuid AND group_id=$4::uuid AND thread_key=$5").bind(c.org).bind(c.user).bind(text(&entry,"id")).bind(text(&entry,"groupId")).bind(text(&entry,"threadKey")).execute(&mut **tx).await?;
    }
    for group in groups {
        if sqlx::query("DELETE FROM messenger_custom_groups g WHERE g.org_id=$1::uuid AND g.user_id=$2 AND g.id=$3::uuid AND NOT EXISTS(SELECT 1 FROM messenger_custom_group_entries e WHERE e.org_id=g.org_id AND e.user_id=g.user_id AND e.group_id=g.id)").bind(c.org).bind(c.user).bind(&group).execute(&mut **tx).await?.rows_affected()>0{deleted.insert(group);}
    }
    Ok(deleted)
}
