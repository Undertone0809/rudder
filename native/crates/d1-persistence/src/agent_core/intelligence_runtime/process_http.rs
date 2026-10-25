use serde_json::Value;
use std::{
    env,
    ffi::OsStr,
    path::{Path, PathBuf},
    time::Duration,
};

const HTTP_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

pub(super) async fn test_process(config: &Value) -> Result<Option<String>, String> {
    let command = super::config_string(config, "command", "");
    if command.is_empty() {
        return Ok(Some("Process adapter requires a command.".to_owned()));
    }

    let configured_cwd = super::config_string(config, "cwd", "");
    let cwd = if configured_cwd.is_empty() {
        env::current_dir().map_err(|error| error.to_string())?
    } else {
        PathBuf::from(configured_cwd)
    };
    if !cwd.is_absolute() {
        return Ok(Some(format!(
            "Working directory must be an absolute path: \"{}\"",
            cwd.display()
        )));
    }
    match std::fs::metadata(&cwd) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => {
            return Ok(Some(format!(
                "Working directory is not a directory: \"{}\"",
                cwd.display()
            )));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Some(format!(
                "Working directory does not exist: \"{}\"",
                cwd.display()
            )));
        }
        Err(error) => return Ok(Some(error.to_string())),
    }

    let config_with_path = config_with_runtime_path(config);
    if let Some(error) = process_command_error(&command, &cwd, &config_with_path) {
        return Ok(Some(error));
    }
    Ok(None)
}

fn process_command_error(command: &str, cwd: &Path, config: &Value) -> Option<String> {
    if process_resolve_command(command, cwd, config) {
        None
    } else if command.contains('/') || command.contains('\\') {
        let absolute = if Path::new(command).is_absolute() {
            PathBuf::from(command)
        } else {
            cwd.join(command)
        };
        Some(format!(
            "Command is not executable: \"{command}\" (resolved: \"{}\")",
            absolute.display()
        ))
    } else {
        Some(format!("Command not found in PATH: \"{command}\""))
    }
}

fn process_resolve_command(command: &str, cwd: &Path, config: &Value) -> bool {
    if command.trim().is_empty() {
        return false;
    }
    let command_path = Path::new(command);
    if command_path.is_absolute() || command.contains('/') || command.contains('\\') {
        let candidate = if command_path.is_absolute() {
            command_path.to_path_buf()
        } else {
            cwd.join(command_path)
        };
        return process_path_exists(&candidate);
    }

    let path = super::path_env(config);
    for directory in
        env::split_paths(OsStr::new(&path)).filter(|directory| !directory.as_os_str().is_empty())
    {
        #[cfg(windows)]
        {
            let extensions = process_path_extensions(config);
            let has_extension = command_path.extension().is_some();
            let candidates = if has_extension {
                vec![directory.join(command)]
            } else {
                extensions
                    .iter()
                    .map(|extension| directory.join(format!("{command}{extension}")))
                    .collect()
            };
            if candidates
                .iter()
                .any(|candidate| process_path_exists(candidate))
            {
                return true;
            }
        }
        #[cfg(not(windows))]
        if process_path_exists(&directory.join(command)) {
            return true;
        }
    }
    false
}

#[cfg(windows)]
fn process_path_extensions(config: &Value) -> Vec<String> {
    let path_ext = config
        .get("env")
        .and_then(Value::as_object)
        .and_then(|env| env.get("PATHEXT"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| env::var("PATHEXT").ok())
        .unwrap_or_else(|| ".EXE;.CMD;.BAT;.COM".to_owned());
    path_ext
        .split(';')
        .filter(|extension| !extension.is_empty())
        .map(str::to_owned)
        .collect()
}

#[cfg(unix)]
fn process_path_exists(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;

    let Ok(path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // Match Node's fs.access(X_OK) check. It intentionally tests effective
    // execute/search access rather than requiring a regular file itself.
    unsafe { libc::access(path.as_ptr(), libc::X_OK) == 0 }
}

#[cfg(windows)]
fn process_path_exists(path: &Path) -> bool {
    // Node's Windows path probe uses fs.access(F_OK), so extension and
    // existence are checked without a POSIX executable-bit requirement.
    std::fs::metadata(path).is_ok()
}

#[cfg(not(any(unix, windows)))]
fn process_path_exists(path: &Path) -> bool {
    std::fs::metadata(path).is_ok()
}

fn config_with_runtime_path(config: &Value) -> Value {
    let mut normalized = config.as_object().cloned().unwrap_or_default();
    let mut runtime_env = config
        .get("env")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut inherited_path = None;
    let mut inherited_path_alias = None;
    for (key, value) in env::vars_os() {
        if key == OsStr::new("PATH") {
            inherited_path = Some(value.to_string_lossy().into_owned());
        } else if key == OsStr::new("Path") {
            inherited_path_alias = Some(value.to_string_lossy().into_owned());
        }
    }
    let primary_path = runtime_env
        .get("PATH")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or(inherited_path);
    let alias_path = runtime_env
        .get("Path")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or(inherited_path_alias);
    let path = primary_path
        .filter(|path| !path.is_empty())
        .or_else(|| alias_path.filter(|path| !path.is_empty()))
        .unwrap_or_else(|| default_path_for_platform().to_owned());
    runtime_env.retain(|key, _| !key.eq_ignore_ascii_case("PATH"));
    runtime_env.insert("PATH".to_owned(), Value::String(path));
    normalized.insert("env".to_owned(), Value::Object(runtime_env));
    Value::Object(normalized)
}

#[cfg(windows)]
fn default_path_for_platform() -> &'static str {
    r"C:\Windows\System32;C:\Windows;C:\Windows\System32\Wbem"
}

#[cfg(not(windows))]
fn default_path_for_platform() -> &'static str {
    "/usr/local/bin:/opt/homebrew/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin"
}

pub(super) async fn test_http(config: &Value) -> Result<Option<String>, String> {
    let raw_url = super::config_string(config, "url", "");
    if raw_url.is_empty() {
        return Ok(Some("HTTP adapter requires a URL.".to_owned()));
    }
    let url = match url::Url::parse(&raw_url) {
        Ok(url) => url,
        Err(_) => return Ok(Some(format!("Invalid URL: {raw_url}"))),
    };
    if !matches!(url.scheme(), "http" | "https") {
        return Ok(Some(format!("Unsupported URL protocol: {}:", url.scheme())));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Ok(Some("Endpoint probe failed".to_owned()));
    }

    let client = reqwest::Client::builder()
        .timeout(HTTP_PROBE_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    let response = match client.head(url).send().await {
        Ok(response) => response,
        Err(_) => return Ok(Some("Endpoint probe failed".to_owned())),
    };
    let status = response.status();
    if !status.is_success() && status.as_u16() != 405 && status.as_u16() != 501 {
        return Ok(Some(format!(
            "Endpoint probe returned HTTP {}.",
            status.as_u16()
        )));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[tokio::test]
    async fn process_test_checks_required_command_and_working_directory() {
        let missing_command = test_process(&json!({ "cwd": "relative" }))
            .await
            .expect("preflight should complete");
        assert_eq!(
            missing_command.as_deref(),
            Some("Process adapter requires a command.")
        );

        let executable = env::current_exe().expect("test executable path");
        let invalid_cwd = test_process(&json!({
            "command": executable,
            "cwd": "relative"
        }))
        .await
        .expect("preflight should complete");
        assert_eq!(
            invalid_cwd.as_deref(),
            Some("Working directory must be an absolute path: \"relative\"")
        );
    }

    #[tokio::test]
    async fn process_test_resolves_executable_in_configured_path_without_running_it() {
        let executable = env::current_exe().expect("test executable path");
        let command = executable
            .file_name()
            .expect("test executable has a filename")
            .to_string_lossy()
            .into_owned();
        let directory = executable
            .parent()
            .expect("test executable has a parent directory");
        let cwd = tempfile::tempdir().expect("temporary working directory");
        let result = test_process(&json!({
            "command": command,
            "cwd": cwd.path(),
            "env": { "PATH": directory }
        }))
        .await
        .expect("preflight should complete");
        assert_eq!(result, None);

        let missing = test_process(&json!({
            "command": "rudder-test-command-that-does-not-exist",
            "cwd": cwd.path(),
            "env": { "PATH": directory }
        }))
        .await
        .expect("preflight should complete");
        assert_eq!(
            missing.as_deref(),
            Some("Command not found in PATH: \"rudder-test-command-that-does-not-exist\"")
        );
    }

    #[tokio::test]
    async fn process_test_uses_process_directory_for_empty_cwd() {
        let executable = env::current_exe().expect("test executable path");
        let command = executable
            .file_name()
            .expect("test executable has a filename")
            .to_string_lossy()
            .into_owned();
        let directory = executable
            .parent()
            .expect("test executable has a parent directory");

        let result = test_process(&json!({
            "command": command,
            "cwd": "",
            "env": { "PATH": directory }
        }))
        .await
        .expect("preflight should complete");
        assert_eq!(result, None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn process_test_requires_execute_access_for_unix_commands() {
        use std::os::unix::fs::PermissionsExt;

        let cwd = tempfile::tempdir().expect("temporary working directory");
        let command = cwd.path().join("not-executable");
        std::fs::write(&command, b"placeholder").expect("write command file");
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o600))
            .expect("remove execute permission");

        let result = test_process(&json!({
            "command": command,
            "cwd": cwd.path()
        }))
        .await
        .expect("preflight should complete");
        assert_eq!(
            result.as_deref(),
            Some(
                format!(
                    "Command is not executable: \"{}\" (resolved: \"{}\")",
                    command.display(),
                    command.display()
                )
                .as_str()
            )
        );
    }

    async fn serve_status(status: u16) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback test server");
        let address = listener.local_addr().expect("local address");
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept HTTP probe");
            let mut request = Vec::new();
            let mut chunk = [0u8; 512];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = stream.read(&mut chunk).await.expect("read request");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
            }
            let request_line = String::from_utf8_lossy(&request)
                .lines()
                .next()
                .unwrap_or_default()
                .to_owned();
            let reason = match status {
                200 => "OK",
                405 => "Method Not Allowed",
                501 => "Not Implemented",
                _ => "Service Unavailable",
            };
            let response = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            stream
                .write_all(response.as_bytes())
                .await
                .expect("write response");
            request_line
        });
        (format!("http://{address}/health"), task)
    }

    #[tokio::test]
    async fn http_test_uses_head_and_accepts_success_405_and_501() {
        for status in [200, 405, 501] {
            let (url, server) = serve_status(status).await;
            let result = test_http(&json!({ "url": url, "method": "PATCH" }))
                .await
                .expect("preflight should complete");
            assert_eq!(result, None);
            assert_eq!(
                server.await.expect("test server task"),
                "HEAD /health HTTP/1.1"
            );
        }
    }

    #[tokio::test]
    async fn http_test_warns_for_unexpected_status_and_rejects_invalid_urls() {
        let (url, server) = serve_status(503).await;
        let result = test_http(&json!({ "url": url }))
            .await
            .expect("preflight should complete");
        assert_eq!(result.as_deref(), Some("Endpoint probe returned HTTP 503."));
        let _ = server.await.expect("test server task");

        assert_eq!(
            test_http(&json!({}))
                .await
                .expect("missing URL is a result")
                .as_deref(),
            Some("HTTP adapter requires a URL.")
        );
        assert_eq!(
            test_http(&json!({ "url": "ftp://example.test/" }))
                .await
                .expect("invalid scheme is a result")
                .as_deref(),
            Some("Unsupported URL protocol: ftp:")
        );
        assert_eq!(
            test_http(&json!({ "url": "http://user:password@example.test/" }))
                .await
                .expect("URL credentials are a blocking probe result")
                .as_deref(),
            Some("Endpoint probe failed")
        );
    }
}
