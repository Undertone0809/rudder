#![allow(dead_code)]
mod support;
use rudder_d1_persistence::activity_reads::{ActivityReadInput, read_activity};
use serde_json::{Value, json};
use support::{Database, ORG, OTHER};

fn input(value: Value) -> ActivityReadInput {
    serde_json::from_value(value).unwrap()
}

#[tokio::test]
async fn activity_reads_scope_cursor_hydration_and_deep_opaque_json() {
    let db = Database::start().await;
    let issue = "70000000-0000-4000-8000-000000000001";
    sqlx::raw_sql(&format!(r#"
INSERT INTO issues(id,org_id,title,identifier) VALUES ('{issue}','{ORG}','Canonical','A-1');
INSERT INTO activity_log(id,org_id,actor_type,actor_id,action,entity_type,entity_id,details,created_at) VALUES
('80000000-0000-4000-8000-000000000001','{ORG}','system','fixture','issue.created','issue','{issue}','{{"title":"","identifier":123}}','2026-04-01T10:00:00.000100Z'),
('80000000-0000-4000-8000-000000000002','{ORG}','system','fixture','project.updated','project','fixture',NULL,'2026-04-01T10:00:00.000500Z'),
('80000000-0000-4000-8000-000000000003','{OTHER}','system','fixture','issue.created','issue','{issue}','{{"secret":true}}','2026-04-01T10:00:00.000900Z');
"#)).execute(&db.pool).await.unwrap();
    let before = db.counts().await;
    let first: Value = serde_json::from_str(
        &read_activity(
            &db.pool,
            ORG,
            &input(json!({"operation":"list-page","limit":1})),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        first["items"][0]["id"],
        "80000000-0000-4000-8000-000000000002"
    );
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    let cursor: Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(first["nextCursor"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(cursor["createdAt"], "2026-04-01T10:00:00.000500Z");
    let last: Value = serde_json::from_str(
        &read_activity(
            &db.pool,
            ORG,
            &input(json!({"operation":"list-page","limit":1,"cursor":cursor})),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        last["items"][0]["details"],
        json!({"title":"","identifier":"A-1","issueIdentifier":"A-1","issueTitle":"Canonical"})
    );
    assert!(last["nextCursor"].is_null());
    let issue_input = input(json!({"operation":"issue","issueId":issue}));
    let issue_rows: Value =
        serde_json::from_str(&read_activity(&db.pool, ORG, &issue_input).await.unwrap()).unwrap();
    assert_eq!(issue_rows.as_array().unwrap().len(), 1);
    assert_eq!(
        issue_rows[0]["details"],
        json!({"title":"","identifier":123})
    );
    assert_eq!(
        read_activity(&db.pool, OTHER, &issue_input).await.unwrap(),
        "[]"
    );
    assert_eq!(before, db.counts().await);
    let deep = format!(
        "{{\"nested\":{}9007199254740993{}}}",
        "[".repeat(600),
        "]".repeat(600)
    );
    sqlx::query(
        "UPDATE activity_log SET details=$1::jsonb WHERE id='80000000-0000-4000-8000-000000000001'",
    )
    .bind(deep)
    .execute(&db.pool)
    .await
    .unwrap();
    let raw = read_activity(&db.pool, ORG, &input(json!({"operation":"list"})))
        .await
        .unwrap();
    assert!(raw.contains(&format!(
        "{}9007199254740992{}",
        "[".repeat(600),
        "]".repeat(600)
    )));
    assert!(raw.contains("\"issueTitle\":\"Canonical\""));
}
