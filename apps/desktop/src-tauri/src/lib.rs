use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

/// The one command the scaffold exposes: hand the frontend the core's honest
/// identity so the invoke bridge is proven end-to-end (hone#5's JSON contract,
/// now serde structs over `invoke` instead of HTTP). No scanning yet.
///
/// App-defined commands are not gated by the capability ACL — only core and
/// plugin commands are — so this needs no permission entry.
#[tauri::command]
fn app_info() -> quench_core::AppInfo {
    quench_core::app_info()
}

/// Scan this machine for harnesses and their skills, with honest provenance
/// (hone#13). The core does the real filesystem work; this command just hands
/// the result across the invoke bridge as a serde struct. No fabricated data —
/// every count the frontend renders traces to a path the core actually read.
#[tauri::command]
fn scan() -> quench_core::Scan {
    quench_core::scan_this_machine()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            build_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![app_info, scan])
        .run(tauri::generate_context!())
        .expect("error while running the Quench application");
}

/// One binary, one tray icon: a menu with Show / Quit, wired to the main window.
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Quench", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Quench", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::with_id("quench-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .tooltip("Quench")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}
