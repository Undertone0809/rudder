//! Materialize an already-proven native Automation Chat result. This does not
//! create execution authority or infer provider/process termination.
use super::*;
mod visuals;
use crate::issue_core_writes::IssueAssetStorage;
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::collections::BTreeSet;

struct Reply {
    kind: String,
    body: String,
    payload: Value,
}
fn object(raw: &str) -> Option<Value> {
    let start = raw.find('{')?;
    let mut stream = serde_json::Deserializer::from_str(&raw[start..]).into_iter::<Value>();
    stream.next()?.ok().filter(Value::is_object)
}
fn bounded(value: &Value, min: usize, max: usize) -> Option<String> {
    let value = value.as_str()?.trim();
    (value.chars().count() >= min && value.chars().count() <= max).then(|| value.into())
}
fn identifier(value: &Value) -> Option<String> {
    bounded(value, 1, 64).filter(|v| {
        v.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    })
}
fn ask_request(payload: &Value) -> Option<Value> {
    let questions = payload["requestUserInput"]["questions"].as_array()?;
    if !(1..=3).contains(&questions.len()) {
        return None;
    }
    let mut ids = BTreeSet::new();
    let mut normalized = Vec::new();
    for q in questions {
        let id = identifier(&q["id"])?;
        if !ids.insert(id.clone()) {
            return None;
        }
        let options = q["options"].as_array()?;
        if !(2..=3).contains(&options.len()) {
            return None;
        }
        let mut option_ids = BTreeSet::new();
        let mut normalized_options = Vec::new();
        for o in options {
            let id = identifier(&o["id"])?;
            if !option_ids.insert(id.clone()) {
                return None;
            }
            let mut value = json!({"id":id,"label":bounded(&o["label"],1,80)?});
            if o.get("description").is_some() {
                value["description"] = json!(bounded(&o["description"], 1, 220)?)
            }
            if let Some(v) = o.get("recommended") {
                value["recommended"] = json!(v.as_bool()?)
            }
            normalized_options.push(value);
        }
        let mut value =
            json!({"id":id,"question":bounded(&q["question"],1,240)?,"options":normalized_options});
        if q.get("header").is_some() {
            value["header"] = json!(bounded(&q["header"], 1, 32)?)
        }
        if let Some(v) = q.get("selectionMode") {
            if !matches!(v.as_str(), Some("single" | "multiple")) {
                return None;
            }
            value["selectionMode"] = v.clone()
        }
        if let Some(v) = q.get("allowFreeform") {
            value["allowFreeform"] = json!(v.as_bool()?)
        }
        normalized.push(value);
    }
    Some(json!({"questions":normalized}))
}
fn issue_proposal(payload: &Value) -> Option<Value> {
    let raw = payload
        .get("issueProposal")
        .filter(|v| v.is_object())
        .unwrap_or(payload);
    let mut value = json!({"title":bounded(&raw["title"],1,200)?,"description":bounded(&raw["description"],1,20000)?,"status":"todo","priority":"medium"});
    for key in ["status", "priority"] {
        if let Some(v) = raw.get(key) {
            let text = v.as_str()?;
            if !(if key == "status" {
                [
                    "backlog",
                    "todo",
                    "in_progress",
                    "in_review",
                    "blocked",
                    "done",
                    "cancelled",
                ]
                .contains(&text)
            } else {
                ["critical", "high", "medium", "low"].contains(&text)
            }) {
                return None;
            }
            value[key] = v.clone()
        }
    }
    for key in [
        "projectId",
        "goalId",
        "parentId",
        "assigneeAgentId",
        "assigneeUserId",
        "assigneeUnassignedReason",
        "reviewerAgentId",
        "reviewerUserId",
    ] {
        if let Some(v) = raw.get(key) {
            if v.is_null() {
                value[key] = Value::Null
            } else {
                value[key] = json!(v.as_str()?.trim())
            }
        }
    }
    if let Some(labels) = raw.get("labelIds") {
        let labels = labels.as_array()?;
        if labels
            .iter()
            .any(|v| v.as_str().is_none_or(|v| Uuid::parse_str(v).is_err()))
        {
            return None;
        }
        value["labelIds"] = json!(labels)
    }
    let owner = ["assigneeAgentId", "assigneeUserId"]
        .iter()
        .any(|k| value[*k].as_str().is_some_and(|v| !v.is_empty()));
    let reason = bounded(&value["assigneeUnassignedReason"], 1, 500).is_some();
    (owner != reason).then_some(value)
}
fn parse_reply(raw: &str, run: &str) -> std::result::Result<Reply, String> {
    if let Some(start) = raw.find("RUDDER_RESULT_BEGIN") {
        let body = &raw[start + "RUDDER_RESULT_BEGIN".len()..];
        if let Some(end) = body.find("RUDDER_RESULT_END") {
            let body = body[..end].trim();
            if !body.is_empty() {
                return Ok(Reply {
                    kind: "message".into(),
                    body: body.into(),
                    payload: Value::Null,
                });
            }
        }
    }
    let sentinel = format!("__RUDDER_RESULT_{run}__");
    let (json, visible) = match raw.find(&sentinel) {
        Some(i) => (object(&raw[i + sentinel.len()..]), raw[..i].trim()),
        None => (None, raw.trim()),
    };
    if raw.contains(&sentinel) && json.is_none() {
        return Err(
            "Chat adapter emitted the Rudder result sentinel without a valid JSON payload".into(),
        );
    }
    let Some(value) = json else {
        if visible.is_empty() {
            return Err("Chat adapter returned no assistant text".into());
        }
        return Ok(Reply {
            kind: "message".into(),
            body: visible.into(),
            payload: Value::Null,
        });
    };
    let kind = value["kind"].as_str().unwrap_or("message");
    if ![
        "message",
        "ask_user",
        "issue_proposal",
        "operation_proposal",
        "automation_create",
    ]
    .contains(&kind)
    {
        return Err(format!("Unsupported assistant result kind: {kind}"));
    }
    let body = value["body"]
        .as_str()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or(visible);
    if body.is_empty() {
        return Err("Assistant response body was empty".into());
    }
    if body.contains(&sentinel) || body.contains("Rudder internal repair request:") {
        return Err("Assistant response leaked internal result protocol text".into());
    }
    let mut payload = value["structuredPayload"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    for key in ["inlineVisuals", "inlineVisualsV1", "inlineAnnotations"] {
        payload.remove(key);
    }
    let request = ask_request(&json!(payload));
    payload.remove("requestUserInput");
    if let Some(v) = request.as_ref() {
        payload.insert("requestUserInput".into(), v.clone());
    }
    if kind == "ask_user" && request.is_none() {
        if value.get("structuredPayload").is_some_and(|v| !v.is_null()) {
            return Err("ask_user assistant responses require structuredPayload.requestUserInput with 1-3 valid questions".into());
        }
        return Ok(Reply {
            kind: "message".into(),
            body: body.into(),
            payload: Value::Null,
        });
    }
    if kind == "issue_proposal" && issue_proposal(&json!(payload)).is_none() {
        return Err("issue_proposal assistant responses require structuredPayload.issueProposal with title, description, and an explicit owner decision".into());
    }
    Ok(Reply {
        kind: if kind == "automation_create" {
            "message"
        } else {
            kind
        }
        .into(),
        body: body.into(),
        payload: json!(payload),
    })
}

fn has_result_envelope(raw: &str, run: &str) -> bool {
    if raw.contains(&format!("__RUDDER_RESULT_{run}__")) {
        return true;
    }
    raw.find("RUDDER_RESULT_BEGIN").is_some_and(|start| {
        let body = &raw[start + "RUDDER_RESULT_BEGIN".len()..];
        body.find("RUDDER_RESULT_END")
            .is_some_and(|end| !body[..end].trim().is_empty())
    })
}
fn safe_plain_fallback(raw: &str, run: &str) -> bool {
    !raw.trim().is_empty()
        && !raw.contains(&format!("__RUDDER_RESULT_{run}__"))
        && !raw.contains("Rudder internal repair request:")
}

pub async fn reconcile_chat_outputs(
    pool: &PgPool,
    storage: Option<&dyn IssueAssetStorage>,
    attachment_max_bytes: f64,
) -> Result<u64> {
    let runs=sqlx::query_as::<_,(String,String)>("SELECT h.org_id::text,h.id::text FROM automation_runs ar JOIN chat_generations g ON g.org_id=ar.org_id AND g.conversation_id=ar.linked_chat_conversation_id AND g.source_message_id=ar.started_chat_message_id JOIN heartbeat_runs h ON h.org_id=g.org_id AND h.chat_generation_id=g.id WHERE ar.status='running' AND h.context_snapshot->>'automationRunId'=ar.id::text AND h.status IN ('succeeded','failed','cancelled','timed_out') AND NOT h.native_admission_hold AND NOT g.native_admission_hold AND g.runtime_terminal_at IS NOT NULL ORDER BY ar.updated_at LIMIT 200").fetch_all(pool).await?;
    let count = runs.len() as u64;
    for (org, run) in runs {
        let mut tx = pool.begin().await?;
        settle_output(&mut tx, &org, &run, storage, attachment_max_bytes).await?;
        super::terminal::sync_chat_run(&mut tx, &org, &run).await?;
        tx.commit().await?;
    }
    Ok(count)
}
async fn settle_output(
    tx: &mut Tx<'_>,
    org: &str,
    run: &str,
    storage: Option<&dyn IssueAssetStorage>,
    attachment_max_bytes: f64,
) -> Result<()> {
    let row=sqlx::query("SELECT ar.id::text AS automation_run_id,ar.automation_id::text,d.title,h.agent_id::text,h.status,h.error,h.context_snapshot,(extract(epoch FROM h.started_at)*1000)::bigint AS started_ms,(extract(epoch FROM h.finished_at)*1000)::bigint AS ended_ms,(SELECT checkpoint_json->>'threadId' FROM heartbeat_run_attempts a WHERE a.org_id=h.org_id AND a.run_id=h.id ORDER BY a.attempt_index DESC LIMIT 1) AS thread_id,g.conversation_id::text,g.source_message_id::text FROM heartbeat_runs h JOIN chat_generations g ON g.org_id=h.org_id AND g.id=h.chat_generation_id JOIN automation_runs ar ON ar.org_id=h.org_id AND ar.linked_chat_conversation_id=g.conversation_id AND ar.started_chat_message_id=g.source_message_id JOIN automations d ON d.org_id=ar.org_id AND d.id=ar.automation_id WHERE h.org_id=$1::uuid AND h.id=$2::uuid AND ar.status='running' AND h.context_snapshot->>'automationRunId'=ar.id::text AND h.status IN ('succeeded','failed','cancelled','timed_out') AND NOT h.native_admission_hold AND NOT g.native_admission_hold AND g.runtime_terminal_at IS NOT NULL FOR UPDATE OF ar,h")
        .bind(org).bind(run).fetch_optional(&mut **tx).await?;
    let Some(row) = row else { return Ok(()) };
    let snapshot: Value = row.try_get("context_snapshot")?;
    if snapshot["automationOutputSettled"] == true {
        return Ok(());
    }
    let automation_run: String = row.try_get("automation_run_id")?;
    let automation: String = row.try_get("automation_id")?;
    let title: String = row.try_get("title")?;
    let conversation: String = row.try_get("conversation_id")?;
    let agent: String = row.try_get("agent_id")?;
    let mut status: String = row.try_get("status")?;
    let message=sqlx::query("SELECT id::text,body,status FROM chat_messages WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND run_id=$3::uuid AND role='assistant' AND superseded_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE")
        .bind(org).bind(&conversation).bind(run).fetch_optional(&mut **tx).await?;
    let (message, raw) = if let Some(row) = message {
        (
            row.try_get::<String, _>("id")?,
            row.try_get::<String, _>("body")?,
        )
    } else {
        let message:String=sqlx::query_scalar("INSERT INTO chat_messages(org_id,conversation_id,role,kind,status,body,run_id,replying_agent_id,chat_turn_id,turn_variant) SELECT m.org_id,m.conversation_id,'assistant','message','failed','Automation chat run failed before it produced a final response.',$3::uuid,$4::uuid,m.chat_turn_id,m.turn_variant FROM chat_messages m WHERE m.org_id=$1::uuid AND m.id=$2::uuid RETURNING id::text")
            .bind(org).bind(row.try_get::<String,_>("source_message_id")?).bind(run).bind(&agent).fetch_one(&mut **tx).await?;
        (
            message,
            "Automation chat run failed before it produced a final response.".into(),
        )
    };
    let repair_attempted = snapshot["nativeChatRepairAttempted"] == true;
    let repair_envelope = status == "succeeded"
        && has_result_envelope(&raw, &automation_run)
        && parse_reply(&raw, &automation_run).is_ok();
    let original = snapshot["nativeChatRepair"]["originalText"]
        .as_str()
        .filter(|text| safe_plain_fallback(text, &automation_run));
    let fallback_accepted =
        repair_attempted && !repair_envelope && status != "cancelled" && original.is_some();
    let raw = if fallback_accepted {
        status = "succeeded".into();
        original.expect("checked original fallback").to_owned()
    } else {
        raw
    };
    let mut failure = if matches!(status.as_str(), "failed" | "timed_out") {
        Some(
            row.try_get::<Option<String>, _>("error")?
                .unwrap_or_else(|| {
                    "Automation chat run failed before it produced a final response.".into()
                }),
        )
    } else {
        None
    };
    let mut reply = if status == "succeeded" {
        match parse_reply(&raw, &automation_run) {
            Ok(v) => v,
            Err(error) => {
                failure = Some(error);
                Reply {
                    kind: "message".into(),
                    body: raw.clone(),
                    payload: json!({}),
                }
            }
        }
    } else {
        Reply {
            kind: "message".into(),
            body: raw.clone(),
            payload: json!({}),
        }
    };
    if !reply.payload.is_object() {
        reply.payload = json!({})
    }
    let mut approval = None;
    if failure.is_none()
        && status == "succeeded"
        && ["issue_proposal", "operation_proposal"].contains(&reply.kind.as_str())
    {
        let (kind, payload) = if reply.kind == "issue_proposal" {
            (
                "chat_issue_creation",
                json!({"chatConversationId":conversation,"proposedByAgentId":agent,"proposedIssue":issue_proposal(&reply.payload)}),
            )
        } else {
            let proposal = reply
                .payload
                .get("operationProposal")
                .filter(|v| v.is_object())
                .unwrap_or(&reply.payload);
            (
                "chat_operation",
                json!({"chatConversationId":conversation,"proposedByAgentId":agent,"operationProposal":proposal}),
            )
        };
        approval=Some(sqlx::query_scalar::<_,String>("INSERT INTO approvals(org_id,type,status,payload) VALUES($1::uuid,$2,'pending',$3) RETURNING id::text").bind(org).bind(kind).bind(payload).fetch_one(&mut **tx).await?);
        if reply.kind == "operation_proposal" {
            reply.payload["operationProposalState"] = json!({"status":"pending","decisionNote":null,"decidedByUserId":null,"decidedAt":null})
        }
    }
    if failure.is_none() && status == "succeeded" {
        let mut files = snapshot["automationGeneratedAttachments"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let (codex_files, mut codex_mappings) =
            if snapshot["automationArtifactSource"]["runtimeType"] == "codex_local" {
                visuals::capture_codex(
                    &reply.body,
                    snapshot["automationArtifactSource"]["codexHome"].as_str(),
                    row.try_get::<Option<String>, _>("thread_id")?.as_deref(),
                    row.try_get("started_ms")?,
                    row.try_get::<Option<i64>, _>("ended_ms")?
                        .unwrap_or(row.try_get("started_ms")?),
                )
            } else {
                (Vec::new(), Vec::new())
            };
        let (body, visual_files, mut mappings) =
            visuals::capture(&reply.body, codex_mappings.len());
        files.extend(codex_files);
        reply.body = body;
        if reply.kind == "message" {
            files.extend(visual_files);
        } else {
            mappings.clear();
            for slot in 0..3 {
                reply.body = reply
                    .body
                    .replace(&format!("::rudder-inline-vis{{slot=\"{slot}\"}}"), "");
            }
        }
        for file in &files {
            match store_file(
                tx,
                storage,
                org,
                &conversation,
                &message,
                &agent,
                file,
                attachment_max_bytes,
            )
            .await?
            {
                Ok(receipt) => {
                    if file["source"] == "codex_inline_visual" {
                        if let Some(mapping) = codex_mappings
                            .iter_mut()
                            .find(|v| v["directiveIndex"] == file["directiveIndex"])
                        {
                            mapping["status"] = json!("ready");
                            mapping["attachmentId"] = receipt["attachmentId"].clone();
                        }
                    }
                    if file["source"] == "rudder_inline_visual" {
                        if let Some(mapping) =
                            mappings.iter_mut().find(|v| v["slot"] == file["slot"])
                        {
                            mapping["status"] = json!("ready");
                            mapping["attachmentId"] = receipt["attachmentId"].clone();
                            mapping["contentType"] = json!("text/html");
                            mapping["byteSize"] = receipt["byteSize"].clone();
                            mapping["sha256"] = receipt["sha256"].clone();
                        }
                    }
                }
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            }
        }
        if !codex_mappings.is_empty() {
            reply.payload["inlineVisuals"] = json!(codex_mappings);
        }
        if !mappings.is_empty() {
            reply.payload["inlineVisualsV1"] = json!(mappings);
        }
    }
    let result_status = if failure.is_some() || status != "succeeded" {
        "failed"
    } else {
        "completed"
    };
    if let Some(error) = failure.as_ref() {
        reply.kind = "message".into();
        reply.payload = json!({"eventType":"automation_chat_run_result","automationId":automation,"automationTitle":title,"runId":automation_run,"status":"failed","failureReason":error,"links":{"automation":format!("/automations/{automation}"),"chat":format!("/messenger/chat/{conversation}")}})
    } else {
        reply.payload["automationChatRun"] = json!({"automationId":automation,"automationTitle":title,"runId":automation_run,"status":if status=="cancelled"{"stopped"}else{result_status},"links":{"automation":format!("/automations/{automation}"),"chat":format!("/messenger/chat/{conversation}")}})
    }
    sqlx::query(
        "SELECT set_config('rudder.native_chat_write','native_chat:automation_output',true)",
    )
    .execute(&mut **tx)
    .await?;
    sqlx::query("UPDATE chat_messages SET kind=$4,status=$5,body=$6,structured_payload=$7,approval_id=$8::uuid,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND id=$3::uuid")
        .bind(org).bind(&conversation).bind(&message).bind(&reply.kind).bind(if status=="cancelled"&&failure.is_none(){"stopped"}else{result_status}).bind(reply.body).bind(reply.payload).bind(approval).execute(&mut **tx).await?;
    sqlx::query("UPDATE heartbeat_runs SET context_snapshot=(context_snapshot-'automationGeneratedAttachments')||$3::jsonb WHERE org_id=$1::uuid AND id=$2::uuid").bind(org).bind(run).bind(json!({"automationOutputSettled":true,"automationOutputFailure":failure,"automationOutputFallbackAccepted":fallback_accepted})).execute(&mut **tx).await?;
    Ok(())
}
async fn store_file(
    tx: &mut Tx<'_>,
    storage: Option<&dyn IssueAssetStorage>,
    org: &str,
    conversation: &str,
    message: &str,
    agent: &str,
    file: &Value,
    attachment_max_bytes: f64,
) -> Result<std::result::Result<Value, String>> {
    let Some(storage) = storage else {
        return Ok(Err("Attachment storage is unavailable".into()));
    };
    let Some(encoded) = file["bodyBase64"].as_str() else {
        return Ok(Err("Generated attachment data is unavailable".into()));
    };
    let body = match decode_attachment(encoded, attachment_max_bytes) {
        Ok(body) => body,
        Err(error) => return Ok(Err(error)),
    };
    let name = file["originalFilename"]
        .as_str()
        .unwrap_or("generated-image.png");
    let content_type = file["contentType"].as_str().unwrap_or("image/png");
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "._-".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let key = format!(
        "{org}/chats/{conversation}/generated/{}-{safe}",
        Uuid::new_v4()
    );
    if let Err(error) = storage.put_object(org, &key, content_type, &body).await {
        return Ok(Err(error));
    }
    let asset:String=sqlx::query_scalar("INSERT INTO assets(org_id,provider,object_key,content_type,byte_size,sha256,original_filename,created_by_agent_id) VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8::uuid) RETURNING id::text")
        .bind(org).bind(storage.provider()).bind(key).bind(content_type).bind(body.len() as i32).bind(format!("{:x}",Sha256::digest(&body))).bind(name).bind(agent).fetch_one(&mut **tx).await?;
    let attachment:String=sqlx::query_scalar("INSERT INTO chat_attachments(org_id,conversation_id,message_id,asset_id) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid) RETURNING id::text").bind(org).bind(conversation).bind(message).bind(asset).fetch_one(&mut **tx).await?;
    Ok(Ok(
        json!({"attachmentId":attachment,"byteSize":body.len(),"sha256":format!("{:x}",Sha256::digest(&body))}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_configured_attachment_limit_accepts_ten_mib_and_rejects_oversize() {
        let limit = 10 * 1024 * 1024;
        for size in [12, limit - 1, limit] {
            let encoded = STANDARD.encode(vec![0u8; size]);
            assert_eq!(
                decode_attachment(&encoded, limit as f64).unwrap().len(),
                size
            );
        }
        assert!(decode_attachment(&STANDARD.encode(vec![0u8; limit + 1]), limit as f64).is_err());
        assert!(decode_attachment(&STANDARD.encode([0u8; 2]), 1.0).is_err());
    }
    #[test]
    fn structured_results_require_the_run_sentinel_and_malformed_payload_never_becomes_plain() {
        let raw = r#"{"kind":"operation_proposal","body":"Review","structuredPayload":{"operationProposal":{"targetType":"agent"}}}"#;
        assert_eq!(parse_reply(raw, "r").unwrap().kind, "message");
        assert!(parse_reply("__RUDDER_RESULT_r__{broken", "r").is_err());
        assert!(!safe_plain_fallback(
            "Rudder internal repair request: secret protocol",
            "r"
        ));
        assert!(safe_plain_fallback("useful original answer", "r"));
        assert!(has_result_envelope(
            "RUDDER_RESULT_BEGIN\nanswer\nRUDDER_RESULT_END",
            "r"
        ));
    }
    #[test]
    fn parses_existing_plain_and_structured_results() {
        assert_eq!(
            parse_reply(
                "working\nRUDDER_RESULT_BEGIN\nAnswer\nRUDDER_RESULT_END",
                "r"
            )
            .unwrap()
            .body,
            "Answer"
        );
        let r=parse_reply("__RUDDER_RESULT_r__{\"kind\":\"operation_proposal\",\"body\":\"Review\",\"structuredPayload\":{\"operationProposal\":{\"targetType\":\"agent\"}}}","r").unwrap();
        assert_eq!(r.kind, "operation_proposal");
        assert!(
            parse_reply(
                "__RUDDER_RESULT_r__{\"kind\":\"issue_proposal\",\"body\":\"Review\",\"structuredPayload\":{}}",
                "r"
            )
            .is_err()
        );
    }
}

fn decode_attachment(encoded: &str, limit: f64) -> std::result::Result<Vec<u8>, String> {
    let body = STANDARD
        .decode(encoded)
        .map_err(|_| "Generated attachment data is invalid".to_string())?;
    if body.len() as f64 > limit {
        return Err(format!("Generated attachment exceeds {limit} bytes"));
    }
    Ok(body)
}
