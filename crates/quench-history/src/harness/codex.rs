use super::injected_tag;
use crate::jsonl::{self, str, text_of, timestamp, u64};
use crate::source::{files_with_ext, modified};
use crate::{
    Author, Compaction, CompactionTrigger, Event, EventKind, Harness, HarnessId, Home, Inference,
    Message, ReadError, Session, SessionRef, ToolCall, ToolResult, Usage,
};
use serde_json::Value;

pub struct Codex;

const INJECTED_HEADINGS: [&str; 1] = ["# AGENTS.md instructions"];

impl Harness for Codex {
    fn id(&self) -> HarnessId {
        HarnessId::Codex
    }

    fn discover(&self, home: &Home) -> Vec<SessionRef> {
        let sessions = home.var_or("CODEX_HOME", ".codex").join("sessions");
        files_with_ext(&sessions, "jsonl", 3)
            .into_iter()
            .map(|path| SessionRef {
                harness: HarnessId::Codex,
                modified: modified(&path),
                path,
                parent: None,
            })
            .collect()
    }

    fn read(&self, r: &SessionRef) -> Result<Session, ReadError> {
        let (lines, diagnostics) = jsonl::read(&r.path)?;
        let meta = lines
            .iter()
            .find(|l| str(l, "type") == Some("session_meta"))
            .ok_or_else(|| ReadError::NotASession {
                path: r.path.clone(),
                harness: "Codex",
            })?;
        let mut session = Session {
            id: str(&meta["payload"], "id").unwrap_or_default().into(),
            harness: HarnessId::Codex,
            path: r.path.clone(),
            cwd: str(&meta["payload"], "cwd").map(Into::into),
            parent: None,
            events: Vec::new(),
            diagnostics,
        };
        let has_records = lines
            .iter()
            .any(|l| str(l, "type") == Some("token_usage_record"));
        let (mut model, mut effort) = (None, None);
        for line in &lines {
            let at = timestamp(line, "timestamp");
            let payload = &line["payload"];
            let kind = match (str(line, "type"), str(payload, "type")) {
                (Some("turn_context"), _) => {
                    model = str(payload, "model").map(String::from).or(model);
                    effort = str(payload, "effort").map(String::from).or(effort);
                    None
                }
                (Some("token_usage_record"), _) => {
                    Some(inference(&payload["usage"], model.clone(), effort.clone()))
                }
                (Some("event_msg"), Some("token_count")) if !has_records => payload["info"]
                    .get("last_token_usage")
                    .map(|u| inference(u, model.clone(), effort.clone())),
                (Some("compacted"), _) => Some(EventKind::Compaction(Compaction {
                    trigger: CompactionTrigger::Unknown,
                    tokens_before: None,
                })),
                (Some("response_item"), Some("message")) => message(payload),
                (Some("response_item"), Some("function_call" | "custom_tool_call")) => {
                    Some(EventKind::ToolCall(ToolCall {
                        id: str(payload, "call_id").map(Into::into),
                        name: str(payload, "name").unwrap_or_default().into(),
                    }))
                }
                (
                    Some("response_item"),
                    Some("function_call_output" | "custom_tool_call_output"),
                ) => Some(EventKind::ToolResult(ToolResult {
                    call_id: str(payload, "call_id").map(Into::into),
                    is_error: None,
                    chars: text_of(&payload["output"]).chars().count(),
                })),
                _ => None,
            };
            if let Some(kind) = kind {
                session.events.push(Event { at, kind });
            }
        }
        Ok(session)
    }
}

fn inference(usage: &Value, model: Option<String>, effort: Option<String>) -> EventKind {
    let cached = u64(usage, "cached_input_tokens");
    let written = u64(usage, "cache_write_input_tokens");
    EventKind::Inference(Inference {
        model,
        effort,
        usage: Usage {
            input: u64(usage, "input_tokens").saturating_sub(cached + written),
            cache_read: cached,
            cache_write: written,
            output: u64(usage, "output_tokens"),
        },
    })
}

fn message(payload: &Value) -> Option<EventKind> {
    let text = text_of(&payload["content"]);
    if text.trim().is_empty() {
        return None;
    }
    let author = match str(payload, "role") {
        Some("assistant") => Author::Assistant,
        Some("user") if !injected(&text) => Author::User,
        _ => Author::Injected,
    };
    Some(EventKind::Message(Message { author, text }))
}

fn injected(text: &str) -> bool {
    injected_tag(text) || INJECTED_HEADINGS.iter().any(|h| text.starts_with(h))
}
