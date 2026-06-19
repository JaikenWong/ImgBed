mod clipboard;
mod store;
mod upload;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            upload::upload_clipboard_image,
            upload::upload_file,
            clipboard::watch_clipboard,
            clipboard::stop_watching,
            store::get_config,
            store::set_config,
            store::get_config_with_default,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
