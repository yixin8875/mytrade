use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

const GATEWAY_ADDR: &str = "127.0.0.1:8765";
const SIDECAR_NAME: &str = "mytrade-gateway";
const TARGET_TRIPLE: &str = "x86_64-pc-windows-msvc";

/// 桌面应用持有的网关子进程；退出时统一终止。
#[derive(Default)]
pub struct GatewayState(pub Mutex<Option<Child>>);

/// 启动页用来区分「网关没起来」和「终端没连上」。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatus {
    pub listening: bool,
    pub sidecar: bool,
    pub log_tail: Option<String>,
}

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

fn read_log_tail(app: &AppHandle, lines: usize) -> Option<String> {
    let text = fs::read_to_string(gateway_data_dir(app).join("gateway.log")).ok()?;
    let mut tail: Vec<&str> = text.lines().collect();
    if tail.len() > lines {
        tail = tail.split_off(tail.len() - lines);
    }
    let joined = tail
        .into_iter()
        .map(|line| line.chars().take(300).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n");
    if joined.is_empty() {
        None
    } else {
        Some(joined)
    }
}

/// 给启动页用：网关进程是否在监听、sidecar 是否存在、最近几行日志。
pub fn status(app: &AppHandle) -> GatewayStatus {
    GatewayStatus {
        listening: gateway_listening(),
        sidecar: sidecar_path(app).is_some(),
        log_tail: read_log_tail(app, 6),
    }
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

fn sidecar_writable(app: &AppHandle) -> bool {
    let Some(path) = sidecar_path(app) else {
        return true;
    };
    match OpenOptions::new().write(true).open(path) {
        Ok(_) => true,
        // 5 = ERROR_ACCESS_DENIED：可能只是安装目录 ACL，提权安装器仍可覆盖
        Err(error) => error.raw_os_error() == Some(5),
    }
}

/// 结束整棵进程树。只 kill PyInstaller 启动器会留下真正跑 uvicorn 的子进程，
/// 它继续占用 mytrade-gateway.exe，导致升级安装覆盖文件时卡住。
#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let pid = pid.to_string();
    let _ = Command::new("taskkill")
        .args(["/PID", pid.as_str(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(windows))]
fn kill_tree(_pid: u32) {}

/// 清理所有网关进程（含父进程已退出的孤儿进程），生产名和开发名都覆盖。
#[cfg(windows)]
fn kill_sidecars() {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    for image in [
        format!("{SIDECAR_NAME}.exe"),
        format!("{SIDECAR_NAME}-{TARGET_TRIPLE}.exe"),
    ] {
        // PyInstaller 解包出的子进程与启动器同名，/IM 会把它们一起结束
        let _ = Command::new("taskkill")
            .args(["/IM", image.as_str(), "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(not(windows))]
fn kill_sidecars() {}

pub fn stop(app: &AppHandle) {
    let Some(state) = app.try_state::<GatewayState>() else {
        return;
    };
    let child = state.0.lock().unwrap().take();
    if let Some(mut child) = child {
        kill_tree(child.id());
        let _ = child.kill();
        let _ = child.wait();
        append_log(app, "sidecar stopped");
    }
}

/// 安装更新前调用：停掉网关并等到 sidecar 文件可以覆盖。
/// 返回 false 时不应该启动安装器，否则会卡在「文件被占用」。
pub fn prepare_for_update(app: &AppHandle) -> bool {
    stop(app);
    kill_sidecars();
    let deadline = Instant::now() + Duration::from_secs(12);
    while Instant::now() < deadline {
        if !gateway_listening() && sidecar_writable(app) {
            append_log(app, "gateway stopped and sidecar unlocked for update");
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    append_log(app, "gateway still running or sidecar locked; update aborted");
    false
}

fn stamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn safe_name(name: &str, extension: &str) -> bool {
    !name.is_empty()
        && name.len() <= 120
        && name.ends_with(extension)
        && !name.contains("..")
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

fn extract_backup(path: &Path, staging: &Path) -> Result<(), String> {
    let file = File::open(path).map_err(|error| format!("无法打开备份：{error}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| format!("备份不是有效的 zip：{error}"))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取备份条目失败：{error}"))?;
        let Some(relative) = entry.enclosed_name() else {
            continue;
        };
        let text = relative.to_string_lossy().replace('\\', "/");
        if !(text.starts_with("data/") || text.starts_with("audit/")) {
            continue;
        }
        let target = staging.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&target)
                .map_err(|error| format!("创建恢复目录失败：{error}"))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("创建恢复目录失败：{error}"))?;
        }
        let mut output =
            File::create(&target).map_err(|error| format!("写入恢复文件失败：{error}"))?;
        io::copy(&mut entry, &mut output)
            .map_err(|error| format!("写入恢复文件失败：{error}"))?;
    }
    Ok(())
}

/// 从 backups 目录里的 zip 恢复数据：停网关 → 解压到临时目录 → 替换 data/audit → 重启网关。
/// 旧的 data/audit 改名保留，恢复失败会自动回滚。
pub fn restore_backup(app: &AppHandle, name: &str) -> Result<String, String> {
    let name = name.trim();
    if !safe_name(name, ".zip") {
        return Err("备份文件名无效".to_string());
    }
    let base = gateway_data_dir(app);
    let archive = base.join("backups").join(name);
    if !archive.is_file() {
        return Err(format!("找不到备份文件：{name}"));
    }

    stop(app);
    kill_sidecars();
    let deadline = Instant::now() + Duration::from_secs(12);
    while Instant::now() < deadline {
        if !gateway_listening() {
            break;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    if gateway_listening() {
        start(app);
        return Err("网关没有停止，已取消恢复".to_string());
    }

    let marker = stamp();
    let staging = base.join(format!(".restore-{marker}"));
    let _ = fs::remove_dir_all(&staging);
    if let Err(error) = extract_backup(&archive, &staging) {
        let _ = fs::remove_dir_all(&staging);
        start(app);
        return Err(error);
    }
    if !staging.join("data").join("mytrade.db").is_file() {
        let _ = fs::remove_dir_all(&staging);
        start(app);
        return Err("备份里没有 data/mytrade.db，已取消恢复".to_string());
    }

    let data_dir = base.join("data");
    let audit_dir = base.join("audit");
    let old_data = base.join(format!("data.old-{marker}"));
    let old_audit = base.join(format!("audit.old-{marker}"));
    let replace_audit = staging.join("audit").is_dir();
    if data_dir.exists() {
        fs::rename(&data_dir, &old_data).map_err(|error| {
            start(app);
            format!("备份当前数据库失败：{error}")
        })?;
    }
    if replace_audit && audit_dir.exists() {
        fs::rename(&audit_dir, &old_audit).map_err(|error| {
            start(app);
            format!("备份当前审计日志失败：{error}")
        })?;
    }

    let swapped = (|| -> io::Result<()> {
        fs::rename(staging.join("data"), &data_dir)?;
        if replace_audit {
            fs::rename(staging.join("audit"), &audit_dir)?;
        }
        Ok(())
    })();
    if let Err(error) = swapped {
        // 尽量退回恢复前的状态
        let _ = fs::rename(&data_dir, staging.join("data"));
        if replace_audit {
            let _ = fs::rename(&audit_dir, staging.join("audit"));
        }
        if old_data.exists() {
            let _ = fs::rename(&old_data, &data_dir);
        }
        if old_audit.exists() {
            let _ = fs::rename(&old_audit, &audit_dir);
        }
        let _ = fs::remove_dir_all(&staging);
        start(app);
        return Err(format!("恢复失败，已回滚：{error}"));
    }

    // 备份里不含凭据；把恢复前的凭据文件带回来，免去重新登录
    let credentials = old_data.join("credentials.json");
    if credentials.is_file() && !data_dir.join("credentials.json").exists() {
        let _ = fs::copy(&credentials, data_dir.join("credentials.json"));
    }
    let _ = fs::remove_dir_all(&staging);
    start(app);
    append_log(app, &format!("restored backup {name}"));
    Ok(format!("已从 {name} 恢复，旧数据保留在 data.old-{marker}"))
}

/// 在资源管理器中定位导出文件或备份目录；只允许数据目录内的路径。
pub fn reveal(app: &AppHandle, path: &str) -> Result<(), String> {
    let base = gateway_data_dir(app)
        .canonicalize()
        .map_err(|error| format!("数据目录不可用：{error}"))?;
    let target = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("路径不存在：{error}"))?;
    if !target.starts_with(&base) {
        return Err("只能定位应用数据目录内的文件".to_string());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut command = Command::new("explorer");
        if target.is_dir() {
            command.arg(&target);
        } else {
            command.arg(format!("/select,{}", target.display()));
        }
        command
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| format!("无法打开资源管理器：{error}"))?;
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        Err("当前系统不支持定位文件".to_string())
    }
}
