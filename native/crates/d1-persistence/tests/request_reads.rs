#![allow(dead_code)]
mod support;
use rudder_d1_persistence::{
    StoreError,
    request_reads::{RequestReadError, RequestReadInput, read_requests},
};
use serde_json::{Value, json};
use support::{CEO, Database, ORG, OTHER};

fn input(value: Value) -> RequestReadInput {
    serde_json::from_value(value).unwrap()
}

#[tokio::test]
async fn requests_preserve_winner_projection_and_attempt_scope_without_writes() {
    let db = Database::start().await;
    let id = "81000000-0000-4000-8000-000000000001";
    let approval = "81000000-0000-4000-8000-000000000002";
    sqlx::raw_sql(&format!(r#"
INSERT INTO requests (id,org_id,kind,subtype,title,prompt,updated_at) VALUES
('{id}','{OTHER}','assistance','issue_blocker','Input','Help','2026-10-12T01:00:00.900Z');
INSERT INTO approvals (id,org_id,type,status,payload,updated_at) VALUES
('{id}','{ORG}','hire_agent','approved','{{"password":"hidden"}}','2026-10-12T01:00:00Z'),
('{approval}','{OTHER}','hire_agent','rejected','{{"nested":{{"password":"hidden"}},"big":9007199254740993}}','2026-10-12T01:00:00.100Z');
INSERT INTO issues (id,org_id,title) VALUES ('82000000-0000-4000-8000-000000000001','{OTHER}','Audit');
INSERT INTO heartbeat_runs (id,org_id,agent_id,status) VALUES
('83000000-0000-4000-8000-000000000001','{OTHER}','{CEO}','succeeded'),
('83000000-0000-4000-8000-000000000002','{OTHER}','{CEO}','succeeded'),
('83000000-0000-4000-8000-000000000003','{OTHER}','{CEO}','succeeded');
INSERT INTO issue_block_audit_attempts (org_id,issue_id,request_id,run_id,root_run_id,agent_id,continuation_kind,failure_class,blocker_fingerprint,attempt_number,required_attempts,status_before,status_after,blocker_reason,requested_action) VALUES
('{OTHER}','82000000-0000-4000-8000-000000000001','{id}','83000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000001','{CEO}','initial','issue','fingerprint',2,3,'in_progress','in_progress','Input','Help'),
('{OTHER}','82000000-0000-4000-8000-000000000001','{id}','83000000-0000-4000-8000-000000000002','83000000-0000-4000-8000-000000000001','{CEO}','passive_issue_followup','issue','fingerprint',1,3,'in_progress','in_progress','Input','Help'),
('{ORG}','82000000-0000-4000-8000-000000000001','{id}','83000000-0000-4000-8000-000000000003','83000000-0000-4000-8000-000000000001','{CEO}','initial','issue','fingerprint',0,3,'in_progress','in_progress','Foreign','Hidden');
"#)).execute(&db.pool).await.unwrap();
    let snapshot = || {
        sqlx::query_scalar::<_, String>("SELECT jsonb_build_array((SELECT jsonb_agg(to_jsonb(t)) FROM requests t),(SELECT jsonb_agg(to_jsonb(t)) FROM approvals t),(SELECT jsonb_agg(to_jsonb(t)) FROM issue_block_audit_attempts t))::text").fetch_one(&db.pool)
    };
    let before = snapshot().await.unwrap();
    assert!(matches!(
        read_requests(
            &db.pool,
            ORG,
            &input(json!({"operation":"detail","requestId":id}))
        )
        .await,
        Err(RequestReadError::Store(StoreError::NotFound))
    ));
    let detail: Value = serde_json::from_str(
        &read_requests(
            &db.pool,
            OTHER,
            &input(json!({"operation":"detail","requestId":approval})),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(detail["id"], approval);
    assert_eq!(detail["status"], "rejected");
    assert_eq!(detail["requestStatus"], "resolved");
    assert_eq!(detail["payload"]["nested"]["password"], "***REDACTED***");
    assert_eq!(detail["payload"]["big"], 9007199254740992u64);
    let attempts: Value = serde_json::from_str(
        &read_requests(
            &db.pool,
            OTHER,
            &input(json!({"operation":"block-audit-attempts","requestId":id})),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(attempts.as_array().unwrap().len(), 2);
    assert_eq!(attempts[0]["attemptNumber"], 1);
    assert_eq!(attempts[1]["attemptNumber"], 2);
    assert!(matches!(
        read_requests(
            &db.pool,
            OTHER,
            &input(json!({"operation":"block-audit-attempts","requestId":approval}))
        )
        .await,
        Err(RequestReadError::NotAssistance)
    ));
    assert_eq!(snapshot().await.unwrap(), before);
}
