#![cfg(unix)]

use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use ring::signature::{Ed25519KeyPair, KeyPair};
use rudder_product_analytics_collector_core::MAX_BATCH_BYTES;
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
    time::{Duration as StdDuration, SystemTime, UNIX_EPOCH},
};
use tempfile::TempDir;
use time::{Date, Duration, OffsetDateTime, Time, format_description::well_known::Rfc3339};

const EVENTS: &str = "rudder_analytics.product_analytics_collector_events";
const INSTALLATIONS: &str = "rudder_analytics.product_analytics_collector_installations";
const SUBJECTS: &str = "rudder_analytics.product_analytics_collector_subjects";
const DAILY_ROLLUPS: &str = "rudder_analytics.product_analytics_collector_daily_rollups";
const PRIVACY_AGGREGATES: &str = "rudder_analytics.product_analytics_collector_privacy_aggregates";
const QUALITY: &str = "rudder_analytics.product_analytics_collector_quality_counters";
const WORK_LOOP_REVISIONS: &str =
    "rudder_analytics.product_analytics_collector_work_loop_revisions";
const MIGRATION_HISTORY: &str = "rudder_analytics._product_analytics_migrations";
const REPORT_SECRET: &str = "local-process-test-report-secret";
const ANONYMOUS_AUTHORIZATION: &str = "local-process-test-anonymous-secret";
const IDENTITY_CONSENT_SYNC_SECRET: &str = "local-process-test-identity-consent-sync";
const IDENTITY_REVOKE_SECRET: &str = "local-process-test-identity-revoke";

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
    verify_direct_role_boundaries(&postgres).await;
    verify_startup_rejects_privilege_drift(&binary, &postgres, &binary_sha256, &admin).await;

    let now = OffsetDateTime::now_utc();
    let today = now.date();
    let report_from = today - Duration::days(70);
    seed_metric_window(&admin, now, today).await;
    seed_retention_cohorts(&admin, now, today).await;
    let (consent_cohort_day, first_event_cohort_day) =
        seed_consent_before_event_cohort(&admin, today).await;
    seed_two_subject_rollup_events(&admin, now).await;

    let node_port = unused_loopback_port();
    let mut node_process = CollectorProcess::spawn_node(&postgres, node_port);
    let node_address = SocketAddr::from(([127, 0, 0, 1], node_port));
    let node_health = wait_for_health(&mut node_process, node_address);
    assert_eq!(node_health["service"], "product-analytics-collector");

    let node_installation = "node-parity-installation";
    let node_pseudo = format!("{:064x}", 91_001);
    let rust_installation = "rust-parity-installation";
    let rust_pseudo = format!("{:064x}", 91_002);
    for (installation, pseudo) in [
        (node_installation, node_pseudo.as_str()),
        (rust_installation, rust_pseudo.as_str()),
    ] {
        let consent = anonymous_consent(node_address, installation, pseudo);
        assert_eq!(consent.0, 200, "Node consent response: {}", consent.1);
    }

    let node_event_id = event_uuid(91_101);
    let node_event = parity_event(&node_event_id, &node_pseudo, now);
    let node_accepted = anonymous_batch(node_address, node_installation, &node_pseudo, &node_event);
    assert_eq!(
        node_accepted.0, 200,
        "Node accepted response: {}",
        node_accepted.1
    );
    assert_eq!(node_accepted.1["accepted"], 1);
    let node_duplicate =
        anonymous_batch(node_address, node_installation, &node_pseudo, &node_event);
    assert_eq!(
        node_duplicate.0, 200,
        "Node replay response: {}",
        node_duplicate.1
    );
    assert_eq!(node_duplicate.1["duplicate"], 1);
    let mut node_conflict_event = node_event.clone();
    node_conflict_event["occurredAt"] = json!(format_time(now + Duration::seconds(1)));
    let node_conflict = anonymous_batch(
        node_address,
        node_installation,
        &node_pseudo,
        &node_conflict_event,
    );
    assert_eq!(
        node_conflict.0, 409,
        "Node conflict response: {}",
        node_conflict.1
    );
    assert_eq!(node_conflict.1["rejected"][0]["errorCode"], "conflict");
    drop(node_process);

    let listener_port = unused_loopback_port();
    let mut process = CollectorProcess::spawn(&binary, &postgres, listener_port, &binary_sha256);
    let address = SocketAddr::from(([127, 0, 0, 1], listener_port));
    let health = wait_for_health(&mut process, address);
    assert_eq!(health["service"], "product-analytics-collector");

    let rust_event_id = event_uuid(91_102);
    let rust_event = parity_event(&rust_event_id, &rust_pseudo, now);
    let rust_accepted = anonymous_batch(address, rust_installation, &rust_pseudo, &rust_event);
    assert_eq!(
        rust_accepted.0, 200,
        "Rust accepted response: {}",
        rust_accepted.1
    );
    assert_batch_response_parity(&node_accepted, &rust_accepted);

    let rust_duplicate = anonymous_batch(address, rust_installation, &rust_pseudo, &rust_event);
    assert_eq!(
        rust_duplicate.0, 200,
        "Rust replay response: {}",
        rust_duplicate.1
    );
    assert_eq!(rust_duplicate.1["duplicate"], 1);
    let rust_replay_of_node_event =
        anonymous_batch(address, node_installation, &node_pseudo, &node_event);
    assert_batch_response_parity(&node_duplicate, &rust_replay_of_node_event);

    let mut rust_conflict_event = rust_event.clone();
    rust_conflict_event["occurredAt"] = json!(format_time(now + Duration::seconds(1)));
    let rust_conflict = anonymous_batch(
        address,
        rust_installation,
        &rust_pseudo,
        &rust_conflict_event,
    );
    assert_eq!(
        rust_conflict.0, 409,
        "Rust conflict response: {}",
        rust_conflict.1
    );
    assert_batch_response_parity(&node_conflict, &rust_conflict);

    drop(process);
    let restart_port = unused_loopback_port();
    let mut process = CollectorProcess::spawn(&binary, &postgres, restart_port, &binary_sha256);
    let address = SocketAddr::from(([127, 0, 0, 1], restart_port));
    let restarted_health = wait_for_health(&mut process, address);
    assert_eq!(restarted_health["service"], "product-analytics-collector");
    let replay_after_restart =
        anonymous_batch(address, rust_installation, &rust_pseudo, &rust_event);
    assert_eq!(replay_after_restart.0, 200);
    assert_eq!(replay_after_restart.1["duplicate"], 1);
    assert_batch_response_parity(&rust_duplicate, &replay_after_restart);

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
    for malformed_body in [json!({}), json!({"events": null}), json!({"events": {}})] {
        let malformed = request_json(
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
            Some(malformed_body),
        );
        assert_eq!(
            malformed.0, 422,
            "malformed batch response: {}",
            malformed.1
        );
        assert_eq!(malformed.1["accepted"], 0);
        assert_eq!(malformed.1["duplicate"], 0);
        assert_eq!(
            malformed.1["rejected"][0],
            json!({
                "eventId": "batch",
                "status": "rejected",
                "errorCode": "invalid_schema",
                "late": false
            })
        );
    }
    let malformed_json = request_raw(
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
        b"{malformed-json",
    );
    assert_eq!(
        malformed_json.0, 400,
        "malformed JSON response: {}",
        malformed_json.1
    );
    assert_eq!(malformed_json.1, json!({"errorCode": "invalid_schema"}));

    let oversized_body = vec![b' '; MAX_BATCH_BYTES + 1];
    let oversized_json = request_raw(
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
        &oversized_body,
    );
    assert_eq!(
        oversized_json.0, 413,
        "oversized JSON response: {}",
        oversized_json.1
    );
    assert_eq!(oversized_json.1, json!({"errorCode": "too_large"}));

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
        if report["quality"]["acceptedEventCount"] == 3
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
    assert_eq!(report["quality"]["receivedBatchCount"], 12);
    assert_eq!(report["quality"]["acceptedEventCount"], 3);
    assert_eq!(report["quality"]["duplicateEventCount"], 4);
    assert_eq!(report["quality"]["rejectedEventCount"], 5);
    assert_eq!(
        metrics["meaningfulDau"],
        metrics["meaningfulActiveInstallations1d"]
    );
    assert_keys(
        &report,
        &[
            "window",
            "metrics",
            "quality",
            "privacy",
            "coverage",
            "dailyCreation",
            "retention",
        ],
    );
    assert_keys(&report["window"], &["from", "to", "timezone"]);
    assert_keys(
        &report["metrics"],
        &[
            "meaningfulActiveInstallations1d",
            "meaningfulActiveInstallations7d",
            "productiveInstallations7d",
            "weeklyCompletedWorkLoops",
            "meaningfulDau",
            "productiveWau",
        ],
    );
    assert_keys(
        &report["quality"],
        &[
            "receivedBatchCount",
            "acceptedEventCount",
            "lateEventCount",
            "duplicateEventCount",
            "rejectedEventCount",
            "aggregateRows",
        ],
    );
    assert_keys(&report["privacy"], &["aggregateRows"]);
    for row in report["privacy"]["aggregateRows"].as_array().unwrap() {
        assert_keys(
            row,
            &[
                "metricName",
                "metricValue",
                "contributingInstallations",
                "privacyThreshold",
            ],
        );
    }
    assert_keys(
        &report["coverage"],
        &["accountLinkedEventCount", "anonymousEventCount"],
    );
    assert_keys(&report["dailyCreation"], &["privacyThreshold", "days"]);
    for day in report["dailyCreation"]["days"].as_array().unwrap() {
        assert_keys(day, &["day", "issuesCreated", "chatsCreated"]);
        assert_keys(&day["issuesCreated"], &["count", "status"]);
        assert_keys(&day["chatsCreated"], &["count", "status"]);
    }
    for cohort in report["retention"].as_array().unwrap() {
        assert_keys(
            cohort,
            &[
                "cohortDay",
                "eligibleInstallations",
                "meaningfulW1",
                "loopW1",
                "loopW4",
                "suppressed",
            ],
        );
    }

    let cohorts = report["retention"].as_array().expect("retention array");
    assert!(
        !cohorts
            .iter()
            .any(|row| row["cohortDay"] == consent_cohort_day),
        "consent timestamp must not create an exact retention cohort: {cohorts:?}"
    );
    let consent_before_event = find_cohort(cohorts, &first_event_cohort_day);
    assert_eq!(consent_before_event["eligibleInstallations"], 2);
    assert_eq!(consent_before_event["loopW4"], 0);

    let backdated_event_at = now - Duration::days(1);
    for index in 0..2 {
        let installation_id = format!("backdated-under-current-consent-{index}");
        let pseudo = format!("{:064x}", 91_000 + index);
        let consent = request_json(
            address,
            "POST",
            "/api/analytics/v1/internal/anonymous/consent",
            vec![(
                "x-rudder-telemetry-anonymous-authorization",
                ANONYMOUS_AUTHORIZATION,
            )],
            Some(json!({
                "installationId": installation_id,
                "pseudonymousInstallationId": pseudo,
                "consentVersion": "process-test-v1",
                "consentEpoch": 1,
                "revoked": false
            })),
        );
        assert_eq!(consent.0, 200, "backdated consent response: {}", consent.1);

        let event_id = event_uuid(91_000 + index);
        let batch = request_json(
            address,
            "POST",
            "/api/analytics/v1/events:batch",
            vec![
                ("authorization", ANONYMOUS_AUTHORIZATION),
                ("x-rudder-installation-id", &installation_id),
                ("x-rudder-telemetry-consent-version", "process-test-v1"),
                ("x-rudder-telemetry-consent-epoch", "1"),
                ("x-rudder-telemetry-pseudonymous-installation-id", &pseudo),
            ],
            Some(json!({
                "events": [human_work_started_event(&event_id, &pseudo, backdated_event_at)]
            })),
        );
        assert_eq!(batch.0, 200, "backdated batch response: {}", batch.1);
        assert_eq!(batch.1["accepted"], 1);
        assert_eq!(batch.1["rejected"].as_array().map(Vec::len), Some(0));

        // Match Node's upload-time consent check without choosing the cohort anchor.
        let stored_with_current_consent: bool = sqlx::query_scalar(&format!(
            "SELECT event.occurred_at = $2::timestamptz AND event.occurred_at < installation.first_seen_at AND event.received_at >= installation.first_seen_at AND event.consent_version = 'process-test-v1' AND event.consent_epoch = 1 FROM {EVENTS} event JOIN {INSTALLATIONS} installation USING (installation_id) WHERE event.event_id = $1::uuid"
        ))
        .bind(&event_id)
        .bind(format_time(backdated_event_at))
        .fetch_one(&admin)
        .await
        .expect("read back event stored under current consent");
        assert!(
            stored_with_current_consent,
            "an event timestamped before consent is stored only after current consent authorizes upload"
        );
    }

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
    assert_eq!(w1["loopW4"], 0);

    let recent_day = (today - Duration::days(2)).to_string();
    let recent = find_cohort(cohorts, &recent_day);
    assert_eq!(recent["meaningfulW1"], 0);
    assert_eq!(recent["loopW4"], 0);

    let w4_day = (today - Duration::days(50)).to_string();
    let w4 = find_cohort(cohorts, &w4_day);
    assert_eq!(w4["loopW4"], 1);

    let identity_installation = "identity-subject-binding-installation";
    let identity_pseudo = format!("{:064x}", 92_000);
    let subject_a = format!("{:064x}", 92_001);
    let subject_b = format!("{:064x}", 92_002);
    let assertion_without_grant = identity_batch(
        address,
        identity_installation,
        &identity_pseudo,
        &subject_a,
        1,
        92_003,
    );
    assert_eq!(assertion_without_grant.0, 422);
    assert_eq!(
        assertion_without_grant.1["rejected"][0]["errorCode"],
        "revoked"
    );
    let no_subject_state: i64 = sqlx::query_scalar(&format!(
        "SELECT count(*)::bigint FROM {SUBJECTS} WHERE installation_id=$1"
    ))
    .bind(identity_installation)
    .fetch_one(&admin)
    .await
    .expect("check an assertion cannot create Identity consent state");
    assert_eq!(no_subject_state, 0);

    let current_grant = sync_identity_consent(address, identity_installation, &subject_a, 1, false);
    assert_eq!(
        current_grant.0, 200,
        "current Identity grant: {}",
        current_grant.1
    );
    assert_eq!(current_grant.1["consentEpoch"], 1);
    assert_eq!(current_grant.1["revoked"], false);
    let current_assertion = identity_batch(
        address,
        identity_installation,
        &identity_pseudo,
        &subject_a,
        1,
        92_004,
    );
    assert_eq!(
        current_assertion.0, 200,
        "subject-bound upload: {}",
        current_assertion.1
    );
    assert_eq!(current_assertion.1["accepted"], 1);

    let mismatched_subject = identity_batch(
        address,
        identity_installation,
        &identity_pseudo,
        &subject_b,
        1,
        92_005,
    );
    assert_eq!(mismatched_subject.0, 422);
    assert_eq!(mismatched_subject.1["rejected"][0]["errorCode"], "revoked");
    let mismatched_subject_state: i64 = sqlx::query_scalar(&format!(
        "SELECT count(*)::bigint FROM {SUBJECTS} WHERE installation_id=$1 AND analytics_subject=$2"
    ))
    .bind(identity_installation)
    .bind(&subject_b)
    .fetch_one(&admin)
    .await
    .expect("check another signed subject cannot inherit the current grant");
    assert_eq!(mismatched_subject_state, 0);

    let revocation = revoke_identity_consent(address, identity_installation, &subject_a, 2);
    assert_eq!(revocation.0, 200, "Identity revocation: {}", revocation.1);
    assert_eq!(revocation.1["consentEpoch"], 2);
    assert_eq!(revocation.1["revoked"], true);
    for replayed_epoch in [1, 2] {
        let replay = sync_identity_consent(
            address,
            identity_installation,
            &subject_a,
            replayed_epoch,
            false,
        );
        assert_eq!(replay.0, 200, "consent replay response: {}", replay.1);
        assert_eq!(replay.1["consentEpoch"], 2);
        assert_eq!(replay.1["revoked"], true);
    }
    for (epoch, event_number) in [(1, 92_006), (2, 92_007)] {
        let stale_or_revoked_assertion = identity_batch(
            address,
            identity_installation,
            &identity_pseudo,
            &subject_a,
            epoch,
            event_number,
        );
        assert_eq!(stale_or_revoked_assertion.0, 422);
        assert_eq!(
            stale_or_revoked_assertion.1["rejected"][0]["errorCode"],
            "revoked"
        );
    }

    let renewed_grant = sync_identity_consent(address, identity_installation, &subject_a, 3, false);
    assert_eq!(renewed_grant.0, 200);
    assert_eq!(renewed_grant.1["revoked"], false);
    let renewed_assertion = identity_batch(
        address,
        identity_installation,
        &identity_pseudo,
        &subject_a,
        3,
        92_008,
    );
    assert_eq!(
        renewed_assertion.0, 200,
        "newer Identity grant: {}",
        renewed_assertion.1
    );
    assert_eq!(renewed_assertion.1["accepted"], 1);
    let identity_event_count: i64 = sqlx::query_scalar(&format!(
        "SELECT count(*)::bigint FROM {EVENTS} WHERE installation_id=$1"
    ))
    .bind(identity_installation)
    .fetch_one(&admin)
    .await
    .expect("count accepted events across revoke and stale replay");
    assert_eq!(identity_event_count, 2);
    let current_subject_state: (i32, bool) = sqlx::query_as(&format!(
        "SELECT consent_epoch, revoked_at IS NOT NULL FROM {SUBJECTS} WHERE installation_id=$1 AND analytics_subject=$2"
    ))
    .bind(identity_installation)
    .bind(&subject_a)
    .fetch_one(&admin)
    .await
    .expect("read renewed subject consent state");
    assert_eq!(current_subject_state, (3, false));

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
    for privilege in ["SELECT", "INSERT"] {
        sqlx::query(&format!(
            "GRANT {privilege} (properties) ON {EVENTS} TO rudder_analytics_collector WITH GRANT OPTION"
        ))
        .execute(admin)
        .await
        .expect("grant raw-event column privilege option for startup regression");
        let table_grant_option_visible: bool = sqlx::query_scalar(&format!(
            "SELECT has_table_privilege('rudder_analytics_collector', '{EVENTS}', '{privilege} WITH GRANT OPTION')"
        ))
        .fetch_one(admin)
        .await
        .expect("check column grant option is not visible as a table grant option");
        assert!(
            !table_grant_option_visible,
            "column-level {privilege} grant option must not appear as a table grant option"
        );
        assert_startup_rejected(
            binary,
            postgres,
            binary_sha256,
            "product_analytics_database_privilege_denied",
        );
        sqlx::query(&format!(
            "REVOKE GRANT OPTION FOR {privilege} (properties) ON {EVENTS} FROM rudder_analytics_collector"
        ))
        .execute(admin)
        .await
        .expect("revoke only raw-event column grant option after startup regression");

        let baseline_table_privilege: bool = sqlx::query_scalar(&format!(
            "SELECT has_table_privilege('rudder_analytics_collector', '{EVENTS}', '{privilege}')"
        ))
        .fetch_one(admin)
        .await
        .expect("check raw-event table privilege after revoking column grant option");
        assert!(
            baseline_table_privilege,
            "revoking column-level {privilege} grant option must preserve table privilege"
        );
        let baseline_column_privilege: bool = sqlx::query_scalar(&format!(
            "SELECT has_column_privilege('rudder_analytics_collector', '{EVENTS}', 'properties', '{privilege}')"
        ))
        .fetch_one(admin)
        .await
        .expect("check raw-event column privilege after revoking column grant option");
        assert!(
            baseline_column_privilege,
            "revoking column-level {privilege} grant option must preserve column privilege"
        );
        let column_grant_option_remains: bool = sqlx::query_scalar(&format!(
            "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname='properties' CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) acl WHERE c.oid='{EVENTS}'::regclass AND acl.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='rudder_analytics_collector') AND acl.privilege_type='{privilege}' AND acl.is_grantable)"
        ))
        .fetch_one(admin)
        .await
        .expect("check raw-event column grant option was removed");
        assert!(
            !column_grant_option_remains,
            "revoking {privilege} grant option must remove the column grant option"
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

async fn verify_direct_role_boundaries(postgres: &PostgresHarness) {
    let collector = connect(&postgres.role_url("rudder_analytics_collector")).await;
    for table in [EVENTS, INSTALLATIONS, SUBJECTS, QUALITY] {
        assert_read_allowed(&collector, table).await;
    }
    for table in [
        DAILY_ROLLUPS,
        PRIVACY_AGGREGATES,
        WORK_LOOP_REVISIONS,
        MIGRATION_HISTORY,
    ] {
        assert_read_denied(
            &collector,
            &format!("SELECT count(*)::bigint FROM {table}"),
            &format!("collector SELECT on {table}"),
        )
        .await;
    }
    for (label, sql) in [
        (
            "collector event update",
            format!("UPDATE {EVENTS} SET event_name=event_name WHERE false"),
        ),
        (
            "collector event delete",
            format!("DELETE FROM {EVENTS} WHERE false"),
        ),
        ("collector rollup insert", empty_daily_rollup_insert()),
        ("collector work-loop insert", empty_work_loop_insert()),
    ] {
        assert_write_denied(&collector, &sql, label).await;
    }
    assert_truncate_denied(&collector, EVENTS, "collector TRUNCATE raw events").await;

    let rollup = connect(&postgres.role_url("rudder_analytics_rollup")).await;
    for table in [EVENTS, INSTALLATIONS, QUALITY] {
        assert_read_allowed(&rollup, table).await;
    }
    for table in [SUBJECTS, MIGRATION_HISTORY] {
        assert_read_denied(
            &rollup,
            &format!("SELECT count(*)::bigint FROM {table}"),
            &format!("rollup SELECT on {table}"),
        )
        .await;
    }
    for sql in [
        empty_daily_rollup_insert(),
        empty_privacy_aggregate_insert(),
        empty_work_loop_insert(),
        format!("UPDATE {DAILY_ROLLUPS} SET event_count=event_count WHERE false"),
        format!("DELETE FROM {DAILY_ROLLUPS} WHERE false"),
    ] {
        assert_write_allowed(&rollup, &sql, "rollup derived-table write").await;
    }
    for (label, sql) in [
        ("rollup raw-event insert", empty_raw_event_insert()),
        (
            "rollup raw-event update",
            format!("UPDATE {EVENTS} SET event_name=event_name WHERE false"),
        ),
        (
            "rollup raw-event delete",
            format!("DELETE FROM {EVENTS} WHERE false"),
        ),
        (
            "rollup installation update",
            format!("UPDATE {INSTALLATIONS} SET updated_at=updated_at WHERE false"),
        ),
        ("rollup subject insert", empty_subject_insert()),
        (
            "rollup subject update",
            format!("UPDATE {SUBJECTS} SET consent_epoch=consent_epoch WHERE false"),
        ),
        (
            "rollup subject delete",
            format!("DELETE FROM {SUBJECTS} WHERE false"),
        ),
    ] {
        assert_write_denied(&rollup, &sql, label).await;
    }
    assert_truncate_denied(&rollup, EVENTS, "rollup TRUNCATE raw events").await;

    let reader = connect(&postgres.role_url("rudder_analytics_reader")).await;
    for table in [DAILY_ROLLUPS, PRIVACY_AGGREGATES, QUALITY] {
        assert_read_allowed(&reader, table).await;
    }
    for table in [
        EVENTS,
        INSTALLATIONS,
        SUBJECTS,
        WORK_LOOP_REVISIONS,
        MIGRATION_HISTORY,
    ] {
        assert_read_denied(
            &reader,
            &format!("SELECT count(*)::bigint FROM {table}"),
            &format!("reader SELECT on {table}"),
        )
        .await;
    }
    for (label, sql) in [
        ("reader raw-event insert", empty_raw_event_insert()),
        (
            "reader installation update",
            format!("UPDATE {INSTALLATIONS} SET updated_at=updated_at WHERE false"),
        ),
        (
            "reader subject delete",
            format!("DELETE FROM {SUBJECTS} WHERE false"),
        ),
        ("reader daily-rollup insert", empty_daily_rollup_insert()),
        (
            "reader daily-rollup update",
            format!("UPDATE {DAILY_ROLLUPS} SET event_count=event_count WHERE false"),
        ),
        (
            "reader privacy-aggregate delete",
            format!("DELETE FROM {PRIVACY_AGGREGATES} WHERE false"),
        ),
        (
            "reader quality-counter update",
            format!("UPDATE {QUALITY} SET updated_at=updated_at WHERE false"),
        ),
    ] {
        assert_write_denied(&reader, &sql, label).await;
    }
    assert_truncate_denied(&reader, DAILY_ROLLUPS, "reader TRUNCATE report data").await;

    collector.close().await;
    rollup.close().await;
    reader.close().await;
}

async fn assert_read_allowed(pool: &PgPool, table: &str) {
    let _: i64 = sqlx::query_scalar(&format!("SELECT count(*)::bigint FROM {table}"))
        .fetch_one(pool)
        .await
        .unwrap_or_else(|error| panic!("expected SELECT access to {table}: {error}"));
}

async fn assert_read_denied(pool: &PgPool, sql: &str, label: &str) {
    let error = sqlx::query_scalar::<_, i64>(sql)
        .fetch_one(pool)
        .await
        .expect_err(label);
    assert_pg_privilege_error(error, label);
}

async fn assert_write_allowed(pool: &PgPool, sql: &str, label: &str) {
    sqlx::query(sql)
        .execute(pool)
        .await
        .unwrap_or_else(|error| panic!("expected {label} to be allowed: {error}"));
}

async fn assert_write_denied(pool: &PgPool, sql: &str, label: &str) {
    let error = sqlx::query(sql).execute(pool).await.expect_err(label);
    assert_pg_privilege_error(error, label);
}

async fn assert_truncate_denied(pool: &PgPool, table: &str, label: &str) {
    let mut transaction = pool
        .begin()
        .await
        .expect("begin rollback-guarded truncate probe");
    let error = sqlx::query(&format!("TRUNCATE TABLE {table}"))
        .execute(&mut *transaction)
        .await
        .expect_err(label);
    transaction
        .rollback()
        .await
        .expect("roll back truncate privilege probe");
    assert_pg_privilege_error(error, label);
}

fn assert_pg_privilege_error(error: sqlx::Error, label: &str) {
    let code = error
        .as_database_error()
        .and_then(|database_error| database_error.code());
    assert_eq!(code.as_deref(), Some("42501"), "{label}: {error}");
}

fn empty_raw_event_insert() -> String {
    format!(
        "INSERT INTO {EVENTS} (event_id, installation_id, event_name, schema_version, occurred_at, effective_at, environment, app_version, release_channel, deployment_mode, actor_kind, origin, properties, confidence, is_backfill, late, consent_version, consent_epoch, payload_sha256) SELECT '00000000-0000-4000-8000-000000009999'::uuid, 'permission-probe', 'account_created', 1, now(), now(), 'test', 'test', 'stable', 'desktop_local', 'user', 'system', jsonb_build_object(), 'exact', false, false, 'probe-v1', 1, repeat('a', 64) WHERE false"
    )
}

fn empty_subject_insert() -> String {
    format!(
        "INSERT INTO {SUBJECTS} (installation_id, analytics_subject, consent_version, consent_epoch) SELECT 'permission-probe', repeat('b', 64), 'probe-v1', 1 WHERE false"
    )
}

fn empty_daily_rollup_insert() -> String {
    format!(
        "INSERT INTO {DAILY_ROLLUPS} (day, installation_id, event_name, origin, dimension_hash, dimensions, event_count, first_occurred_at, last_occurred_at) SELECT current_date, 'permission-probe', 'account_created', 'system', repeat('c', 64), jsonb_build_object(), 0, now(), now() WHERE false"
    )
}

fn empty_privacy_aggregate_insert() -> String {
    format!(
        "INSERT INTO {PRIVACY_AGGREGATES} (day, metric_name, dimension_set_version, dimension_hash, dimension_values, metric_value, contributing_installations, privacy_threshold) SELECT current_date, 'permission-probe', 1, repeat('d', 64), jsonb_build_object(), 0, 0, 2 WHERE false"
    )
}

fn empty_work_loop_insert() -> String {
    format!(
        "INSERT INTO {WORK_LOOP_REVISIONS} (installation_id, pseudonymous_work_cycle_id, completion_revision, completion_event_id, completed_at, environment, release_channel, confidence) SELECT 'permission-probe', 'cycle', 1, 'event', now(), 'test', 'stable', 'exact' WHERE false"
    )
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

fn parity_event(event_id: &str, pseudo: &str, occurred_at: OffsetDateTime) -> Value {
    let mut event = human_work_started_event(event_id, pseudo, occurred_at);
    event["eventName"] = json!("account_created");
    event["origin"] = json!("system");
    event
}

fn anonymous_consent(address: SocketAddr, installation_id: &str, pseudo: &str) -> (u16, Value) {
    request_json(
        address,
        "POST",
        "/api/analytics/v1/internal/anonymous/consent",
        vec![(
            "x-rudder-telemetry-anonymous-authorization",
            ANONYMOUS_AUTHORIZATION,
        )],
        Some(json!({
            "installationId": installation_id,
            "pseudonymousInstallationId": pseudo,
            "consentVersion": "process-test-v1",
            "consentEpoch": 1,
            "revoked": false
        })),
    )
}

fn anonymous_batch(
    address: SocketAddr,
    installation_id: &str,
    pseudo: &str,
    event: &Value,
) -> (u16, Value) {
    request_json(
        address,
        "POST",
        "/api/analytics/v1/events:batch",
        vec![
            ("authorization", ANONYMOUS_AUTHORIZATION),
            ("x-rudder-installation-id", installation_id),
            ("x-rudder-telemetry-consent-version", "process-test-v1"),
            ("x-rudder-telemetry-consent-epoch", "1"),
            ("x-rudder-telemetry-pseudonymous-installation-id", pseudo),
        ],
        Some(json!({"events": [event]})),
    )
}

fn assert_batch_response_parity(expected: &(u16, Value), actual: &(u16, Value)) {
    assert_eq!(expected.0, actual.0, "HTTP status parity");
    assert_eq!(
        normalized_batch_response(&expected.1),
        normalized_batch_response(&actual.1),
        "Node/Rust batch response parity"
    );
}

fn normalized_batch_response(response: &Value) -> Value {
    let mut normalized = response.clone();
    let object = normalized.as_object_mut().expect("batch response object");
    let received_at = object
        .remove("receivedAt")
        .and_then(|value| value.as_str().map(str::to_owned))
        .expect("batch response receivedAt timestamp");
    OffsetDateTime::parse(&received_at, &Rfc3339)
        .expect("batch response receivedAt must be RFC3339");
    if let Some(rejected) = object.get_mut("rejected").and_then(Value::as_array_mut) {
        for acknowledgement in rejected {
            if acknowledgement.get("eventId").is_some() {
                acknowledgement["eventId"] = json!("<event-id>");
            }
        }
    }
    normalized
}

fn identity_key_pair() -> Ed25519KeyPair {
    Ed25519KeyPair::from_seed_unchecked(&[0x5a; 32])
        .expect("create deterministic Identity test key")
}

fn identity_public_key() -> String {
    STANDARD.encode(identity_key_pair().public_key().as_ref())
}

fn identity_assertion(
    installation_id: &str,
    pseudo: &str,
    subject: &str,
    consent_epoch: u64,
    jti: &str,
) -> String {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before Unix epoch")
        .as_millis() as u64;
    let header = json!({
        "alg": "EdDSA",
        "typ": "rudder-telemetry-assertion+jwt",
        "kid": "process-test-key"
    });
    let claims = json!({
        "version": 1,
        "issuer": "https://identity.test",
        "audience": "telemetry-collector",
        "installationId": installation_id,
        "pseudonymousInstallationId": pseudo,
        "analyticsSubject": subject,
        "consentVersion": "identity-test-v1",
        "consentEpoch": consent_epoch,
        "issuedAtMs": now_ms,
        "expiresAtMs": now_ms + 5 * 60 * 1000,
        "jti": jti
    });
    let signing_input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header.to_string()),
        URL_SAFE_NO_PAD.encode(claims.to_string())
    );
    let signature = identity_key_pair().sign(signing_input.as_bytes());
    format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(signature.as_ref())
    )
}

fn identity_batch(
    address: SocketAddr,
    installation_id: &str,
    pseudo: &str,
    subject: &str,
    consent_epoch: u64,
    event_number: u64,
) -> (u16, Value) {
    let assertion = identity_assertion(
        installation_id,
        pseudo,
        subject,
        consent_epoch,
        &format!("process-test-assertion-{event_number}"),
    );
    let bearer = format!("Bearer {assertion}");
    let event_id = event_uuid(event_number);
    request_json(
        address,
        "POST",
        "/api/analytics/v1/events:batch",
        vec![
            ("authorization", &bearer),
            ("x-rudder-installation-id", installation_id),
        ],
        Some(
            json!({"events": [human_work_started_event(&event_id, pseudo, OffsetDateTime::now_utc())]}),
        ),
    )
}

fn sync_identity_consent(
    address: SocketAddr,
    installation_id: &str,
    subject: &str,
    consent_epoch: u64,
    revoked: bool,
) -> (u16, Value) {
    request_json(
        address,
        "POST",
        "/api/analytics/v1/internal/consent/sync",
        vec![(
            "x-rudder-telemetry-consent-sync-secret",
            IDENTITY_CONSENT_SYNC_SECRET,
        )],
        Some(json!({
            "installationId": installation_id,
            "analyticsSubject": subject,
            "consentVersion": "identity-test-v1",
            "consentEpoch": consent_epoch,
            "revoked": revoked
        })),
    )
}

fn revoke_identity_consent(
    address: SocketAddr,
    installation_id: &str,
    subject: &str,
    consent_epoch: u64,
) -> (u16, Value) {
    request_json(
        address,
        "POST",
        "/api/analytics/v1/internal/consent/revoke",
        vec![("x-rudder-telemetry-revoke-secret", IDENTITY_REVOKE_SECRET)],
        Some(json!({
            "installationId": installation_id,
            "analyticsSubject": subject,
            "consentVersion": "identity-test-v1",
            "consentEpoch": consent_epoch
        })),
    )
}

fn assert_keys(value: &Value, expected: &[&str]) {
    let actual = value
        .as_object()
        .expect("JSON object")
        .keys()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    let expected = expected
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(actual, expected, "unexpected JSON object keys: {value}");
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
    let body = body.map(|value| value.to_string().into_bytes());
    request_body_result(address, method, path, headers, body.as_deref())
}

fn request_raw(
    address: SocketAddr,
    method: &str,
    path: &str,
    headers: Vec<(&str, &str)>,
    body: &[u8],
) -> (u16, Value) {
    request_body_result(address, method, path, headers, Some(body))
        .unwrap_or_else(|error| panic!("{method} {path} failed: {error}"))
}

fn request_body_result(
    address: SocketAddr,
    method: &str,
    path: &str,
    headers: Vec<(&str, &str)>,
    body: Option<&[u8]>,
) -> Result<(u16, Value), String> {
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
    if let Some(body) = body {
        write!(
            stream,
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        )
        .map_err(|error| error.to_string())?;
    }
    stream
        .write_all(b"\r\n")
        .map_err(|error| error.to_string())?;
    if let Some(body) = body {
        stream.write_all(body).map_err(|error| error.to_string())?;
    }
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
        let mut command = Command::new("bash");
        command
            .arg(collector_launcher())
            .env("RUDDER_ANALYTICS_COLLECTOR_BIN", binary);
        let process = Self::spawn_with_command(command, postgres, port);
        println!("collector_launcher_binary_sha256={binary_hash}");
        process
    }

    fn spawn_node(postgres: &PostgresHarness, port: u16) -> Self {
        let server_dir = repository_root().join("server");
        let tsx = server_dir.join("node_modules/.bin/tsx");
        assert!(
            tsx.is_file(),
            "Node/Rust process parity requires workspace dependencies; run pnpm install before the PostgreSQL integration test"
        );
        let mut command = Command::new(tsx);
        command
            .arg(server_dir.join("src/product-analytics-collector-server.ts"))
            .current_dir(server_dir);
        Self::spawn_with_command(command, postgres, port)
    }

    fn spawn_with_command(mut command: Command, postgres: &PostgresHarness, port: u16) -> Self {
        let identity_public_key = identity_public_key();
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
                identity_public_key,
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
            .env(
                "RUDDER_TELEMETRY_COLLECTOR_CONSENT_SYNC_SECRET",
                IDENTITY_CONSENT_SYNC_SECRET,
            )
            .env(
                "RUDDER_TELEMETRY_COLLECTOR_REVOKE_SECRET",
                IDENTITY_REVOKE_SECRET,
            )
            .env("RUDDER_TELEMETRY_COLLECTOR_REPORT_SECRET", REPORT_SECRET)
            .env("RUDDER_TELEMETRY_COLLECTOR_RETENTION_DAYS", "90")
            .env("RUDDER_TELEMETRY_COLLECTOR_PRIVACY_THRESHOLD", "2")
            .env("RUDDER_TELEMETRY_COLLECTOR_ROLLUP_INTERVAL_MS", "1000")
            .env("RUST_LOG", "error")
            .env_remove("DATABASE_URL")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = command
            .spawn()
            .unwrap_or_else(|error| panic!("spawn analytics collector process: {error}"));
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

fn repository_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("resolve Rudder repository root")
}

fn collector_launcher() -> PathBuf {
    repository_root().join("deploy/product-analytics/rust-collector-launcher.sh")
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
