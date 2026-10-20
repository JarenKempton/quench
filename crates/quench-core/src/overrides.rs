use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

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
}

impl ResolvedOverride {
    pub fn default_on() -> Self {
        ResolvedOverride {
            value: SkillOverride::On,
            layer: None,
            file: None,
        }
    }
}

pub fn settings_layers(home: &Path, project_root: &Path) -> Vec<(SettingsLayer, PathBuf)> {
    let managed = if cfg!(target_os = "macos") {
        PathBuf::from("/Library/Application Support/ClaudeCode/managed-settings.json")
    } else {
        PathBuf::from("/etc/claude-code/managed-settings.json")
    };
    vec![
        (SettingsLayer::Managed, managed),
        (SettingsLayer::Local, local_settings(project_root)),
        (
            SettingsLayer::Project,
            project_root.join(".claude/settings.json"),
        ),
        (SettingsLayer::User, home.join(".claude/settings.json")),
    ]
}

pub fn local_settings(project_root: &Path) -> PathBuf {
    project_root.join(".claude/settings.local.json")
}

pub fn resolve_overrides(home: &Path, project_root: &Path) -> HashMap<String, ResolvedOverride> {
    let mut resolved: HashMap<String, ResolvedOverride> = HashMap::new();
    for (layer, file) in settings_layers(home, project_root) {
        for (name, value) in read_overrides(&file) {
            resolved.entry(name).or_insert(ResolvedOverride {
                value,
                layer: Some(layer),
                file: Some(file.clone()),
            });
        }
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

pub fn plan_local_write(
    project_root: &Path,
    changes: &[(String, Option<SkillOverride>)],
) -> std::io::Result<WritePlan> {
    let file = local_settings(project_root);
    let before = std::fs::read_to_string(&file).ok();
    let mut settings = match &before {
        Some(text) => match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(map)) => map,
            _ => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("{} is not a JSON object; not touching it", file.display()),
                ))
            }
        },
        None => Map::new(),
    };
    let overrides = settings
        .entry("skillOverrides")
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(overrides) = overrides.as_object_mut() else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("skillOverrides in {} is not an object", file.display()),
        ));
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
        file,
        before,
        after,
    })
}

pub fn write_through(file: &Path, contents: &str) -> std::io::Result<PathBuf> {
    let target = std::fs::canonicalize(file).unwrap_or_else(|_| file.to_path_buf());
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = target.with_file_name(format!(
        ".{}.quench-tmp",
        target
            .file_name()
            .map_or_else(|| "settings".into(), |n| n.to_string_lossy())
    ));
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, &target)?;
    Ok(target)
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
        let plan = plan_local_write(
            &r,
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
        let plan = plan_local_write(&r, &[("x".into(), None)]).unwrap();
        assert_eq!(plan.after, "{}\n");
        fs::write(r.join(".claude/settings.local.json"), "not json").unwrap();
        assert!(plan_local_write(&r, &[("x".into(), Some(SkillOverride::Off))]).is_err());
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
}
