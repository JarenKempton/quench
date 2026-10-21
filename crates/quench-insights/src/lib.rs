//! quench-insights — analysis over [`quench_history::Session`]s.
//!
//! Nothing here knows which harness wrote a session. A [`Run`] is everything an agent did
//! between two user messages; a [`Report`] aggregates sessions and runs per harness.

mod distribution;
mod report;
mod run;
mod signals;

pub use distribution::Distribution;
pub use report::{report, Count, HarnessReport, Report};
pub use run::{runs, Run};
pub use signals::{signals, Bucket, Sample, Signal};
