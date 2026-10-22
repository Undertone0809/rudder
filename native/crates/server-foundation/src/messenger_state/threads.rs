use super::{audit, store::*};
use serde_json::json;
use sqlx::Row;

pub(super) async fn pin(
    tx: &mut Tx<'_>,
    s: &Scope<'_>,
    key: &str,
    pinned: Option<bool>,
) -> Result<String> {
    let chat = key.strip_prefix("chat:");
    let issue = key.strip_prefix("issue:");
    if chat.is_none()
        && issue.is_none()
        && ![
            "issues",
            "approvals",
            "failed-runs",
            "budget-alerts",
            "join-requests",
        ]
        .contains(&key)
    {
        return Err(Error::Http(404, "Messenger thread not found"));
    }
    let Some(pinned) = pinned else {
        return encode(&json!({"threadKey":key}));
    };
    if let Some(id) = chat {
        // Lock the parent before touching its child state, without a placement
        // owner lock. Delete-first waits then returns no row (404); pin-first
        // retains this key-share lock until commit so DELETE can cascade after
        // us. This avoids both the Node cleanup lock inversion and FK-race 500s.
        let exists = sqlx::query_scalar::<_, String>(
            "SELECT id::text FROM chat_conversations WHERE org_id=$1::uuid AND id=$2::uuid FOR KEY SHARE",
        )
        .bind(s.org).bind(id).fetch_optional(&mut **tx).await?;
        if exists.is_none() {
            return Err(Error::Http(404, "Messenger thread not found"));
        }
        let result=sqlx::query("INSERT INTO chat_conversation_user_states(org_id,conversation_id,user_id,last_read_at,pinned_at,updated_at) SELECT org_id,id,$2,COALESCE(last_message_at,updated_at,created_at),CASE WHEN $4 THEN current_setting('rudder.messenger_now')::timestamptz ELSE NULL END,current_setting('rudder.messenger_now')::timestamptz FROM chat_conversations WHERE org_id=$1::uuid AND id=$3::uuid ON CONFLICT(org_id,conversation_id,user_id) DO UPDATE SET pinned_at=EXCLUDED.pinned_at,updated_at=EXCLUDED.updated_at")
            .bind(s.org).bind(s.user).bind(id).bind(pinned).execute(&mut **tx).await?;
        if result.rows_affected() == 0 {
            return Err(Error::Http(404, "Messenger thread not found"));
        }
    } else {
        if let Some(id) = issue {
            // This is canUseIssueThread, deliberately distinct from group/list
            // visibility: legacy pinning does not filter hidden issue rows.
            let allowed=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM issues i WHERE i.org_id=$1::uuid AND i.id=$3::uuid AND ((i.origin_kind<>'automation_execution' AND (i.assignee_user_id=$2 OR i.reviewer_user_id=$2 OR i.created_by_user_id=$2)) OR EXISTS(SELECT 1 FROM issue_follows f WHERE f.org_id=$1::uuid AND f.user_id=$2 AND f.issue_id=i.id) OR EXISTS(SELECT 1 FROM activity_log a WHERE a.org_id=$1::uuid AND a.entity_type='issue' AND a.entity_id=i.id::text AND a.action IN ('automation.issue_created_notification','agent.issue_created_notification') AND a.details->>'userId'=$2)))")
                .bind(s.org).bind(s.user).bind(id).fetch_one(&mut **tx).await?;
            if !allowed {
                return Err(Error::Http(404, "Messenger thread not found"));
            }
        }
        sqlx::query("INSERT INTO messenger_thread_user_states(org_id,user_id,thread_key,last_read_at,pinned_at,updated_at) VALUES($1::uuid,$2,$3,to_timestamp(0),CASE WHEN $4 THEN current_setting('rudder.messenger_now')::timestamptz ELSE NULL END,current_setting('rudder.messenger_now')::timestamptz) ON CONFLICT(org_id,thread_key,user_id) DO UPDATE SET pinned_at=EXCLUDED.pinned_at,updated_at=EXCLUDED.updated_at")
            .bind(s.org).bind(s.user).bind(key).bind(pinned).execute(&mut **tx).await?;
    }
    encode(&json!({"threadKey":key,"pinned":pinned}))
}

pub(super) async fn follow_issue(tx: &mut Tx<'_>, s: &Scope<'_>, issue_id: &str) -> Result<String> {
    let issue = sqlx::query(
        "SELECT id::text, identifier, title
         FROM issues
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(s.org)
    .bind(issue_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| Error::Http(404, "Issue not found"))?;
    let row = sqlx::query(
        "INSERT INTO issue_follows (org_id, issue_id, user_id, created_at)
         VALUES ($1::uuid, $2::uuid, $3, current_setting('rudder.messenger_now')::timestamptz)
         ON CONFLICT (org_id, issue_id, user_id)
         DO UPDATE SET created_at=EXCLUDED.created_at
         RETURNING id::text, org_id::text, issue_id::text, user_id,
                   to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at",
    )
    .bind(s.org)
    .bind(issue_id)
    .bind(s.user)
    .fetch_one(&mut **tx)
    .await?;
    let id: String = row.try_get("id")?;
    let details = json!({
        "issueId": issue_id,
        "identifier": issue.try_get::<Option<String>, _>("identifier")?,
        "title": issue.try_get::<Option<String>, _>("title")?,
    });
    audit::activity(
        tx,
        s,
        audit::Activity {
            action: "issue.followed",
            entity_type: "issue",
            entity_id: issue_id,
            details,
            idempotency_key: None,
            event: true,
        },
    )
    .await?;
    encode(&json!({
        "id": id,
        "orgId": row.try_get::<String, _>("org_id")?,
        "issueId": row.try_get::<String, _>("issue_id")?,
        "userId": row.try_get::<String, _>("user_id")?,
        "createdAt": row.try_get::<String, _>("created_at")?,
    }))
}

pub(super) async fn unfollow_issue(
    tx: &mut Tx<'_>,
    s: &Scope<'_>,
    issue_id: &str,
) -> Result<String> {
    let issue = sqlx::query(
        "SELECT identifier, title
         FROM issues
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(s.org)
    .bind(issue_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| Error::Http(404, "Issue not found"))?;
    let removed = sqlx::query(
        "DELETE FROM issue_follows
         WHERE org_id=$1::uuid AND issue_id=$2::uuid AND user_id=$3",
    )
    .bind(s.org)
    .bind(issue_id)
    .bind(s.user)
    .execute(&mut **tx)
    .await?
    .rows_affected()
        > 0;
    if removed {
        let details = json!({
            "issueId": issue_id,
            "identifier": issue.try_get::<Option<String>, _>("identifier")?,
            "title": issue.try_get::<Option<String>, _>("title")?,
        });
        audit::activity(
            tx,
            s,
            audit::Activity {
                action: "issue.unfollowed",
                entity_type: "issue",
                entity_id: issue_id,
                details,
                idempotency_key: None,
                event: true,
            },
        )
        .await?;
    }
    encode(&json!({"ok": true}))
}
