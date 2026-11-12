// Windows must not follow a reply's symlink into an SMB share just to find
// out what it points at. Open each component without following reparse points,
// and keep its handle until resolution ends. Not sharing delete prevents a
// checked name being replaced. Reads and listings reuse that handle too.
use std::ffi::{OsStr, OsString};
use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::{Component, Path, PathBuf, Prefix};

#[link(name = "kernel32")]
extern "system" {
    fn GetFullPathNameW(path: *const u16, size: u32, out: *mut u16, part: *mut *mut u16) -> u32;
    fn QueryDosDeviceW(name: *const u16, out: *mut u16, size: u32) -> u32;
    fn GetFinalPathNameByHandleW(file: *mut std::ffi::c_void, out: *mut u16, size: u32, flags: u32) -> u32;
    fn GetFileInformationByHandleEx(file: *mut std::ffi::c_void, class: u32, out: *mut std::ffi::c_void, size: u32) -> i32;
    fn ReOpenFile(file: *mut std::ffi::c_void, access: u32, share: u32, flags: u32) -> *mut std::ffi::c_void;
}

fn refused() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "a network share, device or unsupported reparse point")
}

/// The resolved local path, with every ancestor held against replacement.
/// The caller keeps these handles while inspecting the resolved file.
pub(crate) struct LocalPath {
    pub(crate) path: PathBuf,
    _held: Vec<File>,
}

impl LocalPath {
    pub(crate) fn new(path: &Path) -> io::Result<Self> {
        let mut held = Vec::new();
        let path = walk(path, &mut held, 0, false)?;
        Ok(Self { path, _held: held })
    }

    pub(crate) fn file(&self) -> io::Result<&File> {
        let file = self._held.last().ok_or_else(refused)?;
        if file.metadata()?.file_type().is_symlink() {
            return Err(refused());
        }
        Ok(file)
    }

    pub(crate) fn anchored_name(&self) -> io::Result<PathBuf> {
        let native = final_name(self.file()?, 2)?; // VOLUME_NAME_NT
        Ok(PathBuf::from(format!(r"\\?\GLOBALROOT{}", native.to_string_lossy())))
    }

    pub(crate) fn writable(&self) -> io::Result<File> {
        let file = self.file()?;
        // Reopen the same file object, without resolving its name again and
        // without truncating it before checking the returned handle.
        let raw = unsafe { ReOpenFile(file.as_raw_handle(), 0x4000_0000, 7, 0x0020_0000) };
        if raw as isize == -1 {
            return Err(io::Error::last_os_error());
        }
        let file = unsafe { File::from_raw_handle(raw) };
        let meta = file.metadata()?;
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Err(refused());
        }
        Ok(file)
    }

    pub(crate) fn entries(&self) -> io::Result<Vec<io::Result<super::open_policy::LocalDirEntry>>> {
        let file = self.file()?;
        if !file.metadata()?.is_dir() {
            return Err(io::Error::other("Not a folder"));
        }
        let mut entries = Vec::new();
        // FILE_ID_EXTD_DIR_INFO (class 19), aligned to eight bytes. Enumerate
        // the checked directory handle, never a new lookup of `path\*`.
        let mut storage = vec![0u64; 8192];
        loop {
            if unsafe { GetFileInformationByHandleEx(file.as_raw_handle(), 19, storage.as_mut_ptr().cast(), (storage.len() * 8) as u32) } == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(18) {
                    break;
                }
                return Err(error);
            }
            let bytes = unsafe { std::slice::from_raw_parts(storage.as_ptr().cast::<u8>(), storage.len() * 8) };
            let mut at = 0usize;
            loop {
                let read = |offset| -> io::Result<u32> { Ok(u32::from_le_bytes(bytes.get(at + offset..at + offset + 4).ok_or_else(refused)?.try_into().unwrap())) };
                let next = read(0)? as usize;
                let attributes = read(56)?;
                let len = read(60)? as usize;
                let tag = read(68)?;
                if len % 2 != 0 {
                    return Err(refused());
                }
                let raw = bytes.get(at + 88..at + 88 + len).ok_or_else(refused)?;
                let name = OsString::from_wide(&raw.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect::<Vec<_>>());
                if name != "." && name != ".." {
                    let folder = attributes & 0x10 != 0 && (attributes & 0x400 == 0 || tag & 0x2000_0000 == 0);
                    entries.push(Ok(super::open_policy::LocalDirEntry { path: self.path.join(&name), name, is_folder: folder }));
                    if entries.len() > 20_000 {
                        return Ok(entries);
                    }
                }
                if next == 0 {
                    break;
                }
                if next < 88 || at + next >= bytes.len() {
                    return Err(refused());
                }
                at += next;
            }
        }
        Ok(entries)
    }
}

fn final_name(file: &File, flags: u32) -> io::Result<PathBuf> {
    let mut out = vec![0u16; 32768];
    let len = unsafe { GetFinalPathNameByHandleW(file.as_raw_handle(), out.as_mut_ptr(), out.len() as u32, flags) } as usize;
    if len == 0 || len >= out.len() {
        return Err(io::Error::last_os_error());
    }
    Ok(PathBuf::from(OsString::from_wide(&out[..len])))
}

fn wide(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain(Some(0)).collect()
}

fn volume_name(name: &OsStr) -> bool {
    let name = name.to_string_lossy();
    let Some(guid) = name.strip_prefix("Volume{").and_then(|s| s.strip_suffix('}')) else { return false };
    guid.len() == 36 && guid.bytes().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { c == b'-' } else { c.is_ascii_hexdigit() })
}

/// Windows removes dot segments before following links. Normalize once,
/// then open every prefix verbatim so Windows never trims a different last
/// component at each step. Ambiguous trailing dots/spaces are refused.
fn normalize(path: &Path, from_link: bool) -> io::Result<PathBuf> {
    let internal_volume = from_link && matches!(path.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Verbatim(v) if volume_name(v)));
    if !path.is_absolute() || (!internal_volume && super::open_policy::on_a_share(path)) {
        return Err(refused());
    }
    for part in path.components() {
        if let Component::Normal(name) = part {
            let chars: Vec<u16> = name.encode_wide().collect();
            if chars.last().is_some_and(|c| matches!(*c, 32 | 46)) || chars.iter().any(|c| matches!(*c, 0 | 58)) {
                return Err(refused());
            }
        }
    }
    let verbatim = matches!(path.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::VerbatimDisk(_) | Prefix::Verbatim(_)));
    if internal_volume {
        let mut normalized = PathBuf::new();
        for c in path.components() {
            match c {
                Component::ParentDir => {
                    normalized.pop();
                }
                Component::CurDir => {}
                _ => normalized.push(c),
            }
        }
        return Ok(normalized);
    }
    if verbatim && path.components().any(|c| matches!(c, Component::CurDir | Component::ParentDir)) {
        return Err(refused());
    }
    let raw = wide(path.as_os_str());
    let raw = if verbatim { &raw[4..] } else { &raw[..] };
    let mut out = vec![0u16; 32768];
    let len = unsafe { GetFullPathNameW(raw.as_ptr(), out.len() as u32, out.as_mut_ptr(), std::ptr::null_mut()) } as usize;
    if len == 0 || len >= out.len() {
        return Err(refused());
    }
    let mut extended = vec![92, 92, 63, 92]; // \\?\
    extended.extend_from_slice(&out[..len]);
    Ok(PathBuf::from(OsString::from_wide(&extended)))
}

fn walk(path: &Path, held: &mut Vec<File>, links: usize, from_link: bool) -> io::Result<PathBuf> {
    if links > 40 {
        return Err(refused());
    }
    let path = normalize(path, from_link)?;
    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else { return Err(refused()) };
    let device = match prefix.kind() {
        Prefix::VerbatimDisk(drive) => OsString::from(format!("{}:", drive as char)),
        Prefix::Verbatim(name) if from_link && volume_name(name) => name.to_owned(),
        _ => return Err(refused()),
    };
    if components.next() != Some(Component::RootDir) {
        return Err(refused());
    }
    // A mapped share is just as remote as a UNC path. Ask about the drive
    // before opening its root. Unknown and unavailable drives fail closed.
    let mut at = PathBuf::from(prefix.as_os_str());
    at.push(r"\");
    // SUBST/DefineDosDevice aliases can hide another namespace behind a
    // local-looking drive. Inspect the mapping without opening that drive.
    let mut mapping = vec![0u16; 32768];
    if unsafe { QueryDosDeviceW(wide(&device).as_ptr(), mapping.as_mut_ptr(), mapping.len() as u32) } == 0 {
        return Err(refused());
    }
    let len = mapping.iter().position(|c| *c == 0).ok_or_else(refused)?;
    let mapped = PathBuf::from(OsString::from_wide(&mapping[..len]));
    let text = mapped.to_string_lossy();
    if let Some(local) = text.strip_prefix(r"\??\") {
        let mut target = PathBuf::from(local);
        target.extend(components);
        return walk(&target, held, links + 1, false);
    }
    if !super::open_policy::is_local_volume_device(&text) {
        return Err(refused());
    }
    // Anchor opens to the checked physical volume, so redefining a DOS drive
    // letter cannot redirect a later step to a share.
    at = PathBuf::from(format!(r"\\?\GLOBALROOT{}\", text));
    if hold(&at, held)? {
        return Err(refused());
    }
    while let Some(component) = components.next() {
        match component {
            Component::CurDir => continue,
            Component::ParentDir => {
                at.pop();
                continue;
            }
            Component::Normal(name) => {
                // Alternate streams and NT namespace spellings aren't files
                // this gate can hand to another app without changing meaning.
                if name.encode_wide().any(|c| c == b':' as u16) {
                    return Err(refused());
                }
                at.push(name);
            }
            _ => return Err(refused()),
        }
        let reparse = hold(&at, held)?;
        if reparse {
            // read_link opens the reparse point itself, never its target.
            // Only name-surrogate reparse points are links. Cloud placeholders
            // and deduplicated files remain ordinary files (FileType's rule).
            let target = std::fs::read_link(&at).map_err(|_| refused())?;
            let mut target = if target.is_absolute() {
                target
            } else {
                let link = final_name(held.last().ok_or_else(refused)?, 1)?; // VOLUME_NAME_GUID
                let parent = link.parent().ok_or_else(refused)?;
                // A relative symlink target may contain `..`. Apply normal
                // Windows normalization to that substitution before walking
                // it, rather than treating it as a verbatim input path.
                let parent = if matches!(parent.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::VerbatimDisk(_))) {
                    let wide: Vec<u16> = parent.as_os_str().encode_wide().collect();
                    PathBuf::from(OsString::from_wide(&wide[4..]))
                } else {
                    parent.to_path_buf()
                };
                parent.join(target)
            };
            target.extend(components);
            return walk(&target, held, links + 1, true);
        }
    }
    // Read the checked object's name from its handle. A last-component
    // reparse-point swap must never trigger another pathname resolution.
    let file = held.last().ok_or_else(refused)?;
    final_name(file, 0).or_else(|_| final_name(file, 1))
}

fn hold(path: &Path, held: &mut Vec<File>) -> io::Result<bool> {
    // FILE_READ_DATA (LIST_DIRECTORY on a folder) | FILE_READ_ATTRIBUTES;
    // FILE_SHARE_READ | FILE_SHARE_WRITE; FILE_FLAG_OPEN_REPARSE_POINT |
    // FILE_FLAG_BACKUP_SEMANTICS (directories can be opened as handles too).
    // Attribute-only access does NOT participate in Windows sharing locks.
    let file = OpenOptions::new().access_mode(0x81).share_mode(3).custom_flags(0x0020_0000 | 0x0200_0000).open(path)?;
    let reparse = file.metadata()?.file_type().is_symlink();
    held.push(file);
    Ok(reparse)
}
