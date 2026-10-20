use crate::home::QuenchHome;
use crate::view::tilde;
use quench_core::{
    keep_out_of_git, link_target, plan_settings_write, write_through, ProjectKey, SkillOverride,
    WritePlan,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StagedChange {
    pub project: ProjectKey,
    pub working_copy: PathBuf,
    pub file: PathBuf,
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
    pub file: String,
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
    let files = by_file(pending)
        .into_iter()
        .filter_map(|(file, changes)| {
            let plan = plan_settings_write(&file, &targets(&changes)).ok()?;
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
                file: c.file.display().to_string(),
                skill: c.skill.clone(),
                from: label(&c.from),
                to: label(&c.to),
            })
            .collect(),
        files,
        can_undo: last_batch(quench).is_some(),
    }
}

fn by_file<'a>(
    changes: impl IntoIterator<Item = &'a StagedChange>,
) -> BTreeMap<PathBuf, Vec<&'a StagedChange>> {
    let mut map: BTreeMap<PathBuf, Vec<&StagedChange>> = BTreeMap::new();
    for change in changes {
        map.entry(change.file.clone()).or_default().push(change);
    }
    map
}

fn targets(changes: &[&StagedChange]) -> Vec<(String, Option<SkillOverride>)> {
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

fn reversals(changes: &[&StagedChange]) -> Vec<(String, Option<SkillOverride>)> {
    changes
        .iter()
        .rev()
        .map(|c| {
            (
                c.skill.clone(),
                c.from.as_deref().and_then(SkillOverride::parse),
            )
        })
        .collect()
}

pub fn apply(pending: &[StagedChange], quench: &QuenchHome) -> std::io::Result<String> {
    let batch = batch_id();
    let plans: Vec<(WritePlan, Vec<&StagedChange>)> = by_file(pending)
        .into_iter()
        .map(|(file, changes)| Ok((plan_settings_write(&file, &targets(&changes))?, changes)))
        .collect::<std::io::Result<_>>()?;
    let backups = quench.local().join("backups");
    std::fs::create_dir_all(&backups)?;
    let mut entries = Vec::new();
    for (ix, (plan, changes)) in plans.iter().enumerate() {
        let backup = match &plan.before {
            Some(bytes) => {
                let path = backups.join(format!("{batch}-{ix}.json"));
                std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&path)?
                    .write_all(bytes.as_bytes())?;
                Some(path)
            }
            None => None,
        };
        for change in changes {
            entries.push(JournalEntry {
                v: 1,
                batch: batch.clone(),
                at: now_millis(),
                action: "apply".to_string(),
                change: Some((*change).clone()),
                file: plan.file.clone(),
                existed: plan.before.is_some(),
                backup: backup.clone(),
            });
        }
    }
    journal(quench, &entries)?;
    for (plan, _) in &plans {
        write_through(&plan.file, &plan.after)?;
        if plan.before.is_none() {
            keep_out_of_git(&plan.file)?;
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
    let existed: BTreeMap<PathBuf, bool> = entries
        .iter()
        .map(|e| (e.file.clone(), e.existed))
        .collect();
    let plans: Vec<WritePlan> = by_file(entries.iter().filter_map(|e| e.change.as_ref()))
        .into_iter()
        .map(|(file, changes)| plan_settings_write(&file, &reversals(&changes)))
        .collect::<std::io::Result<_>>()?;
    for plan in &plans {
        let created = !existed.get(&plan.file).copied().unwrap_or(true);
        if created && plan.after == "{}\n" {
            std::fs::remove_file(link_target(&plan.file))?;
        } else {
            write_through(&plan.file, &plan.after)?;
        }
    }
    journal(
        quench,
        &[JournalEntry {
            v: 1,
            batch: batch.clone(),
            at: now_millis(),
            action: "undo".to_string(),
            change: None,
            file: PathBuf::new(),
            existed: false,
            backup: None,
        }],
    )?;
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

fn journal(quench: &QuenchHome, entries: &[JournalEntry]) -> std::io::Result<()> {
    std::fs::create_dir_all(quench.local())?;
    let mut lines = String::new();
    for entry in entries {
        lines.push_str(&serde_json::to_string(entry)?);
        lines.push('\n');
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(journal_path(quench))?
        .write_all(lines.as_bytes())
}

fn batch_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    format!(
        "{}-{}-{}",
        now_millis(),
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}
