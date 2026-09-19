use rudder_agent_request_planner::{
    DirectRequest, HttpMethod, ManagedRuntimeIdentity, PlanOutcome, plan_request,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::error::Error;
use std::io::{self, Read};

const SCHEMA: &str = "rudder.agent-request-planner.differential/runtime-v1";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DifferentialEnvelope {
    schema: String,
    capability: String,
    timezone: String,
    runtime: RuntimeInput,
    cases: Vec<DifferentialCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInput {
    organization_id: Option<String>,
    agent_id: Option<String>,
    run_id: Option<String>,
    browser_enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DifferentialCase {
    id: String,
    arguments: Value,
    node_payload: Value,
    cli_args: Vec<String>,
    note: Option<String>,
}

fn main() {
    match run() {
        Ok(passed) => std::process::exit(if passed { 0 } else { 1 }),
        Err(error) => {
            eprintln!("agent-request-planner-differential: {error}");
            std::process::exit(2);
        }
    }
}

fn run() -> Result<bool, Box<dyn Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let envelope: DifferentialEnvelope = serde_json::from_str(&input)?;

    if envelope.schema != SCHEMA {
        return Err(format!("unsupported harness schema: {}", envelope.schema).into());
    }
    if envelope.capability != "goal.change.propose" {
        return Err(format!("unsupported capability: {}", envelope.capability).into());
    }
    let process_timezone = std::env::var("TZ").unwrap_or_default();
    if process_timezone != envelope.timezone {
        return Err(format!(
            "runner TZ {:?} does not match input timezone {:?}",
            process_timezone, envelope.timezone
        )
        .into());
    }

    let runtime = ManagedRuntimeIdentity {
        organization_id: envelope.runtime.organization_id,
        agent_id: envelope.runtime.agent_id,
        run_id: envelope.runtime.run_id,
        browser_enabled: envelope.runtime.browser_enabled,
    };
    let mut reports = Vec::with_capacity(envelope.cases.len());

    for case in &envelope.cases {
        let report = match plan_request(&envelope.capability, case.arguments.clone(), &runtime) {
            Ok(PlanOutcome::Direct(plan)) => {
                let rust_plan = direct_request_json(&plan);
                let equal = rust_plan["body"] == case.node_payload;
                let status = if equal { "equal" } else { "mismatch" };
                json!({
                    "id": case.id,
                    "status": status,
                    "pass": equal,
                    "node": {
                        "arguments": case.arguments,
                        "cliArgs": case.cli_args,
                        "payload": case.node_payload,
                    },
                    "rust": rust_plan,
                    "note": case.note,
                })
            }
            Ok(PlanOutcome::NotDirectCapability) => json!({
                "id": case.id,
                "status": "mismatch",
                "pass": false,
                "node": {
                    "arguments": case.arguments,
                    "cliArgs": case.cli_args,
                    "payload": case.node_payload,
                },
                "rust": { "outcome": "not-direct-capability" },
                "note": case.note,
            }),
            Err(error) => {
                json!({
                    "id": case.id,
                    "status": "error",
                    "pass": false,
                    "node": {
                        "arguments": case.arguments,
                        "cliArgs": case.cli_args,
                        "payload": case.node_payload,
                    },
                    "rust": { "error": error.to_string() },
                    "note": case.note,
                })
            }
        };
        reports.push(report);
    }

    let passed = reports.iter().all(|report| report["pass"] == true);
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "schema": SCHEMA,
            "timezone": envelope.timezone,
            "capability": envelope.capability,
            "passed": passed,
            "cases": reports,
        }))?
    );
    Ok(passed)
}

fn direct_request_json(request: &DirectRequest) -> Value {
    json!({
        "outcome": "direct",
        "capabilityId": request.capability_id,
        "method": method_name(request.method),
        "path": request.path,
        "query": request.query,
        "body": request.body,
        "context": {
            "organization": request.context.organization,
            "agent": request.context.agent,
            "run": request.context.run,
        },
        "responseLimit": request.response_limit,
    })
}

fn method_name(method: HttpMethod) -> &'static str {
    match method {
        HttpMethod::Get => "GET",
        HttpMethod::Post => "POST",
        HttpMethod::Patch => "PATCH",
    }
}
