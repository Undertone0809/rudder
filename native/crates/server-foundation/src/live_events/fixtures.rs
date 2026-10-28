//! Real native HTTP/WebSocket + disposable PostgreSQL. No Node upstream exists
//! in this fixture; public-listener wiring is verified separately by ingress.
#![allow(dead_code)]
#[path = "../../../d1-persistence/tests/support/mod.rs"]
mod support;
use super::*;
use crate::{
    AppState, DatabaseState, ServerConfig,
    native_session_auth::{NativeIngressIdentity, NativeSessionResolution, sign_session_token},
    public_ingress_config::{NativeSessionAuthConfig, NativeSessionAuthKind},
};
use actix_web::{App, HttpRequest, HttpResponse, HttpServer, web};
use awc::{ClientBuilder, ws::Frame};
use futures_util::{Stream, StreamExt};
use serde_json::json;
use std::time::Duration;
#[derive(Clone)]
struct FixtureState {
    app: AppState,
    publisher: LiveEventPublisher,
    pool: sqlx::PgPool,
    auth: NativeSessionAuthConfig,
}
async fn socket(
    request: HttpRequest,
    payload: web::Payload,
    state: web::Data<FixtureState>,
) -> HttpResponse {
    let pending = state.app.session_revocation.begin_upgrade().unwrap();
    let identity = match state
        .app
        .resolve_public_session(&state.auth, request.headers())
        .await
    {
        NativeSessionResolution::Authenticated(identity) => identity,
        _ => return HttpResponse::Forbidden().finish(),
    };
    let registration = match pending.bind(&identity.user_id) {
        Ok(registration) => registration,
        Err(_) => return HttpResponse::Forbidden().finish(),
    };
    upgrade(
        request,
        payload,
        state.publisher.clone(),
        state.pool.clone(),
        NativeIngressIdentity::Session(identity),
        NativeSessionAuthKind::BetterAuth,
        Some(registration),
    )
    .await
}
async fn next_frame<S, E>(socket: &mut S) -> Frame
where
    S: Stream<Item = Result<Frame, E>> + Unpin,
    E: std::fmt::Debug,
{
    tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .expect("native socket has a bounded response")
        .expect("socket remains open until expected frame")
        .expect("valid native WebSocket frame")
}
async fn next_json<S, E>(socket: &mut S) -> Value
where
    S: Stream<Item = Result<Frame, E>> + Unpin,
    E: std::fmt::Debug,
{
    match next_frame(socket).await {
        Frame::Text(bytes) => serde_json::from_slice(&bytes).unwrap(),
        frame => panic!("expected event JSON, got {frame:?}"),
    }
}
const OWNER: &str = "synthetic-live-owner";
const OTHER_USER: &str = "synthetic-live-other";
const PUBLIC_RUN: &str = "71000000-0000-4000-8000-000000000001";
const PRIVATE_RUN: &str = "71000000-0000-4000-8000-000000000002";
const PRIVATE_CHAT: &str = "72000000-0000-4000-8000-000000000001";

#[actix_web::test]
#[ignore = "requires disposable PostgreSQL; exercises native HTTP auth, WebSocket and private Run visibility"]
async fn native_socket_filters_private_runs_dedupes_and_revokes_current_access() {
    let database = support::Database::start().await;
    for (user, token) in [
        (OWNER, "synthetic-owner-token"),
        (OTHER_USER, "synthetic-other-token"),
    ] {
        sqlx::query("INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES($1,'Synthetic live fixture',$1||'@example.test',statement_timestamp(),statement_timestamp())").bind(user).execute(&database.pool).await.unwrap();
        sqlx::query("INSERT INTO session(id,user_id,token,expires_at,created_at,updated_at) VALUES($1,$1,$2,statement_timestamp()+interval '1 day',statement_timestamp(),statement_timestamp())").bind(user).bind(token).execute(&database.pool).await.unwrap();
        sqlx::query("INSERT INTO organization_memberships(org_id,principal_type,principal_id,status,membership_role) VALUES($1::uuid,'user',$2,'active','member')").bind(support::ORG).bind(user).execute(&database.pool).await.unwrap();
    }
    sqlx::query("INSERT INTO chat_conversations(id,org_id,conversation_kind,created_by_user_id,title) VALUES($1::uuid,$2::uuid,'side_chat',$3,'Synthetic private SideChat')").bind(PRIVATE_CHAT).bind(support::ORG).bind(OWNER).execute(&database.pool).await.unwrap();
    sqlx::query("INSERT INTO heartbeat_runs(id,org_id,agent_id,status,context_snapshot,chat_conversation_id) VALUES($1::uuid,$2::uuid,$3::uuid,'running','{}'::jsonb,NULL),($4::uuid,$2::uuid,$3::uuid,'running','{\"scene\":\"side_chat\"}'::jsonb,$5::uuid)").bind(PUBLIC_RUN).bind(support::ORG).bind(support::CEO).bind(PRIVATE_RUN).bind(PRIVATE_CHAT).execute(&database.pool).await.unwrap();
    let publisher = LiveEventPublisher::new();
    let mut app = AppState::new(ServerConfig::default()).unwrap();
    app.database = DatabaseState::Configured(database.pool.clone());
    let revocation = app.session_revocation.clone();
    let auth = NativeSessionAuthConfig {
        kind: NativeSessionAuthKind::BetterAuth,
        secret: "synthetic-native-live-cookie-signing-key".into(),
        secure_cookie: false,
        assertion_key: "synthetic-unused-assertion-key".into(),
    };
    let fixture = web::Data::new(FixtureState {
        app,
        publisher: publisher.clone(),
        pool: database.pool.clone(),
        auth: auth.clone(),
    });
    let server = HttpServer::new(move || {
        App::new()
            .app_data(fixture.clone())
            .route("/api/orgs/{org}/events/ws", web::get().to(socket))
    })
    .bind(("127.0.0.1", 0))
    .unwrap();
    let address = server.addrs()[0];
    let server = server.run();
    let handle = server.handle();
    let task = actix_web::rt::spawn(server);
    let client = ClientBuilder::new().no_default_headers().finish();
    let uri = format!("ws://{address}/api/orgs/{}/events/ws", support::ORG);
    let owner_cookie = format!(
        "better-auth.session_token={}",
        sign_session_token("synthetic-owner-token", &auth.secret).unwrap()
    );
    let other_cookie = format!(
        "better-auth.session_token={}",
        sign_session_token("synthetic-other-token", &auth.secret).unwrap()
    );
    let (_, mut owner) = client
        .ws(&uri)
        .set_header("cookie", owner_cookie.as_str())
        .connect()
        .await
        .unwrap();
    let (_, mut other) = client
        .ws(&uri)
        .set_header("cookie", other_cookie.as_str())
        .connect()
        .await
        .unwrap();
    let denied = client
        .ws(format!(
            "ws://{address}/api/orgs/{}/events/ws",
            support::OTHER
        ))
        .set_header("cookie", owner_cookie.as_str())
        .connect()
        .await;
    assert!(
        denied.is_err(),
        "native organization membership is decisive"
    );
    publisher
        .publish(
            support::ORG,
            "heartbeat.run.log",
            json!({"runId":PUBLIC_RUN,"chunk":"public first","seq":1}),
            Some("fixture:first"),
        )
        .unwrap();
    publisher
        .publish(
            support::ORG,
            "heartbeat.run.log",
            json!({"runId":PUBLIC_RUN,"chunk":"public first","seq":1}),
            Some("fixture:first"),
        )
        .unwrap();
    publisher
        .publish(
            support::ORG,
            "heartbeat.run.log",
            json!({"runId":PRIVATE_RUN,"chunk":"owner private content","seq":2}),
            None,
        )
        .unwrap();
    publisher
        .publish(
            support::ORG,
            "heartbeat.run.log",
            json!({"runId":PUBLIC_RUN,"chunk":"public last","seq":3}),
            None,
        )
        .unwrap();
    assert_eq!(
        next_json(&mut owner).await["payload"]["chunk"],
        "public first"
    );
    assert_eq!(
        next_json(&mut owner).await["payload"]["chunk"],
        "owner private content"
    );
    assert_eq!(
        next_json(&mut owner).await["payload"]["chunk"],
        "public last"
    );
    assert_eq!(
        next_json(&mut other).await["payload"]["chunk"],
        "public first"
    );
    assert_eq!(
        next_json(&mut other).await["payload"]["chunk"],
        "public last"
    );
    // Reproduce the existing close-on-revocation contract while a concrete
    // read-only native auth query is blocked. The lock is disposable/local.
    let mut blocker = database.pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE session IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *blocker)
        .await
        .unwrap();
    publisher
        .publish(
            support::ORG,
            "agent.status",
            json!({"agentId":support::CEO,"status":"idle"}),
            None,
        )
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        let waiting:i64=sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM session AS s%'").fetch_one(&database.pool).await.unwrap();
        if waiting >= 2 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "both native auth SELECTs must actually be waiting on the held session table lock"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    revocation.publish_user_revocation(OWNER);
    // Reuse the existing native WebSocket revocation fixture's two-second
    // close boundary, rather than introducing a new protocol timeout.
    let observed = tokio::time::timeout(Duration::from_secs(2), owner.next()).await;
    let timely_close =
        matches!(&observed,Ok(Some(Ok(Frame::Close(Some(reason)))))if u16::from(reason.code)==1008);
    println!(
        "native live revocation during blocked session SELECT: close_within_2s={timely_close}"
    );
    blocker.rollback().await.unwrap();
    if !timely_close {
        assert!(
            matches!(next_frame(&mut owner).await,Frame::Close(Some(reason))if u16::from(reason.code)==1008)
        );
    }
    assert_eq!(next_json(&mut other).await["type"], "agent.status");
    sqlx::query("UPDATE organization_memberships SET status='suspended' WHERE org_id=$1::uuid AND principal_id=$2").bind(support::ORG).bind(OTHER_USER).execute(&database.pool).await.unwrap();
    publisher
        .publish(
            support::ORG,
            "agent.status",
            json!({"agentId":support::CEO,"status":"idle"}),
            None,
        )
        .unwrap();
    assert!(
        matches!(next_frame(&mut other).await,Frame::Close(Some(reason))if u16::from(reason.code)==1008)
    );
    publisher.close();
    drop(owner);
    drop(other);
    handle.stop(true).await;
    task.await.unwrap().unwrap();
    assert!(
        timely_close,
        "existing registry revocation must close the native socket while the read-only auth SELECT remains blocked"
    );
}
