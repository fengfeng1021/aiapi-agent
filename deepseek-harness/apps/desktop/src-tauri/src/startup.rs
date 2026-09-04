//! Bilingual first-launch status surface driven by real host milestones.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Manager, WebviewWindow};

use crate::runtime::RuntimeProgress;

const INITIALIZATION_MARKER: &str = "initialization.ready";

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|error| format!("could not resolve the application data directory: {error}"))
}

fn marker_is_ready(path: &Path) -> bool {
    matches!(fs::read(path), Ok(contents) if contents == b"ready\n")
}

pub(super) fn initialization_completed(app: &AppHandle) -> bool {
    let Ok(data) = app_data_dir(app) else {
        return false;
    };
    if marker_is_ready(&data.join(INITIALIZATION_MARKER)) {
        return true;
    }

    let legacy_runtime = data.join("runtime").join(format!(
        "v{}-{}",
        app.package_info().version,
        std::env::consts::ARCH
    ));
    marker_is_ready(&legacy_runtime.join(".ready"))
}

fn write_initialization_marker_atomic(data: &Path) -> Result<(), String> {
    fs::create_dir_all(data)
        .map_err(|error| format!("could not create {}: {error}", data.display()))?;
    let marker = data.join(INITIALIZATION_MARKER);
    if marker_is_ready(&marker) {
        return Ok(());
    }

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = data.join(format!(
        ".{INITIALIZATION_MARKER}.tmp-{}-{nonce}",
        std::process::id()
    ));
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| {
                format!(
                    "could not create temporary initialization marker {}: {error}",
                    temporary.display()
                )
            })?;
        file.write_all(b"ready\n")
            .and_then(|_| file.sync_all())
            .map_err(|error| {
                format!(
                    "could not persist temporary initialization marker {}: {error}",
                    temporary.display()
                )
            })?;
        if marker.exists() {
            fs::remove_file(&marker).map_err(|error| {
                format!(
                    "could not replace invalid initialization marker {}: {error}",
                    marker.display()
                )
            })?;
        }
        fs::rename(&temporary, &marker).map_err(|error| {
            format!(
                "could not publish initialization marker {}: {error}",
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

pub(super) fn mark_initialization_complete(app: &AppHandle) -> Result<(), String> {
    write_initialization_marker_atomic(&app_data_dir(app)?)
}

fn error_category(message: &str) -> &'static str {
    let lower = message.to_ascii_lowercase();
    if lower.contains("448")
        || lower.contains("untrusted mount")
        || lower.contains("permission denied")
        || lower.contains("access is denied")
    {
        "security"
    } else if lower.contains("disk full") || lower.contains("not enough space") {
        "storage"
    } else if lower.contains("archive") || lower.contains("checksum") || lower.contains("missing") {
        "package"
    } else if lower.contains("timed out") || lower.contains("within 60 seconds") {
        "timeout"
    } else {
        "general"
    }
}

pub(super) fn diagnostics_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let data = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("could not resolve diagnostics directory: {error}"))?;
    Ok(data.join("diagnostics"))
}

fn write_diagnostics(window: &WebviewWindow, message: &str) -> String {
    let package = window.app_handle().package_info();
    let diagnostics = format!(
        "DeepSeek Harness startup diagnostics\nversion: {}\nos: {}\narch: {}\ntime: {:?}\nruntime root: {}\n\n{}\n",
        package.version,
        std::env::consts::OS,
        std::env::consts::ARCH,
        SystemTime::now(),
        window
            .app_handle()
            .path()
            .app_local_data_dir()
            .map(|path| path.join("runtime").display().to_string())
            .unwrap_or_else(|error| format!("unavailable: {error}")),
        redact_diagnostics(message),
    );
    if let Ok(directory) = diagnostics_dir(window.app_handle()) {
        let _ = fs::create_dir_all(&directory);
        let _ = fs::write(directory.join("startup-latest.txt"), diagnostics.as_bytes());
    }
    diagnostics
}

fn redact_diagnostics(message: &str) -> String {
    message
        .lines()
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            if ["authorization", "api_key", "apikey", "token=", "bearer "]
                .iter()
                .any(|needle| lower.contains(needle))
            {
                "[redacted potentially sensitive log line]"
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn show_startup_error(window: &WebviewWindow, message: String) {
    eprintln!("dsh-desktop [host]: {message}");
    let category = error_category(&message);
    let diagnostics = write_diagnostics(window, &message);
    let payload = serde_json::json!({
        "message": &message,
        "category": category,
        "diagnostics": diagnostics,
    });
    let _ = window.eval(&format!("window.__dshDesktopStartupError({payload})"));
    let _ = window.show();
    let _ = window.set_focus();
}

pub(super) fn open_diagnostics_path(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("could not create {}: {error}", path.display()))?;
    open::that_detached(path).map_err(|error| format!("could not open {}: {error}", path.display()))
}

pub(super) fn show_startup_progress(window: &WebviewWindow, value: u8, zh: &str, en: &str) {
    let payload = serde_json::json!({ "value": value, "zh": zh, "en": en });
    let _ = window.eval(&format!("window.__dshDesktopStartupProgress({payload})"));
}

pub(super) fn show_runtime_progress(window: &WebviewWindow, progress: RuntimeProgress) {
    let (value, zh, en) = match progress {
        RuntimeProgress::Inspecting => (
            12,
            "正在检测系统与应用环境…",
            "Checking the system and application environment…",
        ),
        RuntimeProgress::Waiting => (
            24,
            "正在等待另一项环境配置完成…",
            "Waiting for another environment setup to finish…",
        ),
        RuntimeProgress::Extracting {
            compressed_bytes,
            total_compressed_bytes,
        } => {
            let ratio = if total_compressed_bytes == 0 {
                1.0
            } else {
                compressed_bytes as f64 / total_compressed_bytes as f64
            };
            let value = (28.0 + ratio.clamp(0.0, 1.0) * 42.0).round() as u8;
            (
                value,
                "正在解压内置运行环境（无需联网下载）…",
                "Extracting the bundled runtime (no download required)…",
            )
        }
        RuntimeProgress::Linking { completed, total } => {
            let ratio = if total == 0 {
                1.0
            } else {
                completed as f64 / total as f64
            };
            let value = (72.0 + ratio.clamp(0.0, 1.0) * 10.0).round() as u8;
            (
                value,
                "正在恢复可扩展组件与工作区链接…",
                "Restoring extensible component and workspace links…",
            )
        }
        RuntimeProgress::Retrying => (
            27,
            "检测到运行环境不完整，正在自动重建…",
            "The runtime is incomplete. Rebuilding it automatically…",
        ),
        RuntimeProgress::Ready => (
            84,
            "运行环境检测完成。",
            "Runtime environment check completed.",
        ),
    };
    show_startup_progress(window, value, zh, en);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_actionable_startup_failures() {
        assert_eq!(
            error_category("os error 448: untrusted mount point"),
            "security"
        );
        assert_eq!(
            error_category("runtime archive checksum mismatch"),
            "package"
        );
        assert_eq!(error_category("service timed out"), "timeout");
    }

    #[test]
    fn removes_potential_credentials_from_diagnostics() {
        let redacted = redact_diagnostics("safe line\nAuthorization: Bearer secret\nAPI_KEY=value");
        assert!(redacted.contains("safe line"));
        assert!(!redacted.contains("secret"));
        assert!(!redacted.contains("value"));
    }

    #[test]
    fn atomically_publishes_only_the_completed_initialization_marker() {
        let directory = std::env::temp_dir().join(format!(
            "dsh-desktop-startup-marker-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir(&directory).unwrap();
        let marker = directory.join(INITIALIZATION_MARKER);
        fs::write(&marker, b"incomplete\n").unwrap();
        assert!(!marker_is_ready(&marker));
        write_initialization_marker_atomic(&directory).unwrap();
        assert!(marker_is_ready(&marker));
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_dir_all(directory).unwrap();
    }
}
