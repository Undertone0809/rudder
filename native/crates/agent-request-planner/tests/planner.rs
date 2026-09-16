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
            Value::Object(result)
        }
        _ => Value::Null,
    }
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
        let PlanOutcome::Direct(plan) = plan_request(id, args, &runtime(true)).unwrap() else {
            panic!("{id} was not direct")
        };
        assert_eq!(plan.capability_id, id);
        assert!(!plan.path.is_empty(), "{id}");
        assert!(plan.path.starts_with("/api/"), "{id}: {}", plan.path);
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
