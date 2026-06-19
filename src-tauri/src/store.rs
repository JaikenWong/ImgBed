use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const STORE_NAME: &str = "imgbed.json";

#[tauri::command]
pub fn get_config(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let store = app
        .store(STORE_NAME)
        .map_err(|e| format!("Failed to open store: {}", e))?;
    Ok(store
        .get(&key)
        .and_then(|v| v.as_str().map(|s| s.to_string())))
}

#[tauri::command]
pub fn set_config(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let store = app
        .store(STORE_NAME)
        .map_err(|e| format!("Failed to open store: {}", e))?;
    store.set(&key, serde_json::Value::String(value));
    store.save().map_err(|e| format!("Failed to save store: {}", e))?;
    Ok(())
}

/// Get config with fallback default
#[tauri::command]
pub fn get_config_with_default(app: AppHandle, key: String, default: String) -> Result<String, String> {
    let store = app
        .store(STORE_NAME)
        .map_err(|e| format!("Failed to open store: {}", e))?;
    match store.get(&key) {
        Some(v) => v
            .as_str()
            .map(|s| s.to_string())
            .ok_or("Invalid config value".into()),
        None => Ok(default),
    }
}
