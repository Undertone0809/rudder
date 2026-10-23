#[tokio::main]
async fn main() {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("rudder-postgres-owner {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let code = rudder_postgres_lifecycle::run_protocol().await;
    std::process::exit(code);
}
