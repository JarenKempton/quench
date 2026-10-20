use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct QuenchHome {
    root: PathBuf,
}

impl QuenchHome {
    pub fn at(root: impl Into<PathBuf>) -> Self {
        QuenchHome { root: root.into() }
    }

    pub fn for_user(home: &Path) -> Self {
        match std::env::var_os("QUENCH_HOME") {
            Some(dir) if !dir.is_empty() => QuenchHome::at(dir),
            _ => QuenchHome::at(home.join(".quench")),
        }
    }

    pub fn local(&self) -> PathBuf {
        self.root.join("local")
    }

    pub fn state(&self) -> PathBuf {
        self.root.join("state")
    }
}

pub(crate) fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

pub(crate) fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(tmp, path)
}
