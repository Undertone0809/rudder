#[path = "runtime_spans/fixtures.rs"]
mod fixtures;
mod support;

use fixtures::*;
use rudder_d1_persistence::runtime_spans::{Error, Request, execute};
use serde_json::json;
use support::{CEO, Database, ORG, OTHER};

#[tokio::test(flavor = "multi_thread")]
async fn open_and_locator_bind_are_fenced_concurrent_and_restart_readable() {
    let database = Database::start().await;
    let organization_profile = (database.name().await, database.brand_color().await);
    seed_access(&database.pool).await;
    seed_chat(&database.pool, CHAT, "chat", USER).await;
    seed_chat(&database.pool, CHAT_TWO, "chat", USER).await;
    let owner_actor = actor(USER, ORG, "open-and-bind");
    let (binding_id, segment_id) = ensure_binding(&database.pool, &owner_actor, CHAT).await;
    let (other_binding_id, other_segment_id) =
        ensure_binding(&database.pool, &owner_actor, CHAT_TWO).await;
    seed_run_attempt(&database.pool, CHAT).await;

    let open = open_request(&binding_id, &segment_id);
    let before_invalid_context = span_counts(&database.pool).await;
    let before_invalid_general_counts = database.counts().await;
    let wrong_chat = open_request(&other_binding_id, &other_segment_id);
    assert!(matches!(
        execute(&database.pool, &owner_actor, ORG, &wrong_chat).await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(database.counts().await, before_invalid_general_counts);
    sqlx::query(
        "UPDATE runtime_bindings SET agent_id=$2::uuid WHERE org_id=$3::uuid AND id=$1::uuid",
    )
    .bind(&binding_id)
    .bind(AGENT_TWO)
    .bind(ORG)
    .execute(&database.pool)
    .await
    .expect("mismatch binding Agent fixture");
    assert!(matches!(
        execute(&database.pool, &owner_actor, ORG, &open).await,
        Err(Error::Http(409, _))
    ));
    sqlx::query(
        "UPDATE runtime_bindings SET agent_id=$2::uuid WHERE org_id=$3::uuid AND id=$1::uuid",
    )
    .bind(&binding_id)
    .bind(CEO)
    .bind(ORG)
    .execute(&database.pool)
    .await
    .expect("restore binding Agent fixture");
    sqlx::query(
        "INSERT INTO heartbeat_run_attempts
           (id, org_id, run_id, agent_id, attempt_index, runtime_type, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 'codex_local', 'started')",
    )
    .bind(ATTEMPT_TWO)
    .bind(ORG)
    .bind(RUN)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("insert newer attempt fixture");
    assert!(matches!(
        execute(&database.pool, &owner_actor, ORG, &open).await,
        Err(Error::Http(409, _))
    ));
    sqlx::query("DELETE FROM heartbeat_run_attempts WHERE id=$1::uuid")
        .bind(ATTEMPT_TWO)
        .execute(&database.pool)
        .await
        .expect("remove newer attempt fixture");
    assert_eq!(span_counts(&database.pool).await, before_invalid_context);

    let before_runtime_mismatch = span_counts(&database.pool).await;
    sqlx::query("UPDATE heartbeat_run_attempts SET runtime_type='hermes' WHERE id=$1::uuid")
        .bind(ATTEMPT)
        .execute(&database.pool)
        .await
        .expect("change attempt runtime fixture");
    assert!(matches!(
        execute(&database.pool, &owner_actor, ORG, &open).await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(span_counts(&database.pool).await, before_runtime_mismatch);
    sqlx::query("UPDATE heartbeat_run_attempts SET runtime_type='codex_local' WHERE id=$1::uuid")
        .bind(ATTEMPT)
        .execute(&database.pool)
        .await
        .expect("restore attempt runtime fixture");

    let before_scope_mismatch = span_counts(&database.pool).await;
    sqlx::query(
        "UPDATE runtime_bindings SET principal_scope_ref='user:wrong-owner' WHERE id=$1::uuid",
    )
    .bind(&binding_id)
    .execute(&database.pool)
    .await
    .expect("change principal scope fixture");
    assert!(matches!(
        execute(&database.pool, &owner_actor, ORG, &open).await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(span_counts(&database.pool).await, before_scope_mismatch);
    sqlx::query("UPDATE runtime_bindings SET principal_scope_ref=$2 WHERE id=$1::uuid")
        .bind(&binding_id)
        .bind(format!("org:{ORG}"))
        .execute(&database.pool)
        .await
        .expect("restore principal scope fixture");

    let before_missing_lease = span_counts(&database.pool).await;
    database
        .sql("UPDATE heartbeat_runs SET execution_lease_expires_at=NULL WHERE id='64000000-0000-4000-8000-000000000101'::uuid")
        .await;
    assert!(matches!(
        execute(&database.pool, &owner_actor, ORG, &open).await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(span_counts(&database.pool).await, before_missing_lease);
    sqlx::query("UPDATE heartbeat_runs SET execution_lease_expires_at=clock_timestamp() + interval '1 hour' WHERE id=$1::uuid")
        .bind(RUN)
        .execute(&database.pool)
        .await
        .expect("restore Run lease fixture");

    let mut tasks = Vec::new();
    for _ in 0..8 {
        let pool = database.pool.clone();
        let actor = owner_actor.clone();
        let request = open.clone();
        tasks.push(tokio::spawn(async move {
            execute(&pool, &actor, ORG, &request).await
        }));
    }
    let mut opened = Vec::new();
    for task in tasks {
        opened.push(
            task.await
                .expect("open task joined")
                .expect("open succeeded"),
        );
    }
    let span_id = opened[0]["span"]["id"]
        .as_str()
        .expect("span id")
        .to_owned();
    for result in &opened {
        assert_eq!(result["span"]["id"], span_id);
        assert_eq!(result["span"]["ordinal"], 0);
        assert_eq!(result["span"]["attemptRef"], ATTEMPT);
        assert_eq!(result["segment"]["id"], segment_id);
        assert!(result["span"].get("ownerToken").is_none());
        assert!(result["segment"].get("providerState").is_none());
    }
    assert_eq!(span_counts(&database.pool).await, (1, 1, 0));

    let locator = bind_request(
        &span_id,
        " session-opaque ",
        Some("root-opaque"),
        Some("leaf-opaque"),
    );
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let pool = database.pool.clone();
        let actor = owner_actor.clone();
        let request = locator.clone();
        tasks.push(tokio::spawn(async move {
            execute(&pool, &actor, ORG, &request).await
        }));
    }
    let mut bound = Vec::new();
    for task in tasks {
        bound.push(
            task.await
                .expect("bind task joined")
                .expect("bind succeeded"),
        );
    }
    for result in &bound {
        assert_eq!(result["segment"]["nativeSessionId"], " session-opaque ");
        assert_eq!(result["segment"]["rootSessionId"], "root-opaque");
        assert_eq!(result["segment"]["leafId"], "leaf-opaque");
        assert_eq!(result["segment"]["state"], "open");
    }
    assert_eq!(span_counts(&database.pool).await, (1, 2, 1));

    let changed = bind_request(
        &span_id,
        "different-native-session",
        Some("root-opaque"),
        Some("leaf-opaque"),
    );
    assert!(matches!(
        execute(&database.pool, &owner_actor, ORG, &changed).await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(span_counts(&database.pool).await, (1, 2, 1));

    let before_read = span_counts(&database.pool).await;
    let before_read_general_counts = database.counts().await;
    let read: Request =
        serde_json::from_value(json!({"operation":"read","spanId":span_id})).expect("read request");
    let read_result = execute(&database.pool, &owner_actor, ORG, &read)
        .await
        .expect("read span");
    assert_eq!(read_result, bound[0]);
    assert_eq!(span_counts(&database.pool).await, before_read);
    assert_eq!(database.counts().await, before_read_general_counts);

    sqlx::query("UPDATE heartbeat_runs SET execution_lease_expires_at=clock_timestamp() - interval '1 second' WHERE id=$1::uuid")
        .bind(RUN)
        .execute(&database.pool)
        .await
        .expect("expire current Run lease");
    let before_expired_lease = span_counts(&database.pool).await;
    assert!(matches!(
        execute(&database.pool, &owner_actor, ORG, &open).await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(span_counts(&database.pool).await, before_expired_lease);

    let wrong_org_actor = actor(OTHER_USER, OTHER, "foreign-org");
    assert!(matches!(
        execute(&database.pool, &wrong_org_actor, OTHER, &read).await,
        Err(Error::Http(404, _))
    ));
    assert_eq!(
        (database.name().await, database.brand_color().await),
        organization_profile
    );
}

#[path = "runtime_spans/concurrency_and_side_chat.rs"]
mod concurrency_and_side_chat;
