use crate::context::main_checkout;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkillOverride {
    On,
    NameOnly,
    UserInvocableOnly,
    Off,
}

impl SkillOverride {
    pub fn parse(value: &str) -> Option<SkillOverride> {
        serde_json::from_value(Value::String(value.to_string())).ok()
    }

    pub fn as_str(self) -> &'static str {
        match self {
            SkillOverride::On => "on",
            SkillOverride::NameOnly => "name-only",
            SkillOverride::UserInvocableOnly => "user-invocable-only",
            SkillOverride::Off => "off",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SettingsLayer {
    Managed,
    Local,
    Project,
    User,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ResolvedOverride {
    pub value: SkillOverride,
    pub layer: Option<SettingsLayer>,
    pub file: Option<PathBuf>,
    pub inherited: SkillOverride,
}

impl ResolvedOverride {
    pub fn default_on() -> Self {
        ResolvedOverride {
            value: SkillOverride::On,
            layer: None,
            file: None,
            inherited: SkillOverride::On,
        }
    }
}

fn managed_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/Library/Application Support/ClaudeCode")
    } else {
        PathBuf::from("/etc/claude-code")
    }
}

pub fn settings_layers(home: &Path, project_root: &Path) -> Vec<(SettingsLayer, PathBuf)> {
    let dir = managed_dir();
    let mut drop_ins: Vec<PathBuf> = std::fs::read_dir(dir.join("managed-settings.d"))
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|x| x == "json"))
                .collect()
        })
        .unwrap_or_default();
    drop_ins.sort();
    let mut layers: Vec<(SettingsLayer, PathBuf)> = drop_ins
        .into_iter()
        .rev()
        .map(|p| (SettingsLayer::Managed, p))
        .collect();
    layers.push((SettingsLayer::Managed, dir.join("managed-settings.json")));
    let local = local_settings(home, project_root);
    let legacy = project_root.join(".claude/settings.local.json");
    layers.push((SettingsLayer::Local, local.clone()));
    if legacy != local {
        layers.push((SettingsLayer::Local, legacy));
    }
    layers.push((
        SettingsLayer::Project,
        project_root.join(".claude/settings.json"),
    ));
    layers.push((SettingsLayer::User, home.join(".claude/settings.json")));
    layers
}

pub fn local_settings(home: &Path, project_root: &Path) -> PathBuf {
    let in_place = project_root.join(".claude/settings.local.json");
    if cfg!(windows) || !project_root.ancestors().any(|d| d.join(".git").exists()) {
        return in_place;
    }
    let root = main_checkout(project_root);
    let home = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    if std::fs::canonicalize(&root).unwrap_or_else(|_| root.clone()) == home
        || !owned_like_home(&root, &home)
    {
        return in_place;
    }
    root.join(".claude/settings.local.json")
}

#[cfg(unix)]
fn owned_like_home(root: &Path, home: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(owner) = std::fs::metadata(home).map(|m| m.uid()) else {
        return true;
    };
    [root.to_path_buf(), root.join(".git"), root.join(".claude")]
        .iter()
        .filter_map(|p| std::fs::symlink_metadata(p).ok())
        .all(|m| m.uid() == owner)
}

#[cfg(not(unix))]
fn owned_like_home(_: &Path, _: &Path) -> bool {
    true
}

pub fn resolve_overrides(home: &Path, project_root: &Path) -> HashMap<String, ResolvedOverride> {
    let mut resolved: HashMap<String, ResolvedOverride> = HashMap::new();
    let mut inherited: HashMap<String, SkillOverride> = HashMap::new();
    for (layer, file) in settings_layers(home, project_root) {
        for (name, value) in read_overrides(&file) {
            if layer != SettingsLayer::Local {
                inherited.entry(name.clone()).or_insert(value);
            }
            resolved.entry(name).or_insert(ResolvedOverride {
                value,
                layer: Some(layer),
                file: Some(file.clone()),
                inherited: SkillOverride::On,
            });
        }
    }
    for (name, r) in resolved.iter_mut() {
        r.inherited = inherited.get(name).copied().unwrap_or(SkillOverride::On);
    }
    resolved
}

pub fn read_overrides(file: &Path) -> Vec<(String, SkillOverride)> {
    let Some(settings) = read_object(file) else {
        return Vec::new();
    };
    settings
        .get("skillOverrides")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| Some((k.clone(), SkillOverride::parse(v.as_str()?)?)))
                .collect()
        })
        .unwrap_or_default()
}

fn read_object(file: &Path) -> Option<Map<String, Value>> {
    let text = std::fs::read_to_string(file).ok()?;
    serde_json::from_str::<Value>(&text)
        .ok()?
        .as_object()
        .cloned()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WritePlan {
    pub file: PathBuf,
    pub before: Option<String>,
    pub after: String,
}

fn invalid(file: &Path, why: &str) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        format!("{} {why}; not touching it", file.display()),
    )
}

pub fn plan_settings_write(
    file: &Path,
    changes: &[(String, Option<SkillOverride>)],
) -> std::io::Result<WritePlan> {
    let before = match std::fs::read_to_string(file) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            return Err(std::io::Error::new(
                e.kind(),
                format!("can't read {}: {e}; not touching it", file.display()),
            ))
        }
    };
    let mut settings = match &before {
        Some(text) => match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(map)) => map,
            _ => return Err(invalid(file, "is not a JSON object")),
        },
        None => Map::new(),
    };
    let overrides = settings
        .entry("skillOverrides")
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(overrides) = overrides.as_object_mut() else {
        return Err(invalid(file, "has a skillOverrides that is not an object"));
    };
    for (name, value) in changes {
        match value {
            Some(v) => {
                overrides.insert(name.clone(), Value::String(v.as_str().to_string()));
            }
            None => {
                overrides.shift_remove(name);
            }
        }
    }
    if overrides.is_empty() {
        settings.shift_remove("skillOverrides");
    }
    let after = format!(
        "{}\n",
        serde_json::to_string_pretty(&Value::Object(settings))?
    );
    Ok(WritePlan {
        file: file.to_path_buf(),
        before,
        after,
    })
}

pub fn link_target(file: &Path) -> PathBuf {
    let mut path = file.to_path_buf();
    for _ in 0..40 {
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => match std::fs::read_link(&path) {
                Ok(next) if next.is_absolute() => path = next,
                Ok(next) => path = path.parent().unwrap_or(Path::new("/")).join(next),
                Err(_) => break,
            },
            _ => break,
        }
    }
    path
}

pub fn write_through(file: &Path, contents: &str) -> std::io::Result<PathBuf> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let target = link_target(file);
    if target.is_dir() {
        return Err(invalid(&target, "is a directory"));
    }
    let dir = target.parent().unwrap_or(Path::new("/"));
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        ".{}.quench-{}-{}.tmp",
        target
            .file_name()
            .map_or_else(|| "settings".into(), |n| n.to_string_lossy()),
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = std::fs::write(&tmp, contents)
        .and_then(|()| match std::fs::metadata(&target) {
            Ok(meta) => std::fs::set_permissions(&tmp, meta.permissions()),
            Err(_) => Ok(()),
        })
        .and_then(|()| std::fs::rename(&tmp, &target));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result.map(|()| target)
}

pub fn keep_out_of_git(file: &Path) -> std::io::Result<bool> {
    let Some(dir) = file.parent().and_then(Path::parent) else {
        return Ok(false);
    };
    let ignored = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["check-ignore", "-q"])
        .arg(file)
        .stderr(std::process::Stdio::null())
        .status()?;
    if ignored.code() != Some(1) {
        return Ok(false);
    }
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .stderr(std::process::Stdio::null())
        .output()?;
    if !out.status.success() {
        return Ok(false);
    }
    let exclude = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim()).join("info/exclude");
    std::fs::create_dir_all(exclude.parent().unwrap_or(Path::new("/")))?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(exclude)?;
    writeln!(f, "**/.claude/settings.local.json")?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn root(tag: &str) -> PathBuf {
        let base =
            std::env::temp_dir().join(format!("quench-overrides-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn stronger_layer_wins_and_reports_its_source() {
        let r = root("layers");
        let home = r.join("home");
        let proj = r.join("proj");
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::create_dir_all(proj.join(".claude")).unwrap();
        fs::write(
            home.join(".claude/settings.json"),
            r#"{"skillOverrides":{"a":"off","b":"off"}}"#,
        )
        .unwrap();
        fs::write(
            proj.join(".claude/settings.json"),
            r#"{"skillOverrides":{"b":"name-only"}}"#,
        )
        .unwrap();
        fs::write(
            proj.join(".claude/settings.local.json"),
            r#"{"skillOverrides":{"b":"on","c":"bogus"}}"#,
        )
        .unwrap();
        let resolved = resolve_overrides(&home, &proj);
        assert_eq!(resolved["a"].value, SkillOverride::Off);
        assert_eq!(resolved["a"].layer, Some(SettingsLayer::User));
        assert_eq!(resolved["b"].value, SkillOverride::On);
        assert_eq!(resolved["b"].layer, Some(SettingsLayer::Local));
        assert!(!resolved.contains_key("c"));
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn local_write_preserves_other_keys_and_order() {
        let r = root("merge");
        fs::create_dir_all(r.join(".claude")).unwrap();
        let original = r#"{"permissions":{"allow":["Bash(ls)"]},"skillOverrides":{"keep":"off","drop":"off"},"zeta":1}"#;
        fs::write(r.join(".claude/settings.local.json"), original).unwrap();
        let plan = plan_settings_write(
            &r.join(".claude/settings.local.json"),
            &[
                ("drop".into(), None),
                ("new".into(), Some(SkillOverride::NameOnly)),
            ],
        )
        .unwrap();
        assert_eq!(plan.before.as_deref(), Some(original));
        let after: Value = serde_json::from_str(&plan.after).unwrap();
        let keys: Vec<&String> = after.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["permissions", "skillOverrides", "zeta"]);
        assert_eq!(
            after["skillOverrides"],
            serde_json::json!({"keep": "off", "new": "name-only"})
        );
        assert_eq!(after["permissions"]["allow"][0], "Bash(ls)");
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn removing_the_last_override_removes_the_key_and_bad_json_is_refused() {
        let r = root("empty");
        fs::create_dir_all(r.join(".claude")).unwrap();
        fs::write(
            r.join(".claude/settings.local.json"),
            r#"{"skillOverrides":{"x":"off"}}"#,
        )
        .unwrap();
        let plan = plan_settings_write(
            &r.join(".claude/settings.local.json"),
            &[("x".into(), None)],
        )
        .unwrap();
        assert_eq!(plan.after, "{}\n");
        fs::write(r.join(".claude/settings.local.json"), "not json").unwrap();
        assert!(plan_settings_write(
            &r.join(".claude/settings.local.json"),
            &[("x".into(), Some(SkillOverride::Off))]
        )
        .is_err());
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn write_goes_through_symlinks() {
        let r = root("symlink");
        let dotfiles = r.join("dotfiles/settings.local.json");
        fs::create_dir_all(dotfiles.parent().unwrap()).unwrap();
        fs::write(&dotfiles, "{}").unwrap();
        fs::create_dir_all(r.join("proj/.claude")).unwrap();
        let link = r.join("proj/.claude/settings.local.json");
        std::os::unix::fs::symlink(&dotfiles, &link).unwrap();
        write_through(&link, "{\"a\":1}\n").unwrap();
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&dotfiles).unwrap(), "{\"a\":1}\n");
        let _ = fs::remove_dir_all(&r);
    }

    fn git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(args)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
    }

    #[test]
    fn local_file_lives_at_the_repo_root_and_the_main_checkout_for_worktrees() {
        let r = fs::canonicalize(root("rootfile")).unwrap();
        let home = r.join("home");
        let repo = r.join("repo");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(repo.join("sub/dir")).unwrap();
        git(&repo, &["init", "-q"]);
        fs::write(repo.join("a"), "1").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-qm", "one"]);
        assert_eq!(
            local_settings(&home, &repo.join("sub/dir")),
            repo.join(".claude/settings.local.json")
        );
        git(
            &repo,
            &["worktree", "add", "-q", r.join("wt").to_str().unwrap()],
        );
        assert_eq!(
            local_settings(&home, &r.join("wt")),
            repo.join(".claude/settings.local.json")
        );
        let plain = r.join("plain");
        fs::create_dir_all(&plain).unwrap();
        assert_eq!(
            local_settings(&home, &plain),
            plain.join(".claude/settings.local.json")
        );
        assert_eq!(
            local_settings(&repo, &repo.join("sub")),
            repo.join("sub/.claude/settings.local.json"),
            "repo at home"
        );

        fs::create_dir_all(repo.join(".claude")).unwrap();
        fs::create_dir_all(repo.join("sub/dir/.claude")).unwrap();
        fs::write(
            repo.join(".claude/settings.local.json"),
            r#"{"skillOverrides":{"a":"off"}}"#,
        )
        .unwrap();
        fs::write(
            repo.join("sub/dir/.claude/settings.local.json"),
            r#"{"skillOverrides":{"a":"on","b":"off"}}"#,
        )
        .unwrap();
        let resolved = resolve_overrides(&home, &repo.join("sub/dir"));
        assert_eq!(
            resolved["a"].value,
            SkillOverride::Off,
            "root file wins over a legacy file"
        );
        assert_eq!(
            resolved["b"].value,
            SkillOverride::Off,
            "legacy file still read"
        );
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn inherited_value_ignores_the_local_layers() {
        let r = root("inherit");
        let home = r.join("home");
        let proj = r.join("proj");
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::create_dir_all(proj.join(".claude")).unwrap();
        fs::write(
            proj.join(".claude/settings.json"),
            r#"{"skillOverrides":{"a":"off"}}"#,
        )
        .unwrap();
        fs::write(
            proj.join(".claude/settings.local.json"),
            r#"{"skillOverrides":{"a":"on","b":"name-only"}}"#,
        )
        .unwrap();
        let resolved = resolve_overrides(&home, &proj);
        assert_eq!(
            (resolved["a"].value, resolved["a"].inherited),
            (SkillOverride::On, SkillOverride::Off)
        );
        assert_eq!(resolved["b"].inherited, SkillOverride::On);
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn unreadable_settings_are_refused_not_treated_as_missing() {
        let r = root("latin1");
        fs::create_dir_all(r.join(".claude")).unwrap();
        let file = r.join(".claude/settings.local.json");
        fs::write(&file, b"{\"theme\":\"caf\xe9\"}").unwrap();
        assert!(plan_settings_write(&file, &[("x".into(), Some(SkillOverride::Off))]).is_err());
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn writes_keep_permissions_and_follow_dangling_links() {
        use std::os::unix::fs::PermissionsExt;
        let r = root("perms");
        let file = r.join("settings.local.json");
        fs::write(&file, "{}").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        write_through(&file, "{\"a\":1}\n").unwrap();
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );

        let target = r.join("dotfiles/settings.local.json");
        let link = r.join("link.json");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        write_through(&link, "{}\n").unwrap();
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&target).unwrap(), "{}\n");
        assert!(write_through(&r, "{}").is_err(), "refuses a directory");
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn a_new_local_file_is_kept_out_of_git() {
        let r = fs::canonicalize(root("exclude")).unwrap();
        git(&r, &["init", "-q"]);
        let file = r.join(".claude/settings.local.json");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "{}").unwrap();
        keep_out_of_git(&file).unwrap();
        assert!(!keep_out_of_git(&file).unwrap(), "already ignored");
        let ignored = Command::new("git")
            .arg("-C")
            .arg(&r)
            .args(["check-ignore", "-q", ".claude/settings.local.json"])
            .status()
            .unwrap();
        assert!(ignored.success());
        let _ = fs::remove_dir_all(&r);
    }
}
