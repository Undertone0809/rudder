use crate::{
    CollectorConfig, CollectorError,
    assertion::{AssertionVerificationContext, verify_product_analytics_assertion},
    contract::{Authorization, AuthorizationMode, installation_header_matches},
    db::{CollectorPools, advance_consent, ingest_batch, reject_invalid_schema_batch},
    maintenance::run_maintenance_with_roles,
    report::{ReportQuery, ReportState, handle_report},
};
use actix_web::{
    App, HttpRequest, HttpResponse, HttpServer, Responder, error::JsonPayloadError,
    http::StatusCode, web,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use time::OffsetDateTime;
use tokio::{task::JoinHandle, time::sleep};

#[derive(Clone)]
pub struct AppState {
    pub config: CollectorConfig,
    pub pools: CollectorPools,
}

pub struct StartedCollector {
    pub server: actix_web::dev::Server,
    pub handle: actix_web::dev::ServerHandle,
    pub pools: CollectorPools,
    pub maintenance_task: JoinHandle<()>,
}

impl StartedCollector {
    pub async fn stop(self) {
        self.handle.stop(true).await;
        self.maintenance_task.abort();
        self.pools.close().await;
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ConsentRequest {
    installation_id: Option<String>,
    analytics_subject: Option<String>,
    pseudonymous_installation_id: Option<String>,
    consent_version: Option<String>,
    consent_epoch: Option<u64>,
    revoked: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConsentResponse {
    installation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    analytics_subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pseudonymous_installation_id: Option<String>,
    consent_version: String,
    consent_epoch: u64,
    revoked: bool,
}

pub async fn start(config: CollectorConfig) -> Result<StartedCollector, CollectorError> {
    let pools = CollectorPools::connect(&config).await?;
    let state = web::Data::new(AppState {
        config: config.clone(),
        pools: pools.clone(),
    });
    let report_state = Arc::new(ReportState {
        pool: pools.reader.clone(),
        secret: config.report_secret.clone(),
        privacy_threshold: config.privacy_threshold,
    });
    let server = match HttpServer::new(move || {
        App::new()
            .app_data(state.clone())
            .app_data(web::JsonConfig::default().limit(crate::contract::MAX_BATCH_BYTES))
            .route("/healthz", web::get().to(health))
            .route("/api/health", web::get().to(health))
            .service(
                web::resource("/api/analytics/v1/events:batch")
                    .app_data(
                        web::JsonConfig::default()
                            .limit(crate::contract::MAX_BATCH_BYTES)
                            .error_handler(json_payload_error),
                    )
                    .route(web::post().to(batch)),
            )
            .route("/api/analytics/v1/consent/revoke", web::post().to(revoke))
            .route(
                "/api/analytics/v1/internal/anonymous/consent",
                web::post().to(anonymous_consent),
            )
            .route(
                "/api/analytics/v1/internal/consent/revoke",
                web::post().to(internal_revoke),
            )
            .route(
                "/api/analytics/v1/internal/consent/sync",
                web::post().to(consent_sync),
            )
            .app_data(web::Data::new(report_state.clone()))
            .route("/api/analytics/v1/report", web::get().to(report))
    })
    .bind(config.socket_addr())
    {
        Ok(server) => server.run(),
        Err(error) => {
            pools.close().await;
            return Err(CollectorError::Configuration(format!(
                "collector_listener_bind_failed: {error}"
            )));
        }
    };
    if let Err(error) = run_maintenance_with_roles(
        &pools.maintenance,
        &pools.ingest,
        config.retention_days,
        config.privacy_threshold,
    )
    .await
    {
        pools.close().await;
        return Err(error);
    }
    let maintenance_pools = pools.clone();
    let interval_ms = config.rollup_interval_ms;
    let maintenance_config = config.clone();
    let maintenance_task = tokio::spawn(async move {
        loop {
            sleep(Duration::from_millis(interval_ms)).await;
            if let Err(error) = run_maintenance_with_roles(
                &maintenance_pools.maintenance,
                &maintenance_pools.ingest,
                maintenance_config.retention_days,
                maintenance_config.privacy_threshold,
            )
            .await
            {
                tracing::error!(error = %error, "product analytics maintenance failed");
            }
        }
    });
    let handle = server.handle();
    Ok(StartedCollector {
        server,
        handle,
        pools,
        maintenance_task,
    })
}

fn json_payload_error(error: JsonPayloadError, _request: &HttpRequest) -> actix_web::Error {
    let (status, error_code) = match &error {
        JsonPayloadError::Overflow { .. } | JsonPayloadError::OverflowKnownLength { .. } => {
            (StatusCode::PAYLOAD_TOO_LARGE, "too_large")
        }
        JsonPayloadError::Deserialize(_) => (StatusCode::BAD_REQUEST, "invalid_schema"),
        _ => return error.into(),
    };
    let response = HttpResponse::build(status).json(serde_json::json!({"errorCode": error_code}));
    actix_web::error::InternalError::from_response(error, response).into()
}

pub async fn run_until_shutdown(config: CollectorConfig) -> Result<(), CollectorError> {
    let started = start(config).await?;
    let StartedCollector {
        server,
        handle,
        pools,
        maintenance_task,
    } = started;
    tokio::pin!(server);
    let result = tokio::select! {
        result = &mut server => result.map_err(|error| CollectorError::Internal(error.to_string())),
        _ = shutdown_signal() => {
            handle.stop(true).await;
            let _ = (&mut server).await;
            Ok(())
        }
    };
    maintenance_task.abort();
    pools.close().await;
    result
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let mut terminate = signal(SignalKind::terminate()).expect("SIGTERM handler");
    let mut interrupt = signal(SignalKind::interrupt()).expect("SIGINT handler");
    tokio::select! { _ = terminate.recv() => {}, _ = interrupt.recv() => {} }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

async fn health(state: web::Data<AppState>) -> impl Responder {
    HttpResponse::Ok().json(serde_json::json!({"ok": true, "service": "product-analytics-collector", "schema": state.config.schema}))
}

async fn batch(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Json<Value>,
) -> Result<HttpResponse, CollectorError> {
    let authorization = authorize(&state.config, &request, None)?;
    let now = OffsetDateTime::now_utc();
    let Some(events) = body.get("events").and_then(Value::as_array) else {
        let response = reject_invalid_schema_batch(&state.pools.ingest, now).await?;
        return Ok(HttpResponse::UnprocessableEntity().json(response));
    };
    let response = ingest_batch(&state.pools.ingest, &authorization, events, now).await?;
    let has_conflict = response
        .rejected
        .iter()
        .any(|ack| ack.error_code == Some(crate::contract::AckErrorCode::Conflict));
    let status = if has_conflict {
        actix_web::http::StatusCode::CONFLICT
    } else if response.accepted == 0 && response.duplicate == 0 && !response.rejected.is_empty() {
        actix_web::http::StatusCode::UNPROCESSABLE_ENTITY
    } else {
        actix_web::http::StatusCode::OK
    };
    Ok(HttpResponse::build(status).json(response))
}

async fn revoke(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Json<ConsentRequest>,
) -> Result<HttpResponse, CollectorError> {
    let authorization = authorize(&state.config, &request, None)?;
    let consent_version = body
        .consent_version
        .as_deref()
        .unwrap_or(&authorization.consent_version);
    let consent_epoch = body
        .consent_epoch
        .unwrap_or(authorization.consent_epoch.saturating_add(1));
    let state = advance_consent(
        &state.pools.ingest,
        &authorization.installation_id,
        (authorization.mode == AuthorizationMode::AccountLinked)
            .then_some(authorization.analytics_subject.as_deref())
            .flatten(),
        consent_version,
        consent_epoch,
        true,
    )
    .await?;
    Ok(HttpResponse::Ok().json(ConsentResponse {
        installation_id: authorization.installation_id,
        analytics_subject: authorization.analytics_subject,
        pseudonymous_installation_id: authorization.pseudonymous_installation_id,
        consent_version: state.consent_version,
        consent_epoch: state.consent_epoch,
        revoked: state.revoked,
    }))
}

async fn anonymous_consent(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Json<ConsentRequest>,
) -> Result<HttpResponse, CollectorError> {
    require_secret(
        request
            .headers()
            .get("x-rudder-telemetry-anonymous-authorization")
            .and_then(|value| value.to_str().ok()),
        state.config.anonymous_authorization.as_deref(),
    )?;
    let installation_id = body
        .installation_id
        .as_deref()
        .ok_or(CollectorError::InvalidRequest("invalid_request"))?;
    let pseudo = body
        .pseudonymous_installation_id
        .as_deref()
        .ok_or(CollectorError::InvalidRequest("invalid_request"))?;
    if pseudo.len() != 64 || !pseudo.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(CollectorError::InvalidRequest("invalid_request"));
    }
    let version = body
        .consent_version
        .as_deref()
        .ok_or(CollectorError::InvalidRequest("invalid_request"))?;
    let epoch = body
        .consent_epoch
        .ok_or(CollectorError::InvalidRequest("invalid_request"))?;
    let revoked = body
        .revoked
        .ok_or(CollectorError::InvalidRequest("invalid_request"))?;
    let result = advance_consent(
        &state.pools.ingest,
        installation_id,
        None,
        version,
        epoch,
        revoked,
    )
    .await?;
    Ok(HttpResponse::Ok().json(ConsentResponse {
        installation_id: installation_id.to_owned(),
        analytics_subject: None,
        pseudonymous_installation_id: Some(pseudo.to_owned()),
        consent_version: result.consent_version,
        consent_epoch: result.consent_epoch,
        revoked: result.revoked,
    }))
}

async fn internal_revoke(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Json<ConsentRequest>,
) -> Result<HttpResponse, CollectorError> {
    require_secret(
        request
            .headers()
            .get("x-rudder-telemetry-revoke-secret")
            .and_then(|value| value.to_str().ok()),
        state.config.revoke_secret.as_deref(),
    )?;
    let installation_id = body
        .installation_id
        .as_deref()
        .ok_or(CollectorError::InvalidRequest("invalid_request"))?;
    let version = body
        .consent_version
        .as_deref()
        .ok_or(CollectorError::InvalidRequest("invalid_request"))?;
    let epoch = body
        .consent_epoch
        .ok_or(CollectorError::InvalidRequest("invalid_request"))?;
    let result = advance_consent(
        &state.pools.ingest,
        installation_id,
        body.analytics_subject.as_deref(),
        version,
        epoch,
        true,
    )
    .await?;
    Ok(HttpResponse::Ok().json(ConsentResponse {
        installation_id: installation_id.to_owned(),
        analytics_subject: body.analytics_subject.clone(),
        pseudonymous_installation_id: None,
        consent_version: result.consent_version,
        consent_epoch: result.consent_epoch,
        revoked: result.revoked,
    }))
}

async fn consent_sync(
    state: web::Data<AppState>,
    request: HttpRequest,
    body: web::Json<ConsentRequest>,
) -> Result<HttpResponse, CollectorError> {
    require_secret(
        request
            .headers()
            .get("x-rudder-telemetry-consent-sync-secret")
            .and_then(|value| value.to_str().ok()),
        state.config.consent_sync_secret.as_deref(),
    )?;
    let installation_id = body
        .installation_id
        .as_deref()
        .ok_or(CollectorError::InvalidRequest("invalid_request"))?;
    let version = body
        .consent_version
        .as_deref()
        .ok_or(CollectorError::InvalidRequest("invalid_request"))?;
    let epoch = body
        .consent_epoch
        .ok_or(CollectorError::InvalidRequest("invalid_request"))?;
    let revoked = body
        .revoked
        .ok_or(CollectorError::InvalidRequest("invalid_request"))?;
    let result = advance_consent(
        &state.pools.ingest,
        installation_id,
        body.analytics_subject.as_deref(),
        version,
        epoch,
        revoked,
    )
    .await?;
    Ok(HttpResponse::Ok().json(ConsentResponse {
        installation_id: installation_id.to_owned(),
        analytics_subject: body.analytics_subject.clone(),
        pseudonymous_installation_id: None,
        consent_version: result.consent_version,
        consent_epoch: result.consent_epoch,
        revoked: result.revoked,
    }))
}

async fn report(
    state: web::Data<Arc<ReportState>>,
    request: HttpRequest,
    query: web::Query<ReportQuery>,
) -> Result<HttpResponse, CollectorError> {
    handle_report(
        state,
        query,
        request
            .headers()
            .get("authorization")
            .and_then(|value| value.to_str().ok()),
    )
    .await
}

fn authorize(
    config: &CollectorConfig,
    request: &HttpRequest,
    expected_subject: Option<Option<&str>>,
) -> Result<Authorization, CollectorError> {
    let bearer = request
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer ").or(Some(value)))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(CollectorError::Unauthorized)?;
    let installation_id = request
        .headers()
        .get("x-rudder-installation-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .ok_or(CollectorError::Unauthorized)?;
    if constant_time_equal(
        bearer,
        config.anonymous_authorization.as_deref().unwrap_or(""),
    ) {
        let consent_version = request
            .headers()
            .get("x-rudder-telemetry-consent-version")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        let pseudo = request
            .headers()
            .get("x-rudder-telemetry-pseudonymous-installation-id")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        let epoch = request
            .headers()
            .get("x-rudder-telemetry-consent-epoch")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        if consent_version.is_empty()
            || consent_version.len() > 80
            || pseudo.len() != 64
            || !pseudo.bytes().all(|byte| byte.is_ascii_hexdigit())
            || epoch < 1
        {
            return Err(CollectorError::Unauthorized);
        }
        return Ok(Authorization {
            installation_id: installation_id.to_owned(),
            mode: AuthorizationMode::Anonymous,
            consent_version: consent_version.to_owned(),
            consent_epoch: epoch,
            analytics_subject: None,
            pseudonymous_installation_id: Some(pseudo.to_owned()),
        });
    }
    let verified = verify_product_analytics_assertion(
        bearer,
        AssertionVerificationContext {
            identity_public_key: &config.identity_public_key,
            expected_key_id: &config.identity_key_id,
            expected_issuer: &config.identity_issuer,
            expected_installation_id: installation_id,
            expected_consent_epoch: None,
            expected_analytics_subject: expected_subject,
            now_ms: None,
        },
    )?;
    let authorization = Authorization {
        installation_id: verified.claims.installation_id,
        mode: if verified.claims.analytics_subject.is_some() {
            AuthorizationMode::AccountLinked
        } else {
            AuthorizationMode::Anonymous
        },
        consent_version: verified.claims.consent_version,
        consent_epoch: verified.claims.consent_epoch,
        analytics_subject: verified.claims.analytics_subject,
        pseudonymous_installation_id: Some(verified.claims.pseudonymous_installation_id),
    };
    if !installation_header_matches(&authorization, Some(installation_id)) {
        return Err(CollectorError::Unauthorized);
    }
    Ok(authorization)
}

fn require_secret(actual: Option<&str>, expected: Option<&str>) -> Result<(), CollectorError> {
    if constant_time_equal(actual.unwrap_or(""), expected.unwrap_or("")) {
        Ok(())
    } else {
        Err(CollectorError::Unauthorized)
    }
}

fn constant_time_equal(left: &str, right: &str) -> bool {
    left.len() == right.len()
        && !left.is_empty()
        && left
            .as_bytes()
            .iter()
            .zip(right.as_bytes())
            .fold(0_u8, |acc, (left, right)| acc | (left ^ right))
            == 0
}

#[cfg(test)]
mod tests {
    use super::json_payload_error;
    use actix_web::{
        App, HttpResponse,
        http::{StatusCode, header::ContentType},
        test, web,
    };
    use serde_json::{Value, json};

    async fn accept_json(_body: web::Json<Value>) -> HttpResponse {
        HttpResponse::Ok().finish()
    }

    #[actix_web::test]
    async fn json_extractor_errors_match_node_collector_responses() {
        let app = test::init_service(
            App::new()
                .app_data(web::JsonConfig::default().limit(crate::contract::MAX_BATCH_BYTES))
                .service(
                    web::resource("/")
                        .app_data(
                            web::JsonConfig::default()
                                .limit(crate::contract::MAX_BATCH_BYTES)
                                .error_handler(json_payload_error),
                        )
                        .route(web::post().to(accept_json)),
                ),
        )
        .await;

        let malformed_request = test::TestRequest::post()
            .uri("/")
            .insert_header(ContentType::json())
            .set_payload("{malformed-json")
            .to_request();
        let malformed_response = test::call_service(&app, malformed_request).await;
        assert_eq!(malformed_response.status(), StatusCode::BAD_REQUEST);
        let malformed_body: Value = test::read_body_json(malformed_response).await;
        assert_eq!(malformed_body, json!({"errorCode": "invalid_schema"}));

        let oversized_request = test::TestRequest::post()
            .uri("/")
            .insert_header(ContentType::json())
            .set_payload(vec![b' '; crate::contract::MAX_BATCH_BYTES + 1])
            .to_request();
        let oversized_response = test::call_service(&app, oversized_request).await;
        assert_eq!(oversized_response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let oversized_body: Value = test::read_body_json(oversized_response).await;
        assert_eq!(oversized_body, json!({"errorCode": "too_large"}));
    }
}
