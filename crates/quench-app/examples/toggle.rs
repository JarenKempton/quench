use std::path::PathBuf;

fn main() -> std::io::Result<()> {
    let mut args = std::env::args().skip(1);
    let project = PathBuf::from(args.next().expect(
        "usage: toggle <project> <skill> <on|off|name-only|user-invocable-only|inherit> | undo",
    ));
    let app = quench_app::App::for_this_user()?;
    let skill = args.next().expect("skill or undo");
    let view = if skill == "undo" {
        app.undo_last()?
    } else {
        let value = args.next().expect("value");
        let staged = app.stage_skill(
            &project,
            &skill,
            (value != "inherit").then_some(value.as_str()),
        )?;
        for file in &staged.files {
            println!(
                "--- {}\n{}+++ {}\n{}",
                file.file, file.before, file.file, file.after
            );
        }
        app.apply()?
    };
    let context = app.open_project(&project)?;
    println!(
        "pending {} · can undo {} · always loaded ~{} tokens",
        view.items.len(),
        view.can_undo,
        context.always_tokens
    );
    Ok(())
}
