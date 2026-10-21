use crate::{Exchange, Judge, JudgeError, Verdict};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Cached<J> {
    inner: J,
    judge: String,
    path: PathBuf,
    known: Mutex<HashMap<String, Verdict>>,
}

#[derive(Serialize, Deserialize)]
struct Line {
    judge: String,
    key: String,
    verdict: Verdict,
}

impl<J: Judge> Cached<J> {
    pub fn open(inner: J, path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let judge = inner.id();
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let lines = text.lines().filter(|l| !l.trim().is_empty()).count();
        let known: HashMap<String, Verdict> = text
            .lines()
            .filter_map(|l| serde_json::from_str::<Line>(l).ok())
            .filter(|l| l.judge == judge)
            .map(|l| (l.key, l.verdict))
            .collect();
        let cached = Cached {
            inner,
            judge,
            path,
            known: Mutex::new(known),
        };
        if cached.known() < lines {
            let _ = cached.rewrite();
        }
        cached
    }

    pub fn inner(&self) -> &J {
        &self.inner
    }

    pub fn known(&self) -> usize {
        self.known.lock().expect("cache lock").len()
    }

    fn key(&self, exchange: &Exchange) -> String {
        let mut hash = Sha256::new();
        for part in [&self.judge, &exchange.assistant_said, &exchange.reply] {
            hash.update((part.len() as u64).to_le_bytes());
            hash.update(part.as_bytes());
        }
        format!("{:x}", hash.finalize())
    }

    fn line(&self, key: &str, verdict: Verdict) -> serde_json::Result<String> {
        serde_json::to_string(&Line {
            judge: self.judge.clone(),
            key: key.into(),
            verdict,
        })
    }

    fn rewrite(&self) -> std::io::Result<()> {
        let mut body = String::new();
        for (key, verdict) in self.known.lock().expect("cache lock").iter() {
            body.push_str(&self.line(key, *verdict)?);
            body.push('\n');
        }
        let tmp = self
            .path
            .with_extension(format!("jsonl.{}.tmp", std::process::id()));
        std::fs::write(&tmp, body)?;
        std::fs::rename(&tmp, &self.path)
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
            writeln!(file, "{}", self.line(key, *verdict)?)?;
        }
        file.sync_all()
    }
}

impl<J: Judge> Judge for Cached<J> {
    fn id(&self) -> String {
        self.judge.clone()
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
