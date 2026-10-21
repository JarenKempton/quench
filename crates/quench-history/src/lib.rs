//! quench-history — session history from every coding-agent harness, in one shape.
//!
//! Each harness gets one [`Harness`] adapter that knows where it keeps sessions and how to
//! parse them. Everything above this crate works on [`Session`] and never branches on which
//! harness produced it. Adding a harness means adding one module and one line in
//! [`harnesses`].

mod harness;
mod jsonl;
mod model;
mod source;

pub use harness::harnesses;
pub use model::{
    Author, Compaction, CompactionTrigger, Event, EventKind, HarnessId, Inference, Message, Origin,
    Session, ToolCall, ToolResult, Usage,
};
pub use source::{discover_all, read_all, Diagnostics, Harness, Home, ReadError, SessionRef};
