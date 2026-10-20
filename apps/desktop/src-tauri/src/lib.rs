use quench_app::{App, ChangesView, ContextView, MachineView, RecentView};
use std::path::PathBuf;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, State,
};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
fn machine(app: State<App>) -> MachineView {
    app.machine()
}

#[tauri::command]
fn recent(app: State<App>) -> Vec<RecentView> {
    app.recent()
}

#[tauri::command]
fn launch_project() -> Option<String> {
    std::env::args()
        .nth(1)
        .filter(|a| !a.starts_with('-') && PathBuf::from(a).is_dir())
}

#[tauri::command]
async fn open_project(app: State<'_, App>, path: String) -> Result<ContextView, String> {
    let path = PathBuf::from(path);
    if !path.is_dir() {
        return Err(format!("{} is not a folder", path.display()));
    }
    app.open_project(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn stage_skill(
    app: State<App>,
    path: String,
    skill: String,
    value: Option<String>,
) -> Result<ChangesView, String> {
    app.stage_skill(&PathBuf::from(path), &skill, value.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn changes(app: State<App>) -> ChangesView {
    app.changes()
}

#[tauri::command]
fn discard(app: State<App>) -> ChangesView {
    app.discard()
}

#[tauri::command]
fn apply(app: State<App>) -> Result<ChangesView, String> {
    app.apply().map_err(|e| e.to_string())
}

#[tauri::command]
fn undo(app: State<App>) -> Result<ChangesView, String> {
    app.undo_last().map_err(|e| e.to_string())
}

#[tauri::command]
async fn pick_project(handle: tauri::AppHandle) -> Option<String> {
    handle
        .dialog()
        .file()
        .set_title("Open a project folder")
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.display().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = App::for_this_user().expect("Quench could not create ~/.quench/local");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(app)
        .setup(|app| {
            build_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            machine,
            recent,
            launch_project,
            open_project,
            pick_project,
            stage_skill,
            changes,
            discard,
            apply,
            undo
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Quench application");
}

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
