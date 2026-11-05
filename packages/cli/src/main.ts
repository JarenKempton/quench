#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { Home, harnessById } from "@quench/history";
import { provider, THEME_LIMIT, MAX_THEME_LIMIT } from "@quench/judge";
import { corrections } from "./commands/corrections.ts";
import { setup, STEPS } from "./commands/setup.ts";
import { judgeChoice, readConfig, secretsIn, typesafeKey } from "./config.ts";
import { HOME_FLAGS, SECTIONS, profile } from "./commands/profile.ts";
import { report } from "./commands/report.ts";
import { allRuns, runs } from "./commands/runs.ts";
import { steering } from "./commands/steering.ts";
import { worktrees } from "./commands/worktrees.ts";
import { sources } from "./commands/sources.ts";
import { secrets } from "./commands/secrets.ts";
import { update } from "./commands/update.ts";
import { skills } from "./commands/skills.ts";
import { connect, hub } from "./commands/hub.ts";
import { agent } from "./commands/agent.ts";
import { resolve } from "node:path";
import { version } from "./version.ts";

const USAGE = `quench — see what your coding agents load, what it costs, and how sessions go

Usage:
  quench --version                     the installed version
  quench update [--channel stable|nightly]  install the newest release of your channel, or switch channel
  quench setup [step] [--judge none] [--yes]
                                       find your agents, show the summary, pick a judge; resumes where it stopped
                                       steps: ${STEPS.join(", ")}; --yes takes each recommended answer
  quench [--days 30] [--scan <dir>]   a short summary: what sessions start with and what is worth a look
  quench profile [section] [--days 30] [--scan <dir>] [--json]
                                       every table, or one section: ${SECTIONS.join(", ")}
    --scan <dir>                       also profile <dir>, or the git repositories directly inside it (repeatable)
  quench worktrees [--days 30] [--json]  idle linked worktrees and which are safe to remove (read-only)
  quench report [--days 30] [--json]   totals per harness: starting load, context, models, effort
  quench runs [session-file | --session <id>] [--json] [--host-history <sqlite-file> | --no-host-history]
                                       one session as prompt → what the agent did → your reply
  quench runs --all --json [--history <dir>]
                                       every run of every session, one JSON object per line
    --history <dir>                    read <dir> as one machine's home, tagged with its folder name (repeatable)
  quench secrets [--days 30] [--json] [--repo-history] [--host-history <sqlite-file> | --no-host-history]
                                       credentials exposed in histories, configs and files worms harvest (offline)
  quench steering <project-dir> [--days 30] [--rules] [--json]
                                       instruction items ranked by recorded load; duplicates, conflicts, stale entries (offline)
    --rules                            also list every bullet and paragraph of each file
  quench sources [session-file] [--json]  recorded file reads and source coverage gaps (offline)
  quench skills [--days 30] [--json] [--source <dir>]
                                       one record per skill, agent and location: origin, listing size, use, corrections
    --source <dir>                     compare installed skills with a skills checkout by tree hash (read-only)
  quench skills plan --source <dir> --machine <name> [--project <dir>] --json
                                       what installing a skills checkout would change on this machine (read-only)
  quench hub serve [--data <dir>] [--listen <host:port>] [--url <public url>] [--mirror <git remote>]
                   [--tls-cert <pem> --tls-key <pem> | --http]
                                       run the fleet hub; first run needs QUENCH_HUB_PASSWORD (--http: loopback only)
  quench hub import <git-url|path> [--data <dir>]
                                       bring a skills repo into a new hub with its history, plus one fleet-file commit
  quench connect <https://hub> --code XXXX-XXXX [--pin sha256:…]
                                       pair this machine with a hub and fetch its bundle
  quench skills apply --source <dir> --machine <name> --plan <hash> [--project <dir>] [--json]
                                       install, update and remove the planned skill folders; refuses if disk changed
  quench skills status --source <dir> --machine <name> [--project <dir>] [--json]
                                       conflicts, drift and installation history; exits 1 on conflicts or drift
    --project <dir>                    also place project-scoped skills into this checkout (repeatable)
  quench skills eval <skill> --candidate <dir> [--limit 5] [--max-cost 1] [--yes] [--json]
                                       replay first prompts against the installed and a candidate skill in scratch
                                       Claude Code homes (Linux, macOS); shows a cost estimate and asks first
  quench agent install|uninstall|run [--source <dir> --machine <name>] [--interval 300] [--once]
                                       a user service that keeps applying the paired hub's bundle, or the
                                       source, and reports to the hub; never updates itself
  quench corrections [--days 30] [--examples 10] [--dry-run] [--json]
                                       corrections from people and agents, counted separately
  quench corrections [session-file...] [--session <id>]... [--causes] [--json]
                                       corrections in those sessions only, with transcript line locators
    --themes                          group corrections by intent, retaining sender evidence (opt-in Jev calls)
    --theme-limit <1–${MAX_THEME_LIMIT}>               unique exchanges to group, oldest first (default: ${THEME_LIMIT})
    --causes                          ask what the agent did wrong, for corrections only, beside its behaviour (opt-in Jev calls)
    --context                         recurring corrections with the skills and instruction files in context (read-only)
    --cached-only                     use cached reply verdicts only; never classify new replies
    --judge jev|claude|openai|none     who classifies replies: the one quench setup picked, else Jev (TYPESAFE_API_KEY);
                                       claude -p on your own account; an OpenAI-compatible endpoint
                                       (QUENCH_OPENAI_BASE_URL, QUENCH_OPENAI_MODEL, QUENCH_OPENAI_API_KEY); or none
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
    days: { type: "string" },
    examples: { type: "string", default: "10" },
    "dry-run": { type: "boolean", default: false },
    themes: { type: "boolean", default: false },
    causes: { type: "boolean", default: false },
    context: { type: "boolean", default: false },
    "cached-only": { type: "boolean", default: false },
    "theme-limit": { type: "string" },
    judge: { type: "string" },
    yes: { type: "boolean", short: "y", default: false },
    "host-history": { type: "string" },
    "no-host-history": { type: "boolean", default: false },
    "repo-history": { type: "boolean", default: false },
    scan: { type: "string", multiple: true, default: [] },
    "claude-home": { type: "string" },
    "codex-home": { type: "string" },
    "pi-home": { type: "string" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
    version: { type: "boolean", short: "v", default: false },
    "no-cache": { type: "boolean", default: false },
    session: { type: "string", multiple: true, default: [] },
    all: { type: "boolean", default: false },
    rules: { type: "boolean", default: false },
    history: { type: "string", multiple: true, default: [] },
    channel: { type: "string" },
    source: { type: "string" },
    machine: { type: "string" },
    data: { type: "string" },
    listen: { type: "string" },
    http: { type: "boolean", default: false },
    url: { type: "string" },
    mirror: { type: "string" },
    "tls-cert": { type: "string" },
    "tls-key": { type: "string" },
    code: { type: "string" },
    pin: { type: "string" },
    plan: { type: "string" },
    project: { type: "string", multiple: true, default: [] },
    interval: { type: "string", default: "300" },
    once: { type: "boolean", default: false },
    candidate: { type: "string" },
    limit: { type: "string" },
    "max-cost": { type: "string" },
  },
});

let home = Home.fromEnv();
for (const [flag, harness] of Object.entries(HOME_FLAGS)) {
  const dir = values[flag as keyof typeof HOME_FLAGS];
  if (home && dir) home = home.withVar(harnessById[harness].home.variable, dir);
}
const [command = "summary", ...rest] = positionals;
const days = Number(values.days ?? "30");
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
if (values.causes && command !== "corrections") {
  process.stderr.write("--causes is only available for corrections\n");
  process.exit(1);
}
if (values.context && command !== "corrections") {
  process.stderr.write("--context is only available for corrections\n");
  process.exit(1);
}
if (values["cached-only"] && command !== "corrections") {
  process.stderr.write("--cached-only is only available for corrections\n");
  process.exit(1);
}
if (values.judge !== undefined && command !== "corrections" && command !== "setup") {
  process.stderr.write("--judge is only available for corrections and setup\n");
  process.exit(1);
}
const evaluating = command === "skills" && rest[0] === "eval";
if (values.yes && command !== "setup" && !evaluating) {
  process.stderr.write("--yes is only available for setup and skills eval\n");
  process.exit(1);
}
const config = await readConfig(home.dir);
if (values["theme-limit"] !== undefined && !values.themes) {
  process.stderr.write("--theme-limit requires --themes\n");
  process.exit(1);
}
if (!Number.isInteger(themeLimit) || themeLimit < 1 || themeLimit > MAX_THEME_LIMIT) {
  process.stderr.write(`--theme-limit must be a whole number between 1 and ${MAX_THEME_LIMIT}\n`);
  process.exit(1);
}

if (values.session.length && command !== "runs" && command !== "corrections") {
  process.stderr.write("--session is only available for runs and corrections\n");
  process.exit(1);
}
if (command === "runs" && values.session.length > 1) {
  process.stderr.write("runs takes one --session\n");
  process.exit(1);
}
const scoped = command === "corrections" && (rest.length > 0 || values.session.length > 0);
if (scoped && values.days !== undefined) {
  process.stderr.write("--days can't be combined with session scope\n");
  process.exit(2);
}
if (scoped && (values.themes || values.context)) {
  process.stderr.write("--themes and --context read all history; drop them with session scope\n");
  process.exit(1);
}
if ((values.all || values.history.length) && command !== "runs") {
  process.stderr.write("--all and --history are only available for runs\n");
  process.exit(1);
}
if (values.history.length && !values.all) {
  process.stderr.write("--history requires --all\n");
  process.exit(1);
}
if (values.all && (!values.json || values.session.length || rest.length)) {
  process.stderr.write("--all takes no session and needs --json\n");
  process.exit(1);
}
if (values.channel !== undefined && command !== "update") {
  process.stderr.write("--channel is only available for update\n");
  process.exit(1);
}
if (values.channel !== undefined && values.channel !== "stable" && values.channel !== "nightly") {
  process.stderr.write("--channel must be stable or nightly\n");
  process.exit(1);
}

if (
  (values.source !== undefined || values.machine !== undefined || values.project.length) &&
  command !== "skills" &&
  command !== "agent"
) {
  process.stderr.write(
    "--source, --machine and --project are only available for skills and agent\n",
  );
  process.exit(1);
}
if (
  (values.candidate !== undefined ||
    values.limit !== undefined ||
    values["max-cost"] !== undefined) &&
  !evaluating
) {
  process.stderr.write("--candidate, --limit and --max-cost are only available for skills eval\n");
  process.exit(1);
}
if (values.plan !== undefined && command !== "skills") {
  process.stderr.write("--plan is only available for skills apply\n");
  process.exit(1);
}
if ((values.once || values.interval !== "300") && command !== "agent") {
  process.stderr.write("--interval and --once are only available for agent\n");
  process.exit(1);
}

const HUB_FLAGS = ["data", "listen", "http", "url", "mirror", "tls-cert", "tls-key"] as const;
if (HUB_FLAGS.some((f) => values[f] !== undefined && values[f] !== false) && command !== "hub") {
  process.stderr.write(`--${HUB_FLAGS.join(", --")} are only available for hub\n`);
  process.exit(1);
}
if ((values.code !== undefined || values.pin !== undefined) && command !== "connect") {
  process.stderr.write("--code and --pin are only available for connect\n");
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
    process.exitCode = await steering(home, rest, {
      json: values.json,
      days,
      rules: values.rules,
      cache: !values["no-cache"],
    });
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
  case "setup":
    process.exitCode = await setup(home, rest[0], {
      ...(values.judge === undefined ? {} : { judge: values.judge }),
      yes: values.yes,
    });
    break;
  case "corrections": {
    const choice = judgeChoice(config, process.env, values.judge);
    const jevKey = typesafeKey(config, process.env);
    const invalid = [choice, ...(values.themes || values.causes ? [jevKey] : [])].find(
      (value) => value instanceof Error,
    );
    if (invalid instanceof Error) {
      process.stderr.write(`${invalid.message}\n`);
      process.exitCode = 1;
      break;
    }
    if (choice instanceof Error) break;
    process.exitCode = await corrections(home, {
      days,
      examples,
      json: values.json,
      dryRun: values["dry-run"],
      themes: values.themes,
      causes: values.causes,
      context: values.context,
      cachedOnly: values["cached-only"],
      judge: provider(choice),
      typesafeKey: jevKey instanceof Error ? undefined : jevKey,
      secrets: secretsIn(config, process.env),
      scope: scoped ? { files: rest, sessions: values.session } : null,
      themeLimit,
      ...(values["no-host-history"]
        ? { hostHistory: false as const }
        : values["host-history"]
          ? { hostHistory: values["host-history"] }
          : {}),
    });
    break;
  }
  case "secrets":
    process.exitCode = await secrets(home, {
      json: values.json,
      days,
      repoHistory: values["repo-history"],
      ...(values["no-host-history"]
        ? { hostHistory: false as const }
        : values["host-history"]
          ? { hostHistory: values["host-history"] }
          : {}),
    });
    break;
  case "skills":
    process.exitCode = await skills(home, rest, {
      json: values.json,
      days,
      cache: !values["no-cache"],
      ...(values["no-host-history"]
        ? { hostHistory: false as const }
        : values["host-history"]
          ? { hostHistory: values["host-history"] }
          : {}),
      projects: values.project,
      ...(values.source ? { source: values.source } : {}),
      ...(values.machine ? { machine: values.machine } : {}),
      ...(values.plan ? { plan: values.plan } : {}),
      eval: {
        yes: values.yes,
        ...(values.candidate ? { candidate: resolve(values.candidate) } : {}),
        ...(values.limit !== undefined ? { limit: values.limit } : {}),
        ...(values["max-cost"] !== undefined ? { maxCost: values["max-cost"] } : {}),
      },
    });
    break;
  case "agent":
    process.exitCode = await agent(home, rest, {
      projects: values.project,
      interval: Number(values.interval),
      once: values.once,
      homeFlags: Object.keys(HOME_FLAGS).flatMap((flag) => {
        const dir = values[flag as keyof typeof HOME_FLAGS];
        return dir ? [`--${flag}`, resolve(dir)] : [];
      }),
      ...(values.source ? { source: values.source } : {}),
      ...(values.machine ? { machine: values.machine } : {}),
    });
    break;
  case "hub":
    process.exitCode = await hub(home, rest, {
      http: values.http,
      ...(values.data ? { data: values.data } : {}),
      ...(values.listen ? { listen: values.listen } : {}),
      ...(values.url ? { url: values.url } : {}),
      ...(values.mirror ? { mirror: values.mirror } : {}),
      ...(values["tls-cert"] ? { tlsCert: values["tls-cert"] } : {}),
      ...(values["tls-key"] ? { tlsKey: values["tls-key"] } : {}),
    });
    break;
  case "connect":
    process.exitCode = await connect(home, rest, {
      ...(values.code ? { code: values.code } : {}),
      ...(values.pin ? { pin: values.pin } : {}),
    });
    break;
  case "update":
    process.exitCode = await update(version, values.channel);
    break;
  case "runs":
    if (values.all) {
      process.exitCode = await allRuns(home, values.history);
      break;
    }
    process.exitCode = await runs(home, rest[0], {
      json: values.json,
      ...(values.session[0] ? { session: values.session[0] } : {}),
      ...(values["no-host-history"]
        ? { hostHistory: false as const }
        : values["host-history"]
          ? { hostHistory: values["host-history"] }
          : {}),
    });
    break;
  default:
    process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
    process.exitCode = 1;
}
