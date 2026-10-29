#![allow(dead_code)]
#[path = "../../../d1-persistence/tests/support/mod.rs"]
pub mod support;
use rudder_d1_persistence::agent_core::{NativeAgentAccess, NativeAgentAuthorizer};
pub use rudder_d1_persistence::agent_execution::{
    self, AgentExecutionActor, AgentRunClaim, AgentWakeRequest,
};
pub use rudder_native_chat_executor::agent_run::*;
pub use serde_json::{Value, json};
use sqlx::{PgConnection, Row};
pub use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use std::{future::Future, path::PathBuf, pin::Pin};
pub use support::{Database, ORG};

pub struct Board;
impl NativeAgentAuthorizer for Board {
    fn revalidate<'a>(
        &'a self,
        _connection: &'a mut PgConnection,
        org: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<NativeAgentAccess, sqlx::Error>> + Send + 'a>> {
        Box::pin(async move {
            Ok(if org == ORG {
                NativeAgentAccess::Authorized
            } else {
                NativeAgentAccess::Forbidden
            })
        })
    }
}
pub fn actor() -> AgentExecutionActor {
    AgentExecutionActor {
        actor_type: "user",
        actor_id: "agent-run-sdk-fixture".into(),
        run_id: None,
    }
}

/// Use production admission+claim; no test constructor can mint launch permits.
pub async fn claim(
    database: &Database,
    runtime: &str,
    config: &Value,
    context: Value,
) -> AgentRunClaim {
    let agent = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO agents(id,org_id,name,role,status,agent_runtime_type,agent_runtime_config,runtime_config) VALUES($1::uuid,$2::uuid,'Agent Run SDK fixture','general','idle',$3,$4::jsonb,'{}'::jsonb)")
        .bind(&agent).bind(ORG).bind(runtime).bind(config).execute(&database.pool).await.unwrap();
    let admitted = agent_execution::admit(
        &database.pool,
        &Board,
        &actor(),
        &AgentWakeRequest {
            organization_id: ORG.into(),
            agent_id: agent,
            source: "on_demand".into(),
            trigger_detail: Some("manual".into()),
            reason: Some("agent_run_sdk_fixture".into()),
            payload: Some(json!({})),
            idempotency_key: Some(uuid::Uuid::new_v4().to_string()),
            context_snapshot: context,
        },
    )
    .await
    .expect("production generic native admission");
    let run = admitted.run_id.expect("queued Run materialized");
    agent_execution::claim_queued_run(&database.pool, ORG, &run)
        .await
        .expect("production generic claim")
        .expect("claim mints the one-use execution authority")
}

pub struct Workspace {
    pub root: tempfile::TempDir,
    pub cwd: PathBuf,
    pub runtime: PathBuf,
}
impl Workspace {
    pub fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("cwd");
        let runtime = root.path().join("runtime");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&runtime).unwrap();
        Self { root, cwd, runtime }
    }
    pub fn request(&self, config: Value, context: Value) -> AgentRunRequest {
        AgentRunRequest {
            prompt: "Synthetic trusted Agent invocation".into(),
            context,
            config,
            cwd: self.cwd.clone(),
            process_host: std::env::var_os("RUDDER_TEST_PROCESS_HOST")
                .map(PathBuf::from)
                .unwrap_or_default(),
            runtime_root: self.runtime.clone(),
            env: BTreeMap::from([
                ("HOME".into(), self.cwd.to_string_lossy().into_owned()),
                ("PATH".into(), "/usr/bin:/bin".into()),
            ]),
            managed_args: Vec::new(),
            output: None,
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }
}

pub async fn snapshot(pool: &sqlx::PgPool, run: &str) -> Value {
    sqlx::query_scalar(
        "SELECT to_jsonb(r) FROM heartbeat_runs r WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(run)
    .fetch_one(pool)
    .await
    .unwrap()
}
pub async fn cancel(database: &Database, run: &str) {
    assert!(
        agent_execution::cancel(&database.pool, &Board, &actor(), ORG, run)
            .await
            .unwrap()
    );
}

pub async fn settle(
    database: &Database,
    claim: &AgentRunClaim,
    observation: &mut AgentRunExecutionObservation,
) {
    if let Some(code) = &observation.error_code {
        if !observation.result.is_object() {
            observation.result = json!({});
        }
        observation.result["errorCode"] = json!(code);
    }
    let status = match observation.state {
        AgentRunExecutionState::Succeeded => "succeeded",
        AgentRunExecutionState::Failed => "failed",
        AgentRunExecutionState::Cancelled => "cancelled",
        AgentRunExecutionState::TimedOut => "timed_out",
        state => panic!("unsettled observation {state:?}"),
    };
    let settled = match observation
        .cleanup_proof
        .as_ref()
        .expect("actual resource owner returned its proof")
    {
        AgentRunCleanupProof::Process(proof) => agent_execution::lifecycle::finalize(
            &database.pool,
            &claim.owned,
            status,
            observation.exit_code,
            observation.signal.as_deref(),
            &observation.usage,
            &observation.result,
            observation.error.as_deref(),
            proof,
        )
        .await
        .unwrap(),
        AgentRunCleanupProof::Request(proof) => agent_execution::lifecycle::finalize_request(
            &database.pool,
            &claim.owned,
            status,
            &observation.usage,
            &observation.result,
            observation.error.as_deref(),
            proof,
        )
        .await
        .unwrap(),
    };
    assert!(
        settled,
        "only the matching Run/Attempt proof may release ownership"
    );
    let row = snapshot(&database.pool, &claim.run_id).await;
    assert_eq!(row["status"], status);
    assert!(row["execution_owner_token"].is_null());
    assert!(row["execution_lease_expires_at"].is_null());
    assert!(!row["process_exited_at"].is_null());
    let attempt: String = sqlx::query(
        "SELECT status FROM heartbeat_run_attempts WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&claim.attempt_id)
    .fetch_one(&database.pool)
    .await
    .unwrap()
    .try_get("status")
    .unwrap();
    assert_eq!(attempt, status);
}
