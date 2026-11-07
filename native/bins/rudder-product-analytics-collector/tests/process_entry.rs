#![cfg(unix)]

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{
    env, fs,
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    thread,
    time::Duration as StdDuration,
};
use tempfile::TempDir;
use time::{Date, Duration, OffsetDateTime, Time, format_description::well_known::Rfc3339};

const EVENTS: &str = "rudder_analytics.product_analytics_collector_events";
const INSTALLATIONS: &str = "rudder_analytics.product_analytics_collector_installations";
const SUBJECTS: &str = "rudder_analytics.product_analytics_collector_subjects";
const DAILY_ROLLUPS: &str = "rudder_analytics.product_analytics_collector_daily_rollups";
const REPORT_SECRET: &str = "local-process-test-report-secret";
const ANONYMOUS_AUTHORIZATION: &str = "local-process-test-anonymous-secret";
const IDENTITY_PUBLIC_KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hashed_binary_migrates_and_serves_real_loopback_report() {
    let binary = PathBuf::from(env!("CARGO_BIN_EXE_rudder-product-analytics-collector"));
    let digest = Sha256::digest(fs::read(&binary).expect("read compiled collector binary"));
    let binary_sha256 = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    println!(
        "collector_binary={} sha256={binary_sha256}",
        binary.display()
    );

    let postgres = PostgresHarness::start();
    let admin = connect(&postgres.admin_url).await;
    create_runtime_roles(&admin).await;
    run_migrations(&binary, &postgres.admin_url);
    verify_rollup_capabilities(&admin, &postgres).await;
    verify_startup_rejects_privilege_drift(&binary, &postgres, &binary_sha256, &admin).await;

    let now = OffsetDateTime::now_utc();
    let today = now.date();
    let report_from = today - Duration::days(70);
    seed_metric_window(&admin, now, today).await;
    seed_retention_cohorts(&admin, now, today).await;
    let (consent_cohort_day, first_event_cohort_day) =
        seed_consent_before_event_cohort(&admin, today).await;
    seed_two_subject_rollup_events(&admin, now).await;

    let listener_port = unused_loopback_port();
    let mut process = CollectorProcess::spawn(&binary, &postgres, listener_port, &binary_sha256);
    let address = SocketAddr::from(([127, 0, 0, 1], listener_port));
    let health = wait_for_health(&mut process, address);
    assert_eq!(health["service"], "product-analytics-collector");

    let live_id = "loopback-ingested-installation";
    let live_pseudo = format!("{:064x}", 9001);
    let consent = request_json(
        address,
        "POST",
        "/api/analytics/v1/internal/anonymous/consent",
        vec![(
            "x-rudder-telemetry-anonymous-authorization",
            ANONYMOUS_AUTHORIZATION,
        )],
        Some(json!({
            "installationId": live_id,
            "pseudonymousInstallationId": live_pseudo,
            "consentVersion": "process-test-v1",
            "consentEpoch": 1,
            "revoked": false
        })),
    );
    assert_eq!(consent.0, 200, "consent response: {}", consent.1);

    let event_id = event_uuid(90_001);
    let batch = request_json(
        address,
        "POST",
        "/api/analytics/v1/events:batch",
        vec![
            ("authorization", ANONYMOUS_AUTHORIZATION),
            ("x-rudder-installation-id", live_id),
            ("x-rudder-telemetry-consent-version", "process-test-v1"),
            ("x-rudder-telemetry-consent-epoch", "1"),
            (
                "x-rudder-telemetry-pseudonymous-installation-id",
                &live_pseudo,
            ),
        ],
        Some(json!({"events": [human_work_started_event(&event_id, &live_pseudo, now)]})),
    );
    assert_eq!(batch.0, 200, "batch response: {}", batch.1);
    assert_eq!(batch.1["accepted"], 1);
    assert_eq!(batch.1["rejected"].as_array().map(Vec::len), Some(0));
    let first_observed_event_matches: bool = sqlx::query_scalar(&format!(
        "SELECT first_observed_event_at = $2::timestamptz FROM {INSTALLATIONS} WHERE installation_id = $1"
    ))
    .bind(live_id)
    .bind(format_time(now))
    .fetch_one(&admin)
    .await
    .expect("read first production event timestamp persisted during ingestion");
    assert!(
        first_observed_event_matches,
        "ingestion must persist the event timestamp, not the consent timestamp"
    );

    let path =
        format!("/api/analytics/v1/report?from={report_from}T00:00:00Z&to={today}T23:59:59.999Z");
    let mut report = Value::Null;
    for _ in 0..80 {
        let response = request_json(
            address,
            "GET",
            &path,
            vec![("authorization", &format!("Bearer {REPORT_SECRET}"))],
            None,
        );
        assert_eq!(response.0, 200, "report response: {}", response.1);
        report = response.1;
        let retention = report["retention"].as_array().expect("retention array");
        if report["quality"]["acceptedEventCount"] == 1
            && report["metrics"]["meaningfulActiveInstallations1d"] == 2
            && report["metrics"]["meaningfulActiveInstallations7d"] == 5
            && retention
                .iter()
                .any(|row| row["cohortDay"] == first_event_cohort_day)
        {
            break;
        }
        thread::sleep(StdDuration::from_millis(100));
    }

    let metrics = &report["metrics"];
    assert_eq!(metrics["meaningfulActiveInstallations1d"], 2);
    assert_eq!(metrics["meaningfulActiveInstallations7d"], 5);
    assert_eq!(
        metrics["meaningfulDau"],
        metrics["meaningfulActiveInstallations1d"]
    );
    assert_eq!(report["metricStatus"]["meaningfulDau"], "in_progress");
    assert_eq!(
        report["metricStatus"]["meaningfulActiveInstallations1d"],
        "in_progress"
    );
    assert_eq!(
        report["metricSemantics"]["meaningfulDau"],
        "installation_level_24_hour_proxy_not_account_dau"
    );
    assert_eq!(
        report["metricSemantics"]["dauStatus"],
        "in_progress_until_window_to_utc_day_is_complete"
    );
    assert_eq!(
        report["metricSemantics"]["retentionMaturity"],
        "latest_exact_first_observed_production_event_in_utc_cohort_plus_window_must_be_at_or_before_window_to_utc_day_end"
    );
    assert_eq!(
        report["metricSemantics"]["retentionCohort"],
        "utc_calendar_day_of_first_observed_production_event"
    );
    assert_eq!(
        report["metricSemantics"]["meaningfulW1"],
        "meaningful_activity_at_age_days_gte_7_and_lt_14_from_first_observed_production_event"
    );
    assert_eq!(
        report["metricSemantics"]["loopW4"],
        "valid_work_loop_completion_at_age_days_gte_28_and_lt_35_from_first_observed_production_event"
    );

    let cohorts = report["retention"].as_array().expect("retention array");
    assert!(
        !cohorts
            .iter()
            .any(|row| row["cohortDay"] == consent_cohort_day),
        "consent timestamp must not create an exact retention cohort: {cohorts:?}"
    );
    let consent_before_event = find_cohort(cohorts, &first_event_cohort_day);
    assert_eq!(consent_before_event["eligibleInstallations"], 2);
    assert_eq!(consent_before_event["loopW4"], Value::Null);
    assert_eq!(consent_before_event["loopW4Status"], "immature");

    let mut subject_rollup = (0_i64, 0_i64);
    for _ in 0..80 {
        subject_rollup = sqlx::query_as(&format!(
            "SELECT count(*)::bigint, coalesce(sum(event_count), 0)::bigint FROM {DAILY_ROLLUPS} WHERE installation_id='two-subject-installation' AND event_name='organization_created'"
        ))
        .fetch_one(&admin)
        .await
        .expect("read installation-level two-subject rollup");
        if subject_rollup == (1, 2) {
            break;
        }
        thread::sleep(StdDuration::from_millis(100));
    }
    assert_eq!(
        subject_rollup,
        (1, 2),
        "subjects must aggregate at installation level"
    );

    let w1_day = (today - Duration::days(20)).to_string();
    let w1 = find_cohort(cohorts, &w1_day);
    let precision_rollup: String = sqlx::query_scalar(&format!(
        "SELECT (SELECT to_char(first_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') FROM {DAILY_ROLLUPS} WHERE installation_id='w1-1' AND event_name='organization_created') || '|' || (SELECT to_char(last_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') FROM {DAILY_ROLLUPS} WHERE installation_id='w1-1' AND event_name='human_work_started')"
    ))
    .fetch_one(&admin)
    .await
    .expect("read microsecond W1 rollup timestamps");
    let second_first_seen = at_date(
        today - Duration::days(20),
        Time::from_hms(15, 0, 0).unwrap(),
    ) + Duration::nanoseconds(123_456_000);
    let just_before_w1 = second_first_seen + Duration::days(7) - Duration::microseconds(123);
    assert_eq!(
        precision_rollup,
        format!(
            "{}|{}",
            format_time(second_first_seen),
            format_time(just_before_w1)
        )
    );
    assert_eq!(w1["meaningfulW1"], 1, "cohort: {w1}");
    assert_eq!(w1["meaningfulW1Status"], "available");
    assert_eq!(w1["loopW4"], Value::Null);
    assert_eq!(w1["loopW4Status"], "immature");

    let recent_day = (today - Duration::days(2)).to_string();
    let recent = find_cohort(cohorts, &recent_day);
    assert_eq!(recent["meaningfulW1"], Value::Null);
    assert_eq!(recent["meaningfulW1Status"], "immature");
    assert_eq!(recent["loopW4"], Value::Null);
    assert_eq!(recent["loopW4Status"], "immature");

    let w4_day = (today - Duration::days(50)).to_string();
    let w4 = find_cohort(cohorts, &w4_day);
    assert_eq!(w4["loopW4"], 1);
    assert_eq!(w4["loopW4Status"], "available");

    let migrated_event_exists: bool = sqlx::query_scalar(&format!(
        "SELECT EXISTS (SELECT 1 FROM {EVENTS} WHERE event_id=$1::uuid)"
    ))
    .bind(&event_id)
    .fetch_one(&admin)
    .await
    .expect("read back accepted event through admin connection");
    assert!(migrated_event_exists);
    println!(
        "loopback_entry=PASS binary_sha256={binary_sha256} health={} batch={} metrics={} retention_w1={} retention_w4={}",
        health["ok"], batch.1["accepted"], metrics, w1, w4
    );
}

async fn create_runtime_roles(admin: &PgPool) {
    for role in [
        "rudder_analytics_collector",
        "rudder_analytics_rollup",
        "rudder_analytics_reader",
    ] {
        sqlx::query(&format!("CREATE ROLE {role} LOGIN"))
            .execute(admin)
            .await
            .expect("create disposable runtime role");
    }
}

async fn verify_startup_rejects_privilege_drift(
    binary: &Path,
    postgres: &PostgresHarness,
    binary_sha256: &str,
    admin: &PgPool,
) {
    for privilege in ["SELECT", "INSERT"] {
        sqlx::query(&format!(
            "GRANT {privilege} ON {EVENTS} TO rudder_analytics_collector WITH GRANT OPTION"
        ))
        .execute(admin)
        .await
        .expect("grant raw-event privilege option for startup regression");
        assert_startup_rejected(
            binary,
            postgres,
            binary_sha256,
            "product_analytics_database_privilege_denied",
        );
        sqlx::query(&format!(
            "REVOKE GRANT OPTION FOR {privilege} ON {EVENTS} FROM rudder_analytics_collector"
        ))
        .execute(admin)
        .await
        .expect("revoke only raw-event grant option after startup regression");

        let baseline_privilege_remains: bool = sqlx::query_scalar(&format!(
            "SELECT has_table_privilege('rudder_analytics_collector', '{EVENTS}', '{privilege}')"
        ))
        .fetch_one(admin)
        .await
        .expect("check raw-event baseline privilege after revoking grant option");
        assert!(
            baseline_privilege_remains,
            "revoking {privilege} grant option must preserve the baseline privilege"
        );
        let grant_option_remains: bool = sqlx::query_scalar(&format!(
            "SELECT has_table_privilege('rudder_analytics_collector', '{EVENTS}', '{privilege} WITH GRANT OPTION')"
        ))
        .fetch_one(admin)
        .await
        .expect("check raw-event grant option was removed");
        assert!(
            !grant_option_remains,
            "revoking {privilege} grant option must remove only that option"
        );
    }
    let accepted_port = unused_loopback_port();
    let mut accepted_process =
        CollectorProcess::spawn(binary, postgres, accepted_port, binary_sha256);
    let accepted_health = wait_for_health(
        &mut accepted_process,
        SocketAddr::from(([127, 0, 0, 1], accepted_port)),
    );
    assert_eq!(accepted_health["service"], "product-analytics-collector");

    for privilege in ["DELETE", "TRUNCATE"] {
        sqlx::query(&format!(
            "GRANT {privilege} ON {EVENTS} TO rudder_analytics_collector"
        ))
        .execute(admin)
        .await
        .expect("grant collector raw-event privilege for startup regression");
        assert_startup_rejected(
            binary,
            postgres,
            binary_sha256,
            "product_analytics_database_privilege_denied",
        );
        sqlx::query(&format!(
            "REVOKE {privilege} ON {EVENTS} FROM rudder_analytics_collector"
        ))
        .execute(admin)
        .await
        .expect("remove collector raw-event privilege after startup regression");
    }

    sqlx::query(&format!(
        "GRANT INSERT, UPDATE, DELETE, TRUNCATE ON {DAILY_ROLLUPS}, rudder_analytics.product_analytics_collector_privacy_aggregates, rudder_analytics.product_analytics_collector_quality_counters TO rudder_analytics_reader"
    ))
    .execute(admin)
    .await
    .expect("grant reader write privileges for startup regression");
    assert_startup_rejected(
        binary,
        postgres,
        binary_sha256,
        "product_analytics_database_privilege_denied",
    );
    sqlx::query(&format!(
        "REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON {DAILY_ROLLUPS}, rudder_analytics.product_analytics_collector_privacy_aggregates, rudder_analytics.product_analytics_collector_quality_counters FROM rudder_analytics_reader"
    ))
    .execute(admin)
    .await
    .expect("remove reader write privileges after startup regression");

    sqlx::query(&format!(
        "GRANT UPDATE (event_count) ON {DAILY_ROLLUPS} TO rudder_analytics_reader"
    ))
    .execute(admin)
    .await
    .expect("grant reader column-level write privilege for startup regression");
    assert_startup_rejected(
        binary,
        postgres,
        binary_sha256,
        "product_analytics_database_privilege_denied",
    );
    sqlx::query(&format!(
        "REVOKE UPDATE (event_count) ON {DAILY_ROLLUPS} FROM rudder_analytics_reader"
    ))
    .execute(admin)
    .await
    .expect("remove reader column-level write privilege after startup regression");

    sqlx::query(&format!(
        "REVOKE SELECT ON {DAILY_ROLLUPS} FROM rudder_analytics_reader"
    ))
    .execute(admin)
    .await
    .expect("remove reader table-level select for startup regression");
    sqlx::query(&format!(
        "GRANT SELECT (day) ON {DAILY_ROLLUPS} TO rudder_analytics_reader"
    ))
    .execute(admin)
    .await
    .expect("grant reader column-only select for startup regression");
    assert_startup_rejected(
        binary,
        postgres,
        binary_sha256,
        "product_analytics_database_privilege_denied",
    );
    sqlx::query(&format!(
        "REVOKE SELECT (day) ON {DAILY_ROLLUPS} FROM rudder_analytics_reader"
    ))
    .execute(admin)
    .await
    .expect("remove reader column-only select after startup regression");
    sqlx::query(&format!(
        "GRANT SELECT ON {DAILY_ROLLUPS} TO rudder_analytics_reader"
    ))
    .execute(admin)
    .await
    .expect("restore reader table-level select after startup regression");

    sqlx::query(
        "GRANT EXECUTE ON FUNCTION rudder_analytics.erase_product_analytics_installation(text) TO rudder_analytics_collector WITH GRANT OPTION",
    )
    .execute(admin)
    .await
    .expect("grant erase-function execute grant option for startup regression");
    assert_startup_rejected(
        binary,
        postgres,
        binary_sha256,
        "product_analytics_database_privilege_denied",
    );
    sqlx::query(
        "REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION rudder_analytics.erase_product_analytics_installation(text) FROM rudder_analytics_collector",
    )
    .execute(admin)
    .await
    .expect("remove erase-function execute grant option after startup regression");

    sqlx::query("CREATE ROLE rudder_analytics_unexpected_grant NOLOGIN")
        .execute(admin)
        .await
        .expect("create inherited-grant regression role");
    sqlx::raw_sql(&format!(
        "GRANT DELETE ON {EVENTS} TO rudder_analytics_unexpected_grant; GRANT rudder_analytics_unexpected_grant TO rudder_analytics_collector"
    ))
    .execute(admin)
    .await
    .expect("grant inherited raw-event privilege for startup regression");
    assert_startup_rejected(
        binary,
        postgres,
        binary_sha256,
        "product_analytics_database_privilege_denied",
    );
    sqlx::query("REVOKE rudder_analytics_unexpected_grant FROM rudder_analytics_collector")
        .execute(admin)
        .await
        .expect("remove inherited-grant membership");
    sqlx::raw_sql(&format!(
        "REVOKE DELETE ON {EVENTS} FROM rudder_analytics_unexpected_grant"
    ))
    .execute(admin)
    .await
    .expect("remove inherited raw-event privilege");
    sqlx::query("DROP ROLE rudder_analytics_unexpected_grant")
        .execute(admin)
        .await
        .expect("drop inherited-grant regression role");

    sqlx::query("CREATE ROLE rudder_analytics_unexpected_member NOLOGIN")
        .execute(admin)
        .await
        .expect("create role-membership regression role");
    sqlx::query("GRANT rudder_analytics_unexpected_member TO rudder_analytics_reader")
        .execute(admin)
        .await
        .expect("grant empty role membership for startup regression");
    assert_startup_rejected(
        binary,
        postgres,
        binary_sha256,
        "product_analytics_database_role_membership_denied",
    );
    sqlx::query("REVOKE rudder_analytics_unexpected_member FROM rudder_analytics_reader")
        .execute(admin)
        .await
        .expect("remove role-membership regression grant");
    sqlx::query("DROP ROLE rudder_analytics_unexpected_member")
        .execute(admin)
        .await
        .expect("drop role-membership regression role");
}

fn assert_startup_rejected(
    binary: &Path,
    postgres: &PostgresHarness,
    binary_sha256: &str,
    expected_error: &str,
) {
    let mut process =
        CollectorProcess::spawn(binary, postgres, unused_loopback_port(), binary_sha256);
    let output = process.wait_for_exit();
    assert!(
        !output.status.success(),
        "collector unexpectedly accepted role drift"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains(expected_error),
        "unexpected startup rejection; wanted {expected_error}, stderr={stderr}"
    );
}

fn run_migrations(binary: &Path, database_url: &str) {
    let output = Command::new(binary)
        .arg("--migrate")
        .env(
            "RUDDER_TELEMETRY_COLLECTOR_MIGRATION_DATABASE_URL",
            database_url,
        )
        .env("RUDDER_TELEMETRY_COLLECTOR_MIGRATION_ROLE", "postgres")
        .env("TELEMETRY_COLLECTOR_USER", "rudder_analytics_collector")
        .env("TELEMETRY_ROLLUP_USER", "rudder_analytics_rollup")
        .env("TELEMETRY_READER_USER", "rudder_analytics_reader")
        .output()
        .expect("run compiled collector migration entrypoint");
    assert!(
        output.status.success(),
        "collector --migrate failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

async fn verify_rollup_capabilities(admin: &PgPool, postgres: &PostgresHarness) {
    for (table, privilege, expected) in [
        (EVENTS, "SELECT", true),
        (EVENTS, "INSERT", false),
        (EVENTS, "UPDATE", false),
        (EVENTS, "DELETE", false),
        (INSTALLATIONS, "SELECT", true),
        (INSTALLATIONS, "INSERT", false),
        (INSTALLATIONS, "UPDATE", false),
        (INSTALLATIONS, "DELETE", false),
        (SUBJECTS, "SELECT", false),
        (SUBJECTS, "INSERT", false),
        (SUBJECTS, "UPDATE", false),
        (SUBJECTS, "DELETE", false),
        (
            "rudder_analytics.product_analytics_collector_quality_counters",
            "SELECT",
            true,
        ),
        (
            "rudder_analytics.product_analytics_collector_quality_counters",
            "INSERT",
            false,
        ),
        (
            "rudder_analytics.product_analytics_collector_quality_counters",
            "UPDATE",
            false,
        ),
        (
            "rudder_analytics.product_analytics_collector_quality_counters",
            "DELETE",
            true,
        ),
    ] {
        let allowed: bool =
            sqlx::query_scalar("SELECT has_table_privilege('rudder_analytics_rollup', $1, $2)")
                .bind(table)
                .bind(privilege)
                .fetch_one(admin)
                .await
                .expect("inspect rollup table grants");
        assert_eq!(allowed, expected, "unexpected {privilege} on {table}");
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
        let allowed: bool = sqlx::query_scalar("SELECT has_function_privilege($1, $2, 'EXECUTE')")
            .bind(role)
            .bind(function)
            .fetch_one(admin)
            .await
            .expect("inspect rollup function grant");
        assert_eq!(
            allowed, expected,
            "unexpected EXECUTE on {function} for {role}"
        );
        let public_allowed: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl WHERE p.oid=$1::regprocedure AND acl.grantee=0 AND acl.privilege_type='EXECUTE')",
        )
        .bind(function)
        .fetch_one(admin)
        .await
        .expect("inspect public function grant");
        assert!(!public_allowed, "PUBLIC can execute {function}");
    }

    let rollup_url = postgres.role_url("rudder_analytics_rollup");
    let rollup = connect(&rollup_url).await;
    for (label, sql) in [
        (
            "raw update",
            format!("UPDATE {EVENTS} SET event_name=event_name WHERE false"),
        ),
        (
            "raw insert",
            format!(
                "INSERT INTO {EVENTS} (event_id) SELECT '00000000-0000-4000-8000-000000000001'::uuid WHERE false"
            ),
        ),
        ("raw delete", format!("DELETE FROM {EVENTS} WHERE false")),
        (
            "consent update",
            format!("UPDATE {SUBJECTS} SET analytics_subject=analytics_subject WHERE false"),
        ),
        (
            "consent insert",
            format!(
                "INSERT INTO {SUBJECTS} (installation_id, analytics_subject) SELECT 'test', 'test' WHERE false"
            ),
        ),
        (
            "consent delete",
            format!("DELETE FROM {SUBJECTS} WHERE false"),
        ),
    ] {
        assert!(
            sqlx::query(&sql).execute(&rollup).await.is_err(),
            "rollup role performed {label} directly"
        );
    }
    rollup.close().await;
}

async fn seed_metric_window(admin: &PgPool, now: OffsetDateTime, today: Date) {
    let timestamps = [
        (
            "metric-today",
            "human_work_started",
            now - Duration::minutes(90),
        ),
        (
            "metric-yesterday",
            "human_work_started",
            at_date(today - Duration::days(1), Time::from_hms(20, 0, 0).unwrap()),
        ),
        (
            "metric-seven-day-interior",
            "human_work_started",
            at_date(today - Duration::days(6), Time::from_hms(12, 0, 0).unwrap()),
        ),
        (
            "metric-seven-day-boundary",
            "human_work_started",
            at_date(
                today - Duration::days(7),
                Time::from_hms_nano(23, 59, 59, 999_999_000).unwrap(),
            ),
        ),
        (
            "metric-outside-seven-day-boundary",
            "human_work_started",
            at_date(
                today - Duration::days(7),
                Time::from_hms_nano(23, 59, 59, 999_998_000).unwrap(),
            ),
        ),
    ];
    for (index, (installation, event_name, occurred_at)) in timestamps.into_iter().enumerate() {
        insert_event(
            admin,
            installation,
            event_name,
            occurred_at,
            format!("{:064x}", index + 1),
            None,
            None,
        )
        .await;
    }
}

async fn seed_retention_cohorts(admin: &PgPool, now: OffsetDateTime, today: Date) {
    let w1_first_seen = at_date(
        today - Duration::days(20),
        Time::from_hms(10, 0, 0).unwrap(),
    );
    let w1_installations = seed_cohort(admin, "w1", w1_first_seen, 2).await;
    insert_event(
        admin,
        &w1_installations[0],
        "human_work_started",
        w1_first_seen + Duration::days(7),
        format!("{:064x}", 100),
        None,
        None,
    )
    .await;
    let second_first_seen = w1_first_seen + Duration::hours(5) + Duration::nanoseconds(123_456_000);
    sqlx::query(&format!(
        "UPDATE {INSTALLATIONS} SET first_seen_at=$2::timestamptz WHERE installation_id=$1"
    ))
    .bind(&w1_installations[1])
    .bind(format_time(second_first_seen))
    .execute(admin)
    .await
    .expect("seed exact second installation first-seen time");
    sqlx::query(&format!(
        "UPDATE {EVENTS} SET occurred_at=$2::timestamptz, effective_at=$2::timestamptz WHERE installation_id=$1 AND event_name='organization_created'"
    ))
    .bind(&w1_installations[1])
    .bind(format_time(second_first_seen))
    .execute(admin)
    .await
    .expect("seed exact first-seen event time");
    sqlx::query(&format!(
        "UPDATE {INSTALLATIONS} SET first_observed_event_at=$2::timestamptz WHERE installation_id=$1"
    ))
    .bind(&w1_installations[1])
    .bind(format_time(second_first_seen))
    .execute(admin)
    .await
    .expect("seed exact first observed event timestamp");
    insert_event(
        admin,
        &w1_installations[1],
        "human_work_started",
        second_first_seen + Duration::days(7) - Duration::microseconds(123),
        format!("{:064x}", 101),
        None,
        None,
    )
    .await;

    let recent = at_date(today - Duration::days(2), Time::from_hms(10, 0, 0).unwrap());
    seed_cohort(admin, "recent", recent, 2).await;

    let old = at_date(
        today - Duration::days(50),
        Time::from_hms(10, 0, 0).unwrap(),
    );
    let old_installations = seed_cohort(admin, "w4", old, 2).await;
    insert_event(
        admin,
        &old_installations[0],
        "work_loop_completed",
        old + Duration::days(30),
        format!("{:064x}", 102),
        Some("collector-test-w4-cycle"),
        Some(1),
    )
    .await;

    let suppressed = at_date(
        today - Duration::days(10),
        Time::from_hms(10, 0, 0).unwrap(),
    );
    seed_cohort(admin, "below-threshold", suppressed, 1).await;
    let _ = now;
}

async fn seed_consent_before_event_cohort(admin: &PgPool, today: Date) -> (String, String) {
    let consent_at = at_date(today - Duration::days(45), Time::from_hms(9, 0, 0).unwrap());
    let first_event_at = at_date(
        today - Duration::days(15),
        Time::from_hms(12, 0, 0).unwrap(),
    );
    for index in 0..2 {
        let installation_id = format!("consented-before-event-{index}");
        sqlx::query(&format!(
            "INSERT INTO {INSTALLATIONS} (installation_id, mode, consent_version, consent_epoch, analytics_subject, revoked, first_seen_at, last_seen_at, updated_at) VALUES ($1, 'anonymous', 'process-test-v1', 1, NULL, false, $2::timestamptz, $2::timestamptz, now())"
        ))
        .bind(&installation_id)
        .bind(format_time(consent_at))
        .execute(admin)
        .await
        .expect("seed consent timestamp before first production event");
        insert_event(
            admin,
            &installation_id,
            "organization_created",
            first_event_at,
            format!("{:064x}", 20_000 + index),
            None,
            None,
        )
        .await;
    }
    (
        consent_at.date().to_string(),
        first_event_at.date().to_string(),
    )
}

async fn seed_two_subject_rollup_events(admin: &PgPool, now: OffsetDateTime) {
    let installation_id = "two-subject-installation";
    sqlx::query(&format!(
        "INSERT INTO {INSTALLATIONS} (installation_id, mode, consent_version, consent_epoch, analytics_subject, revoked, first_seen_at, last_seen_at, updated_at) VALUES ($1, 'account_linked', 'process-test-v1', 0, NULL, true, $2::timestamptz, $2::timestamptz, now())"
    ))
    .bind(installation_id)
    .bind(format_time(now))
    .execute(admin)
    .await
    .expect("seed shared installation for two subject rollup");
    for index in 0..2 {
        insert_subject_event(
            admin,
            installation_id,
            &format!("{:064x}", 30_000 + index),
            now - Duration::hours(2),
        )
        .await;
    }
}

async fn seed_cohort(
    admin: &PgPool,
    prefix: &str,
    first_seen: OffsetDateTime,
    count: usize,
) -> Vec<String> {
    let mut installations = Vec::with_capacity(count);
    for index in 0..count {
        let id = format!("{prefix}-{index}");
        sqlx::query(&format!(
            "INSERT INTO {INSTALLATIONS} (installation_id, mode, consent_version, consent_epoch, analytics_subject, revoked, first_seen_at, last_seen_at, updated_at) VALUES ($1, 'anonymous', 'process-test-v1', 1, NULL, false, $2::timestamptz, $2::timestamptz, now())"
        ))
        .bind(&id)
        .bind(format_time(first_seen))
        .execute(admin)
        .await
        .expect("seed installation cohort");
        insert_event(
            admin,
            &id,
            "organization_created",
            first_seen,
            format!("{:064x}", 10_000 + installations.len()),
            None,
            None,
        )
        .await;
        installations.push(id);
    }
    installations
}

async fn insert_event(
    admin: &PgPool,
    installation_id: &str,
    event_name: &str,
    occurred_at: OffsetDateTime,
    pseudonymous_installation_id: String,
    work_cycle_id: Option<&str>,
    completion_revision: Option<i32>,
) {
    sqlx::query(&format!(
        "INSERT INTO {EVENTS} (event_id, installation_id, event_name, schema_version, occurred_at, effective_at, environment, app_version, release_channel, deployment_mode, actor_kind, origin, pseudonymous_installation_id, pseudonymous_work_cycle_id, completion_revision, properties, confidence, is_backfill, late, consent_version, consent_epoch, payload_sha256) VALUES ($1::uuid, $2, $3, 1, $4::timestamptz, $4::timestamptz, 'production', 'test', 'stable', 'desktop_local', 'user', 'human', $5, $6, $7, '{{}}'::jsonb, 'exact', false, false, 'process-test-v1', 1, repeat('a', 64))"
    ))
    .bind(event_uuid(NEXT_EVENT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)))
    .bind(installation_id)
    .bind(event_name)
    .bind(format_time(occurred_at))
    .bind(pseudonymous_installation_id)
    .bind(work_cycle_id)
    .bind(completion_revision)
    .execute(admin)
    .await
    .expect("seed raw telemetry event");
    sqlx::query(&format!(
        "UPDATE {INSTALLATIONS} SET first_observed_event_at = LEAST(COALESCE(first_observed_event_at, $2::timestamptz), $2::timestamptz) WHERE installation_id = $1"
    ))
    .bind(installation_id)
    .bind(format_time(occurred_at))
    .execute(admin)
    .await
    .expect("persist the seeded first observed event timestamp");
}

async fn insert_subject_event(
    admin: &PgPool,
    installation_id: &str,
    analytics_subject: &str,
    occurred_at: OffsetDateTime,
) {
    sqlx::query(&format!(
        "INSERT INTO {EVENTS} (event_id, installation_id, analytics_subject, event_name, schema_version, occurred_at, effective_at, environment, app_version, release_channel, deployment_mode, actor_kind, origin, properties, confidence, is_backfill, late, consent_version, consent_epoch, payload_sha256) VALUES ($1::uuid, $2, $3, 'organization_created', 1, $4::timestamptz, $4::timestamptz, 'production', 'test', 'stable', 'desktop_local', 'user', 'human', '{{}}'::jsonb, 'exact', false, false, 'process-test-v1', 1, repeat('c', 64))"
    ))
    .bind(event_uuid(NEXT_EVENT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)))
    .bind(installation_id)
    .bind(analytics_subject)
    .bind(format_time(occurred_at))
    .execute(admin)
    .await
    .expect("seed raw event for account-linked subject");
    sqlx::query(&format!(
        "UPDATE {INSTALLATIONS} SET first_observed_event_at = LEAST(COALESCE(first_observed_event_at, $2::timestamptz), $2::timestamptz) WHERE installation_id = $1"
    ))
    .bind(installation_id)
    .bind(format_time(occurred_at))
    .execute(admin)
    .await
    .expect("persist the subject event timestamp");
}

fn human_work_started_event(event_id: &str, pseudo: &str, occurred_at: OffsetDateTime) -> Value {
    json!({
        "eventId": event_id,
        "eventName": "human_work_started",
        "schemaVersion": 1,
        "occurredAt": format_time(occurred_at),
        "environment": "production",
        "appVersion": "test",
        "releaseChannel": "stable",
        "deploymentMode": "desktop_local",
        "actorKind": "user",
        "origin": "human",
        "pseudonymousInstallationId": pseudo,
        "pseudonymousOrgId": null,
        "pseudonymousWorkId": null,
        "pseudonymousWorkCycleId": null,
        "pseudonymousRootRunId": null,
        "pseudonymousRunId": null,
        "completionRevision": null,
        "properties": {},
        "confidence": "exact",
        "isBackfill": false
    })
}

fn wait_for_health(process: &mut CollectorProcess, address: SocketAddr) -> Value {
    for _ in 0..100 {
        if let Some(status) = process.0.try_wait().expect("poll collector process") {
            let mut stdout = String::new();
            let mut stderr = String::new();
            if let Some(mut stream) = process.0.stdout.take() {
                let _ = stream.read_to_string(&mut stdout);
            }
            if let Some(mut stream) = process.0.stderr.take() {
                let _ = stream.read_to_string(&mut stderr);
            }
            panic!(
                "collector process exited before health response: {status}; stdout={stdout}; stderr={stderr}"
            );
        }
        if let Ok((200, body)) = request_json_result(address, "GET", "/healthz", vec![], None) {
            return body;
        }
        thread::sleep(StdDuration::from_millis(100));
    }
    panic!("collector loopback health endpoint did not become ready");
}

fn request_json(
    address: SocketAddr,
    method: &str,
    path: &str,
    headers: Vec<(&str, &str)>,
    body: Option<Value>,
) -> (u16, Value) {
    request_json_result(address, method, path, headers, body)
        .unwrap_or_else(|error| panic!("{method} {path} failed: {error}"))
}

fn request_json_result(
    address: SocketAddr,
    method: &str,
    path: &str,
    headers: Vec<(&str, &str)>,
    body: Option<Value>,
) -> Result<(u16, Value), String> {
    let body = body.map(|value| value.to_string()).unwrap_or_default();
    let mut stream = TcpStream::connect_timeout(&address, StdDuration::from_secs(2))
        .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(StdDuration::from_secs(3)))
        .map_err(|error| error.to_string())?;
    write!(
        stream,
        "{method} {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n"
    )
    .map_err(|error| error.to_string())?;
    for (name, value) in headers {
        write!(stream, "{name}: {value}\r\n").map_err(|error| error.to_string())?;
    }
    if !body.is_empty() {
        write!(
            stream,
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        )
        .map_err(|error| error.to_string())?;
    }
    stream
        .write_all(format!("\r\n{body}").as_bytes())
        .map_err(|error| error.to_string())?;
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|error| error.to_string())?;
    decode_response(&response)
}

fn decode_response(response: &[u8]) -> Result<(u16, Value), String> {
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "malformed HTTP response".to_owned())?;
    let headers = std::str::from_utf8(&response[..split]).map_err(|error| error.to_string())?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|status| status.parse::<u16>().ok())
        .ok_or_else(|| "missing HTTP status".to_owned())?;
    let body = &response[split + 4..];
    let body = if headers
        .lines()
        .any(|line| line.eq_ignore_ascii_case("transfer-encoding: chunked"))
    {
        decode_chunked(body)?
    } else {
        body.to_vec()
    };
    let value = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body).map_err(|error| error.to_string())?
    };
    Ok((status, value))
}

fn decode_chunked(mut bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    loop {
        let end = bytes
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or_else(|| "malformed chunked response".to_owned())?;
        let length = usize::from_str_radix(
            std::str::from_utf8(&bytes[..end]).map_err(|error| error.to_string())?,
            16,
        )
        .map_err(|error| error.to_string())?;
        bytes = &bytes[end + 2..];
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

fn find_cohort<'a>(cohorts: &'a [Value], day: &str) -> &'a Value {
    cohorts
        .iter()
        .find(|row| row["cohortDay"] == day)
        .unwrap_or_else(|| panic!("missing cohort {day}: {cohorts:?}"))
}

fn at_date(day: Date, time: Time) -> OffsetDateTime {
    day.with_time(time).assume_utc()
}

fn format_time(value: OffsetDateTime) -> String {
    value.format(&Rfc3339).expect("format UTC timestamp")
}

fn event_uuid(value: u64) -> String {
    format!("00000000-0000-4000-8000-{value:012x}")
}

static NEXT_EVENT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

async fn connect(url: &str) -> PgPool {
    PgPoolOptions::new()
        .max_connections(3)
        .connect(url)
        .await
        .unwrap_or_else(|error| panic!("connect test PostgreSQL: {error}"))
}

fn unused_loopback_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("reserve loopback port")
        .local_addr()
        .expect("read loopback port")
        .port()
}

struct CollectorProcess(Child);

impl CollectorProcess {
    fn spawn(binary: &Path, postgres: &PostgresHarness, port: u16, binary_hash: &str) -> Self {
        let mut command = Command::new(binary);
        command
            .env(
                "RUDDER_TELEMETRY_COLLECTOR_DATABASE_URL",
                postgres.role_url("rudder_analytics_collector"),
            )
            .env(
                "RUDDER_TELEMETRY_COLLECTOR_MAINTENANCE_DATABASE_URL",
                postgres.role_url("rudder_analytics_rollup"),
            )
            .env(
                "RUDDER_TELEMETRY_COLLECTOR_REPORT_DATABASE_URL",
                postgres.role_url("rudder_analytics_reader"),
            )
            .env(
                "RUDDER_TELEMETRY_COLLECTOR_DATABASE_ROLE",
                "rudder_analytics_collector",
            )
            .env(
                "RUDDER_TELEMETRY_COLLECTOR_EXPECTED_DATABASE_ROLE",
                "rudder_analytics_collector",
            )
            .env(
                "RUDDER_TELEMETRY_COLLECTOR_MAINTENANCE_DATABASE_ROLE",
                "rudder_analytics_rollup",
            )
            .env(
                "RUDDER_TELEMETRY_COLLECTOR_REPORT_DATABASE_ROLE",
                "rudder_analytics_reader",
            )
            .env("RUDDER_TELEMETRY_COLLECTOR_HOST", "127.0.0.1")
            .env("RUDDER_TELEMETRY_COLLECTOR_PORT", port.to_string())
            .env(
                "RUDDER_TELEMETRY_COLLECTOR_IDENTITY_PUBLIC_KEY",
                IDENTITY_PUBLIC_KEY,
            )
            .env(
                "RUDDER_TELEMETRY_COLLECTOR_IDENTITY_ISSUER",
                "https://identity.test",
            )
            .env(
                "RUDDER_TELEMETRY_COLLECTOR_IDENTITY_KEY_ID",
                "process-test-key",
            )
            .env(
                "RUDDER_TELEMETRY_COLLECTOR_ANONYMOUS_AUTHORIZATION",
                ANONYMOUS_AUTHORIZATION,
            )
            .env("RUDDER_TELEMETRY_COLLECTOR_REPORT_SECRET", REPORT_SECRET)
            .env("RUDDER_TELEMETRY_COLLECTOR_RETENTION_DAYS", "90")
            .env("RUDDER_TELEMETRY_COLLECTOR_PRIVACY_THRESHOLD", "2")
            .env("RUDDER_TELEMETRY_COLLECTOR_ROLLUP_INTERVAL_MS", "1000")
            .env("RUST_LOG", "error")
            .env_remove("DATABASE_URL")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = command.spawn().unwrap_or_else(|error| {
            panic!("spawn hash-identified collector {binary_hash}: {error}")
        });
        Self(child)
    }

    fn wait_for_exit(&mut self) -> Output {
        for _ in 0..100 {
            if let Some(status) = self.0.try_wait().expect("poll collector startup process") {
                let mut stdout = Vec::new();
                let mut stderr = Vec::new();
                self.0
                    .stdout
                    .as_mut()
                    .expect("capture collector stdout")
                    .read_to_end(&mut stdout)
                    .expect("read collector stdout");
                self.0
                    .stderr
                    .as_mut()
                    .expect("capture collector stderr")
                    .read_to_end(&mut stderr)
                    .expect("read collector stderr");
                return Output {
                    status,
                    stdout,
                    stderr,
                };
            }
            thread::sleep(StdDuration::from_millis(50));
        }
        panic!("collector remained running with a deliberately invalid role profile");
    }
}

impl Drop for CollectorProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct PostgresHarness {
    _temp: TempDir,
    data_dir: PathBuf,
    pg_ctl: PathBuf,
    admin_url: String,
    port: u16,
}

impl PostgresHarness {
    fn start() -> Self {
        let initdb = postgres_binary("initdb");
        let pg_ctl = postgres_binary("pg_ctl");
        let temp = tempfile::tempdir().expect("create disposable PostgreSQL directory");
        let data_dir = temp.path().join("data");
        let log_path = temp.path().join("postgres.log");
        let port = unused_loopback_port();
        run_checked(
            Command::new(initdb).arg("-D").arg(&data_dir).args([
                "--encoding=UTF8",
                "--locale=C",
                "--auth=trust",
                "--username=postgres",
                "--no-sync",
            ]),
            "initdb",
        );
        run_checked(
            Command::new(&pg_ctl)
                .arg("-D")
                .arg(&data_dir)
                .arg("-l")
                .arg(&log_path)
                .arg("-o")
                .arg(format!(
                    "-h 127.0.0.1 -p {port} -F -k {}",
                    temp.path().display()
                ))
                .args(["-w", "start"]),
            "pg_ctl start",
        );
        Self {
            _temp: temp,
            data_dir,
            pg_ctl,
            admin_url: format!("postgresql://postgres@127.0.0.1:{port}/postgres"),
            port,
        }
    }

    fn role_url(&self, role: &str) -> String {
        format!("postgresql://{role}@127.0.0.1:{}/postgres", self.port)
    }
}

impl Drop for PostgresHarness {
    fn drop(&mut self) {
        let _ = Command::new(&self.pg_ctl)
            .arg("-D")
            .arg(&self.data_dir)
            .args(["-m", "immediate", "-w", "stop"])
            .status();
    }
}

fn postgres_binary(name: &str) -> PathBuf {
    let executable = format!("{name}{}", env::consts::EXE_SUFFIX);
    let mut candidates = Vec::new();
    if let Some(bin_dir) = env::var_os("RUDDER_POSTGRES_BIN_DIR") {
        candidates.push(PathBuf::from(bin_dir).join(&executable));
    }
    if let Some(path) = env::var_os("PATH") {
        candidates.extend(env::split_paths(&path).map(|directory| directory.join(&executable)));
    }
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin").join(&executable),
        PathBuf::from("/usr/local/bin").join(&executable),
    ]);
    if let Ok(versions) = fs::read_dir("/usr/lib/postgresql") {
        candidates.extend(
            versions
                .filter_map(Result::ok)
                .map(|entry| entry.path().join("bin").join(&executable)),
        );
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| panic!("PostgreSQL test binary {name} was not found"))
}

fn run_checked(command: &mut Command, label: &str) {
    let output = command
        .output()
        .unwrap_or_else(|error| panic!("run {label}: {error}"));
    assert!(
        output.status.success(),
        "{label} failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
