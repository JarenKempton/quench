use quench_core::{context_for_this_machine, ItemKind};
use std::path::PathBuf;

fn main() {
    let root = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap());
    let load = context_for_this_machine(&root);
    println!(
        "{} context load for {}",
        load.harness,
        load.project_root.display()
    );
    println!(
        "project {} ({:?}: {})",
        load.project.label, load.project.method, load.project.value
    );
    for item in &load.items {
        let what = match &item.kind {
            ItemKind::Instructions {
                imported_by: Some(by),
                ..
            } => format!("instructions (imported by {})", by.display()),
            ItemKind::Instructions {
                imported_by: None, ..
            } => "instructions".to_string(),
            ItemKind::Skill { name, .. } => format!("skill {name}"),
            ItemKind::McpServer(s) => format!(
                "mcp {} ({:?}, {:?}{}) tool cost unknown",
                s.name,
                s.config_scope,
                s.transport,
                s.approval.map(|a| format!(", {a:?}")).unwrap_or_default()
            ),
            ItemKind::Unscanned { what } => format!("not yet scanned: {what}"),
        };
        let dup = item
            .duplicate_of
            .as_ref()
            .map(|d| format!("  duplicate of {}", d.display()))
            .unwrap_or_default();
        println!(
            "{:<8} {:>7} B always {:>7} B on demand  {:<40} {}{}",
            format!("{:?}", item.scope).to_lowercase(),
            item.always_bytes,
            item.on_demand_bytes,
            what,
            item.path.display(),
            dup
        );
    }
    println!(
        "always loaded: {} B ≈ {} tokens (estimated, {})",
        load.always_bytes, load.always_tokens.tokens, load.always_tokens.method
    );
}
