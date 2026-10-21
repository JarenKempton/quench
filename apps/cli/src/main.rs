mod corrections;
mod render;

use clap::{Parser, Subcommand};
use jiff::{Timestamp, ToSpan};
use quench_history::{discover_all, read_all, Home, Session};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

#[derive(Parser)]
#[command(
    version,
    about = "Profile what your coding agents load and how sessions go."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Report {
        #[arg(long, default_value_t = 30)]
        days: i64,
        #[arg(long)]
        json: bool,
    },
    Runs {
        session: PathBuf,
        #[arg(long)]
        json: bool,
    },
    Corrections {
        #[arg(long, default_value_t = 30)]
        days: i64,
        #[arg(long, default_value_t = 10)]
        examples: usize,
        #[arg(long)]
        json: bool,
    },
}

fn main() -> ExitCode {
    let Some(home) = Home::from_env() else {
        eprintln!("HOME is not set");
        return ExitCode::FAILURE;
    };
    match Cli::parse().command {
        Command::Report { days, json } => report(&home, days, json),
        Command::Runs { session, json } => runs(&home, &session, json),
        Command::Corrections {
            days,
            examples,
            json,
        } => {
            let (sessions, _) = load(&home, since(days), |_| true);
            corrections::run(&home, &sessions, days, examples, json)
        }
    }
}

fn report(home: &Home, days: i64, json: bool) -> ExitCode {
    let (sessions, unreadable) = load(home, since(days), |_| true);
    let report = quench_insights::report(&sessions);
    if json {
        print_json(&report);
    } else {
        print!("{}", render::report(&report, days, unreadable));
    }
    ExitCode::SUCCESS
}

fn runs(home: &Home, path: &Path, json: bool) -> ExitCode {
    let Ok(path) = path.canonicalize() else {
        eprintln!("{} does not exist", path.display());
        return ExitCode::FAILURE;
    };
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned());
    let (sessions, _) = load(home, None, |r| {
        r.path == path
            || (r.parent.is_some()
                && r.parent == stem
                && r.path.starts_with(path.with_extension("")))
    });
    let Some(session) = sessions.iter().find(|s| s.path == path) else {
        eprintln!(
            "{} is not a session any known harness wrote",
            path.display()
        );
        return ExitCode::FAILURE;
    };
    let children: Vec<&Session> = sessions.iter().filter(|s| s.parent.is_some()).collect();
    let runs = quench_insights::runs(session, &children);
    if json {
        print_json(&runs);
    } else {
        print!("{}", render::runs(session, &runs));
    }
    ExitCode::SUCCESS
}

fn since(days: i64) -> Option<Timestamp> {
    Timestamp::now().checked_sub((days * 24).hours()).ok()
}

fn load(
    home: &Home,
    since: Option<Timestamp>,
    keep: impl Fn(&quench_history::SessionRef) -> bool,
) -> (Vec<Session>, usize) {
    let refs: Vec<_> = discover_all(home, since)
        .into_iter()
        .filter(|r| keep(r))
        .collect();
    let (ok, failed): (Vec<_>, Vec<_>) = read_all(&refs).into_iter().partition(Result::is_ok);
    (ok.into_iter().flatten().collect(), failed.len())
}

pub(crate) fn print_json(value: &impl serde::Serialize) {
    println!(
        "{}",
        serde_json::to_string_pretty(value).expect("output serializes")
    );
}
