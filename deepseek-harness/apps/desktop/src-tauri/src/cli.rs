//! Launch the bundled interactive CLI in a user-visible native terminal.

use std::{path::Path, process::Command};

use tauri::{AppHandle, Manager};

use crate::runtime::installed_runtime_dir;

fn quoted(value: &Path) -> String {
    format!("'{}'", value.display().to_string().replace('\'', "''"))
}

fn cli_paths(app: &AppHandle) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let runtime = installed_runtime_dir(app, |_| {})?;
    let node = if cfg!(windows) {
        runtime.join("node/node.exe")
    } else {
        runtime.join("node/bin/node")
    };
    let script = runtime.join("app/cli/dsh-cli.mjs");
    if !node.is_file() || !script.is_file() {
        return Err("the bundled CLI runtime is incomplete; reinstall DeepSeek Harness".to_owned());
    }
    Ok((node, script))
}

#[cfg(windows)]
pub(super) fn launch_cli_terminal(app: &AppHandle) -> Result<(), String> {
    let (node, script) = cli_paths(app)?;
    let cwd = app
        .path()
        .document_dir()
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default());
    let has_windows_terminal = Command::new("where.exe")
        .arg("wt.exe")
        .output()
        .is_ok_and(|output| output.status.success());
    if has_windows_terminal {
        Command::new("wt.exe")
            .args(["-w", "new", "new-tab", "--title", "DeepSeek Harness CLI"])
            .arg("--startingDirectory")
            .arg(&cwd)
            .arg(&node)
            .arg(&script)
            .arg("--cwd")
            .arg(&cwd)
            .spawn()
            .map_err(|error| format!("could not open Windows Terminal: {error}"))?;
        return Ok(());
    }

    let command = format!(
        "& {} {} --cwd {}",
        quoted(&node),
        quoted(&script),
        quoted(&cwd)
    );
    Command::new("powershell.exe")
        .args(["-NoLogo", "-NoExit", "-Command"])
        .arg(command)
        .spawn()
        .map_err(|error| format!("could not open the CLI terminal: {error}"))?;
    Ok(())
}

#[cfg(target_os = "macos")]
pub(super) fn launch_cli_terminal(app: &AppHandle) -> Result<(), String> {
    let (node, script) = cli_paths(app)?;
    let cwd = app
        .path()
        .document_dir()
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default());
    let shell = format!(
        "cd {} && {} {} --cwd {}",
        quoted(&cwd),
        quoted(&node),
        quoted(&script),
        quoted(&cwd)
    );
    Command::new("osascript")
        .args([
            "-e",
            &format!("tell application \"Terminal\" to do script {shell:?}"),
        ])
        .spawn()
        .map_err(|error| format!("could not open Terminal: {error}"))?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
pub(super) fn launch_cli_terminal(app: &AppHandle) -> Result<(), String> {
    let (node, script) = cli_paths(app)?;
    let cwd = app
        .path()
        .document_dir()
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default());
    for terminal in ["x-terminal-emulator", "gnome-terminal", "konsole"] {
        let mut command = Command::new(terminal);
        if terminal == "gnome-terminal" {
            command.arg("--");
        } else {
            command.arg("-e");
        }
        match command
            .arg(&node)
            .arg(&script)
            .arg("--cwd")
            .arg(&cwd)
            .current_dir(&cwd)
            .spawn()
        {
            Ok(_) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("could not open {terminal}: {error}")),
        }
    }
    Err("no supported terminal application was found".to_owned())
}
