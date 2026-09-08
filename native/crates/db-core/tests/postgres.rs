//! Opt-in smoke coverage for a real PostgreSQL schema. The deterministic
//! contract tests do not mock SQL construction; this test only runs when a
//! disposable schema is supplied explicitly.

#[tokio::test]
#[ignore = "set RUDDER_DB_CORE_DATABASE_URL, RUDDER_DB_CORE_SCHEMA, and RUDDER_DB_CORE_ORG_ID for PostgreSQL integration"]
async fn reads_organization_rows_from_explicit_postgres_schema_without_writes() {
    use rudder_db_core::{OrganizationScope, PageRequest, ReadRepository};
    use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
    use std::{env, str::FromStr};

    let url = env::var("RUDDER_DB_CORE_DATABASE_URL").expect("integration database URL");
    let schema = env::var("RUDDER_DB_CORE_SCHEMA").expect("disposable integration schema");
    assert!(
        !schema.is_empty()
            && schema.len() <= 63
            && schema
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_'),
        "integration schema must be a simple PostgreSQL identifier"
    );
    let org_id = env::var("RUDDER_DB_CORE_ORG_ID").expect("integration organization id");
    let options = PgConnectOptions::from_str(&url)
        .expect("valid integration database URL")
        .options([("search_path", schema.as_str())]);
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("connect to integration database");
    let repository = ReadRepository::new(pool.clone());
    let scope = OrganizationScope::single(org_id).expect("valid organization scope");
    let _ = repository
        .list_organizations(&scope, PageRequest::new(10).expect("valid page"))
        .await
        .expect("read organizations");
    pool.close().await;
}
