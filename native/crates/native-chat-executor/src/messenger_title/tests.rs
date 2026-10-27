use super::*;
use serde_json::json;
fn request() -> Request {
    let workspace = Workspace::create().unwrap();
    let mut env = BTreeMap::new();
    for key in [
        "PATH",
        "HOME",
        "USERPROFILE",
        "SYSTEMROOT",
        "SystemRoot",
        "TEMP",
        "TMP",
    ] {
        if let Ok(value) = std::env::var(key) {
            env.insert(key.into(), value);
        }
    }
    Request {
        cwd: workspace.path().to_path_buf(),
        runtime_root: workspace.path().to_path_buf(),
        workspace_guard: workspace,
        org_id: uuid::Uuid::new_v4().to_string(),
        run_id: format!("product-intelligence-{}", uuid::Uuid::new_v4()),
        prompt: "Generate this exact synthetic title prompt.".into(),
        process_host: std::env::var_os("RUDDER_TEST_PROCESS_HOST")
            .map(PathBuf::from)
            .expect("RUDDER_TEST_PROCESS_HOST"),
        env,
        cancelled: Arc::new(AtomicBool::new(false)),
    }
}
#[tokio::test]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST and Node in PATH; no database or model service"]
async fn title_process_receives_prompt_exits_and_cleans_its_workspace() {
    let request = request();
    let dir = request.cwd.clone();
    let script = "const fs=require('fs');const input=fs.readFileSync(0,'utf8');if(input!==process.env.EXPECTED_TITLE_PROMPT)process.exit(23);process.stdout.write('Actual process title');";
    let config = json!({"command":"node","args":["-e",script],"env":{"EXPECTED_TITLE_PROMPT":request.prompt},"timeoutSec":10,"graceSec":1});
    let output = execute("process", &config, &request).await.unwrap();
    assert!(output.success);
    assert_eq!(output.text, "Actual process title");
    assert!(dir.is_dir());
    drop(request);
    assert!(!dir.exists());
}
#[tokio::test]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST and Node in PATH; no database or model service"]
async fn title_timeout_and_disconnect_reap_before_workspace_guard_is_released() {
    for cancelled in [false, true] {
        let request = request();
        let dir = request.cwd.clone();
        let flag = request.cancelled.clone();
        let config = json!({"command":"node","args":["-e","process.stdin.resume();setInterval(()=>{},1000)"],"timeoutSec":0.2,"graceSec":0.1});
        if cancelled {
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(80));
                flag.store(true, Ordering::Release);
            });
        }
        let result = execute("process", &config, &request).await;
        assert!(matches!(result, Err(Error::Timeout | Error::Cancelled)));
        drop(request);
        assert!(!dir.exists());
    }
}
#[test]
fn shared_network_classification_preserves_fallback_boundary() {
    assert!(local::network(
        "getaddrinfo ENOTFOUND provider.invalid",
        false
    ));
    assert!(local::network(
        "stream disconnected before completion",
        false
    ));
    for message in [
        "401 Unauthorized: connection closed",
        "quota exceeded: connection reset",
        "provider 503 service unavailable",
        "MCP tool network connection closed",
        "invalid model: fetch failed",
    ] {
        assert!(!local::network(message, false), "{message}");
    }
    assert!(!local::network("connection reset", true));
}
