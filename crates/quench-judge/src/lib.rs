//! quench-judge — questions about agent sessions that need a model to answer.
//!
//! [`Judge`] is the seam: callers hand it [`Exchange`]s and get [`Verdict`]s back, never
//! prose. [`Jev`] answers through TypeSafe's typed-decision API with the user's own key;
//! [`Cached`] wraps any judge so an exchange is only ever paid for once.

mod cache;
mod jev;

pub use cache::Cached;
pub use jev::Jev;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
pub struct Exchange {
    pub assistant_said: String,
    pub reply: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplyKind {
    Correction,
    NewRequest,
    Approval,
    Question,
    Info,
}

impl ReplyKind {
    pub const ALL: [ReplyKind; 5] = [
        ReplyKind::Correction,
        ReplyKind::NewRequest,
        ReplyKind::Approval,
        ReplyKind::Question,
        ReplyKind::Info,
    ];

    pub fn key(self) -> &'static str {
        match self {
            ReplyKind::Correction => "correction",
            ReplyKind::NewRequest => "new_request",
            ReplyKind::Approval => "approval",
            ReplyKind::Question => "question",
            ReplyKind::Info => "info",
        }
    }

    pub fn meaning(self) -> &'static str {
        match self {
            ReplyKind::Correction => {
                "Says the assistant was wrong, ignored an instruction, or went the wrong direction"
            }
            ReplyKind::NewRequest => "Asks for new or additional work",
            ReplyKind::Approval => "Approves, agrees, or says to continue",
            ReplyKind::Question => "Asks a question",
            ReplyKind::Info => "Gives information or answers a question",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Sender {
    Person,
    Automation,
}

impl Sender {
    pub const ALL: [Sender; 2] = [Sender::Person, Sender::Automation];

    pub fn key(self) -> &'static str {
        match self {
            Sender::Person => "person",
            Sender::Automation => "automation",
        }
    }

    pub fn meaning(self) -> &'static str {
        match self {
            Sender::Person => "The person who owns this work typed it themselves, in first person",
            Sender::Automation => "Another AI agent, bot or tool wrote it: it refers to the owner in third person, coordinates other agents' tasks, or reports status",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Verdict {
    pub kind: ReplyKind,
    pub sender: Sender,
    pub confidence: f32,
}

#[derive(Debug, thiserror::Error)]
pub enum JudgeError {
    #[error("the judge rejected the API key (HTTP {0})")]
    Unauthorized(u16),
    #[error("the judge returned HTTP {status}: {body}")]
    Http { status: u16, body: String },
    #[error("could not reach the judge: {0}")]
    Network(String),
    #[error("the judge answered in an unexpected shape: {0}")]
    Shape(String),
}

pub trait Judge: Send + Sync {
    fn id(&self) -> String;
    fn classify(&self, exchanges: &[Exchange]) -> Vec<Result<Verdict, JudgeError>>;
}
