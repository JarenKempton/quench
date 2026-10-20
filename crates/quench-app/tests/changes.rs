use quench_app::{App, JournalEntry, QuenchHome};
use std::fs;
use std::path::{Path, PathBuf};

fn setup(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("quench-changes-{}-{tag}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let root = {
        fs::create_dir_all(&root).unwrap();
        fs::canonicalize(&root).unwrap()
    };
    let home = root.join("home");
    let proj = root.join("proj");
    for name in ["grill", "ship"] {
        let dir = home.join(".claude/skills").join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: Does {name} things.\n---\n"),
        )
        .unwrap();
    }
    fs::create_dir_all(proj.join(".claude")).unwrap();
    fs::write(
        proj.join(".claude/settings.local.json"),
        r#"{"permissions":{"allow":["Bash(ls)"]}}"#,
    )
    .unwrap();
    (root, home, proj)
}

fn skill_tokens(app: &App, proj: &Path, skill: &str) -> u64 {
    let view = app.open_project(proj).unwrap();
    let row = view
        .sections
        .iter()
        .flat_map(|s| &s.rows)
        .find(|r| r.title == skill)
        .unwrap();
    match row.cost {
        quench_app::Cost::Estimated { always_tokens, .. } => always_tokens,
        _ => panic!("expected estimate"),
    }
}

#[test]
fn stage_apply_journal_and_undo_round_trip() {
    let (root, home, proj) = setup("roundtrip");
    let quench = QuenchHome::at(root.join("quench"));
    let app = App::new(&home, quench.clone()).unwrap();
    let original = fs::read_to_string(proj.join(".claude/settings.local.json")).unwrap();
    let before_total = app.open_project(&proj).unwrap().always_tokens;
    assert!(skill_tokens(&app, &proj, "grill") > 0);

    let staged = app.stage_skill(&proj, "grill", Some("off")).unwrap();
    assert_eq!(staged.items.len(), 1);
    assert_eq!(
        (staged.items[0].from.as_str(), staged.items[0].to.as_str()),
        ("inherit", "off")
    );
    assert!(staged.files[0].after.contains(r#""grill": "off""#));
    assert!(staged.files[0].after.contains("Bash(ls)"));
    let row = app.open_project(&proj).unwrap();
    let toggle = row
        .sections
        .iter()
        .flat_map(|s| &s.rows)
        .find(|r| r.title == "grill")
        .unwrap()
        .toggle
        .clone()
        .unwrap();
    assert_eq!(toggle.pending.as_deref(), Some("off"));
    assert_eq!(
        fs::read_to_string(proj.join(".claude/settings.local.json")).unwrap(),
        original,
        "staging never writes"
    );

    assert!(app.stage_skill(&proj, "grill", Some("bogus")).is_err());

    let applied = app.apply().unwrap();
    assert!(applied.items.is_empty() && applied.can_undo);
    assert_eq!(skill_tokens(&app, &proj, "grill"), 0);
    assert!(app.open_project(&proj).unwrap().always_tokens < before_total);
    let written: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(proj.join(".claude/settings.local.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(written["skillOverrides"]["grill"], "off");
    assert_eq!(written["permissions"]["allow"][0], "Bash(ls)");

    let journal: Vec<JournalEntry> = fs::read_to_string(root.join("quench/local/journal.jsonl"))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(journal.len(), 1);
    let change = journal[0].change.as_ref().unwrap();
    assert_eq!(change.machine, app.machine().id);
    assert_eq!(change.harness, "claude-code");
    assert_eq!(change.working_copy, proj);
    assert_eq!(change.project.label, "proj");
    assert!(journal[0].backup.as_ref().unwrap().exists());

    let undone = app.undo_last().unwrap();
    assert!(!undone.can_undo);
    assert_eq!(
        json(&proj.join(".claude/settings.local.json")),
        serde_json::from_str::<serde_json::Value>(&original).unwrap()
    );
    assert_eq!(app.open_project(&proj).unwrap().always_tokens, before_total);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn undo_removes_a_settings_file_quench_created_and_restaging_the_current_value_clears_it() {
    let (root, home, proj) = setup("create");
    fs::remove_file(proj.join(".claude/settings.local.json")).unwrap();
    let app = App::new(&home, QuenchHome::at(root.join("quench"))).unwrap();
    app.stage_skill(&proj, "ship", Some("name-only")).unwrap();
    assert!(
        app.stage_skill(&proj, "ship", None)
            .unwrap()
            .items
            .is_empty(),
        "back to current value"
    );
    app.stage_skill(&proj, "ship", Some("name-only")).unwrap();
    app.apply().unwrap();
    assert!(proj.join(".claude/settings.local.json").exists());
    app.undo_last().unwrap();
    assert!(!proj.join(".claude/settings.local.json").exists());
    let _ = fs::remove_dir_all(&root);
}

fn json(path: &Path) -> serde_json::Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn undo_keeps_edits_made_after_apply() {
    let (root, home, proj) = setup("later-edit");
    let app = App::new(&home, QuenchHome::at(root.join("quench"))).unwrap();
    app.stage_skill(&proj, "grill", Some("off")).unwrap();
    app.apply().unwrap();
    let file = proj.join(".claude/settings.local.json");
    let mut v = json(&file);
    v["permissions"]["allow"]
        .as_array_mut()
        .unwrap()
        .push("Bash(npm test)".into());
    fs::write(&file, v.to_string()).unwrap();
    app.undo_last().unwrap();
    let after = json(&file);
    assert_eq!(
        after["permissions"]["allow"],
        serde_json::json!(["Bash(ls)", "Bash(npm test)"])
    );
    assert!(after.get("skillOverrides").is_none());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn undo_keeps_a_created_file_that_gained_other_settings() {
    let (root, home, proj) = setup("created-later");
    let file = proj.join(".claude/settings.local.json");
    fs::remove_file(&file).unwrap();
    let app = App::new(&home, QuenchHome::at(root.join("quench"))).unwrap();
    app.stage_skill(&proj, "grill", Some("off")).unwrap();
    app.apply().unwrap();
    let mut v = json(&file);
    v["permissions"] = serde_json::json!({"allow": ["Bash(make)"]});
    fs::write(&file, v.to_string()).unwrap();
    app.undo_last().unwrap();
    assert_eq!(
        json(&file),
        serde_json::json!({"permissions": {"allow": ["Bash(make)"]}})
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_failed_undo_changes_nothing_and_stays_undoable() {
    let (root, home, proj) = setup("undo-fail");
    let other = root.join("other");
    fs::create_dir_all(other.join(".claude")).unwrap();
    fs::write(other.join(".claude/settings.local.json"), "{}").unwrap();
    let app = App::new(&home, QuenchHome::at(root.join("quench"))).unwrap();
    app.stage_skill(&proj, "grill", Some("off")).unwrap();
    app.stage_skill(&other, "ship", Some("off")).unwrap();
    app.apply().unwrap();
    fs::write(other.join(".claude/settings.local.json"), "not json").unwrap();
    assert!(app.undo_last().is_err());
    assert_eq!(
        json(&proj.join(".claude/settings.local.json"))["skillOverrides"]["grill"],
        "off"
    );
    assert!(app.changes().can_undo);
    let _ = fs::remove_dir_all(&root);
}
