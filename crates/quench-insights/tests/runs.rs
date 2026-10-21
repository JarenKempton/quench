use jiff::Timestamp;
use quench_history::{
    Author, Diagnostics, Event, EventKind, HarnessId, Inference, Message, Session, ToolCall,
    ToolResult, Usage,
};
use quench_insights::{report, runs};

fn at(secs: i64) -> Option<Timestamp> {
    Some(Timestamp::from_second(1_790_000_000 + secs).unwrap())
}

fn say(secs: i64, author: Author, text: &str) -> Event {
    Event {
        at: at(secs),
        kind: EventKind::Message(Message {
            author,
            text: text.into(),
        }),
    }
}

fn call(secs: i64, context: u64, model: &str, effort: &str) -> Event {
    Event {
        at: at(secs),
        kind: EventKind::Inference(Inference {
            model: Some(model.into()),
            effort: Some(effort.into()),
            usage: Usage {
                input: 0,
                cache_read: context,
                cache_write: 0,
                output: 10,
            },
        }),
    }
}

fn tool(secs: i64, error: bool) -> [Event; 2] {
    [
        Event {
            at: at(secs),
            kind: EventKind::ToolCall(ToolCall {
                id: None,
                name: "anything".into(),
            }),
        },
        Event {
            at: at(secs),
            kind: EventKind::ToolResult(ToolResult {
                call_id: None,
                is_error: Some(error),
                chars: 3,
            }),
        },
    ]
}

fn session(id: &str, parent: Option<&str>, events: Vec<Event>) -> Session {
    Session {
        id: id.into(),
        harness: HarnessId::ClaudeCode,
        path: "/dev/null".into(),
        cwd: None,
        parent: parent.map(Into::into),
        events,
        diagnostics: Diagnostics::default(),
    }
}

fn demo() -> (Session, Session) {
    let mut events = vec![
        say(0, Author::Injected, "harness preamble"),
        say(1, Author::User, "build it"),
        call(2, 20_000, "model-a", "high"),
    ];
    events.extend(tool(3, true));
    events.extend([
        call(4, 26_000, "model-a", "high"),
        say(5, Author::Assistant, "done"),
        say(60, Author::User, "no, the other file"),
        call(61, 30_000, "model-b", "medium"),
        say(120, Author::User, "thanks"),
    ]);
    let child = session(
        "child",
        Some("parent"),
        vec![call(3, 5_000, "model-c", "low")],
    );
    (session("parent", None, events), child)
}

#[test]
fn a_run_spans_one_prompt_and_links_the_reply_that_followed() {
    let (parent, child) = demo();
    let found = runs(&parent, &[&child]);
    let summary: Vec<_> = found
        .iter()
        .map(|r| {
            (
                r.prompt.as_deref(),
                r.reply.as_deref(),
                r.inferences,
                r.context_start,
                r.context_peak,
                r.tool_errors,
                r.subagents,
                r.model.as_deref(),
                r.duration_secs(),
            )
        })
        .collect();
    assert_eq!(
        summary,
        vec![
            (
                Some("build it"),
                Some("no, the other file"),
                2,
                Some(20_000),
                26_000,
                1,
                1,
                Some("model-a"),
                Some(4)
            ),
            (
                Some("no, the other file"),
                Some("thanks"),
                1,
                Some(30_000),
                30_000,
                0,
                0,
                Some("model-b"),
                Some(1)
            ),
        ]
    );
}

#[test]
fn the_report_counts_starting_load_against_everything_processed() {
    let (parent, child) = demo();
    let r = report(&[parent, child]);
    let h = &r.harnesses[0];
    assert_eq!((h.sessions, h.subagent_sessions, h.runs), (1, 1, 2));
    assert_eq!(h.tokens_processed, 20_000 + 26_000 + 30_000 + 5_000);
    assert_eq!(h.starting_load_tokens, 20_000 * 3 + 5_000);
    assert_eq!(h.starting_load.p50, 20_000);
    assert_eq!((h.tool_errors, h.tool_results_with_status), (1, 1));
    assert_eq!(h.models[0].name, "model-a");
}

#[test]
fn an_empty_history_reports_nothing() {
    assert!(report(&[]).harnesses.is_empty());
}
