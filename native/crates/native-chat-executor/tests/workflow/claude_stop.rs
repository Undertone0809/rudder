#![cfg(unix)]

use crate::fixture::*;
use rudder_d1_persistence::native_chat::{
    control::{StopOutcome, StopRequest, request_stop},
    execution::{NativeProviderKind, NativeProviderStatus, NativeProviderTurnReceipt},
};
use rudder_native_chat_executor::NativeExecutionObservation;
use serde_json::{Value, json};
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf, process::Command, time::Duration};

fn python_executable() -> PathBuf {
    let output = Command::new("python3")
        .args(["-c", "import sys; print(sys.executable)"])
        .output()
        .expect("locate Python for the synthetic Claude stream-json fixture");
    assert!(output.status.success(), "python3 must be available");
    PathBuf::from(String::from_utf8(output.stdout).unwrap().trim())
        .canonicalize()
        .expect("canonical Python interpreter")
}

fn install_fake_claude(host: &mut FixtureHost) {
    let executable = host.probe_path("claude-fixture");
    let profiles = host.probe_path("claude-profiles");
    let managed_config = profiles.join(".claude");
    fs::create_dir_all(&managed_config).expect("create managed Claude profile");
    let root = serde_json::to_string(&host.probe_path(".").to_string_lossy())
        .expect("encode fixture root as a Python string");
    let source = format!(
        r#"import json, pathlib, select, sys, time
root = pathlib.Path({root})
events = root / "provider-events.jsonl"
release = root / "release-claude-terminal"
session = sys.argv[sys.argv.index("--session-id") + 1]
result_id = "655b28ae-cd7d-41cf-be0e-5208bfa02066"

def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()

def record(value):
    with events.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(value, separators=(",", ":")) + "\n")

def terminal(subtype):
    emit({{"type":"result","subtype":subtype,"is_error":True,
          "session_id":session,"uuid":result_id}})

emit({{"type":"system","subtype":"init","session_id":session,"model":"fixture"}})
raw = sys.stdin.readline()
if not raw:
    raise SystemExit(21)
message = json.loads(raw)
record(message)
if message.get("type") != "user":
    raise SystemExit(22)
(root / "claude-input-pending").write_text("ready", encoding="utf-8")

deadline = time.monotonic() + 20
interrupt = None
while time.monotonic() < deadline:
    if release.exists():
        terminal("error_no_interrupt")
        raise SystemExit(0)
    ready, _, _ = select.select([sys.stdin], [], [], 0.05)
    if ready:
        raw = sys.stdin.readline()
        if not raw:
            raise SystemExit(23)
        request = json.loads(raw)
        record(request)
        if request.get("type") == "control_request" and request.get("request") == {{"subtype":"interrupt"}}:
            interrupt = request
            break
        if request.get("type") == "user":
            continue
        raise SystemExit(24)
if interrupt is None:
    terminal("error_interrupt_timeout")
    raise SystemExit(0)

request_id = interrupt.get("request_id")
if not isinstance(request_id, str) or not request_id:
    raise SystemExit(25)
emit({{"type":"control_response","response":{{"subtype":"success",
      "request_id":request_id,"response":{{"still_queued":[]}}}}}})
(root / "claude-interrupt-acknowledged").write_text("ack", encoding="utf-8")
deadline = time.monotonic() + 20
while not release.exists() and time.monotonic() < deadline:
    time.sleep(0.02)
terminal("error_during_execution")
"#,
    );
    let script = format!("#!{}\n{}", python_executable().display(), source);
    fs::write(&executable, script).expect("write synthetic Claude stream-json provider");
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
        .expect("make synthetic Claude executable");
    host.enable_claude_runtime(executable, profiles);
}

async fn wait_for_path(path: &std::path::Path) -> bool {
    for _ in 0..1000 {
        if path.exists() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    false
}

async fn stop_request(pool: &sqlx::PgPool, run_id: &str) -> StopRequest {
    let (generation_id, control_version): (String, i32) = sqlx::query_as(
        "SELECT g.id::text,g.control_version FROM chat_generations g
         JOIN heartbeat_runs r ON r.chat_generation_id=g.id WHERE r.id=$1::uuid",
    )
    .bind(run_id)
    .fetch_one(pool)
    .await
    .expect("read admitted generation control version");
    StopRequest {
        conversation_id: CHAT.into(),
        generation_id,
        control_action_id: "72000000-0000-4000-8000-000000000091".into(),
        expected_attempt_epoch: 1,
        expected_control_version: control_version,
        requested_render_seq: 0,
        requested_body_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            .into(),
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; disposable PostgreSQL and a synthetic Claude CLI"]
async fn claude_stop_interrupts_once_waits_for_real_result_and_preserves_failed_status() {
    assert_ignored_external_dependencies();
    let database = Database::start().await;
    let mut host = FixtureHost::new("claude-governed-stop");
    install_fake_claude(&mut host);
    let (actor, run_id, attempt_id) = admitted_with_runtime(
        &database,
        &host,
        "claude_local",
        json!({
            "profileId":"default",
            "command":"claude",
            "model":MODEL,
            "instructionsBundleMode":"managed"
        }),
    )
    .await;

    let input_pending = host.probe_path("claude-input-pending");
    let interrupt_ack = host.probe_path("claude-interrupt-acknowledged");
    let release_terminal = host.probe_path("release-claude-terminal");
    let worker =
        spawn_native_executor_worker(&database, host, actor.clone(), run_id.clone(), attempt_id);

    if !wait_for_path(&input_pending).await {
        fs::write(&release_terminal, "release").expect("release fake provider on timeout");
        let _ = worker.await;
        panic!("Claude fixture did not receive the one admitted user input");
    }

    let request = stop_request(&database.pool, &run_id).await;
    let stop = request_stop(&database.pool, &actor, &request)
        .await
        .expect("record exact Stop for the active Claude execution");
    assert_eq!(stop.outcome, StopOutcome::StopIntentRecorded);

    if !wait_for_path(&interrupt_ack).await {
        fs::write(&release_terminal, "release").expect("release fake provider on timeout");
        let _ = worker.await;
        panic!("Claude did not receive a permit-backed native interrupt");
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    let completed_before_terminal = worker.is_finished();
    fs::write(&release_terminal, "release").expect("release actual Claude result");
    let (result, host) = worker.await.expect("join synthetic Claude worker");
    let NativeExecutionObservation::Claude(observed) = result.expect("Claude terminal receipt")
    else {
        panic!("expected provider-native Claude observation");
    };
    let provider = observed.observation;
    assert!(
        !completed_before_terminal,
        "the correlated interrupt ACK must not act as terminal evidence"
    );
    assert_eq!(provider.turn.subtype(), "error_during_execution");
    assert_eq!(
        provider.turn.status(),
        rudder_claude_code::ClaudeTurnStatus::Failed
    );
    let cleanup = provider
        .cleanup
        .as_ref()
        .expect("Claude result must retain owned host cleanup proof");
    assert_eq!(
        provider.connection.connection_receipt_id(),
        cleanup.connection_receipt_id(),
        "terminal and cleanup proof belong to the same process-host connection"
    );
    assert!(observed.fence.matches_host_cleanup_proof(cleanup));
    let stop = provider
        .stop
        .as_ref()
        .expect("worker returns the exact durable Stop");

    let events = host.events();
    let inputs: Vec<&Value> = events
        .iter()
        .filter(|event| event["type"] == "user")
        .collect();
    let interrupts: Vec<&Value> = events
        .iter()
        .filter(|event| event["type"] == "control_request")
        .collect();
    assert_eq!(inputs.len(), 1, "the admitted body is written exactly once");
    assert_eq!(
        inputs[0]["message"]["content"][0]["text"], BODY,
        "Stop does not substitute or replay the input"
    );
    assert_eq!(
        interrupts.len(),
        1,
        "one durable permit authorizes one interrupt"
    );
    assert_eq!(interrupts[0]["request"]["subtype"], "interrupt");
    assert!(
        !interrupts[0]["request"]
            .as_object()
            .unwrap()
            .contains_key("message")
    );

    let turn = NativeProviderTurnReceipt {
        provider: NativeProviderKind::Claude,
        session_id: provider.turn.session_id().as_str().to_owned(),
        request_id: provider
            .turn
            .result_uuid()
            .expect("actual Claude result UUID")
            .to_owned(),
        final_text: provider.turn.summary().map(str::to_owned),
        status: NativeProviderStatus::Failed,
        usage: provider.turn.usage().cloned(),
        evidence: json!({
            "provider":"claude_local",
            "sessionId":provider.turn.session_id().as_str(),
            "resultUuid":provider.turn.result_uuid(),
            "subtype":provider.turn.subtype(),
            "isError":provider.turn.is_error()
        }),
    };
    let result = rudder_d1_persistence::native_chat::execution::finalize_native_stopped(
        &database.pool,
        &observed.execution_principal,
        &observed.fence,
        &turn,
        cleanup,
        stop,
    )
    .await
    .expect("exact Stop, actual failed result, and same-host cleanup finalize together");
    let retry = rudder_d1_persistence::native_chat::execution::finalize_native_stopped(
        &database.pool,
        &observed.execution_principal,
        &observed.fence,
        &turn,
        cleanup,
        stop,
    )
    .await
    .expect("exact stopped terminal retry stays idempotent");
    assert_eq!(retry, result);
    assert_eq!(result["status"], "cancelled");
    assert_eq!(result["generationStatus"], "stopped");
    assert_eq!(result["nativeAdmissionHold"], false);
    let (run_status, generation_status, actual_provider_status): (String, String, Option<String>) =
        sqlx::query_as(
            "SELECT r.status,g.status,a.provider_evidence->'stopResolution'->>'actualProviderStatus'
             FROM heartbeat_runs r JOIN chat_generations g ON g.id=r.chat_generation_id
             JOIN chat_control_actions a ON a.expected_generation_id=g.id WHERE r.id=$1::uuid",
        )
        .bind(&run_id)
        .fetch_one(&database.pool)
        .await
        .expect("read terminal Stop receipt");
    assert_eq!(run_status, "cancelled");
    assert_eq!(generation_status, "stopped");
    assert_eq!(actual_provider_status.as_deref(), Some("failed"));
}
