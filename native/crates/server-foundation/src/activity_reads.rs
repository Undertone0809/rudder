//! Private, signed, API-wide activity reads. No mutation mode gates or Node fallback.
use crate::{ActorEnvelopeVerificationError, AppState, DatabaseState};
use actix_web::{HttpRequest, HttpResponse, http::StatusCode, web};
use base64::{
    Engine as _, alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};
use rudder_d1_persistence::{
    StoreError,
    activity_reads::{ActivityCursor, ActivityFilters, ActivityRead, read_activity},
};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

pub const ACTIVITY_READ_ACTION: &str = "activity.read";

#[derive(Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum ActivityReadRequest {
    Organization {
        filters: ActivityFilters,
        page: Option<PageRequest>,
    },
    IssueActivity {
        #[serde(rename = "issueId")]
        issue_id: String,
    },
    IssueRuns {
        #[serde(rename = "issueId")]
        issue_id: String,
    },
    RunIssues {
        #[serde(rename = "runId")]
        run_id: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PageRequest {
    limit: Option<f64>,
    cursor: Option<String>,
}

fn cursor_engine() -> GeneralPurpose {
    GeneralPurpose::new(
        &alphabet::URL_SAFE,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
    )
}

fn decode_cursor(cursor: &str) -> Result<ActivityCursor, &'static str> {
    let decode = || -> Option<ActivityCursor> {
        // Buffer's base64url input accepts padded and ordinary base64 too.
        let cursor: String = cursor
            .chars()
            .filter(|c| !c.is_whitespace())
            .map(|c| match c {
                '+' => '-',
                '/' => '_',
                other => other,
            })
            .collect();
        let decoded = cursor_engine().decode(cursor).ok()?;
        let cursor: ActivityCursor = serde_json::from_slice(&decoded).ok()?;
        let id = cursor.id.as_bytes();
        if id.len() != 36
            || !matches!(id[14], b'1'..=b'5')
            || !matches!(id[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
            || uuid::Uuid::parse_str(&cursor.id).is_err()
        {
            return None;
        }
        let date = cursor.created_at.as_bytes();
        if date.len() != 27
            || date.iter().enumerate().any(|(i, c)| match i {
                4 | 7 => *c != b'-',
                10 => *c != b'T',
                13 | 16 => *c != b':',
                19 => *c != b'.',
                26 => *c != b'Z',
                _ => !c.is_ascii_digit(),
            })
            || OffsetDateTime::parse(&cursor.created_at, &Rfc3339).is_err()
        {
            return None;
        }
        Some(cursor)
    };
    decode().ok_or("Activity cursor is invalid or expired")
}

fn validate(input: ActivityReadRequest) -> Result<ActivityRead, &'static str> {
    Ok(match input {
        ActivityReadRequest::Organization { filters, page } => {
            let page = page
                .map(|page| {
                    let limit = page.limit.unwrap_or(30.0);
                    if !limit.is_finite() || limit.fract() != 0.0 {
                        return Err("invalid 'limit' value");
                    }
                    if !(1.0..=100.0).contains(&limit) {
                        return Err("'limit' must be between 1 and 100");
                    }
                    let cursor = page
                        .cursor
                        .filter(|c| !c.is_empty())
                        .map(|c| decode_cursor(&c))
                        .transpose()?;
                    Ok((limit as i64, cursor))
                })
                .transpose()?;
            ActivityRead::Organization { filters, page }
        }
        ActivityReadRequest::IssueActivity { issue_id } => ActivityRead::IssueActivity { issue_id },
        ActivityReadRequest::IssueRuns { issue_id } => ActivityRead::IssueRuns { issue_id },
        ActivityReadRequest::RunIssues { run_id } => ActivityRead::RunIssues { run_id },
    })
}

fn error(status: StatusCode, code: &str) -> HttpResponse {
    let message = match status {
        StatusCode::UNAUTHORIZED => "Unauthorized",
        StatusCode::UNPROCESSABLE_ENTITY => "Invalid Activity read request",
        StatusCode::SERVICE_UNAVAILABLE => "Rust Activity reads are unavailable",
        _ => "Internal server error",
    };
    HttpResponse::build(status).json(serde_json::json!({"error":message,"code":code}))
}

pub(super) async fn activity_reads(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Bytes,
    org_id: web::Path<String>,
) -> HttpResponse {
    state.activity_read(&request, &org_id, &body).await
}

// The page's opaque items may contain deeply nested legacy JSON. Deserialize
// only its bounded envelope; never parse/reserialize the full projection as Value.
fn public_page(body: &str) -> Result<String, serde_json::Error> {
    #[derive(Deserialize)]
    struct PrivatePage {
        items: Box<RawValue>,
        cursor: Option<ActivityCursor>,
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct PublicPage {
        items: Box<RawValue>,
        next_cursor: Option<String>,
    }
    let page: PrivatePage = serde_json::from_str(body)?;
    let next_cursor = page
        .cursor
        .map(|cursor| {
            serde_json::to_vec(&cursor)
                .map(|bytes| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
        })
        .transpose()?;
    serde_json::to_string(&PublicPage {
        items: page.items,
        next_cursor,
    })
}

impl AppState {
    async fn activity_read(
        &self,
        request: &HttpRequest,
        org_id: &str,
        body: &[u8],
    ) -> HttpResponse {
        match self.verify_actor_envelope(request, org_id, ACTIVITY_READ_ACTION, None, body) {
            Ok(_) => (),
            Err(ActorEnvelopeVerificationError::Unconfigured) => {
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "actor_envelope_unconfigured",
                );
            }
            Err(ActorEnvelopeVerificationError::Invalid) => {
                return error(StatusCode::UNAUTHORIZED, "actor_envelope_invalid");
            }
        }
        let input = match serde_json::from_slice::<ActivityReadRequest>(body) {
            Ok(input) => input,
            Err(_) => return error(StatusCode::UNPROCESSABLE_ENTITY, "activity_read_invalid"),
        };
        let input = match validate(input) {
            Ok(input) => input,
            Err(message) => {
                return HttpResponse::BadRequest().json(serde_json::json!({"error":message}));
            }
        };
        let paginated = matches!(&input, ActivityRead::Organization { page: Some(_), .. });
        let DatabaseState::Configured(pool) = &self.database else {
            return error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
        };
        match read_activity(pool, org_id, input).await {
            Ok(body) => {
                let body = if paginated {
                    match public_page(&body) {
                        Ok(body) => body,
                        Err(_) => {
                            return error(
                                StatusCode::INTERNAL_SERVER_ERROR,
                                "activity_read_failed",
                            );
                        }
                    }
                } else {
                    body
                };
                HttpResponse::Ok()
                    .content_type("application/json")
                    .body(body)
            }
            Err(StoreError::InvalidInput) => {
                error(StatusCode::UNPROCESSABLE_ENTITY, "activity_read_invalid")
            }
            Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "activity_read_failed"),
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
    const PATH: &str = "/internal/orgs/10000000-0000-4000-8000-000000000001/activity-reads";
    const KEY: &[u8] = b"synthetic-activity-read-key";
    fn state() -> AppState {
        AppState::new(ServerConfig {
            actor_envelope_key: Some(SigningKey::new(KEY).unwrap()),
            ..ServerConfig::default()
        })
        .unwrap()
    }
    fn signed(body: &[u8], mismatch: &str) -> HttpRequest {
        let now = unix_time_seconds();
        let mut envelope = ActorEnvelope::new(
            ActorIdentity::new("user", "synthetic").unwrap(),
            ORG,
            "session",
            1,
            ACTOR_ENVELOPE_AUDIENCE,
            "POST",
            PATH,
            ACTIVITY_READ_ACTION,
            body,
            "request",
            format!("nonce-{mismatch}"),
            now,
            now + 60,
        )
        .unwrap();
        match mismatch {
            "org" => envelope.organization_id = "20000000-0000-4000-8000-000000000002".into(),
            "action" => envelope.action = "project.read".into(),
            "method" => envelope.method = "GET".into(),
            "path" => envelope.path = format!("{PATH}?extra=1"),
            "request" => envelope.request_id = "other".into(),
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
    async fn signed_envelope_binds_scope_selection_and_rejects_replay() {
        let body = br#"{"operation":"organization","filters":{}}"#;
        for mismatch in ["org", "action", "method", "path", "request", "body"] {
            let request = signed(body, mismatch);
            let actual = if mismatch == "body" {
                br#"{"operation":"organization","filters":{"actorType":"agent"}}"#.as_slice()
            } else {
                body
            };
            assert_eq!(
                state().activity_read(&request, ORG, actual).await.status(),
                StatusCode::UNAUTHORIZED,
                "{mismatch}"
            );
        }
        let state = state();
        let request = signed(body, "valid");
        assert_eq!(
            state.activity_read(&request, ORG, body).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            state.activity_read(&request, ORG, body).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
    #[actix_web::test]
    async fn invalid_page_fails_before_database_access() {
        for body in [
            br#"{"operation":"organization","filters":{},"page":{"limit":101}}"#.as_slice(),
            br#"{"operation":"organization","filters":{},"page":{"cursor":"bad"}}"#,
        ] {
            assert_eq!(
                state()
                    .activity_read(&signed(body, "page"), ORG, body)
                    .await
                    .status(),
                StatusCode::BAD_REQUEST
            );
        }
        let body = br#"{"operation":"organization","filters":{},"owner":"rust"}"#;
        assert_eq!(
            state()
                .activity_read(&signed(body, "invalid"), ORG, body)
                .await
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    #[test]
    fn page_preserves_microsecond_cursor_and_deep_opaque_json() {
        let cursor = ActivityCursor {
            created_at: "2026-10-06T01:02:03.123456Z".into(),
            id: ORG.into(),
        };
        let deep = format!("{}0{}", "[".repeat(600), "]".repeat(600));
        let body = format!(
            r#"{{"items":[{deep}],"cursor":{}}}"#,
            serde_json::to_string(&cursor).unwrap()
        );
        let body = public_page(&body).unwrap();
        assert!(body.contains(&deep));
        let fields: std::collections::BTreeMap<String, Box<RawValue>> =
            serde_json::from_str(&body).unwrap();
        let encoded: String = serde_json::from_str(fields["nextCursor"].get()).unwrap();
        assert_eq!(
            decode_cursor(&encoded).unwrap().created_at,
            cursor.created_at
        );
        assert!(decode_cursor(&base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"id":"10000000-0000-7000-8000-000000000001","createdAt":"2026-10-06T01:02:03.123456Z"}"#)).is_err());
    }
}
