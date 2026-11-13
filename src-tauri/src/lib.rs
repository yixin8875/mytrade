mod gateway;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize)]
struct WindowStateFile {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

fn window_state_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("window-state.json"))
}

/// 恢复上次的窗口位置与大小；窗口已经不在任何显示器里时只恢复大小。
fn restore_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Some(path) = window_state_path(app) else {
        return;
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(state) = serde_json::from_str::<WindowStateFile>(&text) else {
        return;
    };
    if state.maximized {
        let _ = window.maximize();
        return;
    }
    if state.width < 800 || state.height < 500 {
        return;
    }
    let visible = window
        .available_monitors()
        .map(|monitors| {
            monitors.iter().any(|monitor| {
                let position = monitor.position();
                let size = monitor.size();
                let right = position.x + size.width as i32;
                let bottom = position.y + size.height as i32;
                state.x + 80 > position.x
                    && state.x < right - 80
                    && state.y + 40 > position.y
                    && state.y < bottom - 40
            })
        })
        .unwrap_or(true);
    if visible {
        let _ = window.set_position(tauri::PhysicalPosition::new(state.x, state.y));
    }
    let _ = window.set_size(tauri::PhysicalSize::new(state.width, state.height));
}

fn save_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let state = WindowStateFile {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: window.is_maximized().unwrap_or(false),
    };
    let Some(path) = window_state_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(&state) {
        let _ = std::fs::write(path, text);
    }
}

/// 安装更新前停掉网关并等待 sidecar 解锁；返回 false 表示仍被占用
#[tauri::command]
fn gateway_prepare_update(app: tauri::AppHandle) -> bool {
    gateway::prepare_for_update(&app)
}

/// 安装失败时把网关重新拉起来，应用可以继续使用
#[tauri::command]
fn gateway_start(app: tauri::AppHandle) {
    gateway::start(&app);
}

/// 启动页诊断：网关是否已监听、sidecar 是否存在、最近日志
#[tauri::command]
fn gateway_status(app: tauri::AppHandle) -> gateway::GatewayStatus {
    gateway::status(&app)
}

/// 从 backups 目录里的 zip 恢复；会重启网关
#[tauri::command]
fn backup_restore(app: tauri::AppHandle, name: String) -> Result<String, String> {
    gateway::restore_backup(&app, &name)
}

/// 在资源管理器中定位导出文件或备份目录
#[tauri::command]
fn reveal_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    gateway::reveal(&app, &path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let app = tauri::Builder::default()
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .invoke_handler(tauri::generate_handler![
      gateway_prepare_update,
      gateway_start,
      gateway_status,
      backup_restore,
      reveal_path
    ])
    .manage(gateway::GatewayState::default())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      restore_window(app.handle());
      gateway::start(app.handle());
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|app_handle, event| {
    if matches!(event, tauri::RunEvent::Exit) {
      save_window(app_handle);
      gateway::stop(app_handle);
    }
  });
}
