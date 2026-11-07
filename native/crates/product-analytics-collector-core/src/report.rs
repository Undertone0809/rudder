use crate::CollectorError;
use actix_web::{HttpResponse, web};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};
use time::{
    Date, Duration, OffsetDateTime, Time, UtcOffset, format_description::well_known::Rfc3339,
};

const DAILY_ROLLUPS: &str = "rudder_analytics.product_analytics_collector_daily_rollups";
const PRIVACY_AGGREGATES: &str = "rudder_analytics.product_analytics_collector_privacy_aggregates";
const QUALITY: &str = "rudder_analytics.product_analytics_collector_quality_counters";

#[derive(Clone, Debug, Deserialize)]
pub struct ReportQuery {
    pub from: Option<String>,
    pub to: Option<String>,
}

#[derive(Clone)]
pub struct ReportState {
    pub pool: PgPool,
    pub secret: Option<String>,
    pub privacy_threshold: i64,
}

#[derive(Clone)]
struct Range {
    from: Date,
    to: Date,
}

#[derive(Clone)]
struct Rollup {
    day: Date,
    installation_id: String,
    event_name: String,
    origin: String,
    dimensions: Value,
    event_count: i64,
    first_occurred_at: OffsetDateTime,
    last_occurred_at: OffsetDateTime,
}

pub async fn handle_report(
    state: web::Data<Arc<ReportState>>,
    query: web::Query<ReportQuery>,
    authorization: Option<&str>,
) -> Result<HttpResponse, CollectorError> {
    let token = authorization
        .and_then(|value| value.strip_prefix("Bearer ").or(Some(value)))
        .map(str::trim);
    if !constant_time_equal(token.unwrap_or(""), state.secret.as_deref().unwrap_or("")) {
        return Ok(HttpResponse::Unauthorized().json(json!({"errorCode": "unauthorized"})));
    }
    let range = match parse_range(query.into_inner()) {
        Ok(range) => range,
        Err(_) => {
            return Ok(
                HttpResponse::UnprocessableEntity().json(json!({"errorCode": "invalid_window"}))
            );
        }
    };
    let rollups = load_rollups(&state.pool, &range).await?;
    let observations = load_creation_observations(&state.pool).await?;
    let quality = load_quality(&state.pool, &range).await?;
    let aggregates = load_aggregates(&state.pool, &range).await?;
    let production = rollups
        .iter()
        .filter(|row| {
            row.dimensions.get("environment").and_then(Value::as_str) == Some("production")
        })
        .cloned()
        .collect::<Vec<_>>();
    let report_production = production
        .iter()
        .filter(|row| row.first_occurred_at.date() <= range.to)
        .cloned()
        .collect::<Vec<_>>();
    let retention_to = range.to + Duration::days(35);
    let retention_production = production
        .iter()
        .filter(|row| row.last_occurred_at.date() <= retention_to)
        .cloned()
        .collect::<Vec<_>>();
    let meaningful = [
        "human_work_started",
        "review_decision_recorded",
        "work_loop_completed",
    ];
    let productive = ["output_ready", "work_loop_completed"];
    let metric =
        |days: i64, names: &[&str]| active_installations(&report_production, &range, days, names);
    let loops = aggregates
        .iter()
        .filter(|row| row.metric_name == "weekly_completed_work_loops")
        .map(|row| row.metric_value)
        .sum::<i64>();
    let daily_creation = daily_creation(
        &report_production,
        &range,
        state.privacy_threshold,
        &observations,
    );
    let retention = retention(
        &retention_production,
        &aggregates,
        &range,
        state.privacy_threshold,
    );
    let privacy_rows = aggregates
        .iter()
        .map(|row| {
            json!({
                "metricName": row.metric_name,
                "metricValue": row.metric_value,
                "contributingInstallations": row.contributing_installations,
                "privacyThreshold": row.privacy_threshold,
            })
        })
        .collect::<Vec<_>>();
    Ok(HttpResponse::Ok().json(json!({
        "window": {"from": date_start(range.from), "to": date_end(range.to), "timezone": "UTC"},
        "metrics": {
            "meaningfulActiveInstallations1d": metric(1, &meaningful),
            "meaningfulActiveInstallations7d": metric(7, &meaningful),
            "productiveInstallations7d": metric(7, &productive),
            "weeklyCompletedWorkLoops": loops,
            "meaningfulDau": metric(1, &meaningful),
            "productiveWau": metric(7, &productive),
        },
        "quality": {
            "receivedBatchCount": quality.received,
            "acceptedEventCount": quality.accepted,
            "lateEventCount": quality.late,
            "duplicateEventCount": quality.duplicate,
            "rejectedEventCount": quality.rejected,
            "aggregateRows": aggregates.len(),
        },
        "privacy": {"aggregateRows": privacy_rows},
        "coverage": {
            "accountLinkedEventCount": report_production.iter().filter(|row| row.dimensions.get("analytics_mode").and_then(Value::as_str) == Some("account_linked")).map(|row| row.event_count).sum::<i64>(),
            "anonymousEventCount": report_production.iter().filter(|row| row.dimensions.get("analytics_mode").and_then(Value::as_str) != Some("account_linked")).map(|row| row.event_count).sum::<i64>(),
        },
        "dailyCreation": daily_creation,
        "retention": retention,
    })))
}

#[derive(Clone)]
struct Aggregate {
    metric_name: String,
    metric_value: i64,
    contributing_installations: i64,
    privacy_threshold: i64,
    dimensions: Value,
}

struct Quality {
    received: i64,
    accepted: i64,
    late: i64,
    duplicate: i64,
    rejected: i64,
}

fn active_installations(rows: &[Rollup], range: &Range, days: i64, names: &[&str]) -> usize {
    let report_start = range.from.with_time(Time::MIDNIGHT).assume_utc();
    let report_end = date_end_time(range.to);
    let trailing_start = report_end - Duration::days(days);
    let cutoff = trailing_start.max(report_start);
    rows.iter()
        .filter(|row| {
            row.last_occurred_at >= cutoff
                && row.last_occurred_at <= report_end
                && names.contains(&row.event_name.as_str())
        })
        .map(|row| row.installation_id.as_str())
        .collect::<BTreeSet<_>>()
        .len()
}

async fn load_rollups(pool: &PgPool, range: &Range) -> Result<Vec<Rollup>, CollectorError> {
    let retention_to = range.to + Duration::days(35);
    let rows = sqlx::query(&format!("SELECT day::text AS day, installation_id, event_name, origin, dimensions::text AS dimensions, event_count, to_char(first_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS first_occurred_at, to_char(last_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS last_occurred_at FROM {DAILY_ROLLUPS} WHERE day >= $1::date AND day <= $2::date"))
        .bind(range.from.to_string()).bind(retention_to.to_string()).fetch_all(pool).await?;
    rows.into_iter()
        .map(|row| {
            Ok(Rollup {
                day: parse_date(&row.try_get::<String, _>("day")?)?,
                installation_id: row.try_get("installation_id")?,
                event_name: row.try_get("event_name")?,
                origin: row.try_get("origin")?,
                dimensions: serde_json::from_str(&row.try_get::<String, _>("dimensions")?)
                    .map_err(|error| CollectorError::Internal(error.to_string()))?,
                event_count: row.try_get::<i32, _>("event_count")? as i64,
                first_occurred_at: parse_time(&row.try_get::<String, _>("first_occurred_at")?)?,
                last_occurred_at: parse_time(&row.try_get::<String, _>("last_occurred_at")?)?,
            })
        })
        .collect()
}

async fn load_creation_observations(
    pool: &PgPool,
) -> Result<BTreeMap<String, Date>, CollectorError> {
    let rows = sqlx::query(&format!("SELECT event_name, min(day)::text AS first_observed_day FROM {DAILY_ROLLUPS} WHERE event_name IN ('issue_created','chat_created') AND dimensions->>'environment'='production' GROUP BY event_name"))
        .fetch_all(pool).await?;
    rows.into_iter()
        .map(|row| {
            Ok((
                row.try_get("event_name")?,
                parse_date(&row.try_get::<String, _>("first_observed_day")?)?,
            ))
        })
        .collect()
}

async fn load_quality(pool: &PgPool, range: &Range) -> Result<Quality, CollectorError> {
    let row = sqlx::query(&format!("SELECT coalesce(sum(received_batches),0)::bigint AS received, coalesce(sum(accepted_events),0)::bigint AS accepted, coalesce(sum(late_events),0)::bigint AS late, coalesce(sum(duplicate_events),0)::bigint AS duplicate, coalesce(sum(rejected_events),0)::bigint AS rejected FROM {QUALITY} WHERE day >= $1::date AND day <= $2::date"))
        .bind(range.from.to_string()).bind(range.to.to_string()).fetch_one(pool).await?;
    Ok(Quality {
        received: row.try_get("received")?,
        accepted: row.try_get("accepted")?,
        late: row.try_get("late")?,
        duplicate: row.try_get("duplicate")?,
        rejected: row.try_get("rejected")?,
    })
}

async fn load_aggregates(pool: &PgPool, range: &Range) -> Result<Vec<Aggregate>, CollectorError> {
    let rows = sqlx::query(&format!("SELECT metric_name, metric_value::bigint AS metric_value, contributing_installations::bigint AS contributing_installations, privacy_threshold::bigint AS privacy_threshold, dimension_values::text AS dimensions FROM {PRIVACY_AGGREGATES} WHERE day >= $1::date AND day <= $2::date"))
        .bind(range.from.to_string()).bind(range.to.to_string()).fetch_all(pool).await?;
    rows.into_iter()
        .map(|row| {
            Ok(Aggregate {
                metric_name: row.try_get("metric_name")?,
                metric_value: row.try_get("metric_value")?,
                contributing_installations: row.try_get("contributing_installations")?,
                privacy_threshold: row.try_get("privacy_threshold")?,
                dimensions: serde_json::from_str(&row.try_get::<String, _>("dimensions")?)
                    .map_err(|error| CollectorError::Internal(error.to_string()))?,
            })
        })
        .collect()
}

fn daily_creation(
    rows: &[Rollup],
    range: &Range,
    threshold: i64,
    observations: &BTreeMap<String, Date>,
) -> Value {
    let mut days = Vec::new();
    let mut cursor = range.from;
    while cursor <= range.to {
        let values = [
            ("issue_created", "issuesCreated"),
            ("chat_created", "chatsCreated"),
        ]
        .into_iter()
        .map(|(event_name, field)| {
            let group = rows
                .iter()
                .filter(|row| {
                    row.day == cursor && row.event_name == event_name && row.origin == "human"
                })
                .fold((0_i64, BTreeSet::new()), |mut acc, row| {
                    acc.0 += row.event_count;
                    acc.1.insert(row.installation_id.clone());
                    acc
                });
            let value = match observations.get(event_name) {
                None => json!({"count": null, "status": "not_observed"}),
                Some(first) if cursor < *first => json!({"count": null, "status": "not_observed"}),
                Some(_) if group.1.is_empty() => json!({"count": 0, "status": "available"}),
                Some(_) if (group.1.len() as i64) < threshold => {
                    json!({"count": null, "status": "threshold_blocked"})
                }
                Some(_) => json!({"count": group.0, "status": "available"}),
            };
            (field, value)
        })
        .collect::<Vec<_>>();
        let mut day = serde_json::Map::new();
        day.insert("day".into(), json!(cursor.to_string()));
        day.insert(values[0].0.to_owned(), values[0].1.clone());
        day.insert(values[1].0.to_owned(), values[1].1.clone());
        days.push(Value::Object(day));
        cursor = cursor.next_day().unwrap_or(cursor);
    }
    json!({"privacyThreshold": threshold, "days": days})
}

fn retention(
    rows: &[Rollup],
    aggregates: &[Aggregate],
    range: &Range,
    threshold: i64,
) -> Vec<Value> {
    let mut first_seen = BTreeMap::<String, OffsetDateTime>::new();
    let mut meaningful_events = BTreeMap::<String, Vec<OffsetDateTime>>::new();
    for row in rows {
        first_seen
            .entry(row.installation_id.clone())
            .and_modify(|seen_at| {
                if row.first_occurred_at < *seen_at {
                    *seen_at = row.first_occurred_at
                }
            })
            .or_insert(row.first_occurred_at);
        if matches!(
            row.event_name.as_str(),
            "human_work_started" | "review_decision_recorded" | "work_loop_completed"
        ) {
            meaningful_events
                .entry(row.installation_id.clone())
                .or_default()
                .push(row.last_occurred_at);
        }
    }
    let mut loop_retention = BTreeMap::<String, (i64, i64)>::new();
    for aggregate in aggregates
        .iter()
        .filter(|row| row.metric_name == "work_loop_retention")
    {
        let Some(cohort) = aggregate
            .dimensions
            .get("cohort_day")
            .and_then(Value::as_str)
        else {
            continue;
        };
        let Some(window) = aggregate.dimensions.get("window").and_then(Value::as_str) else {
            continue;
        };
        if !matches!(window, "w1" | "w4") {
            continue;
        }
        let values = loop_retention.entry(cohort.to_owned()).or_default();
        match window {
            "w1" => values.0 = aggregate.metric_value,
            "w4" => values.1 = aggregate.metric_value,
            _ => unreachable!(),
        }
    }
    #[derive(Default)]
    struct Cohort {
        eligible: BTreeSet<String>,
        meaningful_w1: i64,
    }
    let mut cohorts = BTreeMap::<Date, Cohort>::new();
    let report_start = range.from.with_time(Time::MIDNIGHT).assume_utc();
    let report_end = date_end_time(range.to);
    for (installation, first_seen_at) in first_seen {
        let cohort_day = first_seen_at.date();
        if cohort_day < range.from {
            continue;
        }
        let entry = cohorts.entry(cohort_day).or_default();
        if first_seen_at >= report_start && first_seen_at <= report_end {
            entry.eligible.insert(installation.clone());
            let meaningful_start = first_seen_at + Duration::days(7);
            let meaningful_end = first_seen_at + Duration::days(14);
            if meaningful_events.get(&installation).is_some_and(|dates| {
                dates
                    .iter()
                    .any(|date| *date >= meaningful_start && *date < meaningful_end)
            }) {
                entry.meaningful_w1 += 1;
            }
        }
    }
    cohorts
        .into_iter()
        .map(|(cohort_day, cohort)| {
            let cohort_name = cohort_day.to_string();
            let eligible_installations = cohort.eligible.len();
            if (eligible_installations as i64) < threshold {
                json!({
                    "cohortDay": cohort_name,
                    "eligibleInstallations": null,
                    "meaningfulW1": null,
                    "loopW1": null,
                    "loopW4": null,
                    "suppressed": true
                })
            } else {
                let (loop_w1, loop_w4) = loop_retention
                    .get(&cohort_name)
                    .copied()
                    .unwrap_or_default();
                json!({
                    "cohortDay": cohort_name,
                    "eligibleInstallations": eligible_installations,
                    "meaningfulW1": cohort.meaningful_w1,
                    "loopW1": loop_w1,
                    "loopW4": loop_w4,
                    "suppressed": false
                })
            }
        })
        .collect()
}

fn parse_range(query: ReportQuery) -> Result<Range, CollectorError> {
    let to = query
        .to
        .as_deref()
        .map(parse_time)
        .transpose()?
        .map(|value| value.to_offset(UtcOffset::UTC).date())
        .unwrap_or_else(|| OffsetDateTime::now_utc().date());
    let from = query
        .from
        .as_deref()
        .map(parse_time)
        .transpose()?
        .map(|value| value.to_offset(UtcOffset::UTC).date())
        .unwrap_or_else(|| to - Duration::days(6));
    if from > to {
        return Err(CollectorError::InvalidRequest("invalid_window"));
    }
    Ok(Range { from, to })
}

fn parse_time(value: &str) -> Result<OffsetDateTime, CollectorError> {
    OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|_| CollectorError::InvalidRequest("invalid_window"))
}
fn parse_date(value: &str) -> Result<Date, CollectorError> {
    Date::parse(
        value,
        &time::format_description::parse_borrowed::<2>("[year]-[month]-[day]").unwrap(),
    )
    .map_err(|_| CollectorError::Internal("invalid database date".into()))
}
fn date_start(value: Date) -> String {
    value
        .with_time(Time::MIDNIGHT)
        .assume_offset(UtcOffset::UTC)
        .format(&Rfc3339)
        .unwrap_or_default()
}
fn date_end(value: Date) -> String {
    date_end_time(value)
        .replace_nanosecond(999_000_000)
        .unwrap()
        .format(&Rfc3339)
        .unwrap_or_default()
}
fn date_end_time(value: Date) -> OffsetDateTime {
    value
        .with_time(Time::MIDNIGHT)
        .assume_offset(UtcOffset::UTC)
        .replace_time(Time::from_hms_nano(23, 59, 59, 999_999_000).unwrap())
}
fn constant_time_equal(left: &str, right: &str) -> bool {
    left.len() == right.len()
        && left
            .as_bytes()
            .iter()
            .zip(right.as_bytes())
            .fold(0_u8, |acc, (left, right)| acc | (left ^ right))
            == 0
        && !left.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(value: &str) -> Date {
        parse_date(value).unwrap()
    }

    fn at(value: &str) -> OffsetDateTime {
        parse_time(value).unwrap()
    }

    #[test]
    fn report_window_end_matches_node_precision_without_changing_utc_boundary() {
        let day = date("2026-08-10");

        assert_eq!(date_end(day), "2026-08-10T23:59:59.999Z");
        assert_eq!(date_end_time(day).nanosecond(), 999_999_000);
    }

    fn rollup(installation_id: &str, event_name: &str, first: &str, last: &str) -> Rollup {
        let first_occurred_at = at(first);
        Rollup {
            day: first_occurred_at.date(),
            installation_id: installation_id.to_owned(),
            event_name: event_name.to_owned(),
            origin: "human".to_owned(),
            dimensions: json!({"environment": "production"}),
            event_count: 1,
            first_occurred_at,
            last_occurred_at: at(last),
        }
    }

    fn aggregate(cohort_day: &str, window: &str, metric_value: i64) -> Aggregate {
        Aggregate {
            metric_name: "work_loop_retention".to_owned(),
            metric_value,
            contributing_installations: 2,
            privacy_threshold: 2,
            dimensions: json!({"cohort_day": cohort_day, "window": window}),
        }
    }

    #[test]
    fn activity_windows_use_elapsed_time_without_adding_a_calendar_day() {
        let range = Range {
            from: date("2026-08-01"),
            to: date("2026-08-10"),
        };
        let rows = vec![
            rollup(
                "today",
                "human_work_started",
                "2026-08-10T08:00:00Z",
                "2026-08-10T08:00:00Z",
            ),
            rollup(
                "yesterday-before-cutoff",
                "human_work_started",
                "2026-08-09T23:59:59.998Z",
                "2026-08-09T23:59:59.998Z",
            ),
            rollup(
                "one-day-boundary",
                "human_work_started",
                "2026-08-09T23:59:59.999999Z",
                "2026-08-09T23:59:59.999999Z",
            ),
            rollup(
                "within-seven-days",
                "work_loop_completed",
                "2026-08-04T00:00:00Z",
                "2026-08-04T00:00:00Z",
            ),
            rollup(
                "outside-seven-days",
                "human_work_started",
                "2026-08-03T23:59:59.999998Z",
                "2026-08-03T23:59:59.999998Z",
            ),
            rollup(
                "today",
                "review_decision_recorded",
                "2026-08-10T09:00:00Z",
                "2026-08-10T09:00:00Z",
            ),
        ];

        assert_eq!(
            active_installations(
                &rows,
                &range,
                1,
                &["human_work_started", "review_decision_recorded"],
            ),
            2
        );
        assert_eq!(
            active_installations(
                &rows,
                &range,
                7,
                &["human_work_started", "work_loop_completed"],
            ),
            4
        );
    }

    #[test]
    fn retention_matches_node_values_and_response_shape_for_unobserved_windows() {
        let rows = vec![
            rollup(
                "old-a",
                "organization_created",
                "2026-07-01T10:00:00Z",
                "2026-07-01T10:00:00Z",
            ),
            rollup(
                "old-b",
                "organization_created",
                "2026-07-01T15:00:00Z",
                "2026-07-01T15:00:00Z",
            ),
            rollup(
                "old-a",
                "human_work_started",
                "2026-07-08T10:00:00Z",
                "2026-07-08T10:00:00Z",
            ),
            rollup(
                "new-a",
                "organization_created",
                "2026-08-01T10:00:00Z",
                "2026-08-01T10:00:00Z",
            ),
            rollup(
                "new-b",
                "organization_created",
                "2026-08-01T15:00:00.123456Z",
                "2026-08-01T15:00:00.123456Z",
            ),
            rollup(
                "new-a",
                "human_work_started",
                "2026-08-08T10:00:00Z",
                "2026-08-08T10:00:00Z",
            ),
            rollup(
                "new-b",
                "human_work_started",
                "2026-08-08T15:00:00.123333Z",
                "2026-08-08T15:00:00.123333Z",
            ),
            rollup(
                "recent-a",
                "organization_created",
                "2026-08-18T10:00:00Z",
                "2026-08-18T10:00:00Z",
            ),
            rollup(
                "recent-b",
                "organization_created",
                "2026-08-18T15:00:00Z",
                "2026-08-18T15:00:00Z",
            ),
            rollup(
                "below-threshold",
                "organization_created",
                "2026-08-19T10:00:00Z",
                "2026-08-19T10:00:00Z",
            ),
            rollup(
                "future-a",
                "organization_created",
                "2026-08-22T10:00:00Z",
                "2026-08-22T10:00:00Z",
            ),
            rollup(
                "future-b",
                "organization_created",
                "2026-08-22T15:00:00Z",
                "2026-08-22T15:00:00Z",
            ),
        ];
        let aggregates = vec![
            aggregate("2026-07-01", "w1", 1),
            aggregate("2026-07-01", "w4", 1),
            aggregate("2026-08-01", "w1", 2),
            aggregate("2026-08-01", "w4", 0),
            aggregate("2026-08-18", "w1", 0),
            aggregate("2026-08-18", "w4", 0),
        ];
        let cohorts = retention(
            &rows,
            &aggregates,
            &Range {
                from: date("2026-07-01"),
                to: date("2026-08-20"),
            },
            2,
        );
        let cohort = |day| cohorts.iter().find(|row| row["cohortDay"] == day).unwrap();
        let retention_keys = BTreeSet::from([
            "cohortDay",
            "eligibleInstallations",
            "meaningfulW1",
            "loopW1",
            "loopW4",
            "suppressed",
        ]);
        let assert_retention_keys = |row: &Value| {
            let actual = row
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<BTreeSet<_>>();
            assert_eq!(actual, retention_keys);
        };

        let old = cohort("2026-07-01");
        assert_eq!(old["meaningfulW1"], 1, "cohort={old}");
        assert_eq!(old["loopW4"], 1);
        assert_retention_keys(old);

        let recent = cohort("2026-08-01");
        assert_eq!(recent["meaningfulW1"], 1);
        assert_eq!(recent["loopW1"], 2);
        assert_eq!(recent["loopW4"], 0);
        assert_retention_keys(recent);

        let unobserved = cohort("2026-08-18");
        assert_eq!(unobserved["meaningfulW1"], 0);
        assert_eq!(unobserved["loopW1"], 0);
        assert_eq!(unobserved["loopW4"], 0);

        let suppressed = cohort("2026-08-19");
        assert_eq!(suppressed["eligibleInstallations"], Value::Null);
        assert_eq!(suppressed["meaningfulW1"], Value::Null);
        assert_eq!(suppressed["loopW1"], Value::Null);
        assert_eq!(suppressed["loopW4"], Value::Null);
        assert_eq!(suppressed["suppressed"], true);
        assert_retention_keys(suppressed);

        let future = cohort("2026-08-22");
        assert_eq!(future["eligibleInstallations"], Value::Null);
        assert_eq!(future["suppressed"], true);
    }
}
