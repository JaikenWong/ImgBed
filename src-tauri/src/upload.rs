use base64::Engine;
use chrono::Local;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Serialize, Deserialize, Clone)]
pub struct UploadResult {
    pub url: String,
    pub cdn_url: String,
    pub filename: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct UploadConfig {
    pub token: String,
    pub repo_owner: String,
    pub repo_name: String,
    pub branch: String,
    pub path_prefix: String,
    pub cdn_base: String,
}

impl Default for UploadConfig {
    fn default() -> Self {
        Self {
            token: String::new(),
            repo_owner: "JaikenWong".into(),
            repo_name: "Drawing-Bed".into(),
            branch: "main".into(),
            path_prefix: "images".into(),
            cdn_base: "https://cdn.jsdelivr.net/gh".into(),
        }
    }
}

const GITHUB_API: &str = "https://api.github.com/repos";

fn upload_to_github(config: &UploadConfig, data: &[u8], ext: &str) -> Result<UploadResult, String> {
    let date = Local::now().format("%Y-%m-%d").to_string();
    let filename = format!("{}{}", Uuid::new_v4(), ext);
    let path = format!("{}/{}/{}", config.path_prefix, date, filename);

    let b64 = base64::engine::general_purpose::STANDARD.encode(data);
    let url = format!(
        "{}/{}/{}/contents/{}",
        GITHUB_API, config.repo_owner, config.repo_name, path
    );

    let body = serde_json::json!({
        "message": "upload from imgbed app",
        "content": b64,
        "branch": config.branch,
    });

    let client = Client::new();
    let resp = client
        .put(&url)
        .header("Authorization", format!("Bearer {}", config.token))
        .header("User-Agent", "imgbed-app")
        .json(&body)
        .send()
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().unwrap_or_default();
        return Err(format!("GitHub API error {}: {}", status, text));
    }

    let cdn_url = format!(
        "{}/{}/{}@{}/{}",
        config.cdn_base, config.repo_owner, config.repo_name, config.branch, path
    );

    Ok(UploadResult {
        url,
        cdn_url,
        filename,
    })
}

#[tauri::command]
pub fn upload_clipboard_image(config: UploadConfig) -> Result<UploadResult, String> {
    let (data, ext) = crate::clipboard::read_clipboard_image()?;
    upload_to_github(&config, &data, &ext)
}

#[tauri::command]
pub fn upload_file(config: UploadConfig, path: String) -> Result<UploadResult, String> {
    let data = std::fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_else(|| ".png".into());
    upload_to_github(&config, &data, &ext)
}
