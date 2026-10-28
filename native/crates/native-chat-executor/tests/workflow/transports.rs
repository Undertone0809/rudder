//! Actual Native Chat admission/claim/finalization for the remaining transports.
use crate::fixture::*;
use rudder_d1_persistence::native_chat::{
    control::{StopRequest, request_stop},
    execution::{self, TransportCleanupProof},
};
use rudder_native_chat_executor::{NativeExecutionObservation, NativeTransportObservation};
use serde_json::{Value, json};
use std::{fs, os::unix::fs::PermissionsExt, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn finish(database: &Database, observation: NativeTransportObservation) -> Value {
    assert!(
        observation.terminal_ready,
        "actual local transport must have a persisted terminal observation"
    );
    let cleanup = observation.cleanup.as_ref().expect("actual cleanup proof");
    assert!(cleanup.matches(&observation.fence));
    execution::finalize_transport(
        &database.pool,
        &observation.execution_principal,
        &observation.fence,
        &observation.turn,
        cleanup,
        observation.stop.as_ref(),
    )
    .await
    .unwrap()
}

async fn snapshot(database: &Database, run: &str) -> Value {
    sqlx::query_scalar("SELECT jsonb_build_object('run',to_jsonb(r),'attempt',to_jsonb(a),'generation',to_jsonb(g),'segment',to_jsonb(s)) FROM heartbeat_runs r JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id JOIN native_segments s ON s.org_id=r.org_id AND s.id=(r.context_snapshot->>'nativeSegmentId')::uuid WHERE r.id=$1::uuid")
        .bind(run).fetch_one(&database.pool).await.unwrap()
}

async fn stop(database: &Database, run: &str) {
    let (generation,version):(String,i32)=sqlx::query_as("SELECT g.id::text,g.control_version FROM chat_generations g JOIN heartbeat_runs r ON r.chat_generation_id=g.id WHERE r.id=$1::uuid").bind(run).fetch_one(&database.pool).await.unwrap();
    request_stop(
        &database.pool,
        &verified_actor(),
        &StopRequest {
            conversation_id: CHAT.into(),
            generation_id: generation,
            control_action_id: uuid::Uuid::new_v4().to_string(),
            expected_attempt_epoch: 1,
            expected_control_version: version,
            requested_render_seq: 0,
            requested_body_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
                .into(),
        },
    )
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires disposable PostgreSQL and the prebuilt process host; synthetic process only"]
async fn chat_process_and_unknown_registry_fallback_use_real_claim_and_never_invent_a_session() {
    for runtime in ["process", "old-custom-process-name"] {
        let database = Database::start().await;
        let host = FixtureHost::new("complete");
        let script = host.probe_path("chat-process.sh");
        let prompt = host.probe_path("chat-process-input");
        fs::write(&script,format!("#!/bin/sh\ncat > '{}'\nprintf 'RUDDER_RESULT_BEGIN\\ntransport process complete\\nRUDDER_RESULT_END\\n'\n",prompt.display())).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let (actor, run, attempt) = admitted_with_runtime(
            &database,
            &host,
            runtime,
            json!({"command":script,"cwd":host.paths().isolated_home}),
        )
        .await;
        let (result, _host) =
            execute_native_on_worker(&database, host, actor, run.clone(), attempt).await;
        let NativeExecutionObservation::Transport(observation) = result.unwrap() else {
            panic!("wrong provider");
        };
        assert!(matches!(
            observation.cleanup,
            Some(TransportCleanupProof::Process(_))
        ));
        assert!(observation.turn.session_id.is_none());
        assert!(
            observation.turn.usage.is_none(),
            "process stdout is not billable token evidence"
        );
        finish(&database, observation).await;
        let submitted = fs::read_to_string(prompt).unwrap();
        assert!(submitted.contains(BODY));
        assert!(
            submitted.contains("old private history"),
            "stateless process receives scoped history"
        );
        let state = snapshot(&database, &run).await;
        assert_eq!(state["run"]["status"], "succeeded");
        assert!(state["segment"]["native_session_id"].is_null());
        assert!(state["attempt"]["provider_thread_id"].is_null());
        assert!(state["attempt"]["provider_turn_id"].is_null());
        assert!(!state["run"]["process_exited_at"].is_null());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires disposable PostgreSQL and prebuilt host path validation; real HTTP body/cancellation"]
async fn chat_http_result_settles_but_headers_only_stop_retains_unknown_remote_input() {
    for cancel in [false, true] {
        let database = Database::start().await;
        let host = FixtureHost::new("complete");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (sent, received) = tokio::sync::oneshot::channel();
        let peer = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0u8; 4096];
            let header_end = loop {
                let n = socket.read(&mut buffer).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buffer[..n]);
                if let Some(index) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    break index + 4;
                }
            };
            let headers = String::from_utf8_lossy(&bytes[..header_end]);
            let length: usize = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|s| s.trim().parse().unwrap())
                })
                .unwrap();
            while bytes.len() < header_end + length {
                let n = socket.read(&mut buffer).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buffer[..n]);
            }
            let body: Value =
                serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap();
            assert_eq!(body["context"]["chatMode"], true);
            assert!(
                body["context"]["chatPrompt"]
                    .as_str()
                    .unwrap()
                    .contains(BODY)
            );
            if cancel {
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nContent-Type: application/json\r\n\r\n").await.unwrap();
                socket.flush().await.unwrap();
                sent.send(()).unwrap();
                tokio::time::timeout(Duration::from_secs(5), async {
                    loop {
                        match socket.read(&mut buffer).await {
                            Ok(0) | Err(_) => break,
                            Ok(_) => (),
                        }
                    }
                })
                .await
                .expect("Stop must close unfinished body");
            } else {
                let body=json!({"text":"RUDDER_RESULT_BEGIN\nHTTP Chat complete\nRUDDER_RESULT_END","structured":{"actual":true}}).to_string();
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
                sent.send(()).unwrap();
            }
        });
        let (actor, run, attempt) = admitted_with_runtime(
            &database,
            &host,
            "http",
            json!({"url":format!("http://{address}/fixture"),"cwd":host.paths().isolated_home,"modelFallbacks":[{"agentRuntimeType":"process","model":"must-not-retry-unknown-input","config":{"command":"/bin/true","cwd":host.paths().isolated_home}}]}),
        )
        .await;
        let worker = spawn_native_executor_worker(&database, host, actor, run.clone(), attempt);
        received.await.unwrap();
        if cancel {
            stop(&database, &run).await;
        }
        let (result, _host) = tokio::time::timeout(Duration::from_secs(8), worker)
            .await
            .unwrap()
            .unwrap();
        let NativeExecutionObservation::Transport(observation) = result.unwrap() else {
            panic!("wrong provider");
        };
        assert!(matches!(
            observation.cleanup,
            Some(TransportCleanupProof::Request(_))
        ));
        if cancel {
            assert!(observation.stop.is_some());
        }
        if cancel {
            assert!(
                !observation.terminal_ready,
                "closing the local HTTP body does not prove remote cancellation"
            );
            assert_eq!(observation.turn.evidence["localRequestSettled"], true);
        } else {
            finish(&database, observation).await;
        }
        let state = snapshot(&database, &run).await;
        assert!(state["run"]["process_pid"].is_null());
        assert!(state["run"]["process_started_at"].is_null());
        assert!(state["run"]["process_exited_at"].is_null());
        assert!(state["segment"]["native_session_id"].is_null());
        assert_eq!(state["run"]["native_admission_hold"], cancel);
        if cancel {
            assert_eq!(state["attempt"]["protocol_phase"], "input_indeterminate");
        }
        let attempt_count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM heartbeat_run_attempts WHERE run_id=$1::uuid")
                .bind(&run)
                .fetch_one(&database.pool)
                .await
                .unwrap();
        assert_eq!(
            attempt_count, 1,
            "unknown accepted HTTP input must never launch the configured fallback"
        );
        peer.await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires disposable PostgreSQL and prebuilt process host; actual process-to-HTTP model fallback"]
async fn configured_fallback_changes_provider_only_after_failed_owned_process_settles() {
    for primary_mode in ["exit", "missing", "empty"] {
        let database = Database::start().await;
        let host = FixtureHost::new("complete");
        let script = host.probe_path("failed-primary.sh");
        fs::write(
            &script,
            "#!/bin/sh\ncat >/dev/null\nprintf 'failed primary output'\nexit 7\n",
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let peer = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0u8; 4096];
            let header_end = loop {
                let n = socket.read(&mut buffer).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buffer[..n]);
                if let Some(i) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    break i + 4;
                }
            };
            let headers = String::from_utf8_lossy(&bytes[..header_end]);
            let length: usize = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|v| v.trim().parse().unwrap())
                })
                .unwrap();
            while bytes.len() < header_end + length {
                let n = socket.read(&mut buffer).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buffer[..n]);
            }
            let body: Value =
                serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap();
            assert!(
                body["context"]["chatPrompt"]
                    .as_str()
                    .unwrap()
                    .contains(BODY)
            );
            let body = json!({"text":"RUDDER_RESULT_BEGIN\nbackup complete\nRUDDER_RESULT_END"})
                .to_string();
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let (actor,run,attempt)=admitted_with_runtime(&database,&host,"process",json!({"command":match primary_mode {"missing"=>json!("rudder-fixture-command-definitely-not-installed"),"empty"=>json!(""),_=>json!(script)},"model":"primary","cwd":host.paths().isolated_home,"modelFallbacks":[{"agentRuntimeType":"http","model":"backup","config":{"url":format!("http://{address}/fallback"),"cwd":host.paths().isolated_home}}]})).await;
        let (result, _host) =
            execute_native_on_worker(&database, host, actor, run.clone(), attempt.clone()).await;
        let NativeExecutionObservation::Transport(observation) = result.unwrap() else {
            panic!("expected configured transport fallback")
        };
        assert_eq!(observation.fence.runtime_type(), "http");
        assert_ne!(observation.fence.identity().attempt_id, attempt);
        assert!(
            observation
                .turn
                .final_text
                .as_deref()
                .unwrap()
                .contains("backup complete")
        );
        let attempts:Vec<(String,String,Option<String>)>=sqlx::query_as("SELECT runtime_type,status,model FROM heartbeat_run_attempts WHERE run_id=$1::uuid ORDER BY attempt_index").bind(&run).fetch_all(&database.pool).await.unwrap();
        assert_eq!(
            attempts,
            vec![
                ("process".into(), "failed".into(), Some("primary".into())),
                ("http".into(), "started".into(), Some("backup".into()))
            ]
        );
        let held: bool = sqlx::query_scalar(
            "SELECT native_admission_hold FROM heartbeat_runs WHERE id=$1::uuid",
        )
        .bind(&run)
        .fetch_one(&database.pool)
        .await
        .unwrap();
        assert!(held);
        if primary_mode != "exit" {
            let disposition:Option<String>=sqlx::query_scalar("SELECT result_json->'nativeChatLastAttempt'->>'inputDisposition' FROM heartbeat_runs WHERE id=$1::uuid").bind(&run).fetch_one(&database.pool).await.unwrap();
            assert_eq!(disposition.as_deref(), Some("not_submitted"));
        }
        finish(&database, observation).await;
        let state:(String,i64,i64)=sqlx::query_as("SELECT status,(SELECT count(*) FROM heartbeat_run_attempts WHERE run_id=r.id),(SELECT count(*) FROM chat_messages WHERE run_id=r.id AND role='assistant' AND superseded_at IS NULL) FROM heartbeat_runs r WHERE id=$1::uuid").bind(&run).fetch_one(&database.pool).await.unwrap();
        assert_eq!(state, ("succeeded".into(), 2, 1));
        peer.await.unwrap();
    }
}

struct AutomationAuthorizer;
impl rudder_d1_persistence::agent_core::NativeAgentAuthorizer for AutomationAuthorizer {
    fn revalidate<'a>(
        &'a self,
        _: &'a mut sqlx::PgConnection,
        org: &'a str,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<
                        rudder_d1_persistence::agent_core::NativeAgentAccess,
                        sqlx::Error,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(std::future::ready(Ok(if org == ORG {
            rudder_d1_persistence::agent_core::NativeAgentAccess::Authorized
        } else {
            rudder_d1_persistence::agent_core::NativeAgentAccess::Forbidden
        })))
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires disposable PostgreSQL and prebuilt process host; real Automation dispatch and one-call result repair"]
async fn automation_missing_sentinel_repairs_once_and_retains_original_answer_if_repair_fails() {
    for fail_repair in [false, true] {
        let database = Database::start().await;
        let host = FixtureHost::new("complete");
        let script = host.probe_path("automation-repair.sh");
        let calls = host.probe_path("automation-repair-calls");
        let repair_output = if fail_repair {
            "exit 7"
        } else {
            "printf 'RUDDER_RESULT_BEGIN\\nrepaired final answer\\nRUDDER_RESULT_END\\n'"
        };
        fs::write(&script,format!(r#"#!/bin/sh
printf 'call\n' >> '{}'
input=$(cat)
case "$input" in *'Rudder internal repair request:'*) {} ;; *) printf 'useful original answer' ;; esac
"#,calls.display(),repair_output)).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        sqlx::query("UPDATE agents SET agent_runtime_type='process',status='idle',workspace_key='codex-agent',agent_runtime_config=$3 WHERE org_id=$1::uuid AND id=$2::uuid")
            .bind(ORG).bind(CEO).bind(json!({"command":script,"cwd":host.paths().isolated_home})).execute(&database.pool).await.unwrap();
        let automation:String=sqlx::query_scalar("INSERT INTO automations(org_id,title,description,assignee_agent_id,output_mode,status,concurrency_policy,catch_up_policy) VALUES($1::uuid,'Native repair fixture','Complete the existing automation',$2::uuid,'chat_output','active','coalesce_if_active','skip_missed') RETURNING id::text").bind(ORG).bind(CEO).fetch_one(&database.pool).await.unwrap();
        let dispatched = rudder_d1_persistence::automation_execution::run_manual(
            &database.pool,
            &AutomationAuthorizer,
            rudder_d1_persistence::automation_management::Actor {
                kind: "user",
                id: "local-board",
                run_id: None,
                local_implicit: true,
            },
            &automation,
            &json!({}),
            &rudder_d1_persistence::automation_execution::Host {
                chat: Some(host.context()),
            },
        )
        .await
        .unwrap();
        assert_eq!(dispatched["status"], "running");
        let mut jobs = rudder_d1_persistence::native_chat::list_automation_jobs(&database.pool)
            .await
            .unwrap();
        assert_eq!(jobs.len(), 1);
        let (actor, run, attempt) = jobs.pop().unwrap().into_parts();
        let pool = database.pool.clone();
        let handle = tokio::runtime::Handle::current();
        let run_for_worker = run.clone();
        let (result,_host)=tokio::task::spawn_blocking(move ||{
            let cancelled=std::sync::atomic::AtomicBool::new(false);
            let observed=rudder_native_chat_executor::run_observed_native_with_request_actor_on_blocking_thread(&handle,&pool,actor,host.context(),&host.paths(),rudder_native_chat_executor::ExecutionRequest{organization_id:ORG,run_id:&run_for_worker,attempt_id:&attempt,timeout:Duration::from_secs(30),cancelled:&cancelled});
            (observed,host)
        }).await.unwrap();
        let NativeExecutionObservation::Transport(observation) = result.unwrap() else {
            panic!("expected process repair transport")
        };
        finish(&database, observation).await;
        rudder_d1_persistence::automation_execution::reconcile_chat_outputs(
            &database.pool,
            None,
            10.0 * 1024.0 * 1024.0,
        )
        .await
        .unwrap();
        let attempts:Vec<String>=sqlx::query_scalar("SELECT status FROM heartbeat_run_attempts WHERE run_id=$1::uuid ORDER BY attempt_index").bind(&run).fetch_all(&database.pool).await.unwrap();
        assert_eq!(
            attempts,
            vec![
                "succeeded",
                if fail_repair { "failed" } else { "succeeded" }
            ]
        );
        assert_eq!(fs::read_to_string(calls).unwrap().lines().count(), 2);
        let output:(String,String,String)=sqlx::query_as("SELECT ar.status,m.body,m.structured_payload->'automationChatRun'->>'status' FROM automation_runs ar JOIN chat_messages m ON m.org_id=ar.org_id AND m.id=ar.terminal_chat_message_id WHERE ar.id=$1::uuid").bind(dispatched["id"].as_str().unwrap()).fetch_one(&database.pool).await.unwrap();
        assert_eq!(
            output,
            (
                "completed".into(),
                if fail_repair {
                    "useful original answer"
                } else {
                    "repaired final answer"
                }
                .into(),
                "completed".into()
            )
        );
        let holds:(bool,bool)=sqlx::query_as("SELECT h.native_admission_hold,g.native_admission_hold FROM heartbeat_runs h JOIN chat_generations g ON g.id=h.chat_generation_id WHERE h.id=$1::uuid").bind(&run).fetch_one(&database.pool).await.unwrap();
        assert_eq!(holds, (false, false));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires disposable PostgreSQL and prebuilt host path validation; no provider launch"]
async fn prelaunch_failure_refuses_wrong_claim_permit_and_never_invents_process_exit() {
    let database = Database::start().await;
    let host = FixtureHost::new("complete");
    let (actor,run,attempt)=admitted_with_runtime(&database,&host,"process",json!({"command":"rudder-fixture-command-definitely-not-installed","cwd":host.paths().isolated_home})).await;
    let (result, _host) =
        execute_native_on_worker(&database, host, actor, run.clone(), attempt).await;
    let failure = match result {
        Err(failure) => failure,
        Ok(_) => panic!("missing command must fail before launch"),
    };
    assert!(failure.is_definitive_failure());
    assert_eq!(
        failure.process_disposition(),
        rudder_native_chat_executor::ProcessDisposition::NotLaunched
    );
    let fence = failure.fence().unwrap();
    let id = fence.identity();
    let principal = failure.execution_principal().unwrap();
    let wrong = rudder_codex_app_server::ConnectionLaunchPermit::from_claim(
        id.run_id.into(),
        id.attempt_id.into(),
        fence.run_execution_owner_token().into(),
        id.connection_epoch,
        "wrong-claim".into(),
    );
    assert!(
        execution::finalize_before_launch_failure(&database.pool, principal, fence, &wrong)
            .await
            .is_err()
    );
    let held: bool =
        sqlx::query_scalar("SELECT native_admission_hold FROM heartbeat_runs WHERE id=$1::uuid")
            .bind(&run)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert!(held);
    let settled = execution::finalize_before_launch_failure(
        &database.pool,
        principal,
        fence,
        failure.unspent_launch_permit().unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(settled["inputDisposition"], "not_submitted");
    let state = snapshot(&database, &run).await;
    assert_eq!(state["run"]["status"], "failed");
    assert_eq!(state["run"]["native_admission_hold"], false);
    assert!(state["run"]["process_pid"].is_null());
    assert!(state["run"]["process_started_at"].is_null());
    assert!(state["run"]["process_exited_at"].is_null());
}
