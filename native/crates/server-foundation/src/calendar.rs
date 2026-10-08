//! Signed, fail-closed transport for public Calendar source/event operations.
use crate::{ActorEnvelopeVerificationError, AppState, DatabaseState};
use actix_web::{HttpRequest, HttpResponse, http::StatusCode, web};
use rudder_d1_persistence::calendar::{CalendarError, execute_calendar};
use serde_json::Value;

pub const CALENDAR_ACTION: &str = "calendar.mutate";

pub(super) async fn calendar(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Bytes,
    org_id: web::Path<String>,
) -> HttpResponse {
    state
        .calendar(&request, org_id.as_str(), body.as_ref())
        .await
}

impl AppState {
    async fn calendar(&self, request: &HttpRequest, org_id: &str, body: &[u8]) -> HttpResponse {
        let actor = match self.verify_actor_envelope(request, org_id, CALENDAR_ACTION, None, body) {
            Ok(actor) if actor.actor().kind == "user" => actor,
            Ok(_) => return calendar_error(StatusCode::FORBIDDEN, "Board access required"),
            Err(ActorEnvelopeVerificationError::Unconfigured) => {
                return calendar_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Rust Calendar is unavailable",
                );
            }
            Err(ActorEnvelopeVerificationError::Invalid) => {
                return calendar_error(StatusCode::UNAUTHORIZED, "Unauthorized");
            }
        };
        let input = match serde_json::from_slice::<Value>(body) {
            Ok(input) if input.is_object() => input,
            _ => return calendar_error(StatusCode::BAD_REQUEST, "Invalid calendar request"),
        };
        let audit_run_id = input.get("auditRunId").and_then(Value::as_str);
        let DatabaseState::Configured(pool) = &self.database else {
            return calendar_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Rust Calendar is unavailable",
            );
        };
        match execute_calendar(pool, org_id, &actor.actor().id, audit_run_id, &input).await {
            Ok((status, body)) => {
                let status =
                    StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
                HttpResponse::build(status)
                    .content_type("application/json; charset=utf-8")
                    .json(body)
            }
            Err(CalendarError::Http(status, message)) => {
                let status =
                    StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
                calendar_error(status, &message)
            }
            Err(CalendarError::Database(error)) => {
                tracing::warn!(error = %error, "native Calendar operation failed");
                calendar_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
            }
        }
    }
}

fn calendar_error(status: StatusCode, message: &str) -> HttpResponse {
    HttpResponse::build(status)
        .content_type("application/json; charset=utf-8")
        .json(serde_json::json!({"error":message}))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::{
        ACTOR_ENVELOPE_AUDIENCE, ACTOR_ENVELOPE_HEADER, ACTOR_ENVELOPE_REQUEST_ID_HEADER,
        ActorEnvelope, ActorIdentity, ServerConfig, SigningKey,
    };
    use actix_web::{App, test};
    use serde_json::{Value, json};
    use sqlx::{PgPool, postgres::PgPoolOptions};
    use std::{
        env, fs,
        net::TcpListener,
        path::PathBuf,
        process::{Command, Stdio},
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    const ORG: &str = "10000000-0000-4000-8000-000000000001";
    const OTHER_ORG: &str = "10000000-0000-4000-8000-000000000002";
    const AGENT: &str = "50000000-0000-4000-8000-000000000001";
    const KEY: &[u8] = b"calendar-http-postgres-test-secret";
    const PATH: &str = "/internal/orgs/10000000-0000-4000-8000-000000000001/calendar";

    struct PostgresHarness {
        root: PathBuf,
        data_dir: PathBuf,
        pg_ctl: PathBuf,
        url: String,
    }

    impl PostgresHarness {
        fn start() -> Self {
            let root =
                env::temp_dir().join(format!("rudder-calendar-http-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).expect("create isolated PostgreSQL directory");
            let data_dir = root.join("data");
            let log = root.join("postgres.log");
            let port = TcpListener::bind("127.0.0.1:0")
                .expect("reserve PostgreSQL TCP port")
                .local_addr()
                .expect("read PostgreSQL port")
                .port();
            let initdb = postgres_binary("initdb");
            let pg_ctl = postgres_binary("pg_ctl");
            let status = Command::new(initdb)
                .arg("-D")
                .arg(&data_dir)
                .args([
                    "--encoding=UTF8",
                    "--locale=C",
                    "--auth=trust",
                    "--username=postgres",
                    "--no-sync",
                ])
                .status()
                .expect("run initdb");
            assert!(status.success(), "initdb failed: {status}");
            let status = Command::new(&pg_ctl)
                .arg("-D")
                .arg(&data_dir)
                .arg("-l")
                .arg(&log)
                .arg("-o")
                .arg(format!(
                    "-h 127.0.0.1 -p {port} -k '' -c shared_buffers=16MB"
                ))
                .args(["-w", "start"])
                .status()
                .expect("run pg_ctl start");
            assert!(
                status.success(),
                "pg_ctl start failed: {}",
                fs::read_to_string(&log).unwrap_or_default()
            );
            Self {
                root,
                data_dir,
                pg_ctl,
                url: format!("postgresql://postgres@127.0.0.1:{port}/postgres"),
            }
        }
    }

    impl Drop for PostgresHarness {
        fn drop(&mut self) {
            let _ = Command::new(&self.pg_ctl)
                .arg("-D")
                .arg(&self.data_dir)
                .args(["-m", "immediate", "-w", "stop"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn postgres_binary(name: &str) -> PathBuf {
        let executable = format!("{name}{}", env::consts::EXE_SUFFIX);
        let mut candidates = Vec::new();
        if let Some(dir) = env::var_os("RUDDER_POSTGRES_BIN_DIR") {
            candidates.push(PathBuf::from(dir).join(&executable));
        }
        if let Some(path) = env::var_os("PATH") {
            candidates.extend(env::split_paths(&path).map(|dir| dir.join(&executable)));
        }
        if let Ok(versions) = fs::read_dir("/usr/lib/postgresql") {
            candidates.extend(
                versions
                    .filter_map(std::result::Result::ok)
                    .map(|entry| entry.path().join("bin").join(&executable)),
            );
        }
        candidates
            .into_iter()
            .find(|candidate| candidate.is_file())
            .unwrap_or_else(|| panic!("PostgreSQL {name} not found"))
    }

    async fn install_calendar_schema(pool: &PgPool) {
        sqlx::raw_sql(
            r#"
            CREATE TABLE organizations (id uuid PRIMARY KEY);
            CREATE TABLE instance_settings (
              id uuid PRIMARY KEY DEFAULT gen_random_uuid(), singleton_key text NOT NULL UNIQUE DEFAULT 'default',
              browser jsonb NOT NULL DEFAULT '{}'::jsonb, general jsonb NOT NULL DEFAULT '{}'::jsonb,
              notifications jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(),
              updated_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE TABLE agents (
              id uuid PRIMARY KEY, org_id uuid NOT NULL, name text NOT NULL, role text NOT NULL DEFAULT 'general',
              title text, status text NOT NULL DEFAULT 'idle', workspace_key text,
              runtime_config jsonb NOT NULL DEFAULT '{}'::jsonb, last_heartbeat_at timestamptz,
              created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE TABLE projects (id uuid PRIMARY KEY, org_id uuid NOT NULL);
            CREATE TABLE goals (id uuid PRIMARY KEY, org_id uuid NOT NULL);
            CREATE TABLE approvals (id uuid PRIMARY KEY, org_id uuid NOT NULL);
            CREATE TABLE issues (
              id uuid PRIMARY KEY, org_id uuid NOT NULL, hidden_at timestamptz, identifier text,
              title text NOT NULL, status text NOT NULL DEFAULT 'backlog', priority text NOT NULL DEFAULT 'medium',
              origin_kind text, origin_id text
            );
            CREATE TABLE heartbeat_runs (
              id uuid PRIMARY KEY, org_id uuid NOT NULL, agent_id uuid NOT NULL, status text NOT NULL,
              started_at timestamptz, finished_at timestamptz, trigger_detail text, context_snapshot jsonb,
              created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE TABLE automations (id uuid PRIMARY KEY, org_id uuid NOT NULL, title text NOT NULL);
            CREATE TABLE activity_log (
              id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, actor_type text NOT NULL,
              actor_id text NOT NULL, action text NOT NULL, entity_type text NOT NULL, entity_id text NOT NULL,
              agent_id uuid, run_id uuid, details jsonb, idempotency_key text,
              created_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE TABLE organization_mutation_outbox (
              id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, activity_id uuid NOT NULL,
              event_type text NOT NULL, payload jsonb NOT NULL, state text NOT NULL DEFAULT 'pending',
              attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
              published_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE TABLE calendar_sources (
              id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, type text NOT NULL DEFAULT 'rudder_local',
              name text NOT NULL, owner_type text NOT NULL DEFAULT 'user', owner_user_id text, owner_agent_id uuid,
              external_provider text, external_calendar_id text, visibility_default text NOT NULL DEFAULT 'full',
              status text NOT NULL DEFAULT 'active', last_synced_at timestamptz, sync_cursor_json jsonb,
              created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE TABLE calendar_events (
              id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, source_id uuid,
              event_kind text NOT NULL, event_status text NOT NULL, owner_type text NOT NULL,
              owner_user_id text, owner_agent_id uuid, title text NOT NULL, description text,
              start_at timestamptz NOT NULL, end_at timestamptz NOT NULL, timezone text NOT NULL DEFAULT 'UTC',
              all_day boolean NOT NULL DEFAULT false, visibility text NOT NULL DEFAULT 'full', issue_id uuid,
              project_id uuid, goal_id uuid, approval_id uuid, heartbeat_run_id uuid, activity_id uuid,
              source_mode text NOT NULL DEFAULT 'manual', external_provider text, external_calendar_id text,
              external_event_id text, external_etag text, external_updated_at timestamptz,
              created_by_user_id text, updated_by_user_id text, created_at timestamptz NOT NULL DEFAULT now(),
              updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
            );
            INSERT INTO organizations(id) VALUES ('10000000-0000-4000-8000-000000000001'),('10000000-0000-4000-8000-000000000002');
            INSERT INTO agents(id,org_id,name,role,status,runtime_config)
              VALUES ('50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Calendar agent','builder','idle','{}');
            "#,
        )
        .execute(pool)
        .await
        .expect("install minimal public Calendar SQL fixture");
    }

    fn signed_request(
        body: &Value,
        id: &str,
        actor_kind: &str,
        actor_id: &str,
        org_id: &str,
        path: &str,
    ) -> test::TestRequest {
        let body = serde_json::to_vec(body).unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::from_secs(1))
            .as_secs();
        let envelope = ActorEnvelope::new(
            ActorIdentity::new(actor_kind, actor_id).unwrap(),
            org_id,
            "calendar-test-session",
            1,
            ACTOR_ENVELOPE_AUDIENCE,
            "POST",
            path,
            CALENDAR_ACTION,
            &body,
            id,
            format!("nonce-{id}"),
            now.saturating_sub(1),
            now + 30,
        )
        .unwrap()
        .sign(KEY)
        .unwrap();
        test::TestRequest::post()
            .uri(PATH)
            .insert_header(("content-type", "application/json"))
            .insert_header((
                ACTOR_ENVELOPE_HEADER,
                serde_json::to_string(&envelope).unwrap(),
            ))
            .insert_header((ACTOR_ENVELOPE_REQUEST_ID_HEADER, id))
            .set_payload(body)
    }

    #[actix_web::test]
    async fn signed_calendar_http_uses_postgres_for_sources_events_audit_and_scope() {
        let postgres = PostgresHarness::start();
        let pool = PgPoolOptions::new()
            .max_connections(4)
            .connect(&postgres.url)
            .await
            .expect("connect Calendar test PostgreSQL");
        install_calendar_schema(&pool).await;
        let app_state = AppState::new(ServerConfig {
            database_url: Some(postgres.url.clone()),
            database_required: true,
            actor_envelope_key: Some(SigningKey::new(KEY).unwrap()),
            ..ServerConfig::default()
        })
        .unwrap();
        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(app_state))
                .route("/internal/orgs/{org_id}/calendar", web::post().to(calendar)),
        )
        .await;

        let create_source = test::call_service(
            &app,
            signed_request(&json!({"operation":"source.create","input":{"name":"HTTP source","syncCursorJson":{"accessToken":"private-token"}}}), "calendar-source-create", "user", "board-user", ORG, PATH).to_request(),
        )
        .await;
        assert_eq!(create_source.status(), StatusCode::CREATED);
        let source: Value = serde_json::from_slice(&test::read_body(create_source).await).unwrap();
        assert_eq!(source["syncCursorJson"]["accessToken"], "[redacted]");
        let source_id = source["id"].as_str().unwrap();

        let start = (time::OffsetDateTime::now_utc() - time::Duration::minutes(1))
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap();
        let end = (time::OffsetDateTime::now_utc() + time::Duration::minutes(1))
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap();
        let create_event = test::call_service(
            &app,
            signed_request(&json!({"operation":"event.create","input":{"sourceId":source_id,"eventKind":"human_event","ownerType":"user","title":"HTTP event","startAt":start,"endAt":end}}), "calendar-event-create", "user", "board-user", ORG, PATH).to_request(),
        )
        .await;
        assert_eq!(create_event.status(), StatusCode::CREATED);
        let event: Value = serde_json::from_slice(&test::read_body(create_event).await).unwrap();
        assert_eq!(event["source"]["id"], source_id);
        let event_id = event["id"].as_str().unwrap();
        let list_start = (time::OffsetDateTime::now_utc() - time::Duration::minutes(5))
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap();
        let list_end = (time::OffsetDateTime::now_utc() + time::Duration::minutes(5))
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap();

        let list = test::call_service(
            &app,
            signed_request(&json!({"operation":"event.list","filters":{"start":list_start,"end":list_end,"agentIds":"","sourceIds":"","eventKinds":"human_event","statuses":"planned"}}), "calendar-event-list", "user", "board-user", ORG, PATH).to_request(),
        )
        .await;
        assert_eq!(list.status(), StatusCode::OK);
        let list: Value = serde_json::from_slice(&test::read_body(list).await).unwrap();
        assert!(
            list["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["id"] == event_id)
        );

        let cross_org_path = format!("/internal/orgs/{OTHER_ORG}/calendar");
        let cross_org = test::call_service(
            &app,
            signed_request(
                &json!({"operation":"source.list"}),
                "calendar-cross-org",
                "user",
                "board-user",
                ORG,
                &cross_org_path,
            )
            .to_request(),
        )
        .await;
        assert_eq!(cross_org.status(), StatusCode::UNAUTHORIZED);
        let invalid_actor = test::call_service(
            &app,
            signed_request(
                &json!({"operation":"source.create","input":{"name":"Agent denied"}}),
                "calendar-agent-denied",
                "agent",
                AGENT,
                ORG,
                PATH,
            )
            .to_request(),
        )
        .await;
        assert_eq!(invalid_actor.status(), StatusCode::FORBIDDEN);

        let audit_count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM activity_log WHERE org_id=$1::uuid")
                .bind(ORG)
                .fetch_one(&pool)
                .await
                .unwrap();
        let outbox_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM organization_mutation_outbox WHERE org_id=$1::uuid",
        )
        .bind(ORG)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(audit_count, 2);
        assert_eq!(outbox_count, 2);
        pool.close().await;
    }
}
