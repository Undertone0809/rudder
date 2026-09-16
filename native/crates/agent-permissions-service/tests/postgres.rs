mod support;

use rudder_agent_permissions_service::{
    AuthenticatedActor, PermissionError, PermissionService, TaskAssignSource, UpdatePermissions,
};
use serde_json::json;
use support::*;

fn patch(create: bool, skills: Option<bool>, assign: bool) -> UpdatePermissions {
    UpdatePermissions {
        can_create_agents: create,
        can_manage_skills: skills,
        can_assign_tasks: assign,
    }
}

#[tokio::test]
async fn omitted_and_malformed_values_normalize_to_node_defaults() {
    let db = Database::start().await;
    sqlx::query("UPDATE agents SET permissions=$1 WHERE id=$2::uuid")
        .bind(json!({"canCreateAgents":"wrong","unknown":true}))
        .bind(TARGET)
        .execute(&db.pool)
        .await
        .unwrap();
    let service = PermissionService::new(db.pool.clone());
    let read = service
        .read(&AuthenticatedActor::local_implicit_board(), TARGET.into())
        .await
        .unwrap();
    assert!(read.permissions.can_create_agents);
    assert!(read.permissions.can_manage_skills);

    let updated = service
        .update(
            &AuthenticatedActor::local_implicit_board(),
            TARGET.into(),
            patch(false, None, false),
        )
        .await
        .unwrap();
    assert!(!updated.permissions.can_create_agents);
    assert!(updated.permissions.can_manage_skills);
}

#[tokio::test]
async fn ceo_target_always_retains_effective_task_assignment() {
    let db = Database::start().await;
    let service = PermissionService::new(db.pool.clone());
    let result = service
        .update(
            &AuthenticatedActor::local_implicit_board(),
            CEO.into(),
            patch(false, Some(false), false),
        )
        .await
        .unwrap();
    assert!(result.can_assign_tasks);
    assert_eq!(result.task_assign_source, TaskAssignSource::CeoRole);
    assert_eq!(db.grant_count(CEO).await, 1);
}

#[tokio::test]
async fn actor_role_and_status_are_revalidated_inside_the_transaction() {
    let db = Database::start().await;
    let service = PermissionService::new(db.pool.clone());
    let actor = AuthenticatedActor::agent(ORG, CEO, None);
    sqlx::query("UPDATE agents SET role='engineer' WHERE id=$1::uuid")
        .bind(CEO)
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(matches!(
        service
            .update(&actor, TARGET.into(), patch(false, None, false))
            .await,
        Err(PermissionError::OnlyCeo)
    ));
    sqlx::query("UPDATE agents SET role='ceo',status='terminated' WHERE id=$1::uuid")
        .bind(CEO)
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(matches!(
        service
            .update(&actor, TARGET.into(), patch(false, None, false))
            .await,
        Err(PermissionError::Forbidden)
    ));
    assert_eq!(db.activity_count().await, 0);
}

#[tokio::test]
async fn concurrent_partial_updates_do_not_restore_stale_skill_permissions() {
    let db = Database::start().await;
    let service = PermissionService::new(db.pool.clone());
    let actor = AuthenticatedActor::local_implicit_board();
    let left = service.update(&actor, TARGET.into(), patch(false, Some(false), false));
    let right = service.update(&actor, TARGET.into(), patch(true, None, false));
    let (left, right) = tokio::join!(left, right);
    left.unwrap();
    right.unwrap();
    let stored = db.permissions(TARGET).await;
    assert_eq!(stored["canManageSkills"], false);
    assert_eq!(db.activity_count().await, 2);
}

#[tokio::test]
async fn audit_failure_rolls_back_permissions_membership_and_grant() {
    let db = Database::start().await;
    sqlx::raw_sql(
        "CREATE FUNCTION reject_permission_audit() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN IF NEW.action='agent.permissions_updated' THEN RAISE EXCEPTION 'audit rejected'; END IF;
         RETURN NEW; END $$;
         CREATE TRIGGER reject_permission_audit BEFORE INSERT ON activity_log
         FOR EACH ROW EXECUTE FUNCTION reject_permission_audit();",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    let service = PermissionService::new(db.pool.clone());
    assert!(matches!(
        service
            .update(
                &AuthenticatedActor::local_implicit_board(),
                TARGET.into(),
                patch(false, Some(false), true),
            )
            .await,
        Err(PermissionError::Database(_))
    ));
    assert_eq!(db.permissions(TARGET).await, json!({}));
    assert_eq!(db.grant_count(TARGET).await, 0);
    let memberships: i64 =
        sqlx::query_scalar("SELECT count(*) FROM organization_memberships WHERE principal_id=$1")
            .bind(TARGET.to_string())
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(memberships, 0);
}

#[tokio::test]
async fn organization_scope_rejects_foreign_targets_and_spoofed_agent_context() {
    let db = Database::start().await;
    let service = PermissionService::new(db.pool.clone());
    assert!(matches!(
        service
            .read(
                &AuthenticatedActor::scoped_board("user", vec![ORG.into()]),
                FOREIGN.into()
            )
            .await,
        Err(PermissionError::Forbidden)
    ));
    assert!(matches!(
        service
            .update(
                &AuthenticatedActor::agent(OTHER, CEO, None),
                TARGET.into(),
                patch(false, None, false),
            )
            .await,
        Err(PermissionError::Forbidden)
    ));
}

#[tokio::test]
async fn scoped_board_membership_is_revalidated_and_revocation_fails_closed() {
    let db = Database::start().await;
    sqlx::query(
        "INSERT INTO organization_memberships
         (org_id,principal_type,principal_id,status,membership_role)
         VALUES ($1::uuid,'user','session-user','active','member')",
    )
    .bind(ORG)
    .execute(&db.pool)
    .await
    .unwrap();
    let service = PermissionService::new(db.pool.clone());
    let actor = AuthenticatedActor::scoped_board("session-user", vec![ORG.into()]);
    service.read(&actor, TARGET.into()).await.unwrap();
    sqlx::query(
        "UPDATE organization_memberships SET status='suspended'
         WHERE org_id=$1::uuid AND principal_id='session-user'",
    )
    .bind(ORG)
    .execute(&db.pool)
    .await
    .unwrap();
    assert!(matches!(
        service
            .update(&actor, TARGET.into(), patch(false, None, false))
            .await,
        Err(PermissionError::Forbidden)
    ));
}

#[tokio::test]
async fn instance_admin_is_revalidated_after_role_revocation() {
    let db = Database::start().await;
    sqlx::query(
        "INSERT INTO instance_user_roles (user_id,role) VALUES ('admin-user','instance_admin')",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    let service = PermissionService::new(db.pool.clone());
    let actor = AuthenticatedActor::instance_admin("admin-user");
    service.read(&actor, TARGET.into()).await.unwrap();
    sqlx::query("DELETE FROM instance_user_roles WHERE user_id='admin-user'")
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(matches!(
        service
            .update(&actor, TARGET.into(), patch(false, None, false))
            .await,
        Err(PermissionError::Forbidden)
    ));
}
