use super::*;
use std::collections::HashMap;
pub(super) async fn read(
    pool: &sqlx::PgPool,
    org: &str,
    user: &str,
    id: Option<String>,
    query: &HashMap<String, Value>,
) -> HttpResponse {
    let input = if let Some(id) = id {
        let id = match decode(&id) {
            Ok(id) => id,
            Err(response) => return response,
        };
        if id.len() != 36
            || id.bytes().enumerate().any(|(index, byte)| {
                if [8, 13, 18, 23].contains(&index) {
                    byte != b'-'
                } else {
                    !byte.is_ascii_hexdigit()
                }
            })
        {
            return error(StatusCode::BAD_REQUEST, "Validation error");
        }
        json!({"operation":"savedViewGet","id":id})
    } else {
        let Some(query) = list_query(query) else {
            return error(StatusCode::BAD_REQUEST, "Validation error");
        };
        json!({"operation":"savedViewList","query":query})
    };
    crate::messenger_state::public_read(pool, org, user, input).await
}
fn list_query(query: &HashMap<String, Value>) -> Option<Value> {
    if query
        .keys()
        .any(|key| !["visibility", "limit", "offset", "primaryRailPinned"].contains(&key.as_str()))
    {
        return None;
    }
    let visibility = match query.get("visibility") {
        None => "visible",
        Some(Value::String(value)) if ["visible", "hidden", "all"].contains(&value.as_str()) => {
            value.as_str()
        }
        _ => return None,
    };
    let number = |key: &str, default: f64| match query.get(key) {
        None => Some(default),
        Some(Value::String(raw)) => run_reads::js_number(raw),
        _ => None,
    };
    let limit = number("limit", 50.0)?;
    let offset = number("offset", 0.0)?;
    if !limit.is_finite()
        || limit.fract() != 0.0
        || !(1.0..=100.0).contains(&limit)
        || !offset.is_finite()
        || offset.fract() != 0.0
        || offset < 0.0
        || offset > i64::MAX as f64
    {
        return None;
    }
    let pinned = match query.get("primaryRailPinned") {
        None => None,
        Some(Value::String(value)) if value == "true" => Some(true),
        _ => return None,
    };
    Some(
        json!({"visibility":visibility,"limit":limit as u32,"offset":offset as u64,"primaryRailPinned":pinned}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_strict_saved_view_query_validation_and_coercion() {
        let query = |raw| {
            super::super::query(
                &actix_web::test::TestRequest::get()
                    .uri(&format!("/?{raw}"))
                    .to_http_request(),
            )
        };
        assert_eq!(
            list_query(&query("limit=0x10&offset=")),
            Some(json!({"visibility":"visible","limit":16,"offset":0,"primaryRailPinned":null}))
        );
        for raw in [
            "limit=101",
            "limit=1&limit=2",
            "primaryRailPinned=false",
            "unknown=true",
            "visibility=",
        ] {
            assert!(list_query(&query(raw)).is_none(), "{raw}");
        }
    }
}
