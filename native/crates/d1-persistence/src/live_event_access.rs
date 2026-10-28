//! Visibility for ephemeral live frames. Authentication/org access is checked
//! on the same transaction by the native socket owner before calling this.
//! Run privacy remains the shared run_visibility authority, with no cache.
use serde_json::Value;
use sqlx::{Postgres, Transaction};
use std::collections::BTreeSet;
#[derive(Default)]
struct References {
    runs: BTreeSet<String>,
    conversations: BTreeSet<String>,
    generations: BTreeSet<String>,
}
fn identifier(value: &Value) -> Option<String> {
    value
        .as_str()
        .and_then(|s| uuid::Uuid::parse_str(s).ok())
        .map(|id| id.to_string())
}
fn optional_ref(value: Option<&Value>, out: &mut BTreeSet<String>) -> Option<()> {
    match value {
        None | Some(Value::Null) => Some(()),
        Some(value) => {
            out.insert(identifier(value)?);
            Some(())
        }
    }
}
fn references(event_type: &str, payload: &Value) -> Option<References> {
    let mut refs = References::default();
    if !payload.is_object() {
        return None;
    }
    for container in [payload, &payload["details"]] {
        for key in ["runId", "sourceRunId", "activeRunId"] {
            optional_ref(container.get(key), &mut refs.runs)?;
        }
        for key in ["conversationId", "chatConversationId"] {
            optional_ref(container.get(key), &mut refs.conversations)?;
        }
    }
    if event_type.starts_with("heartbeat.run.")
        && payload.get("runId").and_then(identifier).is_none()
    {
        return None;
    }
    if event_type == "activity.logged" {
        match payload["entityType"].as_str() {
            Some("heartbeat_run") => {
                refs.runs.insert(identifier(&payload["entityId"])?);
            }
            Some("chat" | "chat_conversation") => {
                refs.conversations.insert(identifier(&payload["entityId"])?);
            }
            Some("chat_generation") => {
                refs.generations.insert(identifier(&payload["entityId"])?);
            }
            _ => {}
        }
    }
    Some(refs)
}
pub async fn visible_in_transaction(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    owner_user_id: Option<&str>,
    event_type: &str,
    payload: &Value,
) -> Result<bool, sqlx::Error> {
    let Some(refs) = references(event_type, payload) else {
        return Ok(false);
    };
    for run in refs.runs {
        let predicate = crate::run_visibility::predicate("r", 3);
        let sql = format!(
            "SELECT EXISTS(SELECT 1 FROM heartbeat_runs r WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND ({predicate}))"
        );
        let visible: bool = sqlx::query_scalar(&sql)
            .bind(organization_id)
            .bind(run)
            .bind(owner_user_id)
            .fetch_one(&mut **tx)
            .await?;
        if !visible {
            return Ok(false);
        }
    }
    for conversation in refs.conversations {
        let visible:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_conversations c WHERE c.org_id=$1::uuid AND c.id=$2::uuid AND (c.conversation_kind<>'side_chat' OR c.created_by_user_id=$3::text))").bind(organization_id).bind(conversation).bind(owner_user_id).fetch_one(&mut **tx).await?;
        if !visible {
            return Ok(false);
        }
    }
    for generation in refs.generations {
        let visible:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_generations g JOIN chat_conversations c ON c.org_id=g.org_id AND c.id=g.conversation_id WHERE g.org_id=$1::uuid AND g.id=$2::uuid AND (c.conversation_kind<>'side_chat' OR c.created_by_user_id=$3::text))").bind(organization_id).bind(generation).bind(owner_user_id).fetch_one(&mut **tx).await?;
        if !visible {
            return Ok(false);
        }
    }
    Ok(true)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn run_frames_require_a_scoped_run_reference() {
        assert!(references("heartbeat.run.log", &json!({"chunk":"private"})).is_none());
        assert!(references("heartbeat.run.log", &json!({"runId":"invalid"})).is_none());
        assert_eq!(
            references(
                "heartbeat.run.log",
                &json!({"runId":"10000000-0000-4000-8000-000000000001"})
            )
            .unwrap()
            .runs
            .len(),
            1
        );
    }
    #[test]
    fn chat_activity_cannot_skip_conversation_visibility() {
        assert!(
            references(
                "activity.logged",
                &json!({"entityType":"chat","entityId":"invalid"})
            )
            .is_none()
        );
        let refs=references("activity.logged",&json!({"entityType":"chat","entityId":"10000000-0000-4000-8000-000000000001","details":{"runId":"20000000-0000-4000-8000-000000000001"}})).unwrap();
        assert_eq!(refs.runs.len(), 1);
        assert_eq!(refs.conversations.len(), 1);
    }
}
