mod render;

use clap::{Parser, Subcommand};
use jiff::{Timestamp, ToSpan};
use quench_history::{discover_all, read_all, Home};
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
}

fn main() -> ExitCode {
    let Command::Report { days, json } = Cli::parse().command;
    let Some(home) = Home::from_env() else {
        eprintln!("HOME is not set");
        return ExitCode::FAILURE;
    };
    let since = Timestamp::now().checked_sub((days * 24).hours()).ok();
    let refs = discover_all(&home, since);
    let (sessions, failures): (Vec<_>, Vec<_>) =
        read_all(&refs).into_iter().partition(Result::is_ok);
    let sessions: Vec<_> = sessions.into_iter().flatten().collect();
    let report = quench_insights::report(&sessions);
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&report).expect("report serializes")
        );
    } else {
        print!("{}", render::report(&report, days, failures.len()));
    }
    ExitCode::SUCCESS
}
