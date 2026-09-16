#[allow(dead_code)]
mod common;
use common::*;
use rudder_bearer_auth_service::{ActorSource, BearerAuthenticator, JwtConfig};
use serde_json::{Value, json};

#[tokio::test]
async fn board_keys_take_precedence_and_resolve_current_membership_and_admin_state() {
    let db = Database::start().await;
    let key = agent_key(&db).await;
    let board_id = board_key(&db, &key.token).await;
    let auth = auth(&db);
    let first = auth
        .authenticate(Some(&key.token), Some(RUN))
        .await
        .unwrap();
    assert_eq!(first.source(), ActorSource::BoardKey);
    assert_eq!(serde_json::to_value(&first).unwrap()["keyId"], board_id);
    assert!(first.require_organization(ORG).is_ok());
    assert!(first.require_organization(OTHER).is_err());
    assert_eq!(first.run_id(), Some(RUN));
    db.sql("UPDATE organization_memberships SET status='inactive'")
        .await;
    let next = auth.authenticate(Some(&key.token), None).await.unwrap();
    assert!(next.require_organization(ORG).is_err());
    sqlx::query("INSERT INTO instance_user_roles(user_id,role) VALUES($1,'instance_admin')")
        .bind(USER)
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(
        auth.authenticate(Some(&key.token), None)
            .await
            .unwrap()
            .require_organization(OTHER)
            .is_ok()
    );
    db.sql("DELETE FROM instance_user_roles").await;
    assert!(
        auth.authenticate(Some(&key.token), None)
            .await
            .unwrap()
            .require_organization(OTHER)
            .is_err()
    );
}

#[tokio::test]
async fn expired_revoked_and_deleted_board_credentials_never_authenticate() {
    let db = Database::start().await;
    let token = "synthetic-board-bearer-only";
    board_key(&db, token).await;
    let auth = auth(&db);
    db.sql("UPDATE board_api_keys SET expires_at=now()-interval '1 second'")
        .await;
    assert_eq!(
        auth.authenticate(Some(token), None).await.unwrap().kind(),
        "none"
    );
    db.sql("UPDATE board_api_keys SET expires_at=NULL,revoked_at=now()")
        .await;
    assert_eq!(
        auth.authenticate(Some(token), None).await.unwrap().kind(),
        "none"
    );
    db.sql("UPDATE board_api_keys SET revoked_at=NULL").await;
    assert_eq!(
        auth.authenticate(Some(token), None).await.unwrap().kind(),
        "board"
    );
    db.sql("DELETE FROM \"user\"").await;
    assert_eq!(
        auth.authenticate(Some(token), None).await.unwrap().kind(),
        "none"
    );
}

#[tokio::test]
async fn keys_recheck_agent_status_scope_and_duplicate_hashes() {
    let db = Database::start().await;
    let key = agent_key(&db).await;
    let auth = auth(&db);
    let first = auth
        .authenticate(Some(&key.token), Some(RUN))
        .await
        .unwrap();
    assert_eq!(first.source(), ActorSource::AgentKey);
    assert_eq!(first.agent_id(), Some(CEO));
    assert!(first.require_organization(OTHER).is_err());
    for status in ["terminated", "pending_approval"] {
        sqlx::query("UPDATE agents SET status=$1")
            .bind(status)
            .execute(&db.pool)
            .await
            .unwrap();
        assert_eq!(
            auth.authenticate(Some(&key.token), None)
                .await
                .unwrap()
                .kind(),
            "none"
        );
    }
    db.sql("UPDATE agents SET status='paused'").await;
    assert_eq!(
        auth.authenticate(Some(&key.token), None)
            .await
            .unwrap()
            .kind(),
        "agent"
    );
    sqlx::query("UPDATE agent_api_keys SET org_id=$1::uuid")
        .bind(OTHER)
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        auth.authenticate(Some(&key.token), None)
            .await
            .unwrap()
            .kind(),
        "none"
    );
    sqlx::query("UPDATE agent_api_keys SET org_id=$1::uuid")
        .bind(ORG)
        .execute(&db.pool)
        .await
        .unwrap();
    db.sql("INSERT INTO agent_api_keys(org_id,agent_id,name,key_hash) SELECT org_id,agent_id,'duplicate',key_hash FROM agent_api_keys").await;
    assert_eq!(
        auth.authenticate(Some(&key.token), None)
            .await
            .unwrap()
            .kind(),
        "none"
    );
}

#[tokio::test]
async fn real_node_signed_tokens_preserve_runtime_identity_without_a_stored_key() {
    let db = Database::start().await;
    let token = node_token();
    let actor = auth(&db).authenticate(Some(&token), None).await.unwrap();
    assert_eq!(actor.source(), ActorSource::AgentJwt);
    assert_eq!(actor.agent_id(), Some(CEO));
    assert_eq!(actor.run_id(), Some(RUN));
    let record = serde_json::to_value(actor).unwrap();
    assert_eq!(record["adapterType"], "codex_local");
    assert!(record.get("keyId").is_none());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM agent_api_keys")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn jwt_validation_rejects_tampering_algorithm_expiry_and_malformed_claims() {
    let db = Database::start().await;
    let auth = auth(&db);
    let mut tokens = vec![
        "not.a.jwt".to_owned(),
        "".to_owned(),
        "x".repeat(16_385),
        sign(json!({"alg":"none"}), claims()),
        sign(json!({"alg":"RS256"}), claims()),
    ];
    let valid = sign(json!({"alg":"HS256"}), claims());
    tokens.push(format!("{valid}garbage"));
    tokens.push(format!("{valid}.extra"));
    for (field, value) in [
        ("exp", json!(1)),
        ("iat", json!(0)),
        ("exp", json!("future")),
        ("iss", json!("other")),
        ("aud", json!("other")),
        ("sub", json!("invalid-id")),
        ("org_id", json!(OTHER)),
        ("run_id", json!("")),
        ("adapter_type", Value::Null),
    ] {
        let mut claim = claims();
        claim[field] = value;
        tokens.push(sign(json!({"alg":"HS256"}), claim));
    }
    for token in tokens {
        assert_eq!(
            auth.authenticate(Some(&token), None).await.unwrap().kind(),
            "none"
        );
    }
    // The historical verifier allows absent issuer and audience.
    let mut legacy = claims();
    legacy.as_object_mut().unwrap().remove("iss");
    legacy.as_object_mut().unwrap().remove("aud");
    assert_eq!(
        auth.authenticate(Some(&sign(json!({"alg":"HS256"}), legacy)), None)
            .await
            .unwrap()
            .kind(),
        "agent"
    );
}

#[tokio::test]
async fn jwt_also_rechecks_current_agent_lifecycle_and_organization() {
    let db = Database::start().await;
    let token = node_token();
    let auth = auth(&db);
    for status in ["pending_approval", "terminated"] {
        sqlx::query("UPDATE agents SET status=$1")
            .bind(status)
            .execute(&db.pool)
            .await
            .unwrap();
        assert_eq!(
            auth.authenticate(Some(&token), None).await.unwrap().kind(),
            "none"
        );
    }
    db.sql("UPDATE agents SET status='paused'").await;
    assert_eq!(
        auth.authenticate(Some(&token), None).await.unwrap().kind(),
        "agent"
    );
    sqlx::query("UPDATE agents SET org_id=$1::uuid")
        .bind(OTHER)
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        auth.authenticate(Some(&token), None).await.unwrap().kind(),
        "none"
    );
}

#[tokio::test]
async fn waiting_authentication_observes_concurrent_board_revocation() {
    let db = Database::start().await;
    let token = "synthetic-concurrent-board";
    board_key(&db, token).await;
    let authenticator = auth(&db);
    let mut revoking = db.pool.begin().await.unwrap();
    sqlx::query("UPDATE board_api_keys SET revoked_at=now()")
        .execute(&mut *revoking)
        .await
        .unwrap();
    let task = tokio::spawn(async move { authenticator.authenticate(Some(token), None).await });
    wait_for_lock(&db, "UPDATE board_api_keys SET last_used_at=%").await;
    revoking.commit().await.unwrap();
    assert_eq!(task.await.unwrap().unwrap().kind(), "none");
}

#[tokio::test]
async fn waiting_authentication_observes_concurrent_agent_key_revocation() {
    let db = Database::start().await;
    let key = agent_key(&db).await;
    let authenticator = auth(&db);
    let mut revoking = db.pool.begin().await.unwrap();
    sqlx::query("UPDATE agent_api_keys SET revoked_at=now()")
        .execute(&mut *revoking)
        .await
        .unwrap();
    let task =
        tokio::spawn(async move { authenticator.authenticate(Some(&key.token), None).await });
    wait_for_lock(&db, "UPDATE agent_api_keys SET last_used_at=%").await;
    revoking.commit().await.unwrap();
    assert_eq!(task.await.unwrap().unwrap().kind(), "none");
}

#[tokio::test]
async fn restart_preserves_revocation_and_does_not_cache_old_membership() {
    let mut db = Database::start().await;
    let key = agent_key(&db).await;
    let token = "synthetic-restart-board";
    board_key(&db, token).await;
    db.sql("UPDATE agent_api_keys SET revoked_at=now(); UPDATE organization_memberships SET status='inactive'").await;
    db.restart().await;
    let authenticator = auth(&db);
    assert_eq!(
        authenticator
            .authenticate(Some(&key.token), None)
            .await
            .unwrap()
            .kind(),
        "none"
    );
    assert!(
        authenticator
            .authenticate(Some(token), None)
            .await
            .unwrap()
            .require_organization(ORG)
            .is_err()
    );
}

#[tokio::test]
async fn missing_credentials_and_missing_jwt_configuration_never_become_board_access() {
    let db = Database::start().await;
    let authenticator = BearerAuthenticator::new(db.pool.clone(), None);
    let actor = authenticator.authenticate(None, Some(RUN)).await.unwrap();
    assert_eq!(actor.kind(), "none");
    assert_eq!(actor.run_id(), Some(RUN));
    assert!(actor.require_organization(ORG).is_err());
    assert_eq!(
        authenticator
            .authenticate(Some(&node_token()), None)
            .await
            .unwrap()
            .kind(),
        "none"
    );
    assert!(JwtConfig::new(Vec::new(), "rudder", "api").is_err());
    let config = JwtConfig::new(SECRET.as_bytes(), "rudder", "api").unwrap();
    assert!(!format!("{config:?}").contains(SECRET));
    assert!(format!("{config:?}").contains("[REDACTED]"));
}
// End of real PostgreSQL bearer regressions.
