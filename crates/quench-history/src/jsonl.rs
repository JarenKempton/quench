use crate::{Diagnostics, ReadError};
use jiff::Timestamp;
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::Path;

pub(crate) fn read(path: &Path) -> Result<(Vec<Value>, Diagnostics), ReadError> {
    let file = std::fs::File::open(path).map_err(|source| ReadError::Io {
        path: path.into(),
        source,
    })?;
    let mut values = Vec::new();
    let mut diagnostics = Diagnostics::default();
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|source| ReadError::Io {
            path: path.into(),
            source,
        })?;
        if line.trim().is_empty() {
            continue;
        }
        diagnostics.lines += 1;
        match serde_json::from_str(&line) {
            Ok(value) => values.push(value),
            Err(_) => diagnostics.skipped += 1,
        }
    }
    Ok((values, diagnostics))
}

pub(crate) fn str<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key)?.as_str()
}

pub(crate) fn u64(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0)
}

pub(crate) fn timestamp(v: &Value, key: &str) -> Option<Timestamp> {
    str(v, key)?.parse().ok()
}

pub(crate) fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| match item {
                Value::String(s) => Some(s.as_str()),
                _ => str(item, "text"),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}
