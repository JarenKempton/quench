use crate::scan::{collect_skills, home_dir, Origin};
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

const MAX_IMPORT_DEPTH: usize = 5;
const BYTES_PER_TOKEN: u64 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Machine,
    Project,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ItemKind {
    Instructions {
        imported_by: Option<PathBuf>,
    },
    Skill {
        name: String,
        description: Option<String>,
        origin: Origin,
        model_invocable: bool,
    },
    Unscanned {
        what: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct ContextItem {
    pub scope: Scope,
    pub path: PathBuf,
    #[serde(flatten)]
    pub kind: ItemKind,
    pub always_bytes: u64,
    pub on_demand_bytes: u64,
    pub duplicate_of: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Estimate {
    pub tokens: u64,
    pub method: &'static str,
}

impl Estimate {
    fn from_bytes(bytes: u64) -> Self {
        Estimate {
            tokens: bytes.div_ceil(BYTES_PER_TOKEN),
            method: "bytes/3",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ContextLoad {
    pub harness: &'static str,
    pub project_root: PathBuf,
    pub items: Vec<ContextItem>,
    pub always_bytes: u64,
    pub always_tokens: Estimate,
}

pub fn context_for_this_machine(project_root: &Path) -> ContextLoad {
    let home = home_dir().unwrap_or_else(|| PathBuf::from("/"));
    claude_code_context(&home, project_root)
}

pub fn claude_code_context(home: &Path, project_root: &Path) -> ContextLoad {
    let project_root =
        std::fs::canonicalize(project_root).unwrap_or_else(|_| project_root.to_path_buf());
    let mut seen = Seen::default();
    let mut items = Vec::new();

    let mut instruction_files = vec![(Scope::Machine, home.join(".claude/CLAUDE.md"))];
    let mut ancestors: Vec<&Path> = project_root
        .ancestors()
        .filter(|d| d.parent().is_some())
        .collect();
    ancestors.reverse();
    for dir in ancestors {
        for name in ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"] {
            instruction_files.push((Scope::Project, dir.join(name)));
        }
    }
    instruction_files.push((Scope::Project, auto_memory(home, &project_root)));
    for (scope, path) in instruction_files {
        push_instructions(&mut items, &mut seen, home, scope, &path, None, 0);
    }

    for (scope, dir) in [
        (Scope::Machine, home.join(".claude/skills")),
        (Scope::Project, project_root.join(".claude/skills")),
    ] {
        let mut skills = Vec::new();
        let mut dangling = Vec::new();
        collect_skills(&dir, &mut skills, &mut dangling);
        for skill in skills {
            let on_demand = std::fs::metadata(&skill.manifest)
                .map(|m| m.len())
                .unwrap_or(0);
            let index = if skill.model_invocable {
                (skill.name.len() + skill.description.as_ref().map_or(0, String::len)) as u64
            } else {
                0
            };
            let duplicate_of = seen.claim_path(&skill.manifest);
            items.push(ContextItem {
                scope,
                path: skill.manifest.clone(),
                kind: ItemKind::Skill {
                    name: skill.name,
                    description: skill.description,
                    origin: skill.origin,
                    model_invocable: skill.model_invocable,
                },
                always_bytes: index,
                on_demand_bytes: on_demand,
                duplicate_of,
            });
        }
    }

    for (what, path) in [
        ("MCP servers", home.join(".claude.json")),
        (
            "plugin skills, commands and agents",
            home.join(".claude/plugins"),
        ),
    ] {
        if path.exists() {
            items.push(ContextItem {
                scope: Scope::Machine,
                path,
                kind: ItemKind::Unscanned {
                    what: what.to_string(),
                },
                always_bytes: 0,
                on_demand_bytes: 0,
                duplicate_of: None,
            });
        }
    }

    let always_bytes = items
        .iter()
        .filter(|i| i.duplicate_of.is_none())
        .map(|i| i.always_bytes)
        .sum();
    ContextLoad {
        harness: "claude-code",
        project_root,
        items,
        always_bytes,
        always_tokens: Estimate::from_bytes(always_bytes),
    }
}

fn auto_memory(home: &Path, project_root: &Path) -> PathBuf {
    let slug: String = main_checkout(project_root)
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    home.join(".claude/projects")
        .join(slug)
        .join("memory/MEMORY.md")
}

fn main_checkout(project_root: &Path) -> PathBuf {
    let top = project_root.ancestors().find(|d| d.join(".git").exists());
    let Some(top) = top else {
        return project_root.to_path_buf();
    };
    let Ok(pointer) = std::fs::read_to_string(top.join(".git")) else {
        return top.to_path_buf();
    };
    pointer
        .trim()
        .strip_prefix("gitdir:")
        .map(|g| PathBuf::from(g.trim()))
        .and_then(|g| {
            g.ancestors()
                .find(|a| a.file_name().is_some_and(|n| n == ".git"))
                .and_then(Path::parent)
                .map(Path::to_path_buf)
        })
        .unwrap_or_else(|| top.to_path_buf())
}

#[derive(Default)]
struct Seen {
    paths: HashMap<PathBuf, PathBuf>,
    contents: HashMap<u64, PathBuf>,
    visiting: HashSet<PathBuf>,
}

impl Seen {
    fn claim_path(&mut self, path: &Path) -> Option<PathBuf> {
        let real = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        if let Some(first) = self.paths.get(&real) {
            return Some(first.clone());
        }
        self.paths.insert(real, path.to_path_buf());
        None
    }

    fn claim(&mut self, path: &Path, text: &str) -> Option<PathBuf> {
        if let Some(first) = self.claim_path(path) {
            return Some(first);
        }
        let mut h = DefaultHasher::new();
        text.hash(&mut h);
        let key = h.finish();
        if let Some(first) = self.contents.get(&key) {
            return Some(first.clone());
        }
        self.contents.insert(key, path.to_path_buf());
        None
    }
}

fn push_instructions(
    items: &mut Vec<ContextItem>,
    seen: &mut Seen,
    home: &Path,
    scope: Scope,
    path: &Path,
    imported_by: Option<&Path>,
    depth: usize,
) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    let duplicate_of = seen.claim(path, &text);
    if duplicate_of.as_deref() == Some(path) {
        return;
    }
    let is_duplicate = duplicate_of.is_some();
    items.push(ContextItem {
        scope,
        path: path.to_path_buf(),
        kind: ItemKind::Instructions {
            imported_by: imported_by.map(Path::to_path_buf),
        },
        always_bytes: text.len() as u64,
        on_demand_bytes: 0,
        duplicate_of,
    });
    if is_duplicate || depth >= MAX_IMPORT_DEPTH {
        return;
    }
    let real = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if !seen.visiting.insert(real.clone()) {
        return;
    }
    let base = path.parent().unwrap_or(Path::new("/"));
    for target in imports(&text) {
        let resolved = match target.strip_prefix("~/") {
            Some(rest) => home.join(rest),
            None => base.join(target),
        };
        if resolved.is_file() {
            push_instructions(items, seen, home, scope, &resolved, Some(path), depth + 1);
        }
    }
    seen.visiting.remove(&real);
}

fn imports(text: &str) -> Vec<&str> {
    let mut fenced = false;
    let mut out = Vec::new();
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        for word in line.split_whitespace() {
            if word.contains('`') {
                continue;
            }
            let Some(target) = word.strip_prefix('@') else {
                continue;
            };
            let target = target.trim_end_matches(['.', ',', ';', ':', ')', '!', '?']);
            if !target.is_empty() && (target.contains('/') || target.contains('.')) {
                out.push(target);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn root(tag: &str) -> PathBuf {
        let base =
            std::env::temp_dir().join(format!("quench-context-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        fs::canonicalize(base).unwrap()
    }

    fn instructions(load: &ContextLoad) -> Vec<(&Path, Option<&Path>)> {
        load.items
            .iter()
            .filter(|i| matches!(i.kind, ItemKind::Instructions { .. }))
            .map(|i| (i.path.as_path(), i.duplicate_of.as_deref()))
            .collect()
    }

    #[test]
    fn instruction_chain_runs_machine_then_ancestors_then_imports() {
        let r = root("chain");
        let home = r.join("home");
        let proj = r.join("work/api");
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::create_dir_all(proj.join("docs")).unwrap();
        fs::write(home.join(".claude/CLAUDE.md"), "global rules").unwrap();
        fs::write(r.join("work/CLAUDE.md"), "parent rules").unwrap();
        fs::write(
            proj.join("CLAUDE.md"),
            "see @docs/style.md and `@not/this.md`\n```\n@fenced/x.md\n```\n",
        )
        .unwrap();
        fs::write(proj.join("docs/style.md"), "style").unwrap();
        fs::write(proj.join("CLAUDE.local.md"), "mine").unwrap();

        let load = claude_code_context(&home, &proj);
        let paths: Vec<PathBuf> = instructions(&load)
            .iter()
            .map(|(p, _)| p.to_path_buf())
            .collect();
        assert_eq!(
            paths,
            vec![
                home.join(".claude/CLAUDE.md"),
                r.join("work/CLAUDE.md"),
                proj.join("CLAUDE.md"),
                proj.join("docs/style.md"),
                proj.join("CLAUDE.local.md"),
            ]
        );
        let imported = load
            .items
            .iter()
            .find(|i| i.path.ends_with("docs/style.md"))
            .unwrap();
        assert!(
            matches!(&imported.kind, ItemKind::Instructions { imported_by: Some(p) } if p.ends_with("api/CLAUDE.md"))
        );
        assert_eq!(imported.scope, Scope::Project);
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn symlinked_and_identical_files_count_once() {
        let r = root("dedupe");
        let home = r.join("home");
        let proj = r.join("proj");
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::create_dir_all(&proj).unwrap();
        fs::write(proj.join("AGENTS.md"), "shared rules 0123456789").unwrap();
        std::os::unix::fs::symlink(proj.join("AGENTS.md"), proj.join("CLAUDE.md")).unwrap();
        fs::write(proj.join("CLAUDE.local.md"), "shared rules 0123456789").unwrap();

        let load = claude_code_context(&home, &proj);
        let found = instructions(&load);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0], (proj.join("CLAUDE.md").as_path(), None));
        assert_eq!(found[1].1, Some(proj.join("CLAUDE.md").as_path()));
        assert_eq!(load.always_bytes, 23);
        assert_eq!(
            load.always_tokens,
            Estimate {
                tokens: 8,
                method: "bytes/3"
            }
        );
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn project_at_home_lists_the_machine_file_once() {
        let r = root("home-proj");
        let home = r.join("home");
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::write(home.join(".claude/CLAUDE.md"), "global").unwrap();
        let load = claude_code_context(&home, &home);
        assert_eq!(
            instructions(&load),
            vec![(home.join(".claude/CLAUDE.md").as_path(), None)]
        );
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn agents_md_without_a_bridge_is_not_loaded() {
        let r = root("agents");
        let home = r.join("home");
        let proj = r.join("proj");
        fs::create_dir_all(&proj).unwrap();
        fs::write(proj.join("AGENTS.md"), "codex only").unwrap();
        let load = claude_code_context(&home, &proj);
        assert!(instructions(&load).is_empty());
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn skills_cost_their_index_always_and_their_body_on_demand() {
        let r = root("skills");
        let home = r.join("home");
        let proj = r.join("proj");
        let dir = proj.join(".claude/skills/ship");
        fs::create_dir_all(&dir).unwrap();
        let body = "---\nname: ship\ndescription: Ship it.\n---\n\nLong body here.\n";
        fs::write(dir.join("SKILL.md"), body).unwrap();

        let load = claude_code_context(&home, &proj);
        let skill = load
            .items
            .iter()
            .find(|i| matches!(i.kind, ItemKind::Skill { .. }))
            .unwrap();
        assert_eq!(skill.scope, Scope::Project);
        assert_eq!(skill.always_bytes, ("ship".len() + "Ship it.".len()) as u64);
        assert_eq!(skill.on_demand_bytes, body.len() as u64);
        assert_eq!(load.always_bytes, skill.always_bytes);
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn skills_hidden_from_the_model_cost_nothing_up_front() {
        let r = root("hidden");
        let home = r.join("home");
        let dir = home.join(".claude/skills/handoff");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            "---\nname: handoff\ndescription: Hand off.\ndisable-model-invocation: true\n---\n",
        )
        .unwrap();
        let load = claude_code_context(&home, &r);
        let skill = load
            .items
            .iter()
            .find(|i| matches!(i.kind, ItemKind::Skill { .. }))
            .unwrap();
        assert_eq!(skill.always_bytes, 0);
        assert!(skill.on_demand_bytes > 0);
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn auto_memory_of_a_worktree_is_the_main_checkouts() {
        let r = root("automem");
        let home = r.join("home");
        let main = r.join("src/app");
        let wt = r.join("wt/feature");
        fs::create_dir_all(main.join(".git/worktrees/feature")).unwrap();
        fs::create_dir_all(&wt).unwrap();
        fs::write(
            wt.join(".git"),
            format!(
                "gitdir: {}\n",
                main.join(".git/worktrees/feature").display()
            ),
        )
        .unwrap();
        let slug: String = main
            .to_string_lossy()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        let mem = home
            .join(".claude/projects")
            .join(slug)
            .join("memory/MEMORY.md");
        fs::create_dir_all(mem.parent().unwrap()).unwrap();
        fs::write(&mem, "- remembered").unwrap();
        let load = claude_code_context(&home, &wt);
        assert!(load.items.iter().any(|i| i.path == mem));
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn import_cycles_terminate() {
        let r = root("cycle");
        let home = r.join("home");
        let proj = r.join("proj");
        fs::create_dir_all(&proj).unwrap();
        fs::write(proj.join("CLAUDE.md"), "@a.md").unwrap();
        fs::write(proj.join("a.md"), "@CLAUDE.md and @b.md").unwrap();
        fs::write(proj.join("b.md"), "@a.md b").unwrap();
        let load = claude_code_context(&home, &proj);
        assert_eq!(
            instructions(&load)
                .iter()
                .filter(|(_, d)| d.is_none())
                .count(),
            3
        );
        let _ = fs::remove_dir_all(&r);
    }
}
