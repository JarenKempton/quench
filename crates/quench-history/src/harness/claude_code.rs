use super::injected_tag;
use crate::jsonl::{self, str, text_of, timestamp, u64};
use crate::source::{files_with_ext, modified};
use crate::{
    Author, Compaction, CompactionTrigger, Event, EventKind, Harness, HarnessId, Home, Inference,
    Message, ReadError, Session, SessionRef, ToolCall, ToolResult, Usage,
};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

pub struct ClaudeCode;

impl Harness for ClaudeCode {
    fn id(&self) -> HarnessId {
        HarnessId::ClaudeCode
    }

    fn discover(&self, home: &Home) -> Vec<SessionRef> {
        let projects = home.var_or("CLAUDE_CONFIG_DIR", ".claude").join("projects");
        let Ok(dirs) = std::fs::read_dir(&projects) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for dir in dirs.flatten().map(|d| d.path()).filter(|p| p.is_dir()) {
            for path in files_with_ext(&dir, "jsonl", 0) {
                out.push(session_ref(&path, None));
                let stem = stem(&path);
                for child in files_with_ext(&dir.join(&stem).join("subagents"), "jsonl", 0) {
                    out.push(session_ref(&child, Some(stem.clone())));
                }
            }
        }
        out
    }

    fn read(&self, r: &SessionRef) -> Result<Session, ReadError> {
        let (lines, diagnostics) = jsonl::read(&r.path)?;
        let mut session = Session {
            id: stem(&r.path),
            harness: HarnessId::ClaudeCode,
            path: r.path.clone(),
            cwd: None,
            parent: r.parent.clone(),
            events: Vec::new(),
            diagnostics,
        };
        let mut inference_at: HashMap<String, usize> = HashMap::new();
        for line in &lines {
            if session.cwd.is_none() {
                session.cwd = str(line, "cwd").map(Into::into);
            }
            let at = timestamp(line, "timestamp");
            let mut push = |kind| session.events.push(Event { at, kind });
            match str(line, "type") {
                Some("system") if str(line, "subtype") == Some("compact_boundary") => {
                    push(EventKind::Compaction(compaction(line)))
                }
                Some("assistant") => {
                    let message = &line["message"];
                    if let Some(inference) = inference(line, message) {
                        let id = str(message, "id").unwrap_or_default().to_string();
                        match inference_at.get(&id) {
                            Some(&i) if !id.is_empty() => {
                                session.events[i].kind = EventKind::Inference(inference)
                            }
                            _ => {
                                inference_at.insert(id, session.events.len());
                                session.events.push(Event {
                                    at,
                                    kind: EventKind::Inference(inference),
                                });
                            }
                        }
                    }
                    for item in blocks(message) {
                        match str(item, "type") {
                            Some("text") => session.events.push(Event {
                                at,
                                kind: EventKind::Message(Message {
                                    author: Author::Assistant,
                                    text: text_of(&item["text"]),
                                }),
                            }),
                            Some("tool_use") => session.events.push(Event {
                                at,
                                kind: EventKind::ToolCall(ToolCall {
                                    id: str(item, "id").map(Into::into),
                                    name: str(item, "name").unwrap_or_default().into(),
                                }),
                            }),
                            _ => {}
                        }
                    }
                }
                Some("user") => {
                    for kind in user_events(line) {
                        session.events.push(Event { at, kind });
                    }
                }
                _ => {}
            }
        }
        Ok(session)
    }
}

fn session_ref(path: &Path, parent: Option<String>) -> SessionRef {
    SessionRef {
        harness: HarnessId::ClaudeCode,
        path: path.into(),
        modified: modified(path),
        parent,
    }
}

fn stem(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn blocks(message: &Value) -> &[Value] {
    message["content"].as_array().map_or(&[], Vec::as_slice)
}

fn compaction(line: &Value) -> Compaction {
    let meta = &line["compactMetadata"];
    Compaction {
        trigger: match str(meta, "trigger") {
            Some("auto") => CompactionTrigger::Auto,
            Some("manual") => CompactionTrigger::Manual,
            _ => CompactionTrigger::Unknown,
        },
        tokens_before: meta.get("preTokens").and_then(Value::as_u64),
    }
}

fn inference(line: &Value, message: &Value) -> Option<Inference> {
    let usage = message.get("usage")?;
    let usage = Usage {
        input: u64(usage, "input_tokens"),
        cache_read: u64(usage, "cache_read_input_tokens"),
        cache_write: u64(usage, "cache_creation_input_tokens"),
        output: u64(usage, "output_tokens"),
    };
    if usage == Usage::default() {
        return None;
    }
    Some(Inference {
        model: str(message, "model").map(Into::into),
        effort: str(line, "perTurnEffort")
            .or_else(|| str(line, "effort"))
            .map(Into::into),
        usage,
    })
}

fn user_events(line: &Value) -> Vec<EventKind> {
    let content = &line["message"]["content"];
    let results: Vec<EventKind> = content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| str(item, "type") == Some("tool_result"))
        .map(|item| {
            EventKind::ToolResult(ToolResult {
                call_id: str(item, "tool_use_id").map(Into::into),
                is_error: item.get("is_error").and_then(Value::as_bool),
                chars: text_of(&item["content"]).chars().count(),
            })
        })
        .collect();
    if !results.is_empty() {
        return results;
    }
    let text = text_of(content);
    if text.trim().is_empty() {
        return Vec::new();
    }
    let flagged = line.get("isMeta").and_then(Value::as_bool) == Some(true)
        || line.get("isCompactSummary").and_then(Value::as_bool) == Some(true);
    let (author, text) = match command(&text) {
        Some(command) if !flagged => (Author::User, command),
        _ if flagged || injected_tag(&text) || text.starts_with("Caveat:") => {
            (Author::Injected, text)
        }
        _ => (Author::User, text),
    };
    vec![EventKind::Message(Message { author, text })]
}

fn command(text: &str) -> Option<String> {
    let name = between(text, "<command-name>", "</command-name>")?;
    let args = between(text, "<command-args>", "</command-args>").unwrap_or_default();
    Some(format!("{name} {args}").trim().to_string())
}

fn between<'a>(text: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = text.find(open)? + open.len();
    let end = text[start..].find(close)? + start;
    Some(text[start..end].trim())
}
