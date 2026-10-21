use crate::Run;
use quench_history::HarnessId;
use serde::Serialize;

#[derive(Debug, Clone)]
pub struct Sample<'a> {
    pub harness: HarnessId,
    pub position: usize,
    pub run: &'a Run,
    pub corrected: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Signal {
    pub name: &'static str,
    pub buckets: Vec<Bucket>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Bucket {
    pub label: String,
    pub replies: usize,
    pub corrections: usize,
}

impl Bucket {
    pub fn rate(&self) -> f64 {
        self.corrections as f64 / self.replies.max(1) as f64
    }
}

type Key = fn(&Sample) -> Option<(usize, String)>;

const SIGNALS: [(&str, Key); 6] = [
    ("Context when the reply came", context),
    ("Reply number in the session", position),
    ("Agent time before the reply", duration),
    ("Effort", effort),
    ("Model", model),
    ("Harness", harness),
];

pub fn signals(samples: &[Sample]) -> Vec<Signal> {
    SIGNALS
        .iter()
        .map(|(name, key)| Signal {
            name,
            buckets: bucket(samples, *key),
        })
        .collect()
}

fn bucket(samples: &[Sample], key: Key) -> Vec<Bucket> {
    let mut found: Vec<(usize, Bucket)> = Vec::new();
    for sample in samples {
        let Some((order, label)) = key(sample) else {
            continue;
        };
        let at = match found.iter().position(|(_, b)| b.label == label) {
            Some(at) => at,
            None => {
                found.push((
                    order,
                    Bucket {
                        label,
                        replies: 0,
                        corrections: 0,
                    },
                ));
                found.len() - 1
            }
        };
        found[at].1.replies += 1;
        found[at].1.corrections += usize::from(sample.corrected);
    }
    found.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.replies.cmp(&a.1.replies)));
    found.into_iter().map(|(_, b)| b).collect()
}

fn range(value: u64, edges: &[(u64, &str)], last: &str) -> (usize, String) {
    edges
        .iter()
        .position(|(edge, _)| value < *edge)
        .map_or((edges.len(), last.to_string()), |i| {
            (i, edges[i].1.to_string())
        })
}

fn context(s: &Sample) -> Option<(usize, String)> {
    Some(range(
        s.run.context_peak,
        &[
            (50_000, "under 50k"),
            (150_000, "50k–150k"),
            (250_000, "150k–250k"),
            (400_000, "250k–400k"),
        ],
        "400k and up",
    ))
}

fn position(s: &Sample) -> Option<(usize, String)> {
    Some(range(
        s.position as u64,
        &[(3, "1–2"), (10, "3–9"), (30, "10–29")],
        "30 and later",
    ))
}

fn duration(s: &Sample) -> Option<(usize, String)> {
    let secs = u64::try_from(s.run.duration_secs()?).ok()?;
    Some(range(
        secs,
        &[(60, "under 1 min"), (300, "1–5 min"), (900, "5–15 min")],
        "15 min and up",
    ))
}

fn effort(s: &Sample) -> Option<(usize, String)> {
    let effort = s.run.effort.as_deref()?;
    let order = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
        .iter()
        .position(|e| *e == effort)
        .unwrap_or(usize::MAX);
    Some((order, effort.to_string()))
}

fn model(s: &Sample) -> Option<(usize, String)> {
    Some((0, s.run.model.clone()?))
}

fn harness(s: &Sample) -> Option<(usize, String)> {
    Some((0, s.harness.label().to_string()))
}
