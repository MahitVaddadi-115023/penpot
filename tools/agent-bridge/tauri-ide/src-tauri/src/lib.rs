// Antigravity IDE — native desktop shell that composes Penpot canvas,
// the agent-plugin markup editor + chat, and a markup file tree in one window.
//
// This is app #3 of the 3-app sequence (popup → plugin wrapper → IDE).
//
// Strategy: single window, single host page, three iframes inside a CSS grid.
// No multi-webview-children for v1 — iframes keep cross-pane composition
// trivial and let us reuse the existing plugin UI verbatim.
//
// Rust's job:
//   1. Provide 6 Tauri commands for markup file CRUD + canvas navigation +
//      log relay.
//   2. Render a native macOS menu bar (App / File / Edit / View / Agent / Help).
//   3. Pipe menu clicks to either Rust handlers or emitted events the
//      frontend (host page) listens to.
//
// Markup files live at ~/.antigravity/markups/. The dir is created on demand.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    Emitter, Manager,
};
use tauri_plugin_shell::ShellExt;

// ---------- helpers --------------------------------------------------------

/// Resolve `~/.antigravity/markups/`, creating it if missing.
/// We resolve `$HOME` via std::env so we don't need a path-permission scope.
fn markups_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME env var not set".to_string())?;
    let dir = home.join(".antigravity").join("markups");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all failed: {e}"))?;
    }
    Ok(dir)
}

/// Reject anything that tries to escape the markups dir (../, absolute paths, etc).
fn safe_join(name: &str) -> Result<PathBuf, String> {
    if name.is_empty() {
        return Err("empty name".into());
    }
    if name.contains('/') || name.contains('\\') || name.starts_with('.') {
        return Err(format!("invalid markup name: {name}"));
    }
    Ok(markups_dir()?.join(name))
}

// ---------- Tauri commands -------------------------------------------------

#[tauri::command]
fn list_markups() -> Result<Vec<String>, String> {
    let dir = markups_dir()?;
    let mut out = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("read_dir failed: {e}"))?;
    for entry in entries.flatten() {
        if let Ok(ft) = entry.file_type() {
            if ft.is_file() {
                if let Some(name) = entry.file_name().to_str() {
                    out.push(name.to_string());
                }
            }
        }
    }
    out.sort();
    Ok(out)
}

#[tauri::command]
fn read_markup(name: String) -> Result<String, String> {
    let path = safe_join(&name)?;
    fs::read_to_string(&path).map_err(|e| format!("read_to_string {name} failed: {e}"))
}

#[tauri::command]
fn write_markup(name: String, content: String) -> Result<(), String> {
    let path = safe_join(&name)?;
    fs::write(&path, content).map_err(|e| format!("write {name} failed: {e}"))
}

#[tauri::command]
fn delete_markup(name: String) -> Result<(), String> {
    let path = safe_join(&name)?;
    fs::remove_file(&path).map_err(|e| format!("remove_file {name} failed: {e}"))
}

#[derive(Serialize, Deserialize, Clone)]
struct OpenPenpotPayload {
    project_id: String,
    file_id: String,
}

/// Tell the canvas iframe to navigate to a specific Penpot workspace URL.
/// We emit an event; the host page's JS picks it up and rewrites canvas-frame.src.
#[tauri::command]
fn open_penpot(
    app: tauri::AppHandle,
    project_id: String,
    file_id: String,
) -> Result<(), String> {
    app.emit(
        "open-penpot",
        OpenPenpotPayload {
            project_id,
            file_id,
        },
    )
    .map_err(|e| format!("emit open-penpot failed: {e}"))
}

#[derive(Serialize, Deserialize, Clone)]
struct AgentLogPayload {
    level: String,
    message: String,
}

/// Receive a log line from an iframe (or the host page) and broadcast it back
/// to the host page so the status bar can render it.
#[tauri::command]
fn agent_log(app: tauri::AppHandle, level: String, message: String) -> Result<(), String> {
    // Echo to stdout for terminal debugging.
    println!("[agent_log {}] {}", level, message);
    app.emit("agent-log", AgentLogPayload { level, message })
        .map_err(|e| format!("emit agent-log failed: {e}"))
}

#[tauri::command]
async fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    app.shell()
        .open(url, None)
        .map_err(|e| format!("open_external failed: {e}"))
}

// ---------- entrypoint -----------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Pre-create the markups dir so the first list_markups() call works.
            let _ = markups_dir();

            // ---- native macOS menu bar -------------------------------------
            let handle = app.handle();

            let about_meta = AboutMetadata {
                name: Some("Antigravity IDE".into()),
                version: Some(env!("CARGO_PKG_VERSION").into()),
                comments: Some(
                    "Native IDE shell for Penpot canvas + agent markup editor + chat.".into(),
                ),
                ..Default::default()
            };

            // App menu (macOS template)
            let app_menu = SubmenuBuilder::new(handle, "Antigravity IDE")
                .about(Some(about_meta.clone()))
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;

            // File menu
            let new_markup = MenuItemBuilder::new("New Markup…")
                .id("new_markup")
                .accelerator("CmdOrCtrl+N")
                .build(app)?;
            let open_workspace = MenuItemBuilder::new("Open Workspace…")
                .id("open_workspace")
                .build(app)?;
            let save_markup = MenuItemBuilder::new("Save")
                .id("save_markup")
                .accelerator("CmdOrCtrl+S")
                .build(app)?;
            let save_all = MenuItemBuilder::new("Save All").id("save_all").build(app)?;
            let file_menu = SubmenuBuilder::new(handle, "File")
                .item(&new_markup)
                .item(&open_workspace)
                .separator()
                .item(&save_markup)
                .item(&save_all)
                .separator()
                .close_window()
                .build()?;

            // Edit menu — standard
            let edit_menu = SubmenuBuilder::new(handle, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            // View menu — toggles + reload + fullscreen
            let toggle_tree = MenuItemBuilder::new("Toggle File Tree")
                .id("toggle_tree")
                .accelerator("CmdOrCtrl+B")
                .build(app)?;
            let toggle_chat = MenuItemBuilder::new("Toggle Chat")
                .id("toggle_chat")
                .accelerator("CmdOrCtrl+/")
                .build(app)?;
            let toggle_canvas = MenuItemBuilder::new("Toggle Canvas Preview")
                .id("toggle_canvas")
                .accelerator("CmdOrCtrl+P")
                .build(app)?;
            let reload_item = MenuItemBuilder::new("Reload")
                .id("reload")
                .accelerator("CmdOrCtrl+R")
                .build(app)?;
            let fullscreen_item = MenuItemBuilder::new("Toggle Full Screen")
                .id("toggle_fullscreen")
                .accelerator("CmdOrCtrl+Ctrl+F")
                .build(app)?;
            let view_menu = SubmenuBuilder::new(handle, "View")
                .item(&toggle_tree)
                .item(&toggle_chat)
                .item(&toggle_canvas)
                .separator()
                .item(&reload_item)
                .item(&fullscreen_item)
                .build()?;

            // Agent menu — emits events to the host page
            let start_agent = MenuItemBuilder::new("Start Agent")
                .id("start_agent")
                .accelerator("CmdOrCtrl+Shift+A")
                .build(app)?;
            let stop_agent = MenuItemBuilder::new("Stop Agent")
                .id("stop_agent")
                .build(app)?;
            let agent_menu = SubmenuBuilder::new(handle, "Agent")
                .item(&start_agent)
                .item(&stop_agent)
                .build()?;

            // Window menu
            let window_menu = SubmenuBuilder::new(handle, "Window")
                .minimize()
                .maximize()
                .separator()
                .build()?;

            // Help menu
            let about_item = MenuItemBuilder::new("About Antigravity IDE")
                .id("about")
                .build(app)?;
            let docs_item = MenuItemBuilder::new("Documentation")
                .id("docs")
                .build(app)?;
            let help_menu = SubmenuBuilder::new(handle, "Help")
                .item(&about_item)
                .item(&docs_item)
                .build()?;

            let menu = MenuBuilder::new(handle)
                .items(&[
                    &app_menu,
                    &file_menu,
                    &edit_menu,
                    &view_menu,
                    &agent_menu,
                    &window_menu,
                    &help_menu,
                ])
                .build()?;
            app.set_menu(menu)?;

            // ---- menu event handler ----------------------------------------
            app.on_menu_event(move |app, event| match event.id().as_ref() {
                "new_markup" => {
                    let _ = app.emit("menu-new-markup", ());
                }
                "open_workspace" => {
                    let _ = app.emit("menu-open-workspace", ());
                }
                "save_markup" => {
                    let _ = app.emit("menu-save", ());
                }
                "save_all" => {
                    let _ = app.emit("menu-save-all", ());
                }
                "toggle_tree" => {
                    let _ = app.emit("toggle-pane", "tree");
                }
                "toggle_chat" => {
                    let _ = app.emit("toggle-pane", "chat");
                }
                "toggle_canvas" => {
                    let _ = app.emit("toggle-pane", "canvas");
                }
                "reload" => {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.eval("window.location.reload()");
                    }
                }
                "toggle_fullscreen" => {
                    if let Some(win) = app.get_webview_window("main") {
                        let is_full = win.is_fullscreen().unwrap_or(false);
                        let _ = win.set_fullscreen(!is_full);
                    }
                }
                "start_agent" => {
                    let _ = app.emit("agent-start", ());
                }
                "stop_agent" => {
                    let _ = app.emit("agent-stop", ());
                }
                "about" => {
                    let _ = app.emit("show-about", ());
                }
                "docs" => {
                    let shell = app.shell();
                    let _ = shell.open(
                        "https://github.com/SaiMahitVaddadi/penpot/tree/portfolio-sync-toolkit/tools/agent-bridge/README.md",
                        None,
                    );
                }
                _ => {}
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_markups,
            read_markup,
            write_markup,
            delete_markup,
            open_penpot,
            agent_log,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
