use super::*;
use projection::{preview, redacted};

pub(super) async fn read(tx: &mut Tx<'_>, c: &Context<'_>, detail: bool) -> Result<Value> {
    let approvals=rows(tx,"SELECT (to_jsonb(a)||jsonb_build_object('_updatedRaw',a.updated_at))::text FROM approvals a WHERE org_id=$1::uuid ORDER BY updated_at DESC,created_at DESC",&[c.org]).await?;
    let requests=rows(tx,"SELECT (to_jsonb(r)||jsonb_build_object('_updatedRaw',r.updated_at))::text FROM requests r WHERE org_id=$1::uuid ORDER BY updated_at DESC,created_at DESC",&[c.org]).await?;
    let comments=rows(tx,"SELECT to_jsonb(m)::text FROM approval_comments m INNER JOIN approvals a ON a.id=m.approval_id AND a.org_id=m.org_id WHERE a.org_id=$1::uuid ORDER BY m.created_at DESC",&[c.org]).await?;
    let agents=rows(tx,"SELECT jsonb_build_object('id',id,'name',name,'icon',icon,'role',role)::text FROM agents WHERE org_id=$1::uuid",&[c.org]).await?;
    let last = state(tx, c, "approvals").await?["lastReadAt"].clone();
    let mut items = Vec::new();
    let mut actionable = Vec::new();
    let mut summary_unread = 0;
    for approval in &approvals {
        let comment = comments
            .iter()
            .find(|comment| comment["approvalId"] == approval["id"]);
        let requester = agent_id(approval);
        let agent = agents
            .iter()
            .find(|agent| text(agent, "id") == requester)
            .cloned()
            .unwrap_or(Value::Null);
        let item = approval_card(approval, &agent, comment, c)?;
        if approval["status"] == "pending" {
            if nanos(&approval["_updatedRaw"])
                .is_some_and(|at| millis(&last).is_none_or(|r| at > r * 1_000_000))
            {
                summary_unread += 1
            }
            actionable.push(item.clone());
        }
        items.push(item);
    }
    for request in &requests {
        let agent = agents
            .iter()
            .find(|agent| agent["id"] == request["requestedByAgentId"])
            .cloned()
            .unwrap_or(Value::Null);
        let item = assistance_card(request, agent);
        if request["status"] == "open" {
            if nanos(&request["_updatedRaw"])
                .is_some_and(|at| millis(&last).is_none_or(|r| at > r * 1_000_000))
            {
                summary_unread += 1
            }
            actionable.push(item.clone());
        }
        items.push(item);
    }
    let unread = if detail {
        unread(&actionable, &last)
    } else {
        summary_unread
    };
    let count = if detail {
        items.len()
    } else {
        actionable.len()
    };
    let mut latest_items = items.clone();
    latest_items.sort_by(|a, b| ordering::compare(c, a, b, false, false));
    let mut latest = latest_items.first().cloned();
    if !detail {
        let mut candidates = Vec::new();
        if let Some(a) = approvals.iter().find(|a| a["status"] == "pending")
            && let Some(item) = items.iter().find(|item| item["id"] == a["id"])
        {
            candidates.push(item.clone());
        }
        if let Some(comment) = comments.iter().find(|comment| {
            approvals
                .iter()
                .any(|a| a["id"] == comment["approvalId"] && a["status"] == "pending")
        }) && let Some(item) = items
            .iter()
            .find(|item| item["id"] == comment["approvalId"])
        {
            candidates.push(item.clone());
        }
        candidates.sort_by(|a, b| ordering::compare(c, a, b, false, false));
        latest = candidates.first().cloned();
        if let Some(request) = requests.iter().find(|r| r["status"] == "open")
            && latest.as_ref().is_none_or(|item| {
                millis(&request["updatedAt"]) > millis(&item["latestActivityAt"])
            })
        {
            latest = items
                .iter()
                .find(|item| item["id"] == request["id"])
                .cloned();
        }
    }
    let latest = latest.as_ref();
    let sum = summary(
        "approvals",
        "Requests",
        (count, unread),
        latest
            .map(|i| i["latestActivityAt"].clone())
            .unwrap_or(Value::Null),
        last,
        "No requests yet",
        latest.map(|i| i["preview"].clone()).unwrap_or(Value::Null),
    );
    let mut result = json!({"summary":sum,"itemCount":count});
    if detail {
        items.sort_by(|a, b| ordering::compare(c, a, b, false, true));
        result["detail"] =
            projection::detail(&sum, "Approvals and assistance needing attention", items);
        result["detail"]["preview"] = latest.map(|i| i["preview"].clone()).unwrap_or(Value::Null);
        result["detail"]["subtitle"] = json!(format!(
            "{count} request{}",
            if count == 1 { "" } else { "s" }
        ));
    }
    Ok(result)
}
fn requester(a: &Value, c: &Context<'_>) -> &'static str {
    if !text(a, "requestedByUserId").is_empty() {
        if text(a, "requestedByUserId") == c.user {
            "You"
        } else {
            "User"
        }
    } else if !text(a, "requestedByAgentId").is_empty() {
        "Agent"
    } else {
        "System"
    }
}
fn agent_id(a: &Value) -> String {
    if !text(a, "requestedByAgentId").is_empty() {
        return text(a, "requestedByAgentId").into();
    }
    if ["chat_issue_creation", "chat_operation"].contains(&text(a, "type")) {
        return a["payload"]["proposedByAgentId"]
            .as_str()
            .filter(|id| uuid::Uuid::parse_str(id.trim()).is_ok())
            .map(str::trim)
            .unwrap_or("")
            .into();
    }
    String::new()
}
fn payload_preview(a: &Value, payload: &Value) -> Value {
    let value = match text(a, "type") {
        "chat_issue_creation" => {
            let proposal = payload
                .get("proposedIssue")
                .filter(|p| p.is_object())
                .unwrap_or(payload);
            let title = text(proposal, "title").trim();
            let description = preview(Some(text(proposal, "description").trim()), 120);
            [
                if title.is_empty() {
                    "Agent proposed an issue from chat".into()
                } else {
                    format!("Issue: {title}")
                },
                description.as_str().unwrap_or("").into(),
            ]
            .into_iter()
            .filter(|v: &String| !v.is_empty())
            .collect::<Vec<_>>()
            .join(" · ")
        }
        "chat_operation" => {
            let proposal = payload
                .get("operationProposal")
                .filter(|p| p.is_object())
                .unwrap_or(payload);
            let summary = text(proposal, "summary").trim();
            if summary.is_empty() {
                "Agent proposed a chat operation".into()
            } else {
                format!(
                    "Operation: {}",
                    preview(Some(summary), 120).as_str().unwrap_or("")
                )
            }
        }
        "hire_agent" => [text(payload, "name"), text(payload, "role")]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" · "),
        "budget_override_required" => [
            text(payload, "scopeName").to_owned(),
            payload["budgetAmount"]
                .as_f64()
                .map(|n| format!("${:.2}", n / 100.0))
                .unwrap_or_default(),
        ]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" · "),
        _ => object_keys(payload)
            .into_iter()
            .take(2)
            .map(|key| {
                let value = &payload[key];
                format!(
                    "{key}: {}",
                    value
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| value.to_string())
                )
            })
            .collect::<Vec<_>>()
            .join(" · "),
    };
    if value.is_empty() {
        Value::Null
    } else {
        json!(value)
    }
}
fn approval_card(
    a: &Value,
    agent: &Value,
    comment: Option<&Value>,
    c: &Context<'_>,
) -> Result<Value> {
    let mut public_approval = a.clone();
    public_approval
        .as_object_mut()
        .unwrap()
        .remove("_updatedRaw");
    let payload = redacted(&a["payload"])?;
    let body = comment
        .map(|comment| preview(comment["body"].as_str(), 140))
        .unwrap_or_else(|| {
            a["decisionNote"]
                .as_str()
                .map(|s| json!(s))
                .unwrap_or_else(|| payload_preview(a, &payload))
        });
    let title = match text(a, "type") {
        "chat_issue_creation" => "Review proposed issue".into(),
        "chat_operation" => "Review chat operation".into(),
        other => other.replace('_', " "),
    };
    let id = text(a, "id");
    let href = format!("/messenger/approvals/{id}");
    Ok(
        json!({"id":id,"threadKey":"approvals","kind":"approvals","title":title,"subtitle":format!("{} · {}",requester(a,c),text(a,"status").replace('_'," ")),"body":body,"preview":body,"href":href,"latestActivityAt":latest(&[&a["updatedAt"],comment.map(|v|&v["createdAt"]).unwrap_or(&Value::Null)]),"actions":[action("Approve",json!(format!("/approvals/{id}/approve")),"POST"),action("Reject",json!(format!("/approvals/{id}/reject")),"POST"),action("Request changes",json!(format!("/approvals/{id}/request-revision")),"POST"),action("Expand details",json!(href),"GET"),action("Open full approval",json!(href),"GET")],"metadata":{"approvalId":id,"type":a["type"],"status":a["status"],"payload":payload,"requester":requester(a,c)},"approval":public_approval,"requestKind":"approval","requesterAgent":agent}),
    )
}
fn assistance_card(r: &Value, agent: Value) -> Value {
    let id = text(r, "id");
    let issue = text(r, "issueId");
    let href = if issue.is_empty() {
        "/messenger/approvals".into()
    } else {
        format!("/issues/{issue}")
    };
    let mut request = r.clone();
    request.as_object_mut().unwrap().remove("_updatedRaw");
    request["kind"] = json!("assistance");
    request["subtype"] = json!("issue_blocker");
    json!({"id":id,"threadKey":"approvals","kind":"approvals","requestKind":"assistance","title":r["title"],"subtitle":if r["status"]=="open"{"Waiting on you".into()}else{text(r,"status").replace('_'," ")},"body":r["prompt"],"preview":r["prompt"],"href":href,"latestActivityAt":r["updatedAt"],"actions":if issue.is_empty(){vec![]}else{vec![action("Open issue",json!(href),"GET")]},"metadata":{"requestId":id,"requestKind":"assistance","subtype":r["subtype"],"status":r["status"],"issueId":r["issueId"]},"assistanceRequest":request,"requesterAgent":agent})
}
