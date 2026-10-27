use super::*;
use std::collections::HashMap;
/// Lookup includes fork ancestors, but never crosses organization/private owner.
pub(super) async fn sources(
    tx: &mut Tx<'_>,
    c: &Context<'_>,
    conversations: &[Value],
) -> Result<HashMap<String, Value>> {
    let ids = json!(
        conversations
            .iter()
            .flat_map(
                |row| ["id", "forkedFromConversationId", "forkRootConversationId"]
                    .into_iter()
                    .filter_map(move |key| row[key].as_str())
            )
            .collect::<Vec<_>>()
    )
    .to_string();
    let current=rows(tx,"SELECT jsonb_build_object('conversationId',b.conversation_id,'source','agent_integration','provider',i.provider,'integrationId',b.integration_id,'externalChatId',b.external_chat_id,'externalChatType',b.external_chat_type)::text FROM agent_integration_chat_bindings b JOIN agent_integrations i ON i.org_id=b.org_id AND i.id=b.integration_id JOIN chat_conversations c ON c.org_id=b.org_id AND c.id=b.conversation_id WHERE b.org_id=$1::uuid AND (c.conversation_kind<>'side_chat' OR c.created_by_user_id=$2) AND b.conversation_id::text IN (SELECT jsonb_array_elements_text($3::jsonb)) ORDER BY b.created_at",&[c.org,c.user,&ids]).await?;
    let historical=rows(tx,"SELECT jsonb_build_object('conversationId',m.conversation_id,'source','agent_integration','provider','feishu','integrationId',m.structured_payload->>'integrationId','externalChatId',m.structured_payload->>'externalChatId','externalChatType',m.structured_payload->>'externalChatType')::text FROM chat_messages m JOIN chat_conversations c ON c.org_id=m.org_id AND c.id=m.conversation_id WHERE m.org_id=$1::uuid AND (c.conversation_kind<>'side_chat' OR c.created_by_user_id=$2) AND m.conversation_id::text IN (SELECT jsonb_array_elements_text($3::jsonb)) AND m.structured_payload->>'source'='agent_integration' AND m.structured_payload->>'provider'='feishu' ORDER BY m.created_at",&[c.org,c.user,&ids]).await?;
    let mut map = HashMap::new();
    for mut row in current.into_iter().chain(historical) {
        let id = text(&row, "conversationId").to_owned();
        if ["integrationId", "externalChatId", "externalChatType"]
            .iter()
            .any(|key| text(&row, key).is_empty())
        {
            continue;
        }
        row.as_object_mut().unwrap().remove("conversationId");
        map.entry(id).or_insert(row);
    }
    Ok(map)
}
pub(super) async fn detail(
    tx: &mut Tx<'_>,
    c: &Context<'_>,
    conversation: &mut Value,
) -> Result<()> {
    let id = text(conversation, "id").to_owned();
    conversation["primaryIssue"] = if text(conversation, "primaryIssueId").is_empty() {
        Value::Null
    } else {
        rows(tx,"SELECT jsonb_build_object('id',id,'identifier',identifier,'title',title,'status',status,'priority',priority)::text FROM issues WHERE org_id=$1::uuid AND id=$2::uuid",&[c.org,text(conversation,"primaryIssueId")]).await?.pop().unwrap_or(Value::Null)
    };
    let mut links=rows(tx,"SELECT to_jsonb(l)::text FROM chat_context_links l WHERE org_id=$1::uuid AND conversation_id=$2::uuid ORDER BY created_at",&[c.org,&id]).await?;
    // Resolve only the four supported entity types. Historical dangling links
    // retain a null entity, matching the legacy conversation contract.
    for link in &mut links {
        let kind = text(link, "entityType");
        let entity = text(link, "entityId");
        let sql = match kind {
            "issue" => {
                "SELECT jsonb_build_object('type','issue','id',id,'label',title,'subtitle',status,'identifier',identifier,'status',status,'description',description,'priority',priority,'href','/issues/'||coalesce(identifier,id::text))::text FROM issues WHERE org_id=$1::uuid AND id::text=$2"
            }
            "project" => {
                "SELECT jsonb_build_object('type','project','id',id,'label',name,'subtitle',description,'identifier',NULL,'status',status,'href','/projects/'||id::text)::text FROM projects WHERE org_id=$1::uuid AND id::text=$2"
            }
            "agent" => {
                "SELECT jsonb_build_object('type','agent','id',id,'label',name,'subtitle',title,'identifier',NULL,'status',status,'href','/agents/'||id::text)::text FROM agents WHERE org_id=$1::uuid AND id::text=$2"
            }
            "goal" => {
                "SELECT jsonb_build_object('type','goal','id',id,'label',title,'subtitle',lifecycle,'identifier',NULL,'status',status,'description',description,'href','/goals/'||id::text)::text FROM goals WHERE org_id=$1::uuid AND id::text=$2"
            }
            _ => {
                link["entity"] = Value::Null;
                continue;
            }
        };
        link["entity"] = rows(tx, sql, &[c.org, entity])
            .await?
            .pop()
            .unwrap_or(Value::Null);
    }
    conversation["contextLinks"] = json!(links);
    Ok(())
}
