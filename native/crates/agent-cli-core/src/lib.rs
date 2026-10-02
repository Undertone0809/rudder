//! Explicit Rust CLI transport for bounded, read-only Agent capabilities.
//!
//! The first command is the canonical organization member directory. It uses
//! the Agent request planner for contract validation and the shared MCP
//! identity validator for credential/org requirements; this crate owns no
//! server, authentication, or database authority.

use reqwest::blocking::{Client, Response};
use reqwest::header::{ACCEPT, AUTHORIZATION, HeaderValue};
use reqwest::redirect::Policy;
use rudder_agent_request_planner::{
    CORE_RESPONSE_LIMIT, ManagedRuntimeIdentity, PlanOutcome, plan_request, query_string,
};
use rudder_cli_mcp_contract_core::{IdentityRequirements, validate_managed_identity};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::net::IpAddr;
use std::path::PathBuf;
use std::time::Duration;
use url::Url;

const DEFAULT_HTTP_TIMEOUT_MS: u64 = 10_000;
const MIN_HTTP_TIMEOUT_MS: u64 = 50;
const MAX_HTTP_TIMEOUT_MS: u64 = 120_000;
const MEMBERS_CAPABILITY: &str = "organization.members.list";
pub const MAX_RESPONSE_BYTES: usize = CORE_RESPONSE_LIMIT;

#[derive(Clone, Debug, Default)]
struct Options {
    api_base: Option<String>,
    api_key: Option<String>,
    org_id: Option<String>,
    query: Option<String>,
    member_type: Option<String>,
    limit: Option<String>,
    cursor: Option<String>,
    context_path: Option<String>,
    profile: Option<String>,
    config_path: Option<String>,
    json: bool,
    full_ids: bool,
}

#[derive(Clone, Debug)]
struct CliError {
    message: String,
    status: Option<u16>,
    code: String,
    details: Option<Value>,
}

impl CliError {
    fn cli(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status: None,
            code: "cli_error".to_owned(),
            details: None,
        }
    }

    fn transport(code: &str, message: &str) -> Self {
        Self {
            message: message.to_owned(),
            status: None,
            code: code.to_owned(),
            details: None,
        }
    }

    fn response_too_large() -> Self {
        Self::transport(
            "response_too_large",
            "API response exceeds the 1,000,000 byte limit",
        )
    }

    fn json_value(&self) -> Value {
        json!({
            "error": self.message,
            "status": self.status,
            "code": self.code,
            "details": self.details,
        })
    }
}

#[derive(Clone, Debug, Default)]
struct Profile {
    api_base: Option<String>,
    org_id: Option<String>,
    api_key_env_var_name: Option<String>,
}

/// Run the CLI and return its process exit code.
pub fn execute(
    args: &[String],
    environment: &BTreeMap<String, String>,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    match parse_command(args) {
        Ok(Command::Help) => {
            let _ = writeln!(stdout, "{}", usage());
            0
        }
        Ok(Command::Version) => {
            let _ = writeln!(stdout, "rudder-cli {}", env!("CARGO_PKG_VERSION"));
            0
        }
        Ok(Command::Members(options)) => match run_members(*options, environment) {
            Ok(output) => {
                let _ = writeln!(stdout, "{output}");
                0
            }
            Err(error) => {
                write_error(&error, options_json_requested(args), stderr);
                1
            }
        },
        Err(error) => {
            write_error(&error, options_json_requested(args), stderr);
            1
        }
    }
}

enum Command {
    Help,
    Version,
    Members(Box<Options>),
}

fn usage() -> &'static str {
    "Usage: rudder-cli org members [--org-id <id>] [--query <text>] [--type <human|agent|all>] [--limit <1..100>] [--cursor <opaque>] [--api-base <url>] [--api-key <token>] [--context <path>] [--profile <name>] [--config <path>] [--json] [--full-ids]\n\nInteractive TTY board login and stored/keychain credentials are not supported. See native/bins/rudder-cli/README.md."
}

fn parse_command(args: &[String]) -> Result<Command, CliError> {
    if args.is_empty() || args == ["--help"] || args == ["-h"] {
        return Ok(Command::Help);
    }
    if args == ["--version"] || args == ["-V"] {
        return Ok(Command::Version);
    }
    if args.first().is_some_and(|arg| arg == "org") && args.len() == 1 {
        return Ok(Command::Help);
    }
    if args.len() < 2 || args[0] != "org" || args[1] != "members" {
        return Err(CliError::cli("supported command: org members"));
    }

    let mut options = Options::default();
    let mut index = 2;
    while index < args.len() {
        let argument = &args[index];
        if argument == "--help" || argument == "-h" {
            return Ok(Command::Help);
        }
        if argument == "--version" || argument == "-V" {
            return Ok(Command::Version);
        }
        if argument == "--json" {
            options.json = true;
            index += 1;
            continue;
        }
        if argument == "--full-ids" {
            options.full_ids = true;
            index += 1;
            continue;
        }

        let (flag, inline_value) = argument
            .split_once('=')
            .map_or((argument.as_str(), None), |(name, value)| {
                (name, Some(value))
            });
        let target = match flag {
            "--api-base" => &mut options.api_base,
            "--api-key" => &mut options.api_key,
            "--org-id" | "-O" => &mut options.org_id,
            "--query" => &mut options.query,
            "--type" => &mut options.member_type,
            "--limit" => &mut options.limit,
            "--cursor" => &mut options.cursor,
            "--context" => &mut options.context_path,
            "--profile" => &mut options.profile,
            "--config" | "-c" => &mut options.config_path,
            _ => return Err(CliError::cli(format!("unknown argument: {flag}"))),
        };
        let value = if let Some(value) = inline_value {
            value.to_owned()
        } else {
            index += 1;
            args.get(index)
                .ok_or_else(|| CliError::cli(format!("{flag} requires a value")))?
                .clone()
        };
        *target = Some(value);
        index += 1;
    }
    Ok(Command::Members(Box::new(options)))
}

fn options_json_requested(args: &[String]) -> bool {
    args.iter()
        .any(|arg| arg == "--json" || arg.starts_with("--json="))
}

fn write_error(error: &CliError, json_output: bool, stderr: &mut dyn Write) {
    if json_output {
        let payload = serde_json::to_string_pretty(&error.json_value())
            .unwrap_or_else(|_| "{\"error\":\"CLI error\"}".to_owned());
        let _ = writeln!(stderr, "{payload}");
    } else if let Some(status) = error.status {
        let message = escape_terminal_controls(&error.message);
        if let Some(details) = error.details.as_ref().filter(|value| !value.is_null()) {
            let details = escape_terminal_controls(&details.to_string());
            let _ = writeln!(stderr, "API error {status}: {message} details={details}");
        } else {
            let _ = writeln!(stderr, "API error {status}: {message}");
        }
    } else {
        let message = escape_terminal_controls(&error.message);
        let _ = writeln!(stderr, "{message}");
    }
}

fn run_members(
    options: Options,
    environment: &BTreeMap<String, String>,
) -> Result<String, CliError> {
    let profile = load_profile(&options, environment)?;
    let api_base = nonempty(options.api_base.as_deref())
        .or_else(|| env_value(environment, "RUDDER_API_URL"))
        .or(profile.api_base.as_deref())
        .map(str::to_owned)
        .unwrap_or_else(|| infer_api_base(&options, environment));
    let api_key = nonempty(options.api_key.as_deref())
        .or_else(|| env_value(environment, "RUDDER_API_KEY"))
        .or_else(|| {
            profile
                .api_key_env_var_name
                .as_deref()
                .and_then(|name| env_value(environment, name))
        })
        .map(str::to_owned)
        .ok_or_else(|| {
            CliError::cli(
                "API key is required. Pass --api-key, set RUDDER_API_KEY, or configure profile apiKeyEnvVarName; interactive TTY login is not supported.",
            )
        })?;
    let org_id = nonempty(options.org_id.as_deref())
        .or_else(|| env_value(environment, "RUDDER_ORG_ID"))
        .or(profile.org_id.as_deref())
        .map(str::to_owned)
        .ok_or_else(|| {
            CliError::cli(
                "Organization ID is required. Pass --org-id, set RUDDER_ORG_ID, or set context profile orgId.",
            )
        })?;
    let identity = resolve_identity(&api_base, &api_key, &org_id)?;

    let mut arguments = Map::new();
    if let Some(query) = options
        .query
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        arguments.insert("query".to_owned(), Value::String(query.to_owned()));
    }
    if let Some(member_type) = options.member_type.as_deref() {
        arguments.insert("type".to_owned(), Value::String(member_type.to_owned()));
    }
    if let Some(limit) = options.limit.as_deref() {
        let parsed = limit.parse::<u64>().map_err(|_| {
            CliError::cli(
                "invalid argument for organization.members.list: limit must be an integer",
            )
        })?;
        arguments.insert("limit".to_owned(), json!(parsed));
    }
    if let Some(cursor) = options
        .cursor
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        arguments.insert("cursor".to_owned(), Value::String(cursor.to_owned()));
    }
    let runtime = ManagedRuntimeIdentity {
        organization_id: identity.org_id().map(str::to_owned),
        ..ManagedRuntimeIdentity::default()
    };
    let PlanOutcome::Direct(request) =
        plan_request(MEMBERS_CAPABILITY, Value::Object(arguments), &runtime).map_err(|error| {
            CliError::cli(format!(
                "invalid argument for {MEMBERS_CAPABILITY}: {error}"
            ))
        })?
    else {
        return Err(CliError::cli(
            "organization.members.list has no direct HTTP request contract",
        ));
    };

    let mut query = query_string(&request.query);
    if options.full_ids {
        if !query.is_empty() {
            query.push('&');
        }
        query.push_str("fullIds=true");
    }
    let url = build_request_url(identity.api_url(), &request.path, &query)?;
    let timeout = request_timeout(environment)?;
    let client = Client::builder()
        .timeout(timeout)
        .redirect(Policy::none())
        .build()
        .map_err(|_| {
            CliError::transport("api_transport_error", "could not initialize API client")
        })?;
    let authorization =
        HeaderValue::from_str(&format!("Bearer {}", identity.api_key())).map_err(|_| {
            CliError::cli("API key contains characters that are invalid in an HTTP header")
        })?;
    let response = client
        .get(url)
        .header(ACCEPT, "application/json")
        .header(AUTHORIZATION, authorization)
        .send()
        .map_err(|error| {
            if error.is_timeout() {
                CliError::transport("request_timeout", "API request timed out")
            } else {
                CliError::transport(
                    "api_transport_error",
                    "API request failed before receiving a response",
                )
            }
        })?;

    let status = response.status().as_u16();
    let body = read_bounded(response)?;
    if !(200..300).contains(&status) {
        return Err(api_response_error(status, &body, identity.api_key()));
    }
    let mut page: Value = serde_json::from_slice(&body).map_err(|_| {
        CliError::transport(
            "api_response_invalid",
            "API returned invalid member directory JSON",
        )
    })?;
    validate_member_page(&page)?;
    redact_json(&mut page, identity.api_key());

    if options.json {
        serde_json::to_string_pretty(&page).map_err(|_| {
            CliError::transport("api_response_invalid", "could not format API response")
        })
    } else {
        Ok(format_member_page(&page))
    }
}

fn resolve_identity(
    api_base: &str,
    api_key: &str,
    org_id: &str,
) -> Result<rudder_cli_mcp_contract_core::ManagedIdentity, CliError> {
    let mut environment = BTreeMap::new();
    environment.insert("RUDDER_API_URL".to_owned(), api_base.to_owned());
    environment.insert("RUDDER_API_KEY".to_owned(), api_key.to_owned());
    environment.insert("RUDDER_ORG_ID".to_owned(), org_id.to_owned());
    validate_managed_identity(
        &environment,
        IdentityRequirements {
            require_api_url: true,
            require_api_key: true,
            require_org_id: true,
            require_agent_id: false,
            require_run_id: false,
        },
    )
    .map_err(|error| CliError::cli(error.to_string()))
}

fn build_request_url(api_base: &str, path: &str, query: &str) -> Result<Url, CliError> {
    let base = Url::parse(api_base.trim()).map_err(|_| {
        CliError::cli("invalid API base URL; expected an absolute http or https URL")
    })?;
    if !matches!(base.scheme(), "http" | "https")
        || !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
    {
        return Err(CliError::cli(
            "invalid API base URL; credentials, query, and fragment are not allowed",
        ));
    }
    if base.scheme() == "http" && !is_loopback_host(base.host_str()) {
        return Err(CliError::cli(
            "refusing to send a bearer token over unencrypted HTTP; use HTTPS or a loopback URL",
        ));
    }
    let prefix = base.path().trim_end_matches('/');
    let endpoint = format!("{}{}", base.origin().ascii_serialization(), prefix);
    let mut url = Url::parse(&format!("{endpoint}{path}"))
        .map_err(|_| CliError::cli("could not construct API request URL"))?;
    if !query.is_empty() {
        url.set_query(Some(query));
    }
    Ok(url)
}

fn request_timeout(environment: &BTreeMap<String, String>) -> Result<Duration, CliError> {
    let Some(raw) = env_value(environment, "RUDDER_CLI_HTTP_TIMEOUT_MS") else {
        return Ok(Duration::from_millis(DEFAULT_HTTP_TIMEOUT_MS));
    };
    let millis = raw.parse::<u64>().map_err(|_| {
        CliError::cli("RUDDER_CLI_HTTP_TIMEOUT_MS must be an integer from 50 through 120000")
    })?;
    if !(MIN_HTTP_TIMEOUT_MS..=MAX_HTTP_TIMEOUT_MS).contains(&millis) {
        return Err(CliError::cli(
            "RUDDER_CLI_HTTP_TIMEOUT_MS must be an integer from 50 through 120000",
        ));
    }
    Ok(Duration::from_millis(millis))
}

fn read_bounded(response: Response) -> Result<Vec<u8>, CliError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(CliError::response_too_large());
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_RESPONSE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            if error.kind() == io::ErrorKind::TimedOut {
                CliError::transport(
                    "request_timeout",
                    "API request timed out while reading the response",
                )
            } else {
                CliError::transport("api_transport_error", "API response could not be read")
            }
        })?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(CliError::response_too_large());
    }
    Ok(bytes)
}

fn api_response_error(status: u16, body: &[u8], api_key: &str) -> CliError {
    let parsed = serde_json::from_slice::<Value>(body)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(body).into_owned()));
    let object = parsed.as_object();
    let message = object
        .and_then(|value| {
            ["error", "message"].into_iter().find_map(|key| {
                value
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            })
        })
        .map(str::to_owned)
        .unwrap_or_else(|| format!("Request failed with status {status}"));
    let code = object
        .and_then(|value| value.get("code"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("api_request_error");
    let code = redact_text(code, api_key);
    let mut details = object
        .and_then(|value| value.get("details"))
        .cloned()
        .unwrap_or(Value::Null);
    let mut message = message;
    message = redact_text(&message, api_key);
    redact_json(&mut details, api_key);
    CliError {
        message,
        status: Some(status),
        code,
        details: Some(details),
    }
}

fn validate_member_page(page: &Value) -> Result<(), CliError> {
    let Some(object) = page.as_object() else {
        return Err(CliError::transport(
            "api_response_invalid",
            "API returned an invalid member directory page",
        ));
    };
    let valid_total = object.get("total").and_then(Value::as_u64).is_some();
    let valid_items = object
        .get("items")
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().all(Value::is_object));
    let valid_cursor = object
        .get("nextCursor")
        .is_some_and(|cursor| cursor.is_null() || cursor.is_string());
    let valid_more = object.get("hasMore").and_then(Value::as_bool).is_some();
    if valid_total && valid_items && valid_cursor && valid_more {
        Ok(())
    } else {
        Err(CliError::transport(
            "api_response_invalid",
            "API returned an invalid member directory page",
        ))
    }
}

fn format_member_page(page: &Value) -> String {
    let mut lines = vec![format!(
        "total={}",
        page["total"].as_u64().unwrap_or_default()
    )];
    if let Some(items) = page["items"].as_array() {
        for item in items {
            let Some(object) = item.as_object() else {
                continue;
            };
            let mut fields = Vec::new();
            for key in ["name", "type", "role", "ref"] {
                if let Some(value) = object.get(key) {
                    fields.push(format!("{key}={}", render_value(value)));
                }
            }
            for (key, value) in object {
                if ["name", "type", "role", "ref"].contains(&key.as_str())
                    || value.is_object()
                    || value.is_array()
                {
                    continue;
                }
                fields.push(format!(
                    "{}={}",
                    escape_terminal_controls(key),
                    render_value(value)
                ));
            }
            lines.push(fields.join(" "));
        }
    }
    if let Some(cursor) = page["nextCursor"].as_str() {
        lines.push(format!("nextCursor={}", escape_terminal_controls(cursor)));
    }
    lines.join("\n")
}

fn render_value(value: &Value) -> String {
    match value {
        Value::Null => "-".to_owned(),
        Value::String(value) => {
            let escaped = escape_terminal_controls(value);
            let compact = escaped.split_whitespace().collect::<Vec<_>>().join(" ");
            let characters = compact.chars().collect::<Vec<_>>();
            if characters.len() > 90 {
                format!("{}...", characters[..87].iter().collect::<String>())
            } else {
                compact
            }
        }
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Array(_) | Value::Object(_) => "[object]".to_owned(),
    }
}

fn escape_terminal_controls(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if character.is_control() {
            escaped.push_str(&format!("\\u{{{:x}}}", character as u32));
        } else {
            escaped.push(character);
        }
    }
    escaped
}

fn redact_json(value: &mut Value, secret: &str) {
    match value {
        Value::String(text) => *text = redact_text(text, secret),
        Value::Array(values) => values
            .iter_mut()
            .for_each(|value| redact_json(value, secret)),
        Value::Object(values) => {
            let replacements = values
                .iter()
                .map(|(key, value)| (redact_text(key, secret), value.clone()))
                .collect::<Vec<_>>();
            values.clear();
            for (key, mut value) in replacements {
                redact_json(&mut value, secret);
                values.insert(key, value);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn redact_text(value: &str, secret: &str) -> String {
    if secret.is_empty() {
        value.to_owned()
    } else {
        value.replace(secret, "[REDACTED]")
    }
}

fn load_profile(
    options: &Options,
    environment: &BTreeMap<String, String>,
) -> Result<Profile, CliError> {
    let Some(context_path) = resolve_context_path(options, environment) else {
        return Ok(Profile::default());
    };
    let text = match fs::read_to_string(&context_path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Profile::default()),
        Err(_) => return Err(CliError::cli("could not read CLI context file")),
    };
    let value: Value = serde_json::from_str(&text)
        .map_err(|_| CliError::cli("could not parse CLI context JSON"))?;
    let Some(context) = value.as_object() else {
        return Ok(Profile::default());
    };
    let profile_name = nonempty(options.profile.as_deref())
        .or_else(|| {
            context
                .get("currentProfile")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or("default");
    let profile = context
        .get("profiles")
        .and_then(Value::as_object)
        .and_then(|profiles| profiles.get(profile_name))
        .and_then(Value::as_object);
    let Some(profile) = profile else {
        return Ok(Profile::default());
    };
    Ok(Profile {
        api_base: profile
            .get("apiBase")
            .and_then(Value::as_str)
            .and_then(trimmed_owned),
        org_id: profile
            .get("orgId")
            .or_else(|| profile.get("companyId"))
            .and_then(Value::as_str)
            .and_then(trimmed_owned),
        api_key_env_var_name: profile
            .get("apiKeyEnvVarName")
            .and_then(Value::as_str)
            .and_then(trimmed_owned),
    })
}

fn resolve_context_path(
    options: &Options,
    environment: &BTreeMap<String, String>,
) -> Option<PathBuf> {
    if let Some(path) = nonempty(options.context_path.as_deref()) {
        return Some(PathBuf::from(path));
    }
    if let Some(path) = env_value(environment, "RUDDER_CONTEXT") {
        return Some(PathBuf::from(path));
    }
    let mut directory = env::current_dir().ok()?;
    loop {
        let candidate = directory.join(".rudder").join("context.json");
        if candidate.is_file() {
            return Some(candidate);
        }
        if !directory.pop() {
            break;
        }
    }
    home_dir(environment).map(|home| home.join(".rudder").join("context.json"))
}

fn infer_api_base(options: &Options, environment: &BTreeMap<String, String>) -> String {
    let host = env_value(environment, "RUDDER_SERVER_HOST")
        .map(str::to_owned)
        .unwrap_or_else(|| "localhost".to_owned());
    let env_port = env_value(environment, "RUDDER_SERVER_PORT").and_then(positive_port);
    let config_port = env_port.or_else(|| read_config_port(options, environment));
    let port = config_port.unwrap_or(3100);
    format!("http://{host}:{port}")
}

fn read_config_port(options: &Options, environment: &BTreeMap<String, String>) -> Option<u16> {
    let path = resolve_config_path(options, environment)?;
    let value: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let port = value.pointer("/server/port")?.as_u64()?;
    u16::try_from(port).ok().filter(|port| *port > 0)
}

fn resolve_config_path(
    options: &Options,
    environment: &BTreeMap<String, String>,
) -> Option<PathBuf> {
    if let Some(path) = nonempty(options.config_path.as_deref()) {
        return Some(PathBuf::from(path));
    }
    if let Some(path) = env_value(environment, "RUDDER_CONFIG") {
        return Some(PathBuf::from(path));
    }
    let mut directory = env::current_dir().ok()?;
    loop {
        let candidate = directory.join(".rudder").join("config.json");
        if candidate.is_file() {
            return Some(candidate);
        }
        if !directory.pop() {
            break;
        }
    }
    let home = home_dir(environment)?;
    let instance = env_value(environment, "RUDDER_INSTANCE_ID")
        .map(str::to_owned)
        .unwrap_or_else(|| "default".to_owned());
    Some(home.join("instances").join(instance).join("config.json"))
}

fn home_dir(environment: &BTreeMap<String, String>) -> Option<PathBuf> {
    env_value(environment, "RUDDER_HOME")
        .map(PathBuf::from)
        .or_else(|| env_value(environment, "HOME").map(PathBuf::from))
        .or_else(|| env_value(environment, "USERPROFILE").map(PathBuf::from))
}

fn positive_port(value: &str) -> Option<u16> {
    value.parse::<u16>().ok().filter(|port| *port > 0)
}

fn is_loopback_host(host: Option<&str>) -> bool {
    let Some(host) = host else {
        return false;
    };
    let normalized = host.trim_end_matches('.');
    normalized.eq_ignore_ascii_case("localhost")
        || normalized.to_ascii_lowercase().ends_with(".localhost")
        || normalized
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn env_value<'a>(environment: &'a BTreeMap<String, String>, name: &str) -> Option<&'a str> {
    environment
        .get(name)
        .map(String::as_str)
        .and_then(|value| nonempty(Some(value)))
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn trimmed_owned(value: &str) -> Option<String> {
    nonempty(Some(value)).map(str::to_owned)
}
