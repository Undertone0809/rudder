use rudder_agent_cli_core::execute;
use std::collections::BTreeMap;
use std::io;

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let environment = std::env::vars().collect::<BTreeMap<_, _>>();
    let mut stdout = io::stdout().lock();
    let mut stderr = io::stderr().lock();
    let code = execute(&args, &environment, &mut stdout, &mut stderr);
    std::process::exit(code);
}
