// Antigravity Bridge — standalone macOS wrapper for agent-plugin/index.html.
//
// This is Tauri app #2 of the 3-app sequence (popup → plugin wrapper → full IDE).
// It hosts the SAME plugin UI that runs inside Penpot's iframe, but as a peer
// macOS app you can launch when Penpot is closed or when you want more screen.
//
// Most of the work happens in the frontend (the plugin already talks to
// newcore on :3777 and the agent-bridge dev-server on :9010 directly over
// HTTP/WS from JS). Rust's job here is small:
//
//   - Open one normal 1200x800 decorated window.
//   - Provide a native macOS menu bar (File > Reload, View > Toggle Fullscreen, Help > About).
//   - Expose `open_external(url)` so plugin links can pop a browser tab.
//
// Deliberately NO global shortcut — Tauri #1 (the popup) already owns Cmd+Opt+I
// system-wide, and registering it here would conflict if both apps run.
// Cmd+I inside the plugin pane is still handled by the plugin's own JS.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    Emitter, Manager,
};
use tauri_plugin_shell::ShellExt;

// ---------- open_external --------------------------------------------------

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
        .setup(|app| {
            // ---- native macOS menu bar -------------------------------------
            let handle = app.handle();

            // App menu (macOS-only, populated by the OS template)
            let about_meta = AboutMetadata {
                name: Some("Antigravity Bridge".into()),
                version: Some(env!("CARGO_PKG_VERSION").into()),
                comments: Some(
                    "Standalone wrapper for the Antigravity Bridge Penpot plugin.".into(),
                ),
                ..Default::default()
            };
            let app_menu = SubmenuBuilder::new(handle, "Antigravity Bridge")
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

            // File > Reload (Cmd+R)
            let reload_item = MenuItemBuilder::new("Reload")
                .id("reload")
                .accelerator("CmdOrCtrl+R")
                .build(app)?;
            let file_menu = SubmenuBuilder::new(handle, "File")
                .item(&reload_item)
                .separator()
                .close_window()
                .build()?;

            // Edit (standard copy/paste so Cmd+I in the plugin keeps working)
            let edit_menu = SubmenuBuilder::new(handle, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            // View > Toggle Fullscreen (Cmd+Ctrl+F is the macOS standard)
            let fullscreen_item = MenuItemBuilder::new("Toggle Full Screen")
                .id("toggle_fullscreen")
                .accelerator("CmdOrCtrl+Ctrl+F")
                .build(app)?;
            let view_menu = SubmenuBuilder::new(handle, "View")
                .item(&fullscreen_item)
                .build()?;

            // Window menu (minimize/zoom)
            let window_menu = SubmenuBuilder::new(handle, "Window")
                .minimize()
                .maximize()
                .separator()
                .build()?;

            // Help > About
            let about_item = MenuItemBuilder::new("About Antigravity Bridge")
                .id("about")
                .build(app)?;
            let help_menu = SubmenuBuilder::new(handle, "Help")
                .item(&about_item)
                .build()?;

            let menu = MenuBuilder::new(handle)
                .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
                .build()?;
            app.set_menu(menu)?;

            // ---- menu event handler ----------------------------------------
            app.on_menu_event(move |app, event| match event.id().as_ref() {
                "reload" => {
                    if let Some(win) = app.get_webview_window("main") {
                        // Tauri 2: re-eval the current URL.
                        let _ = win.eval("window.location.reload()");
                    }
                }
                "toggle_fullscreen" => {
                    if let Some(win) = app.get_webview_window("main") {
                        let is_full = win.is_fullscreen().unwrap_or(false);
                        let _ = win.set_fullscreen(!is_full);
                    }
                }
                "about" => {
                    // Emit to frontend; plugin can optionally show a modal.
                    let _ = app.emit("show-about", ());
                }
                _ => {}
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![open_external])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
