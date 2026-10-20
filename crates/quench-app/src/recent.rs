use crate::home::{read_json, write_json, QuenchHome};
use quench_core::ProjectKey;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const KEEP: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recent {
    pub v: u32,
    pub projects: Vec<RecentProject>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentProject {
    pub path: PathBuf,
    pub method: String,
    pub value: String,
    pub label: String,
}

impl Recent {
    fn path(home: &QuenchHome) -> PathBuf {
        home.local().join("recent.json")
    }

    pub fn load(home: &QuenchHome) -> Recent {
        read_json(&Recent::path(home)).unwrap_or(Recent {
            v: 1,
            projects: Vec::new(),
        })
    }

    pub fn touch(home: &QuenchHome, path: &Path, key: &ProjectKey) -> std::io::Result<Recent> {
        let mut recent = Recent::load(home);
        recent.projects.retain(|p| p.path != path);
        recent.projects.insert(
            0,
            RecentProject {
                path: path.to_path_buf(),
                method: serde_json::to_value(key.method)?
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                value: key.value.clone(),
                label: key.label.clone(),
            },
        );
        recent.projects.truncate(KEEP);
        write_json(&Recent::path(home), &recent)?;
        Ok(recent)
    }
}
