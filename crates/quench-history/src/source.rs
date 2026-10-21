use crate::{HarnessId, Session};
use jiff::Timestamp;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Home {
    dir: PathBuf,
    vars: Vec<(String, String)>,
}

impl Home {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Home {
            dir: dir.into(),
            vars: Vec::new(),
        }
    }

    pub fn from_env() -> Option<Self> {
        let dir = std::env::var_os("HOME")?;
        let vars = std::env::vars().collect();
        Some(Home {
            dir: dir.into(),
            vars,
        })
    }

    pub fn with_var(mut self, key: &str, value: &str) -> Self {
        self.vars.push((key.into(), value.into()));
        self
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn var_or(&self, key: &str, default: &str) -> PathBuf {
        self.vars
            .iter()
            .rev()
            .find(|(k, v)| k == key && !v.is_empty())
            .map(|(_, v)| PathBuf::from(v))
            .unwrap_or_else(|| self.dir.join(default))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionRef {
    pub harness: HarnessId,
    pub path: PathBuf,
    pub modified: Option<Timestamp>,
    pub parent: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Diagnostics {
    pub lines: usize,
    pub skipped: usize,
}

#[derive(Debug, thiserror::Error)]
pub enum ReadError {
    #[error("cannot read {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("{path} is not a {harness} session")]
    NotASession {
        path: PathBuf,
        harness: &'static str,
    },
}

pub trait Harness: Send + Sync {
    fn id(&self) -> HarnessId;
    fn discover(&self, home: &Home) -> Vec<SessionRef>;
    fn read(&self, session: &SessionRef) -> Result<Session, ReadError>;
}

pub fn discover_all(home: &Home, since: Option<Timestamp>) -> Vec<SessionRef> {
    crate::harnesses()
        .iter()
        .flat_map(|h| h.discover(home))
        .filter(|s| match (since, s.modified) {
            (Some(since), Some(m)) => m >= since,
            _ => true,
        })
        .collect()
}

pub(crate) fn modified(path: &Path) -> Option<Timestamp> {
    let time = std::fs::metadata(path).ok()?.modified().ok()?;
    Timestamp::try_from(time).ok()
}

pub(crate) fn files_with_ext(dir: &Path, ext: &str, depth: usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk(dir, ext, depth, &mut out);
    out.sort();
    out
}

fn walk(dir: &Path, ext: &str, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() && depth > 0 {
            walk(&path, ext, depth - 1, out);
        } else if kind.is_file() && path.extension().is_some_and(|e| e == ext) {
            out.push(path);
        }
    }
}

pub fn read_all(refs: &[SessionRef]) -> Vec<Result<Session, ReadError>> {
    let harnesses = crate::harnesses();
    let read = |r: &SessionRef| {
        let harness = harnesses
            .iter()
            .find(|h| h.id() == r.harness)
            .expect("every SessionRef comes from a registered harness");
        harness.read(r)
    };
    let workers = std::thread::available_parallelism().map_or(4, |n| n.get());
    let chunk = refs.len().div_ceil(workers).max(1);
    std::thread::scope(|scope| {
        let handles: Vec<_> = refs
            .chunks(chunk)
            .map(|part| scope.spawn(move || part.iter().map(read).collect::<Vec<_>>()))
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().expect("session reader thread panicked"))
            .collect()
    })
}
