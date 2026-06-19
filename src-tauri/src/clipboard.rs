use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

static WATCHING: AtomicBool = AtomicBool::new(false);

/// Read image data from macOS clipboard via NSPasteboard
pub fn read_clipboard_image() -> Result<(Vec<u8>, String), String> {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;

        // Try reading image via osascript + NSPasteboard
        // Write clipboard image to a temp file using Swift snippet
        let tmp_dir = std::env::temp_dir();
        let tmp_path = tmp_dir.join("imgbed_clipboard_tmp.png");

        // Use swift to read NSPasteboard image
        let script = format!(
            r#"
            import AppKit
            let pb = NSPasteboard.general
            guard let img = NSImage(pasteboard: pb) else {{
                print("NO_IMAGE")
                exit(1)
            }}
            guard let tiff = img.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else {{
                print("CONVERT_FAIL")
                exit(1)
            }}
            try! png.write(to: URL(fileURLWithPath: "{}"))
            print("OK")
            "#,
            tmp_path.display()
        );

        let output = Command::new("swift")
            .arg("-e")
            .arg(&script)
            .output()
            .map_err(|e| format!("Failed to run swift: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if stdout != "OK" {
            return Err("No image in clipboard".into());
        }

        let data = std::fs::read(&tmp_path).map_err(|e| format!("Failed to read temp image: {}", e))?;
        let _ = std::fs::remove_file(&tmp_path);
        Ok((data, ".png".into()))
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("Clipboard image reading is only supported on macOS".into())
    }
}

/// Check if clipboard currently has an image (lightweight check via changeCount)
fn clipboard_has_image() -> bool {
    #[cfg(target_os = "macos")]
    {
        let script = r#"
        import AppKit
        let pb = NSPasteboard.general
        let types = pb.types
        let hasImage = types.contains(.image) || types.contains(NSPasteboard.PasteboardType.fileURL)
        if hasImage {
            print("YES")
        } else {
            print("NO")
        }
        "#;

        let output = std::process::Command::new("swift")
            .arg("-e")
            .arg(script)
            .output();

        match output {
            Ok(out) => String::from_utf8_lossy(&out.stdout).trim() == "YES",
            Err(_) => false,
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[tauri::command]
pub fn watch_clipboard(app: AppHandle) -> Result<(), String> {
    if WATCHING.load(Ordering::SeqCst) {
        return Ok(());
    }
    WATCHING.store(true, Ordering::SeqCst);

    std::thread::spawn(move || {
        let get_change_count = || -> i64 {
            let script = r#"
            import AppKit
            print(NSPasteboard.general.changeCount)
            "#;
            let output = std::process::Command::new("swift")
                .arg("-e")
                .arg(script)
                .output();
            match output {
                Ok(out) => String::from_utf8_lossy(&out.stdout)
                    .trim()
                    .parse()
                    .unwrap_or(-1),
                Err(_) => -1,
            }
        };

        let mut last_change_count = get_change_count();

        while WATCHING.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(500));
            let current = get_change_count();

            if current != last_change_count && current != -1 {
                last_change_count = current;
                if clipboard_has_image() {
                    log::info!("Clipboard image detected, uploading...");
                    let _ = app.emit("clipboard-image-detected", ());
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn stop_watching() -> Result<(), String> {
    WATCHING.store(false, Ordering::SeqCst);
    Ok(())
}
