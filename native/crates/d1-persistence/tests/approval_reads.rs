#![allow(dead_code)]
mod support;
use rudder_d1_persistence::{
    StoreError,
    approval_reads::{ApprovalReadError, ApprovalReadInput, read_approvals},
};
use serde_json::{Value, json};
use support::{Database, ORG, OTHER};
fn input(value: Value) -> ApprovalReadInput {
    serde_json::from_value(value).unwrap()
}

#[tokio::test]
async fn approvals_scope_links_entities_and_labels_without_writes() {
    let db = Database::start().await;
    let a = "91000000-0000-4000-8000-000000000001";
    let foreign = "91000000-0000-4000-8000-000000000002";
    let issue = "92000000-0000-4000-8000-000000000001";
    let foreign_issue = "92000000-0000-4000-8000-000000000002";
    let label = "93000000-0000-4000-8000-000000000001";
    sqlx::raw_sql(&format!(r#"
INSERT INTO approvals(id,org_id,type,status,payload) VALUES
('{a}','{ORG}','hire_agent','pending,approved','{{"password":"hidden","safe":9007199254740993}}'),
('{foreign}','{OTHER}','hire_agent','pending','{{}}');
INSERT INTO issues(id,org_id,title) VALUES ('{issue}','{ORG}','Visible'),('{foreign_issue}','{OTHER}','Hidden');
INSERT INTO issue_approvals(org_id,issue_id,approval_id) VALUES ('{ORG}','{issue}','{a}'),('{ORG}','{issue}','{foreign}'),('{ORG}','{foreign_issue}','{a}');
INSERT INTO labels(id,org_id,name,color) VALUES ('{label}','{ORG}','Visible','blue'),('93000000-0000-4000-8000-000000000002','{OTHER}','Foreign','red'),('93000000-0000-4000-8000-000000000003','{ORG}','Dirty link','red');
INSERT INTO issue_labels(issue_id,label_id,org_id) VALUES ('{issue}','{label}','{ORG}'),('{issue}','93000000-0000-4000-8000-000000000002','{ORG}'),('{issue}','93000000-0000-4000-8000-000000000003','{OTHER}');
"#)).execute(&db.pool).await.unwrap();
    let snapshot = || {
        sqlx::query_scalar::<_,String>("SELECT jsonb_build_array((SELECT jsonb_agg(t) FROM approvals t),(SELECT jsonb_agg(t) FROM issue_approvals t),(SELECT jsonb_agg(t) FROM issue_labels t))::text").fetch_one(&db.pool)
    };
    let before = snapshot().await.unwrap();
    for operation in ["list", "detail", "issue-approvals"] {
        let body = match operation {
            "list" => json!({"operation":operation,"status":"pending,approved"}),
            "detail" => json!({"operation":operation,"targetId":a}),
            _ => json!({"operation":operation,"targetId":issue}),
        };
        let result: Value =
            serde_json::from_str(&read_approvals(&db.pool, ORG, &input(body)).await.unwrap())
                .unwrap();
        let row = if operation == "detail" {
            &result
        } else {
            assert_eq!(result.as_array().unwrap().len(), 1);
            &result[0]
        };
        assert_eq!(row["id"], a);
        assert_eq!(row["payload"]["password"], "***REDACTED***");
        assert_eq!(row["payload"]["safe"], 9007199254740992u64);
        assert!(row.get("kind").is_none());
        assert!(row.get("requestStatus").is_none());
    }
    let result: Value = serde_json::from_str(
        &read_approvals(
            &db.pool,
            ORG,
            &input(json!({"operation":"issues","targetId":a})),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(result.as_array().unwrap().len(), 1);
    assert_eq!(result[0]["id"], issue);
    assert_eq!(result[0]["labelIds"], json!([label]));
    assert_eq!(snapshot().await.unwrap(), before);
    sqlx::query("UPDATE approvals SET org_id=$1::uuid WHERE id=$2::uuid")
        .bind(OTHER)
        .bind(a)
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(matches!(
        read_approvals(
            &db.pool,
            ORG,
            &input(json!({"operation":"issues","targetId":a}))
        )
        .await,
        Err(ApprovalReadError::Store(StoreError::NotFound))
    ));
}
