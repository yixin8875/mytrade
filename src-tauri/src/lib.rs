mod gateway;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let app = tauri::Builder::default()
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .invoke_handler(tauri::generate_handler![
      gateway_prepare_update,
      gateway_start
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
      gateway::start(app.handle());
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|app_handle, event| {
    if matches!(event, tauri::RunEvent::Exit) {
      gateway::stop(app_handle);
    }
  });
}
