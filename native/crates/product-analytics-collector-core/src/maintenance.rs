use crate::{CollectorError, contract::canonical_json};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const RAW_EVENTS: &str = "rudder_analytics.product_analytics_collector_events";
const INSTALLATIONS: &str = "rudder_analytics.product_analytics_collector_installations";
const DAILY_ROLLUPS: &str = "rudder_analytics.product_analytics_collector_daily_rollups";
const PRIVACY_AGGREGATES: &str = "rudder_analytics.product_analytics_collector_privacy_aggregates";
const QUALITY: &str = "rudder_analytics.product_analytics_collector_quality_counters";
const WORK_LOOP_REVISIONS: &str =
    "rudder_analytics.product_analytics_collector_work_loop_revisions";
const DAY_MICROSECONDS: i128 = 24 * 60 * 60 * 1_000_000;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceResult {
    pub projected_work_loop_revisions: u64,
    pub rebuilt_rollup_days: u64,
    pub privacy_aggregate_rows: u64,
    pub deleted_raw_events: u64,
}

struct InstallationCohort {
    installation_id: String,
    cohort_day: String,
    first_seen_at_us: i64,
}

struct ValidWorkLoopCompletion {
    installation_id: String,
    completed_at_us: i64,
}

struct MeaningfulActivity {
    installation_id: String,
    occurred_at_us: i64,
}

struct WorkLoopRetentionAggregate {
    metric_name: &'static str,
    cohort_day: String,
    window: &'static str,
    metric_value: i64,
    contributing_installations: i64,
    latest_first_seen_at_us: i64,
}

pub async fn run_maintenance(
    pool: &PgPool,
    retention_days: i64,
    privacy_threshold: i64,
) -> Result<MaintenanceResult, CollectorError> {
    run_maintenance_with_roles(pool, pool, retention_days, privacy_threshold).await
}

pub async fn run_maintenance_with_roles(
    rollup_pool: &PgPool,
    collector_pool: &PgPool,
    retention_days: i64,
    privacy_threshold: i64,
) -> Result<MaintenanceResult, CollectorError> {
    run_maintenance_at_with_roles(
        rollup_pool,
        collector_pool,
        retention_days,
        privacy_threshold,
        OffsetDateTime::now_utc(),
    )
    .await
}

#[doc(hidden)]
pub async fn run_maintenance_at(
    pool: &PgPool,
    retention_days: i64,
    privacy_threshold: i64,
    now: OffsetDateTime,
) -> Result<MaintenanceResult, CollectorError> {
    run_maintenance_at_with_roles(pool, pool, retention_days, privacy_threshold, now).await
}

#[doc(hidden)]
pub async fn run_maintenance_at_with_roles(
    rollup_pool: &PgPool,
    collector_pool: &PgPool,
    retention_days: i64,
    privacy_threshold: i64,
    now: OffsetDateTime,
) -> Result<MaintenanceResult, CollectorError> {
    if retention_days < 1 || privacy_threshold < 2 {
        return Err(CollectorError::Maintenance(
            "invalid_maintenance_options".into(),
        ));
    }
    // Match Node Date and PostgreSQL's microsecond storage at the UTC cutoff.
    let now = truncate_to_milliseconds(now);
    let revision_from = now - time::Duration::days(retention_days);
    let revision_from_timestamp = format_timestamp(revision_from)?;
    let revision_cutoff_day = format_date(revision_from);
    let deleted = expire_raw_events(collector_pool, &revision_from_timestamp).await?;
    let mut tx = rollup_pool.begin().await?;
    let projected = project_work_loop_revisions(&mut tx).await?;
    apply_retention(&mut tx, &revision_from_timestamp, &revision_cutoff_day).await?;
    let from = format_date(now - time::Duration::days(retention_days.min(30)));
    let rebuilt_days = rebuild_daily_rollups(&mut tx, &from).await?;
    let privacy_rows = rebuild_privacy_aggregates(
        &mut tx,
        &from,
        &revision_from_timestamp,
        &revision_cutoff_day,
        privacy_threshold,
    )
    .await?;
    tx.commit().await?;
    Ok(MaintenanceResult {
        projected_work_loop_revisions: projected,
        rebuilt_rollup_days: rebuilt_days,
        privacy_aggregate_rows: privacy_rows,
        deleted_raw_events: deleted,
    })
}

async fn expire_raw_events(pool: &PgPool, cutoff_timestamp: &str) -> Result<u64, CollectorError> {
    let deleted: i64 = sqlx::query_scalar(
        "SELECT rudder_analytics.expire_product_analytics_raw_events($1::timestamptz)",
    )
    .bind(cutoff_timestamp)
    .fetch_one(pool)
    .await?;
    u64::try_from(deleted)
        .map_err(|_| CollectorError::Maintenance("invalid_deleted_event_count".into()))
}

async fn project_work_loop_revisions(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<u64, CollectorError> {
    let inserted = sqlx::query(&format!(
        "INSERT INTO {WORK_LOOP_REVISIONS} (installation_id, analytics_subject, pseudonymous_org_id, pseudonymous_work_cycle_id, completion_revision, completion_event_id, completed_at, invalidated_at, invalidation_reason_code, invalidation_event_id, environment, release_channel, origin, is_internal, confidence, updated_at) SELECT installation_id, analytics_subject, pseudonymous_org_id, pseudonymous_work_cycle_id, completion_revision, event_id::text, occurred_at, NULL, NULL, NULL, environment, release_channel, origin, is_internal, confidence, now() FROM {RAW_EVENTS} WHERE event_name='work_loop_completed' AND pseudonymous_work_cycle_id IS NOT NULL AND completion_revision IS NOT NULL ON CONFLICT (installation_id, pseudonymous_work_cycle_id, completion_revision) DO UPDATE SET completion_event_id=EXCLUDED.completion_event_id, completed_at=EXCLUDED.completed_at, analytics_subject=EXCLUDED.analytics_subject, pseudonymous_org_id=EXCLUDED.pseudonymous_org_id, environment=EXCLUDED.environment, release_channel=EXCLUDED.release_channel, origin=EXCLUDED.origin, is_internal=EXCLUDED.is_internal, confidence=EXCLUDED.confidence, updated_at=now()"
    )).execute(&mut **tx).await?.rows_affected();
    let invalidated = sqlx::query(&format!(
        "UPDATE {WORK_LOOP_REVISIONS} revision SET invalidated_at=event.occurred_at, invalidation_reason_code=event.properties->>'reason_code', invalidation_event_id=event.event_id::text, updated_at=now() FROM {RAW_EVENTS} event WHERE event.event_name='work_loop_invalidated' AND event.installation_id=revision.installation_id AND event.pseudonymous_work_cycle_id=revision.pseudonymous_work_cycle_id AND event.completion_revision=revision.completion_revision"
    )).execute(&mut **tx).await?.rows_affected();
    Ok(inserted + invalidated)
}

async fn apply_retention(
    tx: &mut Transaction<'_, Postgres>,
    cutoff_timestamp: &str,
    cutoff_day: &str,
) -> Result<(), CollectorError> {
    sqlx::query(&format!(
        "DELETE FROM {WORK_LOOP_REVISIONS} WHERE completed_at < $1::timestamptz"
    ))
    .bind(cutoff_timestamp)
    .execute(&mut **tx)
    .await?;
    sqlx::query(&format!("DELETE FROM {DAILY_ROLLUPS} WHERE day < $1::date"))
        .bind(cutoff_day)
        .execute(&mut **tx)
        .await?;
    sqlx::query(&format!(
        "DELETE FROM {PRIVACY_AGGREGATES} WHERE day < $1::date"
    ))
    .bind(cutoff_day)
    .execute(&mut **tx)
    .await?;
    sqlx::query(&format!("DELETE FROM {QUALITY} WHERE day < $1::date"))
        .bind(cutoff_day)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn rebuild_daily_rollups(
    tx: &mut Transaction<'_, Postgres>,
    from: &str,
) -> Result<u64, CollectorError> {
    sqlx::query(&format!(
        "DELETE FROM {DAILY_ROLLUPS} WHERE day >= $1::date"
    ))
    .bind(from)
    .execute(&mut **tx)
    .await?;
    let rows = sqlx::query(&format!(
        "SELECT (occurred_at AT TIME ZONE 'UTC')::date::text AS day, installation_id, event_name, origin, jsonb_build_object('environment', environment, 'app_version', app_version, 'release_channel', release_channel, 'deployment_mode', deployment_mode, 'confidence', confidence, 'analytics_mode', CASE WHEN analytics_subject IS NULL THEN 'anonymous' ELSE 'account_linked' END)::text AS dimensions, count(*)::bigint AS event_count, min(occurred_at)::text AS first_occurred_at, max(occurred_at)::text AS last_occurred_at FROM {RAW_EVENTS} WHERE occurred_at >= $1::timestamptz AND environment='production' AND is_internal=false GROUP BY (occurred_at AT TIME ZONE 'UTC')::date, installation_id, event_name, origin, environment, app_version, release_channel, deployment_mode, confidence, analytics_subject"
    )).bind(from).fetch_all(&mut **tx).await?;
    let mut days = std::collections::BTreeSet::new();
    for row in rows {
        let day: String = row.try_get("day")?;
        let dimensions_text: String = row.try_get("dimensions")?;
        let dimensions: Value = serde_json::from_str(&dimensions_text)
            .map_err(|error| CollectorError::Maintenance(error.to_string()))?;
        let dimension_hash = hash_json(&dimensions);
        sqlx::query(&format!(
            "INSERT INTO {DAILY_ROLLUPS} (day, installation_id, event_name, origin, dimension_hash, dimensions, event_count, first_occurred_at, last_occurred_at, updated_at) VALUES ($1::date, $2, $3, $4, $5, $6::jsonb, $7, $8::timestamptz, $9::timestamptz, now()) ON CONFLICT (day, installation_id, event_name, origin, dimension_hash) DO UPDATE SET dimensions=EXCLUDED.dimensions, event_count=EXCLUDED.event_count, first_occurred_at=EXCLUDED.first_occurred_at, last_occurred_at=EXCLUDED.last_occurred_at, updated_at=now()"
        )).bind(&day).bind(row.try_get::<String, _>("installation_id")?).bind(row.try_get::<String, _>("event_name")?).bind(row.try_get::<String, _>("origin")?).bind(dimension_hash).bind(dimensions_text).bind(database_integer(row.try_get::<i64, _>("event_count")?)?).bind(row.try_get::<String, _>("first_occurred_at")?).bind(row.try_get::<String, _>("last_occurred_at")?).execute(&mut **tx).await?;
        days.insert(day);
    }
    Ok(days.len() as u64)
}

async fn rebuild_privacy_aggregates(
    tx: &mut Transaction<'_, Postgres>,
    from: &str,
    revision_from: &str,
    revision_cutoff_day: &str,
    privacy_threshold: i64,
) -> Result<u64, CollectorError> {
    sqlx::query(&format!("DELETE FROM {PRIVACY_AGGREGATES} WHERE day >= $1::date OR metric_name IN ('weekly_completed_work_loops', 'work_loop_retention', 'meaningful_work_retention')")).bind(from).execute(&mut **tx).await?;
    let groups = sqlx::query(&format!(
        "SELECT (occurred_at AT TIME ZONE 'UTC')::date::text AS day, event_name, origin, count(*)::bigint AS event_count, count(DISTINCT installation_id)::bigint AS contributing_installations FROM {RAW_EVENTS} WHERE occurred_at >= $1::timestamptz AND environment='production' AND is_internal=false GROUP BY (occurred_at AT TIME ZONE 'UTC')::date, event_name, origin"
    )).bind(from).fetch_all(&mut **tx).await?;
    let mut written = 0_u64;
    for row in groups {
        let contributing: i64 = row.try_get("contributing_installations")?;
        if contributing < privacy_threshold {
            continue;
        }
        let dimensions = serde_json::json!({ "event_name": row.try_get::<String, _>("event_name")?, "origin": row.try_get::<String, _>("origin")? });
        insert_privacy(
            tx,
            &row.try_get::<String, _>("day")?,
            row.try_get::<String, _>("event_name")?.as_str(),
            &dimensions,
            row.try_get("event_count")?,
            contributing,
            privacy_threshold,
        )
        .await?;
        written += 1;
    }
    let loops = sqlx::query(&format!(
        "SELECT (completed_at AT TIME ZONE 'UTC')::date::text AS day, count(*)::bigint AS metric_value, count(DISTINCT installation_id)::bigint AS contributing_installations FROM {WORK_LOOP_REVISIONS} WHERE completed_at >= $1::timestamptz AND invalidated_at IS NULL AND environment='production' AND origin='human' AND is_internal=false GROUP BY (completed_at AT TIME ZONE 'UTC')::date"
    )).bind(from).fetch_all(&mut **tx).await?;
    for row in loops {
        let contributing: i64 = row.try_get("contributing_installations")?;
        if contributing < privacy_threshold {
            continue;
        }
        let dimensions = serde_json::json!({ "source": "valid_work_loop_revisions" });
        insert_privacy(
            tx,
            &row.try_get::<String, _>("day")?,
            "weekly_completed_work_loops",
            &dimensions,
            row.try_get("metric_value")?,
            contributing,
            privacy_threshold,
        )
        .await?;
        written += 1;
    }

    let installation_rows = sqlx::query(&format!(
        "SELECT installation_id, (first_seen_at AT TIME ZONE 'UTC')::date::text AS cohort_day, floor(extract(epoch FROM first_seen_at) * 1000000)::bigint AS first_seen_at_us FROM {INSTALLATIONS}"
    ))
    .fetch_all(&mut **tx)
    .await?;
    let mut installations = Vec::with_capacity(installation_rows.len());
    for row in installation_rows {
        installations.push(InstallationCohort {
            installation_id: row.try_get("installation_id")?,
            cohort_day: row.try_get("cohort_day")?,
            first_seen_at_us: row.try_get("first_seen_at_us")?,
        });
    }

    let completion_rows = sqlx::query(&format!(
        "SELECT installation_id, floor(extract(epoch FROM completed_at) * 1000000)::bigint AS completed_at_us FROM {WORK_LOOP_REVISIONS} WHERE completed_at >= $1::timestamptz AND invalidated_at IS NULL AND environment='production' AND origin='human' AND is_internal=false"
    ))
    .bind(revision_from)
    .fetch_all(&mut **tx)
    .await?;
    let mut completions = Vec::with_capacity(completion_rows.len());
    for row in completion_rows {
        completions.push(ValidWorkLoopCompletion {
            installation_id: row.try_get("installation_id")?,
            completed_at_us: row.try_get("completed_at_us")?,
        });
    }

    let meaningful_rows = sqlx::query(&format!(
        "SELECT event.installation_id, floor(extract(epoch FROM min(event.occurred_at)) * 1000000)::bigint AS occurred_at_us FROM {RAW_EVENTS} event JOIN {INSTALLATIONS} installation USING (installation_id) WHERE (installation.first_seen_at AT TIME ZONE 'UTC')::date >= $1::date AND event.environment='production' AND event.is_internal=false AND event.event_name IN ('human_work_started', 'review_decision_recorded', 'work_loop_completed') AND event.occurred_at >= installation.first_seen_at + interval '7 days' AND event.occurred_at < installation.first_seen_at + interval '14 days' GROUP BY event.installation_id"
    ))
    .bind(revision_cutoff_day)
    .fetch_all(&mut **tx)
    .await?;
    let mut meaningful_activities = Vec::with_capacity(meaningful_rows.len());
    for row in meaningful_rows {
        meaningful_activities.push(MeaningfulActivity {
            installation_id: row.try_get("installation_id")?,
            occurred_at_us: row.try_get("occurred_at_us")?,
        });
    }

    let retention_aggregates = build_work_loop_retention_aggregates(
        &installations,
        &completions,
        revision_cutoff_day,
        privacy_threshold,
    )
    .into_iter()
    .chain(build_meaningful_w1_aggregates(
        &installations,
        &meaningful_activities,
        revision_cutoff_day,
        privacy_threshold,
    ));
    for aggregate in retention_aggregates {
        let dimensions = serde_json::json!({
            "cohort_day": aggregate.cohort_day,
            "window": aggregate.window,
            "latest_first_seen_at_us": aggregate.latest_first_seen_at_us,
        });
        insert_privacy(
            tx,
            &aggregate.cohort_day,
            aggregate.metric_name,
            &dimensions,
            aggregate.metric_value,
            aggregate.contributing_installations,
            privacy_threshold,
        )
        .await?;
        written += 1;
    }

    Ok(written)
}

fn build_work_loop_retention_aggregates(
    installations: &[InstallationCohort],
    completions: &[ValidWorkLoopCompletion],
    revision_cutoff_day: &str,
    privacy_threshold: i64,
) -> Vec<WorkLoopRetentionAggregate> {
    let mut eligible_by_cohort = BTreeMap::<String, BTreeSet<String>>::new();
    let mut latest_first_seen_by_cohort = BTreeMap::<String, i64>::new();
    let mut installation_by_id = HashMap::with_capacity(installations.len());
    for installation in installations {
        if installation.cohort_day.as_str() < revision_cutoff_day {
            continue;
        }
        eligible_by_cohort
            .entry(installation.cohort_day.clone())
            .or_default()
            .insert(installation.installation_id.clone());
        latest_first_seen_by_cohort
            .entry(installation.cohort_day.clone())
            .and_modify(|latest| *latest = (*latest).max(installation.first_seen_at_us))
            .or_insert(installation.first_seen_at_us);
        installation_by_id.insert(installation.installation_id.as_str(), installation);
    }

    let mut retained_by_cohort = BTreeMap::<String, (BTreeSet<String>, BTreeSet<String>)>::new();
    for completion in completions {
        let Some(installation) = installation_by_id.get(completion.installation_id.as_str()) else {
            continue;
        };
        let age_us =
            i128::from(completion.completed_at_us) - i128::from(installation.first_seen_at_us);
        let retained = retained_by_cohort
            .entry(installation.cohort_day.clone())
            .or_default();
        if (7 * DAY_MICROSECONDS..14 * DAY_MICROSECONDS).contains(&age_us) {
            retained.0.insert(completion.installation_id.clone());
        }
        if (28 * DAY_MICROSECONDS..35 * DAY_MICROSECONDS).contains(&age_us) {
            retained.1.insert(completion.installation_id.clone());
        }
    }

    let mut aggregates = Vec::new();
    for (cohort_day, eligible) in eligible_by_cohort {
        let contributing_installations = eligible.len() as i64;
        if contributing_installations < privacy_threshold {
            continue;
        }
        let latest_first_seen_at_us = latest_first_seen_by_cohort[&cohort_day];
        let (w1, w4) = retained_by_cohort.remove(&cohort_day).unwrap_or_default();
        for (window, installations) in [("w1", w1), ("w4", w4)] {
            aggregates.push(WorkLoopRetentionAggregate {
                metric_name: "work_loop_retention",
                cohort_day: cohort_day.clone(),
                window,
                metric_value: installations.len() as i64,
                contributing_installations,
                latest_first_seen_at_us,
            });
        }
    }
    aggregates
}

fn build_meaningful_w1_aggregates(
    installations: &[InstallationCohort],
    activities: &[MeaningfulActivity],
    revision_cutoff_day: &str,
    privacy_threshold: i64,
) -> Vec<WorkLoopRetentionAggregate> {
    let mut eligible_by_cohort = BTreeMap::<String, BTreeSet<String>>::new();
    let mut latest_first_seen_by_cohort = BTreeMap::<String, i64>::new();
    let mut installation_by_id = HashMap::with_capacity(installations.len());
    for installation in installations {
        if installation.cohort_day.as_str() < revision_cutoff_day {
            continue;
        }
        eligible_by_cohort
            .entry(installation.cohort_day.clone())
            .or_default()
            .insert(installation.installation_id.clone());
        latest_first_seen_by_cohort
            .entry(installation.cohort_day.clone())
            .and_modify(|latest| *latest = (*latest).max(installation.first_seen_at_us))
            .or_insert(installation.first_seen_at_us);
        installation_by_id.insert(installation.installation_id.as_str(), installation);
    }

    let mut retained_by_cohort = BTreeMap::<String, BTreeSet<String>>::new();
    for activity in activities {
        let Some(installation) = installation_by_id.get(activity.installation_id.as_str()) else {
            continue;
        };
        let age_us =
            i128::from(activity.occurred_at_us) - i128::from(installation.first_seen_at_us);
        if (7 * DAY_MICROSECONDS..14 * DAY_MICROSECONDS).contains(&age_us) {
            retained_by_cohort
                .entry(installation.cohort_day.clone())
                .or_default()
                .insert(activity.installation_id.clone());
        }
    }

    eligible_by_cohort
        .into_iter()
        .filter_map(|(cohort_day, eligible)| {
            let contributing_installations = eligible.len() as i64;
            if contributing_installations < privacy_threshold {
                return None;
            }
            let installations = retained_by_cohort.remove(&cohort_day).unwrap_or_default();
            Some(WorkLoopRetentionAggregate {
                metric_name: "meaningful_work_retention",
                cohort_day: cohort_day.clone(),
                window: "w1",
                metric_value: installations.len() as i64,
                contributing_installations,
                latest_first_seen_at_us: latest_first_seen_by_cohort[&cohort_day],
            })
        })
        .collect()
}

async fn insert_privacy(
    tx: &mut Transaction<'_, Postgres>,
    day: &str,
    metric_name: &str,
    dimensions: &Value,
    metric_value: i64,
    contributing: i64,
    threshold: i64,
) -> Result<(), CollectorError> {
    let text = serde_json::to_string(dimensions)
        .map_err(|error| CollectorError::Maintenance(error.to_string()))?;
    sqlx::query(&format!(
        "INSERT INTO {PRIVACY_AGGREGATES} (day, metric_name, dimension_set_version, dimension_hash, dimension_values, metric_value, contributing_installations, privacy_threshold, created_at, updated_at) VALUES ($1::date, $2, 1, $3, $4::jsonb, $5, $6, $7, now(), now()) ON CONFLICT (day, metric_name, dimension_set_version, dimension_hash) DO UPDATE SET dimension_values=EXCLUDED.dimension_values, metric_value=EXCLUDED.metric_value, contributing_installations=EXCLUDED.contributing_installations, privacy_threshold=EXCLUDED.privacy_threshold, updated_at=now()"
    )).bind(day).bind(metric_name).bind(hash_json(dimensions)).bind(text).bind(database_integer(metric_value)?).bind(database_integer(contributing)?).bind(database_integer(threshold)?).execute(&mut **tx).await?;
    Ok(())
}

fn hash_json(value: &Value) -> String {
    let mut digest = Sha256::new();
    digest.update(canonical_json(value).as_bytes());
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn format_date(value: OffsetDateTime) -> String {
    value.date().to_string()
}

fn database_integer(value: i64) -> Result<i32, CollectorError> {
    i32::try_from(value)
        .map_err(|_| CollectorError::Maintenance("postgres_integer_overflow".into()))
}

fn format_timestamp(value: OffsetDateTime) -> Result<String, CollectorError> {
    value
        .format(&Rfc3339)
        .map_err(|error| CollectorError::Maintenance(error.to_string()))
}

fn truncate_to_milliseconds(value: OffsetDateTime) -> OffsetDateTime {
    let nanosecond = value.nanosecond() / 1_000_000 * 1_000_000;
    value
        .replace_nanosecond(nanosecond)
        .expect("millisecond-aligned nanoseconds are valid")
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY_US: i64 = 24 * 60 * 60 * 1_000_000;

    fn installation(id: &str, cohort_day: &str, first_seen_at_us: i64) -> InstallationCohort {
        InstallationCohort {
            installation_id: id.to_owned(),
            cohort_day: cohort_day.to_owned(),
            first_seen_at_us,
        }
    }

    fn completion(installation_id: &str, completed_at_us: i64) -> ValidWorkLoopCompletion {
        ValidWorkLoopCompletion {
            installation_id: installation_id.to_owned(),
            completed_at_us,
        }
    }

    fn timestamp_us(value: &str) -> i64 {
        i64::try_from(
            OffsetDateTime::parse(value, &Rfc3339)
                .unwrap()
                .unix_timestamp_nanos()
                / 1_000,
        )
        .unwrap()
    }

    #[test]
    fn work_loop_retention_uses_node_elapsed_windows_and_distinct_installations() {
        let base = timestamp_us("2026-08-04T00:00:00Z");
        let installations = vec![
            installation("a", "2026-08-04", base),
            installation("b", "2026-08-04", base + 60 * 60 * 1_000_000 + 123_456),
            installation("before-cutoff", "2026-08-03", base - DAY_US),
        ];
        let completions = vec![
            completion("a", base + 7 * DAY_US),
            completion("a", base + 13 * DAY_US),
            completion("a", base + 14 * DAY_US),
            completion("a", base + 28 * DAY_US),
            completion("b", base + 60 * 60 * 1_000_000 + 123_455 + 7 * DAY_US),
            completion("b", base + 60 * 60 * 1_000_000 + 123_456 + 7 * DAY_US),
            completion("b", base + 60 * 60 * 1_000_000 + 123_456 + 28 * DAY_US),
            completion("b", base + 60 * 60 * 1_000_000 + 123_456 + 35 * DAY_US),
            completion("before-cutoff", base + 8 * DAY_US),
        ];

        let aggregates =
            build_work_loop_retention_aggregates(&installations, &completions, "2026-08-04", 2);
        let values = aggregates
            .iter()
            .map(|aggregate| (aggregate.window, aggregate.metric_value))
            .collect::<BTreeMap<_, _>>();

        assert_eq!(values, BTreeMap::from([("w1", 2), ("w4", 2)]));
        assert!(aggregates.iter().all(|aggregate| {
            aggregate.cohort_day == "2026-08-04" && aggregate.contributing_installations == 2
        }));
    }

    #[test]
    fn work_loop_retention_applies_cutoff_threshold_and_emits_zero_counts() {
        let cutoff_day = timestamp_us("2026-08-04T00:00:00Z");
        let installations = vec![
            installation("under-threshold", "2026-08-05", cutoff_day + DAY_US),
            installation("eligible-a", "2026-08-04", cutoff_day),
            installation("eligible-b", "2026-08-04", cutoff_day + DAY_US - 1),
            installation("expired-a", "2026-08-03", cutoff_day - DAY_US),
            installation("expired-b", "2026-08-03", cutoff_day - DAY_US + 1),
        ];

        let aggregates = build_work_loop_retention_aggregates(&installations, &[], "2026-08-04", 2);

        assert_eq!(aggregates.len(), 2);
        assert!(aggregates.iter().all(|aggregate| {
            aggregate.cohort_day == "2026-08-04"
                && aggregate.metric_value == 0
                && aggregate.contributing_installations == 2
        }));
    }

    #[test]
    fn meaningful_w1_uses_exact_installation_first_seen_microseconds() {
        let first_seen = timestamp_us("2026-08-04T10:00:00.123456Z");
        let second_first_seen = first_seen + 5 * 60 * 60 * 1_000_000 + 123_456;
        let installations = vec![
            installation("a", "2026-08-04", first_seen),
            installation("b", "2026-08-04", second_first_seen),
        ];
        let activities = vec![
            MeaningfulActivity {
                installation_id: "a".to_owned(),
                occurred_at_us: first_seen + 7 * DAY_US,
            },
            MeaningfulActivity {
                installation_id: "b".to_owned(),
                occurred_at_us: second_first_seen + 7 * DAY_US - 1,
            },
        ];

        let aggregates =
            build_meaningful_w1_aggregates(&installations, &activities, "2026-08-04", 2);

        assert_eq!(aggregates.len(), 1);
        assert_eq!(aggregates[0].metric_name, "meaningful_work_retention");
        assert_eq!(aggregates[0].window, "w1");
        assert_eq!(aggregates[0].metric_value, 1);
        assert_eq!(aggregates[0].contributing_installations, 2);
        assert_eq!(aggregates[0].latest_first_seen_at_us, second_first_seen);
    }
}
