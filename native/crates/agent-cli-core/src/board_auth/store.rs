use super::super::{CliError, MAX_RESPONSE_BYTES, env_value};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(super) fn home(environment: &BTreeMap<String, String>) -> Result<PathBuf, CliError> {
    let platform_home = || {
        #[cfg(windows)]
        let home = env_value(environment, "USERPROFILE").or_else(|| env_value(environment, "HOME"));
        #[cfg(not(windows))]
        let home = env_value(environment, "HOME").or_else(|| env_value(environment, "USERPROFILE"));
        home.map(PathBuf::from)
            .ok_or_else(|| CliError::cli("could not resolve the Rudder home directory"))
    };
    if let Some(raw) = env_value(environment, "RUDDER_HOME") {
        if raw == "~" {
            return platform_home();
        }
        if let Some(suffix) = raw.strip_prefix("~/") {
            return platform_home().map(|home| home.join(suffix));
        }
        return Ok(PathBuf::from(raw));
    }
    platform_home().map(|home| home.join(".rudder"))
}

pub(super) fn path(environment: &BTreeMap<String, String>) -> Result<PathBuf, CliError> {
    match env_value(environment, "RUDDER_AUTH_STORE") {
        Some(raw) => Ok(PathBuf::from(raw)),
        None => home(environment).map(|home| home.join("auth.json")),
    }
}

fn read(path: &Path) -> Result<Value, CliError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err(CliError::cli("CLI credential store must be a regular file"));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(json!({"version": 1, "credentials": {}}));
        }
        Err(_) => return Err(CliError::cli("could not inspect CLI credential store")),
        Ok(metadata) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o077 != 0 {
                    return Err(CliError::cli(
                        "CLI credential store must be private (mode 0600)",
                    ));
                }
            }
            #[cfg(not(unix))]
            let _ = metadata;
        }
    }
    let mut bytes = Vec::new();
    File::open(path)
        .and_then(|file| {
            file.take(MAX_RESPONSE_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
        })
        .map_err(|_| CliError::cli("could not read CLI credential store"))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(CliError::cli("CLI credential store exceeds the size limit"));
    }
    let mut value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| CliError::cli("could not parse CLI credential store JSON"))?;
    let root = value
        .as_object_mut()
        .ok_or_else(|| CliError::cli("invalid CLI credential store"))?;
    if root
        .get("version")
        .is_some_and(|version| version.as_u64() != Some(1))
    {
        return Err(CliError::cli("unsupported CLI credential store version"));
    }
    if !root.contains_key("credentials") {
        root.insert("credentials".to_owned(), json!({}));
    }
    if !root["credentials"].is_object() {
        return Err(CliError::cli("invalid CLI credential store credentials"));
    }
    Ok(value)
}

pub(super) fn credential(path: &Path, base: &str) -> Result<Option<Value>, CliError> {
    find(&read(path)?, base)
}

fn find(store: &Value, base: &str) -> Result<Option<Value>, CliError> {
    let mut found = None;
    for (key, value) in store["credentials"].as_object().into_iter().flatten() {
        if key.trim().trim_end_matches('/') != base {
            continue;
        }
        if found.is_some() {
            return Err(CliError::cli("duplicate API base in CLI credential store"));
        }
        if value
            .get("token")
            .and_then(Value::as_str)
            .is_some_and(|token| !token.trim().is_empty())
        {
            found = Some(value.clone());
        }
    }
    Ok(found)
}

pub(super) fn token(credential: &Value) -> Option<&str> {
    credential
        .get("token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|token| !token.is_empty())
}

pub(super) fn save(path: &Path, base: &str, token: &str, user_id: Value) -> Result<(), CliError> {
    mutate(path, |store| {
        let previous = find(store, base)?;
        let now = OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .map_err(|_| CliError::cli("could not format credential timestamp"))?;
        let created = previous
            .as_ref()
            .and_then(|value| value.get("createdAt"))
            .cloned()
            .unwrap_or_else(|| json!(now));
        let credentials = store["credentials"].as_object_mut().unwrap();
        credentials.retain(|key, _| key.trim().trim_end_matches('/') != base);
        credentials.insert(
            base.to_owned(),
            json!({
                "apiBase": base, "token": token, "userId": user_id,
                "createdAt": created, "updatedAt": now,
            }),
        );
        Ok(true)
    })
    .map(|_| ())
}

pub(super) fn remove_if_current(path: &Path, base: &str, expected: &str) -> Result<bool, CliError> {
    mutate(path, |store| {
        let Some(current) = find(store, base)? else {
            return Ok(false);
        };
        if token(&current) != Some(expected) {
            return Ok(false);
        }
        store["credentials"]
            .as_object_mut()
            .unwrap()
            .retain(|key, _| key.trim().trim_end_matches('/') != base);
        Ok(true)
    })
}

fn mutate(
    path: &Path,
    change: impl FnOnce(&mut Value) -> Result<bool, CliError>,
) -> Result<bool, CliError> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)
            .map_err(|_| CliError::cli("could not create CLI credential directory"))?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(parent)
        .map_err(|_| CliError::cli("could not create CLI credential directory"))?;
    let mut lock_name = path.as_os_str().to_os_string();
    lock_name.push(".lock");
    let lock_path = PathBuf::from(lock_name);
    if fs::symlink_metadata(&lock_path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(CliError::cli("CLI credential lock must not be a symlink"));
    }
    let lock = private_options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|_| CliError::cli("could not open CLI credential lock"))?;
    // OS file locks are released on process exit, including crashes.
    lock.lock()
        .map_err(|_| CliError::cli("could not lock CLI credential store"))?;
    let mut store = read(path)?;
    if !change(&mut store)? {
        return Ok(false);
    }
    store["version"] = json!(1);
    let bytes = serde_json::to_vec_pretty(&store)
        .map_err(|_| CliError::cli("could not serialize CLI credential store"))?;
    if bytes.len() >= MAX_RESPONSE_BYTES {
        return Err(CliError::cli("CLI credential store exceeds the size limit"));
    }
    let mut name = path
        .file_name()
        .ok_or_else(|| CliError::cli("invalid CLI credential path"))?
        .to_os_string();
    name.push(format!(
        ".{}.{}.tmp",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let temporary = parent.join(name);
    let mut owned_temporary = false;
    let mut renamed = false;
    let written = (|| -> io::Result<()> {
        let mut file = private_options()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        owned_temporary = true;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        renamed = true;
        #[cfg(unix)]
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if written.is_err() {
        // Only this invocation's create_new temporary file can be removed.
        if owned_temporary && !renamed {
            let _ = fs::remove_file(&temporary);
        }
        return Err(CliError::cli("could not persist CLI credential store"));
    }
    Ok(true)
}

fn private_options() -> OpenOptions {
    let options = OpenOptions::new();
    #[cfg(unix)]
    let options = {
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = options;
        options.mode(0o600);
        options
    };
    options
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_uses_platform_precedence_and_rudder_home_without_duplicate_suffix() {
        let mut environment = BTreeMap::from([
            ("HOME".to_owned(), "/unix-home".to_owned()),
            ("USERPROFILE".to_owned(), "/windows-home".to_owned()),
        ]);
        #[cfg(windows)]
        let expected = PathBuf::from("/windows-home");
        #[cfg(not(windows))]
        let expected = PathBuf::from("/unix-home");
        assert_eq!(home(&environment).unwrap(), expected.join(".rudder"));
        environment.insert("RUDDER_HOME".to_owned(), "~/custom".to_owned());
        assert_eq!(home(&environment).unwrap(), expected.join("custom"));
        environment.insert("RUDDER_HOME".to_owned(), "/explicit".to_owned());
        assert_eq!(home(&environment).unwrap(), PathBuf::from("/explicit"));
    }
}
