// Antigravity floating popup — Tauri 2.x backend.
//
// Lifecycle:
//   1. App starts, creates the main popup window hidden + always-on-top + frameless.
//   2. Registers global shortcut Cmd+Opt+I — on trigger, shows & focuses the window.
//   3. Window auto-hides on blur (handled in window event handler).
//   4. Frontend invokes Tauri commands:
//        - get_models()                                       -> Vec<String>
//        - submit_instruction(instruction, model, draft)      -> String (rewritten)
//        - paste_result(text)                                 -> ()      (clipboard + osa keystroke)
//        - hide_popup()                                       -> ()
//
// newcore is assumed to be running on http://localhost:3777.
//   - GET  /info        -> { models: [{ id }] }
//   - POST /chat        -> { content: string }   body { model, message }

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::process::Command;
use tauri::{
    AppHandle, Emitter, Manager, WindowEvent,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const NEWCORE_BASE: &str = "http://localhost:3777";

// ---------- /info models ---------------------------------------------------

#[derive(Debug, Deserialize)]
struct InfoModel {
    id: String,
}

#[derive(Debug, Deserialize)]
struct InfoResponse {
    #[serde(default)]
    models: Vec<InfoModel>,
}

#[tauri::command]
async fn get_models() -> Result<Vec<String>, String> {
    let url = format!("{}/info", NEWCORE_BASE);
    let resp = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("newcore /info request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("newcore /info returned HTTP {}", resp.status()));
    }
    let info: InfoResponse = resp
        .json()
        .await
        .map_err(|e| format!("newcore /info JSON parse failed: {e}"))?;
    Ok(info.models.into_iter().map(|m| m.id).collect())
}

// ---------- /chat ----------------------------------------------------------

#[derive(Debug, Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    message: String,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    #[serde(default)]
    content: String,
}

fn build_system_prompt(draft: &str, instruction: &str) -> String {
    format!(
        "SYSTEM: You are a writing assistant. The user has selected some text and wants it edited per their instruction. Reply ONLY with the rewritten text. NO prose, NO markdown fences, NO commentary.\n\nDRAFT:\n{}\n\nINSTRUCTION:\n{}",
        draft, instruction
    )
}

#[tauri::command]
async fn submit_instruction(
    instruction: String,
    model: String,
    draft: String,
) -> Result<String, String> {
    let url = format!("{}/chat", NEWCORE_BASE);
    let body = ChatRequest {
        model: &model,
        message: build_system_prompt(&draft, &instruction),
    };
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("newcore /chat request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("newcore /chat returned HTTP {status}: {text}"));
    }
    let chat: ChatResponse = resp
        .json()
        .await
        .map_err(|e| format!("newcore /chat JSON parse failed: {e}"))?;
    Ok(chat.content)
}

// ---------- paste back into focused app ------------------------------------

#[tauri::command]
async fn paste_result(app: AppHandle, text: String) -> Result<(), String> {
    // 1) put result on clipboard
    app.clipboard()
        .write_text(text)
        .map_err(|e| format!("clipboard write failed: {e}"))?;

    // 2) hide our popup so the previously-focused app regains key focus
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }

    // 3) tiny delay so the OS focus actually moves before we synthesize Cmd+V
    std::thread::sleep(std::time::Duration::from_millis(120));

    // 4) trigger Cmd+V in the now-foreground app via AppleScript
    //    NOTE: requires Accessibility permission (System Settings > Privacy & Security > Accessibility).
    let out = Command::new("osascript")
        .arg("-e")
        .arg(r#"tell application "System Events" to keystroke "v" using command down"#)
        .output()
        .map_err(|e| format!("osascript spawn failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "osascript failed (need Accessibility permission?): {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

// ---------- hide popup -----------------------------------------------------

#[tauri::command]
fn hide_popup(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------- show popup (used by global shortcut + tray) --------------------

fn show_popup(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
        // tell the frontend we just opened — it should snapshot the clipboard
        let _ = app.emit("popup-shown", ());
    }
}

// ---------- entrypoint -----------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_positioner::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        // we only register one — Cmd+Opt+I — so any press = show
                        let _ = shortcut; // unused; kept for clarity
                        show_popup(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Register Cmd+Opt+I (a.k.a. Super+Alt+I cross-platform).
            // Cmd+I alone collides with most editors' italic toggle.
            let shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::ALT), Code::KeyI);
            app.global_shortcut().register(shortcut)?;

            // Auto-hide on blur so the popup never gets in the way.
            if let Some(win) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::Focused(false) = event {
                        if let Some(w) = handle.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_models,
            submit_instruction,
            paste_result,
            hide_popup
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
