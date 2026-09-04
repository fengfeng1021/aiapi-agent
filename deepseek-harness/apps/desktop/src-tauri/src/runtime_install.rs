//! Runtime archive validation, extraction, publication, and readiness checks.

use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use flate2::read::GzDecoder;
use serde::Deserialize;
use tar::{Archive, EntryType};
use tauri::{AppHandle, Manager};

use super::{
    runtime_lock::{acquire_runtime_lock, cleanup_stale_artifacts},
    safe_runtime_relative, RuntimeProgress,
};

#[derive(Debug, Deserialize)]
struct RuntimeLink {
    path: String,
    target: String,
}

fn required_file(path: &Path, label: &str, problems: &mut Vec<String>) {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => problems.push(format!("{label} is not a file: {}", path.display())),
        Err(error) => problems.push(format!(
            "{label} cannot be read at {}: {error}",
            path.display()
        )),
    }
}

fn required_directory(path: &Path, label: &str, problems: &mut Vec<String>) {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => problems.push(format!("{label} is not a directory: {}", path.display())),
        Err(error) => problems.push(format!(
            "{label} cannot be read at {}: {error}",
            path.display()
        )),
    }
}

/// Return every concrete path that prevents this installation from being used.
fn runtime_readiness_error(runtime_dir: &Path, expected_marker: Option<&str>) -> Option<String> {
    let mut problems = Vec::new();
    match fs::metadata(runtime_dir) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => {
            return Some(format!(
                "runtime path is not a directory: {}",
                runtime_dir.display()
            ))
        }
        Err(error) => {
            return Some(format!(
                "runtime directory cannot be read at {}: {error}",
                runtime_dir.display()
            ))
        }
    }

    let node = if cfg!(windows) {
        runtime_dir.join("node/node.exe")
    } else {
        runtime_dir.join("node/bin/node")
    };
    let manifest = runtime_dir.join("manifest.json");
    let links = runtime_dir.join("links.json");
    required_file(&node, "bundled Node executable", &mut problems);
    required_file(
        &runtime_dir.join("app/node_modules/@deepseek-ai/dsh/lib/bin.js"),
        "DeepSeek Harness CLI entrypoint",
        &mut problems,
    );
    required_file(
        &runtime_dir.join("app/node_modules/pnpm/bin/pnpm.cjs"),
        "bundled pnpm entrypoint",
        &mut problems,
    );
    required_file(&manifest, "runtime manifest", &mut problems);
    required_file(&links, "runtime link manifest", &mut problems);

    if manifest.is_file() {
        if let Err(error) = File::open(&manifest)
            .map_err(|error| error.to_string())
            .and_then(|file| {
                serde_json::from_reader::<_, serde_json::Value>(file)
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            })
        {
            problems.push(format!(
                "runtime manifest is not valid JSON at {}: {error}",
                manifest.display()
            ));
        }
    }
    if links.is_file() {
        match File::open(&links)
            .map_err(|error| error.to_string())
            .and_then(|file| {
                serde_json::from_reader::<_, Vec<RuntimeLink>>(file)
                    .map_err(|error| error.to_string())
            }) {
            Ok(runtime_links) => {
                for runtime_link in runtime_links {
                    let link = safe_runtime_relative(Path::new(&runtime_link.path));
                    let target = safe_runtime_relative(Path::new(&runtime_link.target));
                    match (link, target) {
                        (Ok(link), Ok(target)) => {
                            let link = runtime_dir.join(link);
                            let target = runtime_dir.join(target);
                            required_directory(&target, "runtime link target", &mut problems);
                            required_directory(&link, "materialized runtime link", &mut problems);
                        }
                        (Err(error), _) | (_, Err(error)) => problems.push(format!(
                            "runtime link manifest contains an unsafe path at {}: {error}",
                            links.display()
                        )),
                    }
                }
            }
            Err(error) => problems.push(format!(
                "runtime link manifest is not valid JSON at {}: {error}",
                links.display()
            )),
        }
    }

    if let Some(expected_marker) = expected_marker {
        let marker = runtime_dir.join(".ready");
        match fs::read_to_string(&marker) {
            Ok(contents) if contents == expected_marker => {}
            Ok(_) => problems.push(format!(
                "runtime readiness marker does not match the bundled runtime fingerprint: {}",
                marker.display(),
            )),
            Err(error) => problems.push(format!(
                "runtime readiness marker is missing or unreadable at {}: {error}",
                marker.display()
            )),
        }
    }

    (!problems.is_empty()).then(|| problems.join("; "))
}

pub(super) fn runtime_is_ready(runtime_dir: &Path, expected_marker: &str) -> bool {
    runtime_readiness_error(runtime_dir, Some(expected_marker)).is_none()
}

fn wait_for_runtime_readiness(
    runtime_dir: &Path,
    expected_marker: Option<&str>,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match runtime_readiness_error(runtime_dir, expected_marker) {
            None => return Ok(()),
            Some(_) if std::time::Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(100));
            }
            Some(error) => return Err(error),
        }
    }
}

#[cfg(windows)]
fn create_runtime_link(target: &Path, link: &Path) -> std::io::Result<()> {
    junction::create(target, link)
}

#[cfg(unix)]
fn create_runtime_link(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

fn ensure_supported_entry_type(path: &Path, entry_type: EntryType) -> Result<(), String> {
    if entry_type.is_file() || entry_type.is_dir() {
        return Ok(());
    }
    Err(format!(
        "runtime archive contains unsupported entry type 0x{:02x} at {}; only files and directories are allowed",
        entry_type.as_byte(),
        path.display()
    ))
}

struct ProgressReader<'a, R> {
    inner: R,
    bytes_read: u64,
    total_bytes: u64,
    last_percent: Option<u64>,
    report: &'a mut dyn FnMut(u64, u64),
}

impl<R: Read> Read for ProgressReader<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.bytes_read = self.bytes_read.saturating_add(read as u64);
        let percent = if self.total_bytes == 0 {
            100
        } else {
            ((self.bytes_read as u128 * 100) / self.total_bytes as u128) as u64
        };
        if self.last_percent != Some(percent) {
            self.last_percent = Some(percent);
            (self.report)(self.bytes_read, self.total_bytes);
        }
        Ok(read)
    }
}

fn unpack_runtime(
    archive_path: &Path,
    destination: &Path,
    mut progress: impl FnMut(u64, u64),
) -> Result<(), String> {
    let archive_file = File::open(archive_path).map_err(|error| {
        format!(
            "could not open the bundled runtime archive {}: {error}",
            archive_path.display()
        )
    })?;
    let compressed_bytes = archive_file
        .metadata()
        .map_err(|error| format!("could not inspect {}: {error}", archive_path.display()))?
        .len();
    progress(0, compressed_bytes);
    let reader = ProgressReader {
        inner: archive_file,
        bytes_read: 0,
        total_bytes: compressed_bytes,
        last_percent: Some(0),
        report: &mut progress,
    };
    let mut archive = Archive::new(GzDecoder::new(reader));
    let entries = archive
        .entries()
        .map_err(|error| format!("could not read the bundled runtime archive: {error}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|error| format!("invalid runtime archive entry: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("invalid runtime archive path: {error}"))?
            .into_owned();
        let safe_path = safe_runtime_relative(&path)?;
        if safe_path == Path::new(".ready")
            || safe_path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with(".ready.tmp-"))
        {
            return Err(format!(
                "runtime archive attempts to publish a reserved readiness marker: {}",
                path.display()
            ));
        }
        ensure_supported_entry_type(&path, entry.header().entry_type())?;
        let unpacked = entry
            .unpack_in(destination)
            .map_err(|error| format!("could not extract {}: {error}", path.display()))?;
        if !unpacked {
            return Err(format!(
                "runtime archive entry escaped its destination: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

fn materialize_runtime_links(
    destination: &Path,
    mut progress: impl FnMut(usize, usize),
) -> Result<(), String> {
    let links_path = destination.join("links.json");
    let links: Vec<RuntimeLink> = serde_json::from_reader(
        File::open(&links_path)
            .map_err(|error| format!("could not open {}: {error}", links_path.display()))?,
    )
    .map_err(|error| format!("could not parse {}: {error}", links_path.display()))?;
    let total = links.len();
    let mut last_bucket = 0;
    progress(0, total);
    for (index, runtime_link) in links.into_iter().enumerate() {
        let safe_link = safe_runtime_relative(Path::new(&runtime_link.path))?;
        if safe_link == Path::new(".ready") {
            return Err(format!(
                "runtime link manifest attempts to publish the reserved readiness marker: {}",
                runtime_link.path
            ));
        }
        let link = destination.join(safe_link);
        let target = destination.join(safe_runtime_relative(Path::new(&runtime_link.target))?);
        if !target.is_dir() {
            return Err(format!(
                "runtime link target is missing or is not a directory: {} (declared by {})",
                target.display(),
                links_path.display()
            ));
        }
        if link.exists() {
            return Err(format!(
                "runtime link path already exists instead of being materialized: {}",
                link.display()
            ));
        }
        if let Some(parent) = link.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "could not create runtime link parent {}: {error}",
                    parent.display()
                )
            })?;
        }
        create_runtime_link(&target, &link).map_err(|error| {
            format!(
                "could not create runtime link {} -> {}: {error}",
                link.display(),
                target.display()
            )
        })?;
        let completed = index + 1;
        let bucket = if total == 0 {
            10
        } else {
            completed.saturating_mul(10) / total
        };
        if bucket > last_bucket || completed == total {
            last_bucket = bucket;
            progress(completed, total);
        }
    }
    Ok(())
}

fn unique_nonce() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

fn write_ready_marker_atomic(destination: &Path, marker_contents: &str) -> Result<(), String> {
    let marker = destination.join(".ready");
    let temporary = destination.join(format!(
        ".ready.tmp-{}-{}",
        std::process::id(),
        unique_nonce()
    ));
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| {
                format!(
                    "could not create temporary runtime readiness marker {}: {error}",
                    temporary.display()
                )
            })?;
        file.write_all(marker_contents.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|error| {
                format!(
                    "could not persist temporary runtime readiness marker {}: {error}",
                    temporary.display()
                )
            })?;
        fs::rename(&temporary, &marker).map_err(|error| {
            format!(
                "could not atomically publish runtime readiness marker {}: {error}",
                marker.display()
            )
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn remove_incomplete_target(target: &Path) -> Result<(), String> {
    if !target.exists() {
        return Ok(());
    }
    fs::remove_dir_all(target).map_err(|error| {
        format!(
            "could not replace incomplete runtime {}: {error}",
            target.display()
        )
    })
}

fn runtime_ready_marker(fingerprint_path: &Path) -> Result<String, String> {
    let raw = fs::read_to_string(fingerprint_path).map_err(|error| {
        format!(
            "bundled runtime fingerprint is missing or unreadable at {}: {error}",
            fingerprint_path.display()
        )
    })?;
    let fingerprint = raw.trim();
    if fingerprint.len() != 64 || !fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!(
            "bundled runtime fingerprint is not a SHA-256 value at {}",
            fingerprint_path.display()
        ));
    }
    Ok(format!(
        "ready-sha256:{}\n",
        fingerprint.to_ascii_lowercase()
    ))
}

fn prepare_runtime_once(
    archive_path: &Path,
    runtime_root: &Path,
    target: &Path,
    ready_marker: &str,
    mut progress: impl FnMut(RuntimeProgress),
) -> Result<(), String> {
    remove_incomplete_target(target)?;
    let staging = runtime_root.join(format!(
        ".staging-{}-{}",
        std::process::id(),
        unique_nonce()
    ));
    fs::create_dir(&staging).map_err(|error| {
        format!(
            "could not create runtime staging directory {}: {error}",
            staging.display()
        )
    })?;

    let preparation = (|| -> Result<(), String> {
        unpack_runtime(archive_path, &staging, |compressed_bytes, total| {
            progress(RuntimeProgress::Extracting {
                compressed_bytes,
                total_compressed_bytes: total,
            });
        })?;
        fs::rename(&staging, target).map_err(|error| {
            format!(
                "could not publish extracted runtime {} -> {}: {error}",
                staging.display(),
                target.display()
            )
        })?;
        materialize_runtime_links(target, |completed, total| {
            progress(RuntimeProgress::Linking { completed, total });
        })?;
        wait_for_runtime_readiness(target, None, Duration::from_secs(5)).map_err(|error| {
            format!("published runtime payload failed its readiness check: {error}")
        })?;
        // This is intentionally the final filesystem write. Readers never
        // accept a partially linked or only partly validated runtime.
        write_ready_marker_atomic(target, ready_marker)?;
        wait_for_runtime_readiness(target, Some(ready_marker), Duration::from_secs(1)).map_err(
            |error| format!("published runtime failed its final readiness check: {error}"),
        )?;
        Ok(())
    })();

    if preparation.is_err() {
        let _ = remove_incomplete_target(target);
        if staging.exists() {
            let _ = fs::remove_dir_all(&staging);
        }
    }
    preparation
}

pub(super) fn installed_runtime_dir(
    app: &AppHandle,
    mut progress: impl FnMut(RuntimeProgress),
) -> Result<PathBuf, String> {
    progress(RuntimeProgress::Inspecting);
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("could not resolve the application resources: {error}"))?;
    let archive_path = resource_dir.join("runtime.tar.gz");
    if !archive_path.is_file() {
        return Err(format!(
            "bundled runtime archive is missing at {}",
            archive_path.display()
        ));
    }
    let ready_marker = runtime_ready_marker(&resource_dir.join("runtime.tar.gz.sha256"))?;

    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("could not resolve the application data directory: {error}"))?;
    let runtime_root = data_dir.join("runtime");
    fs::create_dir_all(&runtime_root).map_err(|error| {
        format!(
            "could not create runtime directory {}: {error}",
            runtime_root.display()
        )
    })?;
    cleanup_stale_artifacts(&runtime_root)?;

    let target = runtime_root.join(format!(
        "v{}-{}",
        app.package_info().version,
        std::env::consts::ARCH
    ));
    if runtime_is_ready(&target, &ready_marker) {
        progress(RuntimeProgress::Ready);
        return Ok(target);
    }

    let lock = runtime_root.join(format!(
        ".lock-v{}-{}",
        app.package_info().version,
        std::env::consts::ARCH
    ));
    let Some(_lock_guard) =
        acquire_runtime_lock(&lock, &target, &ready_marker, |state| progress(state))?
    else {
        progress(RuntimeProgress::Ready);
        return Ok(target);
    };

    if runtime_is_ready(&target, &ready_marker) {
        progress(RuntimeProgress::Ready);
        return Ok(target);
    }

    let mut failures = Vec::new();
    for attempt in 0..=1 {
        if attempt == 1 {
            progress(RuntimeProgress::Retrying);
            thread::sleep(Duration::from_millis(150));
        }
        match prepare_runtime_once(
            &archive_path,
            &runtime_root,
            &target,
            &ready_marker,
            |state| progress(state),
        ) {
            Ok(()) => {
                progress(RuntimeProgress::Ready);
                return Ok(target);
            }
            Err(error) => failures.push(error),
        }
    }

    Err(format!(
        "bundled runtime preparation failed and one automatic rebuild also failed. First attempt: {}. Rebuild attempt: {}",
        failures.first().map(String::as_str).unwrap_or("unknown error"),
        failures.get(1).map(String::as_str).unwrap_or("unknown error")
    ))
}

#[cfg(test)]
#[path = "runtime_install_tests.rs"]
mod tests;
