use super::store::*;
use serde_json::json;

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
