//! Full Messenger Chat history: accepted generation ledger, detached transcript,
//! then legacy payload; external bindings retain their original public fields.
use super::*;

pub(super) async fn read(tx: &mut Tx<'_>, c: &Context<'_>, id: &str) -> Result<Vec<Value>> {
    let mut messages=rows(tx,"SELECT (to_jsonb(m)-'client_mutation_id'-'client_mutation_fingerprint')::text FROM chat_messages m WHERE m.org_id=$1::uuid AND m.conversation_id=$2::uuid ORDER BY m.created_at,m.id",&[c.org,id]).await?;
    let generations = rows(tx, include_str!("generations.sql"), &[c.org, id]).await?;
    let detached=rows(tx,"SELECT jsonb_build_object('messageId',e.message_id,'payload',e.payload)::text FROM chat_message_transcript_entries e JOIN chat_messages m ON m.org_id=e.org_id AND m.id=e.message_id WHERE m.org_id=$1::uuid AND m.conversation_id=$2::uuid ORDER BY e.message_id,e.entry_seq",&[c.org,id]).await?;
    let queues=rows(tx,"SELECT jsonb_build_object('sourceMessageId',source_message_id,'continuationMessageId',continuation_message_id,'deliveryDisposition',CASE WHEN continuation_generation_id IS NOT NULL OR dequeued_at IS NOT NULL THEN 'continuation_pending' WHEN delivery_disposition='delivered' THEN 'accepted_current' ELSE delivery_disposition END)::text FROM chat_queued_messages WHERE org_id=$1::uuid AND conversation_id=$2::uuid",&[c.org,id]).await?;
    let attachments=rows(tx,"SELECT (to_jsonb(ca)||jsonb_build_object('provider',a.provider,'object_key',a.object_key,'content_type',a.content_type,'byte_size',a.byte_size,'sha256',a.sha256,'original_filename',a.original_filename,'created_by_agent_id',a.created_by_agent_id,'created_by_user_id',a.created_by_user_id,'content_path','/api/assets/'||a.id::text||'/content'))::text FROM chat_attachments ca JOIN assets a ON a.org_id=ca.org_id AND a.id=ca.asset_id WHERE ca.org_id=$1::uuid AND ca.conversation_id=$2::uuid ORDER BY ca.created_at",&[c.org,id]).await?;
    let approvals=rows(tx,"SELECT to_jsonb(a)::text FROM approvals a WHERE a.org_id=$1::uuid AND a.id IN (SELECT m.approval_id FROM chat_messages m WHERE m.org_id=$1::uuid AND m.conversation_id=$2::uuid)",&[c.org,id]).await?;
    for message in &mut messages {
        let message_id = text(message, "id").to_owned();
        let generation = generations
            .iter()
            .find(|row| text(row, "messageId") == message_id);
        let ledger = generation
            .and_then(|row| row["transcript"].as_array())
            .filter(|v| !v.is_empty())
            .cloned();
        let detached = detached
            .iter()
            .filter(|row| text(row, "messageId") == message_id && row["payload"].is_object())
            .map(|row| row["payload"].clone())
            .collect::<Vec<_>>();
        let transcript = ledger.unwrap_or_else(|| {
            if !detached.is_empty() {
                detached
            } else {
                message["structuredPayload"]["__chatTranscript"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
            }
        });
        message["shortRef"] = json!(projection::short("msg", &message_id));
        message["generationId"] = generation
            .map(|row| row["generationId"].clone())
            .unwrap_or(Value::Null);
        message["generationTerminalReason"] = generation
            .map(|row| row["terminalReason"].clone())
            .unwrap_or(Value::Null);
        message["transcriptSummary"] = transcript_summary(&transcript);
        message["transcript"] = json!(transcript);
        if let Some(payload) = message["structuredPayload"].as_object_mut() {
            payload.remove("__chatTranscript");
            if payload.get("source").and_then(Value::as_str) == Some("steer") {
                for queue in queues.iter().filter(|row| {
                    text(row, "sourceMessageId") == message_id
                        || text(row, "continuationMessageId") == message_id
                }) {
                    if !text(queue, "deliveryDisposition").is_empty() {
                        payload.insert(
                            "deliveryDisposition".into(),
                            queue["deliveryDisposition"].clone(),
                        );
                    }
                }
            }
            if payload.is_empty() {
                message["structuredPayload"] = Value::Null;
            }
        }
        message["approval"] = approvals
            .iter()
            .find(|row| row["id"] == message["approvalId"])
            .cloned()
            .unwrap_or(Value::Null);
        message["attachments"] = json!(
            attachments
                .iter()
                .filter(|row| text(row, "messageId") == message_id)
                .cloned()
                .map(|mut row| {
                    if text(&row, "contentType") == "text/html"
                        && !text(&row, "createdByAgentId").is_empty()
                    {
                        row.as_object_mut().unwrap().remove("provider");
                        row.as_object_mut().unwrap().remove("objectKey");
                    }
                    row
                })
                .collect::<Vec<_>>()
        );
    }
    Ok(messages)
}
fn transcript_summary(entries: &[Value]) -> Value {
    if entries.is_empty() {
        return Value::Null;
    }
    let mut dates = entries
        .iter()
        .filter_map(|entry| millis(&entry["ts"]).map(|at| (at, entry["ts"].clone())))
        .collect::<Vec<_>>();
    dates.sort_by_key(|(at, _)| *at);
    json!({"entryCount":entries.len(),"startedAt":dates.first().map(|(_,v)|v.clone()),"endedAt":dates.last().map(|(_,v)|v.clone())})
}
