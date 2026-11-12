// Windows must not follow a reply's symlink into an SMB share just to find
// out what it points at. Open each component without following reparse points,
// and keep its handle until resolution ends. Not sharing write or delete
// prevents a checked ancestor being replaced or retargeted during the walk.
use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf, Prefix};

#[link(name = "kernel32")]
extern "system" {
    fn GetDriveTypeW(root: *const u16) -> u32;
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
        let path = walk(path, &mut held, 0)?;
        Ok(Self { path, _held: held })
    }
}

fn walk(path: &Path, held: &mut Vec<File>, links: usize) -> io::Result<PathBuf> {
    if links > 40 || super::open_policy::on_a_share(path) {
        return Err(refused());
    }
    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else { return Err(refused()) };
    let drive = match prefix.kind() {
        Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => drive,
        _ => return Err(refused()),
    };
    if components.next() != Some(Component::RootDir) {
        return Err(refused());
    }
    // A mapped share is just as remote as a UNC path. Ask about the drive
    // before opening its root. Unknown and unavailable drives fail closed.
    let root = [drive as u16, b':' as u16, b'\\' as u16, 0];
    if !matches!(unsafe { GetDriveTypeW(root.as_ptr()) }, 2 | 3 | 5 | 6) {
        return Err(refused());
    }
    let mut at = PathBuf::from(prefix.as_os_str());
    at.push(r"\");
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
            // A junction is a link too; other reparse tags fail closed here.
            let target = std::fs::read_link(&at).map_err(|_| refused())?;
            let mut target = if target.is_absolute() { target } else { at.parent().ok_or_else(refused)?.join(target) };
            target.extend(components);
            return walk(&target, held, links + 1);
        }
    }
    // No unchecked link remains, and the held handles prevent one being
    // swapped in while canonicalize expands short names such as RUNNER~1.
    std::fs::canonicalize(at)
}

fn hold(path: &Path, held: &mut Vec<File>) -> io::Result<bool> {
    // FILE_READ_ATTRIBUTES; FILE_SHARE_READ; FILE_FLAG_OPEN_REPARSE_POINT |
    // FILE_FLAG_BACKUP_SEMANTICS (directories can be opened as handles too).
    let file = OpenOptions::new().access_mode(0x80).share_mode(1).custom_flags(0x0020_0000 | 0x0200_0000).open(path)?;
    let reparse = file.metadata()?.file_attributes() & 0x400 != 0;
    held.push(file);
    Ok(reparse)
}
