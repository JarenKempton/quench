use crate::{Exchange, Judge, JudgeError, ReplyKind, Sender, Verdict};
use serde_json::{json, Map, Value};

const ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";
const MODEL: &str = "jev-latest";
const WORKERS: usize = 12;
const ASSISTANT_CHARS: usize = 1500;
const REPLY_CHARS: usize = 2000;

pub struct Jev {
    key: String,
    endpoint: String,
}

impl Jev {
    pub fn new(key: impl Into<String>) -> Self {
        Jev {
            key: key.into(),
            endpoint: ENDPOINT.into(),
        }
    }

    pub fn from_env() -> Option<Self> {
        let key = std::env::var("TYPESAFE_API_KEY").ok()?;
        let key = key.trim();
        (!key.is_empty()).then(|| Jev::new(key))
    }

    pub fn with_endpoint(mut self, endpoint: impl Into<String>) -> Self {
        self.endpoint = endpoint.into();
        self
    }

    fn one(&self, exchange: &Exchange) -> Result<Verdict, JudgeError> {
        let kind = self.ask(kind_request(exchange))?;
        let sender = self.ask(sender_request(exchange))?;
        parse(&kind, &sender)
    }

    fn ask(&self, request: Value) -> Result<Value, JudgeError> {
        let response = ureq::post(&self.endpoint)
            .set("Authorization", &format!("Bearer {}", self.key))
            .send_json(request);
        let body: Value = match response {
            Ok(r) => r
                .into_json()
                .map_err(|e| JudgeError::Shape(e.to_string()))?,
            Err(ureq::Error::Status(status @ (401 | 403), _)) => {
                return Err(JudgeError::Unauthorized(status))
            }
            Err(ureq::Error::Status(status, r)) => {
                return Err(JudgeError::Http {
                    status,
                    body: r.into_string().unwrap_or_default(),
                })
            }
            Err(e) => return Err(JudgeError::Network(e.to_string())),
        };
        Ok(body)
    }
}

impl Judge for Jev {
    fn id(&self) -> String {
        format!("jev/{MODEL}/reply-v5")
    }

    fn classify(&self, exchanges: &[Exchange]) -> Vec<Result<Verdict, JudgeError>> {
        let chunk = exchanges.len().div_ceil(WORKERS).max(1);
        std::thread::scope(|scope| {
            let handles: Vec<_> = exchanges
                .chunks(chunk)
                .map(|part| {
                    scope.spawn(move || part.iter().map(|e| self.one(e)).collect::<Vec<_>>())
                })
                .collect();
            handles
                .into_iter()
                .flat_map(|h| h.join().expect("judge worker panicked"))
                .collect()
        })
    }
}

fn kind_request(exchange: &Exchange) -> Value {
    json!({
        "model": MODEL,
        "state": {
            "assistant_said": tail(&exchange.assistant_said, ASSISTANT_CHARS),
            "user_reply": head(&exchange.reply, REPLY_CHARS),
        },
        "questions": {
            "kind": {
                "type": "choice",
                "instructions": "What is the user's reply mainly doing?",
                "criteria": criteria(ReplyKind::ALL, ReplyKind::key, ReplyKind::meaning),
            }
        }
    })
}

fn sender_request(exchange: &Exchange) -> Value {
    json!({
        "model": MODEL,
        "state": { "message": head(&exchange.reply, REPLY_CHARS) },
        "questions": {
            "sender": {
                "type": "choice",
                "instructions": "Who wrote this message?",
                "criteria": criteria(Sender::ALL, Sender::key, Sender::meaning),
            }
        }
    })
}

fn criteria<T: Copy>(
    options: impl IntoIterator<Item = T>,
    key: fn(T) -> &'static str,
    meaning: fn(T) -> &'static str,
) -> Map<String, Value> {
    options
        .into_iter()
        .map(|o| (key(o).to_string(), Value::from(meaning(o))))
        .collect()
}

fn parse(kind: &Value, sender_answer: &Value) -> Result<Verdict, JudgeError> {
    Ok(Verdict {
        kind: choice(kind, "kind", ReplyKind::ALL, ReplyKind::key)?,
        sender: choice(sender_answer, "sender", Sender::ALL, Sender::key)?,
        confidence: kind["answers"]["kind"]["confidence"]
            .as_f64()
            .unwrap_or(0.0) as f32,
    })
}

fn choice<T: Copy, const N: usize>(
    body: &Value,
    question: &str,
    options: [T; N],
    key: fn(T) -> &'static str,
) -> Result<T, JudgeError> {
    let picked = body["answers"][question]["choice"]
        .as_str()
        .ok_or_else(|| JudgeError::Shape(body.to_string()))?;
    options
        .into_iter()
        .find(|o| key(*o) == picked)
        .ok_or_else(|| JudgeError::Shape(format!("unknown {question} {picked}")))
}

fn head(text: &str, chars: usize) -> String {
    text.chars().take(chars).collect()
}

fn tail(text: &str, chars: usize) -> String {
    let skip = text.chars().count().saturating_sub(chars);
    text.chars().skip(skip).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sender_question_never_sees_the_agent_message() {
        let exchange = Exchange {
            assistant_said: "x".repeat(5000),
            reply: "no, the other file".into(),
        };
        let kind = kind_request(&exchange);
        let sender = sender_request(&exchange);
        assert_eq!(
            kind["state"]["assistant_said"].as_str().unwrap().len(),
            ASSISTANT_CHARS
        );
        assert_eq!(
            kind["questions"]["kind"]["criteria"]
                .as_object()
                .unwrap()
                .len(),
            ReplyKind::ALL.len()
        );
        assert_eq!(sender["state"], json!({"message": "no, the other file"}));
    }

    #[test]
    fn reads_both_answers() {
        let kind = json!({"answers": {"kind": {"choice": "correction", "confidence": 0.9}}});
        let sender = json!({"answers": {"sender": {"choice": "automation"}}});
        let verdict = parse(&kind, &sender).unwrap();
        assert_eq!(
            (verdict.kind, verdict.sender, verdict.confidence),
            (ReplyKind::Correction, Sender::Automation, 0.9)
        );
        assert!(parse(&json!({"answers": {"kind": {"choice": "praise"}}}), &sender).is_err());
    }
}
