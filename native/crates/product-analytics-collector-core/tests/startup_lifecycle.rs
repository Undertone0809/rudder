use rudder_product_analytics_collector_core::{CollectorConfig, CollectorError, start};
use sqlx::PgPool;
use std::env;
use tokio::time::{Duration, sleep};

#[tokio::test]
#[ignore = "requires a disposable role-separated PostgreSQL and a live listener owner"]
async fn occupied_listener_does_not_leave_maintenance_pool_or_writer() {
    assert_eq!(
        env::var("RUDDER_ANALYTICS_OCCUPIED_PORT_TEST").as_deref(),
        Ok("1"),
        "set the explicit disposable-fixture gate before running this ignored test"
    );
    let mut config = CollectorConfig::from_env().expect("collector test configuration");
    let application_name = env::var("RUDDER_ANALYTICS_OCCUPIED_PORT_APPLICATION")
        .expect("maintenance application name");
    let admin_url =
        env::var("RUDDER_ANALYTICS_OCCUPIED_PORT_ADMIN_URL").expect("admin database URL");
    if let Ok(maintenance_url) = env::var("RUDDER_ANALYTICS_OCCUPIED_PORT_MAINTENANCE_URL") {
        config.maintenance_database_url = maintenance_url;
    }
    let result = start(config).await;
    assert!(matches!(
        result,
        Err(CollectorError::Configuration(message))
            if message.starts_with("collector_listener_bind_failed:")
    ));

    sleep(Duration::from_millis(250)).await;
    let admin = PgPool::connect(&admin_url).await.expect("admin database");
    let connections: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM pg_stat_activity WHERE application_name = $1",
    )
    .bind(application_name)
    .fetch_one(&admin)
    .await
    .expect("inspect maintenance connections");
    admin.close().await;
    assert_eq!(
        connections, 0,
        "failed startup left a maintenance pool alive"
    );
}
