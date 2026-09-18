use rudder_agent_request_planner::*;
use serde_json::{Map, Value, json};

fn runtime(browser_enabled: bool) -> ManagedRuntimeIdentity {
    ManagedRuntimeIdentity {
        organization_id: Some("org /雪".into()),
        agent_id: Some("agent-1".into()),
        run_id: Some("run-1".into()),
        browser_enabled,
    }
}

fn sample(schema: &Value) -> Value {
    if schema.get("type").is_none()
        && let Some(one) = schema.get("oneOf").and_then(Value::as_array)
    {
        return sample(&one[0]);
    }
    if schema.get("type").is_none()
        && let Some(any) = schema.get("anyOf").and_then(Value::as_array)
    {
        return sample(&any[0]);
    }
    if let Some(value) = schema
        .get("enum")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
    {
        return value.clone();
    }
    if schema.get("format").and_then(Value::as_str) == Some("date-time") {
        return json!("2026-09-18T00:00:00Z");
    }
    let ty = schema
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("object");
    match ty {
        "string" => Value::String("sample 雪".into()),
        "number" | "integer" => json!(1),
        "boolean" => json!(true),
        "array" => json!([sample(&schema["items"])]),
        "object" => {
            let mut result = Map::new();
            if let Some(required) = schema.get("required").and_then(Value::as_array) {
                for key in required.iter().filter_map(Value::as_str) {
                    result.insert(key.into(), sample(&schema["properties"][key]));
                }
            }
            if let Some(choice) = schema
                .get("anyOf")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                && let Some(required) = choice.get("required").and_then(Value::as_array)
            {
                for key in required.iter().filter_map(Value::as_str) {
                    result.insert(key.into(), sample(&schema["properties"][key]));
                }
            }
            if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
                let minimum = schema
                    .get("minProperties")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                for (key, property) in properties {
                    if result.len() >= minimum {
                        break;
                    }
                    if result.contains_key(key) {
                        continue;
                    }
                    result.insert(key.clone(), sample(property));
                }
            }
            Value::Object(result)
        }
        _ => Value::Null,
    }
}

fn encode_path_segment(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(*byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn expected_path(
    capability: &Value,
    arguments: &Value,
    runtime: &ManagedRuntimeIdentity,
) -> String {
    let mut path = capability["api"]["pathTemplate"]
        .as_str()
        .unwrap()
        .to_owned();
    for (placeholder, value) in [
        (
            "orgId",
            runtime.organization_id.as_deref().unwrap_or_default(),
        ),
        ("goal", arguments["goal"].as_str().unwrap_or_default()),
        ("issue", arguments["issue"].as_str().unwrap_or_default()),
        ("comment", arguments["comment"].as_str().unwrap_or_default()),
        ("run", arguments["run"].as_str().unwrap_or_default()),
    ] {
        path = path.replace(&format!("{{{placeholder}}}"), &encode_path_segment(value));
    }
    path
}

fn assert_direct_shape(
    id: &str,
    arguments: Value,
    runtime: &ManagedRuntimeIdentity,
    method: HttpMethod,
    path: &str,
    query: &[(&str, &str)],
    body: Option<Value>,
) {
    let PlanOutcome::Direct(plan) = plan_request(id, arguments, runtime).unwrap() else {
        panic!("{id} was not direct")
    };
    assert_eq!(plan.method, method, "{id} method");
    assert_eq!(plan.path, path, "{id} path");
    assert_eq!(
        plan.query,
        query
            .iter()
            .map(|(key, value)| ((*key).into(), (*value).into()))
            .collect::<Vec<_>>(),
        "{id} query"
    );
    assert_eq!(plan.body, body, "{id} body");
}

#[test]
fn every_contract_direct_descriptor_has_a_complete_representative_plan() {
    let contract = rudder_agent_contract_core::contract();
    let direct: Vec<_> = contract["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["api"]["transport"] == "direct")
        .collect();
    assert_eq!(
        direct.len(),
        49,
        "new direct descriptors require parity coverage"
    );
    let managed_runtime = runtime(true);
    for capability in direct {
        let id = capability["id"].as_str().unwrap();
        let mut args = sample(&capability["mcp"]["inputSchema"]);
        let object = args.as_object_mut().unwrap();
        if id == "browser.locator" {
            object.insert("action".into(), json!("count"));
        }
        if id == "browser.download" {
            object.insert("mode".into(), json!("media"));
        }
        let PlanOutcome::Direct(plan) = plan_request(id, args.clone(), &managed_runtime).unwrap()
        else {
            panic!("{id} was not direct")
        };
        assert_eq!(plan.capability_id, id);
        assert_eq!(
            plan.path,
            expected_path(capability, &args, &managed_runtime),
            "{id}"
        );
        assert_eq!(
            plan.method,
            match capability["api"]["method"].as_str().unwrap() {
                "GET" => HttpMethod::Get,
                "POST" => HttpMethod::Post,
                "PATCH" => HttpMethod::Patch,
                other => panic!("unhandled method {other}"),
            },
            "{id}"
        );
        assert_eq!(
            plan.context.organization,
            capability["cli"]["requiresOrgId"].as_bool().unwrap()
        );
        assert_eq!(
            plan.context.agent,
            capability["cli"]["requiresAgentId"].as_bool().unwrap()
        );
        assert_eq!(
            plan.context.run,
            capability["cli"]["requiresRunId"].as_bool().unwrap()
        );
        assert_eq!(
            plan.response_limit,
            if id.starts_with("browser.") {
                BROWSER_RESPONSE_LIMIT
            } else {
                CORE_RESPONSE_LIMIT
            }
        );
    }
}

#[test]
fn exact_defaults_projection_and_unicode_encoding_match_node_planner() {
    let PlanOutcome::Direct(members) = plan_request(
        "rudder_organization_members_list",
        json!({}),
        &runtime(false),
    )
    .unwrap() else {
        panic!()
    };
    assert_eq!(
        members.path,
        "/api/orgs/org%20%2F%E9%9B%AA/members/directory"
    );
    assert_eq!(query_string(&members.query), "type=all&limit=50");

    let PlanOutcome::Direct(events) =
        plan_request("runs.events", json!({"run":"run /雪"}), &runtime(false)).unwrap()
    else {
        panic!()
    };
    assert_eq!(
        events.path,
        "/api/run-intelligence/runs/run%20%2F%E9%9B%AA/events"
    );
    assert_eq!(
        query_string(&events.query),
        "afterSeq=0&limit=200&maxChars=1200&projection=compact"
    );

    let PlanOutcome::Direct(checkout) =
        plan_request("issue.checkout", json!({"issueId":"I/1"}), &runtime(false)).unwrap()
    else {
        panic!()
    };
    assert_eq!(checkout.path, "/api/issues/I%2F1/checkout");
    assert_eq!(
        checkout.body,
        Some(json!({"agentId":"agent-1","expectedStatuses":["todo","backlog","blocked"]}))
    );

    let PlanOutcome::Direct(log) = plan_request(
        "runs.log",
        json!({"run":"run /雪","offset":64,"limitBytes":4096,"maxChars":321}),
        &runtime(false),
    )
    .unwrap() else {
        panic!()
    };
    assert_eq!(log.method, HttpMethod::Get);
    assert_eq!(
        log.path,
        "/api/run-intelligence/runs/run%20%2F%E9%9B%AA/log"
    );
    assert_eq!(
        query_string(&log.query),
        "offset=64&limitBytes=4096&maxChars=321"
    );
    assert_eq!(log.body, None);
}

#[test]
fn representative_core_routes_queries_and_bodies_match_contract() {
    let managed = runtime(false);

    assert_direct_shape(
        "agent.me",
        json!({}),
        &managed,
        HttpMethod::Get,
        "/api/agents/me",
        &[],
        None,
    );
    assert_direct_shape(
        "agent.inbox",
        json!({}),
        &managed,
        HttpMethod::Get,
        "/api/agents/me/inbox-lite",
        &[],
        None,
    );
    assert_direct_shape(
        "organization.members.list",
        json!({
            "query": "Ada Lovelace",
            "type": "agent",
            "limit": 10,
            "cursor": "next / 1"
        }),
        &managed,
        HttpMethod::Get,
        "/api/orgs/org%20%2F%E9%9B%AA/members/directory",
        &[
            ("query", "Ada Lovelace"),
            ("type", "agent"),
            ("limit", "10"),
            ("cursor", "next / 1"),
        ],
        None,
    );
    assert_direct_shape(
        "goal.list",
        json!({
            "lifecycle": "closed",
            "limit": 7,
            "focus": true,
            "facet": "needs_attention"
        }),
        &managed,
        HttpMethod::Get,
        "/api/orgs/org%20%2F%E9%9B%AA/goals/assigned",
        &[
            ("lifecycle", "closed"),
            ("limit", "7"),
            ("focus", "true"),
            ("facet", "needs_attention"),
        ],
        None,
    );
    assert_direct_shape(
        "goal.context",
        json!({"goal": "goal /1"}),
        &managed,
        HttpMethod::Get,
        "/api/goals/goal%20%2F1/agent-context",
        &[],
        None,
    );
    assert_direct_shape(
        "goal.progress",
        json!({
            "goal": "goal /1",
            "summary": "Evidence is complete",
            "evidenceRefs": ["artifact://one"],
            "idempotencyKey": "progress-1",
            "activityKind": "evidence"
        }),
        &managed,
        HttpMethod::Post,
        "/api/goals/goal%20%2F1/activities",
        &[],
        Some(json!({
            "summary": "Evidence is complete",
            "activityKind": "evidence",
            "evidenceRefs": ["artifact://one"],
            "idempotencyKey": "progress-1"
        })),
    );
    assert_direct_shape(
        "goal.checkpoint",
        json!({
            "goal": "goal /1",
            "summary": "Checkpoint saved",
            "evidenceRefs": [],
            "expectedPlanRevision": 3,
            "plan": {"summary": "Continue verification"},
            "continuation": {
                "kind": "wait",
                "summary": "Await external input",
                "wakeCondition": null
            },
            "idempotencyKey": "checkpoint-1"
        }),
        &managed,
        HttpMethod::Post,
        "/api/goals/goal%20%2F1/checkpoint",
        &[],
        Some(json!({
            "summary": "Checkpoint saved",
            "evidenceRefs": [],
            "expectedPlanRevision": 3,
            "plan": {"summary": "Continue verification"},
            "continuation": {
                "kind": "wait",
                "summary": "Await external input",
                "wakeCondition": null
            },
            "idempotencyKey": "checkpoint-1"
        })),
    );
    assert_direct_shape(
        "goal.change.propose",
        json!({
            "goal": "goal /1",
            "contractRevision": 2,
            "afterContract": {"objectiveMode": "target"},
            "rationale": "The measured outcome changed",
            "evidenceRefs": ["artifact://one"],
            "idempotencyKey": "change-1"
        }),
        &managed,
        HttpMethod::Post,
        "/api/goals/goal%20%2F1/change-proposals",
        &[],
        Some(json!({
            "afterContract": {"objectiveMode": "target"},
            "rationale": "The measured outcome changed",
            "evidenceRefs": ["artifact://one"],
            "idempotencyKey": "change-1",
            "expectedContractRevision": 2
        })),
    );
    assert_direct_shape(
        "goal.result.propose",
        json!({
            "goal": "goal /1",
            "contractRevision": 2,
            "criteria": [{"id": "criterion-1", "status": "met"}],
            "evidenceRefs": ["artifact://one"],
            "riskSummary": "No known gaps",
            "idempotencyKey": "result-1",
            "resultValue": 42,
            "decision": "ship",
            "resultPayload": {"score": 42}
        }),
        &managed,
        HttpMethod::Post,
        "/api/goals/goal%20%2F1/result-proposals",
        &[],
        Some(json!({
            "contractRevision": 2,
            "criteria": [{"id": "criterion-1", "status": "met"}],
            "evidenceRefs": ["artifact://one"],
            "resultValue": 42,
            "decision": "ship",
            "resultPayload": {"score": 42},
            "riskSummary": "No known gaps",
            "idempotencyKey": "result-1"
        })),
    );
    assert_direct_shape(
        "issue.get",
        json!({"issue": "ISS/1"}),
        &managed,
        HttpMethod::Get,
        "/api/issues/ISS%2F1",
        &[],
        None,
    );
    assert_direct_shape(
        "issue.context",
        json!({"issue": "ISS/1", "wakeCommentId": "comment-1"}),
        &managed,
        HttpMethod::Get,
        "/api/issues/ISS%2F1/heartbeat-context",
        &[("wakeCommentId", "comment-1")],
        None,
    );
    assert_direct_shape(
        "issue.checkout",
        json!({"issue": "ISS/1", "expectedStatuses": "todo,blocked"}),
        &managed,
        HttpMethod::Post,
        "/api/issues/ISS%2F1/checkout",
        &[],
        Some(json!({
            "agentId": "agent-1",
            "expectedStatuses": ["todo", "blocked"]
        })),
    );
    assert_direct_shape(
        "issue.comment",
        json!({"issue": "ISS/1", "body": "Progress", "reopen": true}),
        &managed,
        HttpMethod::Post,
        "/api/issues/ISS%2F1/comments",
        &[],
        Some(json!({"body": "Progress", "reopen": true})),
    );
    assert_direct_shape(
        "issue.comments.list",
        json!({"issue": "ISS/1", "after": "comment-1", "order": "asc"}),
        &managed,
        HttpMethod::Get,
        "/api/issues/ISS%2F1/comments",
        &[("after", "comment-1"), ("order", "asc")],
        None,
    );
    assert_direct_shape(
        "issue.comments.get",
        json!({"issue": "ISS/1", "comment": "comment-1"}),
        &managed,
        HttpMethod::Get,
        "/api/issues/ISS%2F1/comments/comment-1",
        &[],
        None,
    );
    assert_direct_shape(
        "issue.done",
        json!({"issue": "ISS/1", "comment": "Completed"}),
        &managed,
        HttpMethod::Patch,
        "/api/issues/ISS%2F1",
        &[],
        Some(json!({"status": "done", "comment": "Completed"})),
    );
    assert_direct_shape(
        "issue.create",
        json!({
            "title": "Investigate failure",
            "description": "Collect the failure evidence",
            "status": "todo",
            "priority": "high",
            "assigneeAgentId": "agent-2",
            "projectId": "project-1",
            "goalId": "goal-1",
            "parentId": "issue-0",
            "requestDepth": 2,
            "billingCode": "engineering",
            "labelIds": ["bug", "native"]
        }),
        &managed,
        HttpMethod::Post,
        "/api/orgs/org%20%2F%E9%9B%AA/issues",
        &[],
        Some(json!({
            "title": "Investigate failure",
            "description": "Collect the failure evidence",
            "status": "todo",
            "priority": "high",
            "assigneeAgentId": "agent-2",
            "projectId": "project-1",
            "goalId": "goal-1",
            "parentId": "issue-0",
            "requestDepth": 2,
            "billingCode": "engineering",
            "labelIds": ["bug", "native"]
        })),
    );
    assert_direct_shape(
        "runs.list",
        json!({
            "updatedAfter": "2026-09-18T00:00:00Z",
            "runIdPrefix": "run-",
            "relatedAgentId": "agent-2",
            "status": "running",
            "runtime": "native",
            "issueId": "ISS/1",
            "usedSkill": "review",
            "loadedSkill": "planner",
            "createdBefore": "2026-09-19T00:00:00Z",
            "cursor": "cursor /1",
            "limit": 9
        }),
        &managed,
        HttpMethod::Get,
        "/api/run-intelligence/orgs/org%20%2F%E9%9B%AA/runs",
        &[
            ("projection", "summary"),
            ("updatedAfter", "2026-09-18T00:00:00Z"),
            ("runIdPrefix", "run-"),
            ("agentId", "agent-2"),
            ("status", "running"),
            ("runtime", "native"),
            ("issueId", "ISS/1"),
            ("usedSkill", "review"),
            ("loadedSkill", "planner"),
            ("createdBefore", "2026-09-19T00:00:00Z"),
            ("cursor", "cursor /1"),
            ("limit", "9"),
        ],
        None,
    );
    assert_direct_shape(
        "runs.get",
        json!({"run": "run /1"}),
        &managed,
        HttpMethod::Get,
        "/api/run-intelligence/runs/run%20%2F1",
        &[("projection", "summary")],
        None,
    );
    assert_direct_shape(
        "runs.events",
        json!({"run": "run /1", "afterSeq": 5, "limit": 3, "maxChars": 321, "cursor": "cursor /1"}),
        &managed,
        HttpMethod::Get,
        "/api/run-intelligence/runs/run%20%2F1/events",
        &[
            ("afterSeq", "5"),
            ("limit", "3"),
            ("maxChars", "321"),
            ("projection", "compact"),
            ("cursor", "cursor /1"),
        ],
        None,
    );
    assert_direct_shape(
        "runs.log",
        json!({"run": "run /1", "offset": 64, "limitBytes": 4096, "maxChars": 321}),
        &managed,
        HttpMethod::Get,
        "/api/run-intelligence/runs/run%20%2F1/log",
        &[
            ("offset", "64"),
            ("limitBytes", "4096"),
            ("maxChars", "321"),
        ],
        None,
    );
    assert_direct_shape(
        "runs.transcript",
        json!({
            "run": "run /1",
            "contextTurns": 3,
            "chronological": true,
            "includeOutput": true,
            "errorsOnly": true,
            "maxChars": 321,
            "aroundError": "step /1",
            "cursor": "cursor /1",
            "turnLimit": 4
        }),
        &managed,
        HttpMethod::Get,
        "/api/run-intelligence/runs/run%20%2F1/transcript",
        &[
            ("contextTurns", "3"),
            ("order", "oldest"),
            ("output", "compact"),
            ("includeOutputs", "true"),
            ("maxChars", "321"),
            ("errorsOnly", "true"),
            ("aroundError", "step /1"),
            ("cursor", "cursor /1"),
            ("turnLimit", "4"),
        ],
        None,
    );
    assert_direct_shape(
        "runs.errors",
        json!({"run": "run /1", "maxChars": 321, "cursor": "cursor /1"}),
        &managed,
        HttpMethod::Get,
        "/api/run-intelligence/runs/run%20%2F1/errors",
        &[("maxChars", "321"), ("cursor", "cursor /1")],
        None,
    );
    assert_direct_shape(
        "runs.create",
        json!({
            "task": "Review the native planner",
            "idempotencyKey": "run-1",
            "targetAgentId": "agent-2"
        }),
        &managed,
        HttpMethod::Post,
        "/api/agent-runs/delegation",
        &[],
        Some(json!({
            "task": "Review the native planner",
            "idempotencyKey": "run-1",
            "targetAgentId": "agent-2"
        })),
    );
}

#[test]
fn representative_browser_routes_and_bodies_match_contract() {
    let managed = runtime(true);

    assert_direct_shape(
        "browser.tabs",
        json!({}),
        &managed,
        HttpMethod::Post,
        "/api/browser/tabs",
        &[],
        Some(json!({})),
    );
    assert_direct_shape(
        "browser.user-tabs",
        json!({}),
        &managed,
        HttpMethod::Post,
        "/api/browser/user_tabs",
        &[],
        Some(json!({})),
    );
    assert_direct_shape(
        "browser.open",
        json!({"url": "https://example.com/a?b=1"}),
        &managed,
        HttpMethod::Post,
        "/api/browser/open",
        &[],
        Some(json!({"url": "https://example.com/a?b=1"})),
    );
    assert_direct_shape(
        "browser.navigate",
        json!({"tabId": "tab-1", "url": "https://example.com/next"}),
        &managed,
        HttpMethod::Post,
        "/api/browser/navigate",
        &[],
        Some(json!({"tabId": "tab-1", "url": "https://example.com/next"})),
    );
    for id in ["browser.back", "browser.forward", "browser.reload"] {
        let path = format!("/api/browser/{}", id.strip_prefix("browser.").unwrap());
        assert_direct_shape(
            id,
            json!({"tabId": "tab-1"}),
            &managed,
            HttpMethod::Post,
            &path,
            &[],
            Some(json!({"tabId": "tab-1"})),
        );
    }
    assert_direct_shape(
        "browser.viewport",
        json!({"action": "set", "width": 1280, "height": 720}),
        &managed,
        HttpMethod::Post,
        "/api/browser/viewport",
        &[],
        Some(json!({"action": "set", "width": 1280, "height": 720})),
    );
    assert_direct_shape(
        "browser.visibility",
        json!({"visible": false}),
        &managed,
        HttpMethod::Post,
        "/api/browser/visibility",
        &[],
        Some(json!({"visible": false})),
    );
    assert_direct_shape(
        "browser.snapshot",
        json!({"tabId": "tab-1", "boxes": true, "depth": 5, "maxNodes": 100}),
        &managed,
        HttpMethod::Post,
        "/api/browser/snapshot",
        &[],
        Some(json!({
            "tabId": "tab-1",
            "boxes": true,
            "depth": 5,
            "maxNodes": 100
        })),
    );
    assert_direct_shape(
        "browser.locator",
        json!({
            "tabId": "tab-1",
            "action": "count",
            "locator": {"strategy": "css", "value": "button"}
        }),
        &managed,
        HttpMethod::Post,
        "/api/browser/locator",
        &[],
        Some(json!({
            "tabId": "tab-1",
            "action": "count",
            "locator": {"strategy": "css", "value": "button"}
        })),
    );
    assert_direct_shape(
        "browser.cua",
        json!({"tabId": "tab-1", "action": "click", "x": 12, "y": 34, "button": "left"}),
        &managed,
        HttpMethod::Post,
        "/api/browser/cua",
        &[],
        Some(json!({
            "tabId": "tab-1",
            "action": "click",
            "x": 12,
            "y": 34,
            "button": "left"
        })),
    );
    assert_direct_shape(
        "browser.dom-cua",
        json!({"tabId": "tab-1", "action": "get", "depth": 5, "maxNodes": 100}),
        &managed,
        HttpMethod::Post,
        "/api/browser/dom_cua",
        &[],
        Some(json!({
            "tabId": "tab-1",
            "action": "get",
            "depth": 5,
            "maxNodes": 100
        })),
    );
    assert_direct_shape(
        "browser.dialog",
        json!({"tabId": "tab-1", "action": "accept", "promptText": "yes"}),
        &managed,
        HttpMethod::Post,
        "/api/browser/dialog",
        &[],
        Some(json!({"tabId": "tab-1", "action": "accept", "promptText": "yes"})),
    );
    assert_direct_shape(
        "browser.clipboard",
        json!({"action": "writeText", "text": "copied"}),
        &managed,
        HttpMethod::Post,
        "/api/browser/clipboard",
        &[],
        Some(json!({"action": "writeText", "text": "copied"})),
    );
    assert_direct_shape(
        "browser.logs",
        json!({
            "tabId": "tab-1",
            "levels": ["error"],
            "limit": 5,
            "clear": true
        }),
        &managed,
        HttpMethod::Post,
        "/api/browser/logs",
        &[],
        Some(json!({
            "tabId": "tab-1",
            "levels": ["error"],
            "limit": 5,
            "clear": true
        })),
    );
    assert_direct_shape(
        "browser.download",
        json!({
            "tabId": "tab-1",
            "mode": "media",
            "locator": {"strategy": "text", "value": "Download"}
        }),
        &managed,
        HttpMethod::Post,
        "/api/browser/download",
        &[],
        Some(json!({
            "tabId": "tab-1",
            "mode": "media",
            "locator": {"strategy": "text", "value": "Download"}
        })),
    );
    assert_direct_shape(
        "browser.assets",
        json!({"tabId": "tab-1", "action": "bundle", "assetIds": ["asset-1"]}),
        &managed,
        HttpMethod::Post,
        "/api/browser/assets",
        &[],
        Some(json!({
            "tabId": "tab-1",
            "action": "bundle",
            "assetIds": ["asset-1"]
        })),
    );
    assert_direct_shape(
        "browser.content",
        json!({"tabId": "tab-1", "format": "pdf"}),
        &managed,
        HttpMethod::Post,
        "/api/browser/content",
        &[],
        Some(json!({"tabId": "tab-1", "format": "pdf"})),
    );
    assert_direct_shape(
        "browser.wait",
        json!({
            "tabId": "tab-1",
            "timeMs": 100,
            "timeoutMs": 500,
            "text": "Ready",
            "textGone": "Loading",
            "url": "/done"
        }),
        &managed,
        HttpMethod::Post,
        "/api/browser/wait",
        &[],
        Some(json!({
            "tabId": "tab-1",
            "timeMs": 100,
            "timeoutMs": 500,
            "text": "Ready",
            "textGone": "Loading",
            "url": "/done"
        })),
    );
    assert_direct_shape(
        "browser.read",
        json!({"tabId": "tab-1"}),
        &managed,
        HttpMethod::Post,
        "/api/browser/read",
        &[],
        Some(json!({"tabId": "tab-1"})),
    );
    assert_direct_shape(
        "browser.click",
        json!({"tabId": "tab-1", "ref": "ref-1"}),
        &managed,
        HttpMethod::Post,
        "/api/browser/click",
        &[],
        Some(json!({"tabId": "tab-1", "ref": "ref-1"})),
    );
    assert_direct_shape(
        "browser.type",
        json!({"tabId": "tab-1", "ref": "ref-1", "text": "hello", "submit": true}),
        &managed,
        HttpMethod::Post,
        "/api/browser/type",
        &[],
        Some(json!({
            "tabId": "tab-1",
            "ref": "ref-1",
            "text": "hello",
            "submit": true
        })),
    );
    assert_direct_shape(
        "browser.screenshot",
        json!({
            "tabId": "tab-1",
            "format": "jpeg",
            "fullPage": true,
            "quality": 80,
            "clip": {"x": 1, "y": 2, "width": 300, "height": 200}
        }),
        &managed,
        HttpMethod::Post,
        "/api/browser/screenshot",
        &[],
        Some(json!({
            "tabId": "tab-1",
            "format": "jpeg",
            "fullPage": true,
            "quality": 80,
            "clip": {"x": 1, "y": 2, "width": 300, "height": 200}
        })),
    );
    assert_direct_shape(
        "browser.close",
        json!({"tabId": "tab-1"}),
        &managed,
        HttpMethod::Post,
        "/api/browser/close",
        &[],
        Some(json!({"tabId": "tab-1"})),
    );
}

#[test]
fn aliases_are_normalized_before_unknown_and_schema_checks() {
    let canonical = plan_request(
        "issue.comments.get",
        json!({"issue":"i","comment":"c"}),
        &runtime(false),
    )
    .unwrap();
    let legacy = plan_request(
        "issue.comments.get",
        json!({"issueId":"i","commentId":"c"}),
        &runtime(false),
    )
    .unwrap();
    assert_eq!(canonical, legacy);
    let transcript = plan_request(
        "runs.transcript",
        json!({"run":"r","maxOutputChars":321}),
        &runtime(false),
    )
    .unwrap();
    let PlanOutcome::Direct(transcript) = transcript else {
        panic!()
    };
    assert!(
        transcript
            .query
            .contains(&("maxChars".into(), "321".into()))
    );

    let comment = plan_request(
        "issue.comment",
        json!({"issue":"i","comment":"legacy body"}),
        &runtime(false),
    )
    .unwrap();
    let done = plan_request(
        "issue.done",
        json!({"issue":"i","body":"legacy done"}),
        &runtime(false),
    )
    .unwrap();
    assert_eq!(
        comment,
        plan_request(
            "issue.comment",
            json!({"issue":"i","body":"legacy body"}),
            &runtime(false),
        )
        .unwrap()
    );
    assert_eq!(
        done,
        plan_request(
            "issue.done",
            json!({"issue":"i","comment":"legacy done"}),
            &runtime(false),
        )
        .unwrap()
    );
}

#[test]
fn rejects_reserved_unknown_type_null_missing_and_invalid_browser_actions() {
    for key in ["orgId", "ORG-ID", "company_id", "api.key", "RuDdEr_fake"] {
        assert!(
            matches!(
                plan_request("agent.me", json!({key: "spoof"}), &runtime(false)),
                Err(PlanError::ReservedIdentity(_))
            ),
            "{key}"
        );
    }
    assert!(matches!(
        plan_request("agent.me", json!({"wat":1}), &runtime(false)),
        Err(PlanError::UnknownArguments { .. })
    ));
    assert!(matches!(
        plan_request("issue.get", json!({"issue":1}), &runtime(false)),
        Err(PlanError::InvalidArgument { .. })
    ));
    assert!(matches!(
        plan_request("issue.get", json!({"issue":null}), &runtime(false)),
        Err(PlanError::InvalidArgument { .. })
    ));
    assert!(matches!(
        plan_request("issue.get", json!({}), &runtime(false)),
        Err(PlanError::InvalidArgument { .. })
    ));
    assert!(matches!(
        plan_request(
            "browser.locator",
            json!({"tabId":"t","action":"click","selector":"x"}),
            &runtime(true)
        ),
        Err(PlanError::InvalidArgument { .. })
    ));
    assert!(matches!(
        plan_request(
            "browser.download",
            json!({"tabId":"t","mode":"file"}),
            &runtime(true)
        ),
        Err(PlanError::InvalidArgument { .. })
    ));
}

#[test]
fn preserves_issue_request_shapes_and_rejects_unmaterialized_images() {
    let PlanOutcome::Direct(comment) = plan_request(
        "issue.comment",
        json!({"issue":"ISS/1","body":"Progress","reopen":true}),
        &runtime(false),
    )
    .unwrap() else {
        panic!()
    };
    assert_eq!(comment.method, HttpMethod::Post);
    assert_eq!(comment.path, "/api/issues/ISS%2F1/comments");
    assert!(comment.query.is_empty());
    assert_eq!(comment.body, Some(json!({"body":"Progress","reopen":true})));

    let PlanOutcome::Direct(done) = plan_request(
        "issue.done",
        json!({"issue":"ISS/1","comment":"Completed"}),
        &runtime(false),
    )
    .unwrap() else {
        panic!()
    };
    assert_eq!(done.method, HttpMethod::Patch);
    assert_eq!(done.path, "/api/issues/ISS%2F1");
    assert!(done.query.is_empty());
    assert_eq!(
        done.body,
        Some(json!({"status":"done","comment":"Completed"}))
    );

    for capability in ["issue.comment", "issue.done"] {
        assert!(matches!(
            plan_request(
                capability,
                json!({"issue":"ISS/1","body":"Completed","images":["/tmp/proof.png"]}),
                &runtime(false),
            ),
            Err(PlanError::InvalidArgument { .. })
        ));
    }
}

#[test]
fn validates_schema_min_properties_and_formats() {
    let base = json!({
        "goal": "goal-1",
        "contractRevision": 1,
        "rationale": "The evidence requires a contract update.",
        "idempotencyKey": "change-1",
    });

    let mut empty_change = base.clone();
    empty_change["afterContract"] = json!({});
    assert!(matches!(
        plan_request("goal.change.propose", empty_change, &runtime(false)),
        Err(PlanError::InvalidArgument { .. })
    ));

    let mut invalid_deadline = base.clone();
    invalid_deadline["afterContract"] = json!({"actionDeadline":"not-a-date"});
    assert!(matches!(
        plan_request("goal.change.propose", invalid_deadline, &runtime(false)),
        Err(PlanError::InvalidArgument { .. })
    ));

    let mut valid_deadline = base;
    valid_deadline["afterContract"] = json!({"actionDeadline":"2026-09-18T00:00:00Z"});
    assert!(plan_request("goal.change.propose", valid_deadline, &runtime(false)).is_ok());
}

#[test]
fn rejects_whitespace_only_runtime_identity() {
    let mut whitespace_org = runtime(false);
    whitespace_org.organization_id = Some(" \t\n".into());
    assert!(matches!(
        plan_request(
            "organization.members.list",
            json!({}),
            &whitespace_org,
        ),
        Err(PlanError::MissingContext(context)) if context == "organization"
    ));

    let mut whitespace_agent = runtime(false);
    whitespace_agent.agent_id = Some(" \t\n".into());
    assert!(matches!(
        plan_request("goal.context", json!({"goal":"goal-1"}), &whitespace_agent),
        Err(PlanError::MissingContext(context)) if context == "agent"
    ));

    let mut whitespace_run = runtime(true);
    whitespace_run.run_id = Some(" \t\n".into());
    assert!(matches!(
        plan_request("browser.tabs", json!({}), &whitespace_run),
        Err(PlanError::MissingContext(context)) if context == "run"
    ));
}

#[test]
fn browser_and_context_gates_fail_closed_and_non_direct_is_typed() {
    assert_eq!(
        plan_request("browser.tabs", json!({}), &runtime(false)),
        Err(PlanError::BrowserDisabled)
    );
    let mut missing = runtime(true);
    missing.run_id = None;
    assert!(matches!(
        plan_request("browser.tabs", json!({}), &missing),
        Err(PlanError::MissingContext(_))
    ));
    assert_eq!(
        plan_request("project.list", json!({}), &runtime(false)).unwrap(),
        PlanOutcome::NotDirectCapability
    );
}
