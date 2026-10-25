use rudder_agent_cli_core::execute;
use std::collections::BTreeMap;
use std::io;

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let environment = std::env::vars().collect::<BTreeMap<_, _>>();
    if args.first().is_some_and(|arg| arg == "mcp-server") {
        if args.len() != 1 {
            eprintln!("rudder-cli: mcp-server does not accept command arguments");
            std::process::exit(2);
        }
        if let Err(error) = rudder_agent_cli_core::run_mcp_server(
            io::stdin().lock(),
            io::stdout().lock(),
            &environment,
        ) {
            eprintln!("rudder-cli: {error}");
            std::process::exit(1);
        }
        return;
    }
    let mut stdout = io::stdout().lock();
    let mut stderr = io::stderr().lock();
    let code = execute(&args, &environment, &mut stdout, &mut stderr);
    std::process::exit(code);
}
