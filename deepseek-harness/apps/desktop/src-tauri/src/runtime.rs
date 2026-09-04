//! Safe first-launch installation of the bundled, link-aware Node.js runtime.

use std::path::{Component, Path, PathBuf};

use tauri::AppHandle;

#[path = "runtime_install.rs"]
mod runtime_install;
#[path = "runtime_lock.rs"]
mod runtime_lock;

pub(super) fn installed_runtime_dir(
    app: &AppHandle,
    progress: impl FnMut(RuntimeProgress),
) -> Result<PathBuf, String> {
    runtime_install::installed_runtime_dir(app, progress)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RuntimeProgress {
    Inspecting,
    Waiting,
    Extracting {
        compressed_bytes: u64,
        total_compressed_bytes: u64,
    },
    Linking {
        completed: usize,
        total: usize,
    },
    Retrying,
    Ready,
}

pub(super) fn safe_runtime_relative(path: &Path) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty() {
        return Err("runtime archive contains an empty path".to_owned());
    }
    let mut safe = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => safe.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!(
                    "runtime archive path escapes its root: {}",
                    path.display()
                ));
            }
        }
    }
    if safe.as_os_str().is_empty() {
        return Err("runtime archive path resolved to an empty path".to_owned());
    }
    Ok(safe)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_runtime_archive_path_traversal() {
        assert!(safe_runtime_relative(Path::new("app/lib/bin.js")).is_ok());
        assert!(safe_runtime_relative(Path::new("../outside")).is_err());
        assert!(safe_runtime_relative(Path::new("/absolute")).is_err());
    }
}
