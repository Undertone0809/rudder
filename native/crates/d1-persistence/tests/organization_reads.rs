mod support;

use rudder_d1_persistence::organization_reads::{read_organization, read_organizations};
use serde_json::json;
use support::{ASSET, CEO, Database, ORG, OTHER};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

#[tokio::test]
async fn organization_projection_includes_legacy_fields_aliases_logo_and_utc_spend() {
    let database = Database::start().await;
    sqlx::query(
        r#"UPDATE organizations
           SET url_key='projection-org', name='Projection Org', description='Full projection',
               status='paused', pause_reason='maintenance', paused_at='2026-01-14 12:13:14.123Z',
               issue_prefix='PROJ', issue_counter=42, budget_monthly_cents=9000,
               require_board_approval_for_new_agents=false,
               default_chat_issue_creation_mode='automatic', brand_color='#123abc',
               created_at='2025-12-01 01:02:03.456Z', updated_at='2026-01-10 11:12:13.789Z'
           WHERE id=$1::uuid"#,
    )
    .bind(ORG)
    .execute(&database.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO organization_logos (org_id, asset_id) VALUES ($1::uuid, $2::uuid)")
        .bind(ORG)
        .bind(ASSET)
        .execute(&database.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO organization_issue_prefix_aliases (org_id, prefix) VALUES ($1::uuid, 'OLDPROJ')",
    )
    .bind(ORG)
    .execute(&database.pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO cost_events (org_id, agent_id, provider, model, cost_cents, occurred_at)
           VALUES
             ($1::uuid, $2::uuid, 'test', 'test-model', 125, '2026-01-01 00:00:00Z'),
             ($1::uuid, $2::uuid, 'test', 'test-model', 275, '2026-01-31 23:59:59.999Z'),
             ($1::uuid, $2::uuid, 'test', 'test-model', 500, '2026-02-01 00:00:00Z'),
             ($1::uuid, $2::uuid, 'test', 'test-model', 700, '2025-12-31 23:59:59.999Z')"#,
    )
    .bind(ORG)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .unwrap();

    let now = OffsetDateTime::parse("2026-01-16T00:00:00Z", &Rfc3339).unwrap();
    let row = read_organization(&mut database.pool.acquire().await.unwrap(), ORG, now)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        row,
        json!({
            "id": ORG,
            "urlKey": "projection-org",
            "name": "Projection Org",
            "description": "Full projection",
            "status": "paused",
            "pauseReason": "maintenance",
            "pausedAt": "2026-01-14T12:13:14.123Z",
            "issuePrefix": "PROJ",
            "issueCounter": 42,
            "budgetMonthlyCents": 9000,
            "spentMonthlyCents": 400,
            "requireBoardApprovalForNewAgents": false,
            "defaultChatIssueCreationMode": "automatic",
            "brandColor": "#123abc",
            "logoAssetId": ASSET,
            "createdAt": "2025-12-01T01:02:03.456Z",
            "updatedAt": "2026-01-10T11:12:13.789Z",
            "issuePrefixAliases": ["OLDPROJ"],
            "workspace": null,
            "logoUrl": format!("/api/assets/{ASSET}/content"),
        })
    );
    assert!(
        read_organization(&mut database.pool.acquire().await.unwrap(), OTHER, now)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        read_organization(
            &mut database.pool.acquire().await.unwrap(),
            "60000000-0000-4000-8000-000000000099",
            now
        )
        .await
        .unwrap()
        .is_none()
    );
}

#[tokio::test]
async fn organization_collection_is_unpaginated_and_can_be_scoped() {
    let database = Database::start().await;
    for index in 0..125 {
        let id = format!("61000000-0000-4000-8000-{index:012}");
        sqlx::query(
            "INSERT INTO organizations (id, url_key, name, issue_prefix) VALUES ($1::uuid, $2, $3, $4)",
        )
        .bind(id)
        .bind(format!("bulk-org-{index}"))
        .bind(format!("Bulk Org {index}"))
        .bind(format!("BULK{index}"))
        .execute(&database.pool)
        .await
        .unwrap();
    }

    let all = read_organizations(
        &mut database.pool.acquire().await.unwrap(),
        None,
        OffsetDateTime::now_utc(),
    )
    .await
    .unwrap();
    assert_eq!(all.len(), 127, "legacy list is not paginated");
    assert!(all.iter().any(|row| row["id"] == ORG));
    assert!(all.iter().any(|row| row["id"] == OTHER));

    let scope = vec![ORG.to_owned()];
    let scoped = read_organizations(
        &mut database.pool.acquire().await.unwrap(),
        Some(&scope),
        OffsetDateTime::now_utc(),
    )
    .await
    .unwrap();
    assert_eq!(scoped.len(), 1);
    assert_eq!(scoped[0]["id"], ORG);
    let empty: Vec<String> = Vec::new();
    let none = read_organizations(
        &mut database.pool.acquire().await.unwrap(),
        Some(&empty),
        OffsetDateTime::now_utc(),
    )
    .await
    .unwrap();
    assert!(none.is_empty());
}
