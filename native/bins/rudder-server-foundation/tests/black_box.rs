#![cfg(unix)]

use rudder_archive_core::create_archive;
use rudder_server_foundation_core::{OrganizationScope, ServerConfig, ServerRuntime};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::postgres::PgPoolOptions;
use std::{
    env, fs,
    io::{self, BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, ChildStdout, Command, Stdio},
    time::{Duration, Instant},
};
use tempfile::TempDir;

const READ_PARITY_FIXTURE: &str =
    include_str!("../../../fixtures/workspace-backup-read-parity.json");

const ISSUE_APPROVAL_FIXTURE_SQL: &str = r#"
CREATE TABLE issues (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    project_id uuid,
    goal_id uuid,
    issue_number integer,
    identifier text,
    title text NOT NULL,
    description text,
    status text NOT NULL,
    priority text NOT NULL,
    board_order integer NOT NULL,
    assignee_agent_id uuid,
    assignee_user_id text,
    reviewer_agent_id uuid,
    reviewer_user_id text,
    revision bigint NOT NULL,
    fencing_token bigint NOT NULL,
    checkout_run_id uuid,
    execution_run_id uuid,
    started_at timestamptz,
    completed_at timestamptz,
    cancelled_at timestamptz,
    hidden_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);
CREATE TABLE approvals (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL,
    type text NOT NULL,
    requested_by_agent_id uuid,
    requested_by_user_id text,
    status text NOT NULL,
    revision bigint NOT NULL,
    decision text,
    decision_note text,
    decided_by_user_id text,
    decided_at timestamptz,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);
CREATE TABLE issue_approvals (
    org_id uuid NOT NULL,
    issue_id uuid NOT NULL,
    approval_id uuid NOT NULL,
    created_at timestamptz NOT NULL
);
INSERT INTO issues (
    id, org_id, issue_number, identifier, title, description, status, priority,
    board_order, assignee_user_id, reviewer_user_id, revision, fencing_token,
    started_at, created_at, updated_at
) VALUES
(
    '10000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    1, 'RUD-1', 'First issue', 'board parity', 'in_review', 'urgent',
    1, 'assignee-1', 'reviewer-1', 7, 11,
    '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-04T00:00:00Z'
), (
    '10000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000001',
    2, 'RUD-2', 'Second issue', NULL, 'todo', 'medium',
    2, NULL, NULL, 1, 2,
    NULL, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'
), (
    '10000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000001',
    3, 'RUD-3', 'Hidden issue', NULL, 'todo', 'low',
    3, NULL, NULL, 1, 1,
    NULL, '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z'
), (
    '10000000-0000-0000-0000-000000000099',
    '00000000-0000-0000-0000-000000000099',
    99, 'OTHER-99', 'Foreign issue', NULL, 'todo', 'medium',
    1, NULL, NULL, 1, 1,
    NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
), (
    '10000000-0000-0000-0000-000000000004',
    '00000000-0000-0000-0000-000000000001',
    4, 'RUD-4', 'Terminated issue', NULL, 'terminated', 'medium',
    4, NULL, NULL, 1, 1,
    NULL, '2026-01-04T00:00:00Z', '2026-01-04T00:00:00Z'
);
UPDATE issues
SET hidden_at = '2026-01-03T00:00:00Z'
WHERE id = '10000000-0000-0000-0000-000000000003';
INSERT INTO approvals (
    id, org_id, type, status, revision, payload, decision_note,
    created_at, updated_at
) VALUES (
    '20000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    'issue_review', 'pending', 3,
    '{"issueId":"10000000-0000-0000-0000-000000000001","secret":"must-not-leak"}',
    'safe note', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
), (
    '20000000-0000-0000-0000-000000000099',
    '00000000-0000-0000-0000-000000000099',
    'issue_review', 'pending', 1, '{}', NULL,
    '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
);
INSERT INTO issue_approvals (org_id, issue_id, approval_id, created_at) VALUES
(
    '00000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    '2026-01-01T00:00:00Z'
), (
    '00000000-0000-0000-0000-000000000099',
    '10000000-0000-0000-0000-000000000099',
    '20000000-0000-0000-0000-000000000099',
    '2026-01-01T00:00:00Z'
);
"#;

fn parity_fixture() -> Value {
    serde_json::from_str(READ_PARITY_FIXTURE).expect("workspace backup read parity fixture")
}

fn assert_parity_error(response: &str, fixture: &Value, error_name: &str) {
    let error = &fixture["apiErrors"][error_name];
    let status = error["status"].as_u64().expect("parity error status");
    assert!(
        response.starts_with(&format!("HTTP/1.1 {status}")),
        "expected {error_name} status {status}, got {response}"
    );
    if let Some(reason) = error["reason"].as_str() {
        assert!(
            response.contains(reason),
            "expected {error_name} reason {reason}, got {response}"
        );
    }
}

#[cfg(unix)]
#[test]
fn health_readiness_capabilities_and_sigterm_are_observable() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_rudder-server-foundation"))
        .env("RUDDER_NATIVE_LISTEN", "127.0.0.1:0")
        .env("RUDDER_NATIVE_DATABASE_REQUIRED", "false")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn server foundation");
    let stdout = child.stdout.take().expect("server stdout");
    let mut stdout = BufReader::new(stdout);
    let mut startup_line = String::new();
    stdout
        .read_line(&mut startup_line)
        .expect("startup receipt");
    let startup: Value = serde_json::from_str(&startup_line).expect("startup JSON");
    assert_eq!(
        startup["routeAuthority"]["schema"],
        "rudder.native.server.route-authority.v1"
    );
    assert_eq!(
        startup["routeAuthority"]["authoritySchema"],
        "rudder.migration.authority.v1"
    );
    assert_eq!(startup["routeAuthority"]["protocolVersion"], 1);
    assert_eq!(
        startup["routeAuthority"]["routes"].as_array().map(Vec::len),
        Some(24)
    );
    let bound_addr: SocketAddr = startup["boundAddr"]
        .as_str()
        .expect("bound address")
        .parse()
        .expect("socket address");
    assert_eq!(startup["publicListener"], false);
    assert_eq!(startup["productWriteAuthority"], false);
    assert_eq!(startup["databaseAuthority"], "read-only-product-data");
    assert_eq!(
        startup["readOnlyAuthorities"],
        serde_json::json!([
            "workspace_backup_list",
            "workspace_backup_files_list",
            "workspace_backup_file_read",
            "workspace_backup_download",
            "organization_read_surfaces",
            "issue_read_surfaces",
            "approval_read_surfaces",
            "activity_read_surfaces",
            "run_read_surfaces"
        ])
    );

    let health = get_with_retry(bound_addr, "/healthz");
    assert!(health.starts_with("HTTP/1.1 200"), "{health}");
    assert!(health.contains("rudder.native.server.health.v1"));

    let readiness = get_with_retry(bound_addr, "/readyz");
    assert!(readiness.starts_with("HTTP/1.1 200"), "{readiness}");
    assert!(readiness.contains("\"state\":\"disabled\""));

    let capabilities = get_with_retry(bound_addr, "/v1/capabilities");
    assert!(capabilities.starts_with("HTTP/1.1 200"), "{capabilities}");
    assert!(capabilities.contains("\"effectiveEngine\":\"rust\""));
    assert!(capabilities.contains("maxQueueDepth"));
    assert!(capabilities.contains("maxDatabaseConnections"));
    assert!(capabilities.contains("workspace_backup_list"));
    assert!(capabilities.contains("workspace_backup_files_list"));
    assert!(capabilities.contains("workspace_backup_file_read"));
    assert!(capabilities.contains("workspace_backup_download"));
    assert!(capabilities.contains("organization_read_surfaces"));
    assert!(capabilities.contains("activity_read_surfaces"));
    assert!(capabilities.contains("run_read_surfaces"));

    let read_without_scope = get_with_retry(bound_addr, "/internal/read-surfaces/v1/organizations");
    assert!(
        read_without_scope.starts_with("HTTP/1.1 503"),
        "{read_without_scope}"
    );
    assert!(read_without_scope.contains("read_surface_unavailable"));

    for path in [
        "/internal/read-surfaces/v1/orgs/00000000-0000-0000-0000-000000000001/issues",
        "/internal/read-surfaces/v1/issues/00000000-0000-0000-0000-000000000001",
        "/internal/read-surfaces/v1/orgs/00000000-0000-0000-0000-000000000001/approvals",
        "/internal/read-surfaces/v1/approvals/00000000-0000-0000-0000-000000000001",
        "/internal/read-surfaces/v1/orgs/00000000-0000-0000-0000-000000000001/activity",
        "/internal/read-surfaces/v1/orgs/00000000-0000-0000-0000-000000000001/runs",
    ] {
        let response = get_with_retry(bound_addr, path);
        assert!(response.starts_with("HTTP/1.1 503"), "{path}: {response}");
        assert!(
            response.contains("read_surface_unavailable"),
            "{path}: {response}"
        );
    }
    for path in [
        "/internal/read-surfaces/v1/orgs/00000000-0000-0000-0000-000000000001/issues?limit=1001",
        "/internal/read-surfaces/v1/orgs/00000000-0000-0000-0000-000000000001/approvals?limit=1001",
    ] {
        let response = get_with_retry(bound_addr, path);
        assert!(response.starts_with("HTTP/1.1 400"), "{path}: {response}");
        assert!(
            response.contains("read_surface_query_invalid"),
            "{path}: {response}"
        );
    }

    let parity = parity_fixture();

    let backup_list = get_with_retry(
        bound_addr,
        "/api/orgs/00000000-0000-0000-0000-000000000001/workspace/backups",
    );
    assert_parity_error(&backup_list, &parity, "databaseDisabled");

    let backup_files = get_with_retry(
        bound_addr,
        "/api/orgs/00000000-0000-0000-0000-000000000001/workspace/backups/10000000-0000-0000-0000-000000000001/files",
    );
    assert_parity_error(&backup_files, &parity, "databaseDisabled");
    let backup_download = get_with_retry(
        bound_addr,
        "/api/orgs/00000000-0000-0000-0000-000000000001/workspace/backups/10000000-0000-0000-0000-000000000001/download",
    );
    assert_parity_error(&backup_download, &parity, "databaseDisabled");

    let pid = child.id() as i32;
    let signal_result = unsafe { libc::kill(pid, libc::SIGTERM) };
    assert_eq!(signal_result, 0, "send SIGTERM");
    let status = child.wait().expect("wait for graceful stop");
    assert!(status.success(), "server exited with {status}");

    let mut remaining = String::new();
    stdout
        .read_to_string(&mut remaining)
        .expect("shutdown receipt");
    let shutdown: Value = remaining
        .lines()
        .find_map(|line| serde_json::from_str(line).ok())
        .expect("shutdown JSON");
    assert_eq!(shutdown["schema"], "rudder.native.server.shutdown.v1");
    assert_eq!(shutdown["state"], "stopped");
    assert_eq!(shutdown["reason"], "sigterm");
}

#[cfg(unix)]
#[test]
fn health_and_readiness_expose_non_authoritative_identity() {
    let (child, stdout, bound_addr) = spawn_server(&[]);

    let health = response_json(&get_with_retry(bound_addr, "/healthz"));
    let readiness = response_json(&get_with_retry(bound_addr, "/readyz"));
    for receipt in [&health, &readiness] {
        assert_eq!(
            receipt["identity"]["buildIdentity"]["package"],
            "rudder-server-foundation-core"
        );
        assert_eq!(
            receipt["identity"]["buildIdentity"]["version"],
            env!("CARGO_PKG_VERSION")
        );
        assert!(
            receipt["identity"]["buildIdentity"]["target"]
                .as_str()
                .is_some_and(|target| !target.is_empty())
        );
        assert!(receipt["identity"]["schemaFingerprint"].is_null());
        assert_eq!(receipt["identity"]["routeAuthority"], "node");
        assert_eq!(receipt["identity"]["commandAuthority"], "node");
        assert_eq!(receipt["identity"]["toolAuthority"], "node");
        assert_eq!(receipt["identity"]["ownershipEpoch"], 0);
        assert_eq!(receipt["identity"]["migrationState"], "node-authoritative");
    }

    stop_server(child, stdout);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
#[ignore = "set RUDDER_READ_SURFACES_DATABASE_URL and RUDDER_READ_SURFACES_ORG_ID for PostgreSQL integration"]
async fn trusted_read_surfaces_use_sqlx_and_fence_organizations() {
    let database_url = std::env::var("RUDDER_READ_SURFACES_DATABASE_URL")
        .expect("RUDDER_READ_SURFACES_DATABASE_URL");
    let organization_id =
        std::env::var("RUDDER_READ_SURFACES_ORG_ID").expect("RUDDER_READ_SURFACES_ORG_ID");
    let scope = OrganizationScope::single(organization_id.clone()).expect("organization scope");
    let config = ServerConfig {
        listen_addr: "127.0.0.1:0".parse().expect("loopback address"),
        database_url: Some(database_url),
        database_required: true,
        trusted_organization_scope: Some(scope),
        ..Default::default()
    };
    let runtime = ServerRuntime::bind(config).expect("bind read-surface server");
    let bound_addr = runtime.bound_addr();
    let control = runtime.control();
    let server = tokio::spawn(runtime.run());

    let organizations = tokio::task::spawn_blocking(move || {
        get_with_retry(
            bound_addr,
            "/internal/read-surfaces/v1/organizations?limit=1",
        )
    })
    .await
    .expect("organization request task");
    assert!(organizations.starts_with("HTTP/1.1 200"), "{organizations}");
    let organization_page = response_json(&organizations);
    assert_eq!(organization_page["items"].as_array().map(Vec::len), Some(1));
    assert_eq!(organization_page["items"][0]["id"], organization_id);

    let issue_list_path =
        format!("/internal/read-surfaces/v1/orgs/{organization_id}/issues?limit=1");
    let approval_list_path =
        format!("/internal/read-surfaces/v1/orgs/{organization_id}/approvals?limit=1");
    let activity_list_path =
        format!("/internal/read-surfaces/v1/orgs/{organization_id}/activity?limit=1");
    let run_list_path = format!("/internal/read-surfaces/v1/orgs/{organization_id}/runs?limit=1");
    let read_surface_lists = tokio::task::spawn_blocking(move || {
        [
            get_with_retry(bound_addr, &issue_list_path),
            get_with_retry(bound_addr, &approval_list_path),
            get_with_retry(bound_addr, &activity_list_path),
            get_with_retry(bound_addr, &run_list_path),
        ]
    })
    .await
    .expect("issue and approval list request task");
    for response in read_surface_lists {
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        let page = response_json(&response);
        assert!(
            page["items"]
                .as_array()
                .is_some_and(|items| items.len() <= 1)
        );
    }

    let foreign_read_surfaces = tokio::task::spawn_blocking(move || {
        [
            get_with_retry(
                bound_addr,
                "/internal/read-surfaces/v1/orgs/00000000-0000-0000-0000-000000000099/issues",
            ),
            get_with_retry(
                bound_addr,
                "/internal/read-surfaces/v1/orgs/00000000-0000-0000-0000-000000000099/approvals",
            ),
            get_with_retry(
                bound_addr,
                "/internal/read-surfaces/v1/orgs/00000000-0000-0000-0000-000000000099/activity",
            ),
            get_with_retry(
                bound_addr,
                "/internal/read-surfaces/v1/orgs/00000000-0000-0000-0000-000000000099/runs",
            ),
        ]
    })
    .await
    .expect("foreign issue and approval list request task");
    for response in foreign_read_surfaces {
        assert!(response.starts_with("HTTP/1.1 404"), "{response}");
        assert!(response.contains("read_surface_not_found"), "{response}");
    }

    let issue_limit_path =
        format!("/internal/read-surfaces/v1/orgs/{organization_id}/issues?limit=1001");
    let approval_limit_path =
        format!("/internal/read-surfaces/v1/orgs/{organization_id}/approvals?limit=1001");
    let activity_limit_path =
        format!("/internal/read-surfaces/v1/orgs/{organization_id}/activity?limit=101");
    let run_limit_path =
        format!("/internal/read-surfaces/v1/orgs/{organization_id}/runs?limit=101");
    let invalid_read_surface_limits = tokio::task::spawn_blocking(move || {
        [
            get_with_retry(bound_addr, &issue_limit_path),
            get_with_retry(bound_addr, &approval_limit_path),
            get_with_retry(bound_addr, &activity_limit_path),
            get_with_retry(bound_addr, &run_limit_path),
        ]
    })
    .await
    .expect("invalid issue and approval list limit request task");
    for response in invalid_read_surface_limits {
        assert!(response.starts_with("HTTP/1.1 400"), "{response}");
        assert!(
            response.contains("read_surface_query_invalid"),
            "{response}"
        );
    }

    let foreign = tokio::task::spawn_blocking(move || {
        get_with_retry(
            bound_addr,
            "/internal/read-surfaces/v1/orgs/00000000-0000-0000-0000-000000000099/goals",
        )
    })
    .await
    .expect("foreign organization request task");
    assert!(foreign.starts_with("HTTP/1.1 404"), "{foreign}");
    assert!(foreign.contains("read_surface_not_found"), "{foreign}");

    let invalid_limit = tokio::task::spawn_blocking(move || {
        get_with_retry(
            bound_addr,
            "/internal/read-surfaces/v1/organizations?limit=1001",
        )
    })
    .await
    .expect("invalid limit request task");
    assert!(invalid_limit.starts_with("HTTP/1.1 400"), "{invalid_limit}");
    assert!(invalid_limit.contains("read_surface_query_invalid"));

    control.shutdown().await;
    server.await.expect("server task").expect("server shutdown");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn issue_and_approval_read_surfaces_use_disposable_postgres_and_fence_reads() {
    const ORG_ID: &str = "00000000-0000-0000-0000-000000000001";
    let postgres = PostgresHarness::start();
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&postgres.url)
        .await
        .expect("connect issue and approval PostgreSQL fixture");
    sqlx::raw_sql(ISSUE_APPROVAL_FIXTURE_SQL)
        .execute(&pool)
        .await
        .expect("install issue and approval fixture");
    pool.close().await;

    let config = ServerConfig {
        listen_addr: "127.0.0.1:0".parse().expect("loopback address"),
        database_url: Some(postgres.url.clone()),
        database_required: true,
        max_response_bytes: 4096,
        trusted_organization_scope: Some(
            OrganizationScope::single(ORG_ID).expect("trusted organization scope"),
        ),
        ..Default::default()
    };
    let runtime = ServerRuntime::bind(config).expect("bind issue and approval server");
    let bound_addr = runtime.bound_addr();
    let control = runtime.control();
    let server = tokio::spawn(runtime.run());

    let first_issue_path = format!("/internal/read-surfaces/v1/orgs/{ORG_ID}/issues?limit=1");
    let first_approval_path = format!("/internal/read-surfaces/v1/orgs/{ORG_ID}/approvals?limit=1");
    let (first_issue, first_approval) = tokio::task::spawn_blocking(move || {
        (
            get_with_retry(bound_addr, &first_issue_path),
            get_with_retry(bound_addr, &first_approval_path),
        )
    })
    .await
    .expect("first issue and approval request task");
    assert!(first_issue.starts_with("HTTP/1.1 200"), "{first_issue}");
    assert!(
        first_approval.starts_with("HTTP/1.1 200"),
        "{first_approval}"
    );
    assert!(response_body_len(&first_issue) <= 4096);
    assert!(response_body_len(&first_approval) <= 4096);

    let first_issue_body = response_json(&first_issue);
    assert_eq!(first_issue_body["items"].as_array().map(Vec::len), Some(1));
    assert_eq!(first_issue_body["items"][0]["identifier"], "RUD-1");
    assert_eq!(first_issue_body["items"][0]["status"], "in_review");
    assert_eq!(first_issue_body["hasMore"], true);
    let cursor = first_issue_body["nextCursor"]
        .as_str()
        .expect("issue next cursor")
        .to_owned();
    let second_issue_path =
        format!("/internal/read-surfaces/v1/orgs/{ORG_ID}/issues?limit=1&cursor={cursor}");
    let second_issue =
        tokio::task::spawn_blocking(move || get_with_retry(bound_addr, &second_issue_path))
            .await
            .expect("second issue request task");
    assert!(second_issue.starts_with("HTTP/1.1 200"), "{second_issue}");
    let second_issue_body = response_json(&second_issue);
    assert_eq!(second_issue_body["items"].as_array().map(Vec::len), Some(1));
    assert_eq!(second_issue_body["items"][0]["identifier"], "RUD-2");
    assert_eq!(second_issue_body["hasMore"], false);
    assert!(!second_issue.contains("RUD-3"));
    assert!(!second_issue.contains("RUD-4"));

    let first_approval_body = response_json(&first_approval);
    assert_eq!(
        first_approval_body["items"].as_array().map(Vec::len),
        Some(1)
    );
    assert_eq!(
        first_approval_body["items"][0]["approvalType"],
        "issue_review"
    );
    assert_eq!(
        first_approval_body["items"][0]["targets"][0]["kind"],
        "issue"
    );
    assert_eq!(
        first_approval_body["items"][0]["targets"][0]["id"],
        "10000000-0000-0000-0000-000000000001"
    );
    assert!(!first_approval.to_ascii_lowercase().contains("payload"));
    assert!(!first_approval.contains("must-not-leak"));

    let issue_get_path = "/internal/read-surfaces/v1/issues/10000000-0000-0000-0000-000000000001";
    let approval_get_path =
        "/internal/read-surfaces/v1/approvals/20000000-0000-0000-0000-000000000001";
    let hidden_issue_get_path =
        "/internal/read-surfaces/v1/issues/10000000-0000-0000-0000-000000000003";
    let terminated_issue_get_path =
        "/internal/read-surfaces/v1/issues/10000000-0000-0000-0000-000000000004";
    let foreign_issue_get_path =
        "/internal/read-surfaces/v1/issues/10000000-0000-0000-0000-000000000099";
    let foreign_approval_get_path =
        "/internal/read-surfaces/v1/approvals/20000000-0000-0000-0000-000000000099";
    let responses = tokio::task::spawn_blocking(move || {
        [
            get_with_retry(bound_addr, issue_get_path),
            get_with_retry(bound_addr, approval_get_path),
            get_with_retry(bound_addr, hidden_issue_get_path),
            get_with_retry(bound_addr, terminated_issue_get_path),
            get_with_retry(bound_addr, foreign_issue_get_path),
            get_with_retry(bound_addr, foreign_approval_get_path),
        ]
    })
    .await
    .expect("issue and approval get request task");
    let issue_get = &responses[0];
    assert!(issue_get.starts_with("HTTP/1.1 200"), "{issue_get}");
    let issue_body = response_json(issue_get);
    assert_eq!(issue_body["identifier"], "RUD-1");
    assert_eq!(issue_body["priority"], "urgent");
    assert_eq!(issue_body["assigneeUserId"], "assignee-1");
    assert_eq!(issue_body["reviewerUserId"], "reviewer-1");
    assert_eq!(issue_body["revision"], 7);
    assert_eq!(issue_body["fencingToken"], 11);
    assert_eq!(issue_body["startedAt"], "2026-01-02T00:00:00.000000Z");
    assert_eq!(issue_body["createdAt"], "2026-01-01T00:00:00.000000Z");
    assert_eq!(issue_body["updatedAt"], "2026-01-04T00:00:00.000000Z");
    assert!(response_body_len(issue_get) <= 4096);

    let approval_get = &responses[1];
    assert!(approval_get.starts_with("HTTP/1.1 200"), "{approval_get}");
    assert_eq!(response_json(approval_get)["status"], "pending");
    assert!(!approval_get.to_ascii_lowercase().contains("payload"));
    assert!(!approval_get.contains("must-not-leak"));
    assert!(response_body_len(approval_get) <= 4096);

    assert!(responses[2].starts_with("HTTP/1.1 200"), "{}", responses[2]);
    assert!(responses[2].contains("hiddenAt"), "{}", responses[2]);
    assert!(responses[3].starts_with("HTTP/1.1 200"), "{}", responses[3]);
    assert!(responses[3].contains("terminated"), "{}", responses[3]);
    for response in [&responses[4], &responses[5]] {
        assert!(response.starts_with("HTTP/1.1 404"), "{response}");
        assert!(response.contains("read_surface_not_found"), "{response}");
    }

    control.shutdown().await;
    server
        .await
        .expect("issue and approval server task")
        .expect("issue and approval server shutdown");
}

#[cfg(unix)]
#[test]
fn authority_introspection_is_versioned_bounded_and_fail_closed() {
    let (child, stdout, bound_addr) = spawn_server(&[]);

    let startup = response_json(&get_with_retry(bound_addr, "/v1/authority"));
    assert_eq!(startup["schema"], "rudder.native.server.route-authority.v1");
    assert_eq!(startup["authoritySchema"], "rudder.migration.authority.v1");
    assert_eq!(startup["protocolVersion"], 1);
    assert_eq!(startup["status"], "ready");
    assert_eq!(startup["publicListener"], false);
    assert_eq!(startup["productWriteAuthority"], false);
    assert_eq!(startup["nodeAuthorityUnchanged"], true);

    let routes = startup["routes"].as_array().expect("authority routes");
    assert_eq!(routes.len(), 24);
    assert!(routes.iter().any(|route| {
        route["routeId"] == "foundation.authority"
            && route["decision"] == "rust"
            && route["owner"] == "rust"
    }));
    assert!(routes.iter().any(|route| {
        route["routeId"] == "node.product_http"
            && route["decision"] == "legacy"
            && route["owner"] == "legacy"
    }));

    let selected = response_json(&get_with_retry(
        bound_addr,
        "/v1/authority?route=%2Fhealthz",
    ));
    assert_eq!(selected["selectedRoute"]["routeId"], "foundation.health");
    assert_eq!(selected["selectedRoute"]["decision"], "rust");
    assert!(selected.get("fencingToken").is_none());
    let selected_text = get_with_retry(bound_addr, "/v1/authority?route=%2Fhealthz");
    assert!(!selected_text.contains("fencingToken"));
    assert!(!selected_text.contains("secret"));

    let unknown = get_with_retry(bound_addr, "/v1/authority?route=%2Fnot-registered");
    assert!(unknown.starts_with("HTTP/1.1 404"), "{unknown}");
    assert!(unknown.contains("unknown_route"), "{unknown}");

    let malformed = get_with_retry(bound_addr, "/v1/authority?route=");
    assert!(malformed.starts_with("HTTP/1.1 400"), "{malformed}");
    assert!(
        malformed.contains("malformed_authority_query"),
        "{malformed}"
    );

    let duplicate = get_with_retry(bound_addr, "/v1/authority?route=%2Fhealthz&route=%2Freadyz");
    assert!(duplicate.starts_with("HTTP/1.1 400"), "{duplicate}");
    assert!(
        duplicate.contains("malformed_authority_query"),
        "{duplicate}"
    );

    let extra_parameter = get_with_retry(bound_addr, "/v1/authority?owner=legacy");
    assert!(
        extra_parameter.starts_with("HTTP/1.1 400"),
        "{extra_parameter}"
    );
    assert!(
        extra_parameter.contains("malformed_authority_query"),
        "{extra_parameter}"
    );

    let method_not_allowed =
        http_request(bound_addr, "POST", "/v1/authority").expect("POST authority endpoint");
    assert!(
        method_not_allowed.starts_with("HTTP/1.1 404"),
        "{method_not_allowed}"
    );

    stop_server(child, stdout);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn workspace_backup_list_uses_postgres_and_preserves_the_read_only_contract() {
    let postgres = PostgresHarness::start();
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&postgres.url)
        .await
        .expect("connect test PostgreSQL");
    sqlx::raw_sql(WORKSPACE_BACKUP_FIXTURE_SQL)
        .execute(&pool)
        .await
        .expect("install workspace backup fixture");
    pool.close().await;

    let (child, stdout, bound_addr) = spawn_server(&[
        ("RUDDER_NATIVE_DATABASE_URL", postgres.url.as_str()),
        ("RUDDER_NATIVE_DATABASE_REQUIRED", "true"),
        ("RUDDER_NATIVE_MAX_RESPONSE_BYTES", "4096"),
    ]);

    let org_one = get_with_retry(
        bound_addr,
        "/api/orgs/00000000-0000-0000-0000-000000000001/workspace/backups",
    );
    assert!(org_one.starts_with("HTTP/1.1 200"), "{org_one}");
    let org_one_body = response_json(&org_one);
    let backups = org_one_body["backups"].as_array().expect("backup array");
    assert_eq!(
        backups.len(),
        2,
        "deleted and cross-org rows must be absent"
    );
    assert_eq!(backups[0]["id"], "10000000-0000-0000-0000-000000000002");
    assert_eq!(backups[1]["id"], "10000000-0000-0000-0000-000000000001");
    assert_eq!(backups[0]["orgId"], "00000000-0000-0000-0000-000000000001");
    assert_eq!(backups[0]["artifactProvider"], "local_file");
    assert_eq!(backups[0]["warnings"], serde_json::json!([]));
    assert_eq!(backups[0]["expiresAt"], "2026-09-30T12:00:00.000Z");
    assert_eq!(backups[1]["warnings"], serde_json::json!(["older"]));
    assert_eq!(backups[1]["expiresAt"], "2026-10-15T12:00:00.000Z");

    let org_two = get_with_retry(
        bound_addr,
        "/api/orgs/00000000-0000-0000-0000-000000000002/workspace/backups",
    );
    let org_two_body = response_json(&org_two);
    assert_eq!(org_two_body["backups"].as_array().unwrap().len(), 1);
    assert_eq!(
        org_two_body["backups"][0]["orgId"],
        "00000000-0000-0000-0000-000000000002"
    );

    let unknown = get_with_retry(
        bound_addr,
        "/api/orgs/00000000-0000-0000-0000-000000000099/workspace/backups",
    );
    assert!(unknown.starts_with("HTTP/1.1 404"), "{unknown}");
    assert!(unknown.contains("organization_not_found"), "{unknown}");

    let post = http_request(
        bound_addr,
        "POST",
        "/api/orgs/00000000-0000-0000-0000-000000000001/workspace/backups",
    )
    .expect("POST backup route");
    assert!(post.starts_with("HTTP/1.1 404"), "{post}");
    stop_server(child, stdout);

    let (limited_child, limited_stdout, limited_addr) = spawn_server(&[
        ("RUDDER_NATIVE_DATABASE_URL", postgres.url.as_str()),
        ("RUDDER_NATIVE_DATABASE_REQUIRED", "true"),
        ("RUDDER_NATIVE_MAX_RESPONSE_BYTES", "128"),
    ]);
    let limited = get_with_retry(
        limited_addr,
        "/api/orgs/00000000-0000-0000-0000-000000000001/workspace/backups",
    );
    assert!(limited.starts_with("HTTP/1.1 500"), "{limited}");
    assert!(limited.contains("response_limit"), "{limited}");
    assert!(response_body_len(&limited) <= 128, "{limited}");
    stop_server(limited_child, limited_stdout);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn workspace_backup_files_list_validates_artifact_and_preserves_scope() {
    let postgres = PostgresHarness::start();
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&postgres.url)
        .await
        .expect("connect test PostgreSQL");
    sqlx::raw_sql(WORKSPACE_BACKUP_FIXTURE_SQL)
        .execute(&pool)
        .await
        .expect("install workspace backup fixture");

    let fixture = workspace_backup_archive_fixture();
    let parity = parity_fixture();
    sqlx::query(
        "UPDATE workspace_backups SET status = 'succeeded', artifact_ref = $1, archive_sha256 = $2 WHERE id = $3::uuid",
    )
    .bind(fixture.archive.to_string_lossy().as_ref())
    .bind(&fixture.sha256)
    .bind("10000000-0000-0000-0000-000000000002")
    .execute(&pool)
    .await
    .expect("attach workspace backup artifact");

    let (child, stdout, bound_addr) = spawn_server(&[
        ("RUDDER_NATIVE_DATABASE_URL", postgres.url.as_str()),
        ("RUDDER_NATIVE_DATABASE_REQUIRED", "true"),
        ("RUDDER_NATIVE_MAX_RESPONSE_BYTES", "4096"),
        ("TZ", "Asia/Shanghai"),
    ]);
    let route = "/api/orgs/00000000-0000-0000-0000-000000000001/workspace/backups/10000000-0000-0000-0000-000000000002/files";
    let download_route = "/api/orgs/00000000-0000-0000-0000-000000000001/workspace/backups/10000000-0000-0000-0000-000000000002/download";

    let download = get_bytes_with_retry(bound_addr, download_route);
    let (download_headers, download_body) = response_parts(&download);
    let expected_archive = fs::read(&fixture.archive).expect("read expected v2 archive");
    assert!(
        download_headers.starts_with("HTTP/1.1 200"),
        "{download_headers}"
    );
    assert!(
        download_headers
            .to_ascii_lowercase()
            .contains("content-type: application/zip")
    );
    assert!(download_headers.contains(&format!("content-length: {}", expected_archive.len())));
    assert!(download_headers.contains(&format!("x-rudder-archive-sha256: {}", fixture.sha256)));
    assert!(
        download_headers.contains("content-disposition: attachment; filename=\"workspace.zip\"")
    );
    assert_eq!(download_body, expected_archive);

    sqlx::query("UPDATE workspace_backups SET archive_sha256 = NULL WHERE id = $1::uuid")
        .bind("10000000-0000-0000-0000-000000000002")
        .execute(&pool)
        .await
        .expect("clear optional archive checksum");
    let unhashed_download = get_bytes_with_retry(bound_addr, download_route);
    let (unhashed_headers, unhashed_body) = response_parts(&unhashed_download);
    assert!(!unhashed_headers.contains("x-rudder-archive-sha256"));
    assert_eq!(unhashed_body, expected_archive);
    sqlx::query("UPDATE workspace_backups SET archive_sha256 = $1 WHERE id = $2::uuid")
        .bind(&fixture.sha256)
        .bind("10000000-0000-0000-0000-000000000002")
        .execute(&pool)
        .await
        .expect("restore optional archive checksum");

    let cross_org_download = get_with_retry(
        bound_addr,
        "/api/orgs/00000000-0000-0000-0000-000000000002/workspace/backups/10000000-0000-0000-0000-000000000002/download",
    );
    assert_parity_error(&cross_org_download, &parity, "backupNotFound");
    let post_download =
        http_request(bound_addr, "POST", download_route).expect("POST backup download route");
    assert_parity_error(&post_download, &parity, "mutationRouteMissing");

    let root = response_json(&get_with_retry(bound_addr, route));
    assert_eq!(root["source"], "org_root");
    assert_eq!(
        root["rootPath"],
        "backup:10000000-0000-0000-0000-000000000002"
    );
    assert_eq!(root["directoryPath"], "");
    assert_eq!(
        root["entries"],
        serde_json::json!([
            {"name":"docs","path":"docs","isDirectory":true},
            {"name":"nested","path":"nested","isDirectory":true},
            {"name":"binary.bin","path":"binary.bin","isDirectory":false},
            {"name":"root.txt","path":"root.txt","isDirectory":false}
        ])
    );

    let docs = response_json(&get_with_retry(bound_addr, &format!("{route}?path=docs")));
    assert_eq!(
        docs["entries"],
        serde_json::json!([
            {"name":"alpha.txt","path":"docs/alpha.txt","isDirectory":false},
            {"name":"readme.md","path":"docs/readme.md","isDirectory":false}
        ])
    );

    let empty = response_json(&get_with_retry(
        bound_addr,
        &format!("{route}?path=missing"),
    ));
    assert_eq!(empty["entries"], serde_json::json!([]));
    assert_eq!(empty["message"], "This backup folder is empty.");

    let ordering_source = fixture._root.path().join("ordering.txt");
    fs::write(&ordering_source, b"x").expect("write ordering fixture source");
    let ordering_entries = parity["ordering"]["publicInput"]
        .as_array()
        .expect("ordering input")
        .iter()
        .map(|name| {
            let name = name.as_str().expect("ordering filename");
            serde_json::json!({
                "path": name,
                "kind": "file",
                "byteSize": 1,
                "mtimeMs": null,
                "mode": null,
                "sha256": format!("{:x}", Sha256::digest(b"x"))
            })
        })
        .collect::<Vec<_>>();
    let mut ordering_plan = vec![serde_json::json!({
        "kind": "directory",
        "archivePath": "workspace/"
    })];
    ordering_plan.extend(parity["ordering"]["publicInput"]
        .as_array()
        .expect("ordering input")
        .iter()
        .map(|name| serde_json::json!({
            "kind": "file",
            "archivePath": format!("workspace/{}", name.as_str().expect("ordering filename")),
            "sourcePath": ordering_source
        })));
    let (ordering_archive, ordering_sha256) = create_workspace_backup_archive(
        fixture._root.path(),
        "ordering",
        &ordering_entries,
        &ordering_plan,
        "workspace-backup-v2-policy-1",
        None,
    );
    sqlx::query(
        "UPDATE workspace_backups SET artifact_ref = $1, archive_sha256 = $2 WHERE id = $3::uuid",
    )
    .bind(ordering_archive.to_string_lossy().as_ref())
    .bind(ordering_sha256)
    .bind("10000000-0000-0000-0000-000000000002")
    .execute(&pool)
    .await
    .expect("attach ordering workspace backup artifact");
    let ordered_root = response_json(&get_with_retry(bound_addr, route));
    let ordered_names = ordered_root["entries"]
        .as_array()
        .expect("ordered root entries")
        .iter()
        .map(|entry| entry["name"].as_str().expect("ordered entry name"))
        .collect::<Vec<_>>();
    let expected_names = parity["ordering"]["publicExpected"]
        .as_array()
        .expect("ordering expected")
        .iter()
        .map(|name| name.as_str().expect("expected ordering filename"))
        .collect::<Vec<_>>();
    assert_eq!(ordered_names, expected_names);
    sqlx::query(
        "UPDATE workspace_backups SET artifact_ref = $1, archive_sha256 = $2 WHERE id = $3::uuid",
    )
    .bind(fixture.archive.to_string_lossy().as_ref())
    .bind(&fixture.sha256)
    .bind("10000000-0000-0000-0000-000000000002")
    .execute(&pool)
    .await
    .expect("restore primary workspace backup artifact");

    let file_route = "/api/orgs/00000000-0000-0000-0000-000000000001/workspace/backups/10000000-0000-0000-0000-000000000002/file?path=docs%2Freadme.md";
    let readme_response = get_with_retry(bound_addr, file_route);
    assert!(
        readme_response.starts_with("HTTP/1.1 200"),
        "{readme_response}"
    );
    let readme = response_json(&readme_response);
    assert_eq!(readme["source"], "org_root");
    assert_eq!(
        readme["rootPath"],
        "backup:10000000-0000-0000-0000-000000000002"
    );
    assert_eq!(readme["filePath"], "docs/readme.md");
    assert_eq!(readme["content"], "readme");
    assert_eq!(
        readme["contentType"],
        parity["preview"]["text"]["contentType"]
    );
    assert_eq!(
        readme["previewKind"],
        parity["preview"]["text"]["previewKind"]
    );
    assert_eq!(readme["truncated"], parity["preview"]["text"]["truncated"]);
    assert_eq!(readme["message"], parity["preview"]["text"]["message"]);

    sqlx::query(
        "UPDATE workspace_backups SET artifact_ref = $1, archive_sha256 = $2 WHERE id = $3::uuid",
    )
    .bind(fixture.windows_archive.to_string_lossy().as_ref())
    .bind(&fixture.windows_sha256)
    .bind("10000000-0000-0000-0000-000000000002")
    .execute(&pool)
    .await
    .expect("attach Windows-root workspace backup artifact");
    let windows_root = response_json(&get_with_retry(bound_addr, route));
    assert_eq!(windows_root["entries"], root["entries"]);
    let windows_readme = response_json(&get_with_retry(bound_addr, file_route));
    assert_eq!(windows_readme["filePath"], "docs/readme.md");
    assert_eq!(windows_readme["content"], "readme");

    sqlx::query(
        "UPDATE workspace_backups SET artifact_ref = $1, archive_sha256 = $2 WHERE id = $3::uuid",
    )
    .bind(fixture.archive.to_string_lossy().as_ref())
    .bind(&fixture.sha256)
    .bind("10000000-0000-0000-0000-000000000002")
    .execute(&pool)
    .await
    .expect("restore primary workspace backup artifact after Windows-root checks");

    let binary_route = "/api/orgs/00000000-0000-0000-0000-000000000001/workspace/backups/10000000-0000-0000-0000-000000000002/file?path=binary.bin";
    let binary_response = get_with_retry(bound_addr, binary_route);
    assert!(
        binary_response.starts_with("HTTP/1.1 200"),
        "{binary_response}"
    );
    let binary = response_json(&binary_response);
    assert_eq!(binary["content"], Value::Null);
    assert_eq!(
        binary["contentType"],
        parity["preview"]["binary"]["contentType"]
    );
    assert_eq!(
        binary["previewKind"],
        parity["preview"]["binary"]["previewKind"]
    );
    assert_eq!(binary["message"], parity["preview"]["binary"]["message"]);
    assert_eq!(
        binary["truncated"],
        parity["preview"]["binary"]["truncated"]
    );

    let missing_file = get_with_retry(
        bound_addr,
        "/api/orgs/00000000-0000-0000-0000-000000000001/workspace/backups/10000000-0000-0000-0000-000000000002/file?path=missing.txt",
    );
    assert_parity_error(&missing_file, &parity, "fileNotFound");

    let invalid_file_path = get_with_retry(
        bound_addr,
        "/api/orgs/00000000-0000-0000-0000-000000000001/workspace/backups/10000000-0000-0000-0000-000000000002/file?path=..%2Fsecret",
    );
    assert_parity_error(&invalid_file_path, &parity, "pathInvalid");

    let cross_org_file = get_with_retry(
        bound_addr,
        "/api/orgs/00000000-0000-0000-0000-000000000002/workspace/backups/10000000-0000-0000-0000-000000000002/file?path=docs%2Freadme.md",
    );
    assert_parity_error(&cross_org_file, &parity, "backupNotFound");

    let post_file = http_request(bound_addr, "POST", file_route).expect("POST backup file route");
    assert_parity_error(&post_file, &parity, "mutationRouteMissing");

    let invalid_path = get_with_retry(bound_addr, &format!("{route}?path=..%2Fsecret"));
    assert_parity_error(&invalid_path, &parity, "pathInvalid");

    let cross_org = get_with_retry(
        bound_addr,
        "/api/orgs/00000000-0000-0000-0000-000000000002/workspace/backups/10000000-0000-0000-0000-000000000002/files",
    );
    assert_parity_error(&cross_org, &parity, "backupNotFound");

    let post = http_request(bound_addr, "POST", route).expect("POST backup files route");
    assert_parity_error(&post, &parity, "mutationRouteMissing");

    for (archive, sha256) in &fixture.invalid_archives {
        sqlx::query(
            "UPDATE workspace_backups SET artifact_ref = $1, archive_sha256 = $2 WHERE id = $3::uuid",
        )
        .bind(archive.to_string_lossy().as_ref())
        .bind(sha256)
        .bind("10000000-0000-0000-0000-000000000002")
        .execute(&pool)
        .await
        .expect("attach invalid workspace backup artifact");
        let invalid = get_with_retry(bound_addr, route);
        assert_parity_error(&invalid, &parity, "artifactInvalid");
        let invalid_download = get_with_retry(bound_addr, download_route);
        assert_parity_error(&invalid_download, &parity, "artifactInvalid");
    }

    sqlx::query(
        "UPDATE workspace_backups SET artifact_ref = $1, archive_sha256 = $2 WHERE id = $3::uuid",
    )
    .bind(fixture.aggregate_limit_archive.to_string_lossy().as_ref())
    .bind(&fixture.aggregate_limit_sha256)
    .bind("10000000-0000-0000-0000-000000000002")
    .execute(&pool)
    .await
    .expect("attach aggregate-limit workspace backup artifact");
    let aggregate_limit = get_with_retry_read_timeout(bound_addr, route, Duration::from_secs(120));
    assert_parity_error(&aggregate_limit, &parity, "artifactInvalid");
    let aggregate_download =
        get_with_retry_read_timeout(bound_addr, download_route, Duration::from_secs(120));
    assert_parity_error(&aggregate_download, &parity, "artifactInvalid");

    sqlx::query(
        "UPDATE workspace_backups SET artifact_ref = $1, archive_sha256 = $2 WHERE id = $3::uuid",
    )
    .bind(fixture.archive.to_string_lossy().as_ref())
    .bind(&fixture.sha256)
    .bind("10000000-0000-0000-0000-000000000002")
    .execute(&pool)
    .await
    .expect("restore valid workspace backup artifact");

    sqlx::query(
        "UPDATE workspace_backups SET status = 'succeeded', artifact_ref = $1, archive_sha256 = $2 WHERE id = $3::uuid",
    )
    .bind(fixture.legacy_artifact.to_string_lossy().as_ref())
    .bind(&fixture.legacy_sha256)
    .bind("10000000-0000-0000-0000-000000000001")
    .execute(&pool)
    .await
    .expect("attach legacy workspace backup artifact");
    let legacy_route = "/api/orgs/00000000-0000-0000-0000-000000000001/workspace/backups/10000000-0000-0000-0000-000000000001/files?path=docs";
    let legacy = response_json(&get_with_retry(bound_addr, legacy_route));
    assert_eq!(legacy["entries"], docs["entries"]);

    let legacy_file_route = "/api/orgs/00000000-0000-0000-0000-000000000001/workspace/backups/10000000-0000-0000-0000-000000000001/file?path=root.txt";
    let legacy_file_response = get_with_retry(bound_addr, legacy_file_route);
    assert!(
        legacy_file_response.starts_with("HTTP/1.1 200"),
        "{legacy_file_response}"
    );
    let legacy_file = response_json(&legacy_file_response);
    assert_eq!(legacy_file["filePath"], "root.txt");
    assert_eq!(legacy_file["content"], "root");
    assert_eq!(legacy_file["contentType"], "text/plain");
    assert_eq!(legacy_file["previewKind"], "text");

    let legacy_download_route = "/api/orgs/00000000-0000-0000-0000-000000000001/workspace/backups/10000000-0000-0000-0000-000000000001/download";
    let legacy_download = get_bytes_with_retry(bound_addr, legacy_download_route);
    let (legacy_headers, legacy_body) = response_parts(&legacy_download);
    assert!(
        legacy_headers.starts_with("HTTP/1.1 200"),
        "{legacy_headers}"
    );
    assert!(legacy_headers.contains("content-disposition: attachment; filename=\"workspace.zip\""));
    assert!(legacy_body.starts_with(b"PK\x03\x04"));
    let legacy_download_sha256 = format!("{:x}", Sha256::digest(legacy_body));
    assert!(legacy_headers.contains(&format!(
        "x-rudder-archive-sha256: {legacy_download_sha256}"
    )));
    let mut legacy_zip =
        zip::ZipArchive::new(std::io::Cursor::new(legacy_body)).expect("open legacy download ZIP");
    assert!(legacy_zip.by_name("workspace/").is_ok());
    assert!(legacy_zip.by_name("workspace/docs/").is_ok());
    let mut legacy_root = legacy_zip
        .by_name("workspace/root.txt")
        .expect("legacy root file");
    assert_eq!(legacy_root.size(), 4);
    assert_eq!(
        legacy_root
            .last_modified()
            .expect("legacy root modified time")
            .hour(),
        parity["download"]["asiaShanghaiHour"]
            .as_u64()
            .expect("Asia/Shanghai fixture hour") as u8,
        "2024-01-01T00:00:00Z must use the Node process timezone"
    );
    let mut legacy_root_content = String::new();
    legacy_root
        .read_to_string(&mut legacy_root_content)
        .expect("read legacy root file");
    assert_eq!(legacy_root_content, "root");

    sqlx::query("UPDATE workspace_backups SET status = 'running' WHERE id = $1::uuid")
        .bind("10000000-0000-0000-0000-000000000001")
        .execute(&pool)
        .await
        .expect("mark backup running");
    let running = get_with_retry(bound_addr, legacy_file_route);
    assert_parity_error(&running, &parity, "backupRunning");
    let running_download = get_with_retry(bound_addr, legacy_download_route);
    assert_parity_error(&running_download, &parity, "backupRunning");

    sqlx::query("UPDATE workspace_backups SET status = 'failed' WHERE id = $1::uuid")
        .bind("10000000-0000-0000-0000-000000000001")
        .execute(&pool)
        .await
        .expect("mark backup failed");
    let failed = get_with_retry(bound_addr, legacy_file_route);
    assert_parity_error(&failed, &parity, "backupFailed");
    let failed_download = get_with_retry(bound_addr, legacy_download_route);
    assert_parity_error(&failed_download, &parity, "backupFailed");

    sqlx::query("UPDATE workspace_backups SET archive_sha256 = $1 WHERE id = $2::uuid")
        .bind("0".repeat(64))
        .bind("10000000-0000-0000-0000-000000000002")
        .execute(&pool)
        .await
        .expect("corrupt recorded checksum");
    let checksum_mismatch = get_with_retry(bound_addr, file_route);
    assert_parity_error(&checksum_mismatch, &parity, "artifactInvalid");
    let checksum_download = get_with_retry(bound_addr, download_route);
    assert_parity_error(&checksum_download, &parity, "artifactInvalid");

    sqlx::query(
        "UPDATE workspace_backups SET artifact_ref = $1, archive_sha256 = NULL WHERE id = $2::uuid",
    )
    .bind(
        fixture
            ._root
            .path()
            .join("missing.zip")
            .to_string_lossy()
            .as_ref(),
    )
    .bind("10000000-0000-0000-0000-000000000002")
    .execute(&pool)
    .await
    .expect("attach missing workspace backup artifact");
    let missing_download = get_with_retry(bound_addr, download_route);
    assert_parity_error(&missing_download, &parity, "artifactNotFound");

    stop_server(child, stdout);
    pool.close().await;
}

#[cfg(unix)]
#[test]
fn request_limits_cover_fixed_and_chunked_bodies() {
    let (child, stdout, bound_addr) = spawn_server(&[("RUDDER_NATIVE_MAX_REQUEST_BYTES", "8")]);

    let exact = http_get_with_body(bound_addr, b"12345678").expect("exact request limit");
    assert!(exact.starts_with("HTTP/1.1 200"), "{exact}");

    let fixed_over =
        http_get_with_body(bound_addr, b"123456789").expect("fixed over-limit request");
    assert!(fixed_over.starts_with("HTTP/1.1 413"), "{fixed_over}");
    assert!(fixed_over.contains("request_too_large"), "{fixed_over}");

    let chunked_over =
        http_get_chunked(bound_addr, &[b"1234", b"56789"]).expect("chunked over-limit request");
    assert!(chunked_over.starts_with("HTTP/1.1 413"), "{chunked_over}");
    assert!(chunked_over.contains("request_too_large"), "{chunked_over}");

    stop_server(child, stdout);
}

#[cfg(unix)]
#[test]
fn queue_admission_promotes_two_waiters_after_active_request_releases() {
    let (child, stdout, bound_addr) = spawn_server(&[
        ("RUDDER_NATIVE_WORKERS", "1"),
        ("RUDDER_NATIVE_MAX_QUEUE_DEPTH", "2"),
    ]);
    let mut active = open_partial_get(bound_addr).expect("open active request");
    let mut queued_one = open_get_with_body(bound_addr, b"waitwait").expect("open first waiter");
    let mut queued_two = open_get_with_body(bound_addr, b"waitwait").expect("open second waiter");

    std::thread::sleep(Duration::from_millis(100));
    active
        .write_all(b"done")
        .expect("complete active request body");
    active.flush().expect("flush active request");
    let active_response = read_response(&mut active).expect("active response");
    assert!(
        active_response.starts_with("HTTP/1.1 200"),
        "{active_response}"
    );

    let first_response = read_response(&mut queued_one).expect("first queued response");
    let second_response = read_response(&mut queued_two).expect("second queued response");
    assert!(
        first_response.starts_with("HTTP/1.1 200"),
        "{first_response}"
    );
    assert!(
        second_response.starts_with("HTTP/1.1 200"),
        "{second_response}"
    );

    stop_server(child, stdout);
}

#[cfg(unix)]
#[test]
fn response_limit_fallback_obeys_one_byte_ceiling() {
    let (child, stdout, bound_addr) = spawn_server(&[("RUDDER_NATIVE_MAX_RESPONSE_BYTES", "1")]);
    let response = http_get(bound_addr, "/healthz").expect("health response");
    assert!(response.starts_with("HTTP/1.1 500"), "{response}");
    assert!(response_body_len(&response) <= 1, "{response}");
    stop_server(child, stdout);
}

#[cfg(unix)]
#[test]
fn sigterm_applies_configured_grace_to_an_inflight_request() {
    let (mut child, mut stdout, bound_addr) =
        spawn_server(&[("RUDDER_NATIVE_SHUTDOWN_GRACE_MS", "1000")]);
    let mut stream = TcpStream::connect_timeout(&bound_addr, Duration::from_millis(250))
        .expect("connect in-flight request");
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("set read timeout");
    write!(
        stream,
        "GET /healthz HTTP/1.1\r\nHost: {bound_addr}\r\nContent-Length: 64\r\nConnection: close\r\n\r\n"
    )
    .expect("write partial request headers");
    stream
        .write_all(b"hold")
        .expect("write partial request body");
    stream.flush().expect("flush partial request");

    let started = Instant::now();
    let signal_result = unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
    assert_eq!(signal_result, 0, "send SIGTERM");
    let status = child.wait().expect("wait for graceful stop");
    assert!(status.success(), "server exited with {status}");
    assert!(started.elapsed() < Duration::from_secs(5));
    drop(stream);

    let mut remaining = String::new();
    stdout
        .read_to_string(&mut remaining)
        .expect("shutdown receipt");
    let shutdown: Value = remaining
        .lines()
        .find_map(|line| serde_json::from_str(line).ok())
        .expect("shutdown JSON");
    assert_eq!(shutdown["schema"], "rudder.native.server.shutdown.v1");
    assert_eq!(shutdown["state"], "stopped");
    assert_eq!(shutdown["reason"], "sigterm");
}

fn spawn_server(overrides: &[(&str, &str)]) -> (Child, BufReader<ChildStdout>, SocketAddr) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_rudder-server-foundation"));
    command
        .env("RUDDER_NATIVE_LISTEN", "127.0.0.1:0")
        .env("RUDDER_NATIVE_DATABASE_REQUIRED", "false")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for name in [
        "RUDDER_NATIVE_MAX_REQUEST_BYTES",
        "RUDDER_NATIVE_MAX_RESPONSE_BYTES",
        "RUDDER_NATIVE_MAX_WEBSOCKET_MESSAGE_BYTES",
        "RUDDER_NATIVE_MAX_QUEUE_DEPTH",
        "RUDDER_NATIVE_MAX_DATABASE_CONNECTIONS",
        "RUDDER_NATIVE_WORKERS",
        "RUDDER_NATIVE_DATABASE_ACQUIRE_TIMEOUT_MS",
        "RUDDER_NATIVE_READINESS_TIMEOUT_MS",
        "RUDDER_NATIVE_SHUTDOWN_GRACE_MS",
        "RUDDER_NATIVE_DATABASE_URL",
    ] {
        command.env_remove(name);
    }
    command
        .env("RUDDER_NATIVE_LISTEN", "127.0.0.1:0")
        .env("RUDDER_NATIVE_DATABASE_REQUIRED", "false");
    for (name, value) in overrides {
        command.env(name, value);
    }
    let mut child = command.spawn().expect("spawn server foundation");
    let stdout = child.stdout.take().expect("server stdout");
    let mut stdout = BufReader::new(stdout);
    let mut startup_line = String::new();
    stdout
        .read_line(&mut startup_line)
        .expect("startup receipt");
    let startup: Value = serde_json::from_str(&startup_line).expect("startup JSON");
    assert_eq!(
        startup["routeAuthority"]["schema"],
        "rudder.native.server.route-authority.v1"
    );
    assert_eq!(
        startup["routeAuthority"]["authoritySchema"],
        "rudder.migration.authority.v1"
    );
    assert_eq!(startup["routeAuthority"]["protocolVersion"], 1);
    assert_eq!(
        startup["routeAuthority"]["routes"].as_array().map(Vec::len),
        Some(24)
    );
    let bound_addr: SocketAddr = startup["boundAddr"]
        .as_str()
        .expect("bound address")
        .parse()
        .expect("socket address");
    (child, stdout, bound_addr)
}

fn stop_server(mut child: Child, mut stdout: BufReader<ChildStdout>) {
    let pid = child.id() as i32;
    let signal_result = unsafe { libc::kill(pid, libc::SIGTERM) };
    assert_eq!(signal_result, 0, "send SIGTERM");
    let status = child.wait().expect("wait for graceful stop");
    assert!(status.success(), "server exited with {status}");

    let mut remaining = String::new();
    stdout
        .read_to_string(&mut remaining)
        .expect("shutdown receipt");
    let shutdown: Value = remaining
        .lines()
        .find_map(|line| serde_json::from_str(line).ok())
        .expect("shutdown JSON");
    assert_eq!(shutdown["schema"], "rudder.native.server.shutdown.v1");
    assert_eq!(shutdown["state"], "stopped");
    assert_eq!(shutdown["reason"], "sigterm");
}

fn get_with_retry(addr: SocketAddr, path: &str) -> String {
    get_with_retry_read_timeout(addr, path, Duration::from_secs(2))
}

fn get_with_retry_read_timeout(addr: SocketAddr, path: &str, read_timeout: Duration) -> String {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        match http_request_with_read_timeout(addr, "GET", path, read_timeout) {
            Ok(response) => return response,
            Err(error) if std::time::Instant::now() < deadline => {
                let _ = error;
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(error) => panic!("GET {path} failed: {error}"),
        }
    }
}

fn http_get(addr: SocketAddr, path: &str) -> std::io::Result<String> {
    http_request(addr, "GET", path)
}

fn http_request(addr: SocketAddr, method: &str, path: &str) -> std::io::Result<String> {
    http_request_with_read_timeout(addr, method, path, Duration::from_secs(2))
}

fn http_request_with_read_timeout(
    addr: SocketAddr,
    method: &str,
    path: &str,
    read_timeout: Duration,
) -> std::io::Result<String> {
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(250))?;
    stream.set_read_timeout(Some(read_timeout))?;
    write!(
        stream,
        "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )?;
    stream.flush()?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    Ok(response)
}

fn get_bytes_with_retry(addr: SocketAddr, path: &str) -> Vec<u8> {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        match http_request_bytes(addr, "GET", path, Duration::from_secs(2)) {
            Ok(response) => return response,
            Err(_) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(error) => panic!("GET {path} failed: {error}"),
        }
    }
}

fn http_request_bytes(
    addr: SocketAddr,
    method: &str,
    path: &str,
    read_timeout: Duration,
) -> io::Result<Vec<u8>> {
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(250))?;
    stream.set_read_timeout(Some(read_timeout))?;
    write!(
        stream,
        "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )?;
    stream.flush()?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response)?;
    Ok(response)
}

fn response_parts(response: &[u8]) -> (String, &[u8]) {
    let offset = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("HTTP response separator");
    (
        String::from_utf8_lossy(&response[..offset]).into_owned(),
        &response[offset + 4..],
    )
}

fn response_json(response: &str) -> Value {
    let (_, body) = response.split_once("\r\n\r\n").expect("HTTP response body");
    serde_json::from_str(body).expect("JSON response body")
}

fn http_get_with_body(addr: SocketAddr, body: &[u8]) -> io::Result<String> {
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(250))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    write!(
        stream,
        "GET /healthz HTTP/1.1\r\nHost: {addr}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)?;
    stream.flush()?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    Ok(response)
}

fn open_partial_get(addr: SocketAddr) -> io::Result<TcpStream> {
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(250))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    write!(
        stream,
        "GET /healthz HTTP/1.1\r\nHost: {addr}\r\nContent-Length: 8\r\nConnection: close\r\n\r\n"
    )?;
    stream.write_all(b"hold")?;
    stream.flush()?;
    Ok(stream)
}

fn open_get_with_body(addr: SocketAddr, body: &[u8]) -> io::Result<TcpStream> {
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(250))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    write!(
        stream,
        "GET /healthz HTTP/1.1\r\nHost: {addr}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)?;
    stream.flush()?;
    Ok(stream)
}

fn read_response(stream: &mut TcpStream) -> io::Result<String> {
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    Ok(response)
}

fn http_get_chunked(addr: SocketAddr, chunks: &[&[u8]]) -> io::Result<String> {
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(250))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    write!(
        stream,
        "GET /healthz HTTP/1.1\r\nHost: {addr}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
    )?;
    for chunk in chunks {
        write!(stream, "{:X}\r\n", chunk.len())?;
        stream.write_all(chunk)?;
        stream.write_all(b"\r\n")?;
    }
    stream.write_all(b"0\r\n\r\n")?;
    stream.flush()?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    Ok(response)
}

fn response_body_len(response: &str) -> usize {
    response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.len())
        .unwrap_or_default()
}

struct PostgresHarness {
    _temp_dir: TempDir,
    data_dir: PathBuf,
    pg_ctl: PathBuf,
    url: String,
}

impl PostgresHarness {
    fn start() -> Self {
        let initdb = postgres_binary("initdb");
        let pg_ctl = postgres_binary("pg_ctl");
        let temp_dir = tempfile::tempdir().expect("create PostgreSQL temp directory");
        let data_dir = temp_dir.path().join("data");
        let log_path = temp_dir.path().join("postgres.log");
        let port = TcpListener::bind("127.0.0.1:0")
            .expect("reserve PostgreSQL port")
            .local_addr()
            .unwrap()
            .port();

        run_checked(
            Command::new(&initdb).arg("-D").arg(&data_dir).args([
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
                    temp_dir.path().display()
                ))
                .args(["-w", "start"]),
            "pg_ctl start",
        );

        Self {
            _temp_dir: temp_dir,
            data_dir,
            pg_ctl,
            url: format!("postgresql://postgres@127.0.0.1:{port}/postgres"),
        }
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
        candidates.extend(env::split_paths(&path).map(|dir| dir.join(&executable)));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin").join(&executable));
    candidates.push(PathBuf::from("/usr/local/bin").join(&executable));
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
        "{label} failed:\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

struct WorkspaceBackupArchiveFixture {
    _root: TempDir,
    archive: PathBuf,
    sha256: String,
    windows_archive: PathBuf,
    windows_sha256: String,
    invalid_archives: Vec<(PathBuf, String)>,
    aggregate_limit_archive: PathBuf,
    aggregate_limit_sha256: String,
    legacy_artifact: PathBuf,
    legacy_sha256: String,
}

fn workspace_backup_tree_sha256(entries: &[serde_json::Value]) -> String {
    let mut entries = entries.iter().collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        left["path"]
            .as_str()
            .expect("entry path")
            .encode_utf16()
            .cmp(right["path"].as_str().expect("entry path").encode_utf16())
    });
    let mut hash = Sha256::new();
    for entry in entries {
        hash.update(entry["path"].as_str().expect("entry path").as_bytes());
        hash.update(b"\0");
        hash.update(entry["kind"].as_str().expect("entry kind").as_bytes());
        hash.update(b"\0");
        hash.update(entry["byteSize"].as_u64().expect("entry size").to_string());
        hash.update(b"\0");
        hash.update(entry["sha256"].as_str().unwrap_or("").as_bytes());
        hash.update(b"\n");
    }
    format!("{:x}", hash.finalize())
}

fn create_workspace_backup_archive(
    root: &Path,
    name: &str,
    entries: &[serde_json::Value],
    plan_entries: &[serde_json::Value],
    policy_version: &str,
    tree_sha256: Option<String>,
) -> (PathBuf, String) {
    create_workspace_backup_archive_with_root_and_limits(
        root,
        name,
        entries,
        plan_entries,
        policy_version,
        tree_sha256,
        "/fixture/workspace",
        8 * 1024 * 1024,
        16 * 1024,
        64 * 1024,
    )
}

#[allow(clippy::too_many_arguments)]
fn create_workspace_backup_archive_with_limits(
    root: &Path,
    name: &str,
    entries: &[serde_json::Value],
    plan_entries: &[serde_json::Value],
    policy_version: &str,
    tree_sha256: Option<String>,
    max_archive_bytes: u64,
    max_file_bytes: u64,
    max_total_file_bytes: u64,
) -> (PathBuf, String) {
    create_workspace_backup_archive_with_root_and_limits(
        root,
        name,
        entries,
        plan_entries,
        policy_version,
        tree_sha256,
        "/fixture/workspace",
        max_archive_bytes,
        max_file_bytes,
        max_total_file_bytes,
    )
}

#[allow(clippy::too_many_arguments)]
fn create_workspace_backup_archive_with_root_and_limits(
    root: &Path,
    name: &str,
    entries: &[serde_json::Value],
    plan_entries: &[serde_json::Value],
    policy_version: &str,
    tree_sha256: Option<String>,
    identity_root_path: &str,
    max_archive_bytes: u64,
    max_file_bytes: u64,
    max_total_file_bytes: u64,
) -> (PathBuf, String) {
    let tree_sha256 = tree_sha256.unwrap_or_else(|| workspace_backup_tree_sha256(entries));
    let manifest_path = root.join(format!("{name}-manifest.json"));
    fs::write(
        &manifest_path,
        serde_json::to_vec(&serde_json::json!({
            "version": 2,
            "policyVersion": policy_version,
            "identity": {
                "orgId": "00000000-0000-0000-0000-000000000001",
                "instanceId": "black-box",
                "rootPath": identity_root_path
            },
            "createdAt": "2026-09-01T00:00:00.000Z",
            "entries": entries,
            "treeSha256": tree_sha256,
            "warnings": []
        }))
        .expect("serialize v2 manifest"),
    )
    .expect("write v2 manifest");
    let plan_path = root.join(format!("{name}-plan.json"));
    fs::write(
        &plan_path,
        serde_json::to_vec(&serde_json::json!({
            "protocolVersion": 1,
            "manifestSource": manifest_path,
            "treeSha256": tree_sha256,
            "entries": plan_entries
        }))
        .expect("serialize archive plan"),
    )
    .expect("write archive plan");
    let archive = root.join(format!("{name}.zip"));
    let created = create_archive(
        &plan_path,
        &archive,
        max_archive_bytes,
        max_file_bytes,
        max_total_file_bytes,
    )
    .expect("create v2 workspace backup fixture");
    (archive, created.sha256)
}

fn workspace_backup_archive_fixture() -> WorkspaceBackupArchiveFixture {
    let root = tempfile::tempdir().expect("workspace backup fixture root");
    let docs_readme = root.path().join("readme.md");
    let docs_alpha = root.path().join("alpha.txt");
    let root_file = root.path().join("root.txt");
    let binary_file = root.path().join("binary.bin");
    let nested_file = root.path().join("deep.txt");
    fs::write(&docs_readme, b"readme").expect("write readme fixture");
    fs::write(&docs_alpha, b"alpha").expect("write alpha fixture");
    fs::write(&root_file, b"root").expect("write root fixture");
    fs::write(&binary_file, b"\0binary").expect("write binary fixture");
    fs::write(&nested_file, b"nested").expect("write nested fixture");

    let entries = vec![
        serde_json::json!({"path":"docs","kind":"directory","byteSize":0,"mtimeMs":null,"mode":null,"sha256":null}),
        serde_json::json!({"path":"docs/readme.md","kind":"file","byteSize":6,"mtimeMs":null,"mode":null,"sha256":format!("{:x}", Sha256::digest(b"readme"))}),
        serde_json::json!({"path":"docs/alpha.txt","kind":"file","byteSize":5,"mtimeMs":null,"mode":null,"sha256":format!("{:x}", Sha256::digest(b"alpha"))}),
        serde_json::json!({"path":"binary.bin","kind":"file","byteSize":7,"mtimeMs":null,"mode":null,"sha256":format!("{:x}", Sha256::digest(b"\0binary"))}),
        serde_json::json!({"path":"root.txt","kind":"file","byteSize":4,"mtimeMs":null,"mode":null,"sha256":format!("{:x}", Sha256::digest(b"root"))}),
        serde_json::json!({"path":"nested/deep.txt","kind":"file","byteSize":6,"mtimeMs":null,"mode":null,"sha256":format!("{:x}", Sha256::digest(b"nested"))}),
    ];
    let plan_entries = vec![
        serde_json::json!({"kind":"directory","archivePath":"workspace/"}),
        serde_json::json!({"kind":"directory","archivePath":"workspace/docs/"}),
        serde_json::json!({"kind":"file","archivePath":"workspace/docs/readme.md","sourcePath":docs_readme}),
        serde_json::json!({"kind":"file","archivePath":"workspace/docs/alpha.txt","sourcePath":docs_alpha}),
        serde_json::json!({"kind":"file","archivePath":"workspace/binary.bin","sourcePath":binary_file}),
        serde_json::json!({"kind":"file","archivePath":"workspace/root.txt","sourcePath":root_file}),
        serde_json::json!({"kind":"file","archivePath":"workspace/nested/deep.txt","sourcePath":nested_file}),
    ];
    let (archive, sha256) = create_workspace_backup_archive(
        root.path(),
        "workspace",
        &entries,
        &plan_entries,
        "workspace-backup-v2-policy-1",
        None,
    );
    let (windows_archive, windows_sha256) = create_workspace_backup_archive_with_root_and_limits(
        root.path(),
        "windows-workspace",
        &entries,
        &plan_entries,
        "workspace-backup-v2-policy-1",
        None,
        r"C:\Users\Zeeland\workspace",
        8 * 1024 * 1024,
        16 * 1024,
        64 * 1024,
    );

    let mut invalid_archives = Vec::new();
    invalid_archives.push(create_workspace_backup_archive(
        root.path(),
        "invalid-policy",
        &entries,
        &plan_entries,
        "unsupported-policy",
        None,
    ));
    invalid_archives.push(create_workspace_backup_archive(
        root.path(),
        "invalid-tree",
        &entries,
        &plan_entries,
        "workspace-backup-v2-policy-1",
        Some("1".repeat(64)),
    ));
    let mut missing = entries.clone();
    missing.push(serde_json::json!({"path":"ghost.txt","kind":"file","byteSize":0,"mtimeMs":null,"mode":null,"sha256":format!("{:x}", Sha256::digest(b""))}));
    invalid_archives.push(create_workspace_backup_archive(
        root.path(),
        "missing-entry",
        &missing,
        &plan_entries,
        "workspace-backup-v2-policy-1",
        None,
    ));
    invalid_archives.push(create_workspace_backup_archive(
        root.path(),
        "unlisted-entry",
        &entries[..entries.len() - 1],
        &plan_entries,
        "workspace-backup-v2-policy-1",
        None,
    ));
    let mut wrong_kind = entries.clone();
    wrong_kind[0] = serde_json::json!({"path":"docs","kind":"file","byteSize":0,"mtimeMs":null,"mode":null,"sha256":format!("{:x}", Sha256::digest(b""))});
    invalid_archives.push(create_workspace_backup_archive(
        root.path(),
        "kind-mismatch",
        &wrong_kind,
        &plan_entries,
        "workspace-backup-v2-policy-1",
        None,
    ));
    let mut wrong_size = entries.clone();
    wrong_size[3]["byteSize"] = serde_json::json!(5);
    invalid_archives.push(create_workspace_backup_archive(
        root.path(),
        "size-mismatch",
        &wrong_size,
        &plan_entries,
        "workspace-backup-v2-policy-1",
        None,
    ));
    let mut duplicate = entries.clone();
    duplicate.push(entries[3].clone());
    invalid_archives.push(create_workspace_backup_archive(
        root.path(),
        "duplicate-path",
        &duplicate,
        &plan_entries,
        "workspace-backup-v2-policy-1",
        None,
    ));
    let mut case_collision = entries.clone();
    case_collision.push(serde_json::json!({"path":"ROOT.TXT","kind":"file","byteSize":4,"mtimeMs":null,"mode":null,"sha256":format!("{:x}", Sha256::digest(b"root"))}));
    invalid_archives.push(create_workspace_backup_archive(
        root.path(),
        "case-collision",
        &case_collision,
        &plan_entries,
        "workspace-backup-v2-policy-1",
        None,
    ));

    let five_mib = 5 * 1024 * 1024;
    let large_source = root.path().join("five-mib.bin");
    fs::File::create(&large_source)
        .and_then(|file| file.set_len(five_mib))
        .expect("write sparse five MiB fixture");
    let one_byte_source = root.path().join("one-byte.bin");
    fs::write(&one_byte_source, [0]).expect("write one-byte fixture");
    let five_mib_sha256 = format!("{:x}", Sha256::digest(vec![0; five_mib as usize]));
    let mut aggregate_entries = Vec::new();
    let mut aggregate_plan_entries = vec![serde_json::json!({
        "kind":"directory",
        "archivePath":"workspace/"
    })];
    for index in 0..20 {
        let path = format!("large-{index:02}.bin");
        aggregate_entries.push(serde_json::json!({
            "path":path,
            "kind":"file",
            "byteSize":five_mib,
            "mtimeMs":null,
            "mode":null,
            "sha256":five_mib_sha256
        }));
        aggregate_plan_entries.push(serde_json::json!({
            "kind":"file",
            "archivePath":format!("workspace/{path}"),
            "sourcePath":large_source
        }));
    }
    aggregate_entries.push(serde_json::json!({
        "path":"over-limit.bin",
        "kind":"file",
        "byteSize":1,
        "mtimeMs":null,
        "mode":null,
        "sha256":format!("{:x}", Sha256::digest([0]))
    }));
    aggregate_plan_entries.push(serde_json::json!({
        "kind":"file",
        "archivePath":"workspace/over-limit.bin",
        "sourcePath":one_byte_source
    }));
    let (aggregate_limit_archive, aggregate_limit_sha256) =
        create_workspace_backup_archive_with_limits(
            root.path(),
            "aggregate-byte-limit",
            &aggregate_entries,
            &aggregate_plan_entries,
            "workspace-backup-v2-policy-1",
            None,
            116 * 1024 * 1024,
            five_mib,
            100 * 1024 * 1024 + 1,
        );

    let legacy_artifact = root.path().join("workspace.json");
    let mut legacy_entries = entries.clone();
    legacy_entries
        .iter_mut()
        .find(|entry| entry["path"] == "root.txt")
        .expect("legacy root entry")["dataBase64"] = serde_json::json!("cm9vdA==");
    legacy_entries
        .iter_mut()
        .find(|entry| entry["path"] == "root.txt")
        .expect("legacy root entry")["mtimeMs"] = serde_json::json!(1_704_067_200_000_i64);
    let legacy_bytes = serde_json::to_vec(&serde_json::json!({
        "version": 1,
        "orgId": "00000000-0000-0000-0000-000000000001",
        "instanceId": "black-box",
        "createdAt": "2026-09-01T00:00:00.000Z",
        "rootPath": "/fixture/workspace",
        "entries": legacy_entries,
        "warnings": []
    }))
    .expect("serialize legacy artifact");
    fs::write(&legacy_artifact, &legacy_bytes).expect("write legacy artifact");
    let legacy_sha256 = format!("{:x}", Sha256::digest(&legacy_bytes));

    WorkspaceBackupArchiveFixture {
        _root: root,
        archive,
        sha256,
        windows_archive,
        windows_sha256,
        invalid_archives,
        aggregate_limit_archive,
        aggregate_limit_sha256,
        legacy_artifact,
        legacy_sha256,
    }
}

const WORKSPACE_BACKUP_FIXTURE_SQL: &str = r#"
CREATE TABLE organizations (id uuid PRIMARY KEY);
CREATE TABLE workspace_backups (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  status text NOT NULL,
  trigger_source text NOT NULL,
  artifact_ref text NOT NULL,
  archive_sha256 text,
  tree_sha256 text,
  file_count integer,
  byte_size bigint,
  compressed_size bigint,
  manifest jsonb,
  warnings jsonb,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz,
  restored_from_backup_id uuid,
  created_by_user_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
INSERT INTO organizations (id) VALUES
  ('00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000002');
INSERT INTO workspace_backups (
  id, org_id, status, trigger_source, artifact_ref, file_count, byte_size,
  compressed_size, manifest, warnings, expires_at, created_at, updated_at
) VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
   'completed', 'manual', '/backups/older.tar.zst', 2, 20, 10, '{"version":1}', '["older"]',
   '2026-10-15T12:00:00Z', '2026-08-30T12:00:00Z', '2026-08-30T12:00:00Z'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
   'completed', 'scheduled', '/backups/newer.tar.zst', 3, 30, 15, '{"version":1}', '{}',
   NULL, '2026-08-31T12:00:00Z', '2026-08-31T12:00:00Z'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001',
   'deleted', 'manual', '/backups/deleted.tar.zst', 1, 10, 5, '{}', '[]',
   NULL, '2026-09-01T12:00:00Z', '2026-09-01T12:00:00Z'),
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002',
   'completed', 'manual', '/backups/org-two.tar.zst', 1, 10, 5, '{}', '[]',
   NULL, '2026-08-31T12:00:00Z', '2026-08-31T12:00:00Z');
"#;
