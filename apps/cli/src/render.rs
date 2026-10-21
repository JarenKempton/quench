use quench_history::Session;
use quench_insights::{Count, Distribution, HarnessReport, Report, Run};
use std::fmt::Write;

pub fn report(report: &Report, days: i64, unreadable: usize) -> String {
    let mut out = String::new();
    if report.harnesses.is_empty() {
        let _ = writeln!(out, "No sessions found in the last {days} days.");
        return out;
    }
    let _ = writeln!(out, "Last {days} days\n");
    for h in &report.harnesses {
        harness(&mut out, h);
    }
    if unreadable > 0 {
        let _ = writeln!(out, "{unreadable} session files could not be read.");
    }
    out
}

fn harness(out: &mut String, h: &HarnessReport) {
    let name = h.harness.label();
    let _ = writeln!(out, "{name}");
    let rows = [
        (
            "Sessions",
            format!("{} (+{} subagent)", h.sessions, h.subagent_sessions),
        ),
        ("Agent runs", h.runs.to_string()),
        ("Model calls", h.inferences.to_string()),
        ("Tokens processed", tokens(h.tokens_processed)),
        (
            "Starting load",
            format!(
                "{}  ({:.0}% of tokens processed)",
                spread(&h.starting_load),
                h.starting_share() * 100.0
            ),
        ),
        ("Peak context", spread(&h.peak_context)),
        (
            "Compactions",
            format!("{} in {} sessions", h.compactions, h.compacted_sessions),
        ),
        ("Tool calls", tool_calls(h)),
        ("Models", top(&h.models)),
        ("Effort", top(&h.efforts)),
    ];
    for (label, value) in rows {
        let _ = writeln!(out, "  {label:<18}{value}");
    }
    if h.skipped_lines > 0 {
        let _ = writeln!(out, "  {:<18}{}", "Unparsed lines", h.skipped_lines);
    }
    let _ = writeln!(out);
}

fn spread(d: &Distribution) -> String {
    if d.n == 0 {
        return "none".into();
    }
    format!(
        "median {}  (p10 {}, p90 {})",
        tokens(d.p50),
        tokens(d.p10),
        tokens(d.p90)
    )
}

fn tokens(n: u64) -> String {
    match n {
        0..1_000 => n.to_string(),
        1_000..1_000_000 => format!("{:.1}k", n as f64 / 1e3),
        1_000_000..1_000_000_000 => format!("{:.1}M", n as f64 / 1e6),
        _ => format!("{:.1}B", n as f64 / 1e9),
    }
}

fn top(counts: &[Count]) -> String {
    let total: usize = counts.iter().map(|c| c.count).sum();
    counts
        .iter()
        .take(4)
        .map(|c| {
            format!(
                "{} {:.0}%",
                c.name,
                100.0 * c.count as f64 / total.max(1) as f64
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn tool_calls(h: &HarnessReport) -> String {
    if h.tool_results_with_status == 0 {
        return format!("{} (errors not recorded)", h.tool_calls);
    }
    format!("{} ({} errors)", h.tool_calls, h.tool_errors)
}

pub fn runs(session: &Session, runs: &[Run]) -> String {
    let mut out = String::new();
    let cwd = session
        .cwd
        .as_ref()
        .map_or("unknown folder".into(), |p| p.display().to_string());
    let _ = writeln!(
        out,
        "{} session {} in {}\n",
        session.harness.label(),
        session.id,
        cwd
    );
    for (i, run) in runs.iter().enumerate() {
        let _ = writeln!(out, "#{:<3} {}", i + 1, quote(run.prompt.as_deref()));
        let _ = writeln!(out, "     {}", facts(run));
        let _ = writeln!(out, "  →  {}\n", quote(run.reply.as_deref()));
    }
    out
}

fn facts(run: &Run) -> String {
    let mut parts = vec![
        run.model.clone().unwrap_or_else(|| "unknown model".into()),
        run.effort
            .clone()
            .unwrap_or_else(|| "effort unknown".into()),
        format!(
            "context {} → {}",
            tokens(run.context_start.unwrap_or(0)),
            tokens(run.context_peak)
        ),
        format!("{} model calls", run.inferences),
        format!("{} tool calls", run.tool_calls),
    ];
    if run.tool_errors > 0 {
        parts.push(format!("{} tool errors", run.tool_errors));
    }
    if run.subagents > 0 {
        parts.push(format!("{} subagents", run.subagents));
    }
    if run.compactions > 0 {
        parts.push(format!("{} compactions", run.compactions));
    }
    if let Some(secs) = run.duration_secs() {
        parts.push(duration(secs));
    }
    parts.join(" · ")
}

fn quote(text: Option<&str>) -> String {
    let Some(text) = text else {
        return "(session ended)".into();
    };
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = line.chars().take(90).collect();
    if cut.len() < line.len() {
        format!("\"{cut}…\"")
    } else {
        format!("\"{cut}\"")
    }
}

fn duration(secs: i64) -> String {
    match secs {
        0..60 => format!("{secs}s"),
        60..3600 => format!("{}m", secs / 60),
        _ => format!("{}h{}m", secs / 3600, secs % 3600 / 60),
    }
}
