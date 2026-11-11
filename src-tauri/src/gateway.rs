use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};

const GATEWAY_ADDR: &str = "127.0.0.1:8765";
const SIDECAR_NAME: &str = "mytrade-gateway";
const TARGET_TRIPLE: &str = "x86_64-pc-windows-msvc";

/// 桌面应用持有的网关子进程；退出时统一终止。
#[derive(Default)]
pub struct GatewayState(pub Mutex<Option<Child>>);

fn gateway_data_dir(app: &AppHandle) -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| app.path().app_local_data_dir().ok())
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join("MyTrade").join("gateway");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn append_log(app: &AppHandle, message: &str) {
    let path = gateway_data_dir(app).join("gateway.log");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[tauri] {message}");
    }
}

fn log_stdio(app: &AppHandle) -> Stdio {
    let path = gateway_data_dir(app).join("gateway.log");
    match OpenOptions::new().create(true).append(true).open(path) {
        Ok(file) => Stdio::from(file),
        Err(_) => Stdio::null(),
    }
}

fn sidecar_path(app: &AppHandle) -> Option<PathBuf> {
    let plain = format!("{SIDECAR_NAME}.exe");
    let versioned = format!("{SIDECAR_NAME}-{TARGET_TRIPLE}.exe");
    let mut candidates = Vec::new();

    if let Ok(current) = std::env::current_exe() {
        if let Some(dir) = current.parent() {
            candidates.push(dir.join(&plain));
            candidates.push(dir.join(&versioned));
        }
    }
    if let Ok(resource) = app.path().resource_dir() {
        candidates.push(resource.join(&plain));
        candidates.push(resource.join("binaries").join(&versioned));
    }
    // tauri dev 时 sidecar 可能还没复制到 target/debug
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(versioned),
    );

    candidates.into_iter().find(|path| path.is_file())
}

fn gateway_listening() -> bool {
    let address: SocketAddr = GATEWAY_ADDR.parse().expect("valid gateway address");
    TcpStream::connect_timeout(&address, Duration::from_millis(300)).is_ok()
}

pub fn start(app: &AppHandle) {
    if gateway_listening() {
        append_log(app, "gateway already listening, skip sidecar");
        return;
    }
    let Some(executable) = sidecar_path(app) else {
        append_log(app, "gateway sidecar not found");
        return;
    };
    let data_dir = gateway_data_dir(app);
    let mut command = Command::new(&executable);
    command
        .arg("--data-dir")
        .arg(&data_dir)
        .arg("--parent-pid")
        .arg(std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(log_stdio(app))
        .stderr(log_stdio(app));

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    match command.spawn() {
        Ok(child) => {
            append_log(
                app,
                &format!(
                    "started sidecar {} (pid {})",
                    executable.display(),
                    child.id()
                ),
            );
            if let Some(state) = app.try_state::<GatewayState>() {
                *state.0.lock().unwrap() = Some(child);
            }
        }
        Err(error) => append_log(
            app,
            &format!("failed to start sidecar {}: {error}", executable.display()),
        ),
    }
}

pub fn stop(app: &AppHandle) {
    let Some(state) = app.try_state::<GatewayState>() else {
        return;
    };
    let child = state.0.lock().unwrap().take();
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
        append_log(app, "sidecar stopped");
    }
}
