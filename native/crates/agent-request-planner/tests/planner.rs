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
