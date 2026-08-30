use rudder_agent_tools_foundation::{binary_identity, capabilities_manifest};

fn main() {
    let mut args = std::env::args().skip(1);
    let result = match (args.next().as_deref(), args.next()) {
        (Some("--version"), None) => {
            println!("rudder-cli-foundation {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        (Some("identity"), None) => binary_identity("rudder-cli-foundation"),
        (Some("capabilities"), None) => capabilities_manifest(),
        _ => {
            eprintln!("usage: rudder-cli-foundation --version|identity|capabilities");
            std::process::exit(2);
        }
    };
    println!(
        "{}",
        serde_json::to_string(&result).expect("foundation output must serialize")
    );
}
