use super::*;
use std::collections::HashMap;
fn component(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
pub(super) struct Hydration {
    tables: HashMap<&'static str, HashMap<String, Value>>,
}
fn optional(v: &Value, key: &str) -> Option<String> {
    string(v, key).filter(|s| !s.trim().is_empty())
}
fn canonical(r: &Value) -> Value {
    let snapshot = &r["contextSnapshot"];
    let get = |key| optional(snapshot, key);
    let conversation = optional(r, "chatConversationId").or_else(|| get("conversationId"));
    let invocation = text(r, "invocationSource");
    let scene = get("scene")
        .filter(|s| {
            [
                "issue",
                "chat",
                "automation",
                "review",
                "heartbeat",
                "delegation",
            ]
            .contains(&s.as_str())
        })
        .or_else(|| {
            get("rudderScene").filter(|s| {
                [
                    "issue",
                    "chat",
                    "automation",
                    "review",
                    "heartbeat",
                    "delegation",
                ]
                .contains(&s.as_str())
            })
        })
        .unwrap_or_else(|| {
            if invocation == "chat" || conversation.is_some() {
                "chat"
            } else if invocation == "review" {
                "review"
            } else if invocation == "delegation" {
                "delegation"
            } else if invocation == "timer" {
                "heartbeat"
            } else if get("automationRunId").is_some() {
                "automation"
            } else if get("issueId").is_some() {
                "issue"
            } else if invocation == "automation" {
                "automation"
            } else {
                "heartbeat"
            }
            .into()
        });
    let target = get("targetType")
        .filter(|s| {
            [
                "issue",
                "chat_conversation",
                "chat_message",
                "automation_run",
                "wakeup_request",
                "manual",
            ]
            .contains(&s.as_str())
        })
        .unwrap_or_else(|| {
            if conversation.is_some() {
                "chat_conversation"
            } else if get("automationRunId").is_some() {
                "automation_run"
            } else if get("issueId").is_some() {
                "issue"
            } else {
                "wakeup_request"
            }
            .into()
        });
    let message = get("messageId")
        .or_else(|| get("assistantMessageId"))
        .or_else(|| get("userMessageId"));
    let wakeup = optional(r, "wakeupRequestId").or_else(|| get("wakeupRequestId"));
    let target_id = get("targetId").or_else(|| match target.as_str() {
        "chat_conversation" => conversation.clone(),
        "chat_message" => message.clone(),
        "automation_run" => get("automationRunId"),
        "issue" => get("issueId"),
        "wakeup_request" => wakeup.clone(),
        _ => None,
    });
    let trigger = get("triggerKind").unwrap_or_else(|| {
        if get("commentId").is_some()
            || get("wakeSource").as_deref() == Some("issue.comment")
            || matches!(
                get("wakeReason").as_deref(),
                Some("issue_commented" | "issue_comment_mentioned")
            )
        {
            "issue_comment".into()
        } else if invocation == "review" {
            "review_routing".into()
        } else if invocation == "timer" {
            "timer".into()
        } else if invocation == "on_demand" && text(r, "triggerDetail") == "manual" {
            "manual".into()
        } else {
            string(r, "triggerDetail").unwrap_or(invocation.into())
        }
    });
    json!({"runId":r["id"],"scene":scene,"triggerKind":trigger,"targetType":target,"targetId":target_id,"invocationSource":invocation,"conversationId":conversation,"messageId":message,"issueId":get("issueId").or_else(||if target=="issue"{target_id.clone()}else{None}),"automationRunId":get("automationRunId"),"automationId":get("automationId"),"wakeupRequestId":wakeup,"sourceRunId":optional(r,"sourceRunId").or_else(||get("sourceRunId"))})
}
pub(super) async fn load(tx: &mut Tx<'_>, c: &Context<'_>, runs: &[Value]) -> Result<Hydration> {
    let origins = runs.iter().map(canonical).collect::<Vec<_>>();
    let mut tables = HashMap::new();
    for (table, key, columns, visibility) in [
        (
            "chat_conversations",
            "conversationId",
            "id,title",
            "AND (conversation_kind<>'side_chat' OR created_by_user_id=$2)",
        ),
        ("chat_messages", "messageId", "id,conversation_id", ""),
        ("issues", "issueId", "id,identifier,title,status", ""),
        ("automation_runs", "automationRunId", "id,automation_id", ""),
        (
            "agent_wakeup_requests",
            "wakeupRequestId",
            "id,source,trigger_detail,reason",
            "",
        ),
    ] {
        let ids = origins
            .iter()
            .filter_map(|o| string(o, key))
            .collect::<Vec<_>>();
        let ids = json!(ids).to_string();
        let sql = format!(
            "SELECT to_jsonb(selected)::text FROM (SELECT {columns} FROM {table} WHERE org_id=$1::uuid AND ($2::text IS NOT NULL) AND id::text IN (SELECT jsonb_array_elements_text($3::jsonb)) {visibility}) selected"
        );
        let selected = rows(tx, &sql, &[c.org, c.user, &ids]).await?;
        tables.insert(
            table,
            selected
                .into_iter()
                .map(|row| (text(&row, "id").to_owned(), row))
                .collect(),
        );
    }
    let mut automations = origins
        .iter()
        .filter_map(|o| string(o, "automationId"))
        .collect::<Vec<_>>();
    if let Some(runs) = tables.get("automation_runs") {
        automations.extend(runs.values().filter_map(|r| string(r, "automationId")));
    }
    let ids = json!(automations).to_string();
    let selected=rows(tx,"SELECT jsonb_build_object('id',id,'title',title,'status',status)::text FROM automations WHERE org_id=$1::uuid AND id::text IN (SELECT jsonb_array_elements_text($2::jsonb))",&[c.org,&ids]).await?;
    tables.insert(
        "automations",
        selected
            .into_iter()
            .map(|r| (text(&r, "id").into(), r))
            .collect(),
    );
    Ok(Hydration { tables })
}
impl Hydration {
    fn get(&self, table: &str, id: &Value) -> Option<&Value> {
        self.tables.get(table)?.get(id.as_str()?)
    }
}
pub(super) fn read(c: &Context<'_>, r: &Value, agent: Option<&Value>, h: &Hydration) -> Value {
    let origin = canonical(r);
    let mut result = json!({"runId":origin["runId"],"scene":origin["scene"],"targetType":origin["targetType"],"targetId":null,"triggerKind":origin["triggerKind"],"invocationSource":origin["invocationSource"],"conversationId":null,"messageId":null,"issueId":null,"automationRunId":null,"automationId":null,"wakeupRequestId":null,"sourceRunId":origin["sourceRunId"],"targetLabel":null,"targetStatus":null,"sourceState":"legacy_unknown","source":{"kind":"unavailable","state":"legacy_unknown"}});
    let unavailable = |mut result: Value| {
        result["sourceState"] = json!("source_unavailable");
        result["source"] = json!({"kind":"unavailable","state":"source_unavailable"});
        result
    };
    match text(&origin, "scene") {
        "chat" => {
            if origin["conversationId"].is_null() || origin["messageId"].is_null() {
                return result;
            }
            let Some(conversation) = h.get("chat_conversations", &origin["conversationId"]) else {
                return unavailable(result);
            };
            let Some(message) = h
                .get("chat_messages", &origin["messageId"])
                .filter(|m| m["conversationId"] == origin["conversationId"])
            else {
                return unavailable(result);
            };
            result["targetId"] = if text(&origin, "targetType") == "chat_conversation" {
                origin["conversationId"].clone()
            } else if text(&origin, "targetType") == "chat_message" {
                origin["messageId"].clone()
            } else {
                Value::Null
            };
            result["conversationId"] = origin["conversationId"].clone();
            result["messageId"] = message["id"].clone();
            result["targetLabel"] = conversation["title"].clone();
            result["sourceState"] = json!("available");
            result["source"] = json!({"kind":"chat","title":conversation["title"],"href":format!("/messenger/chat/{}?messageId={}",text(&origin,"conversationId"),component(text(&origin,"messageId")))});
        }
        "issue" | "review" => {
            if origin["issueId"].is_null() {
                return result;
            }
            let Some(issue) = h.get("issues", &origin["issueId"]) else {
                return unavailable(result);
            };
            let reference = issue["identifier"]
                .as_str()
                .unwrap_or(text(&origin, "issueId"));
            result["targetId"] = if text(&origin, "targetType") == "issue" {
                origin["issueId"].clone()
            } else {
                Value::Null
            };
            result["issueId"] = origin["issueId"].clone();
            result["targetLabel"] = json!(
                issue["identifier"]
                    .as_str()
                    .map(|id| format!("{id} · {}", text(issue, "title")))
                    .unwrap_or_else(|| text(issue, "title").into())
            );
            result["targetStatus"] = issue["status"].clone();
            result["sourceState"] = json!("available");
            result["source"] = json!({"kind":origin["scene"],"identifier":issue["identifier"],"title":issue["title"],"status":issue["status"],"href":format!("/issues/{}",component(reference))});
        }
        "automation" => {
            if origin["automationRunId"].is_null() {
                return result;
            }
            let Some(run) = h.get("automation_runs", &origin["automationRunId"]) else {
                return unavailable(result);
            };
            if !origin["automationId"].is_null() && origin["automationId"] != run["automationId"] {
                return unavailable(result);
            }
            let automation_id = if origin["automationId"].is_null() {
                run["automationId"].clone()
            } else {
                origin["automationId"].clone()
            };
            let Some(automation) = h.get("automations", &automation_id) else {
                return unavailable(result);
            };
            result["targetId"] = if text(&origin, "targetType") == "automation_run" {
                origin["automationRunId"].clone()
            } else {
                Value::Null
            };
            result["automationRunId"] = origin["automationRunId"].clone();
            result["automationId"] = automation_id.clone();
            result["targetLabel"] = automation["title"].clone();
            result["targetStatus"] = automation["status"].clone();
            result["sourceState"] = json!("available");
            result["source"] = json!({"kind":"automation","title":automation["title"],"status":automation["status"],"href":format!("/automations/{}",component(automation_id.as_str().unwrap_or_default()))});
        }
        _ => {
            let explicit = r["contextSnapshot"]["scene"] == "heartbeat"
                || r["contextSnapshot"]["rudderScene"] == "heartbeat";
            let timer = r["invocationSource"] == "timer";
            let manual = r["invocationSource"] == "on_demand"
                && (r["triggerDetail"] == "manual" || origin["triggerKind"] == "manual");
            if !explicit && !timer && !manual {
                return result;
            }
            if origin["wakeupRequestId"].is_null() {
                return result;
            }
            if h.get("agent_wakeup_requests", &origin["wakeupRequestId"])
                .is_none()
                || agent.is_none()
            {
                return unavailable(result);
            }
            result["targetId"] = if text(&origin, "targetType") == "wakeup_request" {
                origin["wakeupRequestId"].clone()
            } else {
                Value::Null
            };
            result["wakeupRequestId"] = origin["wakeupRequestId"].clone();
            result["targetLabel"] = json!(if timer {
                "Timer self-check"
            } else if manual {
                "Manual heartbeat"
            } else {
                "Heartbeat wakeup"
            });
            result["sourceState"] = json!("available");
            result["source"] = json!({"kind":"heartbeat","agent":agent,"href":format!("/agents/{}",component(text(r,"agentId")))});
        }
    }
    let _ = c;
    result
}
