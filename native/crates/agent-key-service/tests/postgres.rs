#[allow(dead_code)]
#[path = "../../d1-persistence/tests/support/mod.rs"]
mod support;

use actix_web::{App, HttpMessage, dev::Service, http::StatusCode, test, web};
use rudder_agent_key_service::{
    AgentIdentity, AgentKeyStore, BoardGrant, KeyError,
    http::{self, TrustedPrincipal},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use support::*;

fn grant() -> BoardGrant {
    BoardGrant::after_authorization(ORG, "board-one").unwrap()
}
async fn key_count(db: &Database) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM agent_api_keys")
        .fetch_one(&db.pool)
        .await
        .unwrap()
}
async fn activity_count(db: &Database) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM activity_log")
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn create_authenticate_list_revoke_matches_the_legacy_token_and_response_contract() {
    let db = Database::start().await;
    let store = AgentKeyStore::new(db.pool.clone());
    let issued = store
        .create(&grant(), CEO, "integration key")
        .await
        .unwrap();
    assert_eq!(issued.token.len(), 52);
    assert!(issued.token.starts_with("pcp_"));
    assert!(
        issued.token[4..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    );
    assert!(!format!("{issued:?}").contains(&issued.token));
    let hash: String = sqlx::query_scalar("SELECT key_hash FROM agent_api_keys WHERE id=$1::uuid")
        .bind(&issued.id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        hash,
        format!("{:x}", Sha256::digest(issued.token.as_bytes()))
    );
    assert_ne!(hash, issued.token);
    let identity = store.authenticate(&issued.token).await.unwrap().unwrap();
    assert_eq!(
        identity,
        AgentIdentity {
            org_id: ORG.into(),
            agent_id: CEO.into(),
            role: "ceo".into()
        }
    );
    let touched: bool =
        sqlx::query_scalar("SELECT last_used_at IS NOT NULL FROM agent_api_keys WHERE id=$1::uuid")
            .bind(&issued.id)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert!(touched);
    let keys = store.list(&grant(), CEO).await.unwrap();
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0].name, "integration key");
    assert_eq!(keys[0].created_at, issued.created_at);
    assert!(keys[0].created_at.ends_with('Z'));
    assert!(keys[0].revoked_at.is_none());
    let serialized = serde_json::to_string(&keys).unwrap();
    assert!(!serialized.contains(&issued.token));
    assert!(!serialized.contains("keyHash"));
    assert!(!serialized.contains(&hash));
    store.revoke(&grant(), CEO, &issued.id).await.unwrap();
    assert!(store.authenticate(&issued.token).await.unwrap().is_none());
    assert!(
        store.list(&grant(), CEO).await.unwrap()[0]
            .revoked_at
            .is_some()
    );
    assert_eq!(activity_count(&db).await, 2);
    let audit: String =
        sqlx::query_scalar("SELECT string_agg(details::text,',') FROM activity_log")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert!(!audit.contains(&issued.token));
    assert!(!audit.contains(&hash));
}

#[tokio::test]
async fn same_agent_and_organization_must_match_for_every_key_operation() {
    let db = Database::start().await;
    let store = AgentKeyStore::new(db.pool.clone());
    let issued = store.create(&grant(), CEO, "scoped").await.unwrap();
    let foreign = BoardGrant::after_authorization(OTHER, "board-one").unwrap();
    assert!(matches!(
        store.create(&foreign, CEO, "no").await,
        Err(KeyError::AgentNotFound)
    ));
    assert!(matches!(
        store.list(&foreign, CEO).await,
        Err(KeyError::AgentNotFound)
    ));
    assert!(matches!(
        store.revoke(&foreign, CEO, &issued.id).await,
        Err(KeyError::AgentNotFound)
    ));
    let second = "50000000-0000-4000-8000-000000000002";
    sqlx::query(
        "INSERT INTO agents(id,org_id,name,role) VALUES($1::uuid,$2::uuid,'Second','general')",
    )
    .bind(second)
    .bind(ORG)
    .execute(&db.pool)
    .await
    .unwrap();
    assert!(matches!(
        store.revoke(&grant(), second, &issued.id).await,
        Err(KeyError::KeyNotFound)
    ));
    assert!(store.authenticate(&issued.token).await.unwrap().is_some());
    assert_eq!(key_count(&db).await, 1);
    assert_eq!(activity_count(&db).await, 1);
}

#[tokio::test]
async fn inactive_agents_cannot_issue_or_authenticate_keys_but_pausing_is_not_revocation() {
    let db = Database::start().await;
    let store = AgentKeyStore::new(db.pool.clone());
    let issued = store.create(&grant(), CEO, "state").await.unwrap();
    for status in ["pending_approval", "terminated"] {
        sqlx::query("UPDATE agents SET status=$2 WHERE id=$1::uuid")
            .bind(CEO)
            .bind(status)
            .execute(&db.pool)
            .await
            .unwrap();
        let rejected = store.create(&grant(), CEO, "rejected").await;
        assert!(matches!(
            rejected,
            Err(KeyError::PendingApproval | KeyError::Terminated)
        ));
        assert!(store.authenticate(&issued.token).await.unwrap().is_none());
    }
    sqlx::query("UPDATE agents SET status='paused' WHERE id=$1::uuid")
        .bind(CEO)
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(store.authenticate(&issued.token).await.unwrap().is_some());
    store
        .create(&grant(), CEO, "paused is allowed")
        .await
        .unwrap();
    assert_eq!(key_count(&db).await, 2);
}

#[tokio::test]
async fn creation_and_revocation_roll_back_if_their_activity_cannot_commit() {
    let db = Database::start().await;
    let store = AgentKeyStore::new(db.pool.clone());
    let issued = store.create(&grant(), CEO, "before failure").await.unwrap();
    db.sql("CREATE FUNCTION reject_key_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic key audit failure'; END $$; CREATE TRIGGER reject_key_audit BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION reject_key_audit();").await;
    assert!(matches!(
        store.create(&grant(), CEO, "rollback").await,
        Err(KeyError::Database(_))
    ));
    assert!(matches!(
        store.revoke(&grant(), CEO, &issued.id).await,
        Err(KeyError::Database(_))
    ));
    assert_eq!(key_count(&db).await, 1);
    assert_eq!(activity_count(&db).await, 1);
    assert!(store.authenticate(&issued.token).await.unwrap().is_some());
}

#[tokio::test]
async fn concurrent_creations_are_distinct_and_revocation_is_committed_before_later_authentication()
{
    let db = Database::start().await;
    let store = AgentKeyStore::new(db.pool.clone());
    let auth = grant();
    let (first, second) = tokio::join!(
        store.create(&auth, CEO, "one"),
        store.create(&auth, CEO, "two")
    );
    let (first, second) = (first.unwrap(), second.unwrap());
    assert_ne!(first.id, second.id);
    assert_ne!(first.token, second.token);
    let (a, b) = tokio::join!(
        store.revoke(&auth, CEO, &first.id),
        store.revoke(&auth, CEO, &first.id)
    );
    a.unwrap();
    b.unwrap();
    assert!(store.authenticate(&first.token).await.unwrap().is_none());
    assert!(store.authenticate(&second.token).await.unwrap().is_some());
    assert_eq!(key_count(&db).await, 2);
    assert_eq!(activity_count(&db).await, 4);
}

#[tokio::test]
async fn a_real_database_restart_preserves_hashes_and_revocations() {
    let mut db = Database::start().await;
    let store = AgentKeyStore::new(db.pool.clone());
    let live = store.create(&grant(), CEO, "live").await.unwrap();
    let revoked = store.create(&grant(), CEO, "revoked").await.unwrap();
    store.revoke(&grant(), CEO, &revoked.id).await.unwrap();
    drop(store);
    db.restart().await;
    let restarted = AgentKeyStore::new(db.pool.clone());
    assert!(restarted.authenticate(&live.token).await.unwrap().is_some());
    assert!(
        restarted
            .authenticate(&revoked.token)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(restarted.list(&grant(), CEO).await.unwrap().len(), 2);
}

#[tokio::test]
async fn corrupt_cross_organization_rows_and_duplicate_credentials_fail_closed() {
    let db = Database::start().await;
    let store = AgentKeyStore::new(db.pool.clone());
    let issued = store.create(&grant(), CEO, "corruption").await.unwrap();
    sqlx::query("UPDATE agent_api_keys SET org_id=$2::uuid WHERE id=$1::uuid")
        .bind(&issued.id)
        .bind(OTHER)
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(store.authenticate(&issued.token).await.unwrap().is_none());
    sqlx::query("UPDATE agent_api_keys SET org_id=$2::uuid WHERE id=$1::uuid")
        .bind(&issued.id)
        .bind(ORG)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agent_api_keys(org_id,agent_id,name,key_hash) SELECT org_id,agent_id,'duplicate',key_hash FROM agent_api_keys WHERE id=$1::uuid")
        .bind(&issued.id).execute(&db.pool).await.unwrap();
    assert!(store.authenticate(&issued.token).await.unwrap().is_none());
    assert!(store.authenticate("").await.unwrap().is_none());
    assert!(store.authenticate("unknown-token").await.unwrap().is_none());
}

#[actix_web::test]
async fn real_http_create_list_delete_uses_trusted_scope_and_never_returns_a_stored_hash() {
    let db = Database::start().await;
    let store = AgentKeyStore::new(db.pool.clone());
    let auth = grant();
    let app = test::init_service(
        App::new()
            .app_data(web::Data::new(store.clone()))
            .wrap_fn(move |req, srv| {
                req.extensions_mut()
                    .insert(TrustedPrincipal::Board(auth.clone()));
                srv.call(req)
            })
            .service(web::scope("/api").configure(http::configure)),
    )
    .await;
    let url = format!("/api/agents/{CEO}/keys");
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&url)
            .set_json(json!({}))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let created: Value = test::read_body_json(response).await;
    assert_eq!(created["name"], "default");
    assert_eq!(created.as_object().unwrap().len(), 4);
    let listed: Value =
        test::call_and_read_body_json(&app, test::TestRequest::get().uri(&url).to_request()).await;
    assert_eq!(listed[0]["id"], created["id"]);
    assert!(listed[0].get("token").is_none());
    assert!(listed[0].get("keyHash").is_none());
    let delete = format!("{url}/{}", created["id"].as_str().unwrap());
    let response =
        test::call_service(&app, test::TestRequest::delete().uri(&delete).to_request()).await;
    assert_eq!(response.status(), StatusCode::OK);
    let result: Value = test::read_body_json(response).await;
    assert_eq!(result, json!({"ok":true}));
    assert!(
        store
            .authenticate(created["token"].as_str().unwrap())
            .await
            .unwrap()
            .is_none()
    );
    let invalid = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&url)
            .set_json(json!({"name":""}))
            .to_request(),
    )
    .await;
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
}

#[actix_web::test]
async fn request_headers_cannot_supply_board_authority_and_agents_receive_forbidden() {
    let db = Database::start().await;
    let store = AgentKeyStore::new(db.pool.clone());
    let app = test::init_service(
        App::new()
            .app_data(web::Data::new(store.clone()))
            .service(web::scope("/api").configure(http::configure)),
    )
    .await;
    let url = format!("/api/agents/{CEO}/keys");
    let response = test::call_service(
        &app,
        test::TestRequest::post()
            .uri(&url)
            .insert_header(("x-rudder-actor-type", "board"))
            .insert_header(("x-rudder-org-id", ORG))
            .set_json(json!({"name":"forged"}))
            .to_request(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let app = test::init_service(
        App::new()
            .app_data(web::Data::new(store))
            .wrap_fn(|req, srv| {
                req.extensions_mut()
                    .insert(TrustedPrincipal::Agent(AgentIdentity {
                        org_id: ORG.into(),
                        agent_id: CEO.into(),
                        role: "ceo".into(),
                    }));
                srv.call(req)
            })
            .service(web::scope("/api").configure(http::configure)),
    )
    .await;
    let response = test::call_service(&app, test::TestRequest::get().uri(&url).to_request()).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(key_count(&db).await, 0);
}

#[tokio::test]
async fn cancellation_during_audit_rolls_back_the_key_and_releases_the_agent_lock() {
    let db = Database::start().await;
    db.sql("CREATE FUNCTION slow_key_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2); RETURN NEW; END $$; CREATE TRIGGER slow_key_audit BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION slow_key_audit();").await;
    let store = AgentKeyStore::new(db.pool.clone());
    let worker = store.clone();
    let task = tokio::spawn(async move { worker.create(&grant(), CEO, "cancelled key").await });
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let sleeping: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='PgSleep')")
                .fetch_one(&db.pool).await.unwrap();
            if sleeping { break; }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }).await.unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        db.sql("DROP TRIGGER slow_key_audit ON activity_log"),
    )
    .await
    .unwrap();
    assert_eq!(key_count(&db).await, 0);
    assert_eq!(activity_count(&db).await, 0);
    store
        .create(&grant(), CEO, "retry after cancellation")
        .await
        .unwrap();
    assert_eq!(key_count(&db).await, 1);
}

#[tokio::test]
async fn creation_rechecks_status_after_waiting_for_a_concurrent_termination() {
    let db = Database::start().await;
    let store = AgentKeyStore::new(db.pool.clone());
    let mut terminating = db.pool.begin().await.unwrap();
    sqlx::query("UPDATE agents SET status='terminated' WHERE id=$1::uuid")
        .bind(CEO)
        .execute(&mut *terminating)
        .await
        .unwrap();
    let worker = store.clone();
    let task =
        tokio::spawn(async move { worker.create(&grant(), CEO, "racing termination").await });
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let waiting: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT status FROM agents%')")
                .fetch_one(&db.pool).await.unwrap();
            if waiting { break; }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }).await.unwrap();
    terminating.commit().await.unwrap();
    assert!(matches!(task.await.unwrap(), Err(KeyError::Terminated)));
    assert_eq!(key_count(&db).await, 0);
    assert_eq!(activity_count(&db).await, 0);
}

// End of real cancellation and authorization-race regressions.
