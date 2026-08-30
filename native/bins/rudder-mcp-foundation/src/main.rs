use rudder_agent_tools_foundation::{
    NodeCompatibilityDispatcher, RuntimeContext, Surface, binary_identity, run_concurrent_stdio,
};

fn main() {
    let mut args = std::env::args().skip(1);
    let first = args.next();
    if first.as_deref() == Some("--version") && args.next().is_none() {
        println!("rudder-mcp-foundation {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if first.as_deref() == Some("--identity") && args.next().is_none() {
        println!(
            "{}",
            serde_json::to_string(&binary_identity("rudder-mcp-foundation")).unwrap()
        );
        return;
    }
    let surface = match first.as_deref() {
        None | Some("core") => Surface::Core,
        Some("browser") => Surface::Browser,
        _ => {
            eprintln!("usage: rudder-mcp-foundation [core|browser]|--version|--identity");
            std::process::exit(2);
        }
    };
    if let Err(error) = run_concurrent_stdio(
        std::io::stdin().lock(),
        std::io::stdout(),
        surface,
        RuntimeContext::from_env(),
        NodeCompatibilityDispatcher::from_env(surface),
    ) {
        eprintln!("rudder-mcp-foundation failed: {error}");
        std::process::exit(1);
    }
}
