use super::fixture::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires disposable PostgreSQL including migration188; real loopback body-stalled HTTP peer"]
async fn headers_received_body_stalled_cancel_settles_request_and_never_records_a_pid() {
    let database = Database::start().await;
    let workspace = Workspace::new();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (headers_sent, headers_received) = tokio::sync::oneshot::channel();
    let peer = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0_u8; 1024];
        loop {
            let count = socket.read(&mut buffer).await.unwrap();
            assert!(count > 0);
            request.extend_from_slice(&buffer[..count]);
            if request.windows(4).any(|value| value == b"\r\n\r\n") {
                break;
            }
        }
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nContent-Type: application/json\r\n\r\n",
            )
            .await
            .unwrap();
        socket.flush().await.unwrap();
        headers_sent.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match socket.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => (),
                }
            }
        })
        .await
        .expect("cancel must close the unfinished response connection");
    });
    let config = json!({"url":format!("http://{address}/body-stalled"),"timeoutMs":0});
    let claim = claim(&database, "http", &config, json!({"marker":"body-stall"})).await;
    let run = claim.run_id.clone();
    let pool = database.pool.clone();
    let request = workspace.request(config, json!({"marker":"body-stall"}));
    let worker = tokio::spawn(execute_agent_run(pool, claim, request));
    tokio::time::timeout(Duration::from_secs(5), headers_received)
        .await
        .unwrap()
        .unwrap();
    let during = snapshot(&database.pool, &run).await;
    assert_eq!(during["status"], "running");
    assert!(during["process_pid"].is_null());
    assert!(during["process_started_at"].is_null());
    cancel(&database, &run).await;
    let (claim, mut observation) = tokio::time::timeout(Duration::from_secs(5), worker)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(observation.state, AgentRunExecutionState::Cancelled);
    assert!(matches!(
        observation.cleanup_proof,
        Some(AgentRunCleanupProof::Request(_))
    ));
    settle(&database, &claim, &mut observation).await;
    let after = snapshot(&database.pool, &run).await;
    assert!(after["process_pid"].is_null());
    assert!(after["process_started_at"].is_null());
    peer.await.unwrap();
}
