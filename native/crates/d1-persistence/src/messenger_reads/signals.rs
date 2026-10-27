use super::*;
mod origin;
const FAILURE: &str = "The run hit a system-level execution problem. Rudder saved the technical details for diagnostics.";
pub(super) async fn read(
    tx: &mut Tx<'_>,
    c: &Context<'_>,
    kind: &str,
    detail: bool,
) -> Result<Value> {
    if !["failed-runs", "budget-alerts", "join-requests"].contains(&kind) {
        return Err(http(404, "Messenger system thread not found"));
    }
    let last = state(tx, c, kind).await?["lastReadAt"].clone();
    let (mut items, summary_count, detail_count, title, empty, description) = match kind {
        "failed-runs" => {
            let visibility = crate::run_visibility::predicate("r", 2);
            let runs=rows(tx,&format!("SELECT (to_jsonb(r)||jsonb_build_object('agent_issue_creation_request_id',q.id,'agent_issue_creation_requested_by_user_id',q.requested_by_user_id,'agent_issue_creation_error',q.error))::text FROM heartbeat_runs r LEFT JOIN agent_issue_creation_requests q ON q.org_id=r.org_id AND q.run_id=r.id WHERE r.org_id=$1::uuid AND r.status='failed' AND {visibility} ORDER BY r.updated_at DESC,r.created_at DESC"),&[c.org,c.user]).await?;
            let requests=rows(tx,&format!("SELECT to_jsonb(q)::text FROM agent_issue_creation_requests q WHERE q.org_id=$1::uuid AND q.requested_by_user_id=$2 AND q.status IN ('failed','cancelled') AND q.created_issue_id IS NULL AND (q.run_id IS NULL OR EXISTS(SELECT 1 FROM heartbeat_runs r WHERE r.org_id=q.org_id AND r.id=q.run_id AND {visibility})) ORDER BY q.updated_at DESC,q.created_at DESC"),&[c.org,c.user]).await?;
            let agents=rows(tx,"SELECT jsonb_build_object('id',id,'name',name,'icon',icon,'role',role,'status',status,'title',title)::text FROM agents WHERE org_id=$1::uuid",&[c.org]).await?;
            let origins = origin::load(tx, c, &runs).await?;
            let mut items = Vec::new();
            for run in &runs {
                let agent = agents.iter().find(|a| a["id"] == run["agentId"]);
                items.push(failed_card(c, run, agent, &origins));
            }
            for request in requests.iter().filter(|q| {
                !runs
                    .iter()
                    .any(|r| r["agentIssueCreationRequestId"] == q["id"])
            }) {
                let agent = agents.iter().find(|a| a["id"] == request["agentId"]);
                items.push(request_card(c, request, agent));
            }
            let count = items.len();
            (
                items,
                count,
                runs.len(),
                "Failed runs",
                "No failed runs yet",
                "Recent failed agent runs",
            )
        }
        "budget-alerts" => {
            let now = time::OffsetDateTime::now_utc();
            let month = time::Date::from_calendar_date(now.year(), now.month(), 1)
                .map_err(|_| http(500, "Internal server error"))?;
            let next = time::Date::from_calendar_date(
                now.year() + i32::from(now.month() == time::Month::December),
                now.month().next(),
                1,
            )
            .map_err(|_| http(500, "Internal server error"))?;
            let response = crate::overview_reads::budget_overview(
                tx,
                c.org,
                month.midnight().assume_utc().unix_timestamp() * 1000,
                next.midnight().assume_utc().unix_timestamp() * 1000,
            )
            .await
            .map_err(|error| match error {
                crate::overview_reads::OverviewReadError::MissingScope(scope) => {
                    http(404, &format!("{scope} not found"))
                }
                _ => http(500, "Internal server error"),
            })?;
            let items = response["activeIncidents"]
                .as_array()
                .into_iter()
                .flatten()
                .map(budget_card)
                .collect::<Vec<_>>();
            let count = items.len();
            (
                items,
                count,
                count,
                "Budget alerts",
                "No budget alerts yet",
                "Open budget incidents",
            )
        }
        _ => {
            let requests=rows(tx,"SELECT to_jsonb(q)::text FROM join_requests q WHERE org_id=$1::uuid AND status='pending_approval' ORDER BY updated_at DESC,created_at DESC",&[c.org]).await?;
            let items = requests.iter().map(join_card).collect::<Vec<_>>();
            let count = items.len();
            (
                items,
                count,
                count,
                "Join requests",
                "No pending join requests",
                "Pending organization join requests",
            )
        }
    };
    let unread = unread(&items, &last);
    let latest = if kind == "budget-alerts" || kind == "join-requests" {
        items.first().cloned()
    } else {
        let mut latest = items.clone();
        latest.sort_by(|a, b| {
            if detail {
                ordering::compare(c, a, b, false, false)
            } else {
                millis(&b["latestActivityAt"]).cmp(&millis(&a["latestActivityAt"]))
            }
        });
        latest.first().cloned()
    };
    let preview = latest
        .as_ref()
        .map(|i| i["preview"].clone())
        .unwrap_or(Value::Null);
    let at = latest
        .as_ref()
        .map(|i| i["latestActivityAt"].clone())
        .unwrap_or(Value::Null);
    let summary = summary(
        kind,
        title,
        if detail { detail_count } else { summary_count },
        at,
        last,
        unread,
        empty,
        preview,
    );
    let mut result = json!({"summary":summary,"itemCount":summary_count});
    if detail {
        if kind == "failed-runs" {
            items.sort_by(|a, b| ordering::compare(c, a, b, false, true));
        }
        let mut detail = projection::detail(&summary, description, items);
        detail["preview"] = latest
            .as_ref()
            .map(|i| i["preview"].clone())
            .unwrap_or(Value::Null);
        detail["subtitle"] = json!(match kind {
            "failed-runs" => format!(
                "{detail_count} recent failure{}",
                if detail_count == 1 { "" } else { "s" }
            ),
            "budget-alerts" => format!(
                "{detail_count} active alert{}",
                if detail_count == 1 { "" } else { "s" }
            ),
            _ => format!(
                "{detail_count} pending request{}",
                if detail_count == 1 { "" } else { "s" }
            ),
        });
        result["detail"] = detail;
    }
    Ok(result)
}
fn coalesce_at(value: &Value) -> Value {
    value["updatedAt"]
        .as_str()
        .or_else(|| value["createdAt"].as_str())
        .map(|v| json!(v))
        .unwrap_or(Value::Null)
}
fn failed_card(
    c: &Context<'_>,
    r: &Value,
    agent: Option<&Value>,
    origins: &origin::Hydration,
) -> Value {
    let request = text(r, "agentIssueCreationRequestId");
    let agent_name = agent.map(|a| text(a, "name")).filter(|s| !s.is_empty());
    let summary = r["resultJson"]["userMessage"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(FAILURE);
    let summary = if request.is_empty() {
        summary.into()
    } else {
        format!("Agent Issue creation failed. {summary}")
    };
    let retry = !request.is_empty() && text(r, "agentIssueCreationRequestedByUserId") == c.user;
    let origin = origin::read(c, r, agent, origins);
    let mut actions = Vec::new();
    if request.is_empty() {
        actions.push(action(
            "Retry",
            json!(format!("/agent-runs/{}/retry", text(r, "id"))),
            "POST",
        ))
    } else if retry {
        actions.push(action(
            "Retry Agent Issue",
            json!(format!(
                "/orgs/{}/agent-issue-creation-requests/{request}/retry",
                c.org
            )),
            "POST",
        ))
    }
    if origin["source"]["kind"] != "unavailable" {
        let label = match text(&origin["source"], "kind") {
            "chat" => "Open chat message",
            "issue" => "Open issue",
            "review" => "Open review",
            "automation" => "Open automation",
            _ => "Open agent",
        };
        actions.push(action(label, origin["source"]["href"].clone(), "GET"));
    }
    let href = format!("/agents/{}/runs/{}", text(r, "agentId"), text(r, "id"));
    actions.push(action("Open run", json!(href), "GET"));
    let suffix = if request.is_empty() {
        "Failed run"
    } else {
        "Agent Issue creation failed"
    };
    let title = agent_name
        .map(|name| format!("{name} · {suffix}"))
        .unwrap_or(suffix.into());
    let mut metadata = json!({"runId":r["id"],"agentId":r["agentId"],"status":r["status"]});
    if !request.is_empty() {
        metadata["agentIssueCreationRequestId"] = json!(request);
        metadata["agentIssueCreationRetryable"] = json!(retry);
        metadata["agentIssueCreationError"] = r["agentIssueCreationError"].clone()
    }
    json!({"id":r["id"],"threadKey":"failed-runs","kind":"failed-runs","title":title,"subtitle":if request.is_empty(){text(r,"status").replace('_'," ")}else{"Agent Issue request failed".into()},"body":summary,"preview":summary,"href":href,"latestActivityAt":coalesce_at(r),"actions":actions,"metadata":metadata,"origin":origin})
}
fn request_card(c: &Context<'_>, r: &Value, agent: Option<&Value>) -> Value {
    let summary = format!(
        "Agent Issue creation failed. {}",
        r["error"]
            .as_str()
            .unwrap_or("Agent run completed without creating an Issue")
    );
    let suffix = "Agent Issue creation failed";
    let title = agent
        .map(|a| text(a, "name"))
        .filter(|s| !s.is_empty())
        .map(|name| format!("{name} · {suffix}"))
        .unwrap_or(suffix.into());
    let href = string(r, "runId").map(|id| format!("/agents/{}/runs/{id}", text(r, "agentId")));
    let mut actions = vec![action(
        "Retry Agent Issue",
        json!(format!(
            "/orgs/{}/agent-issue-creation-requests/{}/retry",
            c.org,
            text(r, "id")
        )),
        "POST",
    )];
    if let Some(href) = &href {
        actions.push(action("Open run", json!(href), "GET"))
    }
    let mut metadata = json!({"requestId":r["id"],"agentId":r["agentId"],"status":r["status"],"agentIssueCreationRequestId":r["id"],"agentIssueCreationRetryable":true,"agentIssueCreationError":r["error"]});
    if !r["runId"].is_null() {
        metadata["runId"] = r["runId"].clone()
    }
    json!({"id":r["id"],"threadKey":"failed-runs","kind":"failed-runs","title":title,"subtitle":"Agent Issue request failed","body":summary,"preview":summary,"href":href,"latestActivityAt":coalesce_at(r),"actions":actions,"metadata":metadata})
}
fn budget_card(i: &Value) -> Value {
    json!({"id":i["id"],"threadKey":"budget-alerts","kind":"budget-alerts","title":i["scopeName"].as_str().filter(|s|!s.is_empty()).unwrap_or("Budget alert"),"subtitle":format!("{} · {}",text(i,"scopeType"),text(i,"thresholdType")),"body":format!("{} {} / {}",text(i,"metric").replace('_'," "),i["amountObserved"],i["amountLimit"]),"preview":format!("{} observed against {} limit",i["amountObserved"],i["amountLimit"]),"href":"/costs","latestActivityAt":coalesce_at(i),"actions":[action("Open budget",json!("/costs"),"GET")],"metadata":{"incidentId":i["id"],"scopeType":i["scopeType"],"scopeId":i["scopeId"],"status":i["status"],"thresholdType":i["thresholdType"]},"incident":i})
}
fn join_card(r: &Value) -> Value {
    json!({"id":r["id"],"threadKey":"join-requests","kind":"join-requests","title":r["agentName"].as_str().or_else(||r["requestEmailSnapshot"].as_str()).map(str::to_owned).unwrap_or_else(||text(r,"requestType").replace('_'," ")),"subtitle":format!("{} · {}",text(r,"status").replace('_'," "),text(r,"requestType").replace('_'," ")),"body":if !r["capabilities"].is_null()||!r["agentDefaultsPayload"].is_null(){"Join request needs approval"}else{"Join request"},"preview":r["capabilities"].as_str().map(|s|json!(s)).unwrap_or_else(||r["requestEmailSnapshot"].clone()),"href":null,"latestActivityAt":coalesce_at(r),"actions":[action("Approve",json!(format!("/orgs/{}/join-requests/{}/approve",text(r,"orgId"),text(r,"id"))),"POST"),action("Reject",json!(format!("/orgs/{}/join-requests/{}/reject",text(r,"orgId"),text(r,"id"))),"POST")],"metadata":{"requestId":r["id"],"orgId":r["orgId"],"requestType":r["requestType"],"status":r["status"]},"joinRequest":r})
}
