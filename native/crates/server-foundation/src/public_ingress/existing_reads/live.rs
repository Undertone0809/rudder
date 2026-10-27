use super::*;
use crate::live_run_reads::{LiveRunReadRequest, read_live_runs};
pub(super) async fn read(
    pool: &sqlx::PgPool,
    org: &str,
    issue: Option<String>,
    owner: Option<&str>,
    request: &HttpRequest,
) -> HttpResponse {
    let query = query(request);
    let goal = if issue.is_none() {
        query
            .get("goalId")
            .and_then(Value::as_str)
            .filter(|id| id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))
            .map(str::to_owned)
    } else {
        None
    };
    let min_count = if issue.is_some() {
        0
    } else {
        query
            .get("minCount")
            .map(js_query_text)
            .as_deref()
            .and_then(parse_min_count)
            .unwrap_or(0)
    };
    let input = LiveRunReadRequest {
        issue_id: issue,
        goal_id: goal,
        min_count,
    };
    match read_live_runs(pool, org, &input, owner).await {
        Ok(body) => HttpResponse::Ok()
            .content_type("application/json")
            .body(body),
        Err(_) => internal_error(),
    }
}
fn js_query_text(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(js_query_text)
            .collect::<Vec<_>>()
            .join(","),
        _ => String::new(),
    }
}
fn parse_min_count(raw: &str) -> Option<u32> {
    let raw = raw.trim_start();
    let negative = raw.starts_with('-');
    let raw = raw
        .strip_prefix('-')
        .or_else(|| raw.strip_prefix('+'))
        .unwrap_or(raw);
    let (radix, raw) = if raw.starts_with("0x") || raw.starts_with("0X") {
        (16, &raw[2..])
    } else {
        (10, raw)
    };
    let mut count = 0u32;
    let mut found = false;
    for digit in raw.chars().map_while(|c| c.to_digit(radix)) {
        found = true;
        count = count.saturating_mul(radix).saturating_add(digit).min(20)
    }
    found.then_some(if negative { 0 } else { count })
}
