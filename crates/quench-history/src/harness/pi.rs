use crate::jsonl::{self, str, text_of, timestamp, u64};
use crate::source::{files_with_ext, modified};
use crate::{
    Author, Compaction, CompactionTrigger, Event, EventKind, Harness, HarnessId, Home, Inference,
    Message, ReadError, Session, SessionRef, ToolCall, ToolResult, Usage,
};
use serde_json::Value;

pub struct Pi;

impl Harness for Pi {
    fn id(&self) -> HarnessId {
        HarnessId::Pi
    }

    fn discover(&self, home: &Home) -> Vec<SessionRef> {
        let sessions = home
            .var_or("PI_CODING_AGENT_DIR", ".pi/agent")
            .join("sessions");
        files_with_ext(&sessions, "jsonl", 1)
            .into_iter()
            .map(|path| SessionRef {
                harness: HarnessId::Pi,
                modified: modified(&path),
                path,
                parent: None,
            })
            .collect()
    }

    fn read(&self, r: &SessionRef) -> Result<Session, ReadError> {
        let (lines, diagnostics) = jsonl::read(&r.path)?;
        let header = lines
            .iter()
            .find(|l| str(l, "type") == Some("session"))
            .ok_or_else(|| ReadError::NotASession {
                path: r.path.clone(),
                harness: "Pi",
            })?;
        let mut session = Session {
            id: str(header, "id").unwrap_or_default().into(),
            harness: HarnessId::Pi,
            path: r.path.clone(),
            cwd: str(header, "cwd").map(Into::into),
            parent: None,
            events: Vec::new(),
            diagnostics,
        };
        for line in &lines {
            let at = timestamp(line, "timestamp");
            let kinds = match str(line, "type") {
                Some("message") => message(&line["message"]),
                Some("compaction") => vec![EventKind::Compaction(Compaction {
                    trigger: CompactionTrigger::Unknown,
                    tokens_before: line.get("tokensBefore").and_then(Value::as_u64),
                })],
                _ => Vec::new(),
            };
            session
                .events
                .extend(kinds.into_iter().map(|kind| Event { at, kind }));
        }
        Ok(session)
    }
}

fn message(m: &Value) -> Vec<EventKind> {
    match str(m, "role") {
        Some("user") => text_message(Author::User, &m["content"]),
        Some("system") => text_message(Author::Injected, &m["content"]),
        Some("toolResult") => vec![EventKind::ToolResult(ToolResult {
            call_id: str(m, "toolCallId").map(Into::into),
            is_error: m.get("isError").and_then(Value::as_bool),
            chars: text_of(&m["content"]).chars().count(),
        })],
        Some("assistant") => assistant(m),
        _ => Vec::new(),
    }
}

fn text_message(author: Author, content: &Value) -> Vec<EventKind> {
    let text = text_of(content);
    if text.trim().is_empty() {
        return Vec::new();
    }
    vec![EventKind::Message(Message { author, text })]
}

fn assistant(m: &Value) -> Vec<EventKind> {
    let mut out = Vec::new();
    let usage = &m["usage"];
    let usage = Usage {
        input: u64(usage, "input"),
        cache_read: u64(usage, "cacheRead"),
        cache_write: u64(usage, "cacheWrite"),
        output: u64(usage, "output"),
    };
    if usage != Usage::default() {
        out.push(EventKind::Inference(Inference {
            model: str(m, "model").map(Into::into),
            effort: str(m, "thinkingLevel").map(Into::into),
            usage,
        }));
    }
    for item in m["content"].as_array().into_iter().flatten() {
        match str(item, "type") {
            Some("text") => out.extend(text_message(Author::Assistant, &item["text"])),
            Some("toolCall") => out.push(EventKind::ToolCall(ToolCall {
                id: str(item, "id").map(Into::into),
                name: str(item, "name").unwrap_or_default().into(),
            })),
            _ => {}
        }
    }
    out
}
