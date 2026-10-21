use crate::{runs, Distribution};
use quench_history::{EventKind, HarnessId, Session};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub harnesses: Vec<HarnessReport>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HarnessReport {
    pub harness: HarnessId,
    pub sessions: usize,
    pub subagent_sessions: usize,
    pub runs: usize,
    pub inferences: usize,
    pub tokens_processed: u64,
    pub starting_load_tokens: u64,
    pub starting_load: Distribution,
    pub peak_context: Distribution,
    pub compactions: usize,
    pub compacted_sessions: usize,
    pub tool_calls: usize,
    pub tool_errors: usize,
    pub tool_results_with_status: usize,
    pub models: Vec<Count>,
    pub efforts: Vec<Count>,
    pub skipped_lines: usize,
}

impl HarnessReport {
    pub fn starting_share(&self) -> f64 {
        if self.tokens_processed == 0 {
            return 0.0;
        }
        self.starting_load_tokens as f64 / self.tokens_processed as f64
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Count {
    pub name: String,
    pub count: usize,
}

pub fn report(sessions: &[Session]) -> Report {
    let mut children: HashMap<(HarnessId, &str), Vec<&Session>> = HashMap::new();
    for s in sessions {
        if let Some(parent) = &s.parent {
            children.entry((s.harness, parent)).or_default().push(s);
        }
    }
    let mut by_harness: BTreeMap<HarnessId, Builder> = BTreeMap::new();
    for s in sessions {
        let kids = children
            .get(&(s.harness, s.id.as_str()))
            .map_or(&[][..], Vec::as_slice);
        by_harness
            .entry(s.harness)
            .or_insert_with(|| Builder::new(s.harness))
            .add(s, kids);
    }
    Report {
        harnesses: by_harness.into_values().map(Builder::finish).collect(),
    }
}

struct Builder {
    report: HarnessReport,
    starting: Vec<u64>,
    peaks: Vec<u64>,
    models: HashMap<String, usize>,
    efforts: HashMap<String, usize>,
}

impl Builder {
    fn new(harness: HarnessId) -> Self {
        Builder {
            report: HarnessReport {
                harness,
                sessions: 0,
                subagent_sessions: 0,
                runs: 0,
                inferences: 0,
                tokens_processed: 0,
                starting_load_tokens: 0,
                starting_load: Distribution::default(),
                peak_context: Distribution::default(),
                compactions: 0,
                compacted_sessions: 0,
                tool_calls: 0,
                tool_errors: 0,
                tool_results_with_status: 0,
                models: Vec::new(),
                efforts: Vec::new(),
                skipped_lines: 0,
            },
            starting: Vec::new(),
            peaks: Vec::new(),
            models: HashMap::new(),
            efforts: HashMap::new(),
        }
    }

    fn add(&mut self, s: &Session, children: &[&Session]) {
        let r = &mut self.report;
        r.skipped_lines += s.diagnostics.skipped;
        if s.parent.is_some() {
            r.subagent_sessions += 1;
        } else {
            r.sessions += 1;
            r.runs += runs(s, children).len();
        }
        let mut first = None;
        let mut peak = 0;
        let mut compacted = false;
        for event in &s.events {
            match &event.kind {
                EventKind::Inference(i) => {
                    let context = i.usage.context();
                    let base = *first.get_or_insert(context);
                    r.inferences += 1;
                    r.tokens_processed += context;
                    r.starting_load_tokens += base.min(context);
                    peak = peak.max(context);
                    count(&mut self.models, i.model.as_deref());
                    count(&mut self.efforts, i.effort.as_deref());
                }
                EventKind::Compaction(_) => {
                    r.compactions += 1;
                    compacted = true;
                }
                EventKind::ToolCall(_) => r.tool_calls += 1,
                EventKind::ToolResult(t) => {
                    r.tool_results_with_status += usize::from(t.is_error.is_some());
                    r.tool_errors += usize::from(t.is_error == Some(true));
                }
                _ => {}
            }
        }
        r.compacted_sessions += usize::from(compacted);
        if s.parent.is_none() {
            if let Some(first) = first {
                self.starting.push(first);
                self.peaks.push(peak);
            }
        }
    }

    fn finish(mut self) -> HarnessReport {
        self.report.starting_load = Distribution::of(self.starting);
        self.report.peak_context = Distribution::of(self.peaks);
        self.report.models = ranked(self.models);
        self.report.efforts = ranked(self.efforts);
        self.report
    }
}

fn count(map: &mut HashMap<String, usize>, key: Option<&str>) {
    *map.entry(key.unwrap_or("unknown").to_string()).or_default() += 1;
}

fn ranked(map: HashMap<String, usize>) -> Vec<Count> {
    let mut out: Vec<Count> = map
        .into_iter()
        .map(|(name, count)| Count { name, count })
        .collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));
    out
}
