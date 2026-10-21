use jiff::Timestamp;
use quench_history::{Author, EventKind, Origin, Session};
use serde::Serialize;

#[derive(Debug, Clone, Default, Serialize)]
pub struct Run {
    pub prompt: Option<String>,
    pub prompt_origin: Option<Origin>,
    pub reply: Option<String>,
    pub reply_origin: Option<Origin>,
    pub assistant_said: Option<String>,
    pub started_at: Option<Timestamp>,
    pub ended_at: Option<Timestamp>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub inferences: usize,
    pub context_start: Option<u64>,
    pub context_peak: u64,
    pub tool_calls: usize,
    pub tool_errors: usize,
    pub compactions: usize,
    pub subagents: usize,
}

impl Run {
    pub fn duration_secs(&self) -> Option<i64> {
        Some(self.ended_at?.duration_since(self.started_at?).as_secs())
    }
}

pub fn runs(session: &Session, children: &[&Session]) -> Vec<Run> {
    let mut segments = vec![Run::default()];
    for event in &session.events {
        let run = segments.last_mut().expect("segments starts non-empty");
        match &event.kind {
            EventKind::Message(m) if m.author == Author::User => segments.push(Run {
                prompt: Some(m.text.clone()),
                prompt_origin: Some(m.origin),
                started_at: event.at,
                ended_at: event.at,
                ..Run::default()
            }),
            EventKind::Message(m) if m.author == Author::Assistant => {
                run.assistant_said = Some(m.text.clone());
            }
            EventKind::Inference(i) => {
                let context = i.usage.context();
                run.inferences += 1;
                run.context_start.get_or_insert(context);
                run.context_peak = run.context_peak.max(context);
                run.model = i.model.clone().or(run.model.take());
                run.effort = i.effort.clone().or(run.effort.take());
            }
            EventKind::ToolCall(_) => run.tool_calls += 1,
            EventKind::ToolResult(r) => run.tool_errors += usize::from(r.is_error == Some(true)),
            EventKind::Compaction(_) => run.compactions += 1,
            _ => {}
        }
        let run = segments.last_mut().expect("segments starts non-empty");
        run.started_at = run.started_at.or(event.at);
        run.ended_at = event.at.or(run.ended_at);
    }
    for i in 1..segments.len() {
        segments[i - 1].reply = segments[i].prompt.clone();
        segments[i - 1].reply_origin = segments[i].prompt_origin;
    }
    for run in &mut segments {
        run.subagents = children
            .iter()
            .filter(|c| within(c.started_at(), run.started_at, run.ended_at))
            .count();
    }
    segments.retain(|r| r.inferences > 0);
    segments
}

fn within(at: Option<Timestamp>, start: Option<Timestamp>, end: Option<Timestamp>) -> bool {
    matches!((at, start, end), (Some(at), Some(s), Some(e)) if s <= at && at <= e)
}
