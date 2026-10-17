//! Signed Overview reads use the existing actor envelope, independently of
//! mutation pilots. Successful responses are public JSON, never receipts.
use crate::{ActorEnvelopeVerificationError, AppState, DatabaseState};
use actix_web::{HttpRequest, HttpResponse, http::StatusCode, web};
use rudder_d1_persistence::{
    StoreError,
    overview_reads::{OverviewReadError, OverviewReadInput, read_overview},
};

pub const OVERVIEW_READ_ACTION: &str = "overview.read";

fn error(status: StatusCode, code: &str) -> HttpResponse {
    let message = match status {
        StatusCode::UNAUTHORIZED => "Unauthorized",
        StatusCode::UNPROCESSABLE_ENTITY => "Invalid Overview read request",
        StatusCode::SERVICE_UNAVAILABLE => "Rust Overview reads are unavailable",
        _ => "Internal server error",
    };
    if status == StatusCode::INTERNAL_SERVER_ERROR {
        HttpResponse::build(status).json(serde_json::json!({"error":message}))
    } else {
        HttpResponse::build(status).json(serde_json::json!({"error":message,"code":code}))
    }
}

pub(super) async fn overview_reads(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Bytes,
    org_id: web::Path<String>,
) -> HttpResponse {
    state
        .overview_read(&request, org_id.as_str(), body.as_ref())
        .await
}

impl AppState {
    async fn overview_read(
        &self,
        request: &HttpRequest,
        org_id: &str,
        body: &[u8],
    ) -> HttpResponse {
        match self.verify_actor_envelope(request, org_id, OVERVIEW_READ_ACTION, None, body) {
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
        // This header has already passed signature, request binding, expiry,
        // issuance and nonce verification. Compare the body's clock to its
        // issuance bucket without changing the shared authentication contract.
        let issued_at = request
            .headers()
            .get(crate::ACTOR_ENVELOPE_HEADER)
            .and_then(|header| header.to_str().ok())
            .and_then(|header| serde_json::from_str::<crate::ActorEnvelope>(header).ok())
            .map(|envelope| envelope.issued_at);
        let input = match serde_json::from_slice::<OverviewReadInput>(body) {
            Ok(input)
                if input.validate().is_ok()
                    && issued_at.is_some_and(|issued| input.matches_issuance(issued)) =>
            {
                input
            }
            _ => return error(StatusCode::UNPROCESSABLE_ENTITY, "overview_read_invalid"),
        };
        let DatabaseState::Configured(pool) = &self.database else {
            return error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
        };
        match read_overview(pool, org_id, &input).await {
            Ok(response) => HttpResponse::Ok()
                .content_type("application/json")
                .body(response),
            Err(OverviewReadError::MissingScope(scope)) => HttpResponse::NotFound()
                .json(serde_json::json!({"error":format!("{scope} not found")})),
            Err(OverviewReadError::Store(StoreError::InvalidInput)) => {
                error(StatusCode::UNPROCESSABLE_ENTITY, "overview_read_invalid")
            }
            Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "overview_read_failed"),
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
    const PATH: &str = "/internal/orgs/10000000-0000-4000-8000-000000000001/overview-reads";
    const KEY: &[u8] = b"synthetic-overview-read-test-key";
    fn state() -> AppState {
        AppState::new(ServerConfig {
            actor_envelope_key: Some(SigningKey::new(KEY).unwrap()),
            ..ServerConfig::default()
        })
        .unwrap()
    }
    fn body(clock: u64) -> serde_json::Value {
        let now = clock as i64 * 1000;
        let date = time::OffsetDateTime::from_unix_timestamp(now / 1000).unwrap();
        let start = time::Date::from_calendar_date(date.year(), date.month(), 1)
            .unwrap()
            .midnight()
            .assume_utc()
            .unix_timestamp()
            * 1000;
        serde_json::json!({"operation":"budget-overview","nowMs":now,"hostLocalMonthStartMs":start})
    }
    fn signed(body: &[u8], field: &str, now: u64) -> HttpRequest {
        let mut envelope = ActorEnvelope::new(
            ActorIdentity::new("user", "fixture").unwrap(),
            ORG,
            "session",
            1,
            ACTOR_ENVELOPE_AUDIENCE,
            "POST",
            PATH,
            OVERVIEW_READ_ACTION,
            body,
            "request",
            format!("nonce-{field}"),
            now - 1,
            now + 60,
        )
        .unwrap();
        match field {
            "expired" => {
                envelope.issued_at = now - 62;
                envelope.expires_at = now - 1;
            }
            "org" => envelope.organization_id = "other".into(),
            "action" => envelope.action = "cost.read".into(),
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
    async fn signed_clock_validation_is_distinct_from_envelope_authentication() {
        // Body time and envelope issuance must share one captured clock, even
        // when CI crosses a second boundary while exercising invalid inputs.
        let clock = unix_time_seconds().saturating_sub(2);
        let valid = body(clock);
        let now = valid["nowMs"].as_i64().unwrap();
        for patch in [
            serde_json::json!({"nowMs":now-60000}),
            serde_json::json!({"nowMs":now+60000}),
            serde_json::json!({"nowMs":9_007_199_254_740_992i64}),
            serde_json::json!({"nowMs":now as f64+0.5}),
            serde_json::json!({"nowMs":null}),
            serde_json::json!({"hostLocalMonthStartMs":null}),
            serde_json::json!({"hostLocalMonthStartMs":now+1}),
            serde_json::json!({"hostLocalMonthStartMs":now-32*86_400_000}),
            serde_json::json!({"hostLocalMonthStartMs":valid["hostLocalMonthStartMs"].as_i64().unwrap()-15*86_400_000}),
        ] {
            let mut input = valid.clone();
            for (key, value) in patch.as_object().unwrap() {
                input[key] = value.clone();
            }
            let bytes = serde_json::to_vec(&input).unwrap();
            assert_eq!(
                state()
                    .overview_read(&signed(&bytes, "clock", clock), ORG, &bytes)
                    .await
                    .status(),
                StatusCode::UNPROCESSABLE_ENTITY,
                "{patch}"
            );
        }
        let bytes = serde_json::to_vec(&valid).unwrap();
        for field in ["expired", "org", "action"] {
            assert_eq!(
                state()
                    .overview_read(&signed(&bytes, field, clock), ORG, &bytes)
                    .await
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        let request = signed(&bytes, "tampered", clock);
        let mut changed = valid.clone();
        changed["operation"] = serde_json::json!("dashboard-summary");
        assert_eq!(
            state()
                .overview_read(&request, ORG, &serde_json::to_vec(&changed).unwrap())
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let state = state();
        let request = signed(&bytes, "replay", clock);
        assert_eq!(
            state.overview_read(&request, ORG, &bytes).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            state.overview_read(&request, ORG, &bytes).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
}
