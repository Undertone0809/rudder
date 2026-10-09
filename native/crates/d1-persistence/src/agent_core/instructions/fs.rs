use serde_json::Value;
use std::{
    fs,
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
};

pub(super) fn invalid(message: &str) -> io::Error {
    io::Error::other(message.to_owned())
}
pub(super) fn random() -> io::Result<String> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| invalid("Secure randomness is unavailable"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
pub(super) fn path(value: &str, base: &Path) -> PathBuf {
    let joined = if Path::new(value).is_absolute() {
        PathBuf::from(value)
    } else {
        base.join(value)
    };
    let mut output = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => (),
            Component::ParentDir => {
                output.pop();
            }
            c => output.push(c),
        }
    }
    output
}
pub(super) fn stat(p: &Path) -> Option<fs::Metadata> {
    fs::metadata(p).ok()
}
pub(super) fn lstat(p: &Path) -> io::Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(p) {
        Ok(v) => Ok(Some(v)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}
pub(super) fn sync_dir(p: &Path) -> io::Result<()> {
    #[cfg(not(windows))]
    {
        fs::File::open(p)?.sync_all()?;
    }
    #[cfg(windows)]
    {
        let _ = p;
    }
    Ok(())
}
pub(super) fn mkdir_private(p: &Path) -> io::Result<()> {
    #[cfg(unix)]
    let mut builder = fs::DirBuilder::new();
    #[cfg(not(unix))]
    let builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(p)
}
pub(super) fn new_file(p: &Path, body: &[u8]) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(p)?;
    file.write_all(body)?;
    file.sync_all()
}
/// Atomically move only into a missing destination. Unsupported filesystems
/// fail closed; migrations must retain inode and metadata rather than copy.
pub(super) fn rename_new(source: &Path, target: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let from = CString::new(source.as_os_str().as_bytes()).map_err(io::Error::other)?;
        let to = CString::new(target.as_os_str().as_bytes()).map_err(io::Error::other)?;
        #[cfg(target_os = "linux")]
        let result = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                from.as_ptr(),
                libc::AT_FDCWD,
                to.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        #[cfg(target_os = "macos")]
        let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        return Err(io::Error::from_raw_os_error(libc::ENOSYS));
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let from = source
            .as_os_str()
            .encode_wide()
            .chain([0])
            .collect::<Vec<_>>();
        let to = target
            .as_os_str()
            .encode_wide()
            .chain([0])
            .collect::<Vec<_>>();
        if unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileExW(from.as_ptr(), to.as_ptr(), 0)
        } == 0
        {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}
/// Default-file publication needs no hard links. On older Unix filesystems,
/// exclusive-create retains legacy write semantics without replacing a target.
pub(super) fn publish_new(source: &Path, target: &Path) -> io::Result<()> {
    match rename_new(source, target) {
        #[cfg(unix)]
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(libc::ENOSYS | libc::EINVAL | libc::EOPNOTSUPP)
            ) =>
        {
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target)?;
            io::copy(&mut fs::File::open(source)?, &mut output)?;
            output.sync_all()
        }
        result => result,
    }
}
pub(super) fn atomic_json(p: &Path, value: &Value) -> io::Result<()> {
    let temporary = p.with_file_name(format!(
        "{}.{}.{}.tmp",
        p.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id(),
        random()?
    ));
    let body = format!("{}\n", serde_json::to_string_pretty(value)?);
    let result = (|| {
        new_file(&temporary, body.as_bytes())?;
        fs::rename(&temporary, p)?;
        sync_dir(p.parent().ok_or_else(|| invalid("Missing parent"))?)
    })();
    if temporary.exists() {
        let _ = fs::remove_file(temporary);
    }
    result
}
pub(super) fn json(p: &Path) -> io::Result<Value> {
    let bytes = fs::read(p)?;
    super::super::json_boundary::parse(&String::from_utf8_lossy(&bytes)).map_err(io::Error::other)
}
pub(super) fn same_directory(a: &Path, b: &Path) -> bool {
    fs::canonicalize(a)
        .ok()
        .zip(fs::canonicalize(b).ok())
        .is_some_and(|(a, b)| a == b)
}
pub(super) fn assert_owned(p: &Path) -> io::Result<()> {
    if let Some(metadata) = lstat(p)?
        && (!metadata.is_dir() || metadata.file_type().is_symlink())
    {
        return Err(invalid(
            "Organization workspace root is not an owned directory",
        ));
    }
    Ok(())
}
pub(super) fn assert_atomic(source: &Path, target: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        let source = source
            .parent()
            .ok_or_else(|| invalid("Missing source parent"))?;
        let target = target
            .parent()
            .ok_or_else(|| invalid("Missing target parent"))?;
        if identity(source)?.0 != identity(target)?.0
            || source
                .components()
                .next()
                .map(|v| v.as_os_str().to_string_lossy().to_lowercase())
                != target
                    .components()
                    .next()
                    .map(|v| v.as_os_str().to_string_lossy().to_lowercase())
        {
            return Err(invalid(
                "Cannot atomically migrate organization workspace across filesystems",
            ));
        }
    }
    #[cfg(unix)]
    {
        let source = fs::metadata(
            source
                .parent()
                .ok_or_else(|| invalid("Missing source parent"))?,
        )?;
        let target = fs::metadata(
            target
                .parent()
                .ok_or_else(|| invalid("Missing target parent"))?,
        )?;
        use std::os::unix::fs::MetadataExt;
        if source.dev() != target.dev() {
            return Err(invalid(
                "Cannot atomically migrate organization workspace across filesystems",
            ));
        }
    }
    Ok(())
}
#[cfg(any(test, windows))]
pub(super) fn identity(path: &Path) -> io::Result<(u64, u128)> {
    snapshot(path)?
        .map(|(_, identity)| identity)
        .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))
}
pub(super) fn snapshot(path: &Path) -> io::Result<Option<(fs::Metadata, (u64, u128))>> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let Some(metadata) = lstat(path)? else {
            return Ok(None);
        };
        let identity = (metadata.dev(), metadata.ino() as u128);
        Ok(Some((metadata, identity)))
    }
    #[cfg(windows)]
    {
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO, FileIdInfo,
            GetFileInformationByHandleEx,
        };
        let file = match fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let mut info = FILE_ID_INFO::default();
        let ok = unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileIdInfo,
                (&mut info as *mut FILE_ID_INFO).cast(),
                size_of::<FILE_ID_INFO>() as u32,
            )
        };
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(Some((
                file.metadata()?,
                (
                    info.VolumeSerialNumber,
                    u128::from_le_bytes(info.FileId.Identifier),
                ),
            )))
        }
    }
}
pub(super) fn alias(source: &Path, target: &Path) -> io::Result<()> {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, source)?;
    #[cfg(windows)]
    super::windows::junction(source, target)?;
    sync_dir(
        source
            .parent()
            .ok_or_else(|| invalid("Missing alias parent"))?,
    )
}
pub(super) fn move_with_alias(source: &Path, target: &Path) -> io::Result<()> {
    fs::rename(source, target)?;
    if let Err(error) = alias(source, target) {
        let _ = fs::rename(target, source);
        return Err(error);
    }
    Ok(())
}
pub(super) fn identical(a: &Path, b: &Path) -> io::Result<bool> {
    let mut a = fs::File::open(a)?;
    let mut b = fs::File::open(b)?;
    let ma = a.metadata()?;
    let mb = b.metadata()?;
    if !ma.is_file() || !mb.is_file() || ma.len() != mb.len() {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if ma.permissions().mode() & 0o111 != mb.permissions().mode() & 0o111 {
            return Ok(false);
        }
    }
    let mut ab = [0_u8; 65536];
    let mut bb = [0_u8; 65536];
    loop {
        let n = a.read(&mut ab)?;
        b.read_exact(&mut bb[..n])?;
        if ab[..n] != bb[..n] {
            return Ok(false);
        }
        if n == 0 {
            return Ok(true);
        }
    }
}
/// Preflight every collision before the first move, preserving both versions.
pub(super) fn preflight(source: &Path, target: &Path) -> io::Result<()> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        if entry.file_name() == ".rudder-workspace-migrations.json" {
            continue;
        }
        let destination = target.join(entry.file_name());
        let Some(other) = lstat(&destination)? else {
            assert_atomic(&entry.path(), &destination)?;
            continue;
        };
        let kind = entry.file_type()?;
        if kind.is_dir() && other.is_dir() {
            preflight(&entry.path(), &destination)?;
        } else if !(kind.is_file() && other.is_file() && identical(&entry.path(), &destination)?) {
            return Err(invalid(
                "Cannot migrate organization storage root because the target already exists",
            ));
        }
    }
    Ok(())
}
pub(super) fn merge(source: &Path, target: &Path) -> io::Result<bool> {
    fs::create_dir_all(target)?;
    let mut retained = false;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        if entry.file_name() == ".rudder-workspace-migrations.json" {
            continue;
        }
        let destination = target.join(entry.file_name());
        let Some(other) = lstat(&destination)? else {
            assert_atomic(&entry.path(), &destination)?;
            rename_new(&entry.path(), &destination)?;
            continue;
        };
        let kind = entry.file_type()?;
        if kind.is_dir() && other.is_dir() {
            if merge(&entry.path(), &destination)? {
                retained = true;
            } else {
                fs::remove_dir(entry.path())?;
            }
        } else if kind.is_file() && other.is_file() && identical(&entry.path(), &destination)? {
            retained = true;
        } else {
            return Err(invalid(
                "Cannot migrate organization storage root because the target already exists",
            ));
        }
    }
    Ok(retained)
}
pub(super) fn archive(source: &Path, parent: &Path) -> io::Result<()> {
    let backups = parent.join(".rudder-migration-backups");
    fs::create_dir_all(&backups)?;
    let name = format!(
        "{}-{}-{}",
        source.file_name().unwrap_or_default().to_string_lossy(),
        super::super::common::now().replace([':', '.'], "-"),
        random()?
    );
    fs::rename(source, backups.join(name))
}
