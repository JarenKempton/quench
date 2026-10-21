use quench_judge::{Cached, Exchange, Judge, JudgeError, ReplyKind, Sender, Verdict};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Counting {
    calls: AtomicUsize,
}

impl Judge for Counting {
    fn id(&self) -> String {
        "counting".into()
    }

    fn classify(&self, exchanges: &[Exchange]) -> Vec<Result<Verdict, JudgeError>> {
        exchanges
            .iter()
            .map(|e| {
                self.calls.fetch_add(1, Ordering::SeqCst);
                if e.reply == "fail" {
                    return Err(JudgeError::Network("down".into()));
                }
                Ok(Verdict {
                    kind: if e.reply.starts_with("no") {
                        ReplyKind::Correction
                    } else {
                        ReplyKind::Approval
                    },
                    sender: Sender::Person,
                    confidence: 1.0,
                })
            })
            .collect()
    }
}

fn ex(reply: &str) -> Exchange {
    Exchange {
        assistant_said: "done".into(),
        reply: reply.into(),
    }
}

#[test]
fn each_exchange_is_judged_once_even_across_runs() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("judgments.jsonl");
    let batch = [ex("no, wrong file"), ex("great"), ex("fail")];

    let first = Cached::open(
        Counting {
            calls: AtomicUsize::new(0),
        },
        &path,
    );
    let kinds: Vec<_> = first
        .classify(&batch)
        .into_iter()
        .map(|r| r.map(|v| v.kind).ok())
        .collect();
    assert_eq!(
        kinds,
        vec![Some(ReplyKind::Correction), Some(ReplyKind::Approval), None]
    );

    let reopened = Cached::open(
        Counting {
            calls: AtomicUsize::new(0),
        },
        &path,
    );
    assert_eq!(reopened.known(), 2);
    reopened.classify(&batch);
    assert_eq!(reopened.inner().calls.load(Ordering::SeqCst), 1);
}
