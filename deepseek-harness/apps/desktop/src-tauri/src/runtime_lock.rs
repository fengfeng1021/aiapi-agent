//! Cross-process runtime preparation locking and abandoned-work cleanup.

use std::{
    fs,
    path::{Path, PathBuf},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use super::{runtime_install::runtime_is_ready, RuntimeProgress};

const LOCK_WAIT_LIMIT: Duration = Duration::from_secs(120);
const LOCK_POLL_INTERVAL: Duration = Duration::from_millis(250);
const OWNERLESS_ARTIFACT_GRACE: Duration = Duration::from_secs(30);

fn unique_nonce() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

fn path_age(path: &Path) -> Option<Duration> {
    fs::metadata(path).ok()?.modified().ok()?.elapsed().ok()
}

#[cfg(windows)]
fn process_is_alive(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };

    if pid == 0 {
        return false;
    }
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        // Access denied can also mean a protected but live process. Only the
        // well-known invalid-PID error is proof that the owner is gone.
        return std::io::Error::last_os_error().raw_os_error() != Some(87);
    }
    let mut exit_code = 0_u32;
    let inspected = unsafe { GetExitCodeProcess(process, &mut exit_code) } != 0;
    unsafe { CloseHandle(process) };
    inspected && exit_code == 259 // STILL_ACTIVE
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    let result = unsafe { libc::kill(pid as i32, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn parse_staging_owner(name: &str) -> Option<u32> {
    name.strip_prefix(".staging-")?
        .split('-')
        .next()?
        .parse()
        .ok()
}

fn read_lock_owner(lock: &Path) -> Option<u32> {
    let contents = fs::read_to_string(lock.join("owner")).ok()?;
    contents
        .lines()
        .find_map(|line| line.strip_prefix("pid=")?.parse().ok())
}

fn has_live_staging(runtime_root: &Path) -> bool {
    fs::read_dir(runtime_root).is_ok_and(|entries| {
        entries.filter_map(Result::ok).any(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            parse_staging_owner(&name).is_some_and(process_is_alive)
        })
    })
}

fn lock_is_abandoned(lock: &Path) -> bool {
    match read_lock_owner(lock) {
        Some(pid) => !process_is_alive(pid),
        None => {
            let has_live_legacy_owner = lock.parent().is_some_and(has_live_staging);
            !has_live_legacy_owner
                && path_age(lock).is_some_and(|age| age >= OWNERLESS_ARTIFACT_GRACE)
        }
    }
}

pub(super) fn cleanup_stale_artifacts(runtime_root: &Path) -> Result<(), String> {
    let entries = fs::read_dir(runtime_root).map_err(|error| {
        format!(
            "could not inspect runtime work directory {}: {error}",
            runtime_root.display()
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "could not inspect an entry under {}: {error}",
                runtime_root.display()
            )
        })?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("could not inspect {}: {error}", entry.path().display()))?;
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let abandoned = if name.starts_with(".lock-v") {
            lock_is_abandoned(&entry.path())
        } else if name.starts_with(".staging-") {
            match parse_staging_owner(&name) {
                Some(pid) => !process_is_alive(pid),
                None => path_age(&entry.path()).is_some_and(|age| age >= OWNERLESS_ARTIFACT_GRACE),
            }
        } else {
            false
        };
        if abandoned {
            fs::remove_dir_all(entry.path()).map_err(|error| {
                format!(
                    "could not remove abandoned runtime work directory {}: {error}",
                    entry.path().display()
                )
            })?;
        }
    }
    Ok(())
}

pub(super) struct RuntimeLock {
    path: PathBuf,
}

impl Drop for RuntimeLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn try_acquire_lock(lock: &Path) -> Result<Option<RuntimeLock>, String> {
    let runtime_root = lock
        .parent()
        .ok_or_else(|| format!("runtime lock has no parent: {}", lock.display()))?;
    let candidate = runtime_root.join(format!(
        ".staging-{}-{}-lock",
        std::process::id(),
        unique_nonce()
    ));
    fs::create_dir(&candidate).map_err(|error| {
        format!(
            "could not create runtime lock candidate {}: {error}",
            candidate.display()
        )
    })?;
    let owner = format!(
        "pid={}\ncreated_unix_ms={}\n",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    if let Err(error) = fs::write(candidate.join("owner"), owner) {
        let _ = fs::remove_dir_all(&candidate);
        return Err(format!("could not write runtime lock owner: {error}"));
    }
    match fs::rename(&candidate, lock) {
        Ok(()) => Ok(Some(RuntimeLock {
            path: lock.to_path_buf(),
        })),
        Err(_) if lock.exists() => {
            let _ = fs::remove_dir_all(&candidate);
            Ok(None)
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&candidate);
            Err(format!(
                "could not acquire runtime extraction lock {}: {error}",
                lock.display()
            ))
        }
    }
}

pub(super) fn acquire_runtime_lock(
    lock: &Path,
    target: &Path,
    expected_marker: &str,
    mut progress: impl FnMut(RuntimeProgress),
) -> Result<Option<RuntimeLock>, String> {
    let deadline = std::time::Instant::now() + LOCK_WAIT_LIMIT;
    loop {
        if runtime_is_ready(target, expected_marker) {
            return Ok(None);
        }
        if lock.exists() && lock_is_abandoned(lock) {
            fs::remove_dir_all(lock).map_err(|error| {
                format!(
                    "could not remove abandoned runtime extraction lock {}: {error}",
                    lock.display()
                )
            })?;
            continue;
        }
        if let Some(guard) = try_acquire_lock(lock)? {
            return Ok(Some(guard));
        }
        progress(RuntimeProgress::Waiting);
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "timed out waiting for the live runtime preparation owner recorded at {}; the lock was preserved to avoid corrupting concurrent installation",
                lock.display()
            ));
        }
        thread::sleep(LOCK_POLL_INTERVAL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "dsh-runtime-lock-{}-{}",
                std::process::id(),
                unique_nonce()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn removes_dead_artifacts_but_preserves_live_lock() {
        let root = TestDir::new();
        let dead_lock = root.0.join(".lock-vdead-x64");
        fs::create_dir(&dead_lock).unwrap();
        fs::write(dead_lock.join("owner"), "pid=4294967295\n").unwrap();
        let dead_staging = root.0.join(".staging-4294967295-1");
        fs::create_dir(&dead_staging).unwrap();
        let live_lock = root.0.join(".lock-vlive-x64");
        fs::create_dir(&live_lock).unwrap();
        fs::write(
            live_lock.join("owner"),
            format!("pid={}\n", std::process::id()),
        )
        .unwrap();

        cleanup_stale_artifacts(&root.0).unwrap();

        assert!(!dead_lock.exists());
        assert!(!dead_staging.exists());
        assert!(live_lock.exists());
    }
}
