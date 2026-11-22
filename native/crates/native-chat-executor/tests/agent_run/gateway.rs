//! Real Hermes session/run/event/approval HTTP peer and durable D1 approval rows.
use super::fixture::*;
use actix_web::{App, HttpRequest, HttpResponse, HttpServer, web};
use futures_util::{StreamExt, stream};
use std::{net::TcpListener, sync::Mutex};

const SESSION: &str = "provider session/one";
const UPSTREAM: &str = "provider-run";
struct Peer {
    choice: Mutex<Option<String>>,
    stopped: AtomicBool,
    changed: tokio::sync::Notify,
    calls: Mutex<Vec<Value>>,
}
async fn gateway(peer: web::Data<Peer>, request: HttpRequest, body: web::Bytes) -> HttpResponse {
    assert_eq!(
        request
            .headers()
            .get("authorization")
            .and_then(|value| value.to_str().ok()),
        Some("Bearer synthetic-gateway-token")
    );
    let value = serde_json::from_slice::<Value>(&body).unwrap_or(Value::Null);
    peer.calls
        .lock()
        .unwrap()
        .push(json!({"method":request.method().as_str(),"path":request.uri().path(),"body":value}));
    match (request.method().as_str(),request.uri().path()) {
        ("POST","/fixture/api/sessions")=>HttpResponse::Ok().json(json!({"session":{"id":SESSION}})),
        ("GET","/fixture/api/sessions/provider%20session%2Fone/messages")=>HttpResponse::Ok().json(json!({"session_id":SESSION,"data":[]})),
        ("POST","/fixture/v1/runs")=>{
            assert_eq!(value["session_id"],SESSION);
            assert!(value["input"].as_str().unwrap().contains("RUDDER_TOOL_CONTEXT_V1"));
            assert!(value["input"].as_str().unwrap().contains(SESSION),"projection must use actual ensured provider session");
            HttpResponse::Ok().json(json!({"run_id":UPSTREAM,"status":"running"}))
        },
        ("GET","/fixture/v1/runs/provider-run/events")=>{
            let first=stream::once(async {Ok::<_,actix_web::Error>(web::Bytes::from_static(b"data: {\"event\":\"approval.request\",\"approval_id\":\"provider-approval\",\"tool\":\"synthetic_tool\",\"tool_call_id\":\"call\"}\n\n"))});
            let second=stream::once(async move {
                loop {let changed=peer.changed.notified();if peer.choice.lock().unwrap().is_some()||peer.stopped.load(Ordering::Acquire){break;}changed.await;}
                let choice=peer.choice.lock().unwrap().clone();
                let terminal=if peer.stopped.load(Ordering::Acquire){json!({"event":"run.cancelled"})}else if choice.as_deref()==Some("once"){json!({"event":"run.completed","usage":{"input_tokens":18,"output_tokens":4},"model":"synthetic-hermes-model"})}else{json!({"event":"run.failed","error":"denied by operator"})};
                let prefix=if choice.as_deref()==Some("once") {"data: {\"event\":\"message.delta\",\"delta\":\"continued after approval\"}\n\n"}else{""};
                Ok::<_,actix_web::Error>(web::Bytes::from(format!("{prefix}data: {terminal}\n\n")))
            });
            HttpResponse::Ok().content_type("text/event-stream").streaming(first.chain(second))
        },
        ("POST","/fixture/v1/runs/provider-run/approval")=>{
            let choice=value["choice"].as_str().unwrap();assert!(["once","deny"].contains(&choice));
            *peer.choice.lock().unwrap()=Some(choice.into());peer.changed.notify_waiters();
            HttpResponse::Ok().json(json!({"status":"running"}))
        },
        ("POST","/fixture/v1/runs/provider-run/stop")=>{
            peer.stopped.store(true,Ordering::Release);peer.changed.notify_waiters();HttpResponse::Ok().json(json!({"status":"stopped"}))
        },
        ("GET","/fixture/v1/runs/provider-run")=>HttpResponse::Ok().json(json!({"status":if peer.stopped.load(Ordering::Acquire){"stopped"}else if peer.choice.lock().unwrap().is_some(){"completed"}else{"running"}})),
        _=>HttpResponse::InternalServerError().json(json!({"error":"unexpected extra fixture request"})),
    }
}

#[actix_web::test]
#[ignore = "requires disposable PostgreSQL including migration188; real loopback Hermes approval peer"]
async fn hermes_durable_approval_once_deny_and_cancel_preserve_continuation_and_stop_evidence() {
    let database = Database::start().await;
    for expected in [
        Some(AgentRunApprovalChoice::Once),
        Some(AgentRunApprovalChoice::Deny),
        None,
    ] {
        let workspace = Workspace::new();
        let peer = Arc::new(Peer {
            choice: Mutex::new(None),
            stopped: AtomicBool::new(false),
            changed: tokio::sync::Notify::new(),
            calls: Mutex::new(Vec::new()),
        });
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = HttpServer::new({
            let peer = peer.clone();
            move || {
                App::new()
                    .app_data(web::Data::from(peer.clone()))
                    .default_service(web::to(gateway))
            }
        })
        .workers(1)
        .shutdown_timeout(1)
        .listen(listener)
        .unwrap()
        .run();
        let control = server.handle();
        let server = actix_web::rt::spawn(server);
        let config = json!({"url":format!("http://{address}/fixture"),"apiKey":"synthetic-gateway-token","timeoutSec":10,"rudderToolContextProjection":{"version":"RUDDER_TOOL_CONTEXT_V1","transcriptHash":"synthetic-hash","events":[]}});
        let claim = claim(&database, "hermes_gateway", &config, json!({})).await;
        let run = claim.run_id.clone();
        let observer = claim.owned.observer();
        let (output, mut incoming) = tokio::sync::mpsc::channel(32);
        let mut request = workspace.request(config, json!({}));
        request.output = Some(output);
        let mut worker = tokio::spawn(execute_agent_run(database.pool.clone(), claim, request));
        let mut approval_id = None;
        let mut withheld = None;
        let mut transcript = Vec::new();
        let (claim,mut observation)=tokio::time::timeout(Duration::from_secs(15),async {
            loop {tokio::select! {
                result=&mut worker=>break result.unwrap().unwrap(),
                Some(output)=incoming.recv()=>match output {
                    AgentRunOutput::ApprovalRequest {offset,provider_run_id,session_id,event,reply,..}=>{
                        assert_eq!(provider_run_id,UPSTREAM);assert_eq!(session_id,SESSION);assert!(peer.choice.lock().unwrap().is_none(),"provider must not receive an implicit decision");
                        let approval=agent_execution::create_runtime_approval(&database.pool,&observer,"hermes_gateway",&format!("{}:{offset}",observer.attempt_id()),&json!({"provider":"hermes","runtimeType":"hermes_gateway","upstreamRunId":provider_run_id,"sessionId":session_id,"event":event,"choices":["once","deny"]})).await.unwrap();
                        assert_eq!(approval.status,"pending");assert_eq!(agent_execution::read_runtime_approval(&database.pool,&observer,&approval.id).await.unwrap().status,"pending");approval_id=Some(approval.id.clone());
                        let before=snapshot(&database.pool,&run).await;assert_eq!(before["status"],"running");assert!(before["process_pid"].is_null());
                        if let Some(choice)=expected {
                            // Disposable operator decision fixture. Public approval ingress is a
                            // separate Foundation acceptance case; this is a real persisted row.
                            let status=if choice==AgentRunApprovalChoice::Once{"approved"}else{"rejected"};
                            sqlx::query("UPDATE approvals SET status=$3,decision_note='Synthetic operator decision',decided_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid").bind(ORG).bind(&approval.id).bind(status).execute(&database.pool).await.unwrap();
                            assert_eq!(agent_execution::read_runtime_approval(&database.pool,&observer,&approval.id).await.unwrap().status,status);
                            reply.send(AgentRunApprovalDecision {approval_id:Some(approval.id),choice:Some(choice),error:None}).unwrap_or_else(|_|panic!("provider approval receiver ended before the actual decision"));
                        }else{cancel(&database,&run).await;withheld=Some(reply);}
                    },
                    AgentRunOutput::Event {event,..}=>transcript.extend(parse_agent_provider_event("hermes_gateway",&event,"2026-10-28T00:00:00Z")),
                    _=>(),
                }
            }}
        }).await.unwrap();
        assert_eq!(observation.session_id.as_deref(), Some(SESSION));
        assert!(matches!(
            observation.cleanup_proof,
            Some(AgentRunCleanupProof::Request(_))
        ));
        match expected {
            Some(choice) => {
                assert_eq!(observation.result["approval"]["resolved"], true);
                assert_eq!(
                    observation.result["approval"]["rudderApprovalId"],
                    json!(approval_id)
                );
                assert_eq!(
                    peer.choice.lock().unwrap().as_deref(),
                    Some(if choice == AgentRunApprovalChoice::Once {
                        "once"
                    } else {
                        "deny"
                    })
                );
                if choice == AgentRunApprovalChoice::Once {
                    assert_eq!(observation.state, AgentRunExecutionState::Succeeded);
                    assert_eq!(observation.usage["inputTokens"].as_i64(), Some(18));
                    assert!(transcript.iter().any(|entry| entry["kind"] == "assistant"
                        && entry["text"] == "continued after approval"));
                } else {
                    assert_eq!(observation.state, AgentRunExecutionState::Failed);
                }
            }
            None => {
                assert_eq!(observation.state, AgentRunExecutionState::Cancelled);
                assert!(peer.stopped.load(Ordering::Acquire));
                assert!(peer.choice.lock().unwrap().is_none());
                assert_eq!(observation.result["remoteCancellationAccepted"], true);
                assert_eq!(observation.result["remoteCancellationVerified"], true);
                assert_eq!(observation.result["approval"]["resolved"], false);
            }
        }
        drop(withheld);
        settle(&database, &claim, &mut observation).await;
        control.stop(true).await;
        server.await.unwrap().unwrap();
    }
}
