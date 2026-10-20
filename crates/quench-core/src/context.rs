use crate::identity::{project_key, ProjectKey};
use crate::mcp::{claude_code_mcp_servers, McpScope, McpServer};
use crate::overrides::{resolve_overrides, ResolvedOverride, SkillOverride};
use crate::scan::frontmatter_fields;
use crate::scan::{collect_skills, home_dir, Origin};
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

const MAX_IMPORT_DEPTH: usize = 4;
const MEMORY_LINES: usize = 200;
const MEMORY_BYTES: usize = 25 * 1024;
const CLAUDE_FILES: [&str; 3] = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"];
const AGENTS_FILES: [&str; 2] = ["AGENTS.md", ".claude/AGENTS.md"];
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
        external: bool,
        path_scoped: bool,
        truncated: bool,
    },
    Skill {
        name: String,
        description: Option<String>,
        origin: Origin,
        model_invocable: bool,
        setting: ResolvedOverride,
    },
    McpServer(McpServer),
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
    pub same_content_as: Option<PathBuf>,
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
    pub project: ProjectKey,
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

    let mut ancestors: Vec<&Path> = project_root
        .ancestors()
        .filter(|d| d.parent().is_some())
        .collect();
    ancestors.reverse();
    let user_file = home.join(".claude/CLAUDE.md");
    let has_claude_file = ancestors.iter().any(|d| {
        CLAUDE_FILES
            .iter()
            .map(|n| d.join(n))
            .any(|f| f.is_file() && f != user_file)
    });
    let project_names: &[&str] = if has_claude_file {
        &CLAUDE_FILES
    } else {
        &AGENTS_FILES
    };

    let mut ctx = Loader {
        items: &mut items,
        seen: &mut seen,
        home,
        project_root: &project_root,
    };
    ctx.instructions(Scope::Machine, &managed_dir().join("CLAUDE.md"), None, 0);
    ctx.instructions(Scope::Machine, &user_file, None, 0);
    ctx.rules(Scope::Machine, &home.join(".claude/rules"));
    for dir in &ancestors {
        for name in project_names {
            ctx.instructions(Scope::Project, &dir.join(name), None, 0);
        }
    }
    ctx.rules(Scope::Project, &project_root.join(".claude/rules"));
    ctx.memory(&auto_memory(home, &project_root));

    let overrides = resolve_overrides(home, &project_root);
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
            let setting = overrides
                .get(&skill.name)
                .cloned()
                .unwrap_or_else(ResolvedOverride::default_on);
            let description = skill.description.as_ref().map_or(0, String::len);
            let index = match (skill.model_invocable, setting.value) {
                (false, _) | (_, SkillOverride::Off | SkillOverride::UserInvocableOnly) => 0,
                (true, SkillOverride::NameOnly) => skill.name.len(),
                (true, SkillOverride::On) => skill.name.len() + description,
            } as u64;
            let duplicate_of = seen.claim_path(&skill.manifest);
            if duplicate_of.as_deref() == Some(skill.manifest.as_path()) {
                continue;
            }
            items.push(ContextItem {
                scope,
                path: skill.manifest.clone(),
                kind: ItemKind::Skill {
                    name: skill.name,
                    description: skill.description,
                    origin: skill.origin,
                    model_invocable: skill.model_invocable,
                    setting,
                },
                always_bytes: index,
                on_demand_bytes: on_demand,
                duplicate_of,
                same_content_as: None,
            });
        }
    }

    let mut keys = vec![project_root.clone()];
    let main = main_checkout(&project_root);
    if main != project_root {
        keys.push(main);
    }
    for server in claude_code_mcp_servers(home, &project_root, &keys) {
        items.push(ContextItem {
            scope: if server.config_scope == McpScope::User {
                Scope::Machine
            } else {
                Scope::Project
            },
            path: server.source.clone(),
            kind: ItemKind::McpServer(server),
            always_bytes: 0,
            on_demand_bytes: 0,
            duplicate_of: None,
            same_content_as: None,
        });
    }

    let plugins = home.join(".claude/plugins");
    if plugins.exists() {
        items.push(ContextItem {
            scope: Scope::Machine,
            path: plugins,
            kind: ItemKind::Unscanned {
                what: "plugin skills, commands, agents and MCP servers".to_string(),
            },
            always_bytes: 0,
            on_demand_bytes: 0,
            duplicate_of: None,
            same_content_as: None,
        });
    }

    let always_bytes = items
        .iter()
        .filter(|i| i.duplicate_of.is_none())
        .map(|i| i.always_bytes)
        .sum();
    ContextLoad {
        harness: "claude-code",
        project: project_key(&project_root),
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

fn managed_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/Library/Application Support/ClaudeCode")
    } else if cfg!(windows) {
        PathBuf::from(r"C:\Program Files\ClaudeCode")
    } else {
        PathBuf::from("/etc/claude-code")
    }
}

pub(crate) fn main_checkout(project_root: &Path) -> PathBuf {
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
        .map(|g| top.join(g.trim()))
        .and_then(|g| {
            let g = std::fs::canonicalize(&g).unwrap_or(g);
            g.ancestors()
                .find(|a| a.file_name().is_some_and(|n| n == "worktrees"))
                .and_then(Path::parent)
                .filter(|git| git.file_name().is_some_and(|n| n == ".git"))
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

    fn same_content(&mut self, path: &Path, text: &str) -> Option<PathBuf> {
        let mut h = DefaultHasher::new();
        text.hash(&mut h);
        let first = self
            .contents
            .entry(h.finish())
            .or_insert_with(|| path.to_path_buf());
        (first != path).then(|| first.clone())
    }
}

struct Loader<'a> {
    items: &'a mut Vec<ContextItem>,
    seen: &'a mut Seen,
    home: &'a Path,
    project_root: &'a Path,
}

impl Loader<'_> {
    fn claim(&mut self, path: &Path) -> Option<Option<PathBuf>> {
        match self.seen.claim_path(path) {
            Some(first) if first == path => None,
            other => Some(other),
        }
    }

    fn push(
        &mut self,
        scope: Scope,
        path: &Path,
        kind: ItemKind,
        text: &str,
        (always, on_demand): (u64, u64),
        duplicate_of: Option<PathBuf>,
    ) {
        let same_content_as = match duplicate_of {
            Some(_) => None,
            None => self.seen.same_content(path, text),
        };
        self.items.push(ContextItem {
            scope,
            path: path.to_path_buf(),
            kind,
            always_bytes: always,
            on_demand_bytes: on_demand,
            duplicate_of,
            same_content_as,
        });
    }

    fn instructions(
        &mut self,
        scope: Scope,
        path: &Path,
        imported_by: Option<&Path>,
        depth: usize,
    ) {
        let Ok(text) = std::fs::read_to_string(path) else {
            return;
        };
        let Some(duplicate_of) = self.claim(path) else {
            return;
        };
        let loaded = strip_html_comments(&text);
        let external = imported_by.is_some()
            && scope == Scope::Project
            && !path.starts_with(self.project_root);
        let is_duplicate = duplicate_of.is_some();
        let kind = ItemKind::Instructions {
            imported_by: imported_by.map(Path::to_path_buf),
            external,
            path_scoped: false,
            truncated: false,
        };
        self.push(
            scope,
            path,
            kind,
            &text,
            (loaded.len() as u64, 0),
            duplicate_of,
        );
        if is_duplicate || depth >= MAX_IMPORT_DEPTH {
            return;
        }
        let real = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        if !self.seen.visiting.insert(real.clone()) {
            return;
        }
        let base = path.parent().unwrap_or(Path::new("/")).to_path_buf();
        for target in imports(&loaded) {
            let resolved = match target.strip_prefix("~/") {
                Some(rest) => self.home.join(rest),
                None => base.join(&target),
            };
            if resolved.is_file() {
                self.instructions(scope, &resolved, Some(path), depth + 1);
            }
        }
        self.seen.visiting.remove(&real);
    }

    fn rules(&mut self, scope: Scope, dir: &Path) {
        let mut files = Vec::new();
        markdown_files(dir, &mut files, 0);
        files.sort();
        for file in files {
            let Ok(text) = std::fs::read_to_string(&file) else {
                continue;
            };
            let Some(duplicate_of) = self.claim(&file) else {
                continue;
            };
            let scoped = frontmatter_fields(&text).has_paths;
            let size = text.len() as u64;
            let kind = ItemKind::Instructions {
                imported_by: None,
                external: false,
                path_scoped: scoped,
                truncated: false,
            };
            let (always, on_demand) = if scoped { (0, size) } else { (size, 0) };
            self.push(scope, &file, kind, &text, (always, on_demand), duplicate_of);
        }
    }

    fn memory(&mut self, path: &Path) {
        let Ok(text) = std::fs::read_to_string(path) else {
            return;
        };
        let Some(duplicate_of) = self.claim(path) else {
            return;
        };
        let mut loaded = 0;
        for (n, line) in text.split_inclusive('\n').enumerate() {
            if n >= MEMORY_LINES || loaded + line.len() > MEMORY_BYTES {
                break;
            }
            loaded += line.len();
        }
        let kind = ItemKind::Instructions {
            imported_by: None,
            external: false,
            path_scoped: false,
            truncated: loaded < text.len(),
        };
        self.push(
            Scope::Project,
            path,
            kind,
            &text,
            (loaded as u64, (text.len() - loaded) as u64),
            duplicate_of,
        );
    }
}

fn markdown_files(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 16 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            markdown_files(&path, out, depth + 1);
        } else if path.extension().is_some_and(|e| e == "md") {
            out.push(path);
        }
    }
}

fn strip_html_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut fence: Option<&str> = None;
    let mut in_comment = false;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_start();
        if !in_comment {
            if let Some(open) = fence {
                if trimmed.starts_with(open) {
                    fence = None;
                }
                out.push_str(line);
                continue;
            }
            if let Some(open) = ["```", "~~~"].into_iter().find(|f| trimmed.starts_with(f)) {
                fence = Some(open);
                out.push_str(line);
                continue;
            }
            if trimmed.starts_with("<!--") {
                in_comment = true;
            } else {
                out.push_str(line);
                continue;
            }
        }
        if line.contains("-->") {
            in_comment = false;
        }
    }
    out
}

fn imports(text: &str) -> Vec<String> {
    let mut fence: Option<&str> = None;
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        if let Some(open) = fence {
            if trimmed.starts_with(open) {
                fence = None;
            }
            continue;
        }
        if let Some(open) = ["```", "~~~"].into_iter().find(|f| trimmed.starts_with(f)) {
            fence = Some(open);
            continue;
        }
        let mut prose = String::new();
        for (i, part) in line.split('`').enumerate() {
            if i % 2 == 0 {
                prose.push_str(part);
                prose.push(' ');
            }
        }
        let prose = prose.replace("\\ ", "\u{0}");
        for word in prose.split_whitespace() {
            let Some(target) = word.strip_prefix('@') else {
                continue;
            };
            let target = target
                .trim_end_matches(['.', ',', ';', ':', ')', '!', '?'])
                .replace('\u{0}', " ");
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
            matches!(&imported.kind, ItemKind::Instructions { imported_by: Some(p), .. } if p.ends_with("api/CLAUDE.md"))
        );
        assert_eq!(imported.scope, Scope::Project);
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn a_symlinked_file_counts_once_and_identical_files_both_count() {
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
        assert_eq!(
            found.len(),
            2,
            "AGENTS.md is not read when a CLAUDE.md exists"
        );
        assert_eq!(found[0], (proj.join("CLAUDE.md").as_path(), None));
        let local = &load.items[1];
        assert_eq!(local.duplicate_of, None);
        assert_eq!(
            local.same_content_as.as_deref(),
            Some(proj.join("CLAUDE.md").as_path())
        );
        assert_eq!(load.always_bytes, 46);
        assert_eq!(
            load.always_tokens,
            Estimate {
                tokens: 16,
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
    fn agents_md_loads_only_when_no_claude_file_exists_above() {
        let r = root("agents");
        let home = r.join("home");
        let proj = r.join("repo/app");
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::write(home.join(".claude/CLAUDE.md"), "user rules").unwrap();
        fs::create_dir_all(proj.join(".claude")).unwrap();
        fs::write(r.join("repo/AGENTS.md"), "root agents").unwrap();
        fs::write(proj.join(".claude/AGENTS.md"), "app agents").unwrap();
        let paths = |load: &ContextLoad| -> Vec<PathBuf> {
            instructions(load)
                .iter()
                .map(|(p, _)| p.to_path_buf())
                .collect()
        };
        assert_eq!(
            paths(&claude_code_context(&home, &proj)),
            vec![
                home.join(".claude/CLAUDE.md"),
                r.join("repo/AGENTS.md"),
                proj.join(".claude/AGENTS.md")
            ],
            "the user CLAUDE.md does not suppress AGENTS.md"
        );
        fs::write(r.join("repo/CLAUDE.local.md"), "mine").unwrap();
        assert_eq!(
            paths(&claude_code_context(&home, &proj)),
            vec![
                home.join(".claude/CLAUDE.md"),
                r.join("repo/CLAUDE.local.md")
            ]
        );
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn rules_load_at_launch_unless_path_scoped() {
        let r = root("rules");
        let home = r.join("home");
        let proj = r.join("proj");
        fs::create_dir_all(home.join(".claude/rules")).unwrap();
        fs::create_dir_all(proj.join(".claude/rules/api")).unwrap();
        fs::write(home.join(".claude/rules/me.md"), "be brief").unwrap();
        fs::write(proj.join(".claude/rules/testing.md"), "run tests").unwrap();
        let scoped = "---\npaths:\n  - \"src/api/**\"\n---\nuse zod\n";
        fs::write(proj.join(".claude/rules/api/zod.md"), scoped).unwrap();
        let load = claude_code_context(&home, &proj);
        let cost = |name: &str| {
            let item = load.items.iter().find(|i| i.path.ends_with(name)).unwrap();
            (item.scope, item.always_bytes, item.on_demand_bytes)
        };
        assert_eq!(cost("me.md"), (Scope::Machine, 8, 0));
        assert_eq!(cost("testing.md"), (Scope::Project, 9, 0));
        assert_eq!(cost("zod.md"), (Scope::Project, 0, scoped.len() as u64));
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn memory_counts_only_the_first_200_lines() {
        let r = root("memory");
        let home = r.join("home");
        let mem = home
            .join(".claude/projects")
            .join(
                r.to_string_lossy()
                    .replace(|c: char| !c.is_ascii_alphanumeric(), "-"),
            )
            .join("memory/MEMORY.md");
        fs::create_dir_all(mem.parent().unwrap()).unwrap();
        fs::write(&mem, "- note\n".repeat(1000)).unwrap();
        let load = claude_code_context(&home, &r);
        let item = load.items.iter().find(|i| i.path == mem).unwrap();
        assert_eq!(
            (item.always_bytes, item.on_demand_bytes),
            (200 * 7, 800 * 7)
        );
        assert!(matches!(
            item.kind,
            ItemKind::Instructions {
                truncated: true,
                ..
            }
        ));
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn comments_code_and_fences_are_not_imported_or_counted() {
        let r = root("parse");
        let home = r.join("home");
        let proj = r.join("proj");
        fs::create_dir_all(&proj).unwrap();
        for f in ["a.md", "b.md", "c.md", "d.md", "my notes.md"] {
            fs::write(proj.join(f), f).unwrap();
        }
        let body = "keep\n<!-- hidden\n@d.md\n-->\nsee `run @a.md now` and mail me@x.io\n~~~\n@b.md\n~~~\n```\n@c.md\n```\n@my\\ notes.md\n";
        fs::write(proj.join("CLAUDE.md"), body).unwrap();
        let load = claude_code_context(&home, &proj);
        let names: Vec<String> = instructions(&load)
            .iter()
            .map(|(p, _)| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["CLAUDE.md", "my notes.md"]);
        let claude = load
            .items
            .iter()
            .find(|i| i.path.ends_with("CLAUDE.md"))
            .unwrap();
        assert_eq!(
            claude.always_bytes,
            (body.len() - "<!-- hidden\n@d.md\n-->\n".len()) as u64
        );
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn imports_stop_after_four_hops() {
        let r = root("depth");
        let home = r.join("home");
        let proj = r.join("proj");
        fs::create_dir_all(&proj).unwrap();
        fs::write(proj.join("CLAUDE.md"), "@d1.md").unwrap();
        for n in 1..=5 {
            fs::write(proj.join(format!("d{n}.md")), format!("@d{}.md", n + 1)).unwrap();
        }
        let load = claude_code_context(&home, &proj);
        assert!(load.items.iter().any(|i| i.path.ends_with("d4.md")));
        assert!(!load.items.iter().any(|i| i.path.ends_with("d5.md")));
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
            "gitdir: ../../src/app/.git/worktrees/feature\n",
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
    fn skill_overrides_change_what_a_skill_costs() {
        let r = root("overrides");
        let home = r.join("home");
        let proj = r.join("proj");
        for name in ["full", "named", "gone", "slash"] {
            let dir = home.join(".claude/skills").join(name);
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("SKILL.md"),
                format!("---\nname: {name}\ndescription: twelve chars\n---\n"),
            )
            .unwrap();
        }
        fs::create_dir_all(proj.join(".claude")).unwrap();
        fs::write(
            proj.join(".claude/settings.local.json"),
            r#"{"skillOverrides":{"named":"name-only","gone":"off","slash":"user-invocable-only"}}"#,
        )
        .unwrap();
        let load = claude_code_context(&home, &proj);
        let cost = |n: &str| {
            load.items
                .iter()
                .find(|i| matches!(&i.kind, ItemKind::Skill { name, .. } if name == n))
                .unwrap()
                .always_bytes
        };
        assert_eq!(cost("full"), 4 + 12);
        assert_eq!(cost("named"), 5);
        assert_eq!(cost("gone"), 0);
        assert_eq!(cost("slash"), 0);
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
