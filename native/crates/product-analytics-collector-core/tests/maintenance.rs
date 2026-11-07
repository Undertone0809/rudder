use rudder_product_analytics_collector_core::{
    CollectorConfig, StartedCollector, run_maintenance_at, start,
};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use std::{
    env,
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration as StdDuration, SystemTime, UNIX_EPOCH},
};
use time::{Duration, OffsetDateTime, UtcOffset, format_description::well_known::Rfc3339};
use tokio::time::sleep;

const ENABLE: &str = "RUDDER_ANALYTICS_COLLECTOR_TEST_ENABLE";
const ADMIN_URL: &str = "RUDDER_ANALYTICS_COLLECTOR_TEST_ADMIN_URL";
const MIGRATOR_URL: &str = "RUDDER_ANALYTICS_COLLECTOR_TEST_MIGRATOR_URL";
const INGEST_URL: &str = "RUDDER_ANALYTICS_COLLECTOR_TEST_INGEST_URL";
const MAINTENANCE_URL: &str = "RUDDER_ANALYTICS_COLLECTOR_TEST_MAINTENANCE_URL";
const READER_URL: &str = "RUDDER_ANALYTICS_COLLECTOR_TEST_READER_URL";
const SCHEMA: &str = "rudder_analytics";
const EVENTS: &str = "rudder_analytics.product_analytics_collector_events";
const INSTALLATIONS: &str = "rudder_analytics.product_analytics_collector_installations";
const SUBJECTS: &str = "rudder_analytics.product_analytics_collector_subjects";
const ROLLUPS: &str = "rudder_analytics.product_analytics_collector_daily_rollups";
const AGGREGATES: &str = "rudder_analytics.product_analytics_collector_privacy_aggregates";
const QUALITY: &str = "rudder_analytics.product_analytics_collector_quality_counters";
const REVISIONS: &str = "rudder_analytics.product_analytics_collector_work_loop_revisions";
const ANONYMOUS_AUTHORIZATION: &str = "collector-maintenance-test-authorization";
const REPORT_SECRET: &str = "collector-maintenance-test-report";
static EVENT_ID: AtomicU64 = AtomicU64::new(1);

type TestResult<T> = Result<T, String>;

#[derive(Clone)]
struct Installation {
    id: String,
    pseudonymous_id: String,
    first_seen_at: OffsetDateTime,
}

struct HttpResponse {
    status: u16,
    body: Value,
}

struct Outcome {
    report: Value,
    main_day: String,
    zero_day: String,
    suppressed_day: String,
    expired_counts: Vec<i64>,
    cutoff_rows: Vec<(String, String, i64, i64)>,
    accepted_events: usize,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a fresh disposable loopback PostgreSQL fixture and explicit TEST_ENABLE=1"]
async fn loopback_maintenance_matches_utc_windows_and_retention() {
    let outcome = run_fixture()
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    let cohorts = outcome.report["retention"]
        .as_array()
        .expect("retention rows");

    let main = cohorts
        .iter()
        .find(|row| row["cohortDay"] == outcome.main_day)
        .expect("W1/W4 cohort appears in report");
    assert_eq!(main["eligibleInstallations"], 4);
    assert_eq!(main["loopW1"], 2);
    assert_eq!(main["loopW1Status"], "available");
    assert_eq!(main["loopW4"], 2);
    assert_eq!(main["loopW4Status"], "available");
    assert_eq!(main["suppressed"], false);

    let metrics = &outcome.report["metrics"];
    assert_eq!(
        metrics["meaningfulDau"],
        metrics["meaningfulActiveInstallations1d"]
    );
    assert_eq!(
        metrics["productiveWau"],
        metrics["productiveInstallations7d"]
    );
    assert_eq!(
        outcome.report["metricStatus"]["meaningfulDau"],
        "in_progress"
    );
    assert_eq!(
        outcome.report["metricSemantics"]["unit"],
        "distinct_production_installations"
    );

    // W4 covers ages 28 through <35 days and is immature until that window ends.
    let zero = cohorts
        .iter()
        .find(|row| row["cohortDay"] == outcome.zero_day)
        .expect("zero cohort appears in report");
    assert_eq!(zero["eligibleInstallations"], 3);
    assert_eq!(zero["loopW1"], 0);
    assert_eq!(zero["loopW1Status"], "available");
    assert_eq!(zero["loopW4"], Value::Null);
    assert_eq!(zero["loopW4Status"], "immature");
    assert_eq!(zero["suppressed"], false);

    let suppressed = cohorts
        .iter()
        .find(|row| row["cohortDay"] == outcome.suppressed_day)
        .expect("below-threshold cohort appears in report");
    assert_eq!(suppressed["eligibleInstallations"], Value::Null);
    assert_eq!(suppressed["loopW1"], Value::Null);
    assert_eq!(suppressed["loopW4"], Value::Null);
    assert_eq!(suppressed["suppressed"], true);

    assert_eq!(outcome.accepted_events, 11);
    assert_eq!(outcome.expired_counts, vec![0, 0, 0, 0, 0]);
    assert_eq!(outcome.cutoff_rows.len(), 2);
    assert_eq!(
        outcome
            .cutoff_rows
            .iter()
            .map(|row| row.1.as_str())
            .collect::<Vec<_>>(),
        vec!["w1", "w4"]
    );
    assert!(
        outcome
            .cutoff_rows
            .iter()
            .all(|(_, _, value, contributors)| { *value == 0 && *contributors == 3 })
    );
    println!(
        "analytics report evidence: main={main} age15_zero={zero} below_threshold={suppressed} metrics={metrics} accepted_events={} expired_counts={:?} cutoff_aggregates={:?}",
        outcome.accepted_events, outcome.expired_counts, outcome.cutoff_rows
    );
}

fn find_cohort<'a>(rows: &'a [Value], day: &str) -> Option<&'a Value> {
    rows.iter().find(|row| row["cohortDay"] == day)
}

async fn run_fixture() -> TestResult<Outcome> {
    if env::var(ENABLE).as_deref() != Ok("1") {
        return Err(format!(
            "set {ENABLE}=1 for the explicit disposable fixture"
        ));
    }

    let admin_url = required_env(ADMIN_URL)?;
    let migrator_url = required_env(MIGRATOR_URL)?;
    let ingest_url = required_env(INGEST_URL)?;
    let maintenance_url = required_env(MAINTENANCE_URL)?;
    let reader_url = required_env(READER_URL)?;
    let admin = connect(&admin_url).await?;
    let database = verify_local_test_database(&admin, "rudder_analytics_test_admin").await?;
    let migrator = connect(&migrator_url).await?;
    verify_same_database(&migrator, &database, "rudder_analytics_migrator").await?;
    verify_migration_history(&migrator).await?;
    verify_role_grants(&admin).await?;
    let ingest_probe = connect(&ingest_url).await?;
    verify_same_database(&ingest_probe, &database, "rudder_analytics_collector").await?;
    let maintenance_probe = connect(&maintenance_url).await?;
    verify_same_database(&maintenance_probe, &database, "rudder_analytics_rollup").await?;
    let reader_probe = connect(&reader_url).await?;
    verify_same_database(&reader_probe, &database, "rudder_analytics_reader").await?;
    ensure_empty_fixture(&admin).await?;

    let run_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let now = OffsetDateTime::now_utc();
    let main_first_seen = now - Duration::days(40);
    let main_day = main_first_seen.date().to_string();
    let zero_first_seen = now - Duration::days(15);
    let suppressed_first_seen = now - Duration::days(10);
    let mut main = make_installations("main", 4, main_first_seen, run_id);
    main[0].first_seen_at = main_first_seen.to_offset(UtcOffset::from_hms(2, 0, 0).unwrap());
    let zero = make_installations("zero", 3, zero_first_seen, run_id);
    let suppressed = make_installations("below", 2, suppressed_first_seen, run_id);

    let first_cutoff_day = (now.date() - Duration::days(90)).to_string();
    let next_cutoff_day = (now.date() - Duration::days(89)).to_string();
    let expired_day = (now.date() - Duration::days(91)).to_string();
    seed_cutoff_cohort(&admin, &first_cutoff_day, run_id, 0).await?;
    seed_cutoff_cohort(&admin, &next_cutoff_day, run_id, 3).await?;
    seed_expired_projection(&admin, &expired_day, now, run_id).await?;

    let port = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| error.to_string())?
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    println!("collector listener=127.0.0.1:{port}");
    let config = CollectorConfig {
        database_url: ingest_url,
        maintenance_database_url: maintenance_url,
        report_database_url: reader_url,
        database_role: Some("rudder_analytics_collector".into()),
        expected_database_role: Some("rudder_analytics_collector".into()),
        maintenance_database_role: Some("rudder_analytics_rollup".into()),
        report_database_role: Some("rudder_analytics_reader".into()),
        schema: SCHEMA.into(),
        host: IpAddr::V4(Ipv4Addr::LOCALHOST),
        port,
        identity_public_key: vec![0; 32],
        identity_issuer: "https://identity.test".into(),
        identity_key_id: "test-key".into(),
        anonymous_authorization: Some(ANONYMOUS_AUTHORIZATION.into()),
        report_secret: Some(REPORT_SECRET.into()),
        revoke_secret: None,
        consent_sync_secret: None,
        retention_days: 90,
        privacy_threshold: 3,
        rollup_interval_ms: 1000,
    };
    let StartedCollector {
        server,
        handle,
        pools,
        maintenance_task,
    } = start(config)
        .await
        .map_err(|error| format!("start collector: {error}"))?;
    let server_task = tokio::spawn(server);

    let result = exercise_loopback(
        port,
        &admin,
        &main,
        &zero,
        &suppressed,
        &expired_day,
        &main_day,
    )
    .await;

    handle.stop(true).await;
    maintenance_task.abort();
    pools.close().await;
    let server_result = server_task.await;
    if let Err(error) = server_result {
        return Err(format!("collector server task: {error}"));
    }
    match result {
        Ok(outcome) => {
            exercise_retention_cutoff_boundary(&admin, &maintenance_probe, &main[0].id, now)
                .await?;
            Ok(outcome)
        }
        Err(error) => Err(error),
    }
}

async fn exercise_retention_cutoff_boundary(
    admin: &PgPool,
    maintenance: &PgPool,
    installation_id: &str,
    now: OffsetDateTime,
) -> TestResult<()> {
    let submillisecond = 456_789;
    let boundary_now = now
        .replace_nanosecond(now.nanosecond() / 1_000_000 * 1_000_000 + submillisecond)
        .map_err(|error| error.to_string())?;
    let cutoff = boundary_now - Duration::days(90) - Duration::nanoseconds(submillisecond.into());
    let before = cutoff - Duration::microseconds(1);
    let after = cutoff + Duration::microseconds(1);
    let before_id = seed_retention_boundary_event(admin, installation_id, before).await?;
    let at_id = seed_retention_boundary_event(admin, installation_id, cutoff).await?;
    let after_id = seed_retention_boundary_event(admin, installation_id, after).await?;

    let result = run_maintenance_at(maintenance, 90, 3, boundary_now)
        .await
        .map_err(|error| format!("run exact-cutoff maintenance: {error}"))?;
    if result.deleted_raw_events != 1 {
        return Err(format!(
            "expected only the pre-cutoff raw event to expire, deleted {}",
            result.deleted_raw_events
        ));
    }
    let mut observed = Vec::new();
    for (event_id, expected) in [(&before_id, false), (&at_id, true), (&after_id, true)] {
        let exists: bool = sqlx::query_scalar(&format!(
            "SELECT EXISTS (SELECT 1 FROM {EVENTS} WHERE event_id=$1::uuid)"
        ))
        .bind(event_id)
        .fetch_one(admin)
        .await
        .map_err(|error| error.to_string())?;
        if exists != expected {
            return Err(format!(
                "raw retention boundary mismatch for {event_id}: expected exists={expected}, got {exists}"
            ));
        }
        observed.push(exists);
    }
    println!(
        "raw retention cutoff={} before={} exists={} at={} exists={} after={} exists={} deleted_raw_events={}",
        format_time(cutoff)?,
        before_id,
        observed[0],
        at_id,
        observed[1],
        after_id,
        observed[2],
        result.deleted_raw_events
    );
    Ok(())
}

async fn seed_retention_boundary_event(
    admin: &PgPool,
    installation_id: &str,
    occurred_at: OffsetDateTime,
) -> TestResult<String> {
    let event_id = next_event_id();
    let timestamp = format_time(occurred_at)?;
    sqlx::query(&format!(
        "INSERT INTO {EVENTS} (event_id, installation_id, event_name, schema_version, occurred_at, effective_at, environment, app_version, release_channel, deployment_mode, actor_kind, origin, properties, confidence, is_backfill, late, consent_version, consent_epoch, payload_sha256) VALUES ($1::uuid, $2, 'organization_created', 1, $3::timestamptz, $3::timestamptz, 'production', 'test', 'stable', 'desktop_local', 'user', 'human', '{{}}'::jsonb, 'exact', true, true, 'test-v1', 1, repeat('c', 64))"
    ))
    .bind(&event_id)
    .bind(installation_id)
    .bind(timestamp)
    .execute(admin)
    .await
    .map_err(|error| error.to_string())?;
    Ok(event_id)
}

async fn exercise_loopback(
    port: u16,
    admin: &PgPool,
    main: &[Installation],
    zero: &[Installation],
    suppressed: &[Installation],
    expired_day: &str,
    main_day: &str,
) -> TestResult<Outcome> {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let health = request_json(address, "GET", "/healthz", vec![], None).await?;
    require_status(&health, 200, "health")?;
    println!("collector health GET /healthz status={}", health.status);

    for installation in main.iter().chain(zero).chain(suppressed) {
        let response = request_json(
            address,
            "POST",
            "/api/analytics/v1/internal/anonymous/consent",
            vec![(
                "x-rudder-telemetry-anonymous-authorization".into(),
                ANONYMOUS_AUTHORIZATION.into(),
            )],
            Some(json!({
                "installationId": installation.id,
                "pseudonymousInstallationId": installation.pseudonymous_id,
                "consentVersion": "test-v1",
                "consentEpoch": 1,
                "revoked": false
            })),
        )
        .await?;
        require_status(&response, 200, "anonymous consent")?;
        sqlx::query(&format!(
            "UPDATE {INSTALLATIONS} SET first_seen_at=$2::timestamptz, last_seen_at=$2::timestamptz WHERE installation_id=$1"
        ))
        .bind(&installation.id)
        .bind(format_time(installation.first_seen_at)?)
        .execute(admin)
        .await
        .map_err(|error| error.to_string())?;
        if main.iter().any(|candidate| candidate.id == installation.id) {
            seed_rollup(admin, installation, main_day, installation.first_seen_at).await?;
        }
    }

    let mut accepted_events = 0;
    for (index, installation) in main.iter().enumerate() {
        let ages: &[Duration] = match index {
            0 => &[Duration::days(7), Duration::days(28)],
            1 => &[
                Duration::days(13) + Duration::hours(23) + Duration::minutes(59),
                Duration::days(34) + Duration::hours(23) + Duration::minutes(59),
            ],
            3 => &[Duration::days(14), Duration::days(35)],
            _ => &[],
        };
        let events = ages
            .iter()
            .map(|age| work_loop_event(installation, installation.first_seen_at + *age))
            .collect::<Vec<_>>();
        if !events.is_empty() {
            accepted_events += ingest_events(address, installation, events).await?;
        }
    }
    for installation in zero.iter().chain(suppressed) {
        accepted_events += ingest_events(
            address,
            installation,
            vec![human_work_started_event(
                installation,
                installation.first_seen_at,
            )],
        )
        .await?;
    }

    let from_day = expired_day;
    let to_day = OffsetDateTime::now_utc().date().to_string();
    let path = format!("/api/analytics/v1/report?from={from_day}T00:00:00Z&to={to_day}T23:59:59Z");
    let mut report = Value::Null;
    let mut ready = false;
    for _ in 0..80 {
        let response = request_json(
            address,
            "GET",
            &path,
            vec![("authorization".into(), format!("Bearer {REPORT_SECRET}"))],
            None,
        )
        .await?;
        require_status(&response, 200, "report")?;
        report = response.body;
        let rows = report["retention"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let has_all = [main_day]
            .iter()
            .all(|day| find_cohort(rows, day).is_some())
            && zero.first().is_some_and(|installation| {
                find_cohort(rows, &installation.first_seen_at.date().to_string()).is_some()
            })
            && suppressed.first().is_some_and(|installation| {
                find_cohort(rows, &installation.first_seen_at.date().to_string()).is_some()
            });
        if has_all {
            ready = true;
            break;
        }
        sleep(StdDuration::from_millis(250)).await;
    }
    if !ready {
        return Err("loopback report did not expose all fixture cohorts after maintenance".into());
    }

    let cutoff_day_now = (OffsetDateTime::now_utc().date() - Duration::days(90)).to_string();
    let cutoff_rows = read_cohort_aggregates(admin, &cutoff_day_now).await?;
    let expired_counts = vec![
        count_for(admin, EVENTS, "installation_id", "expired").await?,
        count_for(admin, ROLLUPS, "installation_id", "expired").await?,
        count_for(admin, AGGREGATES, "metric_name", "test_expired_retention").await?,
        count_for(admin, QUALITY, "day", expired_day).await?,
        count_for(admin, REVISIONS, "installation_id", "expired").await?,
    ];

    Ok(Outcome {
        report,
        main_day: main_day.to_owned(),
        zero_day: zero[0]
            .first_seen_at
            .to_offset(UtcOffset::UTC)
            .date()
            .to_string(),
        suppressed_day: suppressed[0]
            .first_seen_at
            .to_offset(UtcOffset::UTC)
            .date()
            .to_string(),
        expired_counts,
        cutoff_rows,
        accepted_events,
    })
}

async fn ingest_events(
    address: SocketAddr,
    installation: &Installation,
    events: Vec<Value>,
) -> TestResult<usize> {
    let expected = events.len();
    let response = request_json(
        address,
        "POST",
        "/api/analytics/v1/events:batch",
        vec![
            (
                "authorization".into(),
                format!("Bearer {ANONYMOUS_AUTHORIZATION}"),
            ),
            ("x-rudder-installation-id".into(), installation.id.clone()),
            (
                "x-rudder-telemetry-consent-version".into(),
                "test-v1".into(),
            ),
            ("x-rudder-telemetry-consent-epoch".into(), "1".into()),
            (
                "x-rudder-telemetry-pseudonymous-installation-id".into(),
                installation.pseudonymous_id.clone(),
            ),
        ],
        Some(json!({"events": events})),
    )
    .await?;
    require_status(&response, 200, "event batch")?;
    let accepted = response.body["accepted"].as_u64().unwrap_or_default() as usize;
    let rejected = response.body["rejected"].as_array().map_or(0, Vec::len);
    if accepted != expected || rejected != 0 {
        return Err(format!("event batch was not accepted: {}", response.body));
    }
    Ok(accepted)
}

fn work_loop_event(installation: &Installation, occurred_at: OffsetDateTime) -> Value {
    let event_id = next_event_id();
    json!({
        "eventId": event_id,
        "eventName": "work_loop_completed",
        "schemaVersion": 1,
        "occurredAt": format_time(occurred_at).expect("format completion timestamp"),
        "environment": "production",
        "appVersion": "test",
        "releaseChannel": "stable",
        "deploymentMode": "desktop_local",
        "actorKind": "user",
        "origin": "human",
        "pseudonymousInstallationId": installation.pseudonymous_id,
        "pseudonymousOrgId": format!("{:064x}", 1),
        "pseudonymousWorkId": format!("{:064x}", 2),
        "pseudonymousWorkCycleId": format!("cycle-{event_id}"),
        "pseudonymousRootRunId": Value::Null,
        "pseudonymousRunId": Value::Null,
        "completionRevision": 1,
        "properties": {},
        "confidence": "exact",
        "isBackfill": true
    })
}

fn human_work_started_event(installation: &Installation, occurred_at: OffsetDateTime) -> Value {
    json!({
        "eventId": next_event_id(),
        "eventName": "human_work_started",
        "schemaVersion": 1,
        "occurredAt": format_time(occurred_at).expect("format activity timestamp"),
        "environment": "production",
        "appVersion": "test",
        "releaseChannel": "stable",
        "deploymentMode": "desktop_local",
        "actorKind": "user",
        "origin": "human",
        "pseudonymousInstallationId": installation.pseudonymous_id,
        "pseudonymousOrgId": Value::Null,
        "pseudonymousWorkId": Value::Null,
        "pseudonymousWorkCycleId": Value::Null,
        "pseudonymousRootRunId": Value::Null,
        "pseudonymousRunId": Value::Null,
        "completionRevision": Value::Null,
        "properties": {"work_surface": "issue"},
        "confidence": "exact",
        "isBackfill": true
    })
}

fn next_event_id() -> String {
    let id = EVENT_ID.fetch_add(1, Ordering::Relaxed);
    format!("00000000-0000-4000-8000-{id:012x}")
}

fn make_installations(
    cohort: &str,
    count: usize,
    first_seen_at: OffsetDateTime,
    run_id: u128,
) -> Vec<Installation> {
    (0..count)
        .map(|index| {
            let identity = format!("{run_id:x}-{cohort}-{index}");
            Installation {
                id: format!("collector-test-{identity}"),
                pseudonymous_id: format!("{:064x}", index + cohort_number(cohort)),
                first_seen_at,
            }
        })
        .collect()
}

fn cohort_number(cohort: &str) -> usize {
    match cohort {
        "main" => 100,
        "zero" => 200,
        _ => 300,
    }
}

async fn seed_cutoff_cohort(
    admin: &PgPool,
    day: &str,
    run_id: u128,
    ordinal: usize,
) -> TestResult<()> {
    let first_seen_at = OffsetDateTime::parse(&format!("{day}T00:00:00Z"), &Rfc3339)
        .map_err(|error| error.to_string())?;
    let installations = make_installations("cutoff", 3, first_seen_at, run_id + ordinal as u128);
    for installation in &installations {
        sqlx::query(&format!(
            "INSERT INTO {INSTALLATIONS} (installation_id, mode, consent_version, consent_epoch, revoked, first_seen_at, last_seen_at, updated_at) VALUES ($1, 'anonymous', 'test-v1', 1, false, $2::timestamptz, $2::timestamptz, now())"
        ))
        .bind(&installation.id)
        .bind(format_time(first_seen_at)?)
        .execute(admin)
        .await
        .map_err(|error| error.to_string())?;
        seed_rollup(admin, installation, day, first_seen_at).await?;
    }
    Ok(())
}

async fn seed_rollup(
    admin: &PgPool,
    installation: &Installation,
    day: &str,
    occurred_at: OffsetDateTime,
) -> TestResult<()> {
    let dimensions = json!({
        "environment": "production",
        "app_version": "test",
        "release_channel": "stable",
        "deployment_mode": "desktop_local",
        "confidence": "exact",
        "analytics_mode": "anonymous"
    });
    sqlx::query(&format!(
        "INSERT INTO {ROLLUPS} (day, installation_id, event_name, origin, dimension_hash, dimensions, event_count, first_occurred_at, last_occurred_at, updated_at) VALUES ($1::date, $2, 'human_work_started', 'human', $3, $4::jsonb, 1, $5::timestamptz, $5::timestamptz, now())"
    ))
    .bind(day)
    .bind(&installation.id)
    .bind(&installation.pseudonymous_id)
    .bind(dimensions.to_string())
    .bind(format_time(occurred_at)?)
    .execute(admin)
    .await
    .map_err(|error| error.to_string())?;
    sqlx::query(&format!(
        "INSERT INTO {EVENTS} (event_id, installation_id, event_name, schema_version, occurred_at, effective_at, environment, app_version, release_channel, deployment_mode, actor_kind, origin, properties, confidence, is_backfill, late, consent_version, consent_epoch, payload_sha256) VALUES ($1::uuid, $2, 'human_work_started', 1, $3::timestamptz, $3::timestamptz, 'production', 'test', 'stable', 'desktop_local', 'user', 'human', '{{}}'::jsonb, 'exact', true, true, 'test-v1', 1, repeat('c', 64))"
    ))
    .bind(next_event_id())
    .bind(&installation.id)
    .bind(format_time(occurred_at)?)
    .execute(admin)
    .await
    .map_err(|error| error.to_string())?;
    sqlx::query(&format!(
        "UPDATE {INSTALLATIONS} SET first_observed_event_at = LEAST(COALESCE(first_observed_event_at, $2::timestamptz), $2::timestamptz) WHERE installation_id = $1"
    ))
    .bind(&installation.id)
    .bind(format_time(occurred_at)?)
    .execute(admin)
    .await
    .map_err(|error| error.to_string())?;
    Ok(())
}

async fn seed_expired_projection(
    admin: &PgPool,
    day: &str,
    now: OffsetDateTime,
    run_id: u128,
) -> TestResult<()> {
    let installation_id = format!("collector-test-expired-{run_id:x}");
    let occurred_at = now - Duration::days(91);
    let occurred_at_text = format_time(occurred_at)?;
    sqlx::query(&format!(
        "INSERT INTO {INSTALLATIONS} (installation_id, mode, consent_version, consent_epoch, revoked, first_seen_at, last_seen_at, updated_at) VALUES ($1, 'anonymous', 'test-v1', 1, false, $2::timestamptz, $2::timestamptz, now())"
    ))
    .bind(&installation_id)
    .bind(&occurred_at_text)
    .execute(admin)
    .await
    .map_err(|error| error.to_string())?;
    sqlx::query(&format!(
        "INSERT INTO {EVENTS} (event_id, installation_id, event_name, schema_version, occurred_at, effective_at, environment, app_version, release_channel, deployment_mode, actor_kind, origin, properties, confidence, is_backfill, late, consent_version, consent_epoch, payload_sha256) VALUES ($1::uuid, $2, 'organization_created', 1, $3::timestamptz, $3::timestamptz, 'production', 'test', 'stable', 'desktop_local', 'user', 'human', '{{}}'::jsonb, 'exact', true, true, 'test-v1', 1, repeat('b', 64))"
    ))
    .bind(next_event_id())
    .bind(&installation_id)
    .bind(&occurred_at_text)
    .execute(admin)
    .await
    .map_err(|error| error.to_string())?;
    sqlx::query(&format!(
        "INSERT INTO {REVISIONS} (installation_id, pseudonymous_work_cycle_id, completion_revision, completion_event_id, completed_at, environment, release_channel, origin, is_internal, confidence, updated_at) VALUES ($1, 'expired-cycle', 1, 'expired-event', $2::timestamptz, 'production', 'stable', 'human', false, 'exact', now())"
    ))
    .bind(&installation_id)
    .bind(&occurred_at_text)
    .execute(admin)
    .await
    .map_err(|error| error.to_string())?;
    let expired = Installation {
        id: installation_id,
        pseudonymous_id: format!("{:064x}", 900),
        first_seen_at: occurred_at,
    };
    seed_rollup(admin, &expired, day, occurred_at).await?;
    sqlx::query(&format!(
        "INSERT INTO {AGGREGATES} (day, metric_name, dimension_set_version, dimension_hash, dimension_values, metric_value, contributing_installations, privacy_threshold, created_at, updated_at) VALUES ($1::date, 'test_expired_retention', 1, repeat('a', 64), '{{}}'::jsonb, 1, 3, 3, now(), now())"
    ))
    .bind(day)
    .execute(admin)
    .await
    .map_err(|error| error.to_string())?;
    sqlx::query(&format!(
        "INSERT INTO {QUALITY} (day, received_batches, accepted_events, duplicate_events, rejected_events, late_events, updated_at) VALUES ($1::date, 1, 1, 0, 0, 0, now())"
    ))
    .bind(day)
    .execute(admin)
    .await
    .map_err(|error| error.to_string())?;
    Ok(())
}

async fn read_cohort_aggregates(
    admin: &PgPool,
    cohort_day: &str,
) -> TestResult<Vec<(String, String, i64, i64)>> {
    let rows = sqlx::query(&format!(
        "SELECT dimension_values->>'cohort_day' AS cohort_day, dimension_values->>'window' AS window, metric_value::bigint AS metric_value, contributing_installations::bigint AS contributing_installations FROM {AGGREGATES} WHERE metric_name='work_loop_retention' AND dimension_values->>'cohort_day'=$1 ORDER BY dimension_values->>'window'"
    ))
    .bind(cohort_day)
    .fetch_all(admin)
    .await
    .map_err(|error| error.to_string())?;
    rows.into_iter()
        .map(|row| {
            Ok((
                row.try_get("cohort_day")
                    .map_err(|error| error.to_string())?,
                row.try_get("window").map_err(|error| error.to_string())?,
                row.try_get("metric_value")
                    .map_err(|error| error.to_string())?,
                row.try_get("contributing_installations")
                    .map_err(|error| error.to_string())?,
            ))
        })
        .collect()
}

async fn count_for(pool: &PgPool, table: &str, column: &str, value: &str) -> TestResult<i64> {
    let query = format!("SELECT count(*)::bigint FROM {table} WHERE {column}::text LIKE $1");
    sqlx::query_scalar(&query)
        .bind(format!("%{value}%"))
        .fetch_one(pool)
        .await
        .map_err(|error| error.to_string())
}

async fn request_json(
    address: SocketAddr,
    method: &str,
    path: &str,
    headers: Vec<(String, String)>,
    body: Option<Value>,
) -> TestResult<HttpResponse> {
    let method = method.to_owned();
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let body = body
            .map(|body| serde_json::to_vec(&body).map_err(|error| error.to_string()))
            .transpose()?
            .unwrap_or_default();
        let mut stream = TcpStream::connect_timeout(&address, StdDuration::from_secs(3))
            .map_err(|error| error.to_string())?;
        stream
            .set_read_timeout(Some(StdDuration::from_secs(5)))
            .map_err(|error| error.to_string())?;
        write!(
            stream,
            "{method} {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n"
        )
        .map_err(|error| error.to_string())?;
        if !body.is_empty() {
            write!(
                stream,
                "Content-Type: application/json\r\nContent-Length: {}\r\n",
                body.len()
            )
            .map_err(|error| error.to_string())?;
        }
        for (name, value) in headers {
            write!(stream, "{name}: {value}\r\n").map_err(|error| error.to_string())?;
        }
        stream
            .write_all(b"\r\n")
            .map_err(|error| error.to_string())?;
        stream.write_all(&body).map_err(|error| error.to_string())?;
        let mut response = Vec::new();
        stream
            .read_to_end(&mut response)
            .map_err(|error| error.to_string())?;
        parse_response(&response)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn parse_response(response: &[u8]) -> TestResult<HttpResponse> {
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "malformed HTTP response headers".to_owned())?;
    let headers = std::str::from_utf8(&response[..split]).map_err(|error| error.to_string())?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "malformed HTTP status".to_owned())?;
    let body = &response[split + 4..];
    let body = if headers
        .lines()
        .any(|line| line.eq_ignore_ascii_case("transfer-encoding: chunked"))
    {
        decode_chunked(body)?
    } else {
        body.to_vec()
    };
    let body = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body).map_err(|error| error.to_string())?
    };
    Ok(HttpResponse { status, body })
}

fn decode_chunked(mut bytes: &[u8]) -> TestResult<Vec<u8>> {
    let mut output = Vec::new();
    loop {
        let line_end = bytes
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or_else(|| "malformed chunked response".to_owned())?;
        let length = usize::from_str_radix(
            std::str::from_utf8(&bytes[..line_end]).map_err(|error| error.to_string())?,
            16,
        )
        .map_err(|error| error.to_string())?;
        bytes = &bytes[line_end + 2..];
        if length == 0 {
            return Ok(output);
        }
        if bytes.len() < length + 2 || &bytes[length..length + 2] != b"\r\n" {
            return Err("malformed chunked response body".into());
        }
        output.extend_from_slice(&bytes[..length]);
        bytes = &bytes[length + 2..];
    }
}

fn require_status(response: &HttpResponse, expected: u16, action: &str) -> TestResult<()> {
    if response.status != expected {
        return Err(format!(
            "{action} returned HTTP {}: {}",
            response.status, response.body
        ));
    }
    Ok(())
}

fn format_time(value: OffsetDateTime) -> TestResult<String> {
    value.format(&Rfc3339).map_err(|error| error.to_string())
}

fn required_env(name: &str) -> TestResult<String> {
    env::var(name).map_err(|_| format!("missing required test fixture variable {name}"))
}

async fn connect(url: &str) -> TestResult<PgPool> {
    PgPool::connect(url)
        .await
        .map_err(|error| format!("database connection failed: {error}"))
}

async fn verify_local_test_database(
    pool: &PgPool,
    expected_role: &str,
) -> TestResult<(String, String)> {
    let row = sqlx::query(
        "SELECT current_database()::text AS database, inet_server_addr()::text AS address, current_user::text AS role",
    )
    .fetch_one(pool)
    .await
    .map_err(|error| error.to_string())?;
    let database: String = row.try_get("database").map_err(|error| error.to_string())?;
    let address: Option<String> = row.try_get("address").map_err(|error| error.to_string())?;
    let role: String = row.try_get("role").map_err(|error| error.to_string())?;
    if !database.starts_with("rudder_analytics_test_") || role != expected_role {
        return Err("fixture must use the named isolated test database and role".into());
    }
    if !address
        .as_deref()
        .is_some_and(|value| value == "::1" || value.starts_with("127."))
    {
        return Err("fixture PostgreSQL must be reached through a loopback TCP address".into());
    }
    Ok((database, address.unwrap_or_default()))
}

async fn verify_same_database(
    pool: &PgPool,
    expected: &(String, String),
    expected_role: &str,
) -> TestResult<()> {
    let row = sqlx::query(
        "SELECT current_database()::text AS database, inet_server_addr()::text AS address, current_user::text AS role",
    )
    .fetch_one(pool)
    .await
    .map_err(|error| error.to_string())?;
    let database: String = row.try_get("database").map_err(|error| error.to_string())?;
    let address: Option<String> = row.try_get("address").map_err(|error| error.to_string())?;
    let role: String = row.try_get("role").map_err(|error| error.to_string())?;
    if database != expected.0
        || address.as_deref() != Some(expected.1.as_str())
        || role != expected_role
    {
        return Err("collector roles must share the verified disposable local database".into());
    }
    Ok(())
}

async fn verify_migration_history(migrator: &PgPool) -> TestResult<()> {
    let tags: Vec<String> = sqlx::query_scalar(
        "SELECT tag FROM rudder_analytics._product_analytics_migrations ORDER BY tag",
    )
    .fetch_all(migrator)
    .await
    .map_err(|error| error.to_string())?;
    let expected = vec![
        "0140_faulty_kitty_pryde.sql",
        "0141_product_analytics_revision_origin.sql",
        "0142_product_analytics_quality_counters.sql",
        "rust_product_analytics_collector_first_observed_event.sql",
        "rust_product_analytics_collector_role_capabilities.sql",
    ];
    if tags.iter().map(String::as_str).collect::<Vec<_>>() != expected {
        return Err(format!("Rust migration history mismatch: {tags:?}"));
    }
    Ok(())
}

async fn verify_role_grants(admin: &PgPool) -> TestResult<()> {
    for role in [
        "rudder_analytics_migrator",
        "rudder_analytics_collector",
        "rudder_analytics_rollup",
        "rudder_analytics_reader",
    ] {
        let has_usage: bool =
            sqlx::query_scalar("SELECT has_schema_privilege($1, 'rudder_analytics', 'USAGE')")
                .bind(role)
                .fetch_one(admin)
                .await
                .map_err(|error| error.to_string())?;
        if !has_usage {
            return Err(format!("{role} lacks analytics schema USAGE"));
        }
    }

    for (role, table, privilege, expected) in [
        ("rudder_analytics_collector", EVENTS, "INSERT", true),
        ("rudder_analytics_collector", EVENTS, "DELETE", false),
        ("rudder_analytics_rollup", EVENTS, "SELECT", true),
        ("rudder_analytics_rollup", EVENTS, "INSERT", false),
        ("rudder_analytics_rollup", EVENTS, "UPDATE", false),
        ("rudder_analytics_rollup", EVENTS, "DELETE", false),
        ("rudder_analytics_rollup", INSTALLATIONS, "SELECT", true),
        ("rudder_analytics_rollup", INSTALLATIONS, "INSERT", false),
        ("rudder_analytics_rollup", INSTALLATIONS, "UPDATE", false),
        ("rudder_analytics_rollup", INSTALLATIONS, "DELETE", false),
        ("rudder_analytics_rollup", SUBJECTS, "SELECT", false),
        ("rudder_analytics_rollup", SUBJECTS, "INSERT", false),
        ("rudder_analytics_rollup", SUBJECTS, "UPDATE", false),
        ("rudder_analytics_rollup", SUBJECTS, "DELETE", false),
        ("rudder_analytics_rollup", QUALITY, "SELECT", true),
        ("rudder_analytics_rollup", QUALITY, "DELETE", true),
        ("rudder_analytics_rollup", QUALITY, "INSERT", false),
        ("rudder_analytics_rollup", QUALITY, "UPDATE", false),
        ("rudder_analytics_rollup", REVISIONS, "DELETE", true),
        ("rudder_analytics_reader", ROLLUPS, "SELECT", true),
        ("rudder_analytics_reader", AGGREGATES, "SELECT", true),
        ("rudder_analytics_reader", QUALITY, "SELECT", true),
        ("rudder_analytics_reader", EVENTS, "SELECT", false),
        ("rudder_analytics_reader", INSTALLATIONS, "SELECT", false),
        ("rudder_analytics_reader", SUBJECTS, "SELECT", false),
        ("rudder_analytics_reader", REVISIONS, "SELECT", false),
    ] {
        let actual: bool = sqlx::query_scalar("SELECT has_table_privilege($1, $2, $3)")
            .bind(role)
            .bind(table)
            .bind(privilege)
            .fetch_one(admin)
            .await
            .map_err(|error| error.to_string())?;
        if actual != expected {
            return Err(format!(
                "unexpected {privilege} privilege for {role} on {table}: {actual}"
            ));
        }
    }
    for (role, function, expected) in [
        (
            "rudder_analytics_collector",
            "rudder_analytics.expire_product_analytics_raw_events(timestamptz)",
            true,
        ),
        (
            "rudder_analytics_collector",
            "rudder_analytics.erase_product_analytics_installation(text)",
            true,
        ),
        (
            "rudder_analytics_collector",
            "rudder_analytics.erase_product_analytics_subject(text)",
            true,
        ),
        (
            "rudder_analytics_rollup",
            "rudder_analytics.expire_product_analytics_raw_events(timestamptz)",
            false,
        ),
        (
            "rudder_analytics_rollup",
            "rudder_analytics.erase_product_analytics_installation(text)",
            false,
        ),
        (
            "rudder_analytics_rollup",
            "rudder_analytics.erase_product_analytics_subject(text)",
            false,
        ),
    ] {
        let executable: bool =
            sqlx::query_scalar("SELECT has_function_privilege($1, $2, 'EXECUTE')")
                .bind(role)
                .bind(function)
                .fetch_one(admin)
                .await
                .map_err(|error| error.to_string())?;
        if executable != expected {
            return Err(format!(
                "unexpected EXECUTE privilege for {role} on {function}: {executable}"
            ));
        }
        let public_executable: bool =
            sqlx::query_scalar("SELECT has_function_privilege('public', $1, 'EXECUTE')")
                .bind(function)
                .fetch_one(admin)
                .await
                .map_err(|error| error.to_string())?;
        if public_executable {
            return Err(format!("PUBLIC can execute {function}"));
        }
    }
    Ok(())
}

async fn ensure_empty_fixture(admin: &PgPool) -> TestResult<()> {
    for table in [
        EVENTS,
        INSTALLATIONS,
        SUBJECTS,
        ROLLUPS,
        AGGREGATES,
        QUALITY,
        REVISIONS,
    ] {
        let rows: i64 = sqlx::query_scalar(&format!("SELECT count(*)::bigint FROM {table}"))
            .fetch_one(admin)
            .await
            .map_err(|error| error.to_string())?;
        if rows != 0 {
            return Err(format!("disposable fixture table {table} must start empty"));
        }
    }
    Ok(())
}
