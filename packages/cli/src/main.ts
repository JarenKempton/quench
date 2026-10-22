#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { Home } from "@quench/history";
import { THEME_LIMIT, MAX_THEME_LIMIT } from "@quench/judge";
import { corrections } from "./commands/corrections.ts";
import { report } from "./commands/report.ts";
import { runs } from "./commands/runs.ts";
import { steering } from "./commands/steering.ts";
import { sources } from "./commands/sources.ts";

const USAGE = `quench — see what your coding agents load, what it costs, and how sessions go

Usage:
  quench report [--days 30] [--json]   totals per harness: starting load, context, models, effort
  quench runs <session-file> [--json]  one session as prompt → what the agent did → your reply
  quench steering <project-dir> [--json]  current instruction files and rule candidates (offline)
  quench sources <session-file> [--json]  recorded file reads and source coverage gaps (offline)
  quench corrections [--days 30] [--examples 10] [--dry-run] [--json]
                                       corrections from people and agents, counted separately
    --themes                          group corrections by intent, retaining sender evidence (opt-in Jev calls)
    --theme-limit <1–${MAX_THEME_LIMIT}>               unique exchanges to group, oldest first (default: ${THEME_LIMIT})
    --host-history <sqlite-file>        optional local T3 provenance (default: ~/.t3/userdata/statev2.sqlite)
    --no-host-history                  use harness metadata and model judgments only
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
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const home = Home.fromEnv();
const [command, ...rest] = positionals;
const days = Number(values.days);
const examples = Number(values.examples);
const themeLimit = Number(values["theme-limit"] ?? THEME_LIMIT);

if (values.help || !command) {
  process.stdout.write(USAGE);
  process.exit(command || values.help ? 0 : 1);
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

switch (command) {
  case "sources":
    process.exitCode = await sources(home, rest, { json: values.json });
    break;
  case "steering":
    process.exitCode = await steering(home, rest, { json: values.json });
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
