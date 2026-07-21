//! The scanner — Quench's first real look at a machine (hone#13).
//!
//! It reports what harnesses live on this machine and which skills each one
//! sees, **with honest provenance**: every value carries the real path it came
//! from, so no count is ever fabricated (Quench's standing "no fake data" stance).
//! A skill that is a symlink into a source repo reports that repo as its origin;
//! a symlink whose target is gone is surfaced as `dangling`, never hidden.
//!
//! The whole crate is a lens over the filesystem (hone#2's prior-art audit).
//! Git integration and the sources/manifest model are later, Phase-2 work; this
//! is pure `std::fs`.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// One harness Quench knows how to look for, and where its facts live on disk.
struct HarnessSpec {
    id: &'static str,
    name: &'static str,
    /// Home dir relative to `$HOME` (e.g. `.claude`, `.pi/agent`).
    home: &'static str,
    /// Skills dir relative to `$HOME` (e.g. `.claude/skills`).
    skills: &'static str,
    /// Context files loaded into every session, relative to `$HOME`.
    context: &'static [&'static str],
}

/// The four harnesses in scope for the scaffold. Paths are the real canonical
/// locations verified on this machine (hone#13). Codex and Pi *do* carry a
/// skills dir now — the prior-art audit's "Codex has no skill loader" is stale
/// (hone#11 already flagged it), so both are scanned like the others.
const HARNESSES: &[HarnessSpec] = &[
    HarnessSpec {
        id: "claude-code",
        name: "Claude Code",
        home: ".claude",
        skills: ".claude/skills",
        context: &[".claude/CLAUDE.md"],
    },
    HarnessSpec {
        id: "codex",
        name: "Codex",
        home: ".codex",
        skills: ".codex/skills",
        context: &[".codex/AGENTS.md"],
    },
    HarnessSpec {
        id: "pi",
        name: "Pi",
        home: ".pi/agent",
        skills: ".pi/agent/skills",
        context: &[".pi/agent/AGENTS.md"],
    },
    HarnessSpec {
        id: "hermes",
        name: "Hermes",
        home: ".hermes",
        skills: ".hermes/skills",
        context: &[],
    },
];

/// A path Quench looked for and whether it was actually there — the provenance of
/// a "present / absent" claim.
#[derive(Debug, Clone, Serialize)]
pub struct Probe {
    pub path: PathBuf,
    pub present: bool,
}

impl Probe {
    fn at(path: PathBuf) -> Self {
        let present = path.exists();
        Probe { path, present }
    }
}

/// Where a skill physically lives and how Quench knows — the honesty contract in
/// one value. A count of skills is a count of these, each traceable to disk.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Origin {
    /// A real directory the harness owns directly.
    Local { path: PathBuf },
    /// A symlink into a source repo elsewhere — `target` is the true origin.
    Linked { link: PathBuf, target: PathBuf },
}

/// One discovered skill. `name`/`description` come from the SKILL.md that was
/// actually read (`manifest`); nothing is inferred beyond a fallback to the
/// directory name when the frontmatter omits `name`.
#[derive(Debug, Clone, Serialize)]
pub struct Skill {
    pub name: String,
    pub description: Option<String>,
    pub origin: Origin,
    /// The SKILL.md whose bytes produced `name`/`description`.
    pub manifest: PathBuf,
}

/// A context file (CLAUDE.md / AGENTS.md) present on disk, measured — the token
/// cost stays an estimate elsewhere, but the byte length is a real fact.
#[derive(Debug, Clone, Serialize)]
pub struct ContextFile {
    pub path: PathBuf,
    pub bytes: u64,
    /// Set when the context file is itself a symlink (content lives elsewhere).
    pub linked_to: Option<PathBuf>,
}

/// Everything the scanner found for one harness on this machine.
#[derive(Debug, Clone, Serialize)]
pub struct Harness {
    pub id: String,
    pub name: String,
    pub home: Probe,
    pub skills_dir: Probe,
    pub skills: Vec<Skill>,
    pub context_files: Vec<ContextFile>,
    /// Symlinks under the skills dir whose target is gone — real strays, shown
    /// rather than silently dropped.
    pub dangling: Vec<PathBuf>,
}

/// Project-local skills — the "strays" that live inside a project rather than a
/// harness's global dir (hone#13). Probed relative to the launch root; empty is
/// the honest answer when the launched project defines none.
#[derive(Debug, Clone, Serialize)]
pub struct ProjectScan {
    pub root: PathBuf,
    /// The project-local skill dirs Quench looked in (e.g. `<root>/.claude/skills`).
    pub probed: Vec<Probe>,
    pub skills: Vec<Skill>,
    pub dangling: Vec<PathBuf>,
}

/// The whole scan: one honest snapshot of this machine's harnesses and skills.
#[derive(Debug, Clone, Serialize)]
pub struct Scan {
    pub harnesses: Vec<Harness>,
    pub project: ProjectScan,
    /// Skill names that surface in more than one harness — a real cross-harness
    /// duplication signal, computed from the scan, not invented.
    pub duplicate_names: Vec<String>,
}

/// Scan this machine: global harnesses under `$HOME`, plus project-local skills
/// under the current working directory (the launch root).
pub fn scan_this_machine() -> Scan {
    let home = home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let project_root = std::env::current_dir().unwrap_or_else(|_| home.clone());
    scan(&home, &project_root)
}

/// Scan with explicit roots — the testable core (`home` supplies the global
/// harness dirs, `project_root` the project-local strays).
pub fn scan(home: &Path, project_root: &Path) -> Scan {
    let harnesses: Vec<Harness> = HARNESSES.iter().map(|spec| scan_harness(home, spec)).collect();

    let duplicate_names = duplicate_names(&harnesses);
    let project = scan_project(project_root);

    Scan {
        harnesses,
        project,
        duplicate_names,
    }
}

fn scan_harness(home: &Path, spec: &HarnessSpec) -> Harness {
    let skills_dir = Probe::at(home.join(spec.skills));

    let mut skills = Vec::new();
    let mut dangling = Vec::new();
    if skills_dir.present {
        collect_skills(&skills_dir.path, &mut skills, &mut dangling);
    }

    let context_files = spec
        .context
        .iter()
        .filter_map(|rel| context_file(&home.join(rel)))
        .collect();

    Harness {
        id: spec.id.to_string(),
        name: spec.name.to_string(),
        home: Probe::at(home.join(spec.home)),
        skills_dir,
        skills,
        context_files,
        dangling,
    }
}

/// Discover skills under a skills dir. Two real-world layouts coexist (hone#13):
/// flat `<skill>/SKILL.md` (Claude, Pi) and nested `<category>/<skill>/SKILL.md`
/// (Hermes). Hidden entries (`.DS_Store`, Codex's `.system`) are skipped, matching
/// the prior art's non-recursive glob. Symlinks are followed so vendored skills
/// resolve; a symlink whose target is gone becomes a `dangling` entry.
fn collect_skills(dir: &Path, skills: &mut Vec<Skill>, dangling: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if is_hidden(&path) {
            continue;
        }

        // A symlink whose target no longer exists: a real stray pointer.
        if is_dangling_symlink(&path) {
            dangling.push(path);
            continue;
        }

        let manifest = path.join("SKILL.md");
        if manifest.is_file() {
            // Flat layout: this entry is a skill.
            skills.push(read_skill(&path, manifest));
        } else if path.is_dir() {
            // Nested layout: this entry is a category of skills, one level deep.
            if let Ok(children) = std::fs::read_dir(&path) {
                for child in children.flatten() {
                    let cpath = child.path();
                    if is_hidden(&cpath) {
                        continue;
                    }
                    if is_dangling_symlink(&cpath) {
                        dangling.push(cpath);
                        continue;
                    }
                    let cmanifest = cpath.join("SKILL.md");
                    if cmanifest.is_file() {
                        skills.push(read_skill(&cpath, cmanifest));
                    }
                }
            }
        }
    }

    skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
}

/// Build a `Skill` from a skill dir and its SKILL.md, recording provenance.
fn read_skill(dir: &Path, manifest: PathBuf) -> Skill {
    let (name, description) = parse_frontmatter(&manifest);
    let name = name.unwrap_or_else(|| dir_name(dir));
    Skill {
        name,
        description,
        origin: origin_of(dir),
        manifest,
    }
}

/// A skill dir's origin: a symlink reports the resolved source repo, a real dir
/// reports itself.
fn origin_of(dir: &Path) -> Origin {
    match std::fs::symlink_metadata(dir) {
        Ok(meta) if meta.file_type().is_symlink() => {
            let target = std::fs::canonicalize(dir)
                .or_else(|_| std::fs::read_link(dir))
                .unwrap_or_else(|_| dir.to_path_buf());
            Origin::Linked {
                link: dir.to_path_buf(),
                target,
            }
        }
        _ => Origin::Local {
            path: dir.to_path_buf(),
        },
    }
}

fn context_file(path: &Path) -> Option<ContextFile> {
    let meta = std::fs::metadata(path).ok()?; // follows symlinks; None if target missing
    if !meta.is_file() {
        return None;
    }
    let linked_to = match std::fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => std::fs::canonicalize(path).ok(),
        _ => None,
    };
    Some(ContextFile {
        path: path.to_path_buf(),
        bytes: meta.len(),
        linked_to,
    })
}

/// Project-local skills: the same discovery, rooted at project-local harness
/// dirs (`<root>/.claude/skills`, etc.) rather than `$HOME`.
fn scan_project(root: &Path) -> ProjectScan {
    const PROJECT_SKILL_DIRS: &[&str] = &[
        ".claude/skills",
        ".codex/skills",
        ".pi/skills",
        ".hermes/skills",
    ];

    let mut probed = Vec::new();
    let mut skills = Vec::new();
    let mut dangling = Vec::new();

    for rel in PROJECT_SKILL_DIRS {
        let probe = Probe::at(root.join(rel));
        if probe.present {
            collect_skills(&probe.path, &mut skills, &mut dangling);
        }
        probed.push(probe);
    }

    skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    ProjectScan {
        root: root.to_path_buf(),
        probed,
        skills,
        dangling,
    }
}

/// Skill names appearing in more than one harness — the real cross-harness
/// duplication the prior art surfaced as conflicts (hone#2).
fn duplicate_names(harnesses: &[Harness]) -> Vec<String> {
    use std::collections::BTreeMap;
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for h in harnesses {
        // A name counts once per harness even if it repeats within one.
        let mut seen = std::collections::BTreeSet::new();
        for s in &h.skills {
            if seen.insert(s.name.to_lowercase()) {
                *counts.entry(s.name.clone()).or_insert(0) += 1;
            }
        }
    }
    counts
        .into_iter()
        .filter(|(_, n)| *n > 1)
        .map(|(name, _)| name)
        .collect()
}

// ---- small filesystem helpers (no regex, no yaml dep — hone#2) ----

/// Parse `name:` and `description:` out of a SKILL.md's leading `---` frontmatter.
/// Deliberately minimal: single-line scalars, optional surrounding quotes. Values
/// Quench can't read fall back to `None`, never to a guess.
fn parse_frontmatter(manifest: &Path) -> (Option<String>, Option<String>) {
    let text = match std::fs::read_to_string(manifest) {
        Ok(t) => t,
        Err(_) => return (None, None),
    };

    let mut lines = text.lines();
    // Frontmatter must open on the first line with a `---` fence.
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }

    let mut name = None;
    let mut description = None;
    for line in lines {
        let trimmed = line.trim_end();
        if trimmed.trim() == "---" {
            break; // end of frontmatter
        }
        if let Some(v) = trimmed.strip_prefix("name:") {
            name = scalar(v);
        } else if let Some(v) = trimmed.strip_prefix("description:") {
            description = scalar(v);
        }
    }
    (name, description)
}

/// Trim a YAML scalar value: surrounding whitespace and one layer of quotes.
fn scalar(raw: &str) -> Option<String> {
    let v = raw.trim();
    if v.is_empty() {
        return None;
    }
    let v = v
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .or_else(|| v.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
        .unwrap_or(v);
    let v = v.trim();
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

fn is_hidden(path: &Path) -> bool {
    dir_name_opt(path)
        .map(|n| n.starts_with('.'))
        .unwrap_or(false)
}

/// True only for a symlink whose target does not exist.
fn is_dangling_symlink(path: &Path) -> bool {
    matches!(std::fs::symlink_metadata(path), Ok(m) if m.file_type().is_symlink())
        && !path.exists()
}

fn dir_name(path: &Path) -> String {
    dir_name_opt(path).unwrap_or_default().to_string()
}

fn dir_name_opt(path: &Path) -> Option<&str> {
    path.file_name().and_then(|n| n.to_str())
}

/// Home dir from the environment. macOS/Linux use `HOME`; Windows `USERPROFILE`.
/// Kept dependency-free (quench-core stays serde-only).
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Build a throwaway machine layout under a temp dir and scan it, so the
    /// tests assert on real filesystem behavior (symlinks, nesting, dangling)
    /// rather than mocks.
    fn temp_root(tag: &str) -> PathBuf {
        let mut base = std::env::temp_dir();
        // Unique-enough without Math.random/time: pid + tag.
        base.push(format!("quench-scan-test-{}-{}", std::process::id(), tag));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    fn write_skill(dir: &Path, name: &str, desc: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {desc}\n---\n\n# {name}\n"),
        )
        .unwrap();
    }

    #[test]
    fn finds_flat_nested_and_linked_skills_with_provenance() {
        let root = temp_root("layouts");
        let home = root.join("home");

        // Claude: flat skill + a symlink into a "source repo".
        let src_repo = root.join("repo/skills/planning/grill-me");
        write_skill(&src_repo, "grill-me", "grill a plan");
        let claude = home.join(".claude/skills");
        write_skill(&claude.join("diagnose"), "diagnose", "debug hard bugs");
        std::os::unix::fs::symlink(&src_repo, claude.join("grill-me")).unwrap();

        // Hermes: nested category/skill + the same-named "grill-me" (a duplicate).
        let hermes = home.join(".hermes/skills");
        write_skill(&hermes.join("apple/apple-notes"), "apple-notes", "notes");
        write_skill(&hermes.join("planning/grill-me"), "grill-me", "grill");

        let scan = scan(&home, &root.join("empty-project"));

        let claude_h = scan.harnesses.iter().find(|h| h.id == "claude-code").unwrap();
        assert!(claude_h.home.present && claude_h.skills_dir.present);
        assert_eq!(claude_h.skills.len(), 2, "flat + linked");

        // The linked skill reports the source repo as its origin, not the link.
        let linked = claude_h.skills.iter().find(|s| s.name == "grill-me").unwrap();
        match &linked.origin {
            Origin::Linked { target, .. } => {
                assert!(target.ends_with("planning/grill-me"), "resolves to source repo");
            }
            other => panic!("expected Linked origin, got {other:?}"),
        }
        assert_eq!(linked.description.as_deref(), Some("grill a plan"));

        let hermes_h = scan.harnesses.iter().find(|h| h.id == "hermes").unwrap();
        assert_eq!(hermes_h.skills.len(), 2, "nested apple-notes + grill-me");
        assert!(hermes_h.skills.iter().all(|s| matches!(s.origin, Origin::Local { .. })));

        // grill-me is in both Claude and Hermes → a real cross-harness duplicate.
        assert!(scan.duplicate_names.contains(&"grill-me".to_string()));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn dangling_symlink_is_surfaced_not_counted() {
        let root = temp_root("dangling");
        let home = root.join("home");
        let claude = home.join(".claude/skills");
        fs::create_dir_all(&claude).unwrap();
        std::os::unix::fs::symlink(root.join("gone"), claude.join("ghost")).unwrap();

        let scan = scan(&home, &root.join("noproj"));
        let claude_h = scan.harnesses.iter().find(|h| h.id == "claude-code").unwrap();
        assert!(claude_h.skills.is_empty(), "a broken link is not a skill");
        assert_eq!(claude_h.dangling.len(), 1, "but it is surfaced");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn absent_harness_reports_absent_without_inventing() {
        let root = temp_root("absent");
        let home = root.join("home");
        fs::create_dir_all(&home).unwrap();

        let scan = scan(&home, &home);
        for h in &scan.harnesses {
            assert!(!h.home.present, "{} home should be absent", h.id);
            assert!(!h.skills_dir.present);
            assert!(h.skills.is_empty());
        }

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn project_strays_are_found_under_the_root() {
        let root = temp_root("project");
        let home = root.join("home");
        let proj = root.join("proj");
        write_skill(&proj.join(".claude/skills/local-helper"), "local-helper", "stray");

        let scan = scan(&home, &proj);
        assert_eq!(scan.project.skills.len(), 1);
        assert_eq!(scan.project.skills[0].name, "local-helper");
        assert!(scan.project.probed.iter().any(|p| p.present));

        let _ = fs::remove_dir_all(&root);
    }
}
