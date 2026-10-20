use quench_core::{
    local_settings, read_overrides, Approval, ContextLoad, IdentityMethod, ItemKind, McpScope,
    Origin, Scope, SettingsLayer, SkillOverride, Transport,
};
use serde::Serialize;
use std::path::Path;
use ts_rs::TS;

const BYTES_PER_TOKEN: u64 = 3;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct ContextView {
    pub harness: String,
    pub project: ProjectHeader,
    #[ts(type = "number")]
    pub always_tokens: u64,
    pub token_method: String,
    pub sections: Vec<Section>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct ProjectHeader {
    pub label: String,
    pub root: String,
    pub path: String,
    pub identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct Section {
    pub id: String,
    pub title: String,
    pub rows: Vec<Row>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct Row {
    pub id: String,
    pub title: String,
    pub detail: Option<String>,
    pub location: String,
    pub scope: String,
    pub cost: Cost,
    pub notes: Vec<String>,
    pub toggle: Option<Toggle>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct Toggle {
    pub skill: String,
    pub value: String,
    pub source: String,
    pub local: Option<String>,
    pub inherited: String,
    pub locked: bool,
    pub pending: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum Cost {
    Estimated {
        #[ts(type = "number")]
        always_tokens: u64,
        #[ts(type = "number")]
        on_demand_tokens: u64,
    },
    Duplicate,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct RecentView {
    pub path: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct MachineView {
    pub id: String,
    pub label: String,
}

pub fn context_view(load: &ContextLoad, home: &Path) -> ContextView {
    let mut always = Vec::new();
    let mut skills = Vec::new();
    let mut mcp = Vec::new();
    let mut unscanned = Vec::new();
    let local: std::collections::HashMap<String, SkillOverride> =
        read_overrides(&local_settings(home, &load.project_root))
            .into_iter()
            .collect();
    for item in &load.items {
        let location = match item.path.strip_prefix(&load.project_root) {
            Ok(rel) => format!("./{}", rel.display()),
            Err(_) => tilde(&item.path, home),
        };
        let scope = match item.scope {
            Scope::Machine => "This machine",
            Scope::Project => "Project",
        }
        .to_string();
        let cost = if item.duplicate_of.is_some() {
            Cost::Duplicate
        } else {
            Cost::Estimated {
                always_tokens: tokens(item.always_bytes),
                on_demand_tokens: tokens(item.on_demand_bytes),
            }
        };
        let mut notes = Vec::new();
        if let Some(first) = &item.duplicate_of {
            notes.push(format!("same file as {}", tilde(first, home)));
        }
        if let Some(first) = &item.same_content_as {
            notes.push(format!("identical to {}, loaded twice", tilde(first, home)));
        }
        let path_id = item.path.display().to_string();
        match &item.kind {
            ItemKind::Instructions {
                imported_by,
                external,
                path_scoped,
                truncated,
            } => {
                let id = format!("file:{path_id}");
                if let Some(by) = imported_by {
                    notes.push(format!("imported by {}", tilde(by, home)));
                }
                if *external {
                    notes.push(
                        "outside the project: loads only after you approve external imports"
                            .to_string(),
                    );
                }
                if *path_scoped {
                    notes.push("loads when Claude touches matching files".to_string());
                }
                if *truncated {
                    notes.push("only the first 200 lines or 25 KB load".to_string());
                }
                always.push(Row {
                    id,
                    title: file_title(&item.path),
                    detail: None,
                    location,
                    scope,
                    cost,
                    notes,
                    toggle: None,
                });
            }
            ItemKind::Skill {
                name,
                description,
                origin,
                model_invocable,
                setting,
            } => {
                let id = format!("skill:{path_id}");
                if !model_invocable {
                    notes.push("hidden from the model (disable-model-invocation)".to_string());
                }
                if let Origin::Linked { target, .. } = origin {
                    notes.push(format!("linked from {}", tilde(target, home)));
                }
                if setting.value != SkillOverride::On {
                    notes.push(format!(
                        "{} via {}",
                        setting.value.as_str(),
                        layer_label(setting.layer)
                    ));
                }
                let toggle = Some(Toggle {
                    skill: name.clone(),
                    value: setting.value.as_str().to_string(),
                    source: layer_label(setting.layer).to_string(),
                    local: local.get(name).map(|v| v.as_str().to_string()),
                    inherited: setting.inherited.as_str().to_string(),
                    locked: setting.layer == Some(SettingsLayer::Managed),
                    pending: None,
                });
                skills.push(Row {
                    id,
                    title: name.clone(),
                    detail: description.clone(),
                    location,
                    scope,
                    cost,
                    notes,
                    toggle,
                });
            }
            ItemKind::McpServer(server) => {
                let id = format!(
                    "mcp:{}:{path_id}#{}",
                    match server.config_scope {
                        McpScope::User => "user",
                        McpScope::Local => "local",
                        McpScope::Project => "project",
                    },
                    server.name
                );
                if let Some(winner) = server.overridden_by {
                    notes.push(format!(
                        "not used: the {} server with this name wins",
                        match winner {
                            McpScope::User => "user",
                            McpScope::Local => "local",
                            McpScope::Project => "project",
                        }
                    ));
                }
                let transport = match server.transport {
                    Transport::Stdio => "stdio",
                    Transport::Http => "http",
                    Transport::Sse => "sse",
                    Transport::Unknown => "unknown transport",
                };
                notes.push(
                    match server.config_scope {
                        McpScope::User => "user config",
                        McpScope::Local => "local config (this project, only you)",
                        McpScope::Project => "project .mcp.json",
                    }
                    .to_string(),
                );
                if let Some(approval) = server.approval {
                    notes.push(
                        match approval {
                            Approval::Approved => "approved",
                            Approval::Denied => "denied — not loaded",
                            Approval::Pending => "awaiting approval",
                        }
                        .to_string(),
                    );
                }
                let detail = Some(match &server.endpoint {
                    Some(e) => format!("{transport} · {e}"),
                    None => transport.to_string(),
                });
                mcp.push(Row {
                    id,
                    title: server.name.clone(),
                    detail,
                    location,
                    scope,
                    cost: Cost::Unknown,
                    notes,
                    toggle: None,
                });
            }
            ItemKind::Unscanned { what } => {
                let id = format!("unscanned:{path_id}");
                unscanned.push(Row {
                    id,
                    title: what.clone(),
                    detail: Some("not yet scanned".to_string()),
                    location,
                    scope,
                    cost: Cost::Unknown,
                    notes,
                    toggle: None,
                });
            }
        }
    }

    let sections: Vec<Section> = [
        ("instructions", "Always loaded", always),
        ("skills", "Skills", skills),
        ("mcp", "MCP servers", mcp),
        ("unscanned", "Not yet scanned", unscanned),
    ]
    .into_iter()
    .filter(|(_, _, rows)| !rows.is_empty())
    .map(|(id, title, rows)| Section {
        id: id.to_string(),
        title: title.to_string(),
        rows,
    })
    .collect();

    ContextView {
        harness: "Claude Code".to_string(),
        project: ProjectHeader {
            label: load.project.label.clone(),
            root: load.project_root.display().to_string(),
            path: tilde(&load.project_root, home),
            identity: match load.project.method {
                IdentityMethod::RootCommit => format!("root commit {}", short(&load.project.value)),
                IdentityMethod::Remote => format!("remote {}", load.project.value),
                IdentityMethod::Path => "this folder's path (not a git repo)".to_string(),
            },
        },
        always_tokens: sections
            .iter()
            .flat_map(|s| &s.rows)
            .map(|r| match r.cost {
                Cost::Estimated { always_tokens, .. } => always_tokens,
                _ => 0,
            })
            .sum(),
        token_method: format!("estimated, {}", load.always_tokens.method),
        sections,
    }
}

fn layer_label(layer: Option<SettingsLayer>) -> &'static str {
    match layer {
        None => "default",
        Some(SettingsLayer::Managed) => "managed settings",
        Some(SettingsLayer::Local) => "this project, only you",
        Some(SettingsLayer::Project) => "project settings (shared)",
        Some(SettingsLayer::User) => "your user settings (all projects)",
    }
}

fn tokens(bytes: u64) -> u64 {
    bytes.div_ceil(BYTES_PER_TOKEN)
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(12)]
}

fn file_title(path: &Path) -> String {
    path.file_name().map_or_else(
        || path.display().to_string(),
        |n| n.to_string_lossy().into_owned(),
    )
}

pub fn tilde(path: &Path, home: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rest) if !home.as_os_str().is_empty() => format!("~/{}", rest.display()),
        _ => path.display().to_string(),
    }
}
