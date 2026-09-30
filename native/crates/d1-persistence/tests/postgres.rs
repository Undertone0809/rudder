mod support;

use rudder_d1_persistence::{
    MutationStore, Outcome, ProjectCreateCommand, ProjectCreateProvisionRequest,
    ProjectCreateProvisioned, ProjectCreateProvisioner, ProjectDeleteCommand, ProjectPatchCommand,
    ProjectPatchMutationOrigin, Receipt, ResultState, StoreError,
};
use rudder_organization_mutation_core::OrganizationBrandingCommand;
use rudder_project_goal_link_core::{
    ActorAuthority, ActorBinding, GoalSetTargetVerifier, Operation, ProjectGoalLinkCommand,
    ProjectGoalLinkState, ProjectGoalSetReplacementCommand, TargetVerifier,
    ValidatedGoalSetContext,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::Row;
use support::{
    ASSET, CEO, Database, FOREIGN_ASSET, FOREIGN_GOAL, FOREIGN_PROJECT, GOAL, GOAL_TWO, ORG, OTHER,
    PROJECT,
};

struct SeedTargets;

#[derive(Default)]
struct CreateProvisioner {
    requests: std::sync::Mutex<Vec<ProjectCreateProvisionRequest>>,
    fail: bool,
    bind_first_intent: bool,
}

impl ProjectCreateProvisioner for CreateProvisioner {
    fn provision<'a>(
        &'a self,
        request: &'a ProjectCreateProvisionRequest,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<ProjectCreateProvisioned, StoreError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            let mut requests = self.requests.lock().unwrap();
            let changed_intent = self.bind_first_intent
                && requests.first().is_some_and(|original| original != request);
            requests.push(request.clone());
            if changed_intent {
                return Err(StoreError::ProvisioningConflict);
            }
            if self.fail {
                return Err(StoreError::Provisioning("synthetic failure".to_owned()));
            }
            Ok(ProjectCreateProvisioned {
                organization_workspace_root: "/synthetic/library".to_owned(),
            })
        })
    }
}

fn project_create_command(key: &str) -> ProjectCreateCommand {
    ProjectCreateCommand {
        organization_id: ORG.to_owned(),
        actor_kind: "agent".to_owned(),
        actor_id: CEO.to_owned(),
        run_id: None,
        idempotency_key: key.to_owned(),
        data: json!({"name":"Synthetic project", "goalIds":[GOAL_TWO, GOAL], "goalId":FOREIGN_GOAL,
            "newResources":[{"name":"Create source", "kind":"file", "locator":"https://example.test/create"}]}),
        activity_details: json!({"source":"synthetic", "name":"unresolved"}),
    }
}

fn created_response(receipt: &Receipt) -> &serde_json::Value {
    let ResultState::ProjectCreated { response, .. } = &receipt.result else {
        panic!("create receipt")
    };
    response
}

fn required_activity_id(receipt: &Receipt) -> &str {
    receipt
        .activity_id
        .as_deref()
        .expect("ordinary mutation activity id")
}

// This mock tests the SQL boundary when the host rejects a changed intent.
// Durable filesystem binding, corruption handling, and directory reuse belong
// to project_library's tests, not this in-memory provisioner.
#[tokio::test(flavor = "multi_thread")]
async fn project_create_changed_intent_rolls_back_and_committed_replay_skips_hook() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let provisioner = CreateProvisioner {
        bind_first_intent: true,
        ..Default::default()
    };
    let command = project_create_command("create-intent-drift");
    database.sql("CREATE FUNCTION fail_create_intent_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END; $$;
        CREATE TRIGGER fail_create_intent_audit_trigger BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION fail_create_intent_audit();").await;
    assert!(matches!(
        store.project_create(command.clone(), &provisioner).await,
        Err(StoreError::Database(_))
    ));
    let original = provisioner.requests.lock().unwrap()[0].clone();
    database.sql("DROP TRIGGER fail_create_intent_audit_trigger ON activity_log; DROP FUNCTION fail_create_intent_audit();").await;
    let node_project = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let mut node_tx = database.pool.begin().await.unwrap();
    sqlx::query("SELECT org_id FROM organization_mutation_state WHERE org_id=$1::uuid FOR UPDATE")
        .bind(ORG)
        .fetch_one(&mut *node_tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO projects (id,org_id,name) VALUES ($1::uuid,$2::uuid,$3)")
        .bind(node_project)
        .bind(ORG)
        .bind(&original.project_name)
        .execute(&mut *node_tx)
        .await
        .unwrap();
    node_tx.commit().await.unwrap();
    assert!(matches!(
        store.project_create(command.clone(), &provisioner).await,
        Err(StoreError::ProvisioningConflict)
    ));
    let changed = provisioner.requests.lock().unwrap()[1].clone();
    assert_eq!(changed.project_id, original.project_id);
    assert_eq!(changed.request_fingerprint, original.request_fingerprint);
    assert_ne!(changed.project_name, original.project_name);
    assert_ne!(changed.project_url_key, original.project_url_key);
    let counts: (i64, i64, i64, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM projects WHERE id=$1::uuid),
         (SELECT count(*) FROM project_goal_mutation_state WHERE project_id=$1::uuid),
         (SELECT count(*) FROM project_goals WHERE project_id=$1::uuid),
         (SELECT count(*) FROM organization_resources),
         (SELECT count(*) FROM organization_mutation_receipts),
         (SELECT count(*) FROM organization_mutation_outbox), (SELECT count(*) FROM activity_log)",
    )
    .bind(&original.project_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(counts, (0, 0, 0, 0, 0, 0, 0));
    let node_name: String = sqlx::query_scalar("SELECT name FROM projects WHERE id=$1::uuid")
        .bind(node_project)
        .fetch_one(&database.pool)
        .await
        .unwrap();
    assert_eq!(node_name, original.project_name);
    assert_eq!(
        store.project_scope(node_project).await.unwrap().owner,
        "node"
    );
    // Once the collision disappears, the identical intent can complete.
    sqlx::query("DELETE FROM projects WHERE id=$1::uuid")
        .bind(node_project)
        .execute(&database.pool)
        .await
        .unwrap();
    let committed = store
        .project_create(command.clone(), &provisioner)
        .await
        .unwrap();
    assert_eq!(
        created_response(&committed.receipt)["name"],
        original.project_name
    );
    assert_eq!(provisioner.requests.lock().unwrap()[2], original);
    let unavailable_hook = CreateProvisioner {
        fail: true,
        ..Default::default()
    };
    let replay = MutationStore::new(database.pool.clone())
        .project_create(command, &unavailable_hook)
        .await
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.receipt, committed.receipt);
    assert!(unavailable_hook.requests.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn project_create_goal_precedence_and_scalar_defaults_match_service() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let provisioner = CreateProvisioner::default();
    let uppercase_goal = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    sqlx::query(
        "INSERT INTO goals (id,org_id,title) VALUES ($1::uuid,$2::uuid,'Case insensitive')",
    )
    .bind(uppercase_goal)
    .bind(ORG)
    .execute(&database.pool)
    .await
    .unwrap();
    for (index, (fields, expected)) in [
        (json!({}), None),
        (json!({"goalId":null}), None),
        (json!({"goalId":GOAL}), Some(GOAL)),
        (json!({"goalId":FOREIGN_GOAL,"goalIds":[]}), None),
        (
            json!({"goalId":FOREIGN_GOAL,"goalIds":[GOAL_TWO]}),
            Some(GOAL_TWO),
        ),
        (
            json!({"goalId":uppercase_goal.to_uppercase()}),
            Some(uppercase_goal),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let mut command = project_create_command(&format!("scalar-parity-{index}"));
        command.data = fields;
        command.data["name"] = json!("Parity");
        command.data["icon"] = serde_json::Value::Null;
        let result = store.project_create(command, &provisioner).await.unwrap();
        let response = created_response(&result.receipt);
        let name = if index == 0 {
            "Parity".to_owned()
        } else {
            format!("Parity {}", index + 1)
        };
        assert_eq!(response["name"], name);
        assert_eq!(response["urlKey"], name.to_lowercase().replace(' ', "-"));
        assert_eq!(response["goalId"], json!(expected));
        assert_eq!(
            response["goalIds"],
            json!(expected.into_iter().collect::<Vec<_>>())
        );
        assert_eq!(
            response["goals"].as_array().unwrap().len(),
            usize::from(expected.is_some())
        );
        assert_eq!(response["status"], "backlog");
        assert_eq!(response["icon"], "folder");
        for key in [
            "description",
            "leadAgentId",
            "targetDate",
            "pauseReason",
            "pausedAt",
            "archivedAt",
            "executionWorkspacePolicy",
            "primaryWorkspace",
        ] {
            assert!(response[key].is_null(), "{key}");
        }
        assert_eq!(response["workspaces"], json!([]));
        assert_eq!(response["resources"], json!([]));
        assert_eq!(
            response["codebase"],
            json!({"configured":true,"scope":"organization","workspaceId":null,"repoUrl":null,"repoRef":null,"defaultRef":null,"repoName":null,"localFolder":"/synthetic/library","managedFolder":"/synthetic/library","effectiveLocalFolder":"/synthetic/library","origin":"local_folder"})
        );
        assert_eq!(response["id"].as_str().unwrap().as_bytes()[14], b'5');
        if index == 0 {
            assert_eq!(
                response["color"],
                "linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)"
            );
        }
        if index == 1 {
            assert_eq!(
                response["color"],
                "linear-gradient(135deg, #7c3aed 0%, #d946ef 100%)"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn project_create_resources_policy_and_codebase_preserve_enriched_service_response() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let provisioner = CreateProvisioner::default();
    let library: String = sqlx::query_scalar("INSERT INTO organization_resources (org_id,name,kind,source_type,locator,metadata) VALUES ($1::uuid,'Original resource','file','library','projects/parity/source.md','{\"preserved\":true}') RETURNING id::text")
        .bind(ORG).fetch_one(&database.pool).await.unwrap();
    let foreign: String = sqlx::query_scalar("INSERT INTO organization_resources (org_id,name,kind,locator) VALUES ($1::uuid,'Foreign','url','https://example.test/foreign') RETURNING id::text")
        .bind(OTHER).fetch_one(&database.pool).await.unwrap();
    let policy = json!({
        "enabled":true,"defaultMode":"operator_branch","allowIssueOverride":false,
        "defaultProjectWorkspaceId":null,
        "workspaceStrategy":{"type":"git_worktree","baseRef":"main","branchTemplate":"work/{issue}","worktreeParentDir":null,"provisionCommand":"setup","teardownCommand":null},
        "workspaceRuntime":{"nested":[1,null,{"anything":true}]},"branchPolicy":{},
        "pullRequestPolicy":{"labels":["review"]},"runtimePolicy":{"timeout":42},"cleanupPolicy":null,
    });
    let mut command = project_create_command("enriched-parity");
    command.data = json!({
        "name":"  文档 Parity  ","description":"  retained description  ","status":"planned",
        "leadAgentId":CEO,"targetDate":"2026-10-03","color":"#ABCDEF","icon":"folder",
        "archivedAt":"2026-09-29T01:02:03.456Z","executionWorkspacePolicy":policy,
        "resourceAttachments":[{"resourceId":library.to_uppercase(),"role":"working_set","note":"  original attachment  ","sortOrder":9,"isPrimary":true}],
        "newResources":[
            {"name":"Ignored replacement","kind":"file","sourceType":"library","locator":" projects/parity/source.md ","role":"background","sortOrder":0,"metadata":{"replacement":true}},
            {"name":"  External  ","kind":"connector_object","locator":"  connector:object  ","description":"   ","metadata":{"deep":[false,null,{"x":"y"}]},"note":"  ","sortOrder":2},
            {"name":"Directory","kind":"directory","sourceType":"library","locator":"projects/parity","description":" trimmed ","role":"deliverable","sortOrder":3},
        ],
    });
    let created = store
        .project_create(command.clone(), &provisioner)
        .await
        .unwrap();
    let response = created_response(&created.receipt);
    assert_eq!(response["name"], "  文档 Parity  ");
    assert_eq!(response["urlKey"], "parity");
    for key in [
        "description",
        "status",
        "leadAgentId",
        "targetDate",
        "color",
        "icon",
        "archivedAt",
    ] {
        assert_eq!(response[key], command.data[key], "{key}");
    }
    let mut normalized = policy.clone();
    normalized
        .as_object_mut()
        .unwrap()
        .remove("defaultProjectWorkspaceId");
    normalized.as_object_mut().unwrap().remove("cleanupPolicy");
    normalized["workspaceStrategy"]
        .as_object_mut()
        .unwrap()
        .remove("worktreeParentDir");
    normalized["workspaceStrategy"]
        .as_object_mut()
        .unwrap()
        .remove("teardownCommand");
    assert_eq!(response["executionWorkspacePolicy"], normalized);
    let resources = response["resources"].as_array().unwrap();
    assert_eq!(resources.len(), 3);
    assert_eq!(resources[0]["resource"]["name"], "External");
    assert_eq!(resources[0]["resource"]["sourceType"], "external");
    assert_eq!(resources[0]["resource"]["locator"], "connector:object");
    assert_eq!(
        resources[0]["resource"]["metadata"],
        json!({"deep":[false,null,{"x":"y"}]})
    );
    assert!(resources[0]["resource"]["description"].is_null());
    assert!(resources[0]["note"].is_null());
    assert_eq!(resources[0]["role"], "reference");
    assert_eq!(resources[1]["resource"]["description"], "trimmed");
    assert_eq!(resources[2]["resourceId"], library);
    assert_eq!(resources[2]["resource"]["name"], "Original resource");
    assert_eq!(
        resources[2]["resource"]["metadata"],
        json!({"preserved":true})
    );
    assert_eq!(resources[2]["note"], "original attachment");
    assert_eq!(resources[2]["role"], "working_set");
    assert_eq!(resources[2]["isPrimary"], true);
    for attachment in resources {
        assert_eq!(attachment["projectId"], response["id"]);
        assert_eq!(attachment["orgId"], ORG);
        assert_eq!(attachment["resource"]["orgId"], ORG);
        for key in ["createdAt", "updatedAt"] {
            assert!(attachment[key].as_str().unwrap().ends_with('Z'));
            assert!(attachment["resource"][key].as_str().unwrap().ends_with('Z'));
        }
    }
    assert_eq!(
        store
            .project_create(command.clone(), &provisioner)
            .await
            .unwrap()
            .receipt,
        created.receipt
    );
    command.idempotency_key = "foreign-resource-parity".to_owned();
    command.data["resourceAttachments"] = json!([{"resourceId":foreign}]);
    assert!(matches!(
        store.project_create(command, &provisioner).await,
        Err(StoreError::InvalidInput)
    ));
    assert_eq!(provisioner.requests.lock().unwrap().len(), 1);
    let resource_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM organization_resources WHERE org_id=$1::uuid")
            .bind(ORG)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert_eq!(resource_count, 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn project_create_atomic_response_replay_authorization_and_deleted_incarnation() {
    let database = Database::start().await;
    database.sql("UPDATE organization_mutation_state SET owner='node', fence_epoch=fence_epoch+1, fence_token=gen_random_uuid(); UPDATE agents SET role='engineer';").await;
    let store = MutationStore::new(database.pool.clone());
    let provisioner = CreateProvisioner::default();
    let mut command = project_create_command("create-replay");
    command.data["description"] = json!("x".repeat(1024 * 1024 + 1));
    let first = store
        .project_create(command.clone(), &provisioner)
        .await
        .unwrap();
    assert!(!first.replayed);
    let response = created_response(&first.receipt);
    let id = response["id"].as_str().unwrap();
    assert_eq!(response["name"], "Synthetic project 2");
    assert_eq!(response["goalId"], GOAL_TWO);
    assert_eq!(response["goalIds"], json!([GOAL_TWO, GOAL]));
    assert_eq!(
        response["description"].as_str().unwrap().len(),
        1024 * 1024 + 1
    );
    assert_eq!(response["resources"].as_array().unwrap().len(), 1);
    assert_eq!(response["codebase"]["localFolder"], "/synthetic/library");
    assert_eq!(response["icon"], "folder");
    let scope = store.project_scope(id).await.unwrap();
    assert_eq!(
        (scope.owner.as_str(), scope.version, scope.fence_epoch),
        ("rust", 1, 1)
    );
    let restarted = MutationStore::new(database.pool.clone());
    let replay = restarted
        .project_create(command.clone(), &provisioner)
        .await
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(first.receipt, replay.receipt);
    assert_eq!(provisioner.requests.lock().unwrap().len(), 1);
    let details: String =
        sqlx::query_scalar("SELECT details::text FROM activity_log WHERE id=$1::uuid")
            .bind(required_activity_id(&first.receipt))
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&details).unwrap(),
        json!({"source":"synthetic", "name":"Synthetic project 2"})
    );
    let mut conflict = command.clone();
    conflict.data["name"] = json!("Different");
    assert!(matches!(
        store.project_create(conflict, &provisioner).await,
        Err(StoreError::IdempotencyConflict)
    ));
    let mut actor_conflict = command.clone();
    actor_conflict.actor_kind = "board".to_owned();
    actor_conflict.actor_id = "different-board".to_owned();
    assert!(matches!(
        store.project_create(actor_conflict, &provisioner).await,
        Err(StoreError::IdempotencyConflict)
    ));
    database.sql("UPDATE agents SET status='terminated'").await;
    assert!(matches!(
        store.project_create(command.clone(), &provisioner).await,
        Err(StoreError::Unauthorized)
    ));
    database.sql("UPDATE agents SET status='idle'").await;
    let mut foreign = command.clone();
    foreign.organization_id = OTHER.to_owned();
    assert!(matches!(
        store.project_create(foreign, &provisioner).await,
        Err(StoreError::Unauthorized)
    ));
    let mut bad_run = command.clone();
    bad_run.run_id = Some(GOAL.to_owned());
    assert!(matches!(
        store.project_create(bad_run, &provisioner).await,
        Err(StoreError::InvalidInput)
    ));
    sqlx::query("DELETE FROM projects WHERE id=$1::uuid")
        .bind(id)
        .execute(&database.pool)
        .await
        .unwrap();
    assert_eq!(
        restarted
            .project_create(command.clone(), &provisioner)
            .await
            .unwrap()
            .receipt,
        first.receipt
    );
    sqlx::query(
        "INSERT INTO projects (id,org_id,name) VALUES ($1::uuid,$2::uuid,'New incarnation')",
    )
    .bind(id)
    .bind(ORG)
    .execute(&database.pool)
    .await
    .unwrap();
    assert_eq!(
        restarted
            .project_create(command, &provisioner)
            .await
            .unwrap()
            .receipt,
        first.receipt
    );
    let name: String = sqlx::query_scalar("SELECT name FROM projects WHERE id=$1::uuid")
        .bind(id)
        .fetch_one(&database.pool)
        .await
        .unwrap();
    assert_eq!(name, "New incarnation");
    assert_eq!(provisioner.requests.lock().unwrap().len(), 1);
    assert_eq!(store.project_scope(id).await.unwrap().owner, "node");
    assert_eq!(database.counts().await, (0, 1, 1));
    let outbox: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM organization_mutation_outbox WHERE org_id=$1::uuid",
    )
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(outbox, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn project_create_rolls_back_hook_audit_and_receipt_failures_with_stable_retry_identity() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let command = project_create_command("create-rollback");
    let failed_hook = CreateProvisioner {
        fail: true,
        ..Default::default()
    };
    assert!(matches!(
        store.project_create(command.clone(), &failed_hook).await,
        Err(StoreError::Provisioning(_))
    ));
    let id = failed_hook.requests.lock().unwrap()[0].project_id.clone();
    let provisioner = CreateProvisioner::default();
    for table in ["activity_log", "organization_mutation_receipts"] {
        database.sql(&format!("CREATE FUNCTION fail_create_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END; $$;
            CREATE TRIGGER fail_create_write_trigger BEFORE INSERT ON {table} FOR EACH ROW EXECUTE FUNCTION fail_create_write();")).await;
        assert!(matches!(
            store.project_create(command.clone(), &provisioner).await,
            Err(StoreError::Database(_))
        ));
        assert_eq!(database.counts().await, (0, 0, 0));
        let counts: (i64,i64,i64,i64,i64) = sqlx::query_as(
            "SELECT (SELECT count(*) FROM projects WHERE id=$1::uuid),
             (SELECT count(*) FROM project_goal_mutation_state WHERE project_id=$1::uuid),
             (SELECT count(*) FROM project_goals WHERE project_id=$1::uuid),
             (SELECT count(*) FROM organization_resources), (SELECT count(*) FROM organization_mutation_outbox)")
            .bind(&id).fetch_one(&database.pool).await.unwrap();
        assert_eq!(counts, (0, 0, 0, 0, 0));
        database.sql(&format!("DROP TRIGGER fail_create_write_trigger ON {table}; DROP FUNCTION fail_create_write();")).await;
    }
    let result = store.project_create(command, &provisioner).await.unwrap();
    assert_eq!(created_response(&result.receipt)["id"], id);
    let original = failed_hook.requests.lock().unwrap()[0].clone();
    assert!(
        provisioner
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|request| request == &original)
    );
    assert_eq!(database.counts().await, (1, 1, 1));
}

#[tokio::test(flavor = "multi_thread")]
async fn project_create_serializes_duplicate_keys_and_mutable_defaults_without_adopting_existing_rows()
 {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let provisioner = CreateProvisioner::default();
    let mut command = project_create_command("create-concurrent");
    command.data = json!({"name":"Plan", "goalIds":[]});
    let (a, b) = tokio::join!(
        store.project_create(command.clone(), &provisioner),
        store.project_create(command.clone(), &provisioner)
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_ne!(a.replayed, b.replayed);
    assert_eq!(a.receipt, b.receipt);
    assert_eq!(provisioner.requests.lock().unwrap().len(), 1);
    command.idempotency_key = "create-second".to_owned();
    let second = store
        .project_create(command.clone(), &provisioner)
        .await
        .unwrap();
    assert_eq!(created_response(&second.receipt)["name"], "Plan 2");
    assert_ne!(
        created_response(&a.receipt)["color"],
        created_response(&second.receipt)["color"]
    );
    command.idempotency_key = "create-existing-id".to_owned();
    command.data["id"] = json!(PROJECT);
    assert!(matches!(
        store.project_create(command.clone(), &provisioner).await,
        Err(StoreError::Database(_))
    ));
    assert_eq!(store.project_scope(PROJECT).await.unwrap().fence_epoch, 7);
    command.data = json!({"name":"Foreign ref", "goalIds":[FOREIGN_GOAL]});
    assert!(matches!(
        store.project_create(command, &provisioner).await,
        Err(StoreError::InvalidInput)
    ));
    assert_eq!(provisioner.requests.lock().unwrap().len(), 2);
}

impl TargetVerifier for SeedTargets {
    fn target_exists_in_organization(
        &self,
        organization_id: &str,
        project_org_id: &str,
        goal_org_id: &str,
        project_id: &str,
        goal_id: &str,
    ) -> bool {
        organization_id == ORG
            && project_org_id == ORG
            && goal_org_id == ORG
            && project_id == PROJECT
            && matches!(goal_id, GOAL | GOAL_TWO)
    }
}

impl GoalSetTargetVerifier for SeedTargets {
    fn goal_set_exists_in_organization(
        &self,
        organization_id: &str,
        project_id: &str,
        goal_ids: &[String],
    ) -> bool {
        organization_id == ORG
            && project_id == PROJECT
            && goal_ids
                .iter()
                .all(|goal_id| matches!(goal_id.as_str(), GOAL | GOAL_TWO))
    }
}

struct AnyTarget;

impl TargetVerifier for AnyTarget {
    fn target_exists_in_organization(
        &self,
        _organization_id: &str,
        _project_org_id: &str,
        _goal_org_id: &str,
        _project_id: &str,
        _goal_id: &str,
    ) -> bool {
        true
    }
}

fn project_goal_command(
    goal_id: &str,
    linked: bool,
    version: u64,
    operation: Operation,
    key: &str,
) -> ProjectGoalLinkCommand {
    project_goal_command_at_fence(goal_id, linked, version, 7, operation, key)
}

fn project_goal_command_at_fence(
    goal_id: &str,
    linked: bool,
    version: u64,
    fence_epoch: u64,
    operation: Operation,
    key: &str,
) -> ProjectGoalLinkCommand {
    let authority = ActorAuthority::verification_only("known-secret").unwrap();
    let binding: ActorBinding = serde_json::from_value(json!({
        "actor": {
            "ceo_agent": {
                "organization_id": ORG,
                "principal_id": CEO
            }
        },
        "proof": "73431c93f5c11188b21ad422ff959aa702c3b38d5780d060c0c2007309e7f2dd"
    }))
    .unwrap();
    let state = ProjectGoalLinkState::new(
        ORG,
        ORG,
        ORG,
        PROJECT,
        goal_id,
        version,
        fence_epoch,
        linked,
    );
    let context = state
        .validated_context(&binding, &authority, &SeedTargets)
        .unwrap();
    ProjectGoalLinkCommand::from_validated_context(context, operation, version, fence_epoch, key)
}

fn project_goal_command_from_state(
    state: ProjectGoalLinkState,
    operation: Operation,
    version: u64,
    fence_epoch: u64,
    key: &str,
) -> ProjectGoalLinkCommand {
    let authority = ActorAuthority::verification_only("known-secret").unwrap();
    let binding: ActorBinding = serde_json::from_value(json!({
        "actor": {
            "ceo_agent": {
                "organization_id": ORG,
                "principal_id": CEO
            }
        },
        "proof": "73431c93f5c11188b21ad422ff959aa702c3b38d5780d060c0c2007309e7f2dd"
    }))
    .unwrap();
    let context = state
        .validated_context(&binding, &authority, &SeedTargets)
        .unwrap();
    ProjectGoalLinkCommand::from_validated_context(context, operation, version, fence_epoch, key)
}

fn project_goal_set_command(
    goal_ids: Vec<String>,
    primary_goal_after: Option<String>,
    version: u64,
    key: &str,
) -> ProjectGoalSetReplacementCommand {
    let authority = ActorAuthority::verification_only("known-secret").unwrap();
    let binding: ActorBinding = serde_json::from_value(json!({
        "actor": {
            "ceo_agent": {
                "organization_id": ORG,
                "principal_id": CEO
            }
        },
        "proof": "73431c93f5c11188b21ad422ff959aa702c3b38d5780d060c0c2007309e7f2dd"
    }))
    .unwrap();
    let context = ValidatedGoalSetContext::from_target_snapshot(
        &binding,
        &authority,
        &SeedTargets,
        ORG,
        PROJECT,
        goal_ids,
        primary_goal_after,
    )
    .unwrap();
    ProjectGoalSetReplacementCommand::from_validated_context(context, version, 7, key)
}

const PATCH_AGENT: &str = "50000000-0000-4000-8000-000000000002";

fn project_patch_command(patch: serde_json::Value, version: u64, key: &str) -> ProjectPatchCommand {
    ProjectPatchCommand {
        organization_id: ORG.to_owned(),
        project_id: PROJECT.to_owned(),
        actor_kind: "agent".to_owned(),
        actor_id: PATCH_AGENT.to_owned(),
        run_id: None,
        idempotency_key: key.to_owned(),
        expected_version: version,
        fence_epoch: 7,
        patch,
        mutation_origin: ProjectPatchMutationOrigin::Standard,
    }
}

fn project_delete_command(version: u64, fence_epoch: u64, key: &str) -> ProjectDeleteCommand {
    ProjectDeleteCommand {
        organization_id: ORG.to_owned(),
        project_id: PROJECT.to_owned(),
        actor_kind: "board".to_owned(),
        actor_id: "board-user".to_owned(),
        run_id: None,
        idempotency_key: key.to_owned(),
        expected_version: version,
        fence_epoch,
    }
}

async fn seed_patch_agent(database: &Database) {
    sqlx::query(
        "INSERT INTO agents (id, org_id, name, role, status)
         VALUES ($1::uuid, $2::uuid, 'Project editor', 'engineer', 'idle')",
    )
    .bind(PATCH_AGENT)
    .bind(ORG)
    .execute(&database.pool)
    .await
    .unwrap();
}

async fn seed_project_goal_projection(database: &Database, goal_id: &str) {
    sqlx::query("UPDATE projects SET goal_id=$2::uuid WHERE id=$1::uuid AND org_id=$3::uuid")
        .bind(PROJECT)
        .bind(goal_id)
        .bind(ORG)
        .execute(&database.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO project_goals (project_id, goal_id, org_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid)",
    )
    .bind(PROJECT)
    .bind(goal_id)
    .bind(ORG)
    .execute(&database.pool)
    .await
    .unwrap();
}

async fn seed_project_resource_attachment(database: &Database) {
    sqlx::query(
        "INSERT INTO organization_resources
           (id, org_id, name, kind, source_type, locator)
         VALUES ($1::uuid, $2::uuid, 'Existing reference', 'file', 'external', 'https://example.test/existing')",
    )
    .bind(ASSET)
    .bind(ORG)
    .execute(&database.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO project_resource_attachments
           (org_id, project_id, resource_id, role, note, sort_order, is_primary)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'reference', 'Existing note', 0, false)",
    )
    .bind(ORG)
    .bind(PROJECT)
    .bind(ASSET)
    .execute(&database.pool)
    .await
    .unwrap();
}

async fn project_resource_attachment_snapshot(
    database: &Database,
    attachment_id: &str,
) -> serde_json::Value {
    let row = sqlx::query(
        "SELECT a.id::text AS attachment_id,
                a.org_id::text AS attachment_org_id,
                a.project_id::text AS project_id,
                a.resource_id::text AS resource_id,
                a.role,
                a.note,
                a.sort_order,
                a.is_primary,
                to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS attachment_created_at,
                to_char(a.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS attachment_updated_at,
                r.org_id::text AS resource_org_id,
                r.name AS resource_name,
                r.kind AS resource_kind,
                r.source_type AS resource_source_type,
                r.locator AS resource_locator,
                r.description AS resource_description,
                r.metadata::text AS resource_metadata,
                to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS resource_created_at,
                to_char(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS resource_updated_at
         FROM project_resource_attachments a
         JOIN organization_resources r
           ON r.org_id=a.org_id AND r.id=a.resource_id
         WHERE a.org_id=$1::uuid AND a.project_id=$2::uuid AND a.id::text=$3",
    )
    .bind(ORG)
    .bind(PROJECT)
    .bind(attachment_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    let resource_metadata: Option<String> = row.try_get("resource_metadata").unwrap();
    let resource_metadata = resource_metadata
        .map(|metadata| serde_json::from_str(&metadata).unwrap())
        .unwrap_or(serde_json::Value::Null);

    json!({
        "id": row.try_get::<String, _>("attachment_id").unwrap(),
        "orgId": row.try_get::<String, _>("attachment_org_id").unwrap(),
        "projectId": row.try_get::<String, _>("project_id").unwrap(),
        "resourceId": row.try_get::<String, _>("resource_id").unwrap(),
        "role": row.try_get::<String, _>("role").unwrap(),
        "note": row.try_get::<Option<String>, _>("note").unwrap(),
        "sortOrder": row.try_get::<i32, _>("sort_order").unwrap(),
        "isPrimary": row.try_get::<bool, _>("is_primary").unwrap(),
        "resource": {
            "id": row.try_get::<String, _>("resource_id").unwrap(),
            "orgId": row.try_get::<String, _>("resource_org_id").unwrap(),
            "name": row.try_get::<String, _>("resource_name").unwrap(),
            "kind": row.try_get::<String, _>("resource_kind").unwrap(),
            "sourceType": row.try_get::<String, _>("resource_source_type").unwrap(),
            "locator": row.try_get::<String, _>("resource_locator").unwrap(),
            "description": row.try_get::<Option<String>, _>("resource_description").unwrap(),
            "metadata": resource_metadata,
            "createdAt": row.try_get::<String, _>("resource_created_at").unwrap(),
            "updatedAt": row.try_get::<String, _>("resource_updated_at").unwrap(),
        },
        "createdAt": row.try_get::<String, _>("attachment_created_at").unwrap(),
        "updatedAt": row.try_get::<String, _>("attachment_updated_at").unwrap(),
    })
}

async fn project_primary(database: &Database) -> Option<String> {
    sqlx::query_scalar("SELECT goal_id::text FROM projects WHERE id=$1::uuid AND org_id=$2::uuid")
        .bind(PROJECT)
        .bind(ORG)
        .fetch_one(&database.pool)
        .await
        .unwrap()
}

async fn project_goals(database: &Database) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT goal_id::text
         FROM project_goals
         WHERE project_id=$1::uuid AND org_id=$2::uuid
         ORDER BY goal_id",
    )
    .bind(PROJECT)
    .bind(ORG)
    .fetch_all(&database.pool)
    .await
    .unwrap()
}

async fn project_details(database: &Database, activity_id: &str) -> serde_json::Value {
    let details: String = sqlx::query_scalar(
        "SELECT details::text
         FROM activity_log
         WHERE org_id=$1::uuid AND id=$2::uuid AND action='project.updated'",
    )
    .bind(ORG)
    .bind(activity_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    serde_json::from_str(&details).unwrap()
}

fn branding(key: &str, version: u64) -> OrganizationBrandingCommand {
    branding_at(key, version, 7)
}

fn branding_at(key: &str, version: u64, fence_epoch: u64) -> OrganizationBrandingCommand {
    OrganizationBrandingCommand::board(ORG, "board-user", key, version, fence_epoch)
        .with_brand_color(Some(branding_color(key)))
}

fn branding_color(key: &str) -> String {
    let digest = Sha256::digest(key.as_bytes());
    format!("#{:02x}{:02x}{:02x}", digest[0], digest[1], digest[2])
}

fn adapter_fingerprint(core_fingerprint: &str, primary_goal_after: Option<&str>) -> String {
    let identity = json!({
        "adapter_format": 1,
        "kind": "project_goal_link",
        "core_fingerprint": core_fingerprint,
        "primary_goal_after": primary_goal_after,
    });
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&identity).unwrap())
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn branding_applies_state_activity_and_immutable_receipt_atomically() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());

    let committed = store
        .branding(branding("branding-applied", 0))
        .await
        .unwrap();

    assert!(!committed.replayed);
    assert_eq!(committed.receipt.organization_id, ORG);
    assert_eq!(committed.receipt.version, 1);
    assert_eq!(committed.receipt.fence_epoch, 7);
    assert_eq!(
        database.brand_color().await,
        Some(branding_color("branding-applied"))
    );
    assert_eq!(database.counts().await, (1, 1, 1));
}

#[tokio::test(flavor = "multi_thread")]
async fn branding_replay_returns_original_receipt_after_a_later_mutation() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let first = store.branding(branding("branding-first", 0)).await.unwrap();
    store.branding(branding("branding-later", 1)).await.unwrap();

    let replay = store.branding(branding("branding-first", 0)).await.unwrap();

    assert!(replay.replayed);
    assert_eq!(replay.receipt, first.receipt);
    assert_eq!(
        database.brand_color().await,
        Some(branding_color("branding-later"))
    );
    assert_eq!(database.counts().await, (2, 2, 2));
}

#[tokio::test(flavor = "multi_thread")]
async fn branding_replay_rejects_a_semantically_tampered_snapshot() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let command = branding("branding-tamper", 0);
    store.branding(command.clone()).await.unwrap();
    database
        .sql(
            "ALTER TABLE organization_branding_mutation_receipts
             DISABLE TRIGGER organization_branding_mutation_receipts_guard;
             UPDATE organization_branding_mutation_receipts
             SET result=jsonb_set(result, '{result,state,name}', to_jsonb('Tampered'::text))
             WHERE org_id='10000000-0000-4000-8000-000000000001'
               AND idempotency_key='branding-tamper';
             ALTER TABLE organization_branding_mutation_receipts
             ENABLE TRIGGER organization_branding_mutation_receipts_guard;",
        )
        .await;

    assert!(matches!(
        store.branding(command).await,
        Err(StoreError::InvalidReceipt)
    ));
    assert_eq!(
        database.brand_color().await,
        Some(branding_color("branding-tamper"))
    );
    assert_eq!(database.counts().await, (1, 1, 1));
}

#[tokio::test(flavor = "multi_thread")]
async fn branding_replay_rejects_a_tampered_omitted_field() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let command = branding("branding-omitted-field-tamper", 0);
    store.branding(command.clone()).await.unwrap();
    database
        .sql(
            "ALTER TABLE organization_branding_mutation_receipts
             DISABLE TRIGGER organization_branding_mutation_receipts_guard;
             UPDATE organization_branding_mutation_receipts
             SET result=jsonb_set(result, '{result,state,description}', to_jsonb('Tampered'::text))
             WHERE org_id='10000000-0000-4000-8000-000000000001'
               AND idempotency_key='branding-omitted-field-tamper';
             ALTER TABLE organization_branding_mutation_receipts
             ENABLE TRIGGER organization_branding_mutation_receipts_guard;",
        )
        .await;

    assert!(matches!(
        store.branding(command).await,
        Err(StoreError::InvalidReceipt)
    ));
    assert_eq!(
        database.brand_color().await,
        Some(branding_color("branding-omitted-field-tamper"))
    );
    assert_eq!(database.counts().await, (1, 1, 1));
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_replay_rejects_a_semantically_tampered_transition() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let command = project_goal_command(GOAL, false, 0, Operation::Attach, "project-tamper");
    store
        .project_goal(command.clone(), Some(GOAL.to_owned()))
        .await
        .unwrap();
    database
        .sql(
            "ALTER TABLE organization_mutation_receipts
             DISABLE TRIGGER organization_mutation_receipts_guard;
             UPDATE organization_mutation_receipts
             SET result=jsonb_set(result, '{result,linked}', 'false'::jsonb)
             WHERE org_id='10000000-0000-4000-8000-000000000001'
               AND idempotency_key='project-tamper';
             ALTER TABLE organization_mutation_receipts
             ENABLE TRIGGER organization_mutation_receipts_guard;",
        )
        .await;

    assert!(matches!(
        store.project_goal(command, Some(GOAL.to_owned())).await,
        Err(StoreError::InvalidReceipt)
    ));
    assert_eq!(project_primary(&database).await.as_deref(), Some(GOAL));
    assert_eq!(project_goals(&database).await, vec![GOAL.to_owned()]);
    assert_eq!(database.counts().await, (1, 1, 1));
}

#[tokio::test(flavor = "multi_thread")]
async fn branding_conflicting_key_is_rejected_without_overwriting_original_evidence() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let first = store
        .branding(branding("branding-conflict", 0))
        .await
        .unwrap();

    let error = store
        .branding(branding("branding-conflict", 1))
        .await
        .unwrap_err();

    assert!(matches!(error, StoreError::IdempotencyConflict));
    assert_eq!(
        database.brand_color().await,
        Some(branding_color("branding-conflict"))
    );
    assert_eq!(database.counts().await, (1, 1, 1));
    let stored_fingerprint: String = sqlx::query_scalar(
        "SELECT command_fingerprint FROM organization_branding_mutation_receipts
         WHERE org_id=$1::uuid AND idempotency_key=$2",
    )
    .bind(ORG)
    .bind("branding-conflict")
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(stored_fingerprint, first.receipt.fingerprint);
}

#[tokio::test(flavor = "multi_thread")]
async fn branding_checks_owner_scope_freshness_and_bigint_boundaries() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());

    database
        .sql("UPDATE organization_branding_mutation_state SET owner='node', fence_epoch=8, fence_token='60000000-0000-4000-8000-000000000001' WHERE org_id='10000000-0000-4000-8000-000000000001'")
        .await;
    assert!(matches!(
        store.branding(branding("node-owned", 0)).await,
        Err(StoreError::NotOwned)
    ));
    database
        .sql("UPDATE organization_branding_mutation_state SET owner='rust', fence_epoch=9, fence_token='70000000-0000-4000-8000-000000000001' WHERE org_id='10000000-0000-4000-8000-000000000001'")
        .await;

    assert!(matches!(
        store.branding(branding_at("stale-version", 1, 9)).await,
        Err(StoreError::StaleVersion)
    ));
    let stale_fence = branding_at("stale-fence", 0, 8);
    assert!(matches!(
        store.branding(stale_fence).await,
        Err(StoreError::StaleFence)
    ));

    database
        .sql("UPDATE organization_branding_mutation_state SET mutation_version=9223372036854775807 WHERE org_id='10000000-0000-4000-8000-000000000001'")
        .await;
    assert!(matches!(
        store
            .branding(branding_at("version-overflow", i64::MAX as u64, 9))
            .await,
        Err(StoreError::VersionRange)
    ));
    assert!(matches!(
        store
            .branding(branding_at("u64-overflow", u64::MAX, 9))
            .await,
        Err(StoreError::VersionRange)
    ));
    assert_eq!(database.counts().await.1, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn branding_rejects_missing_and_cross_organization_resources() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());

    let missing_org = OrganizationBrandingCommand::board(
        "10000000-0000-4000-8000-000000000099",
        "board-user",
        "missing-org",
        0,
        7,
    )
    .with_brand_color(Some("#123456".to_owned()));
    assert!(matches!(
        store.branding(missing_org).await,
        Err(StoreError::NotFound)
    ));

    let foreign_asset = branding("foreign-asset", 0).with_logo_asset_id(Some(FOREIGN_ASSET.into()));
    assert!(matches!(
        store.branding(foreign_asset).await,
        Err(StoreError::InvalidInput)
    ));
    assert_eq!(database.name().await, "Original");
    assert_eq!(database.counts().await, (0, 0, 0));

    store
        .branding(branding("local-brand-color", 0))
        .await
        .unwrap();
    assert_eq!(
        database.brand_color().await,
        Some(branding_color("local-brand-color"))
    );
    assert_ne!(OTHER, ORG);
    assert_ne!(CEO, "board-user");
}

#[tokio::test(flavor = "multi_thread")]
async fn branding_rolls_back_business_state_version_activity_and_receipt_on_audit_failure() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    database
        .sql(
            "CREATE FUNCTION fail_d1_activity() RETURNS trigger
             LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit failure'; END; $$;
             CREATE TRIGGER fail_d1_activity_trigger
             BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION fail_d1_activity();",
        )
        .await;

    let error = store
        .branding(branding("audit-rollback", 0))
        .await
        .unwrap_err();

    assert!(matches!(error, StoreError::Database(_)));
    assert_eq!(database.name().await, "Original");
    assert_eq!(database.counts().await, (0, 0, 0));
    database
        .sql(
            "DROP TRIGGER fail_d1_activity_trigger ON activity_log;
             DROP FUNCTION fail_d1_activity();",
        )
        .await;
    store.branding(branding("audit-retry", 0)).await.unwrap();
    assert_eq!(database.counts().await, (1, 1, 1));
}

#[tokio::test(flavor = "multi_thread")]
async fn branding_rejects_inactive_ceo_before_replay_and_preserves_scope() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let command = OrganizationBrandingCommand::ceo_agent(ORG, CEO, "inactive-ceo", 0, 7)
        .with_brand_color(Some("#123456".to_owned()));
    database
        .sql(
            "UPDATE agents SET status='terminated' WHERE id='50000000-0000-4000-8000-000000000001'",
        )
        .await;

    assert!(matches!(
        store.branding(command).await,
        Err(StoreError::Unauthorized)
    ));
    assert_eq!(database.counts().await, (0, 0, 0));
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_mutations_keep_multi_goal_and_legacy_primary_projection_in_sync() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());

    let first = store
        .project_goal(
            project_goal_command(GOAL, false, 0, Operation::Attach, "project-first"),
            Some(GOAL.to_owned()),
        )
        .await
        .unwrap();
    assert!(!first.replayed);
    assert_eq!(first.receipt.version, 1);
    match &first.receipt.result {
        ResultState::ProjectGoalLink {
            linked,
            cancelled,
            primary_goal_after,
            ..
        } => {
            assert!(*linked);
            assert!(!*cancelled);
            assert_eq!(primary_goal_after.as_deref(), Some(GOAL));
        }
        result => panic!("unexpected project result: {result:?}"),
    }
    assert_eq!(project_primary(&database).await.as_deref(), Some(GOAL));
    assert_eq!(project_goals(&database).await, vec![GOAL.to_owned()]);
    assert_eq!(
        project_details(&database, required_activity_id(&first.receipt)).await["goalIds"],
        json!([GOAL])
    );
    let first_state = match &first.receipt.result {
        ResultState::ProjectGoalLink { state, .. } => state.as_ref().clone(),
        result => panic!("unexpected project result: {result:?}"),
    };

    let second = store
        .project_goal(
            project_goal_command(GOAL_TWO, false, 1, Operation::Attach, "project-second"),
            Some(GOAL.to_owned()),
        )
        .await
        .unwrap();
    assert_eq!(second.receipt.version, 2);
    assert_eq!(project_primary(&database).await.as_deref(), Some(GOAL));
    assert_eq!(
        project_goals(&database).await,
        vec![GOAL.to_owned(), GOAL_TWO.to_owned()]
    );
    assert_eq!(
        project_details(&database, required_activity_id(&second.receipt)).await["goalIds"],
        json!([GOAL, GOAL_TWO])
    );
    let second_state = match &second.receipt.result {
        ResultState::ProjectGoalLink { state, .. } => state.as_ref().clone(),
        result => panic!("unexpected project result: {result:?}"),
    };

    let detach_primary = store
        .project_goal(
            project_goal_command_from_state(
                first_state.rebase_scope(2, 7).unwrap(),
                Operation::Detach,
                2,
                7,
                "project-detach",
            ),
            Some(GOAL_TWO.to_owned()),
        )
        .await
        .unwrap();
    assert_eq!(detach_primary.receipt.version, 3);
    assert_eq!(project_primary(&database).await.as_deref(), Some(GOAL_TWO));
    assert_eq!(project_goals(&database).await, vec![GOAL_TWO.to_owned()]);
    assert_eq!(
        project_details(&database, required_activity_id(&detach_primary.receipt)).await["goalIds"],
        json!([GOAL_TWO])
    );

    let detach_last = store
        .project_goal(
            project_goal_command_from_state(
                second_state.rebase_scope(3, 7).unwrap(),
                Operation::Detach,
                3,
                7,
                "project-last",
            ),
            None,
        )
        .await
        .unwrap();
    assert_eq!(detach_last.receipt.version, 4);
    match &detach_last.receipt.result {
        ResultState::ProjectGoalLink {
            linked,
            cancelled,
            primary_goal_after,
            ..
        } => {
            assert!(!*linked);
            assert!(!*cancelled);
            assert_eq!(*primary_goal_after, None);
        }
        result => panic!("unexpected project result: {result:?}"),
    }
    assert_eq!(project_primary(&database).await, None);
    assert!(project_goals(&database).await.is_empty());
    assert_eq!(
        project_details(&database, required_activity_id(&detach_last.receipt)).await["goalIds"],
        json!([])
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_set_replacement_is_atomic_and_replays_its_original_receipt() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let first_command = project_goal_set_command(
        vec![GOAL.to_owned(), GOAL_TWO.to_owned()],
        Some(GOAL.to_owned()),
        0,
        "project-goal-set-first",
    );
    let first = store.project_goal_set(first_command.clone()).await.unwrap();

    assert!(!first.replayed);
    assert_eq!(first.receipt.version, 1);
    assert_eq!(project_primary(&database).await.as_deref(), Some(GOAL));
    assert_eq!(
        project_goals(&database).await,
        vec![GOAL.to_owned(), GOAL_TWO.to_owned()]
    );
    assert_eq!(
        project_details(&database, required_activity_id(&first.receipt)).await,
        json!({"goalIds": [GOAL, GOAL_TWO], "primaryGoalId": GOAL})
    );
    match &first.receipt.result {
        ResultState::ProjectGoalSetReplacement {
            project_id,
            goal_ids,
            primary_goal_after,
            ..
        } => {
            assert_eq!(project_id, PROJECT);
            assert_eq!(goal_ids, &[GOAL.to_owned(), GOAL_TWO.to_owned()]);
            assert_eq!(primary_goal_after.as_deref(), Some(GOAL));
        }
        result => panic!("unexpected project goal-set result: {result:?}"),
    }

    let later = store
        .project_goal_set(project_goal_set_command(
            vec![GOAL_TWO.to_owned()],
            Some(GOAL_TWO.to_owned()),
            1,
            "project-goal-set-later",
        ))
        .await
        .unwrap();
    assert_eq!(later.receipt.version, 2);

    let replay = store.project_goal_set(first_command).await.unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.receipt, first.receipt);
    assert_eq!(project_primary(&database).await.as_deref(), Some(GOAL_TWO));
    assert_eq!(project_goals(&database).await, vec![GOAL_TWO.to_owned()]);
    assert_eq!(database.counts().await, (2, 2, 2));
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_set_replacement_rolls_back_business_projection_receipt_and_audit() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    database
        .sql(
            "CREATE FUNCTION fail_goal_set_activity() RETURNS trigger
             LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test goal-set audit failure'; END; $$;
             CREATE TRIGGER fail_goal_set_activity_trigger
             BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION fail_goal_set_activity();",
        )
        .await;

    let error = store
        .project_goal_set(project_goal_set_command(
            vec![GOAL.to_owned(), GOAL_TWO.to_owned()],
            Some(GOAL.to_owned()),
            0,
            "project-goal-set-audit-rollback",
        ))
        .await
        .unwrap_err();

    assert!(matches!(error, StoreError::Database(_)));
    assert_eq!(project_primary(&database).await, None);
    assert!(project_goals(&database).await.is_empty());
    assert_eq!(database.counts().await, (0, 0, 0));
    database
        .sql(
            "DROP TRIGGER fail_goal_set_activity_trigger ON activity_log;
             DROP FUNCTION fail_goal_set_activity();",
        )
        .await;

    store
        .project_goal_set(project_goal_set_command(
            vec![GOAL_TWO.to_owned()],
            Some(GOAL_TWO.to_owned()),
            0,
            "project-goal-set-audit-retry",
        ))
        .await
        .unwrap();
    assert_eq!(project_primary(&database).await.as_deref(), Some(GOAL_TWO));
    assert_eq!(project_goals(&database).await, vec![GOAL_TWO.to_owned()]);
}

#[tokio::test(flavor = "multi_thread")]
async fn project_delete_large_response_survives_fence_cascade_restart_and_uuid_reuse() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let description = "large Project description\n".repeat(64 * 1024);
    assert!(description.len() > 1024 * 1024);
    sqlx::query("UPDATE projects SET description=$2 WHERE id=$1::uuid")
        .bind(PROJECT)
        .bind(&description)
        .execute(&database.pool)
        .await
        .unwrap();
    let command = project_delete_command(0, 7, "project-delete-replay");
    let deleted = store.project_delete(command.clone()).await.unwrap();

    assert!(!deleted.replayed);
    assert_eq!(deleted.receipt.version, 1);
    assert_eq!(deleted.receipt.fence_epoch, 7);
    match &deleted.receipt.result {
        ResultState::ProjectDeleted {
            project_id,
            response,
        } => {
            assert_eq!(project_id, PROJECT);
            assert_eq!(response["id"], PROJECT);
            assert_eq!(response["icon"], "folder");
            assert_eq!(response["urlKey"], "synthetic-project");
            assert_eq!(response["description"], description);
        }
        result => panic!("unexpected project delete result: {result:?}"),
    }

    let project_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1::uuid AND org_id=$2::uuid)",
    )
    .bind(PROJECT)
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    let project_fence_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM project_goal_mutation_state WHERE project_id=$1::uuid)",
    )
    .bind(PROJECT)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert!(!project_exists);
    assert!(!project_fence_exists);

    let receipt_result: String = sqlx::query_scalar(
        "SELECT result::text FROM organization_mutation_receipts
         WHERE org_id=$1::uuid AND idempotency_key=$2 AND command_kind='project_delete'",
    )
    .bind(ORG)
    .bind("project-delete-replay")
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert!(receipt_result.len() > 1024 * 1024);
    let receipt_result: serde_json::Value = serde_json::from_str(&receipt_result).unwrap();
    assert_eq!(receipt_result["result"]["kind"], "project_deleted");
    assert_eq!(receipt_result["result"]["project_id"], PROJECT);

    let outbox = sqlx::query(
        "SELECT event_type, state, payload::text AS payload
         FROM organization_mutation_outbox WHERE activity_id=$1::uuid",
    )
    .bind(required_activity_id(&deleted.receipt))
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(
        outbox.try_get::<String, _>("event_type").unwrap(),
        "activity.logged"
    );
    assert_eq!(outbox.try_get::<String, _>("state").unwrap(), "pending");
    let payload: String = outbox.try_get("payload").unwrap();
    let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(payload["action"], "project.deleted");
    assert_eq!(payload["entityId"], PROJECT);

    let audit_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND action='project.deleted'",
    )
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(audit_count, 1);

    sqlx::query(
        "INSERT INTO projects (id, org_id, name) VALUES ($1::uuid, $2::uuid, 'Replacement')",
    )
    .bind(PROJECT)
    .bind(ORG)
    .execute(&database.pool)
    .await
    .unwrap();
    database
        .sql(
            "UPDATE project_goal_mutation_state
             SET owner='rust', fence_epoch=8, fence_token=gen_random_uuid()
             WHERE project_id='20000000-0000-4000-8000-000000000001'",
        )
        .await;

    // A new store instance has no process-local deletion state to rely on.
    let restarted_store = MutationStore::new(database.pool.clone());
    let context = restarted_store
        .project_delete_context_for_idempotency(ORG, PROJECT, "project-delete-replay")
        .await
        .unwrap();
    assert_eq!(context.expected_version, 0);
    assert_eq!(context.fence_epoch, 7);
    let replay = restarted_store.project_delete(command).await.unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.receipt, deleted.receipt);

    let replacement_name: String =
        sqlx::query_scalar("SELECT name FROM projects WHERE id=$1::uuid")
            .bind(PROJECT)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    let replacement_fence_epoch: i64 = sqlx::query_scalar(
        "SELECT fence_epoch FROM project_goal_mutation_state WHERE project_id=$1::uuid",
    )
    .bind(PROJECT)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(replacement_name, "Replacement");
    assert_eq!(replacement_fence_epoch, 8);
    assert_eq!(database.counts().await, (0, 1, 1));

    let mut conflicting_command = project_delete_command(0, 7, "project-delete-replay");
    conflicting_command.actor_id = "different-board-user".to_owned();
    assert!(matches!(
        restarted_store.project_delete(conflicting_command).await,
        Err(StoreError::IdempotencyConflict)
    ));
    assert_eq!(database.counts().await, (0, 1, 1));

    let outbox_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM organization_mutation_outbox WHERE org_id=$1::uuid",
    )
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(outbox_count, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn project_delete_receipt_write_failure_rolls_back_project_cascade_fence_and_audit() {
    let database = Database::start().await;
    seed_project_goal_projection(&database, GOAL).await;
    let store = MutationStore::new(database.pool.clone());
    let command = project_delete_command(0, 7, "project-delete-receipt-recovery");
    database
        .sql(
            "CREATE FUNCTION fail_project_delete_receipt() RETURNS trigger
             LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test receipt storage failure'; END; $$;
             CREATE TRIGGER fail_project_delete_receipt_trigger
             BEFORE INSERT ON organization_mutation_receipts
             FOR EACH ROW EXECUTE FUNCTION fail_project_delete_receipt();",
        )
        .await;

    assert!(matches!(
        store.project_delete(command.clone()).await,
        Err(StoreError::Database(_))
    ));
    assert_eq!(database.counts().await, (0, 0, 0));
    assert_eq!(project_primary(&database).await.as_deref(), Some(GOAL));
    assert_eq!(project_goals(&database).await, vec![GOAL.to_owned()]);
    let scope = store.project_scope(PROJECT).await.unwrap();
    assert_eq!(scope.version, 0);
    assert_eq!(scope.fence_epoch, 7);
    let outbox_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM organization_mutation_outbox WHERE org_id=$1::uuid",
    )
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(outbox_count, 0);

    database
        .sql(
            "DROP TRIGGER fail_project_delete_receipt_trigger ON organization_mutation_receipts;
             DROP FUNCTION fail_project_delete_receipt();",
        )
        .await;
    let recovered = store.project_delete(command).await.unwrap();
    assert!(!recovered.replayed);
    assert!(project_goals(&database).await.is_empty());
    assert_eq!(database.counts().await, (0, 1, 1));
}

#[tokio::test(flavor = "multi_thread")]
async fn project_delete_audit_failure_rolls_back_delete_receipt_and_outbox_for_same_key_recovery() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let command = project_delete_command(0, 7, "project-delete-audit-recovery");
    database
        .sql(
            "CREATE FUNCTION fail_project_delete_activity() RETURNS trigger
             LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test project delete audit failure'; END; $$;
             CREATE TRIGGER fail_project_delete_activity_trigger
             BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION fail_project_delete_activity();",
        )
        .await;

    assert!(matches!(
        store.project_delete(command.clone()).await,
        Err(StoreError::Database(_))
    ));
    assert_eq!(database.counts().await, (0, 0, 0));
    let project_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1::uuid AND org_id=$2::uuid)",
    )
    .bind(PROJECT)
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    let project_fence_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM project_goal_mutation_state WHERE project_id=$1::uuid)",
    )
    .bind(PROJECT)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert!(project_exists);
    assert!(project_fence_exists);

    let outbox_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM organization_mutation_outbox WHERE org_id=$1::uuid",
    )
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(outbox_count, 0);
    database
        .sql(
            "DROP TRIGGER fail_project_delete_activity_trigger ON activity_log;
             DROP FUNCTION fail_project_delete_activity();",
        )
        .await;

    let recovered = store.project_delete(command).await.unwrap();
    assert!(!recovered.replayed);
    assert_eq!(recovered.receipt.version, 1);
    assert_eq!(database.counts().await, (0, 1, 1));
}

#[tokio::test(flavor = "multi_thread")]
async fn project_delete_rejects_node_owner_and_stale_epoch_without_partial_mutation() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    database
        .sql(
            "UPDATE project_goal_mutation_state
             SET owner='node', fence_epoch=8,
                 fence_token='60000000-0000-4000-8000-000000000001'
             WHERE project_id='20000000-0000-4000-8000-000000000001'",
        )
        .await;
    assert!(matches!(
        store
            .project_delete(project_delete_command(0, 8, "project-delete-node-owner"))
            .await,
        Err(StoreError::NotOwned)
    ));

    database
        .sql(
            "UPDATE project_goal_mutation_state
             SET owner='rust', fence_epoch=9,
                 fence_token='70000000-0000-4000-8000-000000000001'
             WHERE project_id='20000000-0000-4000-8000-000000000001'",
        )
        .await;
    assert!(matches!(
        store
            .project_delete(project_delete_command(0, 8, "project-delete-stale-epoch"))
            .await,
        Err(StoreError::StaleFence)
    ));

    let project_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1::uuid AND org_id=$2::uuid)",
    )
    .bind(PROJECT)
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert!(project_exists);
    assert_eq!(database.counts().await, (0, 0, 0));
}

#[tokio::test(flavor = "multi_thread")]
async fn mixed_project_patch_updates_project_goals_resources_and_activity_atomically() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    seed_patch_agent(&database).await;
    seed_project_resource_attachment(&database).await;
    let patch = json!({
        "goalIds": [GOAL, GOAL_TWO],
        "name": "Mixed transaction project",
        "description": "Updated with Goal links and resources",
        "status": "in_progress",
        "leadAgentId": CEO,
        "targetDate": "2026-10-01",
        "color": "#123abc",
        "icon": "folder",
        "executionWorkspacePolicy": {"enabled": true, "defaultMode": "shared_workspace"},
        "resourceAttachments": [{
            "resourceId": ASSET,
            "role": "reference",
            "note": " Existing reference ",
            "sortOrder": 2,
            "isPrimary": false
        }],
        "newResources": [{
            "name": "Inline brief",
            "kind": "file",
            "sourceType": "external",
            "locator": "https://example.test/brief.md",
            "description": "Generated in the same transaction",
            "metadata": {"origin": "project-patch-test"},
            "role": "deliverable",
            "note": " Current brief ",
            "sortOrder": 4,
            "isPrimary": true
        }],
        "archivedAt": "2026-09-28T10:30:00Z"
    });

    let committed = store
        .project_patch(project_patch_command(
            patch.clone(),
            0,
            "project-patch-mixed",
        ))
        .await
        .unwrap();

    assert!(!committed.replayed);
    assert_eq!(committed.receipt.version, 1);
    assert_eq!(project_primary(&database).await.as_deref(), Some(GOAL));
    assert_eq!(
        project_goals(&database).await,
        vec![GOAL.to_owned(), GOAL_TWO.to_owned()]
    );
    let project = sqlx::query(
        "SELECT name, description, status, lead_agent_id::text AS lead_agent_id,
                target_date::text AS target_date, color, icon,
                execution_workspace_policy::text AS execution_workspace_policy,
                archived_at::text AS archived_at
         FROM projects WHERE id=$1::uuid AND org_id=$2::uuid",
    )
    .bind(PROJECT)
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(
        project.try_get::<String, _>("name").unwrap(),
        "Mixed transaction project"
    );
    assert_eq!(
        project.try_get::<String, _>("description").unwrap(),
        "Updated with Goal links and resources"
    );
    assert_eq!(
        project.try_get::<String, _>("status").unwrap(),
        "in_progress"
    );
    assert_eq!(project.try_get::<String, _>("lead_agent_id").unwrap(), CEO);
    assert_eq!(
        project.try_get::<String, _>("target_date").unwrap(),
        "2026-10-01"
    );
    assert_eq!(
        project
            .try_get::<Option<String>, _>("color")
            .unwrap()
            .as_deref(),
        Some("#123abc")
    );
    assert_eq!(
        project
            .try_get::<Option<String>, _>("icon")
            .unwrap()
            .as_deref(),
        Some("folder")
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(
            &project
                .try_get::<String, _>("execution_workspace_policy")
                .unwrap()
        )
        .unwrap(),
        json!({"enabled": true, "defaultMode": "shared_workspace"})
    );
    assert!(
        project
            .try_get::<String, _>("archived_at")
            .unwrap()
            .starts_with("2026-09-28 10:30:00")
    );
    let attached: Vec<(String, String, Option<String>, i32, bool)> = sqlx::query_as(
        "SELECT r.name, a.role, a.note, a.sort_order, a.is_primary
         FROM project_resource_attachments a
         JOIN organization_resources r ON r.id=a.resource_id AND r.org_id=a.org_id
         WHERE a.org_id=$1::uuid AND a.project_id=$2::uuid
         ORDER BY a.sort_order, a.created_at",
    )
    .bind(ORG)
    .bind(PROJECT)
    .fetch_all(&database.pool)
    .await
    .unwrap();
    assert_eq!(attached.len(), 2);
    assert_eq!(
        attached[0],
        (
            "Existing reference".to_owned(),
            "reference".to_owned(),
            Some("Existing reference".to_owned()),
            2,
            false
        )
    );
    assert_eq!(attached[1].0, "Inline brief");
    assert_eq!(attached[1].1, "deliverable");
    assert_eq!(attached[1].2.as_deref(), Some("Current brief"));
    assert_eq!(attached[1].3, 4);
    assert!(attached[1].4);
    assert_eq!(
        project_details(&database, required_activity_id(&committed.receipt)).await,
        patch
    );
    assert_eq!(database.counts().await, (1, 1, 1));
    let outbox_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM organization_mutation_outbox WHERE org_id=$1::uuid",
    )
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(outbox_count, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn mixed_project_patch_preserves_goal_omission_and_nullable_scalar_semantics() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    seed_patch_agent(&database).await;
    seed_project_goal_projection(&database, GOAL).await;
    sqlx::query("UPDATE projects SET color='#123abc' WHERE id=$1::uuid AND org_id=$2::uuid")
        .bind(PROJECT)
        .bind(ORG)
        .execute(&database.pool)
        .await
        .unwrap();

    store
        .project_patch(project_patch_command(
            json!({"description": "Non-goal Project field changed"}),
            0,
            "project-patch-omitted-goals",
        ))
        .await
        .unwrap();
    assert_eq!(project_primary(&database).await.as_deref(), Some(GOAL));
    assert_eq!(project_goals(&database).await, vec![GOAL.to_owned()]);

    store
        .project_patch(project_patch_command(
            json!({"goalId": GOAL, "goalIds": [GOAL_TWO]}),
            1,
            "project-patch-goal-precedence",
        ))
        .await
        .unwrap();
    assert_eq!(project_primary(&database).await.as_deref(), Some(GOAL_TWO));
    assert_eq!(project_goals(&database).await, vec![GOAL_TWO.to_owned()]);

    store
        .project_patch(project_patch_command(
            json!({"goalId": null}),
            2,
            "project-patch-clear-goals",
        ))
        .await
        .unwrap();
    assert_eq!(project_primary(&database).await, None);
    assert!(project_goals(&database).await.is_empty());

    let description_before_clear: Option<String> = sqlx::query_scalar(
        "SELECT description FROM projects WHERE id=$1::uuid AND org_id=$2::uuid",
    )
    .bind(PROJECT)
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(
        description_before_clear.as_deref(),
        Some("Non-goal Project field changed")
    );
    store
        .project_patch(project_patch_command(
            json!({"goalIds": [GOAL], "description": null}),
            3,
            "project-patch-clear-nullable-description",
        ))
        .await
        .unwrap();
    let cleared_description: Option<String> = sqlx::query_scalar(
        "SELECT description FROM projects WHERE id=$1::uuid AND org_id=$2::uuid",
    )
    .bind(PROJECT)
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(cleared_description, None);
    assert_eq!(project_primary(&database).await.as_deref(), Some(GOAL));

    let color_before_omission: Option<String> =
        sqlx::query_scalar("SELECT color FROM projects WHERE id=$1::uuid AND org_id=$2::uuid")
            .bind(PROJECT)
            .bind(ORG)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert_eq!(color_before_omission.as_deref(), Some("#123abc"));
    store
        .project_patch(project_patch_command(
            json!({"goalIds": [GOAL_TWO], "status": "in_progress"}),
            4,
            "project-patch-omit-nullable-color",
        ))
        .await
        .unwrap();
    let preserved_color: Option<String> =
        sqlx::query_scalar("SELECT color FROM projects WHERE id=$1::uuid AND org_id=$2::uuid")
            .bind(PROJECT)
            .bind(ORG)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert_eq!(preserved_color.as_deref(), Some("#123abc"));
    assert_eq!(project_primary(&database).await.as_deref(), Some(GOAL_TWO));
    assert_eq!(database.counts().await, (5, 5, 5));
}

#[tokio::test(flavor = "multi_thread")]
async fn dedicated_project_resource_operations_preserve_identity_and_replay_atomically() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    seed_patch_agent(&database).await;
    sqlx::query(
        "INSERT INTO organization_resources
           (id, org_id, name, kind, source_type, locator)
         VALUES ($1::uuid, $2::uuid, 'New reference', 'file', 'external', 'https://example.test/new')",
    )
    .bind(ASSET)
    .bind(ORG)
    .execute(&database.pool)
    .await
    .unwrap();
    let before_attach: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM project_resource_attachments
         WHERE org_id=$1::uuid AND project_id=$2::uuid AND resource_id=$3::uuid",
    )
    .bind(ORG)
    .bind(PROJECT)
    .bind(ASSET)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(before_attach, 0);

    let attach_key = "project-resource-attach";
    let attach_command = project_patch_command(
        json!({
            "resourceAttachmentOperation": {
                "kind": "attach",
                "resourceId": ASSET,
                "role": "deliverable",
                "note": "Created through the public Project resource route",
                "sortOrder": 4,
                "isPrimary": true
            }
        }),
        0,
        attach_key,
    );
    let attached = store.project_patch(attach_command.clone()).await.unwrap();
    assert!(!attached.replayed);
    assert_eq!(attached.receipt.version, 1);
    let attached_row = sqlx::query(
        "SELECT id::text AS id, role, note, sort_order, is_primary
         FROM project_resource_attachments
         WHERE org_id=$1::uuid AND project_id=$2::uuid AND resource_id=$3::uuid",
    )
    .bind(ORG)
    .bind(PROJECT)
    .bind(ASSET)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    let attachment_id: String = attached_row.try_get("id").unwrap();
    assert_eq!(
        attached_row.try_get::<String, _>("role").unwrap(),
        "deliverable"
    );
    assert_eq!(
        attached_row.try_get::<Option<String>, _>("note").unwrap(),
        Some("Created through the public Project resource route".to_owned())
    );
    assert_eq!(attached_row.try_get::<i32, _>("sort_order").unwrap(), 4);
    assert!(attached_row.try_get::<bool, _>("is_primary").unwrap());
    let attached_snapshot = project_resource_attachment_snapshot(&database, &attachment_id).await;

    let update_key = "project-resource-update";
    let update_command = project_patch_command(
        json!({
            "resourceAttachmentOperation": {
                "kind": "update",
                "attachmentId": attachment_id,
                "role": "deliverable",
                "note": null,
                "isPrimary": false
            }
        }),
        1,
        update_key,
    );
    let updated = store.project_patch(update_command.clone()).await.unwrap();
    assert!(!updated.replayed);
    assert_eq!(updated.receipt.version, 2);
    let updated_row = sqlx::query(
        "SELECT id::text AS id, role, note, is_primary
         FROM project_resource_attachments
         WHERE org_id=$1::uuid AND project_id=$2::uuid AND resource_id=$3::uuid",
    )
    .bind(ORG)
    .bind(PROJECT)
    .bind(ASSET)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(
        updated_row.try_get::<String, _>("id").unwrap(),
        attachment_id
    );
    assert_eq!(
        updated_row.try_get::<String, _>("role").unwrap(),
        "deliverable"
    );
    assert_eq!(
        updated_row.try_get::<Option<String>, _>("note").unwrap(),
        None
    );
    assert!(!updated_row.try_get::<bool, _>("is_primary").unwrap());
    let updated_snapshot = project_resource_attachment_snapshot(&database, &attachment_id).await;

    let remove_key = "project-resource-remove";
    let remove_command = project_patch_command(
        json!({
            "resourceAttachmentOperation": {
                "kind": "remove",
                "attachmentId": attachment_id
            }
        }),
        2,
        remove_key,
    );
    let remove_snapshot = project_resource_attachment_snapshot(&database, &attachment_id).await;
    assert_eq!(remove_snapshot, updated_snapshot);
    let removed = store.project_patch(remove_command.clone()).await.unwrap();
    assert!(!removed.replayed);
    assert_eq!(removed.receipt.version, 3);
    let remaining: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM project_resource_attachments
         WHERE org_id=$1::uuid AND project_id=$2::uuid AND id::text=$3",
    )
    .bind(ORG)
    .bind(PROJECT)
    .bind(&attachment_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(remaining, 0);

    let attach_replay = store.project_patch(attach_command).await.unwrap();
    let update_replay = store.project_patch(update_command).await.unwrap();
    let remove_replay = store.project_patch(remove_command).await.unwrap();

    for (key, replay, original, expected_action, expected_status, expected_snapshot) in [
        (
            attach_key,
            &attach_replay,
            &attached,
            "project.resource.attached",
            201,
            &attached_snapshot,
        ),
        (
            update_key,
            &update_replay,
            &updated,
            "project.resource.updated",
            200,
            &updated_snapshot,
        ),
        (
            remove_key,
            &remove_replay,
            &removed,
            "project.resource.detached",
            200,
            &remove_snapshot,
        ),
    ] {
        assert!(replay.replayed);
        let persisted_receipt_json: String = sqlx::query_scalar(
            "SELECT result::text FROM organization_mutation_receipts
             WHERE org_id=$1::uuid AND idempotency_key=$2",
        )
        .bind(ORG)
        .bind(key)
        .fetch_one(&database.pool)
        .await
        .unwrap();
        let mut persisted_value: serde_json::Value =
            serde_json::from_str(&persisted_receipt_json).unwrap();
        let resource_response = persisted_value
            .as_object_mut()
            .and_then(|value| value.remove("resource_attachment_response"))
            .unwrap();
        assert_eq!(
            resource_response,
            json!({
                "status": expected_status,
                "body": expected_snapshot,
            })
        );
        let persisted_receipt: Receipt = serde_json::from_value(persisted_value).unwrap();
        assert_eq!(&persisted_receipt, &original.receipt);
        assert_eq!(&replay.receipt, &persisted_receipt);

        let (action, entity_type, entity_id): (String, String, String) = sqlx::query_as(
            "SELECT action, entity_type, entity_id FROM activity_log
             WHERE org_id=$1::uuid AND id=$2::uuid",
        )
        .bind(ORG)
        .bind(required_activity_id(&original.receipt))
        .fetch_one(&database.pool)
        .await
        .unwrap();
        assert_eq!(action, expected_action);
        assert_eq!(entity_type, "project_resource_attachment");
        assert_eq!(entity_id, attachment_id);

        let activity_outbox_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM organization_mutation_outbox
             WHERE org_id=$1::uuid AND activity_id=$2::uuid",
        )
        .bind(ORG)
        .bind(required_activity_id(&original.receipt))
        .fetch_one(&database.pool)
        .await
        .unwrap();
        assert_eq!(activity_outbox_count, 1);
        assert_eq!(database.counts().await, (3, 3, 3));
    }

    let outbox_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM organization_mutation_outbox WHERE org_id=$1::uuid",
    )
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(outbox_count, 3);
    let project_version: i64 = sqlx::query_scalar(
        "SELECT mutation_version FROM project_goal_mutation_state
         WHERE org_id=$1::uuid AND project_id=$2::uuid",
    )
    .bind(ORG)
    .bind(PROJECT)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(project_version, 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn mixed_project_patch_rejects_unauthorized_and_cross_organization_targets() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    seed_patch_agent(&database).await;

    let mut unauthorized = project_patch_command(
        json!({"name": "Unauthorized mutation"}),
        0,
        "project-patch-unauthorized",
    );
    unauthorized.actor_id = "60000000-0000-4000-8000-000000000001".to_owned();
    assert!(matches!(
        store.project_patch(unauthorized).await,
        Err(StoreError::Unauthorized)
    ));

    let mut foreign_project = project_patch_command(
        json!({"name": "Cross-organization mutation"}),
        0,
        "project-patch-foreign-project",
    );
    foreign_project.project_id = FOREIGN_PROJECT.to_owned();
    assert!(matches!(
        store.project_patch(foreign_project).await,
        Err(StoreError::NotFound)
    ));

    assert!(matches!(
        store
            .project_patch(project_patch_command(
                json!({"goalIds": [FOREIGN_GOAL]}),
                0,
                "project-patch-foreign-goal",
            ))
            .await,
        Err(StoreError::InvalidInput)
    ));
    assert_eq!(database.counts().await, (0, 0, 0));
    assert_eq!(project_primary(&database).await, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn mixed_project_patch_replay_returns_original_receipt_without_reapplying_resources() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    seed_patch_agent(&database).await;
    let original_command = project_patch_command(
        json!({
            "goalIds": [GOAL],
            "name": "Original patch",
            "newResources": [{
                "name": "Replay resource",
                "kind": "file",
                "sourceType": "external",
                "locator": "https://example.test/replay"
            }]
        }),
        0,
        "project-patch-replay",
    );
    let original = store.project_patch(original_command.clone()).await.unwrap();
    store
        .project_patch(project_patch_command(
            json!({"name": "Later mutation"}),
            1,
            "project-patch-later",
        ))
        .await
        .unwrap();

    let replay = store.project_patch(original_command).await.unwrap();

    assert!(replay.replayed);
    assert_eq!(replay.receipt, original.receipt);
    let current_name: String = sqlx::query_scalar("SELECT name FROM projects WHERE id=$1::uuid")
        .bind(PROJECT)
        .fetch_one(&database.pool)
        .await
        .unwrap();
    assert_eq!(current_name, "Later mutation");
    let resource_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM organization_resources WHERE org_id=$1::uuid")
            .bind(ORG)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert_eq!(resource_count, 1);
    assert_eq!(database.counts().await, (2, 2, 2));
}

#[tokio::test(flavor = "multi_thread")]
async fn organization_import_project_patch_keeps_fence_and_receipt_without_activity_or_outbox() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    seed_patch_agent(&database).await;
    let mut command = project_patch_command(
        json!({"name": "Imported project"}),
        0,
        "organization-import-project-patch",
    );
    command.mutation_origin = ProjectPatchMutationOrigin::OrganizationImport;

    let committed = store.project_patch(command.clone()).await.unwrap();
    assert!(!committed.replayed);
    assert_eq!(committed.receipt.version, 1);
    assert_eq!(committed.receipt.activity_id, None);
    match &committed.receipt.result {
        ResultState::ProjectPatch {
            mutation_origin, ..
        } => assert_eq!(
            *mutation_origin,
            Some(ProjectPatchMutationOrigin::OrganizationImport)
        ),
        result => panic!("unexpected project result: {result:?}"),
    }

    let persisted: (Option<String>, serde_json::Value) = sqlx::query_as(
        "SELECT activity_id::text, result
         FROM organization_mutation_receipts
         WHERE org_id=$1::uuid AND idempotency_key=$2",
    )
    .bind(ORG)
    .bind(&command.idempotency_key)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(persisted.0, None);
    assert_eq!(
        persisted.1["result"]["mutation_origin"],
        "organization_import"
    );

    let audit_counts: (i64, i64, i64) = sqlx::query_as(
        "SELECT
           (SELECT count(*) FROM activity_log WHERE org_id=$1::uuid),
           (SELECT count(*) FROM organization_mutation_outbox WHERE org_id=$1::uuid),
           (SELECT count(*) FROM organization_mutation_receipts WHERE org_id=$1::uuid)",
    )
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(audit_counts, (0, 0, 1));
    let state: (i64, i64, String) = sqlx::query_as(
        "SELECT mutation_version, fence_epoch, owner
         FROM project_goal_mutation_state WHERE project_id=$1::uuid",
    )
    .bind(PROJECT)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(state, (1, 7, "rust".to_owned()));

    let replay = store.project_patch(command.clone()).await.unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.receipt, committed.receipt);
    assert_eq!(database.counts().await, (1, 0, 1));

    let mut different_actor = command;
    different_actor.actor_id = CEO.to_owned();
    assert!(matches!(
        store.project_patch(different_actor).await,
        Err(StoreError::IdempotencyConflict)
    ));
    assert_eq!(database.counts().await, (1, 0, 1));
}

#[tokio::test(flavor = "multi_thread")]
async fn mixed_project_patch_rolls_back_fields_goals_resources_fence_audit_and_outbox() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    seed_patch_agent(&database).await;
    seed_project_goal_projection(&database, GOAL).await;
    seed_project_resource_attachment(&database).await;
    database
        .sql(
            "CREATE FUNCTION fail_mixed_patch_activity() RETURNS trigger
             LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test mixed patch audit failure'; END; $$;
             CREATE TRIGGER fail_mixed_patch_activity_trigger
             BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION fail_mixed_patch_activity();",
        )
        .await;

    let command = project_patch_command(
        json!({
            "goalIds": [GOAL_TWO],
            "name": "Must roll back",
            "resourceAttachments": [],
            "newResources": [{
                "name": "Must roll back too",
                "kind": "file",
                "sourceType": "external",
                "locator": "https://example.test/rollback"
            }]
        }),
        0,
        "project-patch-rollback",
    );
    assert!(matches!(
        store.project_patch(command.clone()).await,
        Err(StoreError::Database(_))
    ));

    let current_name: String = sqlx::query_scalar("SELECT name FROM projects WHERE id=$1::uuid")
        .bind(PROJECT)
        .fetch_one(&database.pool)
        .await
        .unwrap();
    assert_eq!(current_name, "Synthetic project");
    assert_eq!(project_primary(&database).await.as_deref(), Some(GOAL));
    assert_eq!(project_goals(&database).await, vec![GOAL.to_owned()]);
    let resource_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM organization_resources WHERE org_id=$1::uuid")
            .bind(ORG)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    let attachment_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM project_resource_attachments WHERE org_id=$1::uuid AND project_id=$2::uuid",
    )
    .bind(ORG)
    .bind(PROJECT)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(resource_count, 1);
    assert_eq!(attachment_count, 1);
    assert_eq!(database.counts().await, (0, 0, 0));
    let outbox_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM organization_mutation_outbox WHERE org_id=$1::uuid",
    )
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(outbox_count, 0);

    database
        .sql(
            "DROP TRIGGER fail_mixed_patch_activity_trigger ON activity_log;
             DROP FUNCTION fail_mixed_patch_activity();",
        )
        .await;
    let retry = store.project_patch(command).await.unwrap();
    assert_eq!(retry.receipt.version, 1);
    assert_eq!(project_primary(&database).await.as_deref(), Some(GOAL_TWO));
    assert_eq!(project_goals(&database).await, vec![GOAL_TWO.to_owned()]);
    let resource_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM organization_resources WHERE org_id=$1::uuid")
            .bind(ORG)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert_eq!(resource_count, 2);
    assert_eq!(database.counts().await, (1, 1, 1));
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_rejects_a_primary_goal_that_is_not_in_the_project_set() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());

    let error = store
        .project_goal(
            project_goal_command(GOAL, false, 0, Operation::Attach, "project-invalid-primary"),
            Some(GOAL_TWO.to_owned()),
        )
        .await
        .unwrap_err();

    assert!(matches!(error, StoreError::InvalidProjection));
    assert_eq!(database.counts().await, (0, 0, 0));
    assert_eq!(project_primary(&database).await, None);
    assert!(project_goals(&database).await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_rejects_cross_organization_projection_targets_in_postgres() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let authority = ActorAuthority::verification_only("known-secret").unwrap();
    let binding: ActorBinding = serde_json::from_value(json!({
        "actor": {
            "ceo_agent": {
                "organization_id": ORG,
                "principal_id": CEO
            }
        },
        "proof": "73431c93f5c11188b21ad422ff959aa702c3b38d5780d060c0c2007309e7f2dd"
    }))
    .unwrap();

    for (project_id, goal_id, key) in [
        (FOREIGN_PROJECT, FOREIGN_GOAL, "foreign-both"),
        (PROJECT, FOREIGN_GOAL, "foreign-goal"),
    ] {
        let state = ProjectGoalLinkState::new(ORG, ORG, ORG, project_id, goal_id, 0, 7, false);
        let context = state
            .validated_context(&binding, &authority, &AnyTarget)
            .unwrap();
        let error = store
            .project_goal(
                ProjectGoalLinkCommand::from_validated_context(
                    context,
                    Operation::Attach,
                    0,
                    7,
                    key,
                ),
                Some(goal_id.to_owned()),
            )
            .await
            .unwrap_err();
        assert!(matches!(error, StoreError::NotFound));
    }
    assert_eq!(database.counts().await, (0, 0, 0));
    assert!(project_goals(&database).await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_replay_returns_the_original_receipt_after_later_mutations() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let first_command = project_goal_command(GOAL, false, 0, Operation::Attach, "project-replay");
    let first = store
        .project_goal(first_command.clone(), Some(GOAL.to_owned()))
        .await
        .unwrap();
    store
        .project_goal(
            project_goal_command(GOAL_TWO, false, 1, Operation::Attach, "project-later"),
            Some(GOAL.to_owned()),
        )
        .await
        .unwrap();

    let replay = store
        .project_goal(first_command, Some(GOAL.to_owned()))
        .await
        .unwrap();

    assert!(replay.replayed);
    assert_eq!(replay.receipt, first.receipt);
    assert_eq!(database.counts().await, (2, 2, 2));
    assert_eq!(project_primary(&database).await.as_deref(), Some(GOAL));
    assert_eq!(
        project_goals(&database).await,
        vec![GOAL.to_owned(), GOAL_TWO.to_owned()]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_replay_rejects_a_missing_predecessor_in_history() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let attached = store
        .project_goal(
            project_goal_command(GOAL, false, 0, Operation::Attach, "history-predecessor"),
            Some(GOAL.to_owned()),
        )
        .await
        .unwrap();
    let attached_state = match &attached.receipt.result {
        ResultState::ProjectGoalLink { state, .. } => state.as_ref().clone(),
        result => panic!("unexpected project result: {result:?}"),
    };
    let detached_command =
        project_goal_command_from_state(attached_state, Operation::Detach, 1, 7, "history-replay");
    store
        .project_goal(detached_command.clone(), None)
        .await
        .unwrap();

    database
        .sql(
            "ALTER TABLE organization_mutation_receipts
             DISABLE TRIGGER organization_mutation_receipts_guard;
             DELETE FROM organization_mutation_receipts
             WHERE org_id='10000000-0000-4000-8000-000000000001'
               AND idempotency_key='history-predecessor';
             ALTER TABLE organization_mutation_receipts
             ENABLE TRIGGER organization_mutation_receipts_guard;",
        )
        .await;

    assert!(matches!(
        store.project_goal(detached_command, None).await,
        Err(StoreError::InvalidReceipt)
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_replay_rejects_a_forked_history() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let first_command = project_goal_command(GOAL, false, 0, Operation::Attach, "fork-first");
    store
        .project_goal(first_command.clone(), Some(GOAL.to_owned()))
        .await
        .unwrap();

    let branch_context = ProjectGoalLinkState::bootstrap(ORG, ORG, ORG, PROJECT, GOAL, 1, 7, true);
    let branch_command = project_goal_command_from_state(
        branch_context.clone(),
        Operation::Attach,
        1,
        7,
        "fork-branch",
    );
    let branch_view = branch_command.as_integration_view().unwrap();
    let branch_state = branch_view.resulting_state().unwrap();
    let core_fingerprint = branch_view.fingerprint().unwrap();
    let primary_goal_after = Some(GOAL.to_owned());
    let activity_id = "70000000-0000-4000-8000-000000000001";
    let receipt = Receipt {
        organization_id: ORG.to_owned(),
        version: branch_state.version,
        fence_epoch: branch_state.fence_epoch,
        fingerprint: adapter_fingerprint(&core_fingerprint, primary_goal_after.as_deref()),
        activity_id: Some(activity_id.to_owned()),
        outcome: Outcome::Noop,
        result: ResultState::ProjectGoalLink {
            state: Box::new(branch_state.clone()),
            project_id: PROJECT.to_owned(),
            goal_id: GOAL.to_owned(),
            operation: Operation::Attach,
            link_identifier: branch_view.link_identifier().unwrap(),
            core_fingerprint,
            target_version: branch_context.version,
            target_fence_epoch: branch_context.fence_epoch,
            linked: branch_state.linked,
            cancelled: branch_state.cancelled,
            primary_goal_after,
            state_integrity: branch_state.state_integrity().to_owned(),
            target_integrity: branch_context.state_integrity().to_owned(),
        },
    };
    let receipt_json = serde_json::to_string(&receipt).unwrap();
    database
        .sql(
            "INSERT INTO activity_log
             (id, org_id, actor_type, actor_id, action, entity_type, entity_id, details, idempotency_key)
             VALUES
             ('70000000-0000-4000-8000-000000000001'::uuid,
              '10000000-0000-4000-8000-000000000001'::uuid,
              'user', 'board-user', 'project.updated', 'project',
              '20000000-0000-4000-8000-000000000001', '{}'::jsonb, 'rust-d1:fork-branch')",
        )
        .await;
    sqlx::query(
        "INSERT INTO organization_mutation_receipts
         (org_id, idempotency_key, command_kind, command_fingerprint, receipt_format,
          outcome, resulting_version, fence_epoch, activity_id, result)
         VALUES ($1::uuid, $2, 'project_goal_link', $3, 2, 'noop', $4, $5, $6::uuid, $7::jsonb)",
    )
    .bind(ORG)
    .bind("fork-branch")
    .bind(&receipt.fingerprint)
    .bind(i64::try_from(receipt.version).unwrap())
    .bind(i64::try_from(receipt.fence_epoch).unwrap())
    .bind(activity_id)
    .bind(receipt_json)
    .execute(&database.pool)
    .await
    .unwrap();

    assert!(matches!(
        store
            .project_goal(first_command, Some(GOAL.to_owned()))
            .await,
        Err(StoreError::InvalidReceipt)
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_cancel_is_durable_terminal_and_replays_after_scope_advances() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let attached = store
        .project_goal(
            project_goal_command(GOAL, false, 0, Operation::Attach, "cancel-attach"),
            Some(GOAL.to_owned()),
        )
        .await
        .unwrap();
    let attached_state = match &attached.receipt.result {
        ResultState::ProjectGoalLink { state, .. } => state.as_ref().clone(),
        result => panic!("unexpected project result: {result:?}"),
    };
    let cancel_command = project_goal_command_from_state(
        attached_state.rebase_scope(1, 7).unwrap(),
        Operation::Cancel,
        1,
        7,
        "cancel-link",
    );
    let cancelled = store
        .project_goal(cancel_command.clone(), Some(GOAL.to_owned()))
        .await
        .unwrap();
    assert!(!cancelled.replayed);
    assert_eq!(cancelled.receipt.version, 2);
    assert_eq!(cancelled.receipt.fence_epoch, 8);
    match &cancelled.receipt.result {
        ResultState::ProjectGoalLink {
            state,
            linked,
            cancelled,
            ..
        } => {
            assert!(state.cancelled);
            assert!(*linked);
            assert!(*cancelled);
        }
        result => panic!("unexpected project result: {result:?}"),
    }

    store
        .branding(branding_at("after-cancel-branding", 0, 7))
        .await
        .unwrap();
    let replay = store
        .project_goal(cancel_command, Some(GOAL.to_owned()))
        .await
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.receipt, cancelled.receipt);

    let cancelled_state = match &cancelled.receipt.result {
        ResultState::ProjectGoalLink { state, .. } => state.as_ref().clone(),
        result => panic!("unexpected project result: {result:?}"),
    };
    let error = store
        .project_goal(
            project_goal_command_from_state(
                cancelled_state.rebase_scope(2, 8).unwrap(),
                Operation::Attach,
                2,
                8,
                "cancel-new-key",
            ),
            Some(GOAL.to_owned()),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        StoreError::Link(rudder_project_goal_link_core::LinkMutationError::Cancelled)
    ));
    // Branding and project-goal mutations now own independent version rows;
    // this workflow has two project receipts, three activities, and three
    // total receipts after the independent branding mutation.
    assert_eq!(database.counts().await, (2, 3, 3));
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_noop_persists_new_integrity_and_rejects_stale_context() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let first = store
        .project_goal(
            project_goal_command(GOAL, false, 0, Operation::Attach, "noop-attach"),
            Some(GOAL.to_owned()),
        )
        .await
        .unwrap();
    let first_state = match &first.receipt.result {
        ResultState::ProjectGoalLink { state, .. } => state.as_ref().clone(),
        result => panic!("unexpected project result: {result:?}"),
    };
    let noop = store
        .project_goal(
            project_goal_command_from_state(
                first_state.rebase_scope(1, 7).unwrap(),
                Operation::Attach,
                1,
                7,
                "noop-second-key",
            ),
            Some(GOAL.to_owned()),
        )
        .await
        .unwrap();
    assert_eq!(noop.receipt.outcome, rudder_d1_persistence::Outcome::Noop);
    assert_eq!(noop.receipt.version, 1);
    assert_eq!(noop.receipt.fence_epoch, 7);
    let noop_integrity = match &noop.receipt.result {
        ResultState::ProjectGoalLink { state, .. } => state.state_integrity().to_owned(),
        result => panic!("unexpected project result: {result:?}"),
    };
    assert_ne!(noop_integrity, first_state.state_integrity());

    let error = store
        .project_goal(
            project_goal_command_from_state(
                first_state.rebase_scope(1, 7).unwrap(),
                Operation::Attach,
                1,
                7,
                "noop-stale-context",
            ),
            Some(GOAL.to_owned()),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        StoreError::Link(rudder_project_goal_link_core::LinkMutationError::TargetStateMismatch)
    ));
    assert_eq!(database.counts().await, (1, 2, 2));
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_respects_owner_fence_and_ceo_authority_before_mutation() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());

    database
        .sql("UPDATE project_goal_mutation_state SET owner='node', fence_epoch=8, fence_token='60000000-0000-4000-8000-000000000001' WHERE project_id='20000000-0000-4000-8000-000000000001'")
        .await;
    assert!(matches!(
        store
            .project_goal(
                project_goal_command(GOAL, false, 0, Operation::Attach, "project-node-owned"),
                Some(GOAL.to_owned()),
            )
            .await,
        Err(StoreError::NotOwned)
    ));

    database
        .sql("UPDATE project_goal_mutation_state SET owner='rust', fence_epoch=9, fence_token='70000000-0000-4000-8000-000000000001' WHERE project_id='20000000-0000-4000-8000-000000000001'")
        .await;
    assert!(matches!(
        store
            .project_goal(
                project_goal_command(GOAL, false, 0, Operation::Attach, "project-stale-fence"),
                Some(GOAL.to_owned()),
            )
            .await,
        Err(StoreError::StaleFence)
    ));

    database
        .sql(
            "UPDATE agents SET status='terminated' WHERE id='50000000-0000-4000-8000-000000000001'",
        )
        .await;
    assert!(matches!(
        store
            .project_goal(
                project_goal_command_at_fence(
                    GOAL,
                    false,
                    0,
                    9,
                    Operation::Attach,
                    "project-inactive-ceo",
                ),
                Some(GOAL.to_owned()),
            )
            .await,
        Err(StoreError::Unauthorized)
    ));
    assert_eq!(database.counts().await, (0, 0, 0));
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_rejects_stale_version_and_bigint_overflow_without_partial_mutation() {
    let max = i64::MAX as u64;

    {
        let database = Database::start().await;
        let store = MutationStore::new(database.pool.clone());

        database
            .sql("UPDATE project_goal_mutation_state SET mutation_version=1 WHERE project_id='20000000-0000-4000-8000-000000000001'")
            .await;
        assert!(matches!(
            store
                .project_goal(
                    project_goal_command(
                        GOAL,
                        false,
                        0,
                        Operation::Attach,
                        "project-stale-version"
                    ),
                    Some(GOAL.to_owned()),
                )
                .await,
            Err(StoreError::StaleVersion)
        ));

        database
            .sql("UPDATE project_goal_mutation_state SET mutation_version=9223372036854775807, fence_epoch=7 WHERE project_id='20000000-0000-4000-8000-000000000001'")
            .await;
        assert!(matches!(
            store
                .project_goal(
                    project_goal_command(
                        GOAL,
                        false,
                        max,
                        Operation::Attach,
                        "project-version-overflow"
                    ),
                    Some(GOAL.to_owned()),
                )
                .await,
            Err(StoreError::VersionRange)
        ));
        assert_eq!(database.counts().await, (i64::MAX, 0, 0));
    }

    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    database
        .sql("UPDATE project_goal_mutation_state SET fence_epoch=9223372036854775807, fence_token='80000000-0000-4000-8000-000000000001' WHERE project_id='20000000-0000-4000-8000-000000000001'")
        .await;
    assert!(matches!(
        store
            .project_goal(
                project_goal_command_at_fence(
                    GOAL,
                    false,
                    0,
                    max,
                    Operation::Cancel,
                    "project-fence-overflow",
                ),
                None,
            )
            .await,
        Err(StoreError::VersionRange)
    ));
    assert_eq!(database.counts().await, (0, 0, 0));
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_rolls_back_link_projection_and_receipt_on_audit_failure() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    database
        .sql(
            "CREATE FUNCTION fail_d1_project_activity() RETURNS trigger
             LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test project audit failure'; END; $$;
             CREATE TRIGGER fail_d1_project_activity_trigger
             BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION fail_d1_project_activity();",
        )
        .await;

    let error = store
        .project_goal(
            project_goal_command(GOAL, false, 0, Operation::Attach, "project-rollback"),
            Some(GOAL.to_owned()),
        )
        .await
        .unwrap_err();

    assert!(matches!(error, StoreError::Database(_)));
    assert_eq!(database.counts().await, (0, 0, 0));
    assert_eq!(project_primary(&database).await, None);
    assert!(project_goals(&database).await.is_empty());
    database
        .sql(
            "DROP TRIGGER fail_d1_project_activity_trigger ON activity_log;
             DROP FUNCTION fail_d1_project_activity();",
        )
        .await;
    store
        .project_goal(
            project_goal_command(GOAL, false, 0, Operation::Attach, "project-retry"),
            Some(GOAL.to_owned()),
        )
        .await
        .unwrap();
    assert_eq!(database.counts().await, (1, 1, 1));
}

#[tokio::test(flavor = "multi_thread")]
async fn project_goal_rejects_the_1025th_link_without_partial_projection() {
    let database = Database::start().await;
    let store = MutationStore::new(database.pool.clone());
    let mut goal_values = String::from("INSERT INTO goals (id, org_id, title) VALUES ");
    let mut link_values =
        String::from("INSERT INTO project_goals (project_id, goal_id, org_id) VALUES ");
    let mut first_goal = String::new();
    for index in 0..1024_u32 {
        let goal_id = format!("60000000-0000-4000-8000-{index:012x}");
        if index == 0 {
            first_goal = goal_id.clone();
        }
        if index > 0 {
            goal_values.push_str(", ");
            link_values.push_str(", ");
        }
        goal_values.push_str(&format!(
            "('{goal_id}'::uuid, '{ORG}'::uuid, 'Capacity goal')"
        ));
        link_values.push_str(&format!(
            "('{PROJECT}'::uuid, '{goal_id}'::uuid, '{ORG}'::uuid)"
        ));
    }
    database.sql(&goal_values).await;
    database.sql(&link_values).await;
    database
        .sql(&format!(
            "UPDATE projects SET goal_id='{first_goal}'::uuid WHERE id='{PROJECT}'::uuid"
        ))
        .await;

    let error = store
        .project_goal(
            project_goal_command(GOAL, false, 0, Operation::Attach, "project-capacity"),
            Some(first_goal.clone()),
        )
        .await
        .unwrap_err();

    assert!(matches!(error, StoreError::InvalidInput));
    assert_eq!(database.counts().await, (0, 0, 0));
    assert_eq!(
        project_primary(&database).await.as_deref(),
        Some(first_goal.as_str())
    );
    assert_eq!(project_goals(&database).await.len(), 1024);
}

#[test]
fn project_goal_entry_consumes_an_opaque_core_command_without_a_second_json_path() {
    fn accepts_command(
        store: &MutationStore,
        command: rudder_project_goal_link_core::ProjectGoalLinkCommand,
    ) {
        let _future = store.project_goal(command, None);
    }

    let _ = accepts_command;
}
