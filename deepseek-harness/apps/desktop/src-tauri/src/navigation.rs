//! Main-window construction and strict loopback navigation policy.

use std::sync::{
    atomic::{AtomicU16, Ordering},
    Arc,
};

use tauri::{
    webview::NewWindowResponse, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

use crate::cli::launch_cli_terminal;
use crate::pet::{handle_pet_host_navigation, MAIN_PET_BRIDGE_SCRIPT};

const MAIN_WINDOW: &str = "main";

fn handle_startup_action(app: &tauri::AppHandle, action: &str) {
    match action {
        "retry" => crate::retry_startup(app.clone()),
        "diagnostics" => {
            if let Err(error) = crate::open_diagnostics(app) {
                eprintln!("dsh-desktop [diagnostics]: {error}");
            }
        }
        "quit" => app.exit(1),
        _ => eprintln!("dsh-desktop [navigation]: unknown startup action {action}"),
    }
}

pub(super) fn is_local_app_url(url: &Url, allowed_port: u16) -> bool {
    match url.scheme() {
        "tauri" => allowed_port == 0 && url.host_str() == Some("localhost"),
        "http" => {
            (url.host_str() == Some("tauri.localhost") && allowed_port == 0)
                || (url.host_str() == Some("127.0.0.1") && url.port() == Some(allowed_port))
        }
        "https" => url.host_str() == Some("tauri.localhost") && allowed_port == 0,
        "about" => allowed_port == 0 && url.as_str() == "about:blank",
        _ => false,
    }
}

pub(super) fn build_main_window(
    app: &tauri::App,
    allowed_port: Arc<AtomicU16>,
) -> tauri::Result<WebviewWindow> {
    let navigation_port = Arc::clone(&allowed_port);
    let popup_port = Arc::clone(&allowed_port);
    let cli_app = app.handle().clone();
    let pet_app = app.handle().clone();
    WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
        .title("Aiapi Agent")
        .inner_size(1180.0, 820.0)
        .min_inner_size(800.0, 600.0)
        .center()
        .visible(true)
        .initialization_script(MAIN_PET_BRIDGE_SCRIPT)
        .on_navigation(move |url| {
            if handle_pet_host_navigation(&pet_app, MAIN_WINDOW, url) {
                return false;
            }
            if url.scheme() == "dsh-action" {
                if let Some(action) = url.host_str() {
                    handle_startup_action(&cli_app, action);
                }
                return false;
            }
            if url.scheme() == "dsh-cli" && url.host_str() == Some("open") {
                if let Err(error) = launch_cli_terminal(&cli_app) {
                    eprintln!("dsh-desktop [cli]: {error}");
                    if let Some(window) = cli_app.get_webview_window(MAIN_WINDOW) {
                        let message = serde_json::to_string(&error)
                            .unwrap_or_else(|_| "\"Could not open CLI\"".to_owned());
                        let _ = window.eval(format!("window.alert({message})"));
                    }
                }
                return false;
            }
            if is_local_app_url(url, navigation_port.load(Ordering::Acquire)) {
                return true;
            }
            if matches!(url.scheme(), "http" | "https") {
                let _ = open::that_detached(url.as_str());
            }
            false
        })
        .on_new_window(move |url, _features| {
            if is_local_app_url(&url, popup_port.load(Ordering::Acquire)) {
                NewWindowResponse::Allow
            } else {
                if matches!(url.scheme(), "http" | "https") {
                    let _ = open::that_detached(url.as_str());
                }
                NewWindowResponse::Deny
            }
        })
        .build()
}
