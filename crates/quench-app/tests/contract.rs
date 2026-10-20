use quench_app::{App, QuenchHome};
use std::fs;
use std::path::{Path, PathBuf};

fn fixture(root: &Path) -> (PathBuf, PathBuf) {
    let home = root.join("home");
    let proj = root.join("proj");
    fs::create_dir_all(home.join(".claude/skills/review")).unwrap();
    fs::create_dir_all(proj.join(".claude/skills/ship")).unwrap();
    fs::write(home.join(".claude/CLAUDE.md"), "Be brief.\n").unwrap();
    fs::write(
        home.join(".claude/skills/review/SKILL.md"),
        "---\nname: review\ndescription: >\n  Review a pull\n  request.\n---\nbody\n",
    )
    .unwrap();
    fs::write(proj.join("AGENTS.md"), "Use pnpm. See @docs/style.md\n").unwrap();
    std::os::unix::fs::symlink(proj.join("AGENTS.md"), proj.join("CLAUDE.md")).unwrap();
    fs::create_dir_all(proj.join("docs")).unwrap();
    fs::write(proj.join("docs/style.md"), "Two spaces.\n").unwrap();
    fs::write(
        proj.join(".claude/skills/ship/SKILL.md"),
        "---\nname: ship\ndescription: Ship it.\ndisable-model-invocation: true\n---\nbody\n",
    )
    .unwrap();
    fs::write(
        home.join(".claude.json"),
        r#"{"mcpServers":{"docs":{"type":"http","url":"https://u:secret@mcp.example.com/v1?key=secret"}}}"#,
    )
    .unwrap();
    fs::write(
        proj.join(".mcp.json"),
        r#"{"mcpServers":{"db":{"command":"/opt/bin/db-mcp","env":{"PGPASSWORD":"secret"}}}}"#,
    )
    .unwrap();
    (home, proj)
}

#[test]
fn context_view_contract_is_stable() {
    let root = std::env::temp_dir().join(format!("quench-contract-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let root = fs::canonicalize(&root).unwrap();
    let (home, proj) = fixture(&root);

    let app = App::new(&home, QuenchHome::at(root.join("quench"))).unwrap();
    let view = app.open_project(&proj).unwrap();
    let json = serde_json::to_string_pretty(&view)
        .unwrap()
        .replace(&root.display().to_string(), "<root>")
        .replace(
            &format!("{:016x}", fnv(proj.display().to_string().as_bytes())),
            "<path-hash>",
        );
    assert!(!json.contains("secret"));

    let machine = app.machine();
    assert_eq!(machine.id.len(), 36);
    assert_eq!(
        App::new(&home, QuenchHome::at(root.join("quench")))
            .unwrap()
            .machine(),
        machine
    );
    assert_eq!(app.recent().len(), 1);

    let snapshot = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/contract/context_view.json");
    if std::env::var_os("QUENCH_UPDATE_SNAPSHOT").is_some() {
        fs::write(&snapshot, &json).unwrap();
    }
    let expected =
        fs::read_to_string(&snapshot).expect("run with QUENCH_UPDATE_SNAPSHOT=1 to create");
    assert_eq!(json, expected);
    let _ = fs::remove_dir_all(&root);
}

fn fnv(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325u64, |h, b| {
        (h ^ u64::from(*b)).wrapping_mul(0x100000001b3)
    })
}

#[test]
fn a_corrupt_machine_id_is_never_replaced() {
    let root = std::env::temp_dir().join(format!("quench-machine-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let quench = QuenchHome::at(root.join("quench"));
    let home = root.join("home");
    fs::create_dir_all(&home).unwrap();
    let first = App::new(&home, quench.clone()).unwrap().machine();
    let file = root.join("quench/local/machine.json");
    let text = fs::read_to_string(&file).unwrap();
    fs::write(&file, &text[..text.len() - 3]).unwrap();
    assert!(App::new(&home, quench.clone()).is_err());
    assert_eq!(fs::read_to_string(&file).unwrap(), text[..text.len() - 3]);
    fs::write(&file, &text).unwrap();
    assert_eq!(App::new(&home, quench).unwrap().machine(), first);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn opening_home_lists_each_skill_once() {
    let root = std::env::temp_dir().join(format!("quench-homeproj-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let home = root.join("home");
    fs::create_dir_all(home.join(".claude/skills/one")).unwrap();
    fs::write(
        home.join(".claude/skills/one/SKILL.md"),
        "---\nname: one\ndescription: d\n---\n",
    )
    .unwrap();
    let app = App::new(&home, QuenchHome::at(root.join("quench"))).unwrap();
    let view = app.open_project(&home).unwrap();
    let ids: Vec<&String> = view
        .sections
        .iter()
        .flat_map(|s| &s.rows)
        .map(|r| &r.id)
        .collect();
    let unique: std::collections::HashSet<_> = ids.iter().collect();
    assert_eq!(ids.len(), unique.len());
    assert_eq!(
        view.sections
            .iter()
            .flat_map(|s| &s.rows)
            .filter(|r| r.title == "one")
            .count(),
        1
    );
    let _ = fs::remove_dir_all(&root);
}
