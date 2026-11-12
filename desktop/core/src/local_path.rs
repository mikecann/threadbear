// Windows must not follow a reply's symlink into an SMB share just to find
// out what it points at. Open each component without following reparse points,
// and keep its handle until resolution ends. Not sharing write or delete
// prevents a checked ancestor being replaced or retargeted during the walk.
use std::ffi::{OsStr, OsString};
use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf, Prefix};

#[link(name = "kernel32")]
extern "system" {
    fn GetDriveTypeW(root: *const u16) -> u32;
    fn GetFullPathNameW(path: *const u16, size: u32, out: *mut u16, part: *mut *mut u16) -> u32;
    fn QueryDosDeviceW(name: *const u16, out: *mut u16, size: u32) -> u32;
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
    if verbatim && path.components().any(|c| matches!(c, Component::CurDir | Component::ParentDir)) {
        return Err(refused());
    }
    if internal_volume {
        return Ok(path.to_path_buf());
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
    if !(text.starts_with(r"\Device\HarddiskVolume") || text.starts_with(r"\Device\CdRom")) {
        return Err(refused());
    }
    if !matches!(unsafe { GetDriveTypeW(wide(at.as_os_str()).as_ptr()) }, 2 | 3 | 5 | 6) {
        return Err(refused());
    }
    hold(&at, held)?;
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
                let parent = at.parent().ok_or_else(refused)?;
                // A relative symlink target may contain `..`. Apply normal
                // Windows normalization to that substitution before walking
                // it, rather than treating it as a verbatim input path.
                let parent = if matches!(parent.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::VerbatimDisk(_))) {
                    let wide: Vec<u16> = parent.as_os_str().encode_wide().collect();
                    PathBuf::from(OsString::from_wide(&wide[4..]))
                } else { parent.to_path_buf() };
                parent.join(target)
            };
            target.extend(components);
            return walk(&target, held, links + 1, true);
        }
    }
    // No unchecked link remains, and the held handles prevent one being
    // swapped in while canonicalize expands short names such as RUNNER~1.
    std::fs::canonicalize(at)
}

fn hold(path: &Path, held: &mut Vec<File>) -> io::Result<bool> {
    // FILE_READ_DATA (LIST_DIRECTORY on a folder) | FILE_READ_ATTRIBUTES;
    // FILE_SHARE_READ; FILE_FLAG_OPEN_REPARSE_POINT |
    // FILE_FLAG_BACKUP_SEMANTICS (directories can be opened as handles too).
    // Attribute-only access does NOT participate in Windows sharing locks.
    let file = OpenOptions::new().access_mode(0x81).share_mode(1).custom_flags(0x0020_0000 | 0x0200_0000).open(path)?;
    let reparse = file.metadata()?.file_type().is_symlink();
    held.push(file);
    Ok(reparse)
}
