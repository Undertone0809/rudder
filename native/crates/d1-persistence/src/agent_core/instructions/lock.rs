//! The on-disk protocol is shared with home-paths.ts. A complete owner directory
//! is renamed into place; an unrecognized existing directory is never replaced.
use super::fs::*;
use serde_json::{Value, json};
use std::{
    fs, io,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant, SystemTime},
};
const OWNER: &str = ".rudder-lock-owner-";
const RECLAIM: &str = ".rudder-lock-reclaim-";
const KIND: &str = "rudder-organization-workspace-map-lock";
pub(super) struct Guard {
    path: PathBuf,
    token: String,
}
fn valid_record(value: &Value) -> bool {
    value["version"] == 1
        && value["token"].is_string()
        && value["hostname"].is_string()
        && value["pid"]
            .as_u64()
            .is_some_and(|pid| pid > 0 && pid <= 9_007_199_254_740_991)
        && age(value).is_some()
}
fn age(value: &Value) -> Option<i128> {
    let timestamp = time::OffsetDateTime::parse(
        value["createdAt"].as_str()?,
        &time::format_description::well_known::Rfc3339,
    )
    .ok()?;
    Some((time::OffsetDateTime::now_utc() - timestamp).whole_milliseconds())
}
fn owner(path: &Path) -> Option<Value> {
    let entries = fs::read_dir(path)
        .ok()?
        .collect::<io::Result<Vec<_>>>()
        .ok()?;
    let owners = entries
        .iter()
        .filter(|entry| {
            entry.file_type().is_ok_and(|t| t.is_file())
                && entry.file_name().to_string_lossy().starts_with(OWNER)
                && entry.file_name().to_string_lossy().ends_with(".json")
        })
        .collect::<Vec<_>>();
    let [owner] = owners.as_slice() else {
        return None;
    };
    if entries.iter().any(|entry| {
        entry.file_name() != owner.file_name()
            && !(entry.file_type().is_ok_and(|t| t.is_file())
                && entry.file_name().to_string_lossy().starts_with(RECLAIM)
                && entry.file_name().to_string_lossy().ends_with(".json"))
    }) {
        return None;
    }
    let value = json(&owner.path()).ok()?;
    (valid_record(&value)
        && value["kind"] == KIND
        && owner.file_name() == format!("{OWNER}{}.json", value["token"].as_str()?).as_str())
    .then_some(value)
}
fn alive(pid: u64) -> bool {
    let Ok(pid) = u32::try_from(pid) else {
        return true;
    };
    #[cfg(unix)]
    {
        let Ok(pid) = i32::try_from(pid) else {
            return true;
        };
        unsafe {
            libc::kill(pid, 0) == 0
                || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, GetLastError},
            System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        };
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                GetLastError() != ERROR_INVALID_PARAMETER
            } else {
                CloseHandle(handle);
                true
            }
        }
    }
}
fn stale(value: &Value, hostname: &str) -> bool {
    value["hostname"] == hostname
        && age(value).is_some_and(|age| age > 60_000)
        && !alive(value["pid"].as_u64().unwrap_or(0))
}
fn record(token: &str, hostname: &str) -> Value {
    json!({"version":1,"token":token,"pid":std::process::id(),"hostname":hostname,"createdAt":super::super::common::now()})
}
fn claims(path: &Path) -> io::Result<Vec<(PathBuf, Value)>> {
    let entries = match fs::read_dir(path) {
        Ok(v) => v,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut output = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !entry.file_type()?.is_file() || !name.starts_with(RECLAIM) || !name.ends_with(".json") {
            continue;
        }
        if let Ok(value) = json(&entry.path())
            && valid_record(&value)
            && value["ownerToken"].is_string()
            && name == format!("{RECLAIM}{}.json", value["token"].as_str().unwrap_or(""))
        {
            output.push((entry.path(), value));
        }
    }
    Ok(output)
}
fn reclaim(path: &Path, observed: &Value, hostname: &str) -> io::Result<()> {
    let token = random()?;
    let mut claim = record(&token, hostname);
    claim["ownerToken"] = observed["token"].clone();
    let claim_path = path.join(format!("{RECLAIM}{token}.json"));
    if let Err(error) = new_file(&claim_path, claim.to_string().as_bytes()) {
        return if error.kind() == io::ErrorKind::NotFound {
            Ok(())
        } else {
            Err(error)
        };
    }
    thread::sleep(Duration::from_millis(25));
    for (p, value) in claims(path)? {
        if stale(&value, hostname) {
            let _ = fs::remove_file(p);
        }
    }
    let mut live = claims(path)?
        .into_iter()
        .filter(|(_, value)| value["ownerToken"] == observed["token"])
        .collect::<Vec<_>>();
    live.sort_by(|(_, a), (_, b)| {
        a["createdAt"]
            .as_str()
            .cmp(&b["createdAt"].as_str())
            .then_with(|| a["token"].as_str().cmp(&b["token"].as_str()))
    });
    let elected = live
        .first()
        .is_some_and(|(_, value)| value["token"] == token);
    if !elected
        || !owner(path).is_some_and(|current| {
            current["token"] == observed["token"] && stale(&current, hostname)
        })
    {
        let _ = fs::remove_file(claim_path);
        return Ok(());
    }
    let tombstone = path.with_file_name(format!(
        ".rudder-organizations.lock.reclaimed-{}-{}",
        observed["token"].as_str().unwrap_or(""),
        random()?
    ));
    match fs::rename(path, &tombstone) {
        Ok(()) => fs::remove_dir_all(tombstone),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}
// The first identity was captured from the same metadata/handle before owner()
// read its record. A replacement is retried instead of inheriting old age/mode.
fn inspect_unowned(path: &Path, before: (u64, u128)) -> io::Result<bool> {
    let entries = fs::read_dir(path)
        .map(|entries| entries.count())
        .unwrap_or(0);
    let Some((metadata, current)) = snapshot(path)? else {
        return Ok(true);
    };
    if current != before {
        return Ok(true);
    }
    if entries > 0 {
        return Err(invalid("Unrecognized organization workspace mapping lock"));
    }
    let old = metadata
        .modified()
        .ok()
        .and_then(|time| SystemTime::now().duration_since(time).ok())
        .is_some_and(|age| age > Duration::from_secs(60));
    #[cfg(unix)]
    let private = {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o777 == 0o700
    };
    #[cfg(windows)]
    let private = false;
    if metadata.is_dir() && !metadata.file_type().is_symlink() && private && old {
        let parent = path
            .parent()
            .ok_or_else(|| invalid("Missing lock parent"))?;
        let quarantine = parent.join(format!(
            ".rudder-organizations.lock.recovered-{}",
            random()?
        ));
        match fs::rename(path, quarantine) {
            Ok(()) => sync_dir(parent)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
        Ok(true)
    } else {
        Ok(false)
    }
}
impl Guard {
    pub(super) fn acquire(home: &Path, hostname: &str) -> io::Result<Self> {
        fs::create_dir_all(home)?;
        let token = random()?;
        let path = home.join(".rudder-organizations.lock");
        let acquisition = home.join(format!(".rudder-organizations.lock.acquire-{token}"));
        mkdir_private(&acquisition)?;
        let result = (|| {
            let mut data = record(&token, hostname);
            data["kind"] = json!(KIND);
            new_file(
                &acquisition.join(format!("{OWNER}{token}.json")),
                format!("{data}\n").as_bytes(),
            )?;
            sync_dir(&acquisition)?;
            let start = Instant::now();
            loop {
                if start.elapsed() >= Duration::from_secs(10) {
                    return Err(invalid(
                        "Timed out waiting for organization workspace mapping lock",
                    ));
                }
                if let Some((_metadata, before)) = snapshot(&path)? {
                    if let Some(existing) = owner(&path) {
                        if stale(&existing, hostname) {
                            reclaim(&path, &existing, hostname)?;
                        } else {
                            thread::sleep(Duration::from_millis(25));
                        }
                        continue;
                    }
                    if !inspect_unowned(&path, before)? {
                        thread::sleep(Duration::from_millis(25));
                    }
                    continue;
                }
                match rename_new(&acquisition, &path) {
                    Ok(()) => return Ok(Self { path, token }),
                    Err(e)
                        if matches!(
                            e.kind(),
                            io::ErrorKind::AlreadyExists
                                | io::ErrorKind::DirectoryNotEmpty
                                | io::ErrorKind::IsADirectory
                        ) => {}
                    Err(e) => return Err(e),
                }
            }
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(acquisition);
        }
        result
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        if owner(&self.path).is_some_and(|owner| owner["token"] == self.token)
            && let Ok(token) = random()
        {
            let tombstone = self.path.with_file_name(format!(
                ".rudder-organizations.lock.released-{}-{token}",
                self.token
            ));
            if fs::rename(&self.path, &tombstone).is_ok() {
                let _ = fs::remove_dir_all(tombstone);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lock_publication_preserves_a_new_unrecognized_empty_directory() {
        let root = tempfile::tempdir().unwrap();
        let acquisition = root.path().join("acquisition");
        let lock = root.path().join("lock");
        mkdir_private(&acquisition).unwrap();
        new_file(&acquisition.join("owner"), b"complete").unwrap();
        assert!(lstat(&lock).unwrap().is_none());
        let external = lock.clone();
        std::thread::spawn(move || fs::create_dir(external).unwrap())
            .join()
            .unwrap();
        let before = identity(&lock).unwrap();
        assert_eq!(
            rename_new(&acquisition, &lock).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(identity(&lock).unwrap(), before);
        assert_eq!(fs::read_dir(&lock).unwrap().count(), 0);
        assert!(acquisition.join("owner").is_file());
    }
    #[test]
    fn replacement_lock_does_not_inherit_old_metadata() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(".rudder-organizations.lock");
        for valid_owner in [false, true] {
            mkdir_private(&path).unwrap();
            let old = snapshot(&path).unwrap().unwrap().1;
            fs::rename(&path, root.path().join(format!("old-{valid_owner}"))).unwrap();
            mkdir_private(&path).unwrap();
            if valid_owner {
                let mut value = record("replacement", "synthetic");
                value["kind"] = json!(KIND);
                new_file(
                    &path.join(format!("{OWNER}replacement.json")),
                    value.to_string().as_bytes(),
                )
                .unwrap();
            }
            let current = identity(&path).unwrap();
            assert_ne!(old, current);
            assert!(inspect_unowned(&path, old).unwrap());
            assert_eq!(identity(&path).unwrap(), current);
            fs::remove_dir_all(&path).unwrap();
        }
    }
    #[test]
    fn disappearing_owner_directory_retries_without_failure() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(".rudder-organizations.lock");
        mkdir_private(&path).unwrap();
        let old = snapshot(&path).unwrap().unwrap().1;
        fs::remove_dir(&path).unwrap();
        assert!(inspect_unowned(&path, old).unwrap());
    }
}
