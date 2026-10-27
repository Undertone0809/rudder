//! Messenger supports native and externally bound conversations. Authorization
//! is applied before user-state initialization, message hydration, or counting.
use super::*;
mod context;
mod messages;

pub(super) async fn summaries(
    tx: &mut Tx<'_>,
    c: &Context<'_>,
    ids: Option<&[String]>,
) -> Result<Vec<Value>> {
    let filter = json!({"all":ids.is_none(),"ids":ids.unwrap_or(&[])}).to_string();
    let conversations=rows(tx,"SELECT to_jsonb(c)::text FROM chat_conversations c WHERE c.org_id=$1::uuid AND c.status='active' AND c.messenger_visible AND (c.conversation_kind<>'side_chat' OR c.created_by_user_id=$2) AND ($3::jsonb->>'all'='true' OR c.id::text IN (SELECT jsonb_array_elements_text($3::jsonb->'ids'))) ORDER BY coalesce(c.last_message_at,c.updated_at) DESC,c.title,c.id",&[c.org,c.user,&filter]).await?;
    Ok(hydrate(tx, c, conversations, false)
        .await?
        .iter()
        .map(summary)
        .collect())
}
pub(super) async fn page_summaries(
    tx: &mut Tx<'_>,
    c: &Context<'_>,
    limit: usize,
    cursor: Option<&Value>,
) -> Result<Vec<Value>> {
    let after = cursor.filter(|v| !truth(v, "isPinned"));
    let stamp = after.map(|v| text(v, "latestActivityAt")).unwrap_or("");
    let title = after.map(|v| text(v, "title")).unwrap_or("");
    let key = after.map(|v| text(v, "threadKey")).unwrap_or("");
    let sql = "SELECT to_jsonb(c)::text FROM chat_conversations c WHERE c.org_id=$1::uuid AND c.status='active' AND (c.conversation_kind<>'side_chat' OR c.created_by_user_id=$2) AND NOT EXISTS(SELECT 1 FROM chat_conversation_user_states s WHERE s.org_id=c.org_id AND s.user_id=$2 AND s.conversation_id=c.id AND s.pinned_at IS NOT NULL) AND ($3='' OR coalesce(c.last_message_at,c.updated_at)<NULLIF($3,'')::timestamptz OR (coalesce(c.last_message_at,c.updated_at)=NULLIF($3,'')::timestamptz AND (c.title>$4 OR (c.title=$4 AND 'chat:'||c.id::text>$5)))) ORDER BY coalesce(c.last_message_at,c.updated_at) DESC,c.title,c.id LIMIT $6::bigint";
    let mut conversations = rows(
        tx,
        sql,
        &[c.org, c.user, stamp, title, key, &limit.to_string()],
    )
    .await?;
    let pinned=rows(tx,"SELECT to_jsonb(c)::text FROM chat_conversations c WHERE c.org_id=$1::uuid AND c.status='active' AND (c.conversation_kind<>'side_chat' OR c.created_by_user_id=$2) AND EXISTS(SELECT 1 FROM chat_conversation_user_states s WHERE s.org_id=c.org_id AND s.user_id=$2 AND s.conversation_id=c.id AND s.pinned_at IS NOT NULL) ORDER BY coalesce(c.last_message_at,c.updated_at) DESC,c.title,c.id",&[c.org,c.user]).await?;
    conversations.extend(pinned);
    Ok(hydrate(tx, c, conversations, false)
        .await?
        .iter()
        .filter(|v| truth(v, "messengerVisible"))
        .map(summary)
        .collect())
}
pub(super) async fn detail(tx: &mut Tx<'_>, c: &Context<'_>, id: &str) -> Result<Value> {
    let conversations=rows(tx,"SELECT to_jsonb(c)::text FROM chat_conversations c WHERE c.org_id=$1::uuid AND c.id=$3::uuid AND c.messenger_visible AND (c.conversation_kind<>'side_chat' OR c.created_by_user_id=$2)",&[c.org,c.user,id]).await?;
    if conversations.is_empty() {
        return Err(http(404, "Chat conversation not found"));
    }
    let conversation = hydrate(tx, c, conversations, true)
        .await?
        .pop()
        .ok_or_else(|| http(404, "Chat conversation not found"))?;
    let messages = messages::read(tx, c, id).await?;
    Ok(json!({"conversation":conversation,"messages":messages}))
}
async fn hydrate(
    tx: &mut Tx<'_>,
    c: &Context<'_>,
    mut conversations: Vec<Value>,
    full: bool,
) -> Result<Vec<Value>> {
    if conversations.is_empty() {
        return Ok(conversations);
    }
    let ids = json!(
        conversations
            .iter()
            .map(|v| text(v, "id"))
            .collect::<Vec<_>>()
    )
    .to_string();
    // Preserve the snapshot baseline, while locking surviving parents in UUID
    // order through insertion. Never initialize another owner's private chat.
    let parents=rows(tx,"SELECT jsonb_build_object('id',c.id)::text FROM chat_conversations c WHERE c.org_id=$1::uuid AND (c.conversation_kind<>'side_chat' OR c.created_by_user_id=$2) AND c.id::text IN (SELECT jsonb_array_elements_text($3::jsonb)) ORDER BY c.id FOR KEY SHARE",&[c.org,c.user,&ids]).await?;
    conversations.retain(|v| parents.iter().any(|p| p["id"] == v["id"]));
    let baseline=json!(conversations.iter().filter(|v|parents.iter().any(|p|p["id"]==v["id"])).map(|v|json!({"id":v["id"],"lastReadAt":v["lastMessageAt"].as_str().or_else(||v["updatedAt"].as_str()).or_else(||v["createdAt"].as_str())})).collect::<Vec<_>>()).to_string();
    sqlx::query("INSERT INTO chat_conversation_user_states(org_id,conversation_id,user_id,last_read_at,updated_at) SELECT $1::uuid,(v->>'id')::uuid,$2,(v->>'lastReadAt')::timestamptz,clock_timestamp() FROM jsonb_array_elements($3::jsonb) v ON CONFLICT DO NOTHING").bind(c.org).bind(c.user).bind(baseline).execute(&mut **tx).await?;
    let source = context::sources(tx, c, &conversations).await?;
    let hydration = rows(
        tx,
        include_str!("chat/hydration.sql"),
        &[c.org, c.user, &ids],
    )
    .await?;
    for conversation in &mut conversations {
        let id = text(conversation, "id").to_owned();
        let h = hydration
            .iter()
            .find(|v| text(v, "id") == id)
            .cloned()
            .unwrap_or(json!({}));
        let bound = source.get(&id).cloned().unwrap_or(Value::Null);
        let external = !bound.is_null();
        let unread = if external {
            0
        } else {
            h["unreadCount"].as_i64().unwrap_or(0)
        };
        conversation["shortRef"] = json!(projection::short("cht", &id));
        conversation["latestReplyPreview"] =
            projection::preview(h["latestReplyBody"].as_str(), 140);
        conversation["latestUserMessagePreview"] =
            projection::preview(h["latestUserBody"].as_str(), 140);
        conversation["userMessageCount"] = h["userMessageCount"].clone();
        conversation["lastReadAt"] = h["lastReadAt"].clone();
        conversation["isPinned"] = json!(!h["pinnedAt"].is_null());
        conversation["unreadCount"] = json!(unread);
        conversation["isUnread"] = json!(unread > 0);
        conversation["needsAttention"] =
            json!(!external && (unread > 0 || truth(&h, "pendingProposal")));
        conversation["mutability"] = json!(if external {
            "external_bound_chat"
        } else if ["forkedFromConversationId", "forkRootConversationId"]
            .iter()
            .any(|key| source.contains_key(text(conversation, key)))
        {
            "native_fork_from_external"
        } else {
            "native_chat"
        });
        conversation["sourceMetadata"] = bound;
        if full {
            context::detail(tx, c, conversation).await?;
        } else {
            conversation["activeGenerationId"] = h["activeGenerationId"].clone();
        }
    }
    Ok(conversations)
}
fn summary(conversation: &Value) -> Value {
    let preview = [
        conversation["latestReplyPreview"].clone(),
        projection::preview(conversation["summary"].as_str(), 140),
        projection::preview(conversation["title"].as_str(), 140),
    ]
    .into_iter()
    .find(|v| !v.is_null())
    .unwrap_or(json!("Start the conversation"));
    let mut metadata = json!({"preferredAgentId":conversation["preferredAgentId"],"routedAgentId":conversation["routedAgentId"],"runtimeAgentId":null,"latestUserMessagePreview":conversation["latestUserMessagePreview"],"activeGenerationId":conversation["activeGenerationId"]});
    if let Some(source) = conversation["sourceMetadata"].as_object() {
        metadata.as_object_mut().unwrap().extend(source.clone());
    }
    json!({"threadKey":format!("chat:{}",text(conversation,"id")),"kind":"chat","title":projection::title(text(conversation,"title")),"subtitle":preview,"preview":preview,"latestActivityAt":conversation["lastMessageAt"].as_str().or_else(||conversation["updatedAt"].as_str()),"lastReadAt":conversation["lastReadAt"],"unreadCount":conversation["unreadCount"],"needsAttention":conversation["needsAttention"],"isPinned":conversation["isPinned"],"href":format!("/messenger/chat/{}",text(conversation,"id")),"metadata":metadata})
}
