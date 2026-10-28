//! Actual disposable database + installed native-host context preparation.
#[path = "../../../d1-persistence/tests/support/mod.rs"]
mod support;
use super::*;
use rudder_d1_persistence::{
    agent_core::{NativeAgentAccess, NativeAgentAuthorizer},
    agent_execution::{self, AgentExecutionActor, AgentWakeRequest},
};
use sqlx::PgConnection;
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, atomic::AtomicBool},
};
struct Board;
impl NativeAgentAuthorizer for Board {
    fn revalidate<'a>(
        &'a self,
        _: &'a mut PgConnection,
        org: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<NativeAgentAccess, sqlx::Error>> + Send + 'a>> {
        Box::pin(async move {
            Ok(if org == support::ORG {
                NativeAgentAccess::Authorized
            } else {
                NativeAgentAccess::Forbidden
            })
        })
    }
}
async fn claim(pool: &PgPool, config: &Value) -> AgentRunClaim {
    let agent = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO agents(id,org_id,name,role,status,agent_runtime_type,agent_runtime_config,runtime_config) VALUES($1::uuid,$2::uuid,'Context service fixture','general','idle','process',$3,'{}')")
        .bind(&agent).bind(support::ORG).bind(config).execute(pool).await.unwrap();
    let admission = agent_execution::admit(
        pool,
        &Board,
        &AgentExecutionActor {
            actor_type: "user",
            actor_id: "context-service-fixture".into(),
            run_id: None,
        },
        &AgentWakeRequest {
            organization_id: support::ORG.into(),
            agent_id: agent,
            source: "on_demand".into(),
            trigger_detail: Some("manual".into()),
            reason: Some("context_service_fixture".into()),
            payload: Some(json!({})),
            context_snapshot: json!({}),
            idempotency_key: Some(uuid::Uuid::new_v4().to_string()),
        },
    )
    .await
    .unwrap();
    agent_execution::claim_queued_run(pool, support::ORG, &admission.run_id.unwrap())
        .await
        .unwrap()
        .unwrap()
}
fn host(root: &std::path::Path) -> AgentRunContextHost {
    fixture_host(
        root,
        PathBuf::from(
            std::env::var_os("RUDDER_TEST_PROCESS_HOST").expect("prebuilt native process host"),
        ),
    )
}
fn fixture_host(root: &std::path::Path, process_host: PathBuf) -> AgentRunContextHost {
    let cwd = root.join("cwd");
    let operator = root.join("operator");
    fs::create_dir_all(&cwd).unwrap();
    fs::create_dir_all(&operator).unwrap();
    AgentRunContextHost {
        deployment_mode: "local_trusted".into(),
        environment: std::collections::BTreeMap::from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("HOME".into(), operator.to_string_lossy().into_owned()),
            (
                "CONTEXT_OPERATOR_ENV_FIXTURE".into(),
                "operator-host".into(),
            ),
        ]),
        desktop_brokers: Arc::new(crate::desktop_broker::DesktopBrokers::new().unwrap()),
        workspace: OrganizationWorkspaceHost {
            instance_root: root.to_string_lossy().into_owned(),
            workspace_home: root.join("workspaces").to_string_lossy().into_owned(),
            previous_documents_root: root.join("previous").to_string_lossy().into_owned(),
            friendly_workspace_home: false,
            hostname: "fixture".into(),
        },
        operator_home: operator,
        process_cwd: cwd,
        executable_search_path: "/usr/bin:/bin".into(),
        runtime_root: root.join("runtime"),
        rudder_cli: PathBuf::from("/usr/bin/false"),
        process_host,
        api_url: "http://127.0.0.1:1".into(),
        bundled_skills_root: None,
    }
}
#[test]
fn opencode_materialization_excludes_inherited_config_overrides_and_keeps_operator_env() {
    let root = tempfile::tempdir().unwrap();
    let host = fixture_host(root.path(), PathBuf::from("/usr/bin/false"));
    let artifacts = artifacts::InvocationArtifacts::create(
        &host.runtime_root,
        "10000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000001",
    )
    .unwrap();
    let skills = artifacts::MaterializedSkills {
        entries: Vec::new(),
        root: artifacts.root.join("skills"),
        prompt: String::new(),
        warnings: Vec::new(),
    };
    let instructions = artifacts
        .write("instructions.md", "fixture instructions")
        .unwrap();
    let mut config = json!({"env":{
        "OPENCODE_CONFIG_CONTENT":"injected inline config",
        "OPENCODE_CONFIG_DIR":"/operator/custom-config"
    }});
    let mut env = host.environment.clone();
    env.insert(
        "OPENCODE_CONFIG_CONTENT".into(),
        "inherited inline config".into(),
    );
    env.insert(
        "OPENCODE_CONFIG_DIR".into(),
        "/operator/inherited-config".into(),
    );
    artifacts::provision_core_mcp(
        "opencode_local",
        &mut config,
        &mut env,
        &host,
        &artifacts,
        &skills,
        &instructions,
        &root.path().join("managed"),
        &[],
    )
    .unwrap();
    for key in ["OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR"] {
        assert!(!env.contains_key(key));
        assert!(config["env"].get(key).is_none());
    }
    assert_eq!(env["CONTEXT_OPERATOR_ENV_FIXTURE"], "operator-host");
    let managed: Value =
        serde_json::from_str(&fs::read_to_string(&env["OPENCODE_CONFIG"]).unwrap()).unwrap();
    assert_eq!(managed["mcp"]["rudder-tools"]["command"][1], "mcp-server");
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires disposable PostgreSQL188 and prebuilt RUDDER_TEST_PROCESS_HOST"]
async fn ephemeral_service_and_failed_readiness_join_exact_owned_cleanup() {
    let db = support::Database::start().await;
    let root = tempfile::tempdir().unwrap();
    let host = host(root.path());
    let identity = NativeAgentJwtConfig {
        secret: "synthetic-context-key".into(),
        issuer: "rudder".into(),
        audience: "rudder-api".into(),
    };
    let cancel = Arc::new(AtomicBool::new(false));
    let config = json!({"command":"/bin/true","cwd":host.process_cwd,"env":{"HOME":host.operator_home},"workspaceRuntime":{"services":[{"name":"fixture","command":"test \"$CONTEXT_OPERATOR_ENV_FIXTURE\" = operator-host || exit 17; trap 'printf \"service eof marker\\n\"; exit 0' TERM; printf 'service started\\n'; while :; do sleep 1; done","lifecycle":"ephemeral"}]}});
    let owned = claim(&db.pool, &config).await;
    let (sender, mut receiver) = tokio::sync::mpsc::channel(128);
    let mut prepared =
        prepare_agent_run_invocation(&db.pool, &owned, &host, &identity, &cancel, Some(sender))
            .await
            .unwrap();
    assert!(prepared.preparation_requirements.is_empty());
    assert_eq!(prepared.service_lease.references.len(), 1);
    let service = prepared.service_lease.references[0].clone();
    let artifact = prepared.artifact_root.clone();
    let status: String = sqlx::query_scalar(
        "SELECT status FROM workspace_runtime_services WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(support::ORG)
    .bind(service["id"].as_str())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(status, "running");
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Some(rudder_native_chat_executor::agent_run::AgentRunOutput::Event {
                event,
                ..
            }) = receiver.recv().await
            {
                if event["chunk"]
                    .as_str()
                    .is_some_and(|v| v.contains("service started"))
                {
                    break;
                }
            }
        }
    })
    .await
    .expect("service has installed its shutdown trap");
    prepared.abort_before_provider(&db.pool).await.unwrap();
    drop(prepared);
    let mut stopped_output = String::new();
    while let Ok(rudder_native_chat_executor::agent_run::AgentRunOutput::Event { event, .. }) =
        receiver.try_recv()
    {
        stopped_output.push_str(event["chunk"].as_str().unwrap_or_default());
    }
    assert!(
        stopped_output.contains("service eof marker"),
        "{stopped_output}"
    );
    assert!(!artifact.exists());
    let status: String = sqlx::query_scalar(
        "SELECT status FROM workspace_runtime_services WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(support::ORG)
    .bind(service["id"].as_str())
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(status, "stopped");
    let id = service["id"].as_str().unwrap();
    let receipt = rudder_native_process_transport::read_unbound_cleanup_observation(
        &host.runtime_root.join("runtime-services").join(id),
        id,
        id,
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        receipt.process_id.unwrap().to_string(),
        service["providerRef"].as_str().unwrap()
    );
    assert!(owned.owned.launch_permit_unspent());
    let failure = json!({"command":"/bin/true","cwd":host.process_cwd,"env":{"HOME":host.operator_home},"workspaceRuntime":{"services":[{"name":"not-ready","command":"exit 4","lifecycle":"ephemeral","readiness":{"type":"http","urlTemplate":"http://127.0.0.1:1/ready","timeoutSec":1,"intervalMs":100}}]}});
    let owned = claim(&db.pool, &failure).await;
    assert!(
        prepare_agent_run_invocation(&db.pool, &owned, &host, &identity, &cancel, None)
            .await
            .is_err()
    );
    assert!(
        !host
            .runtime_root
            .join("agent-context")
            .join(&owned.run_id)
            .join(&owned.attempt_id)
            .exists()
    );
    let running:i64=sqlx::query_scalar("SELECT count(*) FROM workspace_runtime_services WHERE org_id=$1::uuid AND status IN('starting','running')").bind(support::ORG).fetch_one(&db.pool).await.unwrap();
    assert_eq!(running, 0);
}
