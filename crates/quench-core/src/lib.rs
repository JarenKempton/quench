//! quench-core — the pure-Rust core for Quench.
//!
//! Holds the scanner, git integration, and provenance logic. It has **no**
//! dependency on Tauri (no `AppHandle` reachable), which keeps a headless
//! consumer possible and turns principle 2 ("cloud never load-bearing") into a
//! boundary that can't be crossed rather than a discipline (quench#8).
//!
//! The scanner (quench#13) lives here, behind honest provenance: every value this
//! crate returns is a real fact traceable to a path on disk, never a fabricated
//! count. See [`scan`].

mod context;
mod mcp;
mod scan;

pub use mcp::{claude_code_mcp_servers, Approval, McpScope, McpServer, Transport};

pub use context::{
    claude_code_context, context_for_this_machine, ContextItem, ContextLoad, Estimate, ItemKind,
    Scope,
};

pub use scan::{
    scan, scan_this_machine, ContextFile, Harness, Origin, Probe, ProjectScan, Scan, Skill,
};

use serde::Serialize;

/// Honest identity/build facts the desktop shell can render without inventing data.
#[derive(Debug, Clone, Serialize)]
pub struct AppInfo {
    pub name: &'static str,
    pub core_version: &'static str,
}

/// The one fact the scaffold can state truthfully: which version of the core is linked.
/// No scanning, no harness counts, no fake data.
pub fn app_info() -> AppInfo {
    AppInfo {
        name: "Quench",
        core_version: env!("CARGO_PKG_VERSION"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_info_reports_the_linked_core_version() {
        let info = app_info();
        assert_eq!(info.name, "Quench");
        assert_eq!(info.core_version, env!("CARGO_PKG_VERSION"));
    }
}
