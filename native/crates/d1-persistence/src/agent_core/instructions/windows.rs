//! Junctions match Node's `fs.symlink(..., "junction")` without requiring the
//! symbolic-link privilege. All paths were selected and bounded by native policy.
use std::{
    fs, io,
    os::windows::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    },
    path::{Component, Path, PathBuf},
};
use windows_sys::Win32::{
    Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    },
    System::IO::DeviceIoControl,
};

/// Check parents erased by Node-compatible lexical normalization. Retained
/// parents still go through the normal owned-root/compatibility-alias preflight.
/// Both separators occur in persisted paths, including verbatim temp roots.
pub(super) fn legacy_instruction_path(
    value: &str,
    cwd: Option<&Path>,
) -> io::Result<Option<PathBuf>> {
    let value = value.replace('/', "\\");
    let raw = if Path::new(&value).is_absolute() {
        PathBuf::from(&value)
    } else if let Some(cwd) = cwd {
        // Path::join removes `..` on a verbatim Windows base. Append without
        // resolving so a junction/file in `folder/..` cannot disappear first.
        let mut raw = cwd.as_os_str().to_os_string();
        raw.push("\\");
        raw.push(&value);
        PathBuf::from(raw)
    } else {
        return Ok(None);
    };
    let mut cursor = PathBuf::new();
    if let Some(parent) = raw.parent() {
        for component in parent.components() {
            match component {
                Component::Prefix(_) | Component::RootDir => cursor.push(component.as_os_str()),
                Component::CurDir => (),
                Component::ParentDir => {
                    // Inspect before popping: otherwise `junction/..` or
                    // `file/..` could hide an invalid traversed component.
                    if let Some(metadata) = super::fs::lstat(&cursor)?
                        && (!metadata.is_dir()
                            || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
                    {
                        return Err(super::fs::invalid(
                            "Instruction file parent is not an owned directory",
                        ));
                    }
                    cursor.pop();
                }
                Component::Normal(part) => cursor.push(part),
            }
        }
    }
    Ok(Some(super::fs::path(
        &raw.to_string_lossy(),
        Path::new("/"),
    )))
}

pub(super) fn junction(source: &Path, target: &Path) -> io::Result<()> {
    let absolute = fs::canonicalize(target)?;
    let printable = absolute.as_os_str().encode_wide().collect::<Vec<_>>();
    let text = absolute.to_string_lossy();
    let substitute = if let Some(rest) = text.strip_prefix(r"\\?\") {
        format!(r"\??\{rest}")
    } else {
        format!(r"\??\{text}")
    }
    .encode_utf16()
    .collect::<Vec<_>>();
    let substitute_len = u16::try_from(substitute.len() * 2).map_err(io::Error::other)?;
    let print_len = u16::try_from(printable.len() * 2).map_err(io::Error::other)?;
    let data_len = u16::try_from(8 + (substitute.len() + printable.len() + 2) * 2)
        .map_err(io::Error::other)?;
    let mut buffer = Vec::new();
    buffer.extend(0xA0000003_u32.to_le_bytes());
    buffer.extend(data_len.to_le_bytes());
    buffer.extend(0_u16.to_le_bytes());
    for field in [0, substitute_len, substitute_len + 2, print_len] {
        buffer.extend(field.to_le_bytes());
    }
    for word in substitute
        .into_iter()
        .chain([0])
        .chain(printable)
        .chain([0])
    {
        buffer.extend(word.to_le_bytes());
    }
    fs::create_dir(source)?;
    let result = (|| {
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(source)?;
        let mut returned = 0;
        let ok = unsafe {
            DeviceIoControl(
                file.as_raw_handle(),
                0x000900A4,
                buffer.as_ptr().cast(),
                buffer.len() as u32,
                std::ptr::null_mut(),
                0,
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    })();
    if result.is_err() {
        let _ = fs::remove_dir(source);
    }
    result
}
