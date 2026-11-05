import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { SkillName, treeHash } from "@quench/fleet";
import { readTree } from "@quench/fleet/disk";
import { readLedger } from "@quench/fleet/apply";
import { discoverAll, readSessions, type Home, type Session } from "@quench/history";
import { CHILD_ENV } from "@quench/judge";
import { prompt as ask } from "../prompt.ts";
import {
  DEFAULT_MAX_COST,
  DEFAULT_PROMPTS,
  estimate,
  evalSupported,
  MAX_COST,
  MAX_PROMPTS,
  rowJson,
  runCost,
  selectPrompts,
  SPEND_STOP,
  summarise,
  type Row,
} from "../skills/eval.ts";
import { PROVIDER_WARNING, renderPreview, renderResults } from "../skills/eval-render.ts";
import { CREDENTIAL_VARS, replay } from "../skills/replay.ts";
import { stateDir, userSkillRoot } from "./skills.ts";

export type EvalFlags = {
  candidate?: string;
  limit?: string;
  maxCost?: string;
  yes: boolean;
  json: boolean;
  days: number;
};

export type EvalDeps = {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  confirm?: (question: string) => Promise<boolean>;
};

class EvalError extends Error {}

const fail = (message: string): never => {
  throw new EvalError(message);
};

async function skillTree(dir: string, what: string) {
  const info = await lstat(join(dir, "SKILL.md")).catch(() => null);
  if (!info?.isFile()) fail(`${what} has no SKILL.md`);
  const tree = await readTree(await realpath(dir));
  return { tree, hash: treeHash(tree), bytes: tree.reduce((n, e) => n + e.bytes.length, 0) };
}

const bounded = (raw: string | undefined, fallback: number, max: number, flag: string) => {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > max)
    fail(`${flag} must be a number above 0 and at most ${max}`);
  return value;
};

async function confirmOnTerminal(question: string) {
  const reader = ask(process.stdin, (t) => process.stderr.write(t));
  try {
    return /^y(es)?$/i.test(((await reader.ask(question)) ?? "").trim());
  } finally {
    reader.close();
  }
}

async function readAll(home: Home, days: number): Promise<Session[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  const refs = (await discoverAll(home, since)).filter((r) => r.harness === "claude-code");
  const sessions: Session[] = [];
  for await (const outcome of readSessions(refs)) if (outcome.ok) sessions.push(outcome.session);
  return sessions;
}

export async function skillsEval(
  home: Home,
  rest: string[],
  flags: EvalFlags,
  deps: EvalDeps = {},
): Promise<number> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  if (!evalSupported(platform)) {
    const message = `skills eval is unsupported on ${platform}: replays run only for Claude Code on Linux and macOS, where its scratch-home isolation was checked`;
    if (flags.json)
      process.stdout.write(`${JSON.stringify({ supported: false, platform, reason: message })}\n`);
    else process.stderr.write(`${message}\n`);
    return 2;
  }
  try {
    return await run(home, rest, flags, env, deps.confirm ?? confirmOnTerminal);
  } catch (error) {
    if (!(error instanceof EvalError)) throw error;
    process.stderr.write(`skills eval: ${error.message}\n`);
    return 1;
  }
}

async function run(
  home: Home,
  rest: string[],
  flags: EvalFlags,
  env: Record<string, string | undefined>,
  confirm: (question: string) => Promise<boolean>,
): Promise<number> {
  const [skill, ...extra] = rest;
  if (!skill || extra.length || !flags.candidate)
    fail("usage: quench skills eval <skill> --candidate <dir> [--limit 5] [--max-cost 1] [--yes]");
  if (!SkillName.safeParse(skill).success) fail("not a valid skill name");
  const limit = bounded(flags.limit, DEFAULT_PROMPTS, MAX_PROMPTS, "--limit");
  if (!Number.isInteger(limit)) fail("--limit must be a whole number");
  const maxCost = bounded(flags.maxCost, DEFAULT_MAX_COST, MAX_COST, "--max-cost");
  if (env[CHILD_ENV]) fail("already running inside a Quench replay");
  if (!CREDENTIAL_VARS.some((name) => env[name]))
    fail(
      `replays run in a scratch Claude home with no login; set ${CREDENTIAL_VARS.join(", ")} (claude setup-token prints a CLAUDE_CODE_OAUTH_TOKEN)`,
    );
  const command = Bun.which("claude", env.PATH === undefined ? {} : { PATH: env.PATH });
  if (!command) fail("claude was not found on PATH");

  const installed = join(await userSkillRoot(home, "claude-code"), skill!);
  const current = await skillTree(installed, `the installed ${skill}`);
  const candidate = await skillTree(flags.candidate!, "--candidate");
  const selection = selectPrompts(
    await readAll(home, flags.days),
    skill!,
    current.hash,
    await readLedger(stateDir(home)),
    limit,
  );
  if (!selection.prompts.length)
    fail(
      `no first prompts to replay: of ${selection.sessionsRead} Claude Code sessions in the last ${flags.days} days, ${selection.notCurrentVersion} ran without a ledger record of the installed version and ${selection.notTriggered} did not trigger ${skill} on their first prompt`,
    );
  const cost = estimate(selection.prompts, current.bytes, candidate.bytes);
  if (cost.usd !== null && cost.usd > maxCost)
    fail(
      `estimated cost $${cost.usd.toFixed(4)} is above --max-cost $${maxCost}; lower --limit or raise --max-cost`,
    );
  process.stderr.write(renderPreview(skill!, selection.prompts, cost, maxCost));
  if (!flags.yes && !(await confirm("Run these replays? [y/N] "))) {
    process.stderr.write("Not run.\n");
    return 1;
  }

  const rows: Row[] = selection.prompts.map((p) => ({ prompt: p, current: null, candidate: null }));
  let spent = 0;
  let priciest = 0;
  let stopped: string | null = null;
  run: for (const row of rows)
    for (const side of ["current", "candidate"] as const) {
      const version = side === "current" ? current : candidate;
      const next = Math.max(runCost(row.prompt, version.bytes) ?? 0, priciest);
      if (spent + next > maxCost) {
        stopped = SPEND_STOP;
        break run;
      }
      const result = await replay({
        command: command!,
        env,
        skill: skill!,
        tree: version.tree,
        prompt: row.prompt.text,
        model: row.prompt.model,
        budgetUsd: maxCost - spent,
      });
      row[side] = result;
      const paid = result.ok ? (result.costUsd ?? 0) : 0;
      spent += paid;
      priciest = Math.max(priciest, paid);
    }
  const summary = summarise(rows, stopped);
  const hashes = { current: current.hash, candidate: candidate.hash };
  process.stdout.write(
    flags.json
      ? `${JSON.stringify(
          {
            schemaVersion: 1,
            skill,
            harness: "claude-code",
            versions: hashes,
            selection: {
              sessionsRead: selection.sessionsRead,
              notCurrentVersion: selection.notCurrentVersion,
              notTriggered: selection.notTriggered,
              prompts: selection.prompts.length,
            },
            estimate: { tokens: cost.tokens, usd: cost.usd },
            maxCostUsd: maxCost,
            prompts: rows.map(rowJson),
            summary,
            warning: PROVIDER_WARNING,
          },
          null,
          2,
        )}\n`
      : renderResults(skill!, hashes, rows, summary),
  );
  return 0;
}
