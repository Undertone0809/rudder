//! Read-only live-run selection with Node-resolved issue access and chat visibility.
//! The signed request carries the authorized organization, resolved issue UUID,
//! and derived chat visibility scope into this capability.
use crate::{ActorEnvelopeVerificationError, AppState, DatabaseState};
use actix_web::{HttpRequest, HttpResponse, http::StatusCode, web};
use rudder_d1_persistence::legacy_read_json::normalize_legacy_read_json;
use serde::Deserialize;
use sqlx::PgPool;

pub const LIVE_RUN_READ_ACTION: &str = "live_run.read";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct LiveRunReadRequest {
    issue_id: Option<String>,
    goal_id: Option<String>,
    min_count: u32,
    #[serde(default)]
    chat_visibility: LiveRunChatVisibility,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "mode",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum LiveRunChatVisibility {
    All,
    None,
    Owner { owner_user_id: String },
}

impl Default for LiveRunChatVisibility {
    fn default() -> Self {
        Self::All
    }
}

// Keep the explicit legacy projection: resultJson is the summary, never the
// full result, and issue reads deliberately omit goalId and issueId. PostgreSQL
// timestamps must match JavaScript Date JSON (UTC, exactly three fractional digits).
const PROJECTION: &str = r#"
jsonb_build_object(
  'id', r.id::text,
  'status', r.status,
  'executionPhase', r.running_substate,
  'invocationSource', r.invocation_source,
  'triggerDetail', r.trigger_detail,
  'startedAt', to_char(r.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'finishedAt', to_char(r.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'createdAt', to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'stdoutExcerpt', r.stdout_excerpt,
  'resultJson', r.result_summary_json,
  'agentId', r.agent_id::text,
  'agentName', a.name,
  'agentRuntimeType', a.agent_runtime_type
)
"#;

fn chat_visibility_filter(scope: &LiveRunChatVisibility, owner_bind: &str) -> String {
    let owner_condition = match scope {
        LiveRunChatVisibility::All => return String::new(),
        LiveRunChatVisibility::None => "false".to_owned(),
        LiveRunChatVisibility::Owner { .. } => {
            format!("visible_conversation.created_by_user_id = {owner_bind}")
        }
    };
    let marker = "coalesce((r.scene = 'side_chat' or r.context_snapshot ->> 'scene' = 'side_chat' or r.context_snapshot ->> 'rudderScene' = 'side_chat' or r.context_snapshot -> 'unifiedAgentRun' ->> 'scene' = 'side_chat'), false)";
    format!(
        r#"AND (
  (
    ({marker})
    AND EXISTS (
      SELECT 1 FROM chat_conversations visible_conversation
      WHERE visible_conversation.id = r.chat_conversation_id
        AND visible_conversation.org_id = r.org_id
        AND visible_conversation.conversation_kind = 'side_chat'
        AND {owner_condition}
    )
  )
  OR (
    NOT ({marker})
    AND (
      r.chat_conversation_id IS NULL
      OR EXISTS (
        SELECT 1 FROM chat_conversations visible_conversation
        WHERE visible_conversation.id = r.chat_conversation_id
          AND visible_conversation.org_id = r.org_id
          AND (
            visible_conversation.conversation_kind <> 'side_chat'
            OR {owner_condition}
          )
      )
    )
  )
)"#
    )
}

fn read_sql(issue: bool, goal: bool, visibility: &LiveRunChatVisibility) -> String {
    let projection = if issue {
        PROJECTION.to_owned()
    } else {
        format!(
            "{PROJECTION} || jsonb_build_object('goalId', r.goal_id::text, 'issueId', r.context_snapshot ->> 'issueId')"
        )
    };
    let filter = if issue {
        "AND r.context_snapshot ->> 'issueId' = $2"
    } else if goal {
        "AND r.goal_id = $2::uuid"
    } else {
        ""
    };
    let has_selection_bind = issue || goal;
    let owner_bind_index = 2 + if has_selection_bind { 1 } else { 0 };
    let has_owner_bind = matches!(visibility, LiveRunChatVisibility::Owner { .. });
    let minimum_bind_index = owner_bind_index + if has_owner_bind { 1 } else { 0 };
    let visibility_filter = chat_visibility_filter(visibility, &format!("${owner_bind_index}"));
    // One statement gives live rows and fillers a coherent snapshot. The live
    // set is never capped by minCount. CTE count only controls the filler limit;
    // selecting through the same join preserves missing-agent behavior.
    format!(
        r#"WITH live AS MATERIALIZED (
 SELECT r.id, r.created_at, ({projection})::text AS payload
 FROM heartbeat_runs r INNER JOIN agents a ON a.id = r.agent_id
 WHERE r.org_id = $1::uuid {filter} {visibility_filter}
 AND (r.status IN ('queued', 'running') OR r.terminal_effects_pending = true)
), recent AS (
 SELECT r.id, r.created_at, ({projection})::text AS payload
 FROM heartbeat_runs r INNER JOIN agents a ON a.id = r.agent_id
 WHERE r.org_id = $1::uuid {filter} {visibility_filter}
 AND r.status NOT IN ('queued', 'running') AND r.terminal_effects_pending = false
 AND NOT EXISTS (SELECT 1 FROM live WHERE live.id = r.id)
 ORDER BY r.created_at DESC
 LIMIT GREATEST(0, ${minimum_bind_index}::bigint - (SELECT count(*) FROM live))
)
SELECT payload FROM (
 SELECT 0 AS section, created_at, payload FROM live
 UNION ALL
 SELECT 1 AS section, created_at, payload FROM recent
) selected ORDER BY section, created_at DESC"#
    )
}

async fn read_live_runs(
    pool: &PgPool,
    org_id: &str,
    input: &LiveRunReadRequest,
) -> Result<String, sqlx::Error> {
    let sql = read_sql(
        input.issue_id.is_some(),
        input.goal_id.is_some(),
        &input.chat_visibility,
    );
    let mut query = sqlx::query_scalar::<_, String>(&sql).bind(org_id);
    if let Some(issue_id) = &input.issue_id {
        query = query.bind(issue_id);
    } else if let Some(goal_id) = &input.goal_id {
        query = query.bind(goal_id);
    }
    if let LiveRunChatVisibility::Owner { owner_user_id } = &input.chat_visibility {
        query = query.bind(owner_user_id);
    }
    let rows = query
        .bind(i64::from(input.min_count))
        .fetch_all(pool)
        .await?;
    rows.into_iter()
        .map(|row| {
            normalize_legacy_read_json(&row).map_err(|error| sqlx::Error::Decode(Box::new(error)))
        })
        .collect::<Result<Vec<String>, _>>()
        .map(|rows| format!("[{}]", rows.join(",")))
}

fn read_error(status: StatusCode, code: &str) -> HttpResponse {
    let error = match status {
        StatusCode::UNAUTHORIZED => "Unauthorized",
        StatusCode::UNPROCESSABLE_ENTITY => "Invalid live-run read request",
        StatusCode::SERVICE_UNAVAILABLE => "Rust live-run reads are unavailable",
        _ => "Internal server error",
    };
    tracing::warn!(reason = code, "native live-run read failed");
    HttpResponse::build(status)
        .content_type("application/json; charset=utf-8")
        .json(serde_json::json!({"error":error}))
}

pub(super) async fn live_run_reads(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Bytes,
    org_id: web::Path<String>,
) -> HttpResponse {
    state.live_run_read(&request, org_id.as_str(), &body).await
}

impl AppState {
    async fn live_run_read(
        &self,
        request: &HttpRequest,
        org_id: &str,
        body: &[u8],
    ) -> HttpResponse {
        match self.verify_actor_envelope(request, org_id, LIVE_RUN_READ_ACTION, None, body) {
            Ok(_) => (),
            Err(ActorEnvelopeVerificationError::Unconfigured) => {
                return read_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "actor_envelope_unconfigured",
                );
            }
            Err(ActorEnvelopeVerificationError::Invalid) => {
                return read_error(StatusCode::UNAUTHORIZED, "actor_envelope_invalid");
            }
        }
        let input = match serde_json::from_slice::<LiveRunReadRequest>(body) {
            Ok(input)
                if input.min_count <= 20
                    && !(input.issue_id.is_some()
                        && (input.goal_id.is_some() || input.min_count != 0)) =>
            {
                input
            }
            _ => return read_error(StatusCode::UNPROCESSABLE_ENTITY, "live_run_read_invalid"),
        };
        let DatabaseState::Configured(pool) = &self.database else {
            return read_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
        };
        match read_live_runs(pool, org_id, &input).await {
            // The old live list is unbounded. Applying the foundation receipt
            // size limit here would silently break high-volume parity.
            Ok(runs) => HttpResponse::Ok()
                .content_type("application/json; charset=utf-8")
                .body(runs),
            Err(_) => read_error(StatusCode::INTERNAL_SERVER_ERROR, "live_run_read_failed"),
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
    const PATH: &str = "/internal/orgs/10000000-0000-4000-8000-000000000001/live-run-reads";
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
            LIVE_RUN_READ_ACTION,
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
        let body = br#"{"issueId":null,"goalId":null,"minCount":0}"#;
        for field in ["org", "action", "method", "path", "request", "body"] {
            let actual = if field == "body" {
                br#"{"issueId":null,"goalId":null,"minCount":1}"#.as_slice()
            } else {
                body.as_slice()
            };
            assert_eq!(
                state()
                    .live_run_read(&signed(body, field), ORG, actual)
                    .await
                    .status(),
                StatusCode::UNAUTHORIZED,
                "{field}"
            );
        }
        let state = state();
        let request = signed(body, "valid");
        assert_eq!(
            state.live_run_read(&request, ORG, body).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            state.live_run_read(&request, ORG, body).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[actix_web::test]
    async fn malformed_signed_commands_are_rejected_before_database_access() {
        for body in [
            r#"{}"#,
            r#"{"minCount":21}"#,
            r#"{"minCount":-1}"#,
            r#"{"issueId":"issue","goalId":"goal","minCount":0}"#,
            r#"{"issueId":"issue","minCount":1}"#,
            r#"{"minCount":0,"owner":"rust"}"#,
        ] {
            let body = body.as_bytes();
            assert_eq!(
                state()
                    .live_run_read(&signed(body, "invalid"), ORG, body)
                    .await
                    .status(),
                StatusCode::UNPROCESSABLE_ENTITY
            );
        }
    }

    #[test]
    fn chat_visibility_defaults_to_all_and_deserializes_each_mode() {
        let omitted: LiveRunReadRequest =
            serde_json::from_str(r#"{"issueId":null,"goalId":null,"minCount":0}"#).unwrap();
        assert_eq!(omitted.chat_visibility, LiveRunChatVisibility::All);

        for (json, expected) in [
            (r#"{"mode":"all"}"#, LiveRunChatVisibility::All),
            (r#"{"mode":"none"}"#, LiveRunChatVisibility::None),
            (
                r#"{"mode":"owner","ownerUserId":"user-1"}"#,
                LiveRunChatVisibility::Owner {
                    owner_user_id: "user-1".to_owned(),
                },
            ),
        ] {
            let request: LiveRunReadRequest = serde_json::from_str(&format!(
                r#"{{"issueId":null,"goalId":null,"minCount":0,"chatVisibility":{json}}}"#
            ))
            .unwrap();
            assert_eq!(request.chat_visibility, expected);
        }
    }

    #[actix_web::test]
    async fn errors_keep_the_legacy_public_body_and_json_charset() {
        let response = read_error(StatusCode::INTERNAL_SERVER_ERROR, "live_run_read_failed");
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

    #[test]
    fn sql_keeps_live_rows_uncapped_and_projection_compatible() {
        let org = read_sql(false, false, &LiveRunChatVisibility::All);
        assert!(org.contains("'resultJson', r.result_summary_json"));
        assert!(!org.contains("r.result_json"));
        assert!(org.contains("INNER JOIN agents a ON a.id = r.agent_id"));
        assert!(org.contains("'goalId', r.goal_id::text"));
        assert!(org.contains("'issueId', r.context_snapshot ->> 'issueId'"));
        assert!(org.contains("LIMIT GREATEST(0, $2::bigint - (SELECT count(*) FROM live))"));
        assert!(!org.contains("chat_conversations"));
        assert!(
            !org.split("), recent AS (")
                .next()
                .unwrap()
                .contains("LIMIT")
        );
        let issue = read_sql(true, false, &LiveRunChatVisibility::All);
        assert!(!issue.contains("'goalId'"));
        assert!(!issue.contains("'issueId',"));
        assert!(issue.contains("r.context_snapshot ->> 'issueId' = $2"));
        assert!(
            read_sql(false, true, &LiveRunChatVisibility::All).contains("r.goal_id = $2::uuid")
        );
    }

    #[test]
    fn sql_applies_owner_and_hide_all_visibility_to_both_run_sets() {
        let owner = read_sql(
            false,
            false,
            &LiveRunChatVisibility::Owner {
                owner_user_id: "user-1".to_owned(),
            },
        );
        assert_eq!(
            owner
                .matches("visible_conversation.created_by_user_id = $2")
                .count(),
            4
        );
        assert_eq!(
            owner
                .matches("visible_conversation.org_id = r.org_id")
                .count(),
            4
        );
        assert_eq!(
            owner
                .matches("visible_conversation.conversation_kind = 'side_chat'")
                .count(),
            2
        );
        assert_eq!(
            owner
                .matches("visible_conversation.conversation_kind <> 'side_chat'")
                .count(),
            2
        );
        assert_eq!(owner.matches("r.chat_conversation_id IS NULL").count(), 2);
        assert!(owner.contains("LIMIT GREATEST(0, $3::bigint - (SELECT count(*) FROM live))"));
        let owner_issue = read_sql(
            true,
            false,
            &LiveRunChatVisibility::Owner {
                owner_user_id: "user-1".to_owned(),
            },
        );
        assert!(owner_issue.contains("r.context_snapshot ->> 'issueId' = $2"));
        assert!(owner_issue.contains("visible_conversation.created_by_user_id = $3"));
        assert!(
            owner_issue.contains("LIMIT GREATEST(0, $4::bigint - (SELECT count(*) FROM live))")
        );

        let hidden = read_sql(false, false, &LiveRunChatVisibility::None);
        assert_eq!(hidden.matches("AND false").count(), 2);
        assert!(hidden.contains("visible_conversation.org_id = r.org_id"));
        assert!(hidden.contains("visible_conversation.conversation_kind <> 'side_chat'"));
        assert!(hidden.contains("r.chat_conversation_id IS NULL"));
        assert!(hidden.contains("LIMIT GREATEST(0, $2::bigint - (SELECT count(*) FROM live))"));
    }
}
