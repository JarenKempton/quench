use jiff::Timestamp;
use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub enum HarnessId {
    ClaudeCode,
    Codex,
    Pi,
}

impl HarnessId {
    pub fn label(self) -> &'static str {
        match self {
            HarnessId::ClaudeCode => "Claude Code",
            HarnessId::Codex => "Codex",
            HarnessId::Pi => "Pi",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Session {
    pub id: String,
    pub harness: HarnessId,
    pub path: PathBuf,
    pub cwd: Option<PathBuf>,
    pub parent: Option<String>,
    pub events: Vec<Event>,
    pub diagnostics: crate::Diagnostics,
}

impl Session {
    pub fn started_at(&self) -> Option<Timestamp> {
        self.events.iter().find_map(|e| e.at)
    }

    pub fn ended_at(&self) -> Option<Timestamp> {
        self.events.iter().rev().find_map(|e| e.at)
    }

    pub fn inferences(&self) -> impl Iterator<Item = &Inference> {
        self.events.iter().filter_map(|e| match &e.kind {
            EventKind::Inference(i) => Some(i),
            _ => None,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Event {
    pub at: Option<Timestamp>,
    pub kind: EventKind,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[non_exhaustive]
pub enum EventKind {
    Message(Message),
    Inference(Inference),
    ToolCall(ToolCall),
    ToolResult(ToolResult),
    Compaction(Compaction),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Author {
    User,
    Assistant,
    Injected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    Typed,
    Scheduled,
    Host,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub struct Message {
    pub author: Author,
    pub origin: Origin,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Inference {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub usage: Usage,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Usage {
    pub input: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub output: u64,
}

impl Usage {
    pub fn context(&self) -> u64 {
        self.input + self.cache_read + self.cache_write
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolCall {
    pub id: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolResult {
    pub call_id: Option<String>,
    pub is_error: Option<bool>,
    pub chars: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionTrigger {
    Auto,
    Manual,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub struct Compaction {
    pub trigger: CompactionTrigger,
    pub tokens_before: Option<u64>,
}
