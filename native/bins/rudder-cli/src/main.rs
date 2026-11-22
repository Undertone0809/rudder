use rudder_agent_cli_core::execute;
use std::collections::BTreeMap;
use std::io;

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let environment = std::env::vars().collect::<BTreeMap<_, _>>();
    if args.first().is_some_and(|arg| arg == "mcp-server") {
        if args.len() == 3 && args[1] == "--binding-id" {
            if let Err(error) = rudder_agent_cli_core::run_managed_mcp_proxy(
                io::stdin().lock(),
                io::stdout().lock(),
                &environment,
                &args[2],
            ) {
                eprintln!("rudder-cli: {error}");
                std::process::exit(1);
            }
            return;
        }
        if args.len() == 3 && args[1] == "--server" {
            if args[2] == "browser" || args[2] == "computer" {
                let surface = if args[2] == "browser" {
                    rudder_agent_cli_core::DesktopSurface::Browser
                } else {
                    rudder_agent_cli_core::DesktopSurface::Computer
                };
                let _liveness =
                    (surface == rudder_agent_cli_core::DesktopSurface::Browser).then(|| {
                        rudder_agent_cli_core::start_browser_liveness(&environment, |_| {
                            std::process::exit(0)
                        })
                    });
                if let Err(error) = rudder_agent_cli_core::run_desktop_mcp_server(
                    io::stdin().lock(),
                    io::stdout().lock(),
                    &environment,
                    surface,
                ) {
                    eprintln!("rudder-cli: {error}");
                    std::process::exit(1);
                }
                return;
            }
            if args[2] != "core" {
                eprintln!(
                    "rudder-cli: Unsupported Rudder MCP server surface: {}",
                    args[2]
                );
                std::process::exit(2);
            }
        }
        if args.len() != 1 && !(args.len() == 3 && args[1] == "--server" && args[2] == "core") {
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
