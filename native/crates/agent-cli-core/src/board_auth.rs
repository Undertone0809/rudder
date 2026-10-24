//! Board CLI challenge orchestration and credential persistence. No Node process.
use super::{
    CliError, Options, api_response_error, build_request_url, env_value, infer_api_base,
    load_profile, nonempty, read_bounded, redact_json, request_timeout,
};
use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderValue};
use reqwest::redirect::Policy;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use url::Url;

mod store;

#[derive(Clone, Copy)]
enum Operation {
    Login,
    Logout,
    Whoami,
}

pub(super) struct AuthCommand {
    operation: Operation,
    options: Options,
    instance_admin: bool,
    no_browser: bool,
    data_dir: Option<String>,
}

pub(super) fn parse(args: &[String]) -> Result<AuthCommand, CliError> {
    let operation = match args.get(1).map(String::as_str) {
        Some("login") => Operation::Login,
        Some("logout") => Operation::Logout,
        Some("whoami") => Operation::Whoami,
        _ => {
            return Err(CliError::cli(
                "supported auth commands: login, logout, whoami",
            ));
        }
    };
    let mut command = AuthCommand {
        operation,
        options: Options::default(),
        instance_admin: false,
        no_browser: false,
        data_dir: None,
    };
    let mut index = 2;
    while index < args.len() {
        match args[index].as_str() {
            "--json" => {
                command.options.json = true;
                index += 1;
                continue;
            }
            "--full-ids" => {
                command.options.full_ids = true;
                index += 1;
                continue;
            }
            "--instance-admin" if matches!(operation, Operation::Login) => {
                command.instance_admin = true;
                index += 1;
                continue;
            }
            "--no-browser" if matches!(operation, Operation::Login) => {
                command.no_browser = true;
                index += 1;
                continue;
            }
            _ => {}
        }
        let (flag, inline) = args[index]
            .split_once('=')
            .map_or((args[index].as_str(), None), |(flag, value)| {
                (flag, Some(value))
            });
        let target = match flag {
            "--api-base" => &mut command.options.api_base,
            "--api-key" => &mut command.options.api_key,
            "--org-id" | "-O" if matches!(operation, Operation::Login) => {
                &mut command.options.org_id
            }
            "--context" => &mut command.options.context_path,
            "--profile" => &mut command.options.profile,
            "--config" | "-c" => &mut command.options.config_path,
            "--data-dir" | "-d" => &mut command.data_dir,
            // Accepted common client metadata; these auth operations do not submit agent runs.
            "--run-id" => {
                index += if inline.is_some() { 1 } else { 2 };
                if index > args.len() {
                    return Err(CliError::cli("--run-id requires a value"));
                }
                continue;
            }
            _ => return Err(CliError::cli(format!("unknown argument: {flag}"))),
        };
        let value = if let Some(value) = inline {
            value.to_owned()
        } else {
            index += 1;
            args.get(index)
                .cloned()
                .ok_or_else(|| CliError::cli(format!("{flag} requires a value")))?
        };
        *target = Some(value);
        index += 1;
    }
    Ok(command)
}

pub(super) fn stored_token(
    environment: &BTreeMap<String, String>,
    base: &str,
) -> Result<Option<String>, CliError> {
    let path = store::path(environment)?;
    Ok(store::credential(&path, base.trim().trim_end_matches('/'))?
        .as_ref()
        .and_then(store::token)
        .map(str::to_owned))
}

pub(super) fn rudder_home(environment: &BTreeMap<String, String>) -> Option<std::path::PathBuf> {
    store::home(environment).ok()
}

impl AuthCommand {
    pub(super) fn json(&self) -> bool {
        self.options.json
    }

    pub(super) fn run(
        &self,
        environment: &BTreeMap<String, String>,
        stderr: &mut dyn Write,
    ) -> Result<Value, CliError> {
        let mut environment = environment.clone();
        if let Some(directory) = nonempty(self.data_dir.as_deref()) {
            environment.insert("RUDDER_HOME".to_owned(), directory.to_owned());
        }
        let profile = load_profile(&self.options, &environment)?;
        let base = nonempty(self.options.api_base.as_deref())
            .or_else(|| env_value(&environment, "RUDDER_API_URL"))
            .or(profile.api_base.as_deref())
            .map(str::to_owned)
            .unwrap_or_else(|| infer_api_base(&self.options, &environment));
        let base = base.trim().trim_end_matches('/');
        build_request_url(base, "/api/cli-auth/me", "")?;
        let path = store::path(&environment)?;
        let client = Client::builder()
            .timeout(request_timeout(&environment)?)
            .redirect(Policy::none())
            .build()
            .map_err(|_| {
                CliError::transport("api_transport_error", "could not initialize API client")
            })?;
        match self.operation {
            Operation::Login => {
                // Fail before issuing a new challenge if an existing store cannot be read safely.
                let _ = store::credential(&path, base)?;
                let org = nonempty(self.options.org_id.as_deref())
                    .or_else(|| env_value(&environment, "RUDDER_ORG_ID"))
                    .or(profile.org_id.as_deref());
                self.login(&client, base, org, &path, stderr)
            }
            Operation::Logout => {
                let Some(credential) = store::credential(&path, base)? else {
                    return Ok(
                        json!({"ok": true, "apiBase": base, "revoked": false, "removedLocalCredential": false}),
                    );
                };
                let token = store::token(&credential)
                    .ok_or_else(|| CliError::cli("invalid stored board credential"))?;
                let revoked = request(
                    &client,
                    base,
                    "/api/cli-auth/revoke-current",
                    "",
                    Some(&json!({})),
                    Some(token),
                )
                .is_ok();
                // A concurrent login may have saved a different key during the HTTP request.
                let removed = store::remove_if_current(&path, base, token)?;
                Ok(
                    json!({"ok": true, "apiBase": base, "revoked": revoked, "removedLocalCredential": removed}),
                )
            }
            Operation::Whoami => {
                let explicit = nonempty(self.options.api_key.as_deref())
                    .or_else(|| env_value(&environment, "RUDDER_API_KEY"))
                    .or_else(|| {
                        profile
                            .api_key_env_var_name
                            .as_deref()
                            .and_then(|name| env_value(&environment, name))
                    });
                let stored = if explicit.is_none() {
                    store::credential(&path, base)?
                } else {
                    None
                };
                let token = explicit.or_else(|| stored.as_ref().and_then(store::token))
                    .ok_or_else(|| CliError::cli("Board credential is required. Run rudder-cli auth login or supply --api-key."))?;
                let mut me = request(&client, base, "/api/cli-auth/me", "", None, Some(token))?;
                redact_json(&mut me, token);
                Ok(me)
            }
        }
    }

    fn login(
        &self,
        client: &Client,
        base: &str,
        org: Option<&str>,
        store_path: &std::path::Path,
        stderr: &mut dyn Write,
    ) -> Result<Value, CliError> {
        let challenge = request(
            client,
            base,
            "/api/cli-auth/challenges",
            "",
            Some(&json!({
                "command": "rudder auth login", "clientName": "rudder cli",
                "requestedAccess": if self.instance_admin { "instance_admin_required" } else { "board" },
                "requestedCompanyId": org,
            })),
            None,
        )?;
        let id = required_string(&challenge, "id")?;
        if id.len() > 128
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(invalid_response());
        }
        let token = required_string(&challenge, "token")?;
        let board_token = required_string(&challenge, "boardApiToken")?;
        let poll_path = format!("/cli-auth/challenges/{id}");
        if challenge.get("pollPath").and_then(Value::as_str) != Some(poll_path.as_str()) {
            return Err(invalid_response());
        }
        let expiry = OffsetDateTime::parse(required_string(&challenge, "expiresAt")?, &Rfc3339)
            .map_err(|_| invalid_response())?;
        let remaining = expiry - OffsetDateTime::now_utc();
        if !remaining.is_positive() {
            return Err(expired());
        }
        let budget = Duration::try_from(remaining)
            .map_err(|_| invalid_response())?
            .min(Duration::from_secs(600));
        let deadline = Instant::now() + budget;
        let approval = approval_url(base, &challenge)?;
        if approval.contains(board_token) {
            return Err(invalid_response());
        }
        let _ = writeln!(
            stderr,
            "Board authentication required\nOpen this URL in your browser to approve CLI access:\n{approval}"
        );
        if !self.no_browser && open_browser(&approval) {
            let _ = writeln!(stderr, "Opened the approval page in your browser.");
        }
        let interval = Duration::from_millis(
            challenge
                .get("suggestedPollIntervalMs")
                .and_then(Value::as_u64)
                .unwrap_or(1000)
                .clamp(500, 5000),
        );
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("token", token)
            .finish();
        while Instant::now() < deadline {
            let status = request(
                client,
                base,
                &format!("/api{poll_path}"),
                &query,
                None,
                None,
            )
            .map_err(|mut error| {
                for secret in [token, board_token] {
                    error.code = super::redact_text(&error.code, secret);
                    error.message = super::redact_text(&error.message, secret);
                    if let Some(details) = error.details.as_mut() {
                        redact_json(details, secret);
                    }
                }
                error
            })?;
            match status.get("status").and_then(Value::as_str) {
                Some("approved") => {
                    let persisted = (|| -> Result<Value, CliError> {
                        let me = request(
                            client,
                            base,
                            "/api/cli-auth/me",
                            "",
                            None,
                            Some(board_token),
                        )?;
                        let user_id = me
                            .get("userId")
                            .filter(|id| !id.is_null())
                            .or_else(|| me.pointer("/user/id"))
                            .and_then(Value::as_str)
                            .filter(|id| !id.trim().is_empty())
                            .ok_or_else(invalid_response)?;
                        let user_id = json!(user_id);
                        store::save(store_path, base, board_token, user_id.clone())?;
                        Ok(user_id)
                    })();
                    let user_id = match persisted {
                        Ok(id) => id,
                        Err(mut error) => {
                            // Approval already created a server key. Avoid leaving it orphaned
                            // when identity lookup or local persistence cannot finish.
                            if request(
                                client,
                                base,
                                "/api/cli-auth/revoke-current",
                                "",
                                Some(&json!({})),
                                Some(board_token),
                            )
                            .is_err()
                            {
                                error.message.push_str(
                                    "; approved credential revocation could not be confirmed",
                                );
                            }
                            return Err(error);
                        }
                    };
                    return Ok(
                        json!({"ok": true, "apiBase": base, "userId": user_id, "approvalUrl": approval}),
                    );
                }
                Some("cancelled") => {
                    return Err(CliError::cli("CLI auth challenge was cancelled."));
                }
                Some("expired") => return Err(expired()),
                Some("pending") => {}
                _ => return Err(invalid_response()),
            }
            std::thread::sleep(interval.min(deadline.saturating_duration_since(Instant::now())));
        }
        Err(expired())
    }
}

fn request(
    client: &Client,
    base: &str,
    path: &str,
    query: &str,
    body: Option<&Value>,
    token: Option<&str>,
) -> Result<Value, CliError> {
    let url = build_request_url(base, path, query)?;
    let mut builder = if body.is_some() {
        client.post(url)
    } else {
        client.get(url)
    }
    .header(ACCEPT, "application/json");
    if let Some(body) = body {
        builder = builder
            .header(CONTENT_TYPE, "application/json")
            .body(body.to_string());
    }
    if let Some(token) = token {
        let header = HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| {
            CliError::cli("API key contains characters that are invalid in an HTTP header")
        })?;
        builder = builder.header(AUTHORIZATION, header);
    }
    let response = builder.send().map_err(|error| {
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
    let bytes = read_bounded(response)?;
    if !(200..300).contains(&status) {
        return Err(api_response_error(status, &bytes, token.unwrap_or("")));
    }
    serde_json::from_slice(&bytes).map_err(|_| invalid_response())
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, CliError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 8192)
        .ok_or_else(invalid_response)
}

fn invalid_response() -> CliError {
    CliError::transport(
        "api_response_invalid",
        "API returned an invalid CLI authentication response",
    )
}
fn expired() -> CliError {
    CliError::cli("CLI auth challenge expired before approval.")
}

fn approval_url(base: &str, challenge: &Value) -> Result<String, CliError> {
    let base_url = Url::parse(base).map_err(|_| invalid_response())?;
    let fallback;
    let raw = if let Some(url) = challenge.get("approvalUrl").and_then(Value::as_str) {
        url
    } else {
        let path = required_string(challenge, "approvalPath")?;
        if !path.starts_with('/') || path.starts_with("//") {
            return Err(invalid_response());
        }
        fallback = format!("{base}{path}");
        &fallback
    };
    let url = Url::parse(raw).map_err(|_| invalid_response())?;
    if url.origin() != base_url.origin()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(CliError::cli(
            "CLI approval URL must use the configured API origin",
        ));
    }
    Ok(url.to_string())
}

fn open_browser(url: &str) -> bool {
    #[cfg(target_os = "macos")]
    let mut command = Command::new("/usr/bin/open");
    #[cfg(windows)]
    let mut command = {
        let root = std::env::var_os("SystemRoot")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows"));
        let mut command = Command::new(root.join("System32").join("rundll32.exe"));
        command.arg("url.dll,FileProtocolHandler");
        command
    };
    #[cfg(all(not(target_os = "macos"), not(windows)))]
    let mut command = Command::new("xdg-open");
    let Ok(mut child) = command
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    true
}
