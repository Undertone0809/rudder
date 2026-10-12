#![allow(dead_code)]
mod support;
use rudder_d1_persistence::organization_catalog_reads::{
    OrganizationCatalogReadInput, read_organization_catalog,
};
use serde_json::{Value, json};
use support::{Database, ORG, OTHER};

fn input(operation: &str) -> OrganizationCatalogReadInput {
    serde_json::from_value(json!({"operation":operation,"legacyDateTimezone":"UTC"})).unwrap()
}

#[test]
fn catalog_does_not_accept_caller_identity_or_filters() {
    for field in ["userId", "boardUserContext", "status", "issueId"] {
        let mut value = json!({"operation":"resources"});
        value[field] = json!("value");
        assert!(serde_json::from_value::<OrganizationCatalogReadInput>(value).is_err());
    }
}

#[tokio::test]
async fn catalog_preserves_raw_resource_order_and_read_only_effective_profile() {
    let db = Database::start().await;
    let resource = "76000000-0000-4000-8000-000000000001";
    let canonical = "77000000-0000-4000-8000-000000000003";
    sqlx::raw_sql(&format!(r#"
INSERT INTO organization_resources(id,org_id,name,kind,locator,metadata,created_at) VALUES
('{resource}','{ORG}','Historical proof','file','synthetic://proof','"{{\"password\":\"keep\",\"large\":9007199254740993}}"','0032-01-01 00:00:00Z'),
('76000000-0000-4000-8000-000000000002','{OTHER}','Foreign proof','file','synthetic://foreign','{{}}','2026-01-01 00:00:00Z');
INSERT INTO organization_intelligence_profiles(id,org_id,purpose,agent_runtime_type,agent_runtime_config,status,updated_at) VALUES
('77000000-0000-4000-8000-000000000001','{ORG}','lightweight','other','{{"source":"lightweight"}}','configured','2026-01-01 00:00:00Z'),
('77000000-0000-4000-8000-000000000002','{ORG}','reasoning','codex_local','{{"model":"gpt-5.5","reasoningEffort":" high ","keep":false}}','configured','0032-01-01 00:00:00Z');
"#)).execute(&db.pool).await.unwrap();
    let snapshot = || {
        sqlx::query_scalar::<_,String>("SELECT jsonb_build_array((SELECT jsonb_agg(to_jsonb(t)) FROM organization_resources t),(SELECT jsonb_agg(to_jsonb(t)) FROM organization_intelligence_profiles t))::text").fetch_one(&db.pool)
    };
    let before = snapshot().await.unwrap();
    let resources: Value = serde_json::from_str(
        &read_organization_catalog(&db.pool, ORG, &input("resources"))
            .await
            .unwrap(),
    )
    .unwrap();
    let row = resources
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == resource)
        .unwrap();
    assert_eq!(row["createdAt"], "2032-01-01T00:00:00.000Z");
    assert_eq!(
        row["metadata"],
        json!({"password":"keep","large":9007199254740992u64})
    );
    assert!(
        resources
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v["orgId"] == ORG)
    );
    let profile: Value = serde_json::from_str(
        &read_organization_catalog(&db.pool, ORG, &input("intelligence-profiles"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(profile[0]["purpose"], "default");
    assert_eq!(profile[0]["status"], "disabled");
    assert_eq!(
        profile[0]["agentRuntimeConfig"],
        json!({"model":"gpt-6-luna","modelReasoningEffort":"high","keep":false})
    );
    assert_eq!(snapshot().await.unwrap(), before);
    sqlx::query("INSERT INTO organization_intelligence_profiles(id,org_id,purpose,agent_runtime_type,agent_runtime_config) VALUES ($1::uuid,$2::uuid,'default','other','false')").bind(canonical).bind(ORG).execute(&db.pool).await.unwrap();
    let selected: Value = serde_json::from_str(
        &read_organization_catalog(&db.pool, ORG, &input("intelligence-profiles"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(selected[0]["id"], canonical);
    assert_eq!(selected[0]["agentRuntimeConfig"], false);
}
