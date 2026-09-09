use std::collections::BTreeMap;

use rudder_runtime_adapter_core::{
    ProcessHostMessage, ProcessHostOutput, ProcessHostTerminal, ProcessLaunch,
    RuntimeProcessAdapter, RuntimeProcessOutcome,
};
use rudder_runtime_core::{
    ActorIdentity, ActorType, CancellationReason, FenceToken, Lease, OutputLimits, RetryPolicy,
    RunContext, RunMachine, RunRequest, RuntimeIdentity,
};
use serde_json::json;

fn identity() -> RuntimeIdentity {
    RuntimeIdentity::new(
        "org-1",
        "run-1",
        ActorIdentity::new(ActorType::Agent, "agent-1").unwrap(),
    )
    .unwrap()
}

fn fence(epoch: u64) -> FenceToken {
    FenceToken::new(epoch, format!("fence-{epoch}")).unwrap()
}

fn machine(limits: OutputLimits) -> RunMachine {
    let request = RunRequest::new(
        identity(),
        RunContext::manual(),
        RetryPolicy::default(),
        limits,
        None,
        Some(10_000),
    )
    .unwrap();
    let mut machine = RunMachine::new(request, 0).unwrap();
    machine
        .admit(Lease::new("worker-1", fence(1), 0, 1_000).unwrap(), 10)
        .unwrap();
    machine.start(&fence(1), 10).unwrap();
    machine
}

fn launch() -> ProcessLaunch {
    let runtime_root = std::env::temp_dir().join("rudder-runtime");
    let cwd = std::env::temp_dir();
    let executable = std::env::current_exe().expect("test executable path");
    ProcessLaunch::new(
        executable.to_string_lossy(),
        vec!["-c".to_owned(), "printf ok".to_owned()],
        cwd.to_string_lossy(),
        BTreeMap::new(),
        runtime_root.to_string_lossy(),
        "host-owner-1",
    )
}

#[test]
fn start_message_preserves_identity_fence_and_run_binding() {
    let machine = machine(OutputLimits::default());
    let adapter = RuntimeProcessAdapter::new(&machine, launch(), 10).unwrap();

    let start = adapter.start(&machine, 10).unwrap();
    assert!(matches!(
        start.message(),
        ProcessHostMessage::StartProcess { .. }
    ));
    assert_eq!(start.identity(), &identity());
    assert_eq!(start.fence(), &fence(1));
    assert_eq!(start.attempt(), 1);

    let wire = start.to_wire_value().unwrap();
    assert_eq!(wire["protocolVersion"]["major"], 2);
    assert_eq!(wire["requestId"], "run-1");
    assert_eq!(wire["ownerToken"], "host-owner-1");
    assert_eq!(
        wire["authority"]["runtimeIdentity"]["organizationId"],
        "org-1"
    );
    assert_eq!(wire["authority"]["runtimeIdentity"]["runId"], "run-1");
    assert_eq!(wire["authority"]["runtimeIdentity"]["agentId"], "agent-1");
    assert_eq!(wire["authority"]["ownership"]["epoch"], 1);
    assert_eq!(wire["authority"]["lease"]["owner"], "worker-1");
    assert_eq!(wire["authority"]["attempt"], 1);
    assert_eq!(
        wire["authority"]["receiptContext"]["ownerToken"],
        "host-owner-1"
    );
}

#[test]
fn launch_requires_absolute_paths_and_a_safe_owner_token() {
    let machine = machine(OutputLimits::default());

    let mut relative_executable = launch();
    relative_executable.executable = "sh".to_owned();
    assert_eq!(
        RuntimeProcessAdapter::new(&machine, relative_executable, 10)
            .unwrap_err()
            .code(),
        "paths_must_be_absolute"
    );

    let mut relative_root = launch();
    relative_root.runtime_root = "runtime".to_owned();
    assert_eq!(
        RuntimeProcessAdapter::new(&machine, relative_root, 10)
            .unwrap_err()
            .code(),
        "invalid_runtime_root"
    );

    let mut path_owner = launch();
    path_owner.owner_token = "owner/with/path".to_owned();
    assert_eq!(
        RuntimeProcessAdapter::new(&machine, path_owner, 10)
            .unwrap_err()
            .code(),
        "invalid_owner_token"
    );
}

#[test]
fn stale_fences_and_cancelled_runs_cannot_send_process_controls() {
    let machine = machine(OutputLimits::default());
    let adapter = RuntimeProcessAdapter::new(&machine, launch(), 10).unwrap();

    assert_eq!(
        adapter
            .input(&machine, &fence(2), 10, "input")
            .unwrap_err()
            .code(),
        "stale_fence"
    );

    let input = adapter.input(&machine, &fence(1), 10, "input").unwrap();
    let input_wire = input.to_wire_value().unwrap();
    assert_eq!(input_wire["type"], "input");
    assert_eq!(input_wire["data"], "input");

    let resize = adapter.resize(&machine, &fence(1), 10, 80, 24).unwrap();
    let resize_wire = resize.to_wire_value().unwrap();
    assert_eq!(resize_wire["type"], "resize");
    assert_eq!(resize_wire["cols"], 80);
    assert_eq!(resize_wire["rows"], 24);

    assert_eq!(
        adapter
            .input(&machine, &fence(1), 10, "bad\0input")
            .unwrap_err()
            .code(),
        "invalid_terminal_input"
    );
    assert_eq!(
        adapter
            .resize(&machine, &fence(1), 10, 1, 24)
            .unwrap_err()
            .code(),
        "invalid_terminal_size"
    );

    let mut cancelled = machine.clone();
    cancelled
        .request_cancel(CancellationReason::OperatorStop)
        .unwrap();
    assert_eq!(
        adapter
            .resize(&cancelled, &fence(1), 10, 80, 24)
            .unwrap_err()
            .code(),
        "cancel_requested"
    );
    let stop = adapter
        .stop(
            &cancelled,
            &fence(1),
            10,
            CancellationReason::OperatorStop,
            Some(250),
        )
        .unwrap();
    assert!(matches!(stop.message(), ProcessHostMessage::Stop { .. }));

    let mut expired_cancelled = machine.clone();
    expired_cancelled
        .request_cancel(CancellationReason::OperatorStop)
        .unwrap();
    let stop_after_lease_expiry = adapter
        .stop(
            &expired_cancelled,
            &fence(1),
            1_001,
            CancellationReason::OperatorStop,
            None,
        )
        .unwrap_err();
    assert_eq!(stop_after_lease_expiry.code(), "lease_expired");
}

#[test]
fn terminal_mapping_bounds_output_and_preserves_runtime_identity() {
    let limits = OutputLimits::new(5, 4, 64, 512).unwrap();
    let machine = machine(limits);
    let adapter = RuntimeProcessAdapter::new(&machine, launch(), 10).unwrap();
    let outcome = adapter
        .map_terminal(
            &machine,
            10,
            ProcessHostTerminal::succeeded(Some(0), None)
                .with_authority(adapter.authority().clone()),
            ProcessHostOutput::new("héllo", "error-output", Some(json!({"ok": true}))),
        )
        .unwrap();

    assert_eq!(outcome.status(), rudder_runtime_core::RunStatus::Succeeded);
    assert_eq!(outcome.identity(), &identity());
    assert_eq!(outcome.result().stdout().text(), "héll");
    assert_eq!(outcome.result().stderr().text(), "erro");
    assert!(outcome.result().stdout().truncated());
    assert_eq!(outcome.exit_code(), Some(0));
}

#[test]
fn terminal_events_map_to_stable_failure_and_timeout_outcomes() {
    let machine = machine(OutputLimits::default());
    let adapter = RuntimeProcessAdapter::new(&machine, launch(), 10).unwrap();
    let failed = adapter
        .map_terminal(
            &machine,
            10,
            ProcessHostTerminal::failed(Some("child_exit"), Some(7), None)
                .with_authority(adapter.authority().clone()),
            ProcessHostOutput::default(),
        )
        .unwrap();
    assert_eq!(failed.status(), rudder_runtime_core::RunStatus::Failed);
    assert_eq!(failed.result().error.as_ref().unwrap().code, "child_exit");

    let mut timed_out_machine = machine.clone();
    timed_out_machine
        .request_cancel(CancellationReason::Timeout)
        .unwrap();
    let timed_out = adapter
        .map_terminal(
            &timed_out_machine,
            10,
            ProcessHostTerminal::failed(Some("child_exit"), None, None)
                .with_authority(adapter.authority().clone()),
            ProcessHostOutput::default(),
        )
        .unwrap();
    assert_eq!(timed_out.status(), rudder_runtime_core::RunStatus::TimedOut);
    assert_eq!(timed_out.result().error.as_ref().unwrap().code, "timed_out");

    let mut cancelled_machine = machine.clone();
    cancelled_machine
        .request_cancel(CancellationReason::OperatorStop)
        .unwrap();
    let cancelled = adapter
        .map_terminal(
            &cancelled_machine,
            10,
            ProcessHostTerminal::failed(Some("child_exit"), None, None)
                .with_authority(adapter.authority().clone()),
            ProcessHostOutput::default(),
        )
        .unwrap();
    assert_eq!(
        cancelled.status(),
        rudder_runtime_core::RunStatus::Cancelled
    );
    assert_eq!(cancelled.result().error.as_ref().unwrap().code, "cancelled");
}

#[test]
fn terminal_cleanup_and_receipt_failures_never_map_to_success() {
    let machine = machine(OutputLimits::default());
    let adapter = RuntimeProcessAdapter::new(&machine, launch(), 10).unwrap();
    let outcome = adapter
        .map_terminal(
            &machine,
            10,
            ProcessHostTerminal::succeeded_without_cleanup()
                .with_authority(adapter.authority().clone()),
            ProcessHostOutput::default(),
        )
        .unwrap();
    assert_eq!(outcome.status(), rudder_runtime_core::RunStatus::Failed);
    assert_eq!(
        outcome.result().error.as_ref().unwrap().code,
        "process_group_cleanup_unproven"
    );
}

#[allow(dead_code)]
fn _assert_outcome_is_typed(_: RuntimeProcessOutcome) {}
