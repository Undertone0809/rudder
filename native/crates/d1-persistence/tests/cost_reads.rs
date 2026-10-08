#![allow(dead_code)]
mod support;
use rudder_d1_persistence::{
    StoreError,
    cost_reads::{CostReadInput, read_costs},
};
use serde_json::{Value, json};
use support::{CEO, Database, FOREIGN_PROJECT, ORG, OTHER, PROJECT};

fn input(operation: &str) -> CostReadInput {
    serde_json::from_value(json!({"operation":operation})).unwrap()
}
async fn read(db: &Database, operation: &str) -> Value {
    serde_json::from_str(&read_costs(&db.pool, ORG, &input(operation)).await.unwrap()).unwrap()
}

#[tokio::test]
async fn cost_reads_real_postgres_aggregation_scope_dates_and_projection() {
    let db = Database::start().await;
    sqlx::raw_sql(&format!(r#"
UPDATE organizations SET budget_monthly_cents=10000 WHERE id='{ORG}';
INSERT INTO agents (id,org_id,name,role,status) VALUES ('50000000-0000-4000-8000-000000000002','{OTHER}','Foreign','general','idle');
INSERT INTO heartbeat_runs (id,org_id,agent_id,status,started_at,finished_at) VALUES
 ('60000000-0000-4000-8000-000000000001','{ORG}','{CEO}','succeeded','2024-02-29T00:00:00Z','2024-03-01T02:00:00Z'),
 ('60000000-0000-4000-8000-000000000002','{OTHER}','50000000-0000-4000-8000-000000000002','succeeded','2024-02-29T00:00:00Z','2024-03-01T02:00:00Z');
INSERT INTO issues (id,org_id,project_id,title) VALUES
 ('70000000-0000-4000-8000-000000000001','{ORG}','{PROJECT}','Attribution'),
 ('70000000-0000-4000-8000-000000000002','{OTHER}','{FOREIGN_PROJECT}','Foreign attribution');
INSERT INTO activity_log (org_id,actor_type,actor_id,action,entity_type,entity_id,run_id,created_at) VALUES
 ('{ORG}','agent','{CEO}','issue.updated','issue','70000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','2024-03-01T00:00:00Z'),
 ('{OTHER}','agent','foreign','issue.updated','issue','70000000-0000-4000-8000-000000000002','60000000-0000-4000-8000-000000000001','2024-03-02T00:00:00Z');
INSERT INTO cost_events (org_id,agent_id,heartbeat_run_id,provider,biller,billing_type,model,input_tokens,cached_input_tokens,output_tokens,cost_cents,occurred_at) VALUES
 ('{ORG}','{CEO}','60000000-0000-4000-8000-000000000001','Anthropic','claude','subscription_included','a',100,20,10,100,'2024-02-29T00:00:00Z'),
 ('{ORG}','{CEO}','60000000-0000-4000-8000-000000000001','openai','openai','metered_api','b',200,30,40,200,'2024-03-01T00:00:00Z'),
 ('{ORG}','{CEO}',NULL,'claude','claude','subscription_overage','c',0,0,0,50,'2024-03-02T00:00:00Z'),
 ('{OTHER}','50000000-0000-4000-8000-000000000002',NULL,'foreign','foreign','metered_api','secret',999,999,999,999,'2024-03-01T00:00:00Z');
INSERT INTO finance_events (org_id,event_kind,direction,biller,amount_cents,estimated,occurred_at,created_at,metadata_json) VALUES
 ('{ORG}','subscription','debit','claude',300,true,'2024-03-01T00:00:00Z','2024-03-01T00:00:00Z','{{"snake_key":true,"huge":9007199254740993}}'),
 ('{ORG}','refund','credit','claude',25,false,'2024-03-01T00:00:00Z','2024-03-01T00:00:01Z',NULL),
 ('{ORG}','usage','debit','openai',100,false,'2024-03-02T00:00:00Z','2024-03-02T00:00:00Z',NULL),
 ('{OTHER}','foreign','debit','foreign',999,false,'2024-03-01T00:00:00Z','2024-03-01T00:00:00Z',NULL);
"#)).execute(&db.pool).await.unwrap();
    let baseline = db.counts().await;
    let summary = read(&db, "summary").await;
    assert_eq!(
        summary,
        json!({"orgId":ORG,"spendCents":350,"budgetCents":10000,"utilizationPercent":3.5,
        "inputTokens":320,"cachedInputTokens":50,"outputTokens":50,"totalTokens":370,
        "eventCount":3,"tokenEventCount":2,"activeDurationMs":93600000})
    );
    let agent = read(&db, "by-agent").await;
    assert_eq!(agent[0]["agentId"], CEO);
    assert_eq!(agent[0]["apiRunCount"], 1);
    assert_eq!(agent[0]["subscriptionRunCount"], 1);
    assert_eq!(agent[0]["subscriptionInputTokens"], 120);
    assert_eq!(agent[0]["cachedInputTokenSemantics"], "included_in_input");
    assert_eq!(
        read(&db, "by-agent-model").await.as_array().unwrap().len(),
        3
    );
    assert_eq!(read(&db, "by-provider").await[0]["provider"], "openai");
    assert_eq!(read(&db, "by-biller").await[0]["biller"], "openai");
    let project = read(&db, "by-project").await;
    assert_eq!(project[0]["projectId"], PROJECT);
    assert_eq!(project[0]["costCents"], 300);
    assert_eq!(project[1]["projectId"], Value::Null);
    assert_eq!(read(&db, "trend").await[0]["date"], "2024-02-29");
    let mut selection = input("trend");
    selection.from_ms = Some(1709164800000); // inclusive Feb 29 UTC
    selection.to_ms = Some(1709251200000); // inclusive Mar 1 UTC
    selection.agent_id = Some(CEO.to_owned());
    selection.project_id = Some(PROJECT.to_owned());
    let trend: Value =
        serde_json::from_str(&read_costs(&db.pool, ORG, &selection).await.unwrap()).unwrap();
    assert_eq!(trend.as_array().unwrap().len(), 2);
    assert_eq!(trend[0]["totalTokens"], 130);
    selection.operation = serde_json::from_value(json!("summary")).unwrap();
    let clipped: Value =
        serde_json::from_str(&read_costs(&db.pool, ORG, &selection).await.unwrap()).unwrap();
    assert_eq!(clipped["spendCents"], 300);
    assert_eq!(clipped["activeDurationMs"], 86400000);
    assert_eq!(read(&db, "window-spend").await, json!([]));
    assert_eq!(
        read(&db, "finance-summary").await,
        json!({"orgId":ORG,"debitCents":400,"creditCents":25,"netCents":375,"estimatedDebitCents":300,"eventCount":3})
    );
    assert_eq!(read(&db, "finance-by-biller").await[0]["netCents"], 275);
    assert_eq!(
        read(&db, "finance-by-kind").await[0]["eventKind"],
        "subscription"
    );
    let events = read(&db, "finance-events").await;
    assert_eq!(events[1]["eventKind"], "refund");
    assert_eq!(events[2]["occurredAt"], "2024-03-01T00:00:00.000Z");
    assert_eq!(
        events[2]["metadataJson"],
        json!({"snake_key":true,"huge":9007199254740992u64})
    );
    assert_eq!(events[2]["agentId"], Value::Null);
    assert_eq!(
        db.counts().await,
        baseline,
        "reads must not mutate receipts, activity or ownership"
    );
}

#[tokio::test]
async fn cost_reads_empty_unknown_and_large_sums_have_no_i32_overflow() {
    let db = Database::start().await;
    for operation in [
        "by-agent",
        "trend",
        "by-agent-model",
        "by-provider",
        "by-biller",
        "by-project",
        "window-spend",
        "finance-by-biller",
        "finance-by-kind",
        "finance-events",
    ] {
        assert_eq!(read(&db, operation).await, json!([]), "{operation}");
    }
    assert_eq!(read(&db, "summary").await["spendCents"], 0);
    assert_eq!(read(&db, "finance-summary").await["eventCount"], 0);
    assert!(matches!(
        read_costs(
            &db.pool,
            "10000000-0000-4000-8000-000000000099",
            &input("summary")
        )
        .await,
        Err(StoreError::NotFound)
    ));
    sqlx::raw_sql(&format!(r#"
INSERT INTO cost_events (org_id,agent_id,provider,biller,billing_type,model,input_tokens,cached_input_tokens,output_tokens,cost_cents,occurred_at)
 SELECT '{ORG}','{CEO}','anthropic',CASE WHEN n=1 THEN 'a' ELSE 'b' END,'metered_api','big',2000000000,2000000000,2000000000,2000000000,CURRENT_TIMESTAMP FROM generate_series(1,3) n;
INSERT INTO finance_events (org_id,event_kind,biller,amount_cents,occurred_at)
 SELECT '{ORG}','usage','big',2000000000,CURRENT_TIMESTAMP FROM generate_series(1,3);
"#)).execute(&db.pool).await.unwrap();
    let summary = read(&db, "summary").await;
    assert_eq!(summary["spendCents"], 6000000000u64);
    assert_eq!(summary["inputTokens"], 12000000000u64);
    assert_eq!(summary["totalTokens"], 18000000000u64);
    assert_eq!(
        read(&db, "finance-summary").await["debitCents"],
        6000000000u64
    );
    let windows = read(&db, "window-spend").await;
    assert_eq!(windows.as_array().unwrap().len(), 3);
    assert_eq!(windows[0]["window"], "5h");
    assert_eq!(windows[0]["biller"], "mixed");
    assert_eq!(windows[2]["windowHours"], 168);
    assert_eq!(
        read(&db, "by-agent").await[0]["apiRunCount"],
        0,
        "NULL runs are not counted"
    );
}

#[tokio::test]
async fn finance_opaque_metadata_dates_and_exact_far_future_bounds() {
    let db = Database::start().await;
    let deep = format!("{}1{}", "[".repeat(600), "]".repeat(600));
    sqlx::query("INSERT INTO finance_events (org_id,event_kind,biller,amount_cents,occurred_at,created_at,metadata_json) VALUES ($1::uuid,'deep','test',1,'10000-01-01 00:00:00Z','1969-12-31 23:59:59.999999Z',$2::jsonb)")
        .bind(ORG).bind(&deep).execute(&db.pool).await.unwrap();
    let raw = read_costs(&db.pool, ORG, &input("finance-events"))
        .await
        .unwrap();
    assert!(raw.contains("+010000-01-01T00:00:00.000Z"));
    assert!(raw.contains("1969-12-31T23:59:59.999Z"));
    assert!(raw.contains(&deep));
    sqlx::raw_sql(&format!(
        r#"
INSERT INTO cost_events (org_id,agent_id,provider,model,cost_cents,occurred_at) VALUES
 ('{ORG}','{CEO}','openai','edge',1,'9999-12-31T23:59:59.999Z'),
 ('{ORG}','{CEO}','openai','outside',100,'9999-12-31T23:59:59.999008Z');
"#
    ))
    .execute(&db.pool)
    .await
    .unwrap();
    let mut selection = input("summary");
    selection.from_ms = Some(253402300799999);
    selection.to_ms = selection.from_ms;
    let result: Value =
        serde_json::from_str(&read_costs(&db.pool, ORG, &selection).await.unwrap()).unwrap();
    assert_eq!(
        result["spendCents"], 1,
        "the inclusive millisecond boundary must not drift by microseconds"
    );
    assert_eq!(result["eventCount"], 1);
    let mut selection = input("trend");
    selection.agent_id = Some(CEO.replace('-', ""));
    assert!(
        read_costs(&db.pool, ORG, &selection).await.is_ok(),
        "PostgreSQL compact UUIDs remain supported"
    );
    selection.agent_id = Some("invalid".to_owned());
    assert!(matches!(
        read_costs(&db.pool, ORG, &selection).await,
        Err(StoreError::Database(_))
    ));
}

#[tokio::test]
async fn finance_date_context_is_bound_read_only_and_transaction_local() {
    let db = Database::start().await;
    sqlx::query("INSERT INTO finance_events (org_id,event_kind,biller,amount_cents,occurred_at,created_at) VALUES ($1::uuid,'date','test',1,'0012-02-01 00:00:00Z','0032-01-01 00:00:00Z')")
        .bind(ORG).execute(&db.pool).await.unwrap();
    let mut selection = input("finance-events");
    selection.legacy_date_timezone = Some("UTC".to_owned());
    let utc: Value =
        serde_json::from_str(&read_costs(&db.pool, ORG, &selection).await.unwrap()).unwrap();
    assert_eq!(utc[0]["occurredAt"], "2001-12-02T00:00:00.000Z");
    assert_eq!(utc[0]["createdAt"], "2032-01-01T00:00:00.000Z");
    selection.legacy_date_timezone = Some("Pacific/Honolulu".to_owned());
    let legacy: Value =
        serde_json::from_str(&read_costs(&db.pool, ORG, &selection).await.unwrap()).unwrap();
    assert_eq!(legacy[0]["occurredAt"], Value::Null);
    assert_eq!(legacy[0]["createdAt"], Value::Null);
    let zone: String = sqlx::query_scalar("SHOW TimeZone")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        zone, "UTC",
        "date context must not leak out of the read transaction"
    );
    let baseline = db.counts().await;
    selection.legacy_date_timezone = Some("UTC'); DELETE FROM finance_events; --".to_owned());
    assert!(read_costs(&db.pool, ORG, &selection).await.is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM finance_events")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(count, 1, "timezone is a parameter value, never SQL syntax");
    assert_eq!(db.counts().await, baseline);
}
