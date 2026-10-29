mod support;

use rudder_d1_persistence::{
    agent_core::{NativeAgentAccess, NativeAgentAuthorizer},
    agent_execution,
    issue_checkout::{IssueCheckoutRequest, execute_with_native_auth},
};
use sqlx::PgConnection;
use std::{future::Future, pin::Pin};
use support::{Database, ORG};

struct Authorized;
impl NativeAgentAuthorizer for Authorized {
    fn revalidate<'a>(
        &'a self,
        _: &'a mut PgConnection,
        _: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<NativeAgentAccess, sqlx::Error>> + Send + 'a>> {
        Box::pin(std::future::ready(Ok(NativeAgentAccess::Authorized)))
    }
}

#[tokio::test]
async fn issue_producers_admit_native_all_runtimes_and_resume_paused_without_crossing_cancel_fence()
{
    let db = Database::start().await;
    for (index, runtime) in [
        "claude_local",
        "codex_local",
        "cursor",
        "opencode_local",
        "pi_local",
        "hermes_local",
        "process",
        "http",
        "openclaw_gateway",
        "hermes_gateway",
    ]
    .iter()
    .enumerate()
    {
        let agent = uuid::Uuid::new_v4().to_string();
        let issue = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO agents(id,org_id,name,role,status,agent_runtime_type) VALUES($1::uuid,$2::uuid,$3,'general',$4,$5)")
            .bind(&agent).bind(ORG).bind(format!("Issue producer {runtime}")).bind(if index==0 {"paused"} else {"idle"}).bind(runtime).execute(&db.pool).await.unwrap();
        sqlx::query("INSERT INTO issues(id,org_id,title,status,identifier) VALUES($1::uuid,$2::uuid,'Producer checkout','todo','SYN-'||$1::text)").bind(&issue).bind(ORG).execute(&db.pool).await.unwrap();
        let (status, _) = execute_with_native_auth(
            &db.pool,
            "user",
            "synthetic-board",
            &Authorized,
            &IssueCheckoutRequest {
                org_id: ORG.into(),
                issue_id: issue.clone(),
                agent_id: agent.clone(),
                expected_statuses: vec!["todo".into()],
                actor_run_id: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(status, 200);
        let (authority, wake_status, before): (String,String,Option<String>)=sqlx::query_as("SELECT execution_authority,status,run_id::text FROM agent_wakeup_requests WHERE org_id=$1::uuid AND agent_id=$2::uuid").bind(ORG).bind(&agent).fetch_one(&db.pool).await.unwrap();
        assert_eq!(authority, "native_rust");
        if index == 0 {
            assert_eq!(wake_status, "deferred_agent_paused");
            assert!(before.is_none());
            sqlx::query("UPDATE agents SET status='idle' WHERE id=$1::uuid")
                .bind(&agent)
                .execute(&db.pool)
                .await
                .unwrap();
            agent_execution::resume_pending(&db.pool).await.unwrap();
        }
        let run: String=sqlx::query_scalar("SELECT run_id::text FROM agent_wakeup_requests WHERE org_id=$1::uuid AND agent_id=$2::uuid").bind(ORG).bind(&agent).fetch_one(&db.pool).await.unwrap();
        let claim = agent_execution::claim_queued_run(&db.pool, ORG, &run)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(claim.runtime_type, *runtime);
        assert_eq!(claim.issue_id.as_deref(), Some(issue.as_str()));
    }
    // A deferred assignment created before cancellation cannot launch after reopen.
    let agent = uuid::Uuid::new_v4().to_string();
    let issue = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO agents(id,org_id,name,role,status,agent_runtime_type) VALUES($1::uuid,$2::uuid,'Fenced producer','general','paused','process')").bind(&agent).bind(ORG).execute(&db.pool).await.unwrap();
    sqlx::query("INSERT INTO issues(id,org_id,title,status,identifier) VALUES($1::uuid,$2::uuid,'Fenced checkout','todo','SYN-'||$1::text)").bind(&issue).bind(ORG).execute(&db.pool).await.unwrap();
    execute_with_native_auth(
        &db.pool,
        "user",
        "synthetic-board",
        &Authorized,
        &IssueCheckoutRequest {
            org_id: ORG.into(),
            issue_id: issue.clone(),
            agent_id: agent.clone(),
            expected_statuses: vec!["todo".into()],
            actor_run_id: None,
        },
    )
    .await
    .unwrap();
    sqlx::query("UPDATE issues SET execution_cancellation_at=clock_timestamp() WHERE id=$1::uuid")
        .bind(&issue)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE agents SET status='idle' WHERE id=$1::uuid")
        .bind(&agent)
        .execute(&db.pool)
        .await
        .unwrap();
    agent_execution::resume_pending(&db.pool).await.unwrap();
    let state: (String, Option<String>) = sqlx::query_as(
        "SELECT status,run_id::text FROM agent_wakeup_requests WHERE agent_id=$1::uuid",
    )
    .bind(&agent)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(state, ("cancelled".into(), None));
}

#[tokio::test]
async fn queued_work_settles_after_pause_or_terminate_and_public_input_cannot_choose_goal_owner() {
    use agent_execution::{AgentExecutionActor, AgentWakeRequest};
    use serde_json::json;
    let db = Database::start().await;
    let actor = AgentExecutionActor {
        actor_type: "user",
        actor_id: "synthetic-board".into(),
        run_id: None,
    };
    for status in ["paused", "terminated"] {
        let agent = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO agents(id,org_id,name,role,status,agent_runtime_type) VALUES($1::uuid,$2::uuid,'Queued status producer','general','idle','process')").bind(&agent).bind(ORG).execute(&db.pool).await.unwrap();
        let request = AgentWakeRequest {
            organization_id: ORG.into(),
            agent_id: agent.clone(),
            source: "on_demand".into(),
            trigger_detail: Some("manual".into()),
            reason: None,
            payload: Some(json!({"_rudderExecutionProducer":"goal_start_v1"})),
            idempotency_key: None,
            context_snapshot: json!({"_rudderExecutionProducer":"goal_start_v1"}),
        };
        let admitted = agent_execution::admit(&db.pool, &Authorized, &actor, &request)
            .await
            .unwrap();
        let run = admitted.run_id.unwrap();
        let marker:String=sqlx::query_scalar("SELECT payload->>'_rudderExecutionProducer' FROM agent_wakeup_requests WHERE id=$1::uuid").bind(&admitted.wakeup_request_id).fetch_one(&db.pool).await.unwrap();
        assert_eq!(marker, "agent_wakeup_v1");
        sqlx::query("UPDATE agents SET status=$2 WHERE id=$1::uuid")
            .bind(&agent)
            .bind(status)
            .execute(&db.pool)
            .await
            .unwrap();
        assert!(
            agent_execution::claim_queued_run(&db.pool, ORG, &run)
                .await
                .unwrap()
                .is_none()
        );
        let state: (String, Option<String>) = sqlx::query_as(
            "SELECT status,execution_owner_token FROM heartbeat_runs WHERE id=$1::uuid",
        )
        .bind(&run)
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(state, ("cancelled".into(), None));
    }
    let agent = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO agents(id,org_id,name,role,status,agent_runtime_type) VALUES($1::uuid,$2::uuid,'Deferred terminated producer','general','paused','process')").bind(&agent).bind(ORG).execute(&db.pool).await.unwrap();
    let request = AgentWakeRequest {
        organization_id: ORG.into(),
        agent_id: agent.clone(),
        source: "on_demand".into(),
        trigger_detail: None,
        reason: None,
        payload: None,
        idempotency_key: None,
        context_snapshot: json!({}),
    };
    let deferred = agent_execution::admit(&db.pool, &Authorized, &actor, &request)
        .await
        .unwrap();
    assert_eq!(deferred.status, "deferred_agent_paused");
    sqlx::query("UPDATE agents SET status='terminated' WHERE id=$1::uuid")
        .bind(&agent)
        .execute(&db.pool)
        .await
        .unwrap();
    agent_execution::resume_pending(&db.pool).await.unwrap();
    let state: (String, Option<String>) =
        sqlx::query_as("SELECT status,run_id::text FROM agent_wakeup_requests WHERE id=$1::uuid")
            .bind(&deferred.wakeup_request_id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(state, ("skipped".into(), None));
}
