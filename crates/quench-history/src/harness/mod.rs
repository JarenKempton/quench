mod claude_code;
mod codex;
mod pi;

use crate::Harness;

pub fn harnesses() -> Vec<Box<dyn Harness>> {
    vec![
        Box::new(claude_code::ClaudeCode),
        Box::new(codex::Codex),
        Box::new(pi::Pi),
    ]
}

pub(crate) fn injected_tag(text: &str) -> bool {
    let Some(rest) = text.trim_start().strip_prefix('<') else {
        return false;
    };
    let name: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    !name.is_empty() && rest[name.len()..].starts_with('>') && text.contains(&format!("</{name}>"))
}
