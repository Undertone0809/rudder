//! Public Run read ingress. All response projections remain owned by the
//! existing Rust Run reader; this module resolves public references and
//! revalidates the native identity before invoking it.

use super::*;
use crate::{
    member_directory_auth::{MemberDirectoryNativeAccess, MemberDirectoryNativeAuth},
    native_session_auth::NativeIngressIdentity,
    run_reads::Surface,
};
use actix_web::http::Method;
use futures_util::StreamExt;
use serde_json::{Value, json};
use sqlx::Row;
use time::{
    Date, OffsetDateTime, PrimitiveDateTime, UtcOffset,
    format_description::well_known::{Rfc2822, Rfc3339},
};

const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RunOperation {
    Detail,
    Events,
    WorkspaceOperations,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum Endpoint {
    List {
        organization_id: String,
        surface: Surface,
    },
    Overview {
        organization_id: String,
    },
    Run {
        reference: String,
        surface: Surface,
        operation: RunOperation,
    },
    Active {
        issue_reference: String,
    },
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
    match parts.as_slice() {
        [api, orgs, raw_org_id, heartbeat_runs]
            if api.eq_ignore_ascii_case("api")
                && orgs.eq_ignore_ascii_case("orgs")
                && heartbeat_runs.eq_ignore_ascii_case("heartbeat-runs") =>
        {
            Some(Endpoint::List {
                organization_id: decode_capture(raw_org_id)?,
                surface: Surface::Heartbeat,
            })
        }
        [api, orgs, raw_org_id, agent_runs]
            if api.eq_ignore_ascii_case("api")
                && orgs.eq_ignore_ascii_case("orgs")
                && agent_runs.eq_ignore_ascii_case("agent-runs") =>
        {
            Some(Endpoint::List {
                organization_id: decode_capture(raw_org_id)?,
                surface: Surface::Agent,
            })
        }
        [api, orgs, raw_org_id, agent_runs, overview]
            if api.eq_ignore_ascii_case("api")
                && orgs.eq_ignore_ascii_case("orgs")
                && agent_runs.eq_ignore_ascii_case("agent-runs")
                && overview.eq_ignore_ascii_case("overview") =>
        {
            Some(Endpoint::Overview {
                organization_id: decode_capture(raw_org_id)?,
            })
        }
        [api, surface, raw_reference]
            if api.eq_ignore_ascii_case("api")
                && (surface.eq_ignore_ascii_case("heartbeat-runs")
                    || surface.eq_ignore_ascii_case("agent-runs")) =>
        {
            Some(Endpoint::Run {
                reference: decode_capture(raw_reference)?,
                surface: run_surface(surface),
                operation: RunOperation::Detail,
            })
        }
        [api, surface, raw_reference, leaf]
            if api.eq_ignore_ascii_case("api")
                && (surface.eq_ignore_ascii_case("heartbeat-runs")
                    || surface.eq_ignore_ascii_case("agent-runs"))
                && (leaf.eq_ignore_ascii_case("events")
                    || leaf.eq_ignore_ascii_case("workspace-operations")) =>
        {
            Some(Endpoint::Run {
                reference: decode_capture(raw_reference)?,
                surface: run_surface(surface),
                operation: if leaf.eq_ignore_ascii_case("events") {
                    RunOperation::Events
                } else {
                    RunOperation::WorkspaceOperations
                },
            })
        }
        [api, issues, raw_issue_reference, active_run]
            if api.eq_ignore_ascii_case("api")
                && issues.eq_ignore_ascii_case("issues")
                && active_run.eq_ignore_ascii_case("active-run") =>
        {
            Some(Endpoint::Active {
                issue_reference: decode_capture(raw_issue_reference)?,
            })
        }
        _ => None,
    }
}

fn run_surface(value: &str) -> Surface {
    if value.eq_ignore_ascii_case("heartbeat-runs") {
        Surface::Heartbeat
    } else {
        Surface::Agent
    }
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
        return HttpResponse::NotFound().json(json!({"error":"Run route not found"}));
    };
    let max_bytes = state
        .foundation
        .config
        .max_request_bytes
        .min(MAX_BODY_BYTES);
    let mut body = Vec::new();
    while let Some(chunk) = payload.next().await {
        let Ok(chunk) = chunk else {
            return HttpResponse::BadRequest().json(json!({"error":"Invalid request body"}));
        };
        if body.len().saturating_add(chunk.len()) > max_bytes {
            return HttpResponse::PayloadTooLarge()
                .json(json!({"error":"Request body is too large"}));
        }
        body.extend_from_slice(&chunk);
    }
    if let Some(response) = malformed_public_json_response(&request, &body) {
        return response;
    }
    execute(state, request, endpoint).await
}

async fn execute(
    state: web::Data<IngressState>,
    request: HttpRequest,
    endpoint: Endpoint,
) -> HttpResponse {
    if let Some(response) = private_host_rejection(&state, &request) {
        return response;
    }
    if state.config.forwarding_policy.identity(&request).is_err() {
        return json_error(StatusCode::BAD_REQUEST, "invalid_forwarding_identity");
    }
    let _permit = match state.foundation.admission.acquire().await {
        Ok(permit) => permit,
        Err(AdmissionError::QueueFull) => {
            return json_error(StatusCode::SERVICE_UNAVAILABLE, "request_queue_full");
        }
    };
    if state.config.identity_auth.is_none() {
        return json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "native_identity_unavailable",
        );
    }
    let DatabaseState::Configured(pool) = &state.foundation.database else {
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "database_disabled");
    };
    let identity = match resolve_public_http_identity(&state, &request).await {
        Ok(identity) => identity,
        Err((status, code)) => return json_error(status, code),
    };
    if let Some(response) = agent_run_context_mismatch_response(&request, &identity) {
        return response;
    }
    if matches!(&identity, NativeIngressIdentity::None) {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    }
    let Some((actor, session_id)) = agent_core::actor_and_session(&identity) else {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    let Some(native_auth) = agent_core::native_authorizer(&identity, &actor, &session_id, &state)
    else {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    };

    match endpoint {
        Endpoint::List {
            organization_id,
            surface,
        } => {
            let query = query_values(request.query_string());
            let Some(input) = list_input(surface, &query) else {
                return invalid_run_request();
            };
            crate::run_reads::read_with_native_auth(
                pool,
                &organization_id,
                &identity,
                &native_auth,
                input,
            )
            .await
        }
        Endpoint::Overview { organization_id } => {
            crate::run_reads::read_with_native_auth(
                pool,
                &organization_id,
                &identity,
                &native_auth,
                json!({"operation":"overview"}),
            )
            .await
        }
        Endpoint::Run {
            reference,
            surface,
            operation,
        } => {
            let not_found = not_found_run_message(surface);
            let (run_id, organization_id) = match resolve_run_reference(
                pool,
                &state,
                &identity,
                &native_auth,
                &reference,
                not_found,
            )
            .await
            {
                Ok(resolution) => resolution,
                Err(response) => return response,
            };
            let query = query_values(request.query_string());
            let redaction = run_read_redaction();
            let input = match operation {
                RunOperation::Detail => json!({
                    "operation":"detail",
                    "surface":surface_name(surface),
                    "runId":run_id,
                    "redaction":redaction,
                }),
                RunOperation::Events => json!({
                    "operation":"events",
                    "runId":run_id,
                    "afterSeq":number_query(&query, "afterSeq", 0.0),
                    "limit":number_query(&query, "limit", 200.0),
                    "redaction":redaction,
                }),
                RunOperation::WorkspaceOperations => json!({
                    "operation":"workspaceOperations",
                    "runId":run_id,
                    "redaction":redaction,
                }),
            };
            crate::run_reads::read_with_native_auth(
                pool,
                &organization_id,
                &identity,
                &native_auth,
                input,
            )
            .await
        }
        Endpoint::Active { issue_reference } => {
            let (issue_id, organization_id) =
                match resolve_issue_reference(pool, &issue_reference).await {
                    Ok(Some(issue)) => issue,
                    Ok(None) => return json_error(StatusCode::NOT_FOUND, "Issue not found"),
                    Err(error) => return db_error(error),
                };
            crate::run_reads::read_with_native_auth(
                pool,
                &organization_id,
                &identity,
                &native_auth,
                json!({
                    "operation":"active",
                    "issueId":issue_id,
                    "redaction":run_read_redaction(),
                }),
            )
            .await
        }
    }
}

fn list_input(surface: Surface, query: &QueryValues) -> Option<Value> {
    let start = first_or_joined(query.get("startDate"));
    let end = first_or_joined(query.get("endDate"));
    let start_date = start.as_deref().and_then(js_date_to_iso);
    let end_date = end.as_deref().and_then(js_date_to_iso);
    let explicit_limit = query
        .get("limit")
        .filter(|values| values.len() > 1 || values.first().is_some_and(|value| !value.is_empty()));
    let limit = if let Some(values) = explicit_limit {
        let parsed = js_parse_int(&values.join(",")).unwrap_or(100.0);
        let parsed = if parsed == 0.0 { 100.0 } else { parsed };
        Some(parsed.clamp(1.0, 1000.0) as u32)
    } else if start_date.is_some() || end_date.is_some() {
        None
    } else {
        Some(100)
    };
    let agent_id = query_value(query, "agentId");
    let agent_id = match agent_id {
        Value::String(value) if !value.is_empty() => Value::String(value),
        Value::Array(values) if !values.is_empty() => Value::Array(values),
        _ => Value::Null,
    };
    let goal_id = match query.get("goalId") {
        Some(values) if values.len() == 1 && valid_legacy_goal_id(&values[0]) => {
            Value::String(values[0].clone())
        }
        _ => Value::Null,
    };
    let limit = limit.map_or(Value::Null, |limit| json!(limit));
    Some(json!({
        "operation":"list",
        "surface":surface_name(surface),
        "agentId":agent_id,
        "goalId":goal_id,
        "startDate":start_date,
        "endDate":end_date,
        "limit":limit,
    }))
}

fn valid_legacy_goal_id(value: &str) -> bool {
    value.len() == 36
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

fn surface_name(surface: Surface) -> &'static str {
    match surface {
        Surface::Heartbeat => "heartbeat",
        Surface::Agent => "agent",
    }
}

fn not_found_run_message(surface: Surface) -> &'static str {
    match surface {
        Surface::Heartbeat => "Heartbeat run not found",
        Surface::Agent => "Agent run not found",
    }
}

type QueryValues = std::collections::HashMap<String, Vec<String>>;

fn query_values(query: &str) -> QueryValues {
    let mut values = QueryValues::new();
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        values
            .entry(key.into_owned())
            .or_default()
            .push(value.into_owned());
    }
    values
}

fn first_or_joined(values: Option<&Vec<String>>) -> Option<String> {
    values.filter(|values| !values.is_empty()).map(|values| {
        if values.len() == 1 {
            values[0].clone()
        } else {
            values.join(",")
        }
    })
}

fn query_value(query: &QueryValues, key: &str) -> Value {
    match query.get(key).map(Vec::as_slice) {
        None | Some([]) => Value::Null,
        Some([one]) => Value::String(one.clone()),
        Some(values) => Value::Array(values.iter().cloned().map(Value::String).collect()),
    }
}

fn number_query(query: &QueryValues, key: &str, default: f64) -> f64 {
    let Some(values) = query.get(key) else {
        return default;
    };
    let raw = values.join(",");
    let Some(parsed) = js_number(&raw) else {
        return default;
    };
    if parsed.is_finite() { parsed } else { default }
}

pub(super) fn js_number(raw: &str) -> Option<f64> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Some(0.0);
    }
    let (negative, unsigned) = if let Some(value) = raw.strip_prefix('-') {
        (true, value)
    } else if let Some(value) = raw.strip_prefix('+') {
        (false, value)
    } else {
        (false, raw)
    };
    let prefix = unsigned.as_bytes().get(..2);
    let has_radix_prefix = prefix.is_some_and(|prefix| {
        prefix.eq_ignore_ascii_case(b"0x")
            || prefix.eq_ignore_ascii_case(b"0b")
            || prefix.eq_ignore_ascii_case(b"0o")
    });
    if (negative || raw.starts_with('+')) && has_radix_prefix {
        return None;
    }
    let radix = if !negative && !raw.starts_with('+') {
        if prefix.is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"0x")) {
            Some(16)
        } else if prefix.is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"0b")) {
            Some(2)
        } else if prefix.is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"0o")) {
            Some(8)
        } else {
            None
        }
    } else {
        None
    };
    let Some(radix) = radix else {
        return raw.parse::<f64>().ok();
    };
    let digits = &unsigned[2..];
    if digits.is_empty() {
        return None;
    }
    let mut number = 0.0;
    for digit in digits.bytes() {
        let digit = match digit {
            b'0'..=b'9' => usize::from(digit - b'0'),
            b'a'..=b'f' => usize::from(digit - b'a' + 10),
            b'A'..=b'F' => usize::from(digit - b'A' + 10),
            _ => return None,
        };
        if digit >= radix {
            return None;
        }
        number = number * radix as f64 + digit as f64;
    }
    Some(number)
}

fn js_parse_int(raw: &str) -> Option<f64> {
    let raw = raw.trim_start();
    let (sign, unsigned) = if let Some(value) = raw.strip_prefix('-') {
        (-1.0, value)
    } else if let Some(value) = raw.strip_prefix('+') {
        (1.0, value)
    } else {
        (1.0, raw)
    };
    let mut number = 0.0;
    let mut found = false;
    for digit in unsigned.bytes() {
        if !digit.is_ascii_digit() {
            break;
        }
        found = true;
        number = number * 10.0 + f64::from(digit - b'0');
    }
    found.then_some(sign * number)
}

pub(super) fn js_date_to_iso(raw: &str) -> Option<String> {
    let parsed = OffsetDateTime::parse(raw, &Rfc3339)
        .ok()
        .or_else(|| {
            OffsetDateTime::parse(raw, &time::format_description::well_known::Iso8601::DEFAULT).ok()
        })
        .or_else(|| OffsetDateTime::parse(raw, &Rfc2822).ok())
        .or_else(|| parse_local_datetime(raw))
        .or_else(|| {
            let format =
                time::format_description::parse_borrowed::<1>("[year]-[month]-[day]").ok()?;
            Date::parse(raw, &format)
                .ok()
                .map(|date| date.with_time(time::Time::MIDNIGHT).assume_utc())
        })
        .or_else(|| parse_local_slash_date(raw))?;
    let millis = parsed.unix_timestamp_nanos().div_euclid(1_000_000);
    if millis.unsigned_abs() > 8_640_000_000_000_000 {
        return None;
    }
    let instant = OffsetDateTime::from_unix_timestamp_nanos(millis * 1_000_000)
        .ok()?
        .to_offset(UtcOffset::UTC);
    Some(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        instant.year(),
        u8::from(instant.month()),
        instant.day(),
        instant.hour(),
        instant.minute(),
        instant.second(),
        instant.millisecond(),
    ))
}

fn parse_local_datetime(raw: &str) -> Option<OffsetDateTime> {
    for description in [
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond]",
        "[year]-[month]-[day]T[hour]:[minute]:[second]",
        "[year]-[month]-[day]T[hour]:[minute]",
        "[year]-[month]-[day] [hour]:[minute]:[second].[subsecond]",
        "[year]-[month]-[day] [hour]:[minute]:[second]",
        "[year]-[month]-[day] [hour]:[minute]",
        "[year]/[month]/[day] [hour]:[minute]:[second]",
    ] {
        let format = time::format_description::parse_borrowed::<1>(description).ok()?;
        if let Ok(parsed) = PrimitiveDateTime::parse(raw, &format) {
            let offset = UtcOffset::current_local_offset().unwrap_or(UtcOffset::UTC);
            return Some(parsed.assume_offset(offset));
        }
    }
    PrimitiveDateTime::parse(raw, &time::format_description::well_known::Iso8601::DEFAULT)
        .ok()
        .map(|parsed| parsed.assume_utc())
}

fn parse_local_slash_date(raw: &str) -> Option<OffsetDateTime> {
    for description in [
        "[year padding:none]/[month padding:none]/[day padding:none]",
        "[month padding:none]/[day padding:none]/[year]",
    ] {
        let format = time::format_description::parse_borrowed::<1>(description).ok()?;
        if let Ok(date) = Date::parse(raw, &format) {
            let offset = UtcOffset::current_local_offset().unwrap_or(UtcOffset::UTC);
            return Some(date.with_time(time::Time::MIDNIGHT).assume_offset(offset));
        }
    }
    None
}

fn run_read_redaction() -> Value {
    let mut user_names = Vec::new();
    for name in ["USER", "LOGNAME", "USERNAME"] {
        if let Ok(value) = std::env::var(name) {
            push_unique(&mut user_names, value);
        }
    }
    let mut home_dirs = Vec::new();
    for name in ["HOME", "USERPROFILE"] {
        if let Ok(value) = std::env::var(name) {
            push_unique(&mut home_dirs, value);
        }
    }
    #[cfg(unix)]
    if let Some((username, home)) = unix_user_metadata() {
        push_unique(&mut user_names, username);
        push_unique(&mut home_dirs, home);
    }
    for name in &user_names {
        push_unique(&mut home_dirs, format!("/Users/{name}"));
        push_unique(&mut home_dirs, format!("/home/{name}"));
        push_unique(&mut home_dirs, format!("C:\\Users\\{name}"));
    }
    json!({
        "userNames":user_names,
        "homeDirs":home_dirs,
        "replacement":"*",
    })
}

fn push_unique(values: &mut Vec<String>, value: String) {
    let value = value.trim().to_owned();
    if !value.is_empty() && !values.contains(&value) {
        values.push(value);
    }
}

#[cfg(unix)]
fn unix_user_metadata() -> Option<(String, String)> {
    // Match os.userInfo().username and os.homedir() without spawning a helper.
    let mut entry = std::mem::MaybeUninit::<libc::passwd>::uninit();
    let mut buffer = vec![0_u8; 16 * 1024];
    let mut result = std::ptr::null_mut();
    // SAFETY: `entry`, `buffer`, and `result` are valid writable pointers for
    // the duration of the call; getpwuid_r initializes `entry` on success.
    let status = unsafe {
        libc::getpwuid_r(
            libc::geteuid(),
            entry.as_mut_ptr(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut result,
        )
    };
    if status != 0 || result.is_null() {
        return None;
    }
    let entry = unsafe { entry.assume_init() };
    let username = if entry.pw_name.is_null() {
        String::new()
    } else {
        // SAFETY: successful getpwuid_r returns a NUL-terminated name that
        // remains backed by `buffer`, which is still alive here.
        unsafe { std::ffi::CStr::from_ptr(entry.pw_name) }
            .to_string_lossy()
            .into_owned()
    };
    let home = if entry.pw_dir.is_null() {
        String::new()
    } else {
        // SAFETY: successful getpwuid_r returns a NUL-terminated home path
        // that remains backed by `buffer`, which is still alive here.
        unsafe { std::ffi::CStr::from_ptr(entry.pw_dir) }
            .to_string_lossy()
            .into_owned()
    };
    Some((username, home))
}

#[allow(clippy::result_large_err)]
pub(super) async fn resolve_run_reference(
    pool: &sqlx::PgPool,
    state: &IngressState,
    identity: &NativeIngressIdentity,
    native_auth: &MemberDirectoryNativeAuth<'_>,
    reference: &str,
    not_found_message: &'static str,
) -> Result<(String, String), HttpResponse> {
    let owner = match crate::run_reads::native_run_owner(identity) {
        Ok(owner) => owner,
        Err(response) => return Err(response),
    };
    let short_prefix = short_run_reference(reference);
    let mut tx = pool.begin().await.map_err(|_| internal_error())?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await
        .map_err(|_| internal_error())?;
    let scope = if short_prefix.is_some() {
        Some(run_alias_organization_scope(state, identity, native_auth, &mut tx).await?)
    } else {
        None
    };
    let rows = if let Some(prefix) = short_prefix {
        let Some(scope) = scope else {
            unreachable!("short run references always resolve an organization scope")
        };
        if scope.as_ref().is_some_and(Vec::is_empty) {
            return Err(not_found(not_found_message));
        }
        let owner_parameter = if scope.is_some() { 3 } else { 2 };
        let visibility = rudder_d1_persistence::run_visibility::predicate("r", owner_parameter);
        if let Some(organization_ids) = scope {
            let sql = format!(
                "SELECT r.id::text AS run_id,r.org_id::text AS org_id FROM heartbeat_runs r WHERE replace(lower(r.id::text),'-','') LIKE $1 AND r.org_id::text=ANY($2::text[]) AND {visibility} ORDER BY r.created_at DESC LIMIT 2"
            );
            sqlx::query(&sql)
                .bind(format!("{prefix}%"))
                .bind(organization_ids)
                .bind(owner)
                .fetch_all(&mut *tx)
                .await
                .map_err(|_| internal_error())?
        } else {
            let sql = format!(
                "SELECT r.id::text AS run_id,r.org_id::text AS org_id FROM heartbeat_runs r WHERE replace(lower(r.id::text),'-','') LIKE $1 AND {visibility} ORDER BY r.created_at DESC LIMIT 2"
            );
            sqlx::query(&sql)
                .bind(format!("{prefix}%"))
                .bind(owner)
                .fetch_all(&mut *tx)
                .await
                .map_err(|_| internal_error())?
        }
    } else {
        let visibility = rudder_d1_persistence::run_visibility::predicate("r", 2);
        let sql = format!(
            "SELECT r.id::text AS run_id,r.org_id::text AS org_id FROM heartbeat_runs r WHERE r.id=$1::uuid AND {visibility} ORDER BY r.created_at DESC LIMIT 2"
        );
        sqlx::query(&sql)
            .bind(reference)
            .bind(owner)
            .fetch_all(&mut *tx)
            .await
            .map_err(|_| internal_error())?
    };
    if let Err(error) = tx.commit().await {
        tracing::warn!(error = %error, "native Run reference transaction failed");
        return Err(internal_error());
    }
    match rows.as_slice() {
        [] => Err(not_found(not_found_message)),
        [row] => Ok((
            row.try_get("run_id").map_err(|_| internal_error())?,
            row.try_get("org_id").map_err(|_| internal_error())?,
        )),
        _ => Err(HttpResponse::Conflict().json(json!({
            "error":"Run ID prefix is ambiguous",
            "details":{
                "runId":short_run_reference(reference).unwrap_or_default(),
                "matches":unique_short_run_ids(rows.iter().filter_map(|row| row.try_get::<String, _>("run_id").ok()).collect()),
            }
        }))),
    }
}

#[allow(clippy::result_large_err)]
async fn run_alias_organization_scope(
    state: &IngressState,
    identity: &NativeIngressIdentity,
    native_auth: &MemberDirectoryNativeAuth<'_>,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
) -> Result<Option<Vec<String>>, HttpResponse> {
    if let Some(org_id) = project_reads::agent_organization_id(identity) {
        match native_auth.revalidate(tx, org_id).await {
            Ok(MemberDirectoryNativeAccess::Authorized) => {
                return Ok(Some(vec![org_id.to_owned()]));
            }
            Ok(MemberDirectoryNativeAccess::Unauthorized) => {
                return Err(unauthorized());
            }
            Ok(MemberDirectoryNativeAccess::Forbidden) => {
                return Err(forbidden(identity));
            }
            Err(error) => {
                tracing::warn!(error = %error, "native Agent Run reference scope failed");
                return Err(internal_error());
            }
        }
    }
    match identity {
        NativeIngressIdentity::LocalImplicit => Ok(None),
        NativeIngressIdentity::Session(_) | NativeIngressIdentity::BoardKey { .. } => {
            organization_reads::organization_list_scope(state, identity, tx)
                .await
                .map_err(|(status, _)| match status {
                    StatusCode::UNAUTHORIZED => unauthorized(),
                    StatusCode::FORBIDDEN => forbidden(identity),
                    _ => internal_error(),
                })
        }
        NativeIngressIdentity::None => Err(unauthorized()),
        NativeIngressIdentity::AgentKey { .. } | NativeIngressIdentity::AgentJwt(_) => {
            Err(forbidden(identity))
        }
    }
}

pub(super) async fn resolve_issue_reference(
    pool: &sqlx::PgPool,
    reference: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
    let identifier = legacy_issue_identifier(reference);
    if let Some(identifier) = identifier {
        let row = sqlx::query(
            "SELECT id::text AS issue_id,org_id::text AS org_id FROM issues WHERE identifier=$1 LIMIT 1",
        )
        .bind(&identifier)
        .fetch_optional(pool)
        .await?;
        if let Some(row) = row {
            return Ok(Some((row.try_get("issue_id")?, row.try_get("org_id")?)));
        }
        if let Some((prefix, issue_number)) = identifier.rsplit_once('-') {
            let issue_number = issue_number.parse::<i64>().ok();
            if let Some(issue_number) = issue_number {
                let row = sqlx::query(
                    "SELECT i.id::text AS issue_id,i.org_id::text AS org_id FROM organization_issue_prefix_aliases a INNER JOIN issues i ON i.org_id=a.org_id AND i.issue_number=$2 WHERE a.prefix=$1 LIMIT 1",
                )
                .bind(prefix)
                .bind(issue_number)
                .fetch_optional(pool)
                .await?;
                if let Some(row) = row {
                    return Ok(Some((row.try_get("issue_id")?, row.try_get("org_id")?)));
                }
            }
        }
        return Ok(None);
    }
    let row = sqlx::query(
        "SELECT id::text AS issue_id,org_id::text AS org_id FROM issues WHERE id=$1::uuid LIMIT 1",
    )
    .bind(reference)
    .fetch_optional(pool)
    .await?;
    row.map(|row| Ok((row.try_get("issue_id")?, row.try_get("org_id")?)))
        .transpose()
}

fn legacy_issue_identifier(reference: &str) -> Option<String> {
    let (prefix, number) = reference.split_once('-')?;
    if prefix.is_empty()
        || !prefix.as_bytes()[0].is_ascii_alphabetic()
        || !prefix.bytes().all(|byte| byte.is_ascii_alphanumeric())
        || number.is_empty()
        || !number.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    Some(reference.to_ascii_uppercase())
}

fn short_run_reference(reference: &str) -> Option<String> {
    let normalized = reference.trim().to_ascii_lowercase();
    if let Some((kind, prefix)) = normalized.split_once('_') {
        return (kind == "run"
            && (8..=32).contains(&prefix.len())
            && prefix.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| prefix.to_owned());
    }
    (!is_uuid_like(&normalized)
        && normalized.len() >= 8
        && normalized.bytes().all(|byte| byte.is_ascii_hexdigit()))
    .then_some(normalized)
}

fn is_uuid_like(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && matches!(bytes[14], b'1'..=b'5')
        && matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
}

fn unique_short_run_ids(run_ids: Vec<String>) -> Vec<String> {
    let normalized = run_ids
        .iter()
        .map(|id| id.replace('-', "").to_ascii_lowercase())
        .collect::<Vec<_>>();
    for length in 12..=32 {
        let candidates = normalized
            .iter()
            .map(|id| id.chars().take(length).collect::<String>())
            .collect::<Vec<_>>();
        if candidates
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            == candidates.len()
        {
            return candidates
                .into_iter()
                .map(|candidate| format!("run_{candidate}"))
                .collect();
        }
    }
    normalized
        .into_iter()
        .map(|id| format!("run_{id}"))
        .collect()
}

fn decode_capture(value: &str) -> Option<String> {
    percent_encoding::percent_decode_str(value)
        .decode_utf8()
        .ok()
        .map(|value| value.into_owned())
}

fn invalid_run_request() -> HttpResponse {
    HttpResponse::UnprocessableEntity().json(json!({"error":"Invalid run read request"}))
}

fn json_error(status: StatusCode, message: &str) -> HttpResponse {
    HttpResponse::build(status)
        .content_type("application/json; charset=utf-8")
        .json(json!({"error":message}))
}

fn db_error(error: impl std::fmt::Display) -> HttpResponse {
    tracing::warn!(error = %error, "native public Run lookup failed");
    json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

fn internal_error() -> HttpResponse {
    json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

fn not_found(message: &str) -> HttpResponse {
    json_error(StatusCode::NOT_FOUND, message)
}

fn unauthorized() -> HttpResponse {
    json_error(StatusCode::UNAUTHORIZED, "Unauthorized")
}

fn forbidden(identity: &NativeIngressIdentity) -> HttpResponse {
    let message = match identity {
        NativeIngressIdentity::AgentKey { .. } | NativeIngressIdentity::AgentJwt(_) => {
            "Agent key cannot access another organization"
        }
        _ => "User does not have access to this organization",
    };
    json_error(StatusCode::FORBIDDEN, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserves_only_the_ten_run_get_head_routes() {
        let mut paths = vec![
            "/api/orgs/org/heartbeat-runs".to_owned(),
            "/api/orgs/org/agent-runs".to_owned(),
            "/api/orgs/org/agent-runs/overview".to_owned(),
        ];
        for surface in ["heartbeat-runs", "agent-runs"] {
            paths.extend([
                format!("/api/{surface}/run-id"),
                format!("/api/{surface}/run-id/events"),
                format!("/api/{surface}/run-id/workspace-operations"),
            ]);
        }
        paths.push("/api/issues/ISS-1/active-run".to_owned());
        assert_eq!(paths.len(), 10);
        for path in paths {
            assert!(is_reserved_path(&path, &Method::GET), "{path}");
            assert!(is_reserved_path(&path, &Method::HEAD), "{path}");
        }
        for path in [
            "/api/orgs/org/live-runs",
            "/api/issues/ISS-1/live-runs",
            "/api/agent-runs/run-id/log",
            "/api/agent-runs/run-id/cancel",
            "/api/agent-runs/run-id/retry",
        ] {
            assert!(!is_reserved_path(path, &Method::GET), "{path}");
            assert!(!is_reserved_path(path, &Method::POST), "{path}");
        }
    }

    #[test]
    fn list_filters_keep_legacy_date_and_limit_rules() {
        let query = query_values(
            "startDate=2024-03-01T00%3A00%3A00%2B08%3A00&endDate=bad&limit=0&agentId=a&goalId=12345678-1234-1234-1234-123456789012",
        );
        let input = list_input(Surface::Agent, &query).unwrap();
        assert_eq!(input["startDate"], "2024-02-29T16:00:00.000Z");
        assert!(input["endDate"].is_null());
        assert_eq!(input["limit"], 100);
        assert_eq!(input["agentId"], "a");
        assert_eq!(input["goalId"], "12345678-1234-1234-1234-123456789012");
        let date_only = query_values("startDate=2024-02-29");
        assert!(list_input(Surface::Heartbeat, &date_only).unwrap()["limit"].is_null());
    }

    #[test]
    fn date_filters_keep_common_javascript_date_forms() {
        assert!(js_date_to_iso("2024-04-05 12:30:00").is_some());
        assert!(js_date_to_iso("2024/4/5").is_some());
        assert!(js_date_to_iso("4/5/2024").is_some());
        assert_eq!(
            js_date_to_iso("Fri, 05 Apr 2024 12:30:00 +0800").as_deref(),
            Some("2024-04-05T04:30:00.000Z")
        );
    }

    #[test]
    fn reference_helpers_preserve_typed_and_legacy_prefixes() {
        assert_eq!(
            short_run_reference(" RUN_AABBCCDD "),
            Some("aabbccdd".to_owned())
        );
        assert_eq!(short_run_reference("aabbccdd"), Some("aabbccdd".to_owned()));
        assert_eq!(
            short_run_reference("aabbccdd-0000-4000-8000-000000000001"),
            None
        );
        assert_eq!(legacy_issue_identifier("old-14"), Some("OLD-14".to_owned()));
        assert_eq!(legacy_issue_identifier("bad-prefix"), None);
    }

    #[test]
    fn event_numbers_match_javascript_radix_prefixes_case_insensitively() {
        let query = query_values("afterSeq=0X10&limit=0B10");
        assert_eq!(number_query(&query, "afterSeq", 0.0), 16.0);
        assert_eq!(number_query(&query, "limit", 200.0), 2.0);
        assert_eq!(
            number_query(&query_values("afterSeq=%2B0x10"), "afterSeq", 7.0),
            7.0
        );
        assert_eq!(
            number_query(&query_values("afterSeq=-0b10"), "afterSeq", 7.0),
            7.0
        );
    }
}
