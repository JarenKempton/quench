#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { Home } from "@quench/history";
import { report } from "./commands/report.ts";
import { runs } from "./commands/runs.ts";

const USAGE = `quench — see what your coding agents load, what it costs, and how sessions go

Usage:
  quench report [--days 30] [--json]   totals per harness: starting load, context, models, effort
  quench runs <session-file> [--json]  one session as prompt → what the agent did → your reply
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    days: { type: "string", default: "30" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const home = Home.fromEnv();
const [command, ...rest] = positionals;
const days = Number(values.days);

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

switch (command) {
  case "report":
    process.exitCode = await report(home, { days, json: values.json });
    break;
  case "runs":
    process.exitCode = await runs(home, rest[0], { json: values.json });
    break;
  default:
    process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
    process.exitCode = 1;
}
