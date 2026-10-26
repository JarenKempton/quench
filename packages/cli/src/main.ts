#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { Home, harnessById } from "@quench/history";
import { THEME_LIMIT, MAX_THEME_LIMIT } from "@quench/judge";
import { corrections } from "./commands/corrections.ts";
import { HOME_FLAGS, SECTIONS, profile } from "./commands/profile.ts";
import { report } from "./commands/report.ts";
import { runs } from "./commands/runs.ts";
import { steering } from "./commands/steering.ts";
import { worktrees } from "./commands/worktrees.ts";
import { sources } from "./commands/sources.ts";
import { version } from "../package.json";

const USAGE = `quench — see what your coding agents load, what it costs, and how sessions go

Usage:
  quench --version                     the installed version
  quench [--days 30] [--scan <dir>]   a short summary: what sessions start with and what is worth a look
  quench profile [section] [--days 30] [--scan <dir>] [--json]
                                       every table, or one section: ${SECTIONS.join(", ")}
    --scan <dir>                       also profile <dir>, or the git repositories directly inside it (repeatable)
  quench worktrees [--days 30] [--json]  idle linked worktrees and which are safe to remove (read-only)
  quench report [--days 30] [--json]   totals per harness: starting load, context, models, effort
  quench runs [session-file] [--json]  one session as prompt → what the agent did → your reply
  quench steering <project-dir> [--json]  current instruction files and rule candidates (offline)
  quench sources [session-file] [--json]  recorded file reads and source coverage gaps (offline)
  quench corrections [--days 30] [--examples 10] [--dry-run] [--json]
                                       corrections from people and agents, counted separately
    --themes                          group corrections by intent, retaining sender evidence (opt-in Jev calls)
    --theme-limit <1–${MAX_THEME_LIMIT}>               unique exchanges to group, oldest first (default: ${THEME_LIMIT})
    --host-history <sqlite-file>        optional local T3 provenance (default: ~/.t3/userdata/statev2.sqlite)
    --no-host-history                  use harness metadata and model judgments only

quench, profile and worktrees keep per-session results in ~/.quench/local/session-places.json,
re-reading only sessions that changed. --no-cache reads everything and writes nothing.

Harness homes are found at their default locations or their own environment variables
(CLAUDE_CONFIG_DIR, CODEX_HOME, PI_CODING_AGENT_DIR). Override with --claude-home,
--codex-home or --pi-home <dir> on any command.
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    days: { type: "string", default: "30" },
    examples: { type: "string", default: "10" },
    "dry-run": { type: "boolean", default: false },
    themes: { type: "boolean", default: false },
    "theme-limit": { type: "string" },
    "host-history": { type: "string" },
    "no-host-history": { type: "boolean", default: false },
    scan: { type: "string", multiple: true, default: [] },
    "claude-home": { type: "string" },
    "codex-home": { type: "string" },
    "pi-home": { type: "string" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
    version: { type: "boolean", short: "v", default: false },
    "no-cache": { type: "boolean", default: false },
  },
});

let home = Home.fromEnv();
for (const [flag, harness] of Object.entries(HOME_FLAGS)) {
  const dir = values[flag as keyof typeof HOME_FLAGS];
  if (home && dir) home = home.withVar(harnessById[harness].home.variable, dir);
}
const [command = "summary", ...rest] = positionals;
const days = Number(values.days);
const examples = Number(values.examples);
const themeLimit = Number(values["theme-limit"] ?? THEME_LIMIT);

if (values.version) {
  process.stdout.write(`quench ${version}\n`);
  process.exit(0);
}
if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (!home) {
  process.stderr.write("HOME is not set\n");
  process.exit(1);
}
if (!Number.isFinite(days) || days <= 0) {
  process.stderr.write("--days must be a positive number\n");
  process.exit(1);
}
if (!Number.isInteger(examples) || examples < 0) {
  process.stderr.write("--examples must be a whole number\n");
  process.exit(1);
}

if (values.themes && command !== "corrections") {
  process.stderr.write("--themes is only available for corrections\n");
  process.exit(1);
}
if (values["theme-limit"] !== undefined && !values.themes) {
  process.stderr.write("--theme-limit requires --themes\n");
  process.exit(1);
}
if (!Number.isInteger(themeLimit) || themeLimit < 1 || themeLimit > MAX_THEME_LIMIT) {
  process.stderr.write(`--theme-limit must be a whole number between 1 and ${MAX_THEME_LIMIT}\n`);
  process.exit(1);
}

if (values.scan.length && command !== "profile" && command !== "summary") {
  process.stderr.write("--scan is only available for profile\n");
  process.exit(1);
}

switch (command) {
  case "summary":
    process.exitCode = await profile(home, {
      days,
      scan: values.scan,
      json: values.json,
      view: "summary",
      cache: !values["no-cache"],
    });
    break;
  case "profile": {
    const view = rest[0] ?? "full";
    if (view !== "full" && !SECTIONS.includes(view as (typeof SECTIONS)[number])) {
      process.stderr.write(`unknown section "${view}"; use one of: ${SECTIONS.join(", ")}\n`);
      process.exitCode = 1;
      break;
    }
    process.exitCode = await profile(home, {
      days,
      scan: values.scan,
      json: values.json,
      view: view as (typeof SECTIONS)[number] | "full",
      cache: !values["no-cache"],
    });
    break;
  }
  case "sources":
    process.exitCode = await sources(home, rest, { json: values.json });
    break;
  case "steering":
    process.exitCode = await steering(home, rest, { json: values.json });
    break;
  case "worktrees":
    process.exitCode = await worktrees(home, {
      days,
      json: values.json,
      cache: !values["no-cache"],
    });
    break;
  case "report":
    process.exitCode = await report(home, { days, json: values.json });
    break;
  case "corrections":
    process.exitCode = await corrections(home, {
      days,
      examples,
      json: values.json,
      dryRun: values["dry-run"],
      themes: values.themes,
      themeLimit,
      ...(values["no-host-history"]
        ? { hostHistory: false as const }
        : values["host-history"]
          ? { hostHistory: values["host-history"] }
          : {}),
    });
    break;
  case "runs":
    process.exitCode = await runs(home, rest[0], { json: values.json });
    break;
  default:
    process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
    process.exitCode = 1;
}
