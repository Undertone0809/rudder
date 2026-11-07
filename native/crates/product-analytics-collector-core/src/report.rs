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
        "metricStatus": {
            "meaningfulActiveInstallations1d": report_window_status(range.to),
            "meaningfulActiveInstallations7d": report_window_status(range.to),
            "productiveInstallations7d": report_window_status(range.to),
            "meaningfulDau": report_window_status(range.to),
            "productiveWau": report_window_status(range.to),
        },
        "metricSemantics": {
            "unit": "distinct_production_installations",
            "timezone": "UTC",
            "activityWindow": "trailing_elapsed_days_ending_at_window_to_utc_day_end_inclusive_clipped_to_window_from",
            "dauStatus": "in_progress_until_window_to_utc_day_is_complete",
            "retentionCohort": "utc_calendar_day_of_first_observed_production_event",
            "retentionMaturity": "latest_exact_first_observed_production_event_in_utc_cohort_plus_window_must_be_at_or_before_window_to_utc_day_end",
            "meaningfulEvents": meaningful,
            "productiveEvents": productive,
            "meaningfulDau": "installation_level_24_hour_proxy_not_account_dau",
            "productiveWau": "installation_level_7_day_proxy_not_account_wau",
            "meaningfulW1": "meaningful_activity_at_age_days_gte_7_and_lt_14_from_first_observed_production_event",
            "loopW1": "valid_work_loop_completion_at_age_days_gte_7_and_lt_14_from_first_observed_production_event",
            "loopW4": "valid_work_loop_completion_at_age_days_gte_28_and_lt_35_from_first_observed_production_event",
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

fn report_window_status(to: Date) -> &'static str {
    let today = OffsetDateTime::now_utc().date();
    if to < today {
        "complete"
    } else if to == today {
        "in_progress"
    } else {
        "future"
    }
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
    for row in rows {
        first_seen
            .entry(row.installation_id.clone())
            .and_modify(|seen_at| {
                if row.first_occurred_at < *seen_at {
                    *seen_at = row.first_occurred_at
                }
            })
            .or_insert(row.first_occurred_at);
    }
    #[derive(Default)]
    struct RetentionAggregate {
        contributing_installations: Option<i64>,
        latest_first_observed_at: Option<OffsetDateTime>,
        meaningful_w1: Option<i64>,
        loop_w1: Option<i64>,
        loop_w4: Option<i64>,
    }
    let mut retention_aggregates = BTreeMap::<String, RetentionAggregate>::new();
    for aggregate in aggregates.iter().filter(|row| {
        matches!(
            row.metric_name.as_str(),
            "work_loop_retention" | "meaningful_work_retention"
        )
    }) {
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
        let entry = retention_aggregates.entry(cohort.to_owned()).or_default();
        entry.contributing_installations = Some(aggregate.contributing_installations);
        if let Some(first_seen_us) = aggregate
            .dimensions
            .get("latest_first_observed_at_us")
            .and_then(Value::as_i64)
            && let Ok(first_seen_at) =
                OffsetDateTime::from_unix_timestamp_nanos(i128::from(first_seen_us) * 1_000)
        {
            entry.latest_first_observed_at = Some(
                entry
                    .latest_first_observed_at
                    .map_or(first_seen_at, |latest| latest.max(first_seen_at)),
            );
        }
        match (aggregate.metric_name.as_str(), window) {
            ("work_loop_retention", "w1") => entry.loop_w1 = Some(aggregate.metric_value),
            ("work_loop_retention", "w4") => entry.loop_w4 = Some(aggregate.metric_value),
            ("meaningful_work_retention", "w1") => {
                entry.meaningful_w1 = Some(aggregate.metric_value)
            }
            _ => {}
        }
    }
    #[derive(Default)]
    struct Cohort {
        eligible: BTreeSet<String>,
        aggregated_eligible: Option<i64>,
        aggregated_meaningful_w1: Option<i64>,
        latest_first_observed_at: Option<OffsetDateTime>,
    }
    let mut cohorts = BTreeMap::<Date, Cohort>::new();
    for (installation, first_seen_at) in first_seen {
        let cohort_day = first_seen_at.date();
        if cohort_day < range.from || cohort_day > range.to {
            continue;
        }
        let entry = cohorts.entry(cohort_day).or_default();
        entry.eligible.insert(installation.clone());
        entry.latest_first_observed_at = Some(
            entry
                .latest_first_observed_at
                .map_or(first_seen_at, |latest| latest.max(first_seen_at)),
        );
    }
    for (cohort_name, aggregate) in &retention_aggregates {
        let Ok(cohort_day) = parse_date(cohort_name) else {
            continue;
        };
        if cohort_day < range.from || cohort_day > range.to {
            continue;
        }
        if aggregate.latest_first_observed_at.is_none() && !cohorts.contains_key(&cohort_day) {
            continue;
        }
        let entry = cohorts.entry(cohort_day).or_default();
        entry.aggregated_eligible = aggregate.contributing_installations;
        entry.aggregated_meaningful_w1 = aggregate.meaningful_w1;
        if aggregate.latest_first_observed_at.is_some() {
            entry.latest_first_observed_at = aggregate.latest_first_observed_at;
        }
    }
    cohorts.retain(|cohort_day, cohort| {
        retention_aggregates.contains_key(&cohort_day.to_string())
            || (cohort.eligible.len() as i64) < threshold
    });
    let report_end = date_end_time(range.to);
    cohorts
        .into_iter()
        .map(|(cohort_day, cohort)| {
        let cohort_name = cohort_day.to_string();
        let aggregate = retention_aggregates.get(&cohort_name);
        let latest_first_observed_at = cohort
            .latest_first_observed_at
            .expect("cohort has an observed first-event timestamp");
        let meaningful_w1_mature = latest_first_observed_at + Duration::days(14) <= report_end;
        let loop_w1_mature = meaningful_w1_mature;
        let loop_w4_mature = latest_first_observed_at + Duration::days(35) <= report_end;
        let eligible_installations = cohort
            .aggregated_eligible
            .unwrap_or(cohort.eligible.len() as i64);
        let meaningful_w1 = cohort.aggregated_meaningful_w1;
        let suppressed = eligible_installations < threshold;
        let status = |mature: bool, observed: bool| {
            if suppressed {
                "threshold_blocked"
            } else if !mature {
                "immature"
            } else if observed {
                "available"
            } else {
                "not_observed"
            }
        };
        if suppressed {
            json!({
                "cohortDay": cohort_name,
                "eligibleInstallations": null,
                "meaningfulW1": null,
                "meaningfulW1Status": "threshold_blocked",
                "loopW1": null,
                "loopW1Status": "threshold_blocked",
                "loopW4": null,
                "loopW4Status": "threshold_blocked",
                "suppressed": true
            })
        } else {
            json!({
                "cohortDay": cohort_name,
                "eligibleInstallations": eligible_installations,
                "meaningfulW1": if meaningful_w1_mature { meaningful_w1.map_or(Value::Null, |value| json!(value)) } else { Value::Null },
                "meaningfulW1Status": status(meaningful_w1_mature, meaningful_w1.is_some()),
                "loopW1": if loop_w1_mature { aggregate.and_then(|value| value.loop_w1).map_or(Value::Null, |value| json!(value)) } else { Value::Null },
                "loopW1Status": status(loop_w1_mature, aggregate.and_then(|value| value.loop_w1).is_some()),
                "loopW4": if loop_w4_mature { aggregate.and_then(|value| value.loop_w4).map_or(Value::Null, |value| json!(value)) } else { Value::Null },
                "loopW4Status": status(loop_w4_mature, aggregate.and_then(|value| value.loop_w4).is_some()),
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
    date_end_time(value).format(&Rfc3339).unwrap_or_default()
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

    fn meaningful_aggregate(cohort_day: &str, metric_value: i64) -> Aggregate {
        Aggregate {
            metric_name: "meaningful_work_retention".to_owned(),
            metric_value,
            contributing_installations: 2,
            privacy_threshold: 2,
            dimensions: json!({"cohort_day": cohort_day, "window": "w1"}),
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
    fn retention_uses_exact_first_observed_event_and_reports_maturity_separately() {
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
        ];
        let aggregates = vec![
            aggregate("2026-07-01", "w1", 1),
            aggregate("2026-07-01", "w4", 1),
            meaningful_aggregate("2026-07-01", 1),
            aggregate("2026-08-01", "w1", 2),
            aggregate("2026-08-01", "w4", 0),
            meaningful_aggregate("2026-08-01", 1),
            aggregate("2026-08-18", "w1", 0),
            aggregate("2026-08-18", "w4", 0),
            meaningful_aggregate("2026-08-18", 0),
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

        let old = cohort("2026-07-01");
        assert_eq!(old["meaningfulW1"], 1, "cohort={old}");
        assert_eq!(old["meaningfulW1Status"], "available");
        assert_eq!(old["loopW4"], 1);
        assert_eq!(old["loopW4Status"], "available");

        let recent = cohort("2026-08-01");
        assert_eq!(recent["meaningfulW1"], 1);
        assert_eq!(recent["meaningfulW1Status"], "available");
        assert_eq!(recent["loopW1"], 2);
        assert_eq!(recent["loopW1Status"], "available");
        assert_eq!(recent["loopW4"], Value::Null);
        assert_eq!(recent["loopW4Status"], "immature");

        let immature = cohort("2026-08-18");
        assert_eq!(immature["meaningfulW1"], Value::Null);
        assert_eq!(immature["meaningfulW1Status"], "immature");
        assert_eq!(immature["loopW1"], Value::Null);
        assert_eq!(immature["loopW1Status"], "immature");
        assert_eq!(immature["loopW4"], Value::Null);
        assert_eq!(immature["loopW4Status"], "immature");

        let suppressed = cohort("2026-08-19");
        assert_eq!(suppressed["meaningfulW1Status"], "threshold_blocked");
        assert_eq!(suppressed["loopW4Status"], "threshold_blocked");
    }

    #[test]
    fn report_window_status_identifies_incomplete_utc_day() {
        let today = OffsetDateTime::now_utc().date();
        assert_eq!(report_window_status(today), "in_progress");
        assert_eq!(report_window_status(today - Duration::days(1)), "complete");
        assert_eq!(report_window_status(today + Duration::days(1)), "future");
    }
}
