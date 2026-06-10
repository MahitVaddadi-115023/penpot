// Antigravity floating popup — Tauri 2.x backend.
//
// Lifecycle:
//   1. App starts, creates the main popup window hidden + always-on-top + frameless.
//   2. Registers global shortcut Cmd+Opt+I — on trigger, shows & focuses the window.
//   3. Window auto-hides on blur (handled in window event handler).
//   4. Frontend invokes Tauri commands:
//        - get_models()                                       -> Vec<String>
//        - submit_instruction(instruction, model, draft)      -> String (rewritten)
//        - paste_result(text)                                 -> PasteOutcome { ok, pasted, error }
//        - hide_popup()                                       -> ()
//        - check_accessibility()                              -> bool
//        - open_accessibility_settings()                      -> ()
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

// ---------- accessibility permission probe ---------------------------------
//
// macOS only. The auto-paste step calls AppleScript / System Events to
// synthesize Cmd+V, which requires the *running* process (Terminal in dev,
// the bundled .app in release) to be granted Accessibility in
// System Settings > Privacy & Security > Accessibility.
//
// We probe with a side-effect-free script: "name of frontmost process".
// If permission is missing, osascript exits non-zero (typically -1743).

#[tauri::command]
fn check_accessibility() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let out = Command::new("osascript")
            .args([
                "-e",
                "tell application \"System Events\" to name of first process whose frontmost is true",
            ])
            .output();
        match out {
            Ok(o) if o.status.success() => Ok(true),
            Ok(_) => Ok(false),
            Err(_) => Ok(false),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(true)
    }
}

#[tauri::command]
fn open_accessibility_settings() -> Result<(), String> {
    // Opens System Settings → Privacy & Security → Accessibility on macOS 13+.
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .status()
            .map_err(|e| format!("open settings failed: {}", e))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

// ---------- paste back into focused app ------------------------------------

#[derive(Debug, Serialize)]
pub struct PasteOutcome {
    /// Whole operation completed without a hard error (clipboard write succeeded).
    ok: bool,
    /// Whether the synthetic Cmd+V keystroke was actually fired.
    /// false means: clipboard was set, but Accessibility permission is missing,
    /// so the user needs to press Cmd+V themselves.
    pasted: bool,
    /// Optional error string for the case where even the clipboard write fails.
    error: Option<String>,
}

#[tauri::command]
async fn paste_result(app: AppHandle, text: String) -> Result<PasteOutcome, String> {
    // 1) put result on clipboard — this part has no AX dependency.
    if let Err(e) = app.clipboard().write_text(text) {
        return Ok(PasteOutcome {
            ok: false,
            pasted: false,
            error: Some(format!("clipboard write failed: {e}")),
        });
    }

    // 2) hide our popup so the previously-focused app regains key focus
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }

    // 3) gate the keystroke synthesis on AX permission. If we don't have it,
    //    osascript would fail silently from the user's POV ("said done, nothing
    //    pasted"). Better to skip cleanly and let the frontend tell the user
    //    "press Cmd+V manually".
    if !check_accessibility().unwrap_or(false) {
        return Ok(PasteOutcome {
            ok: true,
            pasted: false,
            error: None,
        });
    }

    // 4) tiny delay so the OS focus actually moves before we synthesize Cmd+V
    std::thread::sleep(std::time::Duration::from_millis(120));

    // 5) trigger Cmd+V in the now-foreground app via AppleScript
    let out = Command::new("osascript")
        .arg("-e")
        .arg(r#"tell application "System Events" to keystroke "v" using command down"#)
        .output()
        .map_err(|e| format!("osascript spawn failed: {e}"))?;
    if !out.status.success() {
        // AX could have been revoked between probe & keystroke, or System Events
        // misbehaved. Clipboard is still set, so report it as "not pasted".
        return Ok(PasteOutcome {
            ok: true,
            pasted: false,
            error: Some(format!(
                "osascript failed (need Accessibility permission?): {}",
                String::from_utf8_lossy(&out.stderr)
            )),
        });
    }
    Ok(PasteOutcome {
        ok: true,
        pasted: true,
        error: None,
    })
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
            hide_popup,
            check_accessibility,
            open_accessibility_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
