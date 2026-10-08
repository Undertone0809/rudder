//! Organization-scoped read authority for legacy and current Run rows.
//! Node authenticates and resolves references; no mutation-owner switch or
//! Node fallback can replace these domain queries and public projections.
mod projection;
mod redaction;
use crate::{ActorEnvelopeVerificationError, AppState, DatabaseState};
use actix_web::{HttpRequest, HttpResponse, http::StatusCode, web};
use redaction::{Redaction, redact_json};
use serde::Deserialize;
use sqlx::{PgPool, Row};

pub const RUN_READ_ACTION: &str = "run.read";

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub(super) enum Surface {
    Heartbeat,
    Agent,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum RunReadRequest {
    List {
        surface: Surface,
        agent_id: Option<String>,
        goal_id: Option<String>,
        start_date: Option<String>,
        end_date: Option<String>,
        limit: Option<u32>,
    },
    Overview {},
    Visibility {
        run_id: String,
    },
    WorkspaceOperationAccess {
        operation_id: String,
    },
    Detail {
        surface: Surface,
        run_id: String,
        redaction: Redaction,
    },
    Events {
        run_id: String,
        after_seq: f64,
        limit: f64,
        redaction: Redaction,
    },
    WorkspaceOperations {
        run_id: String,
        redaction: Redaction,
    },
    Active {
        issue_id: String,
        redaction: Redaction,
    },
}

fn json_error(status: StatusCode, message: &str) -> HttpResponse {
    HttpResponse::build(status)
        .content_type("application/json; charset=utf-8")
        .json(serde_json::json!({"error":message}))
}
fn db_error(error: impl std::fmt::Display) -> HttpResponse {
    // Do not expose SQL, paths, payloads, or credentials to public callers.
    tracing::warn!("native run read failed: {}", error);
    json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}
fn encode_error(error: serde_json::Error) -> sqlx::Error {
    sqlx::Error::Decode(Box::new(error))
}
fn list_json(rows: Vec<String>) -> String {
    format!("[{}]", rows.join(","))
}
fn response(raw: String) -> HttpResponse {
    HttpResponse::Ok()
        .content_type("application/json; charset=utf-8")
        .body(raw)
}

struct RunProjection {
    surface: Surface,
    list: bool,
    skills: bool,
}

async fn runs(
    pool: &PgPool,
    org: &str,
    suffix: &str,
    projection: RunProjection,
    binds: &[Option<String>],
    limit: Option<u32>,
    owner: Option<&str>,
) -> Result<Vec<String>, sqlx::Error> {
    let RunProjection {
        surface,
        list,
        skills,
    } = projection;
    let sql = format!(
        "SELECT r.id::text AS run_id, CASE WHEN jsonb_typeof(r.context_snapshot)='string' THEN r.context_snapshot#>>'{{}}' END AS context_string, CASE WHEN jsonb_typeof(r.context_snapshot)='number' THEN r.context_snapshot::text END AS context_number, ({})::text AS payload, ({})::text AS origin, ({})::text AS summary FROM heartbeat_runs r {suffix}",
        projection::run_projection(list, surface),
        projection::origin_projection(),
        projection::summary_projection()
    );
    let has_limit = list && suffix.contains("$6");
    let sql = crate::run_visibility::scoped_query(&sql, binds.len() + 2 + usize::from(has_limit));
    let mut query = sqlx::query(&sql).bind(org);
    for bind in binds {
        query = query.bind(bind);
    }
    if has_limit {
        query = query.bind(limit.map(i64::from));
    }
    let rows = query.bind(owner).fetch_all(pool).await?;
    let mut skills_by_run = std::collections::HashMap::<String, Vec<String>>::new();
    if skills && !rows.is_empty() {
        let run_ids = rows
            .iter()
            .map(|row| row.try_get::<String, _>("run_id"))
            .collect::<Result<Vec<_>, _>>()?;
        let skill_rows=sqlx::query(r#"
SELECT e.run_id::text AS run_id, jsonb_build_object('key', CASE WHEN jsonb_typeof(s.value->'key')='string' THEN s.value->>'key' END,
 'runtimeName', CASE WHEN jsonb_typeof(s.value->'runtimeName')='string' THEN s.value->>'runtimeName' END,
 'name', CASE WHEN jsonb_typeof(s.value->'name')='string' THEN s.value->>'name' END)::text AS payload
FROM heartbeat_run_events e CROSS JOIN LATERAL jsonb_array_elements(
 CASE WHEN jsonb_typeof(e.payload->'usedSkills')='array' THEN e.payload->'usedSkills' ELSE '[]'::jsonb END
) WITH ORDINALITY s(value, ordinal)
WHERE e.org_id=$1::uuid AND e.run_id=ANY($2::uuid[]) AND e.event_type IN ('adapter.invoke','adapter.skill_usage')
ORDER BY e.created_at ASC, e.id ASC, s.ordinal ASC"#).bind(org).bind(run_ids).fetch_all(pool).await?;
        for row in skill_rows {
            skills_by_run
                .entry(row.try_get("run_id")?)
                .or_default()
                .push(row.try_get("payload")?);
        }
    }
    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        let mut payload: String = row.try_get("payload")?;
        let origin: String = row.try_get("origin")?;
        if let Some(context) = row
            .try_get::<Option<String>, _>("context_string")?
            .filter(|s| !s.is_empty())
        {
            projection::append_raw_fields(
                &mut payload,
                &format!(
                    "{{\"contextSnapshot\":{}}}",
                    projection::public_string_context(&context)
                ),
            );
        }
        if let Some(context) = row.try_get::<Option<String>, _>("context_number")? {
            let context = projection::public_number_context(&context)
                .map_err(|error| sqlx::Error::Decode(Box::new(error)))?;
            projection::append_raw_fields(
                &mut payload,
                &format!("{{\"contextSnapshot\":{context}}}"),
            );
        }
        if list {
            let summary: String = row.try_get("summary")?;
            let mut summary = projection::summarize(&summary).map_err(encode_error)?;
            if skills {
                let run_id: String = row.try_get("run_id")?;
                let skill_rows = skills_by_run.remove(&run_id).unwrap_or_default();
                projection::add_skills(&mut summary, &skill_rows).map_err(encode_error)?;
            }
            projection::append_raw_fields(&mut payload, &format!("{{\"resultJson\":{summary}}}"));
        }
        if matches!(surface, Surface::Agent) {
            projection::append_fields(
                &mut payload,
                &projection::origin(&origin).map_err(encode_error)?,
            );
        }
        result.push(
            rudder_d1_persistence::legacy_read_json::normalize_legacy_read_json(&payload)
                .map_err(encode_error)?,
        );
    }
    Ok(result)
}

/// Read configuration without the Node settings service's get-or-create side
/// effect. Mirror its strict schema and legacy gitIdentity omission; select
/// only scalar settings metadata, never decode a legacy configuration object.
async fn log_redaction_enabled(pool: &PgPool) -> Result<bool, sqlx::Error> {
    let row=sqlx::query(r#"
SELECT CASE WHEN jsonb_typeof(general)='object' THEN
 (general - ARRAY['gitIdentity','censorUsernameInLogs','showDeveloperDiagnostics','experimentalPluginsEnabled','experimentalSitesEnabled','experimentalGoalsEnabled','experimentalComputerUseEnabled','locale','productAnalyticsMode','productAnalyticsConsentEpoch']::text[] = '{}'::jsonb)
 AND (NOT general ? 'censorUsernameInLogs' OR jsonb_typeof(general->'censorUsernameInLogs')='boolean')
 AND (NOT general ? 'showDeveloperDiagnostics' OR jsonb_typeof(general->'showDeveloperDiagnostics')='boolean')
 AND (NOT general ? 'experimentalPluginsEnabled' OR jsonb_typeof(general->'experimentalPluginsEnabled')='boolean')
 AND (NOT general ? 'experimentalSitesEnabled' OR jsonb_typeof(general->'experimentalSitesEnabled')='boolean')
 AND (NOT general ? 'experimentalGoalsEnabled' OR jsonb_typeof(general->'experimentalGoalsEnabled')='boolean')
 AND (NOT general ? 'experimentalComputerUseEnabled' OR jsonb_typeof(general->'experimentalComputerUseEnabled')='boolean')
 AND (NOT general ? 'locale' OR general->>'locale' IN ('en','zh-CN'))
 AND (NOT general ? 'productAnalyticsMode' OR general->>'productAnalyticsMode' IN ('off','anonymous','account_linked'))
 AND (NOT general ? 'productAnalyticsConsentEpoch' OR jsonb_typeof(general->'productAnalyticsConsentEpoch')='number')
 ELSE false END AS valid,
 CASE WHEN jsonb_typeof(general->'censorUsernameInLogs')='boolean' THEN (general->>'censorUsernameInLogs')::boolean ELSE false END AS enabled,
 CASE WHEN jsonb_typeof(general->'productAnalyticsConsentEpoch')='number' THEN general->>'productAnalyticsConsentEpoch' END AS epoch
FROM instance_settings WHERE singleton_key='default' LIMIT 1"#).fetch_optional(pool).await?;
    let Some(row) = row else {
        return Ok(false);
    };
    let epoch = row.try_get::<Option<String>, _>("epoch")?;
    let valid_epoch = epoch.as_deref().is_none_or(|value| {
        value
            .parse::<f64>()
            .is_ok_and(|number| number.is_finite() && number >= 1.0 && number.fract() == 0.0)
    });
    Ok(row.try_get::<Option<bool>, _>("valid")?.unwrap_or(false)
        && valid_epoch
        && row.try_get::<bool, _>("enabled")?)
}

async fn visible_run_exists(
    pool: &PgPool,
    org: &str,
    run_id: &str,
    owner: Option<&str>,
) -> Result<bool, sqlx::Error> {
    let query = crate::run_visibility::scoped_query(
        "SELECT EXISTS(SELECT 1 FROM heartbeat_runs r WHERE r.org_id=$1::uuid AND r.id=$2::uuid)",
        3,
    );
    sqlx::query_scalar(&query)
        .bind(org)
        .bind(run_id)
        .bind(owner)
        .fetch_one(pool)
        .await
}

async fn read(
    pool: &PgPool,
    org: &str,
    input: RunReadRequest,
    owner: Option<&str>,
) -> Result<HttpResponse, sqlx::Error> {
    match input {
        RunReadRequest::Visibility { run_id } => {
            if visible_run_exists(pool, org, &run_id, owner).await? {
                Ok(HttpResponse::NoContent().finish())
            } else {
                Ok(json_error(StatusCode::NOT_FOUND, "Agent run not found"))
            }
        }
        RunReadRequest::WorkspaceOperationAccess { operation_id } => {
            let unbound = crate::run_visibility::unbound_workspace_visible("w");
            let query = format!(
                "SELECT EXISTS(SELECT 1 FROM workspace_operations w WHERE w.org_id=$1::uuid AND w.id=$2::uuid AND ((w.heartbeat_run_id IS NOT NULL AND EXISTS(SELECT 1 FROM visible_runs admitted WHERE admitted.id=w.heartbeat_run_id)) OR (w.heartbeat_run_id IS NULL AND ({unbound}))))"
            );
            let query = crate::run_visibility::scoped_query(&query, 3);
            let visible: bool = sqlx::query_scalar(&query)
                .bind(org)
                .bind(operation_id)
                .bind(owner)
                .fetch_one(pool)
                .await?;
            if visible {
                Ok(HttpResponse::NoContent().finish())
            } else {
                Ok(json_error(
                    StatusCode::NOT_FOUND,
                    "Workspace operation not found",
                ))
            }
        }
        RunReadRequest::List {
            surface,
            agent_id,
            goal_id,
            start_date,
            end_date,
            limit,
        } => {
            let has_skills = agent_id.is_some();
            // UUID casts retain the legacy database's accepted UUID syntax.
            let values = [agent_id, goal_id, start_date, end_date];
            let rows = runs(pool, org, "WHERE r.org_id=$1::uuid AND ($2::uuid IS NULL OR r.agent_id=$2::uuid) AND ($3::uuid IS NULL OR r.goal_id=$3::uuid) AND ($4::timestamptz IS NULL OR r.created_at >= $4::timestamptz) AND ($5::timestamptz IS NULL OR r.created_at <= $5::timestamptz) ORDER BY r.created_at DESC, r.id DESC LIMIT $6", RunProjection { surface, list: true, skills: has_skills }, &values, limit, owner).await?;
            Ok(response(list_json(rows)))
        }
        RunReadRequest::Overview {} => {
            let latest = runs(pool, org, "INNER JOIN (SELECT DISTINCT ON (r.agent_id) r.id FROM heartbeat_runs r INNER JOIN agents a ON a.id=r.agent_id WHERE r.org_id=$1::uuid AND a.org_id=$1::uuid AND a.status <> 'terminated' ORDER BY r.agent_id, r.created_at DESC, r.id DESC) latest ON latest.id=r.id ORDER BY r.agent_id", RunProjection { surface: Surface::Agent, list: true, skills: false }, &[], None, owner).await?;
            let recent = runs(pool, org, "INNER JOIN agents a ON a.id=r.agent_id WHERE r.org_id=$1::uuid AND a.org_id=$1::uuid ORDER BY r.created_at DESC, r.id DESC LIMIT 6", RunProjection { surface: Surface::Agent, list: true, skills: false }, &[], None, owner).await?;
            Ok(response(format!(
                "{{\"latestByAgent\":{},\"recent\":{}}}",
                list_json(latest),
                list_json(recent)
            )))
        }
        RunReadRequest::Detail {
            surface,
            run_id,
            mut redaction,
        } => {
            redaction.enabled = log_redaction_enabled(pool).await?;
            let rows = runs(
                pool,
                org,
                "WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
                RunProjection {
                    surface,
                    list: false,
                    skills: false,
                },
                &[Some(run_id)],
                None,
                owner,
            )
            .await?;
            match rows.into_iter().next() {
                Some(raw) => Ok(response(
                    redact_json(&raw, &redaction, false).map_err(encode_error)?,
                )),
                None => Ok(json_error(
                    StatusCode::NOT_FOUND,
                    match surface {
                        Surface::Heartbeat => "Heartbeat run not found",
                        Surface::Agent => "Agent run not found",
                    },
                )),
            }
        }
        RunReadRequest::Events {
            run_id,
            after_seq,
            limit,
            mut redaction,
        } => {
            if !visible_run_exists(pool, org, &run_id, owner).await? {
                return Ok(json_error(StatusCode::NOT_FOUND, "Agent run not found"));
            }
            redaction.enabled = log_redaction_enabled(pool).await?;
            let query = format!(
                "SELECT ({})::text FROM heartbeat_run_events e INNER JOIN heartbeat_runs r ON r.id=e.run_id AND r.org_id=e.org_id WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND e.seq > $3::integer AND e.event_type <> 'issue.execution_released' ORDER BY e.seq ASC LIMIT $4::bigint",
                projection::event_projection()
            );
            let query = crate::run_visibility::scoped_query(&query, 5);
            let rows = sqlx::query_scalar::<_, String>(&query)
                .bind(org)
                .bind(run_id)
                .bind(after_seq.to_string())
                .bind(limit.clamp(1.0, 1000.0).to_string())
                .bind(owner)
                .fetch_all(pool)
                .await?;
            let result = rows
                .into_iter()
                .map(|raw| {
                    let raw = redaction::decode_event_payload_column(&raw).map_err(encode_error)?;
                    redact_json(&raw, &redaction, true).map_err(encode_error)
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(response(list_json(result)))
        }
        RunReadRequest::WorkspaceOperations {
            run_id,
            mut redaction,
        } => {
            if !visible_run_exists(pool, org, &run_id, owner).await? {
                return Ok(json_error(StatusCode::NOT_FOUND, "Agent run not found"));
            }
            redaction.enabled = log_redaction_enabled(pool).await?;
            let workspace = sqlx::query_scalar::<_,Option<String>>("SELECT CASE WHEN jsonb_typeof(context_snapshot->'executionWorkspaceId')='string' THEN context_snapshot->>'executionWorkspaceId' END FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid")
                .bind(org).bind(&run_id).fetch_optional(pool).await?.flatten();
            let workspace = workspace
                .as_deref()
                .map(redaction::js_trim)
                .filter(|value| !value.is_empty());
            let unbound = crate::run_visibility::unbound_workspace_visible("w");
            let query = format!(
                "SELECT ({})::text FROM workspace_operations w INNER JOIN heartbeat_runs r ON r.id=$2::uuid AND r.org_id=w.org_id WHERE w.org_id=$1::uuid AND (w.heartbeat_run_id=$2::uuid OR ($3::uuid IS NOT NULL AND w.heartbeat_run_id IS NULL AND w.execution_workspace_id=$3::uuid AND ({unbound}))) ORDER BY w.started_at ASC,w.created_at ASC,w.id ASC",
                projection::workspace_projection()
            );
            let query = crate::run_visibility::scoped_query(&query, 4);
            let rows = sqlx::query_scalar::<_, String>(&query)
                .bind(org)
                .bind(run_id)
                .bind(workspace)
                .bind(owner)
                .fetch_all(pool)
                .await?;
            let result = rows
                .into_iter()
                .map(|raw| redact_json(&raw, &redaction, false).map_err(encode_error))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(response(list_json(result)))
        }
        RunReadRequest::Active {
            issue_id,
            mut redaction,
        } => {
            redaction.enabled = log_redaction_enabled(pool).await?;
            // Pinned execution wins even for terminal runs with effects pending.
            // Visibility applies before candidate selection. Among visible runs,
            // select the latest active run, THEN check its issue context.
            let selected_sql = r#"
WITH issue AS (SELECT id, execution_run_id, assignee_agent_id, status FROM issues WHERE org_id=$1::uuid AND id=$2::uuid),
pinned AS (SELECT r.id FROM issue i INNER JOIN heartbeat_runs r ON r.id=i.execution_run_id AND r.org_id=$1::uuid WHERE r.status IN ('queued','running') OR r.terminal_effects_pending=true),
candidate AS (SELECT r.id,CASE WHEN jsonb_typeof(r.context_snapshot->'issueId')='string' THEN r.context_snapshot->>'issueId' END AS issue_id FROM issue i INNER JOIN heartbeat_runs r ON r.agent_id=i.assignee_agent_id AND r.org_id=$1::uuid WHERE i.status='in_progress' AND (r.status='running' OR r.terminal_effects_pending=true) ORDER BY r.started_at DESC LIMIT 1)
SELECT id::text, true AS pinned, NULL::text AS issue_id FROM pinned UNION ALL SELECT id::text, false AS pinned, issue_id FROM candidate WHERE NOT EXISTS(SELECT 1 FROM pinned) LIMIT 1"#;
            let selected_sql = crate::run_visibility::scoped_query(selected_sql, 3);
            let selected = sqlx::query(&selected_sql)
                .bind(org)
                .bind(&issue_id)
                .bind(owner)
                .fetch_all(pool)
                .await?;
            let Some(selected) = selected.into_iter().next() else {
                return Ok(response("null".into()));
            };
            if !selected.try_get::<bool, _>("pinned")?
                && selected
                    .try_get::<Option<String>, _>("issue_id")?
                    .as_deref()
                    .map(redaction::js_trim)
                    != Some(issue_id.as_str())
            {
                return Ok(response("null".into()));
            }
            let run_id: String = selected.try_get("id")?;
            let rows = runs(pool, org, "INNER JOIN agents a ON a.id=r.agent_id AND a.org_id=r.org_id WHERE r.org_id=$1::uuid AND r.id=$2::uuid",RunProjection {surface: Surface::Heartbeat,list:false,skills:false},&[Some(run_id.clone())],None,owner).await?;
            let Some(raw) = rows.into_iter().next() else {
                return Ok(response("null".into()));
            };
            let mut raw = redact_json(&raw, &redaction, false).map_err(encode_error)?;
            let agent: String=sqlx::query_scalar("SELECT jsonb_build_object('agentId',a.id::text,'agentName',a.name,'agentRuntimeType',a.agent_runtime_type)::text FROM agents a INNER JOIN heartbeat_runs r ON r.agent_id=a.id AND r.org_id=a.org_id WHERE r.org_id=$1::uuid AND r.id=$2::uuid").bind(org).bind(run_id).fetch_one(pool).await?;
            projection::append_raw_fields(&mut raw, &agent);
            Ok(response(raw))
        }
    }
}

pub(super) async fn run_reads(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Bytes,
    org: web::Path<String>,
) -> HttpResponse {
    state.run_read(&request, org.as_str(), &body).await
}
impl AppState {
    async fn run_read(&self, request: &HttpRequest, org: &str, body: &[u8]) -> HttpResponse {
        let actor = match self.verify_actor_envelope(request, org, RUN_READ_ACTION, None, body) {
            Ok(actor) => actor,
            Err(ActorEnvelopeVerificationError::Unconfigured) => {
                return json_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Rust run reads are unavailable",
                );
            }
            Err(ActorEnvelopeVerificationError::Invalid) => {
                return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
            }
        };
        let input = match serde_json::from_slice::<RunReadRequest>(body) {
            Ok(input) if !matches!(&input, RunReadRequest::List{limit:Some(n),..} if *n == 0 || *n > 1000) => {
                input
            }
            _ => return json_error(StatusCode::UNPROCESSABLE_ENTITY, "Invalid run read request"),
        };
        let DatabaseState::Configured(pool) = &self.database else {
            return json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Rust run reads are unavailable",
            );
        };
        match read(pool, org, input, crate::run_visibility::owner(&actor)).await {
            Ok(response) => response,
            Err(error) => db_error(error),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ACTOR_ENVELOPE_AUDIENCE, ACTOR_ENVELOPE_HEADER, ACTOR_ENVELOPE_REQUEST_ID_HEADER,
        ActorEnvelope, ActorIdentity, ServerConfig, SigningKey, unix_time_seconds,
    };
    use actix_web::test::TestRequest;

    const ORG: &str = "10000000-0000-4000-8000-000000000001";
    const PATH: &str = "/internal/orgs/10000000-0000-4000-8000-000000000001/run-reads";
    const KEY: &[u8] = b"synthetic-live-run-read-key";

    fn state() -> AppState {
        AppState::new(ServerConfig {
            actor_envelope_key: Some(SigningKey::new(KEY).unwrap()),
            ..ServerConfig::default()
        })
        .unwrap()
    }

    fn signed(body: &[u8], field: &str) -> HttpRequest {
        let now = unix_time_seconds();
        let mut envelope = ActorEnvelope::new(
            ActorIdentity::new("user", "synthetic").unwrap(),
            ORG,
            "session",
            1,
            ACTOR_ENVELOPE_AUDIENCE,
            "POST",
            PATH,
            RUN_READ_ACTION,
            body,
            "request",
            format!("nonce-{field}"),
            now,
            now + 60,
        )
        .unwrap();
        match field {
            "org" => envelope.organization_id = "10000000-0000-4000-8000-000000000002".to_owned(),
            "action" => envelope.action = "project.create".to_owned(),
            "method" => envelope.method = "GET".to_owned(),
            "path" => envelope.path = format!("{PATH}?unexpected=true"),
            "request" => envelope.request_id = "other".to_owned(),
            _ => (),
        }
        TestRequest::post()
            .uri(PATH)
            .insert_header((
                ACTOR_ENVELOPE_HEADER,
                serde_json::to_string(&envelope.sign(KEY).unwrap()).unwrap(),
            ))
            .insert_header((ACTOR_ENVELOPE_REQUEST_ID_HEADER, "request"))
            .to_http_request()
    }

    #[actix_web::test]
    async fn envelope_binds_scope_body_method_path_action_request_and_nonce() {
        let body = br#"{"operation":"overview"}"#;
        for field in ["org", "action", "method", "path", "request", "body"] {
            let actual = if field == "body" {
                br#"{"operation":"overview","extra":true}"#.as_slice()
            } else {
                body.as_slice()
            };
            assert_eq!(
                state()
                    .run_read(&signed(body, field), ORG, actual)
                    .await
                    .status(),
                StatusCode::UNAUTHORIZED,
                "{field}"
            );
        }
        let state = state();
        let request = signed(body, "valid");
        assert_eq!(
            state.run_read(&request, ORG, body).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            state.run_read(&request, ORG, body).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[actix_web::test]
    async fn malformed_signed_commands_are_rejected_before_database_access() {
        for body in [
            r#"{}"#,
            r#"{"operation":"unknown"}"#,
            r#"{"operation":"list","surface":"agent","limit":-1}"#,
            r#"{"operation":"list","surface":"agent","limit":1001}"#,
            r#"{"operation":"detail","surface":"agent","runId":"run"}"#,
            r#"{"operation":"overview","owner":"rust"}"#,
        ] {
            let body = body.as_bytes();
            assert_eq!(
                state()
                    .run_read(&signed(body, "invalid"), ORG, body)
                    .await
                    .status(),
                StatusCode::UNPROCESSABLE_ENTITY
            );
        }
    }

    #[actix_web::test]
    async fn errors_keep_the_legacy_public_body_and_json_charset() {
        let response = json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error");
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "application/json; charset=utf-8"
        );
        let body = actix_web::body::to_bytes(response.into_body())
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({"error":"Internal server error"})
        );
    }
}
