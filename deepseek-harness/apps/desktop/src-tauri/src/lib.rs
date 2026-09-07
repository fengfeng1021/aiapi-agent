//! Tauri host that owns the local dsh Web process and exposes only its loopback UI.

mod cli;
mod navigation;
mod pet;
mod runtime;
mod startup;

use std::{
    collections::VecDeque,
    env,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU16, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use navigation::build_main_window;
#[cfg(test)]
use navigation::is_local_app_url;
use pet::{destroy_pet_window, prepare_pet_window};
use runtime::{installed_runtime_dir, RuntimeProgress};
use startup::{
    diagnostics_dir, mark_initialization_complete, open_diagnostics_path, show_runtime_progress,
    show_startup_error, show_startup_progress,
};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewWindow};

// Cold first boot materializes ~50k runtime files under Defender/indexers,
// which routinely exceeds a minute on Windows. Give it five.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(300);
const LOG_TAIL_LINES: usize = 40;

fn runtime_window_urls(base: &Url) -> (Url, Url) {
    fn with_flags(base: &Url, flags: &[(&str, &str)]) -> Url {
        let mut url = base.clone();
        let retained = base
            .query_pairs()
            .filter(|(key, _)| {
                !matches!(
                    key.as_ref(),
                    "dsh-desktop" | "dsh-pet-host" | "dsh-pet-window"
                )
            })
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect::<Vec<_>>();
        url.set_query(None);
        let mut query = url.query_pairs_mut();
        for (key, value) in retained {
            query.append_pair(&key, &value);
        }
        for (key, value) in flags {
            query.append_pair(key, value);
        }
        drop(query);
        url
    }

    (
        with_flags(base, &[("dsh-desktop", "1"), ("dsh-pet-host", "external")]),
        with_flags(base, &[("dsh-desktop", "1"), ("dsh-pet-window", "1")]),
    )
}

#[derive(Debug)]
struct LaunchSpec {
    program: PathBuf,
    args: Vec<String>,
    current_dir: PathBuf,
    install_anchor: PathBuf,
}

#[derive(Default)]
struct ProcessState {
    child: Mutex<Option<Child>>,
    logs: Mutex<VecDeque<String>>,
    shutting_down: AtomicBool,
    starting: AtomicBool,
    #[cfg(windows)]
    job: Mutex<Option<WindowsJob>>,
}

fn web_runtime_args(cli: String) -> Vec<String> {
    vec![
        cli,
        "web".to_owned(),
        "--port".to_owned(),
        "0".to_owned(),
        "--no-open".to_owned(),
    ]
}

fn start_runtime(
    app_handle: AppHandle,
    window: WebviewWindow,
    process: Arc<ProcessState>,
    allowed_port: Arc<AtomicU16>,
) {
    if process
        .starting
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    process.shutting_down.store(false, Ordering::Release);
    if let Ok(mut logs) = process.logs.lock() {
        logs.clear();
    }
    thread::spawn(move || {
        let _ = window.eval("window.__dshDesktopStartupReset?.()");
        show_startup_progress(
            &window,
            1,
            "正在检测 Windows 环境…",
            "Checking the Windows environment…",
        );
        let result = (|| -> Result<(), String> {
            let spec = launch_spec(&app_handle, |progress| {
                show_runtime_progress(&window, progress);
            })?;
            if process.shutting_down.load(Ordering::Acquire) {
                return Ok(());
            }
            show_startup_progress(
                &window,
                90,
                "正在启动本地服务并进行最终验证…",
                "Starting the local service and running final checks…",
            );
            let (stdout, stderr) = spawn_runtime(&spec, &process)?;
            show_startup_progress(
                &window,
                96,
                "本地服务已启动，正在等待就绪信号…",
                "Local service started. Waiting for its readiness signal…",
            );
            let (ready_tx, ready_rx) = mpsc::channel();
            pipe_logs(stdout, "stdout", Arc::clone(&process), ready_tx.clone());
            pipe_logs(stderr, "stderr", Arc::clone(&process), ready_tx);
            let url = wait_for_runtime(ready_rx, Arc::clone(&process))?;
            let Some(port) = url.port() else {
                return Err("local runtime announced a URL without a port".to_owned());
            };
            allowed_port.store(port, Ordering::Release);
            mark_initialization_complete(&app_handle)?;
            let (main_url, pet_url) = runtime_window_urls(&url);
            show_startup_progress(
                &window,
                100,
                "环境准备完成，正在进入 Aiapi Agent。",
                "Environment ready. Opening Aiapi Agent.",
            );
            if window.is_visible().unwrap_or(false) {
                thread::sleep(Duration::from_millis(280));
            }
            window
                .navigate(main_url)
                .map_err(|error| format!("could not open the local Web UI: {error}"))?;
            if let Err(error) = prepare_pet_window(&app_handle, pet_url, Arc::clone(&allowed_port))
            {
                process.append_log("pet-host", &error);
            }
            let _ = window.show();
            let _ = window.set_focus();
            Ok(())
        })();
        if let Err(error) = result {
            if !process.shutting_down.load(Ordering::Acquire) {
                process.shutdown();
                process.starting.store(false, Ordering::Release);
                show_startup_error(&window, error);
                return;
            }
        }
        process.starting.store(false, Ordering::Release);
    });
}

fn open_diagnostics(app: &AppHandle) -> Result<(), String> {
    open_diagnostics_path(&diagnostics_dir(app)?)
}

fn retry_startup(app: AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let process = app.state::<Arc<ProcessState>>().inner().clone();
    let allowed_port = app.state::<Arc<AtomicU16>>().inner().clone();
    if process.starting.load(Ordering::Acquire) {
        return;
    }
    allowed_port.store(0, Ordering::Release);
    destroy_pet_window(&app);
    process.shutdown();
    start_runtime(app, window, process, allowed_port);
}

impl ProcessState {
    fn append_log(&self, source: &str, line: &str) {
        eprintln!("dsh-desktop [{source}]: {line}");
        let mut logs = self.logs.lock().expect("desktop log mutex poisoned");
        if logs.len() == LOG_TAIL_LINES {
            logs.pop_front();
        }
        logs.push_back(format!("[{source}] {line}"));
    }

    fn failure_message(&self, summary: &str) -> String {
        let logs = self.logs.lock().expect("desktop log mutex poisoned");
        if logs.is_empty() {
            return summary.to_owned();
        }
        format!(
            "{summary}\n\n{}",
            logs.iter().cloned().collect::<Vec<_>>().join("\n")
        )
    }

    fn exited(&self) -> Result<Option<String>, String> {
        let mut child = self
            .child
            .lock()
            .map_err(|_| "desktop process mutex poisoned".to_owned())?;
        let Some(child) = child.as_mut() else {
            return Ok(Some("local runtime process is unavailable".to_owned()));
        };
        child
            .try_wait()
            .map(|status| status.map(|value| format!("local runtime exited with {value}")))
            .map_err(|error| format!("could not inspect the local runtime: {error}"))
    }

    fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::AcqRel) {
            return;
        }

        let Ok(mut slot) = self.child.lock() else {
            return;
        };
        let Some(mut child) = slot.take() else {
            return;
        };

        if child.try_wait().ok().flatten().is_some() {
            let _ = child.wait();
            return;
        }

        #[cfg(windows)]
        {
            if let Ok(mut job) = self.job.lock() {
                if let Some(job) = job.take() {
                    job.terminate();
                    let _ = child.wait();
                    return;
                }
            }
            terminate_windows_tree(&mut child);
        }

        #[cfg(unix)]
        terminate_unix_group(&mut child);
    }
}

#[cfg(windows)]
struct WindowsJob {
    handle: isize,
}

#[cfg(windows)]
impl WindowsJob {
    fn assign(child: &Child) -> Result<Self, String> {
        use std::{mem::size_of, os::windows::io::AsRawHandle, ptr};
        use windows_sys::Win32::{
            Foundation::{CloseHandle, HANDLE},
            System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        };

        let raw_job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if raw_job.is_null() {
            return Err(format!(
                "could not create the runtime job: {}",
                std::io::Error::last_os_error()
            ));
        }

        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                raw_job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            unsafe { CloseHandle(raw_job) };
            return Err(format!(
                "could not configure the runtime job: {}",
                std::io::Error::last_os_error()
            ));
        }

        let process_handle = child.as_raw_handle() as HANDLE;
        if unsafe { AssignProcessToJobObject(raw_job, process_handle) } == 0 {
            unsafe { CloseHandle(raw_job) };
            return Err(format!(
                "could not assign the runtime process to its job: {}",
                std::io::Error::last_os_error()
            ));
        }

        Ok(Self {
            handle: raw_job as isize,
        })
    }

    fn terminate(self) {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, HANDLE},
            System::JobObjects::TerminateJobObject,
        };

        let raw = self.handle as HANDLE;
        unsafe {
            TerminateJobObject(raw, 0);
            CloseHandle(raw);
        }
        std::mem::forget(self);
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        unsafe { CloseHandle(self.handle as HANDLE) };
    }
}

#[cfg(windows)]
fn terminate_windows_tree(child: &mut Child) {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

    let _ = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
    let _ = child.wait();
}

#[cfg(unix)]
fn terminate_unix_group(child: &mut Child) {
    let process_group = -(child.id() as i32);
    unsafe { libc::kill(process_group, libc::SIGTERM) };
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            let _ = child.wait();
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    unsafe { libc::kill(process_group, libc::SIGKILL) };
    let _ = child.wait();
}

fn launch_spec(
    app: &AppHandle,
    mut progress: impl FnMut(RuntimeProgress),
) -> Result<LaunchSpec, String> {
    if cfg!(debug_assertions) {
        progress(RuntimeProgress::Inspecting);
        let repo_root = env::var_os("DSH_DESKTOP_REPO_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .ancestors()
                    .nth(3)
                    .expect("desktop crate remains under apps/desktop/src-tauri")
                    .to_path_buf()
            });
        let mut args = vec!["--import".to_owned(), "tsx/esm".to_owned()];
        args.extend(web_runtime_args(
            repo_root.join("apps/cli/src/bin.ts").display().to_string(),
        ));
        let spec = LaunchSpec {
            program: PathBuf::from(
                env::var_os("DSH_DESKTOP_NODE").unwrap_or_else(|| "node".into()),
            ),
            args,
            install_anchor: repo_root.join("apps/desktop/package.json"),
            current_dir: repo_root,
        };
        progress(RuntimeProgress::Ready);
        return Ok(spec);
    }

    let runtime_dir = installed_runtime_dir(app, progress)?;
    let program = if cfg!(windows) {
        runtime_dir.join("node/node.exe")
    } else {
        runtime_dir.join("node/bin/node")
    };
    let app_dir = runtime_dir.join("app");
    let cli = app_dir.join("node_modules/@deepseek-ai/dsh/lib/bin.js");
    if !program.is_file() {
        return Err(format!(
            "bundled Node runtime is missing at {}",
            program.display()
        ));
    }
    if !cli.is_file() {
        return Err(format!("bundled dsh CLI is missing at {}", cli.display()));
    }
    Ok(LaunchSpec {
        program,
        args: web_runtime_args(cli.display().to_string()),
        install_anchor: app_dir.join("package.json"),
        current_dir: app_dir,
    })
}

fn spawn_runtime(
    spec: &LaunchSpec,
    state: &ProcessState,
) -> Result<(impl Read + Send + 'static, impl Read + Send + 'static), String> {
    let mut command = Command::new(&spec.program);
    let bundled_pnpm = spec.current_dir.join("node_modules/pnpm/bin/pnpm.cjs");
    command
        .args(&spec.args)
        .current_dir(&spec.current_dir)
        .env("DSH_DESKTOP", "1")
        .env("DSH_INSTALL_ANCHOR", &spec.install_anchor)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if bundled_pnpm.is_file() {
        command.env("DSH_PNPM_CLI", bundled_pnpm);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    #[cfg(target_os = "linux")]
    unsafe {
        use std::os::unix::process::CommandExt;
        let parent = std::process::id() as libc::pid_t;
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::getppid() != parent {
                libc::_exit(1);
            }
            Ok(())
        });
    }

    let mut child = command.spawn().map_err(|error| {
        format!(
            "could not start {} in {}: {error}",
            spec.program.display(),
            spec.current_dir.display()
        )
    })?;

    #[cfg(windows)]
    match WindowsJob::assign(&child) {
        Ok(job) => {
            *state.job.lock().expect("desktop job mutex poisoned") = Some(job);
        }
        Err(error) => state.append_log(
            "host",
            &format!("{error}; using explicit process-tree cleanup"),
        ),
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "runtime stdout was not piped".to_owned())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "runtime stderr was not piped".to_owned())?;
    *state
        .child
        .lock()
        .map_err(|_| "desktop process mutex poisoned".to_owned())? = Some(child);
    Ok((stdout, stderr))
}

fn parse_server_url(line: &str) -> Option<Url> {
    let marker = "dsh web: ";
    let raw = line.split_once(marker)?.1.split_whitespace().next()?;
    let url = Url::parse(raw).ok()?;
    (url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port().is_some())
        .then_some(url)
}

fn pipe_logs<R: Read + Send + 'static>(
    reader: R,
    source: &'static str,
    state: Arc<ProcessState>,
    ready: Sender<Url>,
) {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            match line {
                Ok(line) => {
                    state.append_log(source, &line);
                    if let Some(url) = parse_server_url(&line) {
                        let _ = ready.send(url);
                    }
                }
                Err(error) => {
                    state.append_log(source, &format!("could not read process output: {error}"));
                    break;
                }
            }
        }
    });
}

fn wait_for_runtime(ready: Receiver<Url>, state: Arc<ProcessState>) -> Result<Url, String> {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    loop {
        if state.shutting_down.load(Ordering::Acquire) {
            return Err("local runtime startup was cancelled".to_owned());
        }

        match ready.recv_timeout(Duration::from_millis(100)) {
            Ok(url) => return Ok(url),
            Err(RecvTimeoutError::Disconnected) => {
                return Err(state.failure_message(
                    "local runtime closed its output before announcing the Web UI",
                ))
            }
            Err(RecvTimeoutError::Timeout) => {}
        }

        match state.exited() {
            Ok(Some(status)) => return Err(state.failure_message(&status)),
            Err(error) => return Err(state.failure_message(&error)),
            Ok(None) => {}
        }

        if Instant::now() >= deadline {
            return Err(
                state.failure_message("local runtime did not become ready within 5 minutes")
            );
        }
    }
}

pub fn run() {
    let process = Arc::new(ProcessState::default());
    let process_for_setup = Arc::clone(&process);
    let allowed_port = Arc::new(AtomicU16::new(0));
    let port_for_setup = Arc::clone(&allowed_port);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let Some(window) = app.get_webview_window("main") else {
                return;
            };
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }))
        .manage(Arc::clone(&process))
        .manage(Arc::clone(&allowed_port))
        .setup(move |app| {
            let window = build_main_window(app, Arc::clone(&port_for_setup))?;
            let app_handle = app.handle().clone();
            let _ = window.show();
            let _ = window.set_focus();
            let startup_process = Arc::clone(&process_for_setup);
            let startup_port = Arc::clone(&port_for_setup);
            start_runtime(app_handle, window, startup_process, startup_port);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("could not build the DeepSeek Harness desktop application");

    app.run(move |app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            destroy_pet_window(app_handle);
            process.shutdown();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_loopback_web_readiness_lines() {
        let announced = parse_server_url(
            "[boot] dsh web: http://127.0.0.1:4567 (LAN: http://192.168.1.4:4567)",
        )
        .unwrap();
        assert_eq!(announced.as_str(), "http://127.0.0.1:4567/");
        assert!(parse_server_url("dsh web: http://localhost:4567").is_none());
        assert!(parse_server_url("provider: http://127.0.0.1:4567").is_none());
    }

    #[test]
    fn desktop_web_runtime_never_opens_the_system_browser() {
        assert_eq!(
            web_runtime_args("dsh.js".to_owned()),
            ["dsh.js", "web", "--port", "0", "--no-open"]
        );
    }

    #[test]
    fn confines_navigation_to_the_active_runtime() {
        assert!(is_local_app_url(
            &Url::parse("tauri://localhost/").unwrap(),
            0
        ));
        assert!(!is_local_app_url(
            &Url::parse("tauri://localhost/").unwrap(),
            3080
        ));
        assert!(is_local_app_url(
            &Url::parse("http://127.0.0.1:3080/session").unwrap(),
            3080
        ));
        assert!(!is_local_app_url(
            &Url::parse("http://127.0.0.1:3081/").unwrap(),
            3080
        ));
        assert!(!is_local_app_url(
            &Url::parse("https://example.com/").unwrap(),
            3080
        ));
        assert!(!is_local_app_url(
            &Url::parse("http://localhost:3080/").unwrap(),
            3080
        ));
    }

    #[test]
    fn assigns_distinct_main_and_pet_runtime_query_contracts() {
        let base = Url::parse("http://127.0.0.1:3080/session?keep=1&dsh-desktop=old").unwrap();
        let (main, pet) = runtime_window_urls(&base);
        assert_eq!(
            main.as_str(),
            "http://127.0.0.1:3080/session?keep=1&dsh-desktop=1&dsh-pet-host=external"
        );
        assert_eq!(
            pet.as_str(),
            "http://127.0.0.1:3080/session?keep=1&dsh-desktop=1&dsh-pet-window=1"
        );
    }
}
