use rudder_product_analytics_collector_core::{
    CollectorConfig, CollectorError, MigrationConfig, migrate, run_until_shutdown,
};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info".to_owned()))
        .json()
        .init();
    let result = if std::env::args().nth(1).as_deref() == Some("--migrate") {
        match MigrationConfig::from_env() {
            Ok(config) => migrate(&config).await,
            Err(error) => Err(error),
        }
    } else {
        match CollectorConfig::from_env() {
            Ok(config) => run_until_shutdown(config).await,
            Err(error) => Err(error),
        }
    };
    if let Err(error) = result {
        report_error(error);
        std::process::exit(1);
    }
}

fn report_error(error: CollectorError) {
    eprintln!("rudder-product-analytics-collector failed: {error}");
}
