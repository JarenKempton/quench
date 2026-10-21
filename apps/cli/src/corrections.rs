use crate::print_json;
use crate::render::{facts, quote};
use quench_app::QuenchHome;
use quench_history::{Home, Origin, Session};
use quench_insights::{runs, signals, Run, Sample, Signal};
use quench_judge::{Cached, Exchange, Jev, Judge, JudgeError, ReplyKind, Sender, Verdict};
use serde::Serialize;
use std::collections::BTreeMap;
use std::fmt::Write;
use std::process::ExitCode;

const MIN_BUCKET: usize = 15;

const NO_KEY: &str = "Classifying replies uses Jev (typesafe.ai) with your own key. It sends each reply, plus the end of the agent message before it.
Set TYPESAFE_API_KEY to opt in. Answers are cached in ~/.quench/local/judgments.jsonl, so each reply is paid for once.";

struct Reply<'a> {
    session: &'a Session,
    position: usize,
    run: &'a Run,
    kind: Option<ReplyKind>,
    sender: Option<Sender>,
}

impl Reply<'_> {
    fn is_correction(&self) -> bool {
        self.kind == Some(ReplyKind::Correction)
    }
}

#[derive(Serialize)]
struct Output<'a> {
    judge: String,
    newly_judged: usize,
    failed: usize,
    from_people: Tally,
    from_automation: Tally,
    signals: Vec<Signal>,
    latest: Vec<Example<'a>>,
}

#[derive(Serialize, Default)]
struct Tally {
    replies: usize,
    kinds: BTreeMap<ReplyKind, usize>,
}

impl Tally {
    fn of(replies: &[&Reply]) -> Self {
        let mut kinds = BTreeMap::new();
        for kind in replies.iter().filter_map(|r| r.kind) {
            *kinds.entry(kind).or_default() += 1;
        }
        Tally {
            replies: replies.len(),
            kinds,
        }
    }

    fn corrections(&self) -> usize {
        self.kinds.get(&ReplyKind::Correction).copied().unwrap_or(0)
    }

    fn judged(&self) -> usize {
        self.kinds.values().sum()
    }
}

#[derive(Serialize)]
struct Example<'a> {
    harness: &'static str,
    folder: Option<String>,
    reply: &'a str,
    run: &'a Run,
}

pub fn run(home: &Home, sessions: &[Session], days: i64, examples: usize, json: bool) -> ExitCode {
    let Some(jev) = Jev::from_env() else {
        eprintln!("{NO_KEY}");
        return ExitCode::from(2);
    };
    let judge = Cached::open(
        jev,
        QuenchHome::for_user(home.dir())
            .local()
            .join("judgments.jsonl"),
    );
    let before = judge.known();
    let all_runs = runs_by_session(sessions);
    let replies = match judge_replies(&judge, &all_runs) {
        Ok(replies) => replies,
        Err(code) => {
            eprintln!("TypeSafe rejected TYPESAFE_API_KEY (HTTP {code}). Check it has no extra characters.");
            return ExitCode::FAILURE;
        }
    };
    let output = summarize(&judge, before, &replies, examples);
    if json {
        print_json(&output);
    } else {
        print!("{}", render(&output, days));
    }
    ExitCode::SUCCESS
}

fn runs_by_session(sessions: &[Session]) -> Vec<(&Session, Vec<Run>)> {
    sessions
        .iter()
        .filter(|s| s.parent.is_none())
        .map(|s| {
            let children: Vec<&Session> = sessions
                .iter()
                .filter(|c| c.harness == s.harness && c.parent.as_deref() == Some(&s.id))
                .collect();
            (s, runs(s, &children))
        })
        .collect()
}

fn judge_replies<'a>(
    judge: &impl Judge,
    all_runs: &'a [(&'a Session, Vec<Run>)],
) -> Result<Vec<Reply<'a>>, u16> {
    let asked: Vec<(&Session, usize, &Run)> = all_runs
        .iter()
        .flat_map(|(s, list)| list.iter().enumerate().map(move |(i, r)| (*s, i + 1, r)))
        .filter(|(_, _, r)| r.reply.is_some())
        .collect();
    let exchanges: Vec<Exchange> = asked
        .iter()
        .map(|(_, _, r)| Exchange {
            assistant_said: r.assistant_said.clone().unwrap_or_default(),
            reply: r.reply.clone().unwrap_or_default(),
        })
        .collect();
    let verdicts = judge.classify(&exchanges);
    if let Some(JudgeError::Unauthorized(code)) = verdicts.iter().find_map(|v| v.as_ref().err()) {
        return Err(*code);
    }
    Ok(asked
        .into_iter()
        .zip(verdicts)
        .map(|((session, position, run), verdict)| {
            let verdict = verdict.ok();
            Reply {
                session,
                position,
                run,
                kind: verdict.map(|v| v.kind),
                sender: sender(run.reply_origin, verdict.as_ref()),
            }
        })
        .collect())
}

fn sender(origin: Option<Origin>, verdict: Option<&Verdict>) -> Option<Sender> {
    match origin {
        Some(Origin::Typed) => Some(Sender::Person),
        Some(Origin::Scheduled) => Some(Sender::Automation),
        _ => verdict.map(|v| v.sender),
    }
}

fn summarize<'a>(
    judge: &Cached<Jev>,
    before: usize,
    replies: &'a [Reply<'a>],
    examples: usize,
) -> Output<'a> {
    let (automated, people): (Vec<&Reply>, Vec<&Reply>) = replies
        .iter()
        .partition(|r| r.sender == Some(Sender::Automation));
    let samples: Vec<Sample> = people
        .iter()
        .filter(|r| r.kind.is_some())
        .map(|r| Sample {
            harness: r.session.harness,
            position: r.position,
            run: r.run,
            corrected: r.is_correction(),
        })
        .collect();
    let mut latest: Vec<&&Reply> = people.iter().filter(|r| r.is_correction()).collect();
    latest.sort_by_key(|r| std::cmp::Reverse(r.run.ended_at));
    Output {
        judge: judge.id(),
        newly_judged: judge.known().saturating_sub(before),
        failed: replies.iter().filter(|r| r.kind.is_none()).count(),
        from_people: Tally::of(&people),
        from_automation: Tally::of(&automated),
        signals: signals(&samples),
        latest: latest
            .into_iter()
            .take(examples)
            .map(|r| example(r))
            .collect(),
    }
}

fn example<'a>(r: &Reply<'a>) -> Example<'a> {
    Example {
        harness: r.session.harness.label(),
        folder: r
            .session
            .cwd
            .as_ref()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().into_owned()),
        reply: r.run.reply.as_deref().unwrap_or_default(),
        run: r.run,
    }
}

fn render(o: &Output, days: i64) -> String {
    let mut out = String::new();
    let people = &o.from_people;
    let bots = &o.from_automation;
    let _ = writeln!(
        out,
        "Last {days} days · {} replies to agent runs · judged by {} ({} new, {} failed)\n",
        people.replies + bots.replies,
        o.judge,
        o.newly_judged,
        o.failed
    );
    let _ = writeln!(
        out,
        "Corrections from people         {:>5} of {:>5} replies  ({:.1}%)",
        people.corrections(),
        people.judged(),
        pct(people.corrections(), people.judged())
    );
    let _ = writeln!(
        out,
        "Corrections relayed by agents   {:>5} of {:>5} replies  ({:.1}%)  not counted below\n",
        bots.corrections(),
        bots.judged(),
        pct(bots.corrections(), bots.judged())
    );
    let _ = writeln!(
        out,
        "{:<36}{:>9}{:>12}",
        "What came before a person's reply", "replies", "corrected"
    );
    for signal in &o.signals {
        let shown: Vec<_> = signal
            .buckets
            .iter()
            .filter(|b| b.replies >= MIN_BUCKET)
            .collect();
        if shown.len() < 2 {
            continue;
        }
        let _ = writeln!(out, "{}", signal.name);
        for b in shown {
            let _ = writeln!(
                out,
                "  {:<34}{:>9}{:>11.1}%",
                b.label,
                b.replies,
                b.rate() * 100.0
            );
        }
    }
    let _ = writeln!(
        out,
        "\nBuckets under {MIN_BUCKET} replies are hidden. These are correlations, not causes.\n"
    );
    let _ = writeln!(out, "Latest corrections from people");
    for e in &o.latest {
        let when = e
            .run
            .ended_at
            .map(|t| t.strftime("%Y-%m-%d").to_string())
            .unwrap_or_default();
        let folder = e.folder.as_deref().unwrap_or("?");
        let _ = writeln!(
            out,
            "  {when}  {} · {folder}  {}",
            e.harness,
            quote(Some(e.reply))
        );
        let _ = writeln!(out, "      after: {}", facts(e.run));
    }
    out
}

fn pct(n: usize, of: usize) -> f64 {
    100.0 * n as f64 / of.max(1) as f64
}
