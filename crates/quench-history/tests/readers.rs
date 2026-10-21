use quench_history::{
    discover_all, read_all, Author, CompactionTrigger, EventKind, HarnessId, Home, Session, Usage,
};
use std::path::{Path, PathBuf};

fn fixture_home() -> Home {
    Home::new(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/home"))
}

fn sessions(home: &Home) -> Vec<Session> {
    let mut out: Vec<Session> = read_all(&discover_all(home, None))
        .into_iter()
        .map(|r| r.expect("fixture sessions are readable"))
        .collect();
    out.sort_by(|a, b| (a.harness, &a.id).cmp(&(b.harness, &b.id)));
    out
}

fn one(harness: HarnessId, id: &str) -> Session {
    sessions(&fixture_home())
        .into_iter()
        .find(|s| s.harness == harness && s.id == id)
        .unwrap_or_else(|| panic!("no {harness:?} session {id}"))
}

fn messages(s: &Session, author: Author) -> Vec<String> {
    s.events
        .iter()
        .filter_map(|e| match &e.kind {
            EventKind::Message(m) if m.author == author => Some(m.text.clone()),
            _ => None,
        })
        .collect()
}

fn usages(s: &Session) -> Vec<Usage> {
    s.inferences().map(|i| i.usage).collect()
}

#[test]
fn discovers_every_harness_and_links_subagents() {
    let found: Vec<(HarnessId, String, Option<String>)> = sessions(&fixture_home())
        .into_iter()
        .map(|s| (s.harness, s.id, s.parent))
        .collect();
    assert_eq!(
        found,
        vec![
            (HarnessId::ClaudeCode, "agent-a1".into(), Some("s1".into())),
            (HarnessId::ClaudeCode, "s1".into(), None),
            (HarnessId::Codex, "c1".into(), None),
            (HarnessId::Pi, "p1".into(), None),
        ]
    );
}

#[test]
fn claude_code_separates_people_from_harness_text() {
    let s = one(HarnessId::ClaudeCode, "s1");
    assert_eq!(
        messages(&s, Author::User),
        vec![
            "Add a health check endpoint",
            "/review now",
            "<div> renders twice",
            "no, use the existing router"
        ]
    );
    assert_eq!(messages(&s, Author::Injected).len(), 2);
    assert_eq!(s.cwd.as_deref(), Some(Path::new("/work/demo")));
}

#[test]
fn claude_code_counts_each_model_call_once_with_its_final_usage() {
    let s = one(HarnessId::ClaudeCode, "s1");
    let calls: Vec<(Option<String>, Option<String>, u64, u64)> = s
        .inferences()
        .map(|i| {
            (
                i.model.clone(),
                i.effort.clone(),
                i.usage.context(),
                i.usage.output,
            )
        })
        .collect();
    assert_eq!(
        calls,
        vec![
            (
                Some("claude-opus-5-5".into()),
                Some("high".into()),
                21002,
                40
            ),
            (
                Some("claude-opus-5-5".into()),
                Some("medium".into()),
                30003,
                9
            ),
        ]
    );
}

#[test]
fn claude_code_reads_tool_errors_compactions_and_bad_lines() {
    let s = one(HarnessId::ClaudeCode, "s1");
    let errors: Vec<Option<bool>> = s
        .events
        .iter()
        .filter_map(|e| match &e.kind {
            EventKind::ToolResult(r) => Some(r.is_error),
            _ => None,
        })
        .collect();
    assert_eq!(errors, vec![Some(true)]);
    let compaction = s.events.iter().find_map(|e| match &e.kind {
        EventKind::Compaction(c) => Some((c.trigger, c.tokens_before)),
        _ => None,
    });
    assert_eq!(compaction, Some((CompactionTrigger::Auto, Some(180000))));
    assert_eq!(s.diagnostics.skipped, 1);
}

#[test]
fn codex_hides_injected_instructions_and_normalizes_cached_input() {
    let s = one(HarnessId::Codex, "c1");
    assert_eq!(messages(&s, Author::User), vec!["Fix the flaky test"]);
    assert_eq!(messages(&s, Author::Injected).len(), 3);
    assert_eq!(
        usages(&s),
        vec![Usage {
            input: 6804,
            cache_read: 11904,
            cache_write: 0,
            output: 13
        }]
    );
    let i = s.inferences().next().unwrap();
    assert_eq!(
        (i.model.as_deref(), i.effort.as_deref()),
        (Some("gpt-6.1-sol"), Some("high"))
    );
}

#[test]
fn pi_reads_usage_thinking_level_and_skips_empty_calls() {
    let s = one(HarnessId::Pi, "p1");
    assert_eq!(messages(&s, Author::User), vec!["Rename the module"]);
    assert_eq!(messages(&s, Author::Injected), vec!["You are Pi."]);
    assert_eq!(
        usages(&s),
        vec![Usage {
            input: 1774,
            cache_read: 200,
            cache_write: 0,
            output: 61
        }]
    );
    assert_eq!(
        s.inferences().next().unwrap().effort.as_deref(),
        Some("medium")
    );
}

#[test]
fn harness_dirs_follow_their_override_variables() {
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/home");
    let home = Home::new("/nonexistent")
        .with_var("CLAUDE_CONFIG_DIR", &path(&fixtures, ".claude"))
        .with_var("CODEX_HOME", &path(&fixtures, ".codex"))
        .with_var("PI_CODING_AGENT_DIR", &path(&fixtures, ".pi/agent"));
    assert_eq!(sessions(&home).len(), 4);
}

#[test]
fn a_home_without_any_harness_has_no_sessions() {
    let empty = tempfile::tempdir().unwrap();
    assert!(discover_all(&Home::new(empty.path()), None).is_empty());
}

fn path(base: &Path, rel: &str) -> String {
    PathBuf::from(base).join(rel).to_string_lossy().into_owned()
}
