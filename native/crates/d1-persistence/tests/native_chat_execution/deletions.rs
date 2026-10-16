use super::*;
use std::sync::Arc;

const ISSUE_DELETE: &str = "21000000-0000-4000-8000-000000000211";
const ISSUE_PROJECT_DELETE: &str = "21000000-0000-4000-8000-000000000212";
const PROJECT_WORKSPACE: &str = "22000000-0000-4000-8000-000000000211";

async fn generation_id(database: &Database, run_id: &str) -> String {
    sqlx::query_scalar(
        "SELECT chat_generation_id::text FROM heartbeat_runs
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read generation id before concurrent Agent deletion")
}

async fn assert_generation_unclaimed(database: &Database, generation_id: &str) {
    let state: (bool, bool, bool, i64) = sqlx::query_as(
        "SELECT native_admission_hold, control_owner_token IS NULL,
                control_lease_expires_at IS NULL,
                (SELECT count(*) FROM activity_log a
                 WHERE a.org_id=$1::uuid AND a.entity_id=g.id::text
                   AND a.action='runtime.native_chat.execution_claimed')
         FROM chat_generations g WHERE g.org_id=$1::uuid AND g.id=$2::uuid",
    )
    .bind(ORG)
    .bind(generation_id)
    .fetch_one(&database.pool)
    .await
    .expect("read generation after concurrent Agent deletion");
    assert_eq!(state, (false, true, true, 0));
}

async fn remove_agent_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    agent_id: &str,
) {
    sqlx::query("SELECT set_config('rudder.native_chat_write', 'native_chat:execution', true)")
        .execute(&mut **tx)
        .await
        .expect("authorize the test's Rust-owned Native Chat cleanup");
    for statement in [
        "DELETE FROM issue_block_audit_attempts WHERE org_id=$1::uuid AND agent_id=$2::uuid",
        "DELETE FROM heartbeat_run_events WHERE org_id=$1::uuid AND agent_id=$2::uuid",
        "DELETE FROM agent_task_sessions WHERE org_id=$1::uuid AND agent_id=$2::uuid",
        "DELETE FROM organization_mutation_outbox
         WHERE activity_id IN (
           SELECT id FROM activity_log
           WHERE org_id=$1::uuid AND run_id IN (
             SELECT id FROM heartbeat_runs WHERE org_id=$1::uuid AND agent_id=$2::uuid
           )
         )",
        "DELETE FROM activity_log
         WHERE org_id=$1::uuid AND run_id IN (
           SELECT id FROM heartbeat_runs WHERE org_id=$1::uuid AND agent_id=$2::uuid
         )",
        "DELETE FROM heartbeat_runs WHERE org_id=$1::uuid AND agent_id=$2::uuid",
        "DELETE FROM agent_wakeup_requests WHERE org_id=$1::uuid AND agent_id=$2::uuid",
        "DELETE FROM agent_api_keys WHERE org_id=$1::uuid AND agent_id=$2::uuid",
        "DELETE FROM agent_runtime_state WHERE org_id=$1::uuid AND agent_id=$2::uuid",
        "DELETE FROM agents WHERE org_id=$1::uuid AND id=$2::uuid",
    ] {
        sqlx::query(statement)
            .bind(ORG)
            .bind(agent_id)
            .execute(&mut **tx)
            .await
            .expect("execute existing Agent-removal cleanup step");
    }
}

async fn assert_no_claim_effects(database: &Database, run_id: &str) {
    let state: (bool, bool, bool, bool, i64) = sqlx::query_as(
        "SELECT g.native_admission_hold, r.native_admission_hold,
                g.control_owner_token IS NULL, g.control_lease_expires_at IS NULL,
                (SELECT count(*) FROM activity_log a
                 WHERE a.org_id=$1::uuid AND a.entity_id=g.id::text
                   AND a.action='runtime.native_chat.execution_claimed')
         FROM heartbeat_runs r
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read first-claim state after concurrent deletion");
    assert_eq!(state, (false, false, true, true, 0));
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_delete_lock_conflict_is_bounded_and_has_no_claim_effects() {
    let database = Database::start().await;
    let host = Arc::new(ExecutionHost::new());
    let (actor, run_id, attempt_id) = prepare(&database, &host).await;
    let generation_id = generation_id(&database, &run_id).await;
    let mut deleting = database
        .pool
        .begin()
        .await
        .expect("begin Agent removal transaction");
    sqlx::query("SELECT id FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE")
        .bind(ORG)
        .bind(&run_id)
        .fetch_one(&mut *deleting)
        .await
        .expect("Agent removal locks Run before Agent");
    sqlx::query("SELECT id FROM agents WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE")
        .bind(ORG)
        .bind(CEO)
        .fetch_one(&mut *deleting)
        .await
        .expect("Agent removal locks Agent after Run");

    let task_pool = database.pool.clone();
    let task_actor = actor.clone();
    let task_host = Arc::clone(&host);
    let task_run_id = run_id.clone();
    let task_attempt_id = attempt_id.clone();
    let claim_task = tokio::spawn(async move {
        claim(
            &task_pool,
            &task_actor,
            ORG,
            &task_run_id,
            &task_attempt_id,
            task_host.context(),
        )
        .await
    });
    let claim_result = tokio::time::timeout(Duration::from_secs(5), claim_task)
        .await
        .expect("claim must not wait on the Agent row held by removal")
        .expect("join claim operation");
    match claim_result {
        Err(Error::Http(409, message))
            if message == "Native Chat Agent is being changed or removed" => {}
        Err(Error::Http(status, message)) => {
            panic!("expected Agent-lock 409, got HTTP {status}: {message}")
        }
        Err(Error::Database(error)) => {
            panic!("expected Agent-lock 409, got database error: {error}")
        }
        Ok(_) => panic!("claim succeeded while Agent removal owned the Agent row"),
    }
    assert_generation_unclaimed(&database, &generation_id).await;

    tokio::time::timeout(Duration::from_secs(5), async {
        remove_agent_in_transaction(&mut deleting, CEO).await;
        deleting
            .commit()
            .await
            .expect("commit concurrent Agent removal");
    })
    .await
    .expect("Agent removal must finish after bounded claim rejection");
    assert_generation_unclaimed(&database, &generation_id).await;
    let selected: (Option<String>, Option<String>) = sqlx::query_as(
        "SELECT preferred_agent_id::text, routed_agent_id::text
         FROM chat_conversations WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(CHAT)
    .fetch_one(&database.pool)
    .await
    .expect("read Chat selection after Agent removal");
    assert_eq!(selected, (None, None));
}

#[tokio::test(flavor = "multi_thread")]
async fn run_lock_conflict_breaks_agent_removal_cycle_without_claim_effects() {
    let database = Database::start().await;
    let host = Arc::new(ExecutionHost::new());
    let (actor, run_id, attempt_id) = prepare(&database, &host).await;
    let generation_id = generation_id(&database, &run_id).await;

    let mut deleting = database
        .pool
        .begin()
        .await
        .expect("begin Agent removal transaction");
    sqlx::query("SELECT id FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE")
        .bind(ORG)
        .bind(&run_id)
        .fetch_one(&mut *deleting)
        .await
        .expect("Agent removal locks Run before Agent");
    let mut generation_gate = database
        .pool
        .begin()
        .await
        .expect("begin deterministic claim gate");
    sqlx::query("SELECT id FROM chat_generations WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE")
        .bind(ORG)
        .bind(&generation_id)
        .fetch_one(&mut *generation_gate)
        .await
        .expect("hold Generation until claim has locked the Agent");

    let task_pool = database.pool.clone();
    let task_actor = actor.clone();
    let task_host = Arc::clone(&host);
    let task_run_id = run_id.clone();
    let task_attempt_id = attempt_id.clone();
    let claim_task = tokio::spawn(async move {
        claim(
            &task_pool,
            &task_actor,
            ORG,
            &task_run_id,
            &task_attempt_id,
            task_host.context(),
        )
        .await
    });
    wait_for_lock_wait(&database.pool, "native_chat_claim_generation_lock").await;

    let probe = sqlx::query(
        "SELECT id FROM agents WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE NOWAIT",
    )
    .bind(ORG)
    .bind(CEO)
    .fetch_one(&database.pool)
    .await;
    match probe {
        Err(sqlx::Error::Database(error)) if error.code().as_deref() == Some("55P03") => {}
        Err(error) => panic!("expected claim to hold the Agent SHARE lock: {error}"),
        Ok(_) => panic!("claim has not acquired the Agent SHARE lock"),
    }

    generation_gate
        .commit()
        .await
        .expect("release deterministic Generation gate");
    let claim_result = tokio::time::timeout(Duration::from_secs(5), claim_task)
        .await
        .expect("claim must not wait on Run while holding Agent")
        .expect("join claim operation");
    match claim_result {
        Err(Error::Http(409, message))
            if message == "Native Chat Run is being changed or removed" => {}
        Err(Error::Http(status, message)) => {
            panic!("expected Run-lock 409, got HTTP {status}: {message}")
        }
        Err(Error::Database(error)) => panic!("expected Run-lock 409, got database error: {error}"),
        Ok(_) => panic!("claim succeeded while Agent removal owned the Run row"),
    }
    assert_generation_unclaimed(&database, &generation_id).await;

    tokio::time::timeout(Duration::from_secs(5), async {
        remove_agent_in_transaction(&mut deleting, CEO).await;
        deleting
            .commit()
            .await
            .expect("commit concurrent Agent removal");
    })
    .await
    .expect("Agent removal must finish after bounded claim rejection");
    assert_generation_unclaimed(&database, &generation_id).await;
    let selected: (Option<String>, Option<String>) = sqlx::query_as(
        "SELECT preferred_agent_id::text, routed_agent_id::text
         FROM chat_conversations WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(CHAT)
    .fetch_one(&database.pool)
    .await
    .expect("read Chat selection after Agent removal");
    assert_eq!(selected, (None, None));
}

#[tokio::test(flavor = "multi_thread")]
async fn issue_delete_serializes_before_conversation_lock_without_deadlock_or_claim_effects() {
    let database = Database::start().await;
    let host = Arc::new(ExecutionHost::new());
    let (actor, run_id, attempt_id) = prepare(&database, &host).await;
    sqlx::query("INSERT INTO issues (id, org_id, title) VALUES ($1::uuid, $2::uuid, 'Concurrent issue delete')")
        .bind(ISSUE_DELETE)
        .bind(ORG)
        .execute(&database.pool)
        .await
        .expect("seed primary Issue");
    sqlx::query("UPDATE chat_conversations SET primary_issue_id=$1::uuid WHERE org_id=$2::uuid AND id=$3::uuid")
        .bind(ISSUE_DELETE)
        .bind(ORG)
        .bind(CHAT)
        .execute(&database.pool)
        .await
        .expect("attach primary Issue to admitted Chat");

    let mut deleting = database
        .pool
        .begin()
        .await
        .expect("begin concurrent Issue deletion");
    sqlx::query("SELECT id FROM issues WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE")
        .bind(ORG)
        .bind(ISSUE_DELETE)
        .fetch_one(&mut *deleting)
        .await
        .expect("hold Issue row as delete does");

    let task_pool = database.pool.clone();
    let task_actor = actor.clone();
    let task_host = Arc::clone(&host);
    let task_run_id = run_id.clone();
    let task_attempt_id = attempt_id.clone();
    let claim_task = tokio::spawn(async move {
        claim(
            &task_pool,
            &task_actor,
            ORG,
            &task_run_id,
            &task_attempt_id,
            task_host.context(),
        )
        .await
    });
    wait_for_lock_wait(&database.pool, "native_chat_claim_issue_prelock").await;

    tokio::time::timeout(
        Duration::from_secs(5),
        sqlx::query("DELETE FROM issues WHERE org_id=$1::uuid AND id=$2::uuid")
            .bind(ORG)
            .bind(ISSUE_DELETE)
            .execute(&mut *deleting),
    )
    .await
    .expect("Issue delete must not wait on an unacquired Conversation lock")
    .expect("delete primary Issue");
    deleting
        .commit()
        .await
        .expect("commit concurrent Issue deletion");

    let claim_result = tokio::time::timeout(Duration::from_secs(5), claim_task)
        .await
        .expect("claim must terminate after Issue deletion")
        .expect("join claim operation");
    assert_conflict(claim_result);
    let issue_link: Option<String> = sqlx::query_scalar(
        "SELECT primary_issue_id::text FROM chat_conversations WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(CHAT)
    .fetch_one(&database.pool)
    .await
    .expect("read Chat after Issue deletion");
    assert_eq!(issue_link, None);
    assert_no_claim_effects(&database, &run_id).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn project_workspace_cascade_precedes_issue_and_conversation_locks() {
    let database = Database::start().await;
    let host = Arc::new(ExecutionHost::new());
    let (actor, run_id, attempt_id) = prepare(&database, &host).await;
    sqlx::query(
        "INSERT INTO project_workspaces
           (id, org_id, project_id, name, source_type, cwd, is_primary)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'Concurrent delete workspace', 'local_path', $4, true)",
    )
    .bind(PROJECT_WORKSPACE)
    .bind(ORG)
    .bind(support::PROJECT)
    .bind(host.cwd.to_string_lossy().as_ref())
    .execute(&database.pool)
    .await
    .expect("seed ProjectWorkspace");
    sqlx::query(
        "INSERT INTO issues (id, org_id, project_id, project_workspace_id, title)
         VALUES ($1::uuid, $2::uuid, NULL, $3::uuid, 'Legacy workspace-only Issue')",
    )
    .bind(ISSUE_PROJECT_DELETE)
    .bind(ORG)
    .bind(PROJECT_WORKSPACE)
    .execute(&database.pool)
    .await
    .expect("seed legacy Issue with workspace but no project reference");
    sqlx::query("UPDATE chat_conversations SET primary_issue_id=$1::uuid WHERE org_id=$2::uuid AND id=$3::uuid")
        .bind(ISSUE_PROJECT_DELETE)
        .bind(ORG)
        .bind(CHAT)
        .execute(&database.pool)
        .await
        .expect("attach workspace-only Issue to admitted Chat");

    let mut deleting = database
        .pool
        .begin()
        .await
        .expect("begin concurrent Project deletion");
    sqlx::query("SELECT id FROM projects WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE")
        .bind(ORG)
        .bind(support::PROJECT)
        .fetch_one(&mut *deleting)
        .await
        .expect("hold Project row as delete does");

    let task_pool = database.pool.clone();
    let task_actor = actor.clone();
    let task_host = Arc::clone(&host);
    let task_run_id = run_id.clone();
    let task_attempt_id = attempt_id.clone();
    let claim_task = tokio::spawn(async move {
        claim(
            &task_pool,
            &task_actor,
            ORG,
            &task_run_id,
            &task_attempt_id,
            task_host.context(),
        )
        .await
    });
    wait_for_lock_wait(&database.pool, "native_chat_claim_project_prelock").await;

    tokio::time::timeout(
        Duration::from_secs(5),
        sqlx::query("DELETE FROM projects WHERE org_id=$1::uuid AND id=$2::uuid")
            .bind(ORG)
            .bind(support::PROJECT)
            .execute(&mut *deleting),
    )
    .await
    .expect("Project cascade must not wait on an Issue row held by claim")
    .expect("delete Project and cascading workspace");
    deleting
        .commit()
        .await
        .expect("commit concurrent Project deletion");

    let claim_result = tokio::time::timeout(Duration::from_secs(5), claim_task)
        .await
        .expect("claim must terminate after Project deletion")
        .expect("join claim operation");
    assert_conflict(claim_result);
    let issue_link: Option<String> = sqlx::query_scalar(
        "SELECT project_workspace_id::text FROM issues WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(ISSUE_PROJECT_DELETE)
    .fetch_one(&database.pool)
    .await
    .expect("read workspace-only Issue after Project deletion");
    assert_eq!(issue_link, None);
    assert_no_claim_effects(&database, &run_id).await;
}
