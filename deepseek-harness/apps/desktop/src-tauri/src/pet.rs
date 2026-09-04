//! Independent desktop-pet window and its deliberately narrow host bridge.

use std::sync::{
    atomic::{AtomicU16, Ordering},
    Arc,
};

use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::navigation::is_local_app_url;

pub(super) const PET_WINDOW_LABEL: &str = "pet";

const PET_INITIAL_WIDTH_CSS: f64 = 260.0;
const PET_INITIAL_HEIGHT_CSS: f64 = 220.0;
const PET_MIN_WIDTH_CSS: f64 = 160.0;
const PET_MIN_HEIGHT_CSS: f64 = 160.0;
const PET_MAX_WIDTH_CSS: f64 = 640.0;
const PET_MAX_HEIGHT_CSS: f64 = 560.0;
const PET_EDGE_MARGIN_CSS: f64 = 12.0;
const PET_MIN_VISIBLE_CSS: f64 = 48.0;
const PET_MAX_MOVE_CSS: f64 = 4096.0;

/// The main page only needs to turn the independent host on or off. Keeping a
/// separate bridge prevents it from acquiring drag, resize, or hit-test control.
pub(super) const MAIN_PET_BRIDGE_SCRIPT: &str = r#"
(() => {
  const navigate = (action, values = {}) => {
    const url = new URL(`dsh-pet://${action}`);
    for (const [key, value] of Object.entries(values)) url.searchParams.set(key, String(value));
    window.location.assign(url.href);
  };
  const api = Object.freeze({
    version: 1,
    role: 'main',
    setVisible(visible) {
      navigate('set-visible', { visible: visible === true });
    },
  });
  try { Object.defineProperty(window, '__DSH_PET_HOST__', { value: api, configurable: false }); }
  catch (_) { /* A frozen bridge from an earlier initialization remains authoritative. */ }
})();
"#;

/// This is an application-owned API, not the Tauri global API. Every operation
/// is validated again by Rust and the navigation itself is always denied.
const PET_BRIDGE_SCRIPT: &str = r#"
(() => {
  const finite = (value) => Number.isFinite(Number(value));
  const navigate = (action, values = {}) => {
    const url = new URL(`dsh-pet://${action}`);
    for (const [key, value] of Object.entries(values)) url.searchParams.set(key, String(value));
    window.location.assign(url.href);
  };
  const api = Object.freeze({
    version: 1,
    role: 'pet',
    beginDrag() {
      navigate('begin-drag');
    },
    moveBy(deltaX, deltaY) {
      if (!finite(deltaX) || !finite(deltaY)) return false;
      navigate('move-by', { dx: Number(deltaX), dy: Number(deltaY) });
      return true;
    },
    resizeTo(width, height) {
      if (!finite(width) || !finite(height)) return false;
      navigate('resize-to', { width: Number(width), height: Number(height) });
      return true;
    },
    setVisible(visible) {
      navigate('set-visible', { visible: visible === true });
    },
    setInputPassthrough(passthrough) {
      navigate('set-input-passthrough', { passthrough: passthrough === true });
    },
  });
  try { Object.defineProperty(window, '__DSH_PET_HOST__', { value: api, configurable: false }); }
  catch (_) { /* A frozen bridge from an earlier initialization remains authoritative. */ }
})();
"#;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Rect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl Rect {
    fn right(self) -> i64 {
        i64::from(self.x) + i64::from(self.width)
    }

    fn bottom(self) -> i64 {
        i64::from(self.y) + i64::from(self.height)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum PetHostAction {
    BeginDrag,
    MoveBy { dx: f64, dy: f64 },
    ResizeTo { width: f64, height: f64 },
    SetVisible(bool),
    SetInputPassthrough(bool),
}

fn parse_number(url: &Url, name: &str) -> Result<f64, String> {
    let value = url
        .query_pairs()
        .find_map(|(key, value)| (key == name).then_some(value.into_owned()))
        .ok_or_else(|| format!("pet host action is missing {name}"))?;
    let number = value
        .parse::<f64>()
        .map_err(|_| format!("pet host action has an invalid {name}"))?;
    if number.is_finite() {
        Ok(number)
    } else {
        Err(format!("pet host action has a non-finite {name}"))
    }
}

fn parse_bool(url: &Url, name: &str) -> Result<bool, String> {
    match url
        .query_pairs()
        .find_map(|(key, value)| (key == name).then_some(value.into_owned()))
        .as_deref()
    {
        Some("true") => Ok(true),
        Some("false") => Ok(false),
        _ => Err(format!("pet host action has an invalid {name}")),
    }
}

fn parse_pet_host_action(url: &Url, caller_label: &str) -> Result<PetHostAction, String> {
    if url.scheme() != "dsh-pet" {
        return Err("not a pet host action".to_owned());
    }
    let action = url
        .host_str()
        .ok_or_else(|| "pet host action has no name".to_owned())?;
    match action {
        "set-visible" if matches!(caller_label, "main" | PET_WINDOW_LABEL) => {
            Ok(PetHostAction::SetVisible(parse_bool(url, "visible")?))
        }
        "begin-drag" if caller_label == PET_WINDOW_LABEL => Ok(PetHostAction::BeginDrag),
        "move-by" if caller_label == PET_WINDOW_LABEL => {
            let dx = parse_number(url, "dx")?;
            let dy = parse_number(url, "dy")?;
            if dx.abs() > PET_MAX_MOVE_CSS || dy.abs() > PET_MAX_MOVE_CSS {
                return Err("pet host move exceeds the per-request limit".to_owned());
            }
            Ok(PetHostAction::MoveBy { dx, dy })
        }
        "resize-to" if caller_label == PET_WINDOW_LABEL => Ok(PetHostAction::ResizeTo {
            width: parse_number(url, "width")?,
            height: parse_number(url, "height")?,
        }),
        "set-input-passthrough" if caller_label == PET_WINDOW_LABEL => Ok(
            PetHostAction::SetInputPassthrough(parse_bool(url, "passthrough")?),
        ),
        _ => Err(format!(
            "pet host action {action} is not allowed from window {caller_label}"
        )),
    }
}

fn css_to_physical(value: f64, scale_factor: f64) -> u32 {
    (value * scale_factor).round().clamp(1.0, u32::MAX as f64) as u32
}

fn clamp_axis(value: i64, size: u32, area_start: i32, area_size: u32) -> i32 {
    let minimum = i64::from(area_start);
    let maximum = minimum + i64::from(area_size.saturating_sub(size));
    value
        .clamp(minimum, maximum)
        .clamp(i32::MIN as i64, i32::MAX as i64) as i32
}

fn fit_inside_area(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    area: Rect,
) -> PhysicalPosition<i32> {
    PhysicalPosition::new(
        clamp_axis(i64::from(position.x), size.width, area.x, area.width),
        clamp_axis(i64::from(position.y), size.height, area.y, area.height),
    )
}

fn intersection_size(window: Rect, area: Rect) -> (u32, u32) {
    let width = (window.right().min(area.right()) - i64::from(window.x).max(i64::from(area.x)))
        .max(0) as u32;
    let height = (window.bottom().min(area.bottom()) - i64::from(window.y).max(i64::from(area.y)))
        .max(0) as u32;
    (width, height)
}

fn squared_distance_to_rect(center_x: i64, center_y: i64, area: Rect) -> i128 {
    let nearest_x = center_x.clamp(i64::from(area.x), area.right());
    let nearest_y = center_y.clamp(i64::from(area.y), area.bottom());
    let dx = i128::from(center_x - nearest_x);
    let dy = i128::from(center_y - nearest_y);
    dx * dx + dy * dy
}

/// Preserve a usable hit target on at least one monitor without pinning the pet
/// to one display. This permits smooth movement across adjacent mixed-DPI screens.
fn keep_visible_on_some_monitor(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    work_areas: &[Rect],
    minimum_visible: u32,
) -> PhysicalPosition<i32> {
    if work_areas.is_empty() {
        return position;
    }
    let window = Rect {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    let required_width = minimum_visible.min(size.width);
    let required_height = minimum_visible.min(size.height);
    if work_areas.iter().any(|area| {
        let (width, height) = intersection_size(window, *area);
        width >= required_width && height >= required_height
    }) {
        return position;
    }

    let center_x = i64::from(position.x) + i64::from(size.width) / 2;
    let center_y = i64::from(position.y) + i64::from(size.height) / 2;
    let area = *work_areas
        .iter()
        .min_by_key(|area| squared_distance_to_rect(center_x, center_y, **area))
        .expect("work areas were checked as non-empty");
    let minimum_x = i64::from(area.x) - i64::from(size.width) + i64::from(required_width);
    let maximum_x = area.right() - i64::from(required_width);
    let minimum_y = i64::from(area.y) - i64::from(size.height) + i64::from(required_height);
    let maximum_y = area.bottom() - i64::from(required_height);
    PhysicalPosition::new(
        i64::from(position.x)
            .clamp(minimum_x, maximum_x)
            .clamp(i32::MIN as i64, i32::MAX as i64) as i32,
        i64::from(position.y)
            .clamp(minimum_y, maximum_y)
            .clamp(i32::MIN as i64, i32::MAX as i64) as i32,
    )
}

fn monitor_work_areas(window: &WebviewWindow) -> Result<Vec<Rect>, String> {
    window
        .available_monitors()
        .map_err(|error| format!("could not inspect desktop monitor bounds: {error}"))
        .map(|monitors| {
            monitors
                .into_iter()
                .map(|monitor| {
                    let area = monitor.work_area();
                    Rect {
                        x: area.position.x,
                        y: area.position.y,
                        width: area.size.width,
                        height: area.size.height,
                    }
                })
                .collect()
        })
}

fn current_work_area(window: &WebviewWindow) -> Result<Option<Rect>, String> {
    window
        .current_monitor()
        .map_err(|error| format!("could not inspect the pet monitor: {error}"))
        .map(|monitor| {
            monitor.map(|monitor| {
                let area = monitor.work_area();
                Rect {
                    x: area.position.x,
                    y: area.position.y,
                    width: area.size.width,
                    height: area.size.height,
                }
            })
        })
}

fn move_pet_by(window: &WebviewWindow, dx: f64, dy: f64) -> Result<(), String> {
    let scale = window
        .scale_factor()
        .map_err(|error| format!("could not read the pet window scale factor: {error}"))?;
    let position = window
        .outer_position()
        .map_err(|error| format!("could not read the pet window position: {error}"))?;
    let size = window
        .outer_size()
        .map_err(|error| format!("could not read the pet window size: {error}"))?;
    let target = PhysicalPosition::new(
        (f64::from(position.x) + dx * scale)
            .round()
            .clamp(i32::MIN as f64, i32::MAX as f64) as i32,
        (f64::from(position.y) + dy * scale)
            .round()
            .clamp(i32::MIN as f64, i32::MAX as f64) as i32,
    );
    let work_areas = monitor_work_areas(window)?;
    let target = keep_visible_on_some_monitor(
        target,
        size,
        &work_areas,
        css_to_physical(PET_MIN_VISIBLE_CSS, scale),
    );
    window
        .set_position(target)
        .map_err(|error| format!("could not move the pet window: {error}"))
}

fn resize_pet_to(window: &WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    let scale = window
        .scale_factor()
        .map_err(|error| format!("could not read the pet window scale factor: {error}"))?;
    let requested = PhysicalSize::new(
        css_to_physical(width.clamp(PET_MIN_WIDTH_CSS, PET_MAX_WIDTH_CSS), scale),
        css_to_physical(height.clamp(PET_MIN_HEIGHT_CSS, PET_MAX_HEIGHT_CSS), scale),
    );
    let old_position = window
        .outer_position()
        .map_err(|error| format!("could not read the pet window position: {error}"))?;
    let old_size = window
        .outer_size()
        .map_err(|error| format!("could not read the pet window size: {error}"))?;
    let mut size = requested;
    if let Some(area) = current_work_area(window)? {
        size.width = size.width.min(area.width);
        size.height = size.height.min(area.height);
        // Keep the lower-right content anchor stable so an expanding reply bubble
        // grows up and left instead of making the character jump.
        let anchored = PhysicalPosition::new(
            (i64::from(old_position.x) + i64::from(old_size.width) - i64::from(size.width))
                .clamp(i32::MIN as i64, i32::MAX as i64) as i32,
            (i64::from(old_position.y) + i64::from(old_size.height) - i64::from(size.height))
                .clamp(i32::MIN as i64, i32::MAX as i64) as i32,
        );
        window
            .set_position(fit_inside_area(anchored, size, area))
            .map_err(|error| format!("could not keep the resized pet on screen: {error}"))?;
    }
    window
        .set_size(size)
        .map_err(|error| format!("could not resize the pet window: {error}"))
}

fn apply_pet_action(app: &AppHandle, action: PetHostAction) -> Result<(), String> {
    let window = app
        .get_webview_window(PET_WINDOW_LABEL)
        .ok_or_else(|| "pet window is not available".to_owned())?;
    match action {
        PetHostAction::BeginDrag => window
            .start_dragging()
            .map_err(|error| format!("could not start native pet dragging: {error}")),
        PetHostAction::MoveBy { dx, dy } => move_pet_by(&window, dx, dy),
        PetHostAction::ResizeTo { width, height } => resize_pet_to(&window, width, height),
        PetHostAction::SetVisible(true) => window
            .show()
            .map_err(|error| format!("could not show the pet window: {error}")),
        PetHostAction::SetVisible(false) => window
            .hide()
            .map_err(|error| format!("could not hide the pet window: {error}")),
        PetHostAction::SetInputPassthrough(passthrough) => window
            .set_ignore_cursor_events(passthrough)
            .map_err(|error| format!("could not change pet input passthrough: {error}")),
    }
}

/// Returns true when the URL belongs to the pet bridge. The caller must always
/// deny that navigation, regardless of whether the action was valid.
pub(super) fn handle_pet_host_navigation(app: &AppHandle, caller_label: &str, url: &Url) -> bool {
    if url.scheme() != "dsh-pet" {
        return false;
    }
    match parse_pet_host_action(url, caller_label).and_then(|action| apply_pet_action(app, action))
    {
        Ok(()) => {}
        Err(error) => eprintln!("dsh-desktop [pet-host]: {error}"),
    }
    true
}

fn enforce_pet_window_attributes(window: &WebviewWindow) {
    let _ = window.set_always_on_top(true);
    let _ = window.set_skip_taskbar(true);
    let _ = window.set_decorations(false);
    let _ = window.set_resizable(false);
    let _ = window.set_maximizable(false);
    let _ = window.set_minimizable(false);
}

fn place_new_pet_window(window: &WebviewWindow) -> Result<(), String> {
    let scale = window
        .scale_factor()
        .map_err(|error| format!("could not read the initial pet scale factor: {error}"))?;
    let size = window
        .outer_size()
        .map_err(|error| format!("could not read the initial pet size: {error}"))?;
    let Some(area) = current_work_area(window)? else {
        return Ok(());
    };
    let margin = i64::from(css_to_physical(PET_EDGE_MARGIN_CSS, scale));
    let position = PhysicalPosition::new(
        (area.right() - i64::from(size.width) - margin).clamp(i32::MIN as i64, i32::MAX as i64)
            as i32,
        (area.bottom() - i64::from(size.height) - margin).clamp(i32::MIN as i64, i32::MAX as i64)
            as i32,
    );
    window
        .set_position(fit_inside_area(position, size, area))
        .map_err(|error| format!("could not place the pet window: {error}"))
}

pub(super) fn prepare_pet_window(
    app: &AppHandle,
    url: Url,
    allowed_port: Arc<AtomicU16>,
) -> Result<(), String> {
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port() != Some(allowed_port.load(Ordering::Acquire))
    {
        return Err(
            "refusing to create a pet window outside the active loopback runtime".to_owned(),
        );
    }

    if let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) {
        enforce_pet_window_attributes(&window);
        // Keep the surface hidden until the freshly loaded pet client has read
        // the persisted visibility setting and explicitly synchronizes it.
        let _ = window.hide();
        window
            .navigate(url)
            .map_err(|error| format!("could not navigate the existing pet window: {error}"))?;
        return Ok(());
    }

    let navigation_port = Arc::clone(&allowed_port);
    let navigation_app = app.clone();
    let popup_port = Arc::clone(&allowed_port);
    let window = WebviewWindowBuilder::new(app, PET_WINDOW_LABEL, WebviewUrl::External(url))
        .title("DeepSeek Harness Pet")
        .inner_size(PET_INITIAL_WIDTH_CSS, PET_INITIAL_HEIGHT_CSS)
        .min_inner_size(PET_MIN_WIDTH_CSS, PET_MIN_HEIGHT_CSS)
        .max_inner_size(PET_MAX_WIDTH_CSS, PET_MAX_HEIGHT_CSS)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .shadow(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .focused(false)
        .visible(false)
        .prevent_overflow_with_margin(PhysicalSize::new(12, 12))
        .initialization_script(PET_BRIDGE_SCRIPT)
        .on_navigation(move |url| {
            if handle_pet_host_navigation(&navigation_app, PET_WINDOW_LABEL, url) {
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
                tauri::webview::NewWindowResponse::Allow
            } else {
                if matches!(url.scheme(), "http" | "https") {
                    let _ = open::that_detached(url.as_str());
                }
                tauri::webview::NewWindowResponse::Deny
            }
        })
        .build()
        .map_err(|error| format!("could not create the independent pet window: {error}"))?;
    place_new_pet_window(&window)?;
    Ok(())
}

pub(super) fn destroy_pet_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) {
        // Hide first so a failed/asynchronous destroy can never leave an old
        // runtime port visibly interactive during a retry.
        let _ = window.hide();
        if let Err(error) = window.destroy() {
            eprintln!("dsh-desktop [pet-host]: could not destroy stale pet window: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_rejects_privileged_actions_from_the_main_window() {
        assert_eq!(
            parse_pet_host_action(
                &Url::parse("dsh-pet://set-visible?visible=true").unwrap(),
                "main"
            )
            .unwrap(),
            PetHostAction::SetVisible(true)
        );
        assert!(
            parse_pet_host_action(&Url::parse("dsh-pet://begin-drag").unwrap(), "main").is_err()
        );
        assert!(parse_pet_host_action(
            &Url::parse("dsh-pet://resize-to?width=300&height=260").unwrap(),
            "main"
        )
        .is_err());
    }

    #[test]
    fn bridge_accepts_only_finite_bounded_pet_geometry() {
        assert_eq!(
            parse_pet_host_action(
                &Url::parse("dsh-pet://move-by?dx=-12.5&dy=8").unwrap(),
                PET_WINDOW_LABEL
            )
            .unwrap(),
            PetHostAction::MoveBy { dx: -12.5, dy: 8.0 }
        );
        assert!(parse_pet_host_action(
            &Url::parse("dsh-pet://move-by?dx=5000&dy=0").unwrap(),
            PET_WINDOW_LABEL
        )
        .is_err());
        assert!(parse_pet_host_action(
            &Url::parse("dsh-pet://resize-to?width=NaN&height=200").unwrap(),
            PET_WINDOW_LABEL
        )
        .is_err());
    }

    #[test]
    fn high_dpi_geometry_keeps_a_drag_target_visible_across_monitors() {
        let areas = [
            Rect {
                x: -1920,
                y: 0,
                width: 1920,
                height: 1040,
            },
            Rect {
                x: 0,
                y: 0,
                width: 2560,
                height: 1400,
            },
        ];
        let size = PhysicalSize::new(390, 330); // 260x220 CSS at 150% DPI.
        assert_eq!(
            keep_visible_on_some_monitor(PhysicalPosition::new(-120, 400), size, &areas, 72),
            PhysicalPosition::new(-120, 400)
        );
        assert_eq!(
            keep_visible_on_some_monitor(PhysicalPosition::new(9000, 400), size, &areas, 72),
            PhysicalPosition::new(2488, 400)
        );
    }

    #[test]
    fn fit_inside_handles_negative_monitor_origins_and_oversized_content() {
        let area = Rect {
            x: -1600,
            y: -200,
            width: 1600,
            height: 900,
        };
        assert_eq!(
            fit_inside_area(
                PhysicalPosition::new(-2000, 600),
                PhysicalSize::new(600, 400),
                area
            ),
            PhysicalPosition::new(-1600, 300)
        );
        assert_eq!(
            fit_inside_area(
                PhysicalPosition::new(-400, 0),
                PhysicalSize::new(2000, 1000),
                area
            ),
            PhysicalPosition::new(-1600, -200)
        );
    }

    #[test]
    fn bridge_does_not_expose_the_tauri_global_api() {
        assert!(!PET_BRIDGE_SCRIPT.contains("__TAURI__"));
        assert!(!PET_BRIDGE_SCRIPT.contains("shell"));
        assert!(!PET_BRIDGE_SCRIPT.contains("fs"));
        assert!(PET_BRIDGE_SCRIPT.contains("__DSH_PET_HOST__"));
    }
}
