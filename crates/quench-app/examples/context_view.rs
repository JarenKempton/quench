use std::path::PathBuf;

fn main() -> std::io::Result<()> {
    let root = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir()?);
    let app = quench_app::App::for_this_user()?;
    let view = app.open_project(&root)?;
    println!("{}", serde_json::to_string_pretty(&view)?);
    Ok(())
}
