#![allow(dead_code)]
mod support;
use rudder_d1_persistence::{
    StoreError,
    issue_metadata_reads::{IssueMetadataReadError, IssueMetadataReadInput, read_issue_metadata},
};
use serde_json::{Value, json};
use support::{ASSET, Database, FOREIGN_ASSET, ORG, OTHER};

fn input(value: Value) -> IssueMetadataReadInput {
    serde_json::from_value(value).unwrap()
}

#[test]
fn metadata_inputs_keep_context_separate_from_target_selection() {
    for value in [
        json!({"operation":"attachments"}),
        json!({"operation":"work-products","issueId":"id","boardUserContext":false}),
        json!({"operation":"follows","issueId":"id"}),
        json!({"operation":"follows","legacyDateTimezone":"UTC\n"}),
    ] {
        assert!(input(value).validate().is_err());
    }
    assert!(
        input(json!({"operation":"follows","boardUserContext":false}))
            .validate()
            .is_ok()
    );
    assert!(
        serde_json::from_value::<IssueMetadataReadInput>(
            json!({"operation":"follows","userId":"spoof"})
        )
        .is_err()
    );
}

#[tokio::test]
async fn metadata_rechecks_target_and_fences_each_disclosed_row_without_writes() {
    let db = Database::start().await;
    let issue = "71000000-0000-4000-8000-000000000001";
    let foreign_issue = "71000000-0000-4000-8000-000000000002";
    let attachment = "72000000-0000-4000-8000-000000000001";
    let product = "73000000-0000-4000-8000-000000000001";
    sqlx::raw_sql(&format!(r#"
INSERT INTO issues(id,org_id,title) VALUES ('{issue}','{ORG}','Release proof'),('{foreign_issue}','{OTHER}','Foreign proof');
INSERT INTO assets(id,org_id,provider,object_key,content_type,byte_size,sha256) VALUES ('74000000-0000-4000-8000-000000000001','{ORG}','synthetic','synthetic-key','text/plain',1,'synthetic');
INSERT INTO issue_attachments(id,org_id,issue_id,asset_id) VALUES
('{attachment}','{ORG}','{issue}','{ASSET}'),
('72000000-0000-4000-8000-000000000002','{ORG}','{issue}','{FOREIGN_ASSET}'),
('72000000-0000-4000-8000-000000000003','{OTHER}','{issue}','74000000-0000-4000-8000-000000000001');
INSERT INTO issue_work_products(id,org_id,issue_id,type,provider,title,status,metadata) VALUES
('{product}','{ORG}','{issue}','document','synthetic','Proof','active','{{"password":"keep","large":9007199254740993}}'),
('73000000-0000-4000-8000-000000000002','{OTHER}','{issue}','document','synthetic','Foreign','active','{{}}');
INSERT INTO issue_follows(org_id,issue_id,user_id) VALUES ('{ORG}','{issue}','reader'),('{ORG}','{foreign_issue}','reader'),('{OTHER}','{issue}','reader'),('{ORG}','{issue}','other-reader');
"#)).execute(&db.pool).await.unwrap();
    let snapshot = || {
        sqlx::query_scalar::<_,String>("SELECT jsonb_build_array((SELECT jsonb_agg(to_jsonb(t)) FROM issue_attachments t),(SELECT jsonb_agg(to_jsonb(t)) FROM issue_work_products t),(SELECT jsonb_agg(to_jsonb(t)) FROM issue_follows t))::text").fetch_one(&db.pool)
    };
    let before = snapshot().await.unwrap();
    let attachments: Value = serde_json::from_str(
        &read_issue_metadata(
            &db.pool,
            ORG,
            &input(json!({"operation":"attachments","issueId":issue})),
            None,
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(attachments.as_array().unwrap().len(), 1);
    assert_eq!(attachments[0]["id"], attachment);
    assert_eq!(
        attachments[0]["contentPath"],
        format!("/api/attachments/{attachment}/content")
    );
    let products: Value = serde_json::from_str(
        &read_issue_metadata(
            &db.pool,
            ORG,
            &input(json!({"operation":"work-products","issueId":issue})),
            None,
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(products.as_array().unwrap().len(), 1);
    assert_eq!(
        products[0]["metadata"],
        json!({"password":"keep","large":9007199254740992u64})
    );
    assert_eq!(
        products[0]["runWorkspaceId"],
        products[0]["executionWorkspaceId"]
    );
    let follows: Value = serde_json::from_str(
        &read_issue_metadata(
            &db.pool,
            ORG,
            &input(json!({"operation":"follows","boardUserContext":true})),
            Some("reader"),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(follows.as_array().unwrap().len(), 1);
    assert_eq!(follows[0]["issue"]["id"], issue);
    assert_eq!(snapshot().await.unwrap(), before);
    sqlx::query("UPDATE issues SET org_id=$1::uuid WHERE id=$2::uuid")
        .bind(OTHER)
        .bind(issue)
        .execute(&db.pool)
        .await
        .unwrap();
    for operation in ["attachments", "work-products"] {
        assert!(matches!(
            read_issue_metadata(
                &db.pool,
                ORG,
                &input(json!({"operation":operation,"issueId":issue})),
                None
            )
            .await,
            Err(IssueMetadataReadError::Store(StoreError::NotFound))
        ));
    }
}
