use crate::home::QuenchHome;
use crate::view::tilde;
use quench_core::{plan_local_write, write_through, ProjectKey, SkillOverride};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StagedChange {
    pub project: ProjectKey,
    pub working_copy: PathBuf,
    pub machine: String,
    pub harness: String,
    pub skill: String,
    pub from: Option<String>,
    pub to: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JournalEntry {
    pub v: u32,
    pub batch: String,
    pub at: u64,
    pub action: String,
    pub change: Option<StagedChange>,
    pub file: PathBuf,
    pub existed: bool,
    pub backup: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct ChangesView {
    pub items: Vec<PendingView>,
    pub files: Vec<FileDiffView>,
    pub can_undo: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct PendingView {
    pub project: String,
    pub skill: String,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct FileDiffView {
    pub file: String,
    pub before: String,
    pub after: String,
}

pub fn label(value: &Option<String>) -> String {
    value.clone().unwrap_or_else(|| "inherit".to_string())
}

pub fn changes_view(pending: &[StagedChange], quench: &QuenchHome, home: &Path) -> ChangesView {
    let files = by_working_copy(pending)
        .into_iter()
        .filter_map(|(root, changes)| {
            let plan = plan_local_write(&root, &overrides_of(&changes)).ok()?;
            Some(FileDiffView {
                file: tilde(&plan.file, home),
                before: plan.before.unwrap_or_default(),
                after: plan.after,
            })
        })
        .collect();
    ChangesView {
        items: pending
            .iter()
            .map(|c| PendingView {
                project: c.project.label.clone(),
                skill: c.skill.clone(),
                from: label(&c.from),
                to: label(&c.to),
            })
            .collect(),
        files,
        can_undo: last_batch(quench).is_some(),
    }
}

fn by_working_copy(pending: &[StagedChange]) -> BTreeMap<PathBuf, Vec<&StagedChange>> {
    let mut map: BTreeMap<PathBuf, Vec<&StagedChange>> = BTreeMap::new();
    for change in pending {
        map.entry(change.working_copy.clone())
            .or_default()
            .push(change);
    }
    map
}

fn overrides_of(changes: &[&StagedChange]) -> Vec<(String, Option<SkillOverride>)> {
    changes
        .iter()
        .map(|c| {
            (
                c.skill.clone(),
                c.to.as_deref().and_then(SkillOverride::parse),
            )
        })
        .collect()
}

pub fn apply(pending: &[StagedChange], quench: &QuenchHome) -> std::io::Result<String> {
    let batch = format!("{}", now_millis());
    let plans = by_working_copy(pending)
        .into_iter()
        .map(|(root, changes)| Ok((plan_local_write(&root, &overrides_of(&changes))?, changes)))
        .collect::<std::io::Result<Vec<_>>>()?;
    let backups = quench.local().join("backups");
    std::fs::create_dir_all(&backups)?;
    for (ix, (plan, changes)) in plans.iter().enumerate() {
        let backup = match &plan.before {
            Some(bytes) => {
                let path = backups.join(format!("{batch}-{ix}.json"));
                std::fs::write(&path, bytes)?;
                Some(path)
            }
            None => None,
        };
        write_through(&plan.file, &plan.after)?;
        for change in changes {
            journal(
                quench,
                &JournalEntry {
                    v: 1,
                    batch: batch.clone(),
                    at: now_millis(),
                    action: "apply".to_string(),
                    change: Some((*change).clone()),
                    file: plan.file.clone(),
                    existed: plan.before.is_some(),
                    backup: backup.clone(),
                },
            )?;
        }
    }
    Ok(batch)
}

pub fn undo_last(quench: &QuenchHome) -> std::io::Result<Option<String>> {
    let Some(batch) = last_batch(quench) else {
        return Ok(None);
    };
    let entries: Vec<JournalEntry> = read_journal(quench)
        .into_iter()
        .filter(|e| e.batch == batch && e.action == "apply")
        .collect();
    let mut restored = std::collections::BTreeSet::new();
    for entry in &entries {
        if !restored.insert(entry.file.clone()) {
            continue;
        }
        match &entry.backup {
            Some(backup) => {
                write_through(&entry.file, &std::fs::read_to_string(backup)?)?;
            }
            None if !entry.existed => {
                let real =
                    std::fs::canonicalize(&entry.file).unwrap_or_else(|_| entry.file.clone());
                let _ = std::fs::remove_file(real);
            }
            None => {}
        }
        journal(
            quench,
            &JournalEntry {
                v: 1,
                batch: batch.clone(),
                at: now_millis(),
                action: "undo".to_string(),
                change: None,
                file: entry.file.clone(),
                existed: entry.existed,
                backup: entry.backup.clone(),
            },
        )?;
    }
    Ok(Some(batch))
}

fn last_batch(quench: &QuenchHome) -> Option<String> {
    let entries = read_journal(quench);
    let undone: std::collections::HashSet<String> = entries
        .iter()
        .filter(|e| e.action == "undo")
        .map(|e| e.batch.clone())
        .collect();
    entries
        .iter()
        .rev()
        .find(|e| e.action == "apply" && !undone.contains(&e.batch))
        .map(|e| e.batch.clone())
}

fn journal_path(quench: &QuenchHome) -> PathBuf {
    quench.local().join("journal.jsonl")
}

fn read_journal(quench: &QuenchHome) -> Vec<JournalEntry> {
    std::fs::read_to_string(journal_path(quench))
        .map(|t| {
            t.lines()
                .filter_map(|l| serde_json::from_str(l).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn journal(quench: &QuenchHome, entry: &JournalEntry) -> std::io::Result<()> {
    std::fs::create_dir_all(quench.local())?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(journal_path(quench))?;
    writeln!(file, "{}", serde_json::to_string(entry)?)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}
