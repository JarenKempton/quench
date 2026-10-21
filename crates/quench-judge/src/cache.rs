use crate::{Exchange, Judge, JudgeError, Verdict};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Cached<J> {
    inner: J,
    path: PathBuf,
    known: Mutex<HashMap<String, Verdict>>,
}

#[derive(Serialize, Deserialize)]
struct Line {
    key: String,
    verdict: Verdict,
}

impl<J: Judge> Cached<J> {
    pub fn open(inner: J, path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let known = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str::<Line>(l).ok())
            .map(|l| (l.key, l.verdict))
            .collect();
        Cached {
            inner,
            path,
            known: Mutex::new(known),
        }
    }

    pub fn inner(&self) -> &J {
        &self.inner
    }

    pub fn known(&self) -> usize {
        self.known.lock().expect("cache lock").len()
    }

    fn key(&self, exchange: &Exchange) -> String {
        let mut hash = Sha256::new();
        for part in [
            self.inner.id().as_str(),
            &exchange.assistant_said,
            &exchange.reply,
        ] {
            hash.update((part.len() as u64).to_le_bytes());
            hash.update(part.as_bytes());
        }
        format!("{:x}", hash.finalize())
    }

    fn remember(&self, fresh: &[(String, Verdict)]) -> std::io::Result<()> {
        if fresh.is_empty() {
            return Ok(());
        }
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        for (key, verdict) in fresh {
            let line = serde_json::to_string(&Line {
                key: key.clone(),
                verdict: *verdict,
            })?;
            writeln!(file, "{line}")?;
        }
        file.sync_all()
    }
}

impl<J: Judge> Judge for Cached<J> {
    fn id(&self) -> String {
        self.inner.id()
    }

    fn classify(&self, exchanges: &[Exchange]) -> Vec<Result<Verdict, JudgeError>> {
        let keys: Vec<String> = exchanges.iter().map(|e| self.key(e)).collect();
        let missing: Vec<usize> = {
            let known = self.known.lock().expect("cache lock");
            (0..exchanges.len())
                .filter(|&i| !known.contains_key(&keys[i]))
                .collect()
        };
        let asked: Vec<Exchange> = missing.iter().map(|&i| exchanges[i].clone()).collect();
        let answers = self.inner.classify(&asked);
        let mut fresh = Vec::new();
        let mut failed = HashMap::new();
        for (&i, answer) in missing.iter().zip(answers) {
            match answer {
                Ok(v) => fresh.push((keys[i].clone(), v)),
                Err(e) => {
                    failed.insert(i, e);
                }
            }
        }
        let _ = self.remember(&fresh);
        let mut known = self.known.lock().expect("cache lock");
        known.extend(fresh);
        (0..exchanges.len())
            .map(|i| match failed.remove(&i) {
                Some(e) => Err(e),
                None => Ok(known[&keys[i]]),
            })
            .collect()
    }
}
