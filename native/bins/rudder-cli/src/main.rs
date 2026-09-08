use rudder_cli_mcp_contract_core::{
    DEFAULT_WORKSPACE_MAX_ENTRIES, DEFAULT_WORKSPACE_MAX_PATH_BYTES, WorkspaceListRequest,
    list_workspace_directory,
};
use serde_json::{Value, json};
use std::env;
use std::path::Path;

const WORKSPACE_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug)]
struct CliError {
    code: String,
    message: String,
}

impl CliError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Default)]
struct WorkspaceListOptions {
    root: Option<String>,
    directory: Option<String>,
    max_entries: Option<u64>,
    max_path_bytes: Option<u64>,
    positional: Vec<String>,
}

fn main() {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("--version") if args.next().is_none() => {
            println!("rudder-cli {}", env!("CARGO_PKG_VERSION"));
        }
        Some("--help") if args.next().is_none() => {
            println!("{}", usage());
        }
        Some("workspace") => match (args.next().as_deref(), args.next()) {
            (Some("list"), first) => {
                let mut remaining = first.into_iter().chain(args);
                match run_workspace_list(&mut remaining) {
                    Ok(response) => println!("{response}"),
                    Err(error) => {
                        println!("{}", workspace_error(&error));
                        eprintln!("rudder-cli: {}", error.message);
                        std::process::exit(2);
                    }
                }
            }
            _ => exit_usage(),
        },
        _ => exit_usage(),
    }
}

fn usage() -> &'static str {
    "usage: rudder-cli --version | workspace list [ROOT] [DIRECTORY] [MAX_ENTRIES] [MAX_PATH_BYTES] [--root PATH] [--directory PATH] [--max-entries N] [--max-path-bytes N]"
}

fn exit_usage() -> ! {
    eprintln!("{usage}", usage = usage());
    std::process::exit(2);
}

fn run_workspace_list(arguments: &mut impl Iterator<Item = String>) -> Result<Value, CliError> {
    let options = parse_workspace_options(arguments)?;
    let root = options
        .root
        .or_else(|| env::var("RUDDER_PROJECT_LIBRARY_PATH").ok())
        .ok_or_else(|| {
            CliError::new(
                "workspace_root_required",
                "workspace root must be supplied by the host or --root",
            )
        })?;
    let root = root.trim();
    if root.is_empty() {
        return Err(CliError::new(
            "workspace_root_required",
            "workspace root must not be empty",
        ));
    }
    if !Path::new(root).is_absolute() {
        return Err(CliError::new(
            "workspace_root_must_be_absolute",
            "workspace root must be an absolute path",
        ));
    }

    let directory = options
        .directory
        .or_else(|| options.positional.get(1).cloned())
        .unwrap_or_else(|| "projects".to_owned());
    let max_entries = options
        .max_entries
        .or(parse_positional_u64(&options.positional, 2, "max_entries")?)
        .unwrap_or(DEFAULT_WORKSPACE_MAX_ENTRIES);
    let max_path_bytes = options
        .max_path_bytes
        .or(parse_positional_u64(
            &options.positional,
            3,
            "max_path_bytes",
        )?)
        .unwrap_or(DEFAULT_WORKSPACE_MAX_PATH_BYTES);

    let request = WorkspaceListRequest::from_json(&json!({
        "directory": directory,
        "maxEntries": max_entries,
        "maxPathBytes": max_path_bytes,
    }))
    .map_err(|error| CliError::new(error.code(), error.message()))?;
    let result = list_workspace_directory(Path::new(root), &request)
        .map_err(|error| CliError::new(error.code(), error.message()))?;

    Ok(json!({
        "ok": true,
        "capability": "workspace.list",
        "operation": "listWorkspaceDirectory",
        "protocolVersion": WORKSPACE_PROTOCOL_VERSION,
        "accepted": false,
        "directoryPath": result.directory_path,
        "entries": result.entries,
    }))
}

fn parse_workspace_options(
    arguments: &mut impl Iterator<Item = String>,
) -> Result<WorkspaceListOptions, CliError> {
    let mut options = WorkspaceListOptions::default();
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--root" | "-r" => {
                options.root = Some(required_option(arguments, "--root")?);
            }
            "--directory" | "-d" => {
                options.directory = Some(required_option(arguments, "--directory")?);
            }
            "--max-entries" | "--maxEntries" => {
                options.max_entries = Some(parse_option_u64(
                    required_option(arguments, "--max-entries")?,
                    "max_entries",
                )?);
            }
            "--max-path-bytes" | "--maxPathBytes" => {
                options.max_path_bytes = Some(parse_option_u64(
                    required_option(arguments, "--max-path-bytes")?,
                    "max_path_bytes",
                )?);
            }
            "--json" => {}
            value if value.starts_with('-') => {
                return Err(CliError::new(
                    "unknown_option",
                    format!("unknown workspace list option {value}"),
                ));
            }
            value => options.positional.push(value.to_owned()),
        }
    }
    if options.positional.len() > 4 {
        return Err(CliError::new(
            "usage",
            "workspace list accepts at most four positional arguments",
        ));
    }
    if options.root.is_some() && !options.positional.is_empty() {
        return Err(CliError::new(
            "usage",
            "workspace root must be positional or --root, not both",
        ));
    }
    if options.directory.is_some() && options.positional.len() > 1 {
        return Err(CliError::new(
            "usage",
            "workspace directory must be positional or --directory, not both",
        ));
    }
    if options.max_entries.is_some() && options.positional.len() > 2 {
        return Err(CliError::new(
            "usage",
            "workspace entry limit must be positional or --max-entries, not both",
        ));
    }
    if options.max_path_bytes.is_some() && options.positional.len() > 3 {
        return Err(CliError::new(
            "usage",
            "workspace path limit must be positional or --max-path-bytes, not both",
        ));
    }
    if options.root.is_none() && !options.positional.is_empty() {
        options.root = options.positional.first().cloned();
    }
    Ok(options)
}

fn required_option(
    arguments: &mut impl Iterator<Item = String>,
    option: &str,
) -> Result<String, CliError> {
    arguments
        .next()
        .filter(|value| !value.starts_with('-'))
        .ok_or_else(|| CliError::new("usage", format!("{option} requires a value")))
}

fn parse_option_u64(value: String, name: &str) -> Result<u64, CliError> {
    value.parse::<u64>().map_err(|_| {
        CliError::new(
            "invalid_limit",
            format!("{name} must be an unsigned integer"),
        )
    })
}

fn parse_positional_u64(
    positional: &[String],
    index: usize,
    name: &str,
) -> Result<Option<u64>, CliError> {
    positional
        .get(index)
        .map(|value| parse_option_u64(value.clone(), name))
        .transpose()
}

fn workspace_error(error: &CliError) -> Value {
    json!({
        "ok": false,
        "capability": "workspace.list",
        "operation": "listWorkspaceDirectory",
        "protocolVersion": WORKSPACE_PROTOCOL_VERSION,
        "accepted": false,
        "errorCode": error.code,
        "message": error.message,
    })
}
