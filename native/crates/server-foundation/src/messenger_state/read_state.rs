//! Per-user read cursors, distinct from Issue lifecycle and execution state.
use super::store::*;
use rudder_d1_persistence::messenger_reads::mutation_snapshot;
use serde_json::json;
const STAMP: &str = "YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"";
async fn can_issue(tx: &mut Tx<'_>, s: &Scope<'_>, id: &str) -> Result<bool> {
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM issues i WHERE i.org_id=$1::uuid AND i.id=$3::uuid AND ((i.origin_kind<>'automation_execution' AND (i.assignee_user_id=$2 OR i.reviewer_user_id=$2 OR i.created_by_user_id=$2)) OR EXISTS(SELECT 1 FROM issue_follows f WHERE f.org_id=i.org_id AND f.issue_id=i.id AND f.user_id=$2) OR EXISTS(SELECT 1 FROM activity_log a WHERE a.org_id=i.org_id AND a.entity_type='issue' AND a.entity_id=i.id::text AND a.action IN ('automation.issue_created_notification','agent.issue_created_notification') AND a.details->>'userId'=$2)))").bind(s.org).bind(s.user).bind(id).fetch_one(&mut **tx).await?)
}
pub(super) async fn read(
    tx: &mut Tx<'_>,
    s: &Scope<'_>,
    key: &str,
    requested: Option<&str>,
    chat_latest: bool,
) -> Result<String> {
    let mut effective = requested.map(str::to_owned);
    if let Some(id) = key.strip_prefix("chat:") {
        let latest=sqlx::query_scalar::<_,Option<String>>(&format!("SELECT to_char(last_message_at AT TIME ZONE 'UTC','{STAMP}') FROM chat_conversations WHERE org_id=$1::uuid AND id=$2::uuid AND messenger_visible AND (conversation_kind<>'side_chat' OR created_by_user_id=$3) FOR KEY SHARE")).bind(s.org).bind(id).bind(s.user).fetch_optional(&mut **tx).await?.ok_or(Error::Http(404,"Chat conversation not found"))?;
        if chat_latest {
            effective = latest;
        }
        let stamp:String=sqlx::query_scalar(&format!("INSERT INTO chat_conversation_user_states(org_id,conversation_id,user_id,last_read_at,updated_at) VALUES($1::uuid,$2::uuid,$3,coalesce($4::timestamptz,current_setting('rudder.messenger_now')::timestamptz),current_setting('rudder.messenger_now')::timestamptz) ON CONFLICT(org_id,conversation_id,user_id) DO UPDATE SET last_read_at=EXCLUDED.last_read_at,updated_at=EXCLUDED.updated_at RETURNING to_char(last_read_at AT TIME ZONE 'UTC','{STAMP}')")).bind(s.org).bind(id).bind(s.user).bind(effective).fetch_one(&mut **tx).await?;
        mutation_activity(
            tx,
            s,
            "messenger.thread_read",
            "messenger_thread",
            key,
            json!({"lastReadAt":stamp}),
        )
        .await?;
        return encode(&json!({"threadKey":key,"lastReadAt":stamp}));
    }
    if let Some(id) = key.strip_prefix("issue:") {
        if !can_issue(tx, s, id).await? {
            return Err(Error::Http(404, "Messenger thread not found"));
        }
        let attention =
            mutation_snapshot::issue_attention(tx, s.org, s.user, &locale(), Some(id)).await?;
        effective=sqlx::query_scalar("SELECT greatest(coalesce($1::timestamptz,current_setting('rudder.messenger_now')::timestamptz),$2::timestamptz,(SELECT updated_at FROM issues WHERE org_id=$3::uuid AND id=$4::uuid))::text").bind(effective).bind(attention).bind(s.org).bind(id).fetch_one(&mut **tx).await?;
    } else if key == "issues" {
        let attention =
            mutation_snapshot::issue_attention(tx, s.org, s.user, &locale(), None).await?;
        effective=sqlx::query_scalar("SELECT greatest(coalesce($1::timestamptz,current_setting('rudder.messenger_now')::timestamptz),$2::timestamptz)::text").bind(effective).bind(attention).fetch_one(&mut **tx).await?;
    } else if !["approvals", "failed-runs", "budget-alerts", "join-requests"].contains(&key) {
        return Err(Error::Http(404, "Messenger thread not found"));
    }
    let stamp:String=sqlx::query_scalar(&format!("INSERT INTO messenger_thread_user_states(org_id,user_id,thread_key,last_read_at,updated_at) VALUES($1::uuid,$2,$3,coalesce($4::timestamptz,current_setting('rudder.messenger_now')::timestamptz),current_setting('rudder.messenger_now')::timestamptz) ON CONFLICT(org_id,thread_key,user_id) DO UPDATE SET last_read_at=EXCLUDED.last_read_at,updated_at=EXCLUDED.updated_at RETURNING to_char(last_read_at AT TIME ZONE 'UTC','{STAMP}')")).bind(s.org).bind(s.user).bind(key).bind(effective).fetch_one(&mut **tx).await?;
    mutation_activity(
        tx,
        s,
        "messenger.thread_read",
        "messenger_thread",
        key,
        json!({"lastReadAt":stamp}),
    )
    .await?;
    encode(&json!({"threadKey":key,"lastReadAt":stamp}))
}
pub(super) async fn issue(tx: &mut Tx<'_>, s: &Scope<'_>, id: &str) -> Result<String> {
    let exists = sqlx::query_scalar::<_, String>(
        "SELECT id::text FROM issues WHERE org_id=$1::uuid AND id=$2::uuid FOR KEY SHARE",
    )
    .bind(s.org)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?;
    if exists.is_none() {
        return Err(Error::Http(404, "Issue not found"));
    }
    let raw:String=sqlx::query_scalar(&format!("INSERT INTO issue_read_states(org_id,issue_id,user_id,last_read_at,updated_at) VALUES($1::uuid,$2::uuid,$3,current_setting('rudder.messenger_now')::timestamptz,current_setting('rudder.messenger_now')::timestamptz) ON CONFLICT(org_id,issue_id,user_id) DO UPDATE SET last_read_at=EXCLUDED.last_read_at,updated_at=EXCLUDED.updated_at RETURNING jsonb_build_object('id',id,'orgId',org_id,'issueId',issue_id,'userId',user_id,'lastReadAt',to_char(last_read_at AT TIME ZONE 'UTC','{STAMP}'),'createdAt',to_char(created_at AT TIME ZONE 'UTC','{STAMP}'),'updatedAt',to_char(updated_at AT TIME ZONE 'UTC','{STAMP}'))::text")).bind(s.org).bind(id).bind(s.user).fetch_one(&mut **tx).await?;
    // The public Issue alias records a read even if the user does not track it;
    // the legacy Messenger update returned null in that case and was ignored.
    if can_issue(tx, s, id).await? {
        read(tx, s, &format!("issue:{id}"), None, false).await?;
    }
    mutation_activity(tx, s, "issue.read", "issue", id, json!({})).await?;
    Ok(raw)
}
pub(super) async fn dismiss(tx: &mut Tx<'_>, s: &Scope<'_>) -> Result<String> {
    let summaries = mutation_snapshot::items(tx, s.org, s.user, &locale(), None).await?;
    // The legacy directory uses its aggregate Issues thread, not split cards.
    let mut keys = Vec::new();
    for summary in summaries.iter().filter(|v| {
        !field(v, "threadKey").starts_with("issue:") && v["unreadCount"].as_u64().unwrap_or(0) > 0
    }) {
        let key = field(summary, "threadKey");
        match read(tx, s, key, summary["latestActivityAt"].as_str(), false).await {
            Ok(_) => keys.push(key.to_owned()),
            Err(Error::Http(404, _)) => (),
            Err(error) => return Err(error),
        }
    }
    mutation_activity(
        tx,
        s,
        "messenger.unreads_dismissed",
        "organization",
        s.org,
        json!({"dismissedThreadKeys":keys}),
    )
    .await?;
    encode(&json!({"dismissedCount":keys.len(),"dismissedThreadKeys":keys}))
}
