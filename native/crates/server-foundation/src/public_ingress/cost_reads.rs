//! Public Cost and Finance GET reads. The existing D1 projection owns the
//! aggregation and response shape; this module owns public identity and org
//! revalidation so selected ingress never forwards these reads to Node.

use super::*;
use crate::{
    member_directory_auth::MemberDirectoryNativeAccess, native_session_auth::NativeIngressIdentity,
};
use actix_web::http::Method;
use futures_util::StreamExt;
use rudder_d1_persistence::cost_reads::{
    CostReadInput, CostReadOperation, Granularity, read_costs,
};
use serde_json::json;
use time::{
    Date, OffsetDateTime, PrimitiveDateTime, UtcOffset, format_description::well_known::Rfc3339,
};

const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
struct Endpoint {
    organization_id: String,
    operation: CostReadOperation,
}

fn endpoint_for_path(path: &str, method: &Method) -> Option<Endpoint> {
    if !matches!(*method, Method::GET | Method::HEAD) {
        return None;
    }
    let path = path.strip_prefix('/')?;
    let path = path.strip_suffix('/').unwrap_or(path);
    let parts = path.split('/').collect::<Vec<_>>();
    if parts.iter().any(|part| part.is_empty()) {
        return None;
    }
    let [api, orgs, raw_org_id, costs, raw_operation] = parts.as_slice() else {
        return None;
    };
    if !api.eq_ignore_ascii_case("api")
        || !orgs.eq_ignore_ascii_case("orgs")
        || !costs.eq_ignore_ascii_case("costs")
    {
        return None;
    }
    let operation = match raw_operation.to_ascii_lowercase().as_str() {
        "summary" => CostReadOperation::Summary,
        "by-agent" => CostReadOperation::ByAgent,
        "trend" => CostReadOperation::Trend,
        "by-agent-model" => CostReadOperation::ByAgentModel,
        "by-provider" => CostReadOperation::ByProvider,
        "by-biller" => CostReadOperation::ByBiller,
        "by-project" => CostReadOperation::ByProject,
        "window-spend" => CostReadOperation::WindowSpend,
        "finance-summary" => CostReadOperation::FinanceSummary,
        "finance-by-biller" => CostReadOperation::FinanceByBiller,
        "finance-by-kind" => CostReadOperation::FinanceByKind,
        _ => return None,
    };
    let organization_id = percent_encoding::percent_decode_str(raw_org_id)
        .decode_utf8()
        .ok()?
        .into_owned();
    Some(Endpoint {
        organization_id,
        operation,
    })
}

pub(super) fn is_reserved_path(path: &str, method: &Method) -> bool {
    endpoint_for_path(path, method).is_some()
}

pub(super) async fn dispatch_alias(
    state: web::Data<IngressState>,
    request: HttpRequest,
    mut payload: web::Payload,
) -> HttpResponse {
    let Some(endpoint) = endpoint_for_path(request.uri().path(), request.method()) else {
        return HttpResponse::NotFound().json(json!({"error":"Cost route not found"}));
    };
    let mut body = Vec::new();
    while let Some(chunk) = payload.next().await {
        let Ok(chunk) = chunk else {
            return HttpResponse::BadRequest().json(json!({"error":"Invalid request body"}));
        };
        if body.len().saturating_add(chunk.len())
            > state
                .foundation
                .config
                .max_request_bytes
                .min(MAX_BODY_BYTES)
        {
            return HttpResponse::PayloadTooLarge()
                .json(json!({"error":"Request body is too large"}));
        }
        body.extend_from_slice(&chunk);
    }
    execute(state, request, web::Bytes::from(body), endpoint).await
}

async fn execute(
    state: web::Data<IngressState>,
    request: HttpRequest,
    body: web::Bytes,
    endpoint: Endpoint,
) -> HttpResponse {
    if let Some(response) = malformed_public_json_response(&request, &body) {
        return response;
    }
    if let Some(response) = private_host_rejection(&state, &request) {
        return response;
    }
    if !matches!(*request.method(), Method::GET | Method::HEAD) {
        return HttpResponse::NotFound().json(json!({"error":"Not found"}));
    }
    if state.config.forwarding_policy.identity(&request).is_err() {
        return state
            .foundation
            .json_error(StatusCode::BAD_REQUEST, "invalid_forwarding_identity");
    }
    let _permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(AdmissionError::QueueFull) => {
            return state
                .foundation
                .json_error(StatusCode::SERVICE_UNAVAILABLE, "request_queue_full");
        }
    };
    if state.config.identity_auth.is_none() {
        return state.foundation.json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "native_identity_unavailable",
        );
    }
    let DatabaseState::Configured(pool) = &state.foundation.database else {
        return state
            .foundation
            .json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
    };
    let identity = match resolve_public_http_identity(&state, &request).await {
        Ok(identity) => identity,
        Err((status, reason)) => return state.foundation.json_error(status, reason),
    };
    if let Some(response) = agent_run_context_mismatch_response(&request, &identity) {
        return response;
    }
    if matches!(&identity, NativeIngressIdentity::None) {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    }
    let Some((actor, session_id)) = agent_core::actor_and_session(&identity) else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };
    let Some(native_auth) = agent_core::native_authorizer(&identity, &actor, &session_id, &state)
    else {
        return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
    };

    // Node ran assertCompanyAccess before parsing query values. Keep that
    // precedence and revalidate against current Rust-owned membership/key
    // state, including the requested organization, before accepting filters.
    let mut authorization = match pool.begin().await {
        Ok(tx) => tx,
        Err(_) => return internal_error(),
    };
    if sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *authorization)
        .await
        .is_err()
    {
        return internal_error();
    }
    match native_auth
        .revalidate(&mut authorization, &endpoint.organization_id)
        .await
    {
        Ok(MemberDirectoryNativeAccess::Authorized) => (),
        Ok(MemberDirectoryNativeAccess::Unauthorized) => {
            return HttpResponse::Unauthorized().json(json!({"error":"Unauthorized"}));
        }
        Ok(MemberDirectoryNativeAccess::Forbidden) => {
            return project_reads::forbidden_response(&identity);
        }
        Err(_) => return internal_error(),
    }
    if authorization.commit().await.is_err() {
        return internal_error();
    }

    let input = match cost_read_input(&request, endpoint.operation) {
        Ok(input) => input,
        Err(message) => return HttpResponse::BadRequest().json(json!({"error":message})),
    };
    match read_costs(pool, &endpoint.organization_id, &input).await {
        Ok(response) => HttpResponse::Ok()
            .content_type("application/json")
            .body(response),
        Err(rudder_d1_persistence::StoreError::NotFound) => {
            HttpResponse::NotFound().json(json!({"error":"Organization not found"}))
        }
        Err(rudder_d1_persistence::StoreError::InvalidInput) => {
            HttpResponse::UnprocessableEntity().json(json!({"error":"Invalid Cost read request"}))
        }
        Err(_) => internal_error(),
    }
}

fn cost_read_input(
    request: &HttpRequest,
    operation: CostReadOperation,
) -> Result<CostReadInput, &'static str> {
    let mut input = CostReadInput {
        operation,
        from_ms: None,
        to_ms: None,
        granularity: Granularity::Day,
        agent_id: None,
        project_id: None,
        limit: None,
        // FinanceEvents is deliberately not reserved here until native ingress
        // can reproduce the legacy connection's timestamp decoding context.
        legacy_date_timezone: None,
    };
    if operation != CostReadOperation::WindowSpend {
        let from = date_query_value(request, "from")?;
        let to = date_query_value(request, "to")?;
        if let (Some(from), Some(to)) = (from, to)
            && from > to
        {
            return Err("'from' date must not be later than 'to' date");
        }
        input.from_ms = from;
        input.to_ms = to;
    }
    if operation == CostReadOperation::Trend {
        let granularity = first_query_value(request, "granularity");
        input.granularity = match granularity.as_deref() {
            None | Some("day") => Granularity::Day,
            Some("hour") => Granularity::Hour,
            Some(_) => return Err("invalid 'granularity' value"),
        };
        input.agent_id = first_query_value(request, "agentId");
        input.project_id = first_query_value(request, "projectId");
    }
    Ok(input)
}

fn query_values(request: &HttpRequest, name: &str) -> Vec<String> {
    url::form_urlencoded::parse(request.query_string().as_bytes())
        .filter(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
        .collect()
}

fn first_query_value(request: &HttpRequest, name: &str) -> Option<String> {
    query_values(request, name)
        .into_iter()
        .next()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn date_query_value(request: &HttpRequest, name: &str) -> Result<Option<i64>, &'static str> {
    let values = query_values(request, name);
    if values.is_empty() {
        return Ok(None);
    }
    // Express's simple query parser returns a string for one key and an array
    // for duplicate keys. `new Date(array)` uses array string coercion.
    let raw = values.join(",");
    if raw.is_empty() {
        return Ok(None);
    }
    parse_js_date_millis(&raw)
        .map(Some)
        .ok_or(if name == "from" {
            "invalid 'from' date"
        } else {
            "invalid 'to' date"
        })
}

fn parse_js_date_millis(raw: &str) -> Option<i64> {
    let parsed = OffsetDateTime::parse(raw, &Rfc3339)
        .ok()
        .or_else(|| {
            OffsetDateTime::parse(raw, &time::format_description::well_known::Iso8601::DEFAULT).ok()
        })
        .or_else(|| parse_local_datetime(raw))
        .or_else(|| {
            let format = time::format_description::parse("[year]-[month]-[day]").ok()?;
            Date::parse(raw, &format)
                .ok()
                .map(|date| date.with_time(time::Time::MIDNIGHT).assume_utc())
        })?;
    let millis = parsed.unix_timestamp_nanos().div_euclid(1_000_000);
    (millis.unsigned_abs() <= 8_640_000_000_000_000).then(|| millis as i64)
}

fn parse_local_datetime(raw: &str) -> Option<OffsetDateTime> {
    for description in [
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond]",
        "[year]-[month]-[day]T[hour]:[minute]:[second]",
        "[year]-[month]-[day]T[hour]:[minute]",
    ] {
        let format = time::format_description::parse(description).ok()?;
        if let Ok(parsed) = PrimitiveDateTime::parse(raw, &format) {
            let offset = UtcOffset::current_local_offset().unwrap_or(UtcOffset::UTC);
            return Some(parsed.assume_offset(offset));
        }
    }
    PrimitiveDateTime::parse(raw, &time::format_description::well_known::Iso8601::DEFAULT)
        .ok()
        .map(|parsed| parsed.assume_utc())
}

fn internal_error() -> HttpResponse {
    HttpResponse::InternalServerError().json(json!({"error":"Internal server error"}))
}
