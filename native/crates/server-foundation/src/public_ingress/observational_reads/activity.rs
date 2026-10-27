use super::*;
use base64::{
    Engine, alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};
use rudder_d1_persistence::{
    StoreError,
    activity_link_reads::{
        ActivityLinkReadError, ActivityLinkReadInput, ActivityLinkReadOperation,
        read_activity_links,
    },
    activity_reads::{ActivityCursor, ActivityReadInput, ActivityReadOperation, read_activity},
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

pub(super) async fn read(
    pool: &sqlx::PgPool,
    org: &str,
    target: Option<&str>,
    identity: &NativeIngressIdentity,
    query: &Query,
    endpoint: Endpoint,
) -> HttpResponse {
    if matches!(
        &endpoint,
        Endpoint::Activity(_) | Endpoint::IssueActivity(_)
    ) {
        let input = match activity_input(query, target) {
            Ok(input) => input,
            Err(response) => return response,
        };
        return match read_activity(pool, org, &input).await {
            Ok(body) => success(body),
            Err(_) => internal_error(),
        };
    }
    let owner = match crate::run_reads::native_run_owner(identity) {
        Ok(owner) => owner,
        Err(response) => return response,
    };
    let mut input = ActivityLinkReadInput {
        operation: ActivityLinkReadOperation::IssueRuns,
        user_id: None,
        issue_id: None,
        run_id: None,
        run_alias: None,
        since: None,
        until: None,
        include: None,
        agent_id: None,
        project_id: None,
        limit: None,
        cursor: None,
        legacy_date_timezone: Some("UTC".into()),
        canonical_locale: None,
    };
    let not_found = match endpoint {
        Endpoint::Ledger(_, raw_user) => {
            let user = match percent_encoding::percent_decode_str(&raw_user).decode_utf8() {
                Ok(user) => user.into_owned(),
                Err(_) => return error(StatusCode::BAD_REQUEST, "Invalid request path"),
            };
            input.operation = ActivityLinkReadOperation::UserLedger;
            input.user_id = Some(if user == "me" {
                owner.unwrap_or("local-board").to_owned()
            } else {
                user
            });
            // Ledger collation only compares UUID IDs at an exact timestamp and
            // source tie; it never compares user content. Pin it independently
            // of the retired Node process's host-locale default.
            input.canonical_locale = Some("en".into());
            input.since = match date(query, "since") {
                Ok(date) => date,
                Err(response) => return response,
            };
            input.until = match date(query, "until") {
                Ok(date) => date,
                Err(response) => return response,
            };
            input.include = match includes(query) {
                Ok(includes) => includes,
                Err(response) => return response,
            };
            input.agent_id = string(query, "agentId");
            input.project_id = string(query, "projectId");
            input.issue_id = string(query, "issueId");
            input.limit = match positive_limit(query) {
                Ok(limit) => limit,
                Err(response) => return response,
            };
            input.cursor = string(query, "cursor");
            "Agent run not found"
        }
        Endpoint::IssueRuns(_) => {
            input.issue_id = target.map(str::to_owned);
            "Issue not found"
        }
        Endpoint::RunIssues(_, heartbeat) => {
            input.operation = ActivityLinkReadOperation::RunIssues;
            input.run_id = target.map(str::to_owned);
            input.run_alias = Some(if heartbeat { "heartbeat" } else { "agent" }.into());
            if heartbeat {
                "Heartbeat run not found"
            } else {
                "Agent run not found"
            }
        }
        _ => unreachable!("only activity endpoints are dispatched here"),
    };
    match read_activity_links(pool, org, owner, &input).await {
        Ok(body) => success(body),
        Err(ActivityLinkReadError::Store(StoreError::NotFound)) => {
            error(StatusCode::NOT_FOUND, not_found)
        }
        Err(ActivityLinkReadError::BadRequest(message)) => error(StatusCode::BAD_REQUEST, &message),
        Err(ActivityLinkReadError::Store(StoreError::InvalidInput)) => error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid ActivityLink read request",
        ),
        Err(_) => internal_error(),
    }
}

#[allow(clippy::result_large_err)]
fn activity_input(query: &Query, issue: Option<&str>) -> Result<ActivityReadInput, HttpResponse> {
    let mut input = ActivityReadInput {
        operation: if issue.is_some() {
            ActivityReadOperation::Issue
        } else {
            ActivityReadOperation::List
        },
        issue_id: issue.map(str::to_owned),
        agent_id: None,
        user_id: None,
        actor_type: None,
        actor_id: None,
        entity_type: None,
        entity_id: None,
        limit: None,
        cursor: None,
        legacy_date_timezone: Some("UTC".into()),
    };
    if issue.is_some() {
        return Ok(input);
    }
    input.agent_id = string(query, "agentId");
    input.user_id = string(query, "userId");
    input.actor_id = string(query, "actorId");
    input.entity_type = string(query, "entityType");
    input.entity_id = string(query, "entityId");
    input.actor_type =
        string(query, "actorType").filter(|v| ["agent", "user", "system"].contains(&v.as_str()));
    let limit = positive_limit(query)?;
    let cursor = string(query, "cursor");
    if limit.is_some() || cursor.is_some() {
        if limit.is_some_and(|v| v > 100.0) {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "'limit' must be between 1 and 100",
            ));
        }
        input.operation = ActivityReadOperation::ListPage;
        input.limit = Some(limit.unwrap_or(30.0) as i64);
        input.cursor = cursor
            .as_deref()
            .map(decode_cursor)
            .transpose()
            .map_err(|_| {
                error(
                    StatusCode::BAD_REQUEST,
                    "Activity cursor is invalid or expired",
                )
            })?;
    }
    Ok(input)
}

fn decode_cursor(raw: &str) -> Result<ActivityCursor, ()> {
    // Same accepted base64 variants as the already-native ledger parser.
    let mut encoded = raw
        .bytes()
        .take_while(|b| *b != b'=')
        .filter_map(|b| match b {
            b'-' => Some(b'+'),
            b'_' => Some(b'/'),
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' => Some(b),
            _ => None,
        })
        .collect::<Vec<_>>();
    if encoded.len() % 4 == 1 {
        encoded.pop();
    }
    let decoder = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    let bytes = decoder.decode(encoded).map_err(|_| ())?;
    let value: Value = serde_json::from_str(&String::from_utf8_lossy(&bytes)).map_err(|_| ())?;
    let id = value.get("id").and_then(Value::as_str).ok_or(())?;
    let created_at = value.get("createdAt").and_then(Value::as_str).ok_or(())?;
    let uuid = uuid::Uuid::parse_str(id).map_err(|_| ())?;
    if id.len() != 36
        || !matches!(uuid.get_version_num(), 1..=5)
        || uuid.get_variant() != uuid::Variant::RFC4122
    {
        return Err(());
    }
    let b = created_at.as_bytes();
    if b.len() != 27
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
        || b[19] != b'.'
        || b[26] != b'Z'
        || b.iter()
            .enumerate()
            .any(|(i, b)| ![4, 7, 10, 13, 16, 19, 26].contains(&i) && !b.is_ascii_digit())
        || OffsetDateTime::parse(created_at, &Rfc3339).is_err()
    {
        return Err(());
    }
    Ok(ActivityCursor {
        id: id.to_owned(),
        created_at: created_at.to_owned(),
    })
}

#[allow(clippy::result_large_err)]
fn includes(query: &Query) -> Result<Option<Vec<String>>, HttpResponse> {
    let Some(values) = query.get("include") else {
        return Ok(None);
    };
    let [value] = values.as_slice() else {
        return Err(error(StatusCode::BAD_REQUEST, "invalid 'include' value"));
    };
    let includes = value
        .split(',')
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if let Some(invalid) = includes
        .iter()
        .find(|v| !["chat", "comments", "issues", "approvals", "activity"].contains(&v.as_str()))
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            &format!("invalid 'include' value: {invalid}"),
        ));
    }
    Ok(Some(includes))
}

#[allow(clippy::result_large_err)]
fn date(query: &Query, key: &str) -> Result<Option<String>, HttpResponse> {
    let Some(values) = query.get(key) else {
        return Ok(None);
    };
    let invalid = || error(StatusCode::BAD_REQUEST, &format!("invalid '{key}' value"));
    let [raw] = values.as_slice() else {
        return Err(invalid());
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(invalid());
    }
    let normalized = raw.to_ascii_lowercase();
    let now = OffsetDateTime::now_utc();
    if normalized == "today" {
        return Ok(Some(
            calendar::start(now, false)
                .ok_or_else(internal_error)?
                .format(&Rfc3339)
                .map_err(|_| internal_error())?,
        ));
    }
    if let Some(unit) = normalized
        .chars()
        .last()
        .filter(|unit| ['h', 'd', 'w'].contains(unit))
    {
        let amount = &normalized[..normalized.len() - 1];
        if !amount.is_empty() && amount.bytes().all(|b| b.is_ascii_digit()) {
            let hours = match unit {
                'd' => 24,
                'w' => 168,
                _ => 1,
            };
            let instant = amount
                .parse::<i64>()
                .ok()
                .and_then(|v| v.checked_mul(hours))
                .and_then(|v| v.checked_mul(3600))
                .and_then(|seconds| now.checked_sub(time::Duration::seconds(seconds)));
            return Ok(Some(
                instant
                    .and_then(|instant| instant.format(&Rfc3339).ok())
                    .unwrap_or_else(|| "Invalid Date".into()),
            ));
        }
    }
    run_reads::js_date_to_iso(raw).map(Some).ok_or_else(invalid)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn activity_paging_rejects_ambiguous_limit_and_invalid_cursor() {
        for query in ["limit=0", "limit=1&limit=2", "limit=101", "cursor=bad"] {
            assert!(
                activity_input(&query_values(query), None).is_err(),
                "{query}"
            );
        }
        let input = activity_input(&query_values("limit=0x10&actorType=unknown"), None).unwrap();
        assert_eq!(input.limit, Some(16));
        assert_eq!(input.actor_type, None);
        assert_eq!(
            activity_input(&query_values("limit=bad"), Some("issue"))
                .unwrap()
                .operation,
            ActivityReadOperation::Issue
        );
    }
}
