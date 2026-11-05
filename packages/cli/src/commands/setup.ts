import { harnesses, type Home } from "@quench/history";
import {
  CANNED_EXCHANGE,
  endpointProblem,
  JudgeName,
  keyProblem,
  provider,
  type JudgeChoice,
  type Judgment,
} from "@quench/judge";
import { judgeChoice, readConfig, writeConfig, type Config } from "../config.ts";
import { plural, shortPath } from "../format.ts";
import { prompt } from "../prompt.ts";
import { profile } from "./profile.ts";

export const STEPS = ["agents", "summary", "judge", "hub", "ui"] as const;
type Step = (typeof STEPS)[number];
type Outcome = "done" | "skipped" | "stopped";
type Env = Record<string, string | undefined>;

export type SetupOptions = {
  judge?: string;
  yes: boolean;
  env?: Env;
  platform?: NodeJS.Platform;
};

type Context = {
  home: Home;
  yes: boolean;
  env: Env;
  platform: NodeJS.Platform;
  judge: string | undefined;
  ask: (question: string, hidden?: boolean) => Promise<string | null>;
  config: Config;
};

const TITLES: Record<Step, string> = {
  agents: "Your agents",
  summary: "What your sessions start with",
  judge: "Pick a judge",
  hub: "Pair with a hub",
  ui: "Open quench ui",
};

const RUN: Record<Step, (c: Context) => Promise<Outcome>> = {
  agents,
  summary,
  judge: pickJudge,
  hub,
  ui,
};

export async function setup(
  home: Home,
  from: string | undefined,
  options: SetupOptions,
): Promise<number> {
  if (from !== undefined && !STEPS.includes(from as Step)) {
    process.stderr.write(`unknown setup step "${from}"; use one of: ${STEPS.join(", ")}\n`);
    return 1;
  }
  if (options.judge !== undefined && !JudgeName.safeParse(options.judge).success) {
    process.stderr.write("--judge must be jev, claude, openai or none\n");
    return 1;
  }
  const config = await readConfig(home.dir);
  const done = new Set(config.setup?.done ?? []);
  const resume = STEPS.findIndex((s) => !done.has(s));
  const start = from ? STEPS.indexOf(from as Step) : Math.max(resume, 0);
  const reader = prompt();
  const context: Context = {
    home,
    yes: options.yes,
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
    judge: options.judge,
    ask: reader.ask,
    config,
  };
  try {
    return await steps(context, start, done);
  } finally {
    reader.close();
  }
}

async function steps(context: Context, start: number, done: Set<string>): Promise<number> {
  const { home } = context;
  for (const [i, step] of STEPS.entries()) {
    if (i < start) continue;
    out(`\nStep ${i + 1}/${STEPS.length} · ${TITLES[step]}\n`);
    const outcome = await RUN[step](context);
    if (outcome === "stopped") {
      out(`\nSetup stopped at ${step}. Run quench setup to resume there.\n`);
      return 1;
    }
    if (outcome === "done") done.add(step);
    else done.delete(step);
    context.config = { ...context.config, setup: { done: STEPS.filter((s) => done.has(s)) } };
    await writeConfig(home.dir, context.config);
  }
  const left = STEPS.filter((s) => !done.has(s));
  out(
    left.length
      ? `\nSetup finished; skipped: ${left.join(", ")}. Run quench setup to come back to them.\n`
      : "\nSetup finished.\n",
  );
  return 0;
}

async function agents({ home }: Context): Promise<Outcome> {
  let found = 0;
  for (const harness of harnesses) {
    const dir = shortPath(home.of(harness.home), home.dir);
    const refs = await harness.discover(home).catch(() => []);
    const sessions = refs.filter((r) => !r.parent);
    const dates = refs.flatMap((r) => (r.modified ? [r.modified.getTime()] : []));
    if (!sessions.length) {
      out(`  ${harness.label.padEnd(12)} no sessions in ${dir}\n`);
      continue;
    }
    found++;
    const days = Math.max(1, Math.ceil((Date.now() - Math.min(...dates)) / 86_400_000));
    out(
      `  ${harness.label.padEnd(12)} ${plural(sessions.length, "session")} over ${plural(days, "day")}, in ${dir}\n`,
    );
  }
  if (!found)
    out(
      "  No agent history found. If yours lives elsewhere, set CLAUDE_CONFIG_DIR, CODEX_HOME or PI_CODING_AGENT_DIR.\n",
    );
  return "done";
}

async function summary({ home }: Context): Promise<Outcome> {
  await profile(home, { days: 30, scan: [], json: false, view: "summary", cache: true });
  return "done";
}

async function pickJudge(context: Context): Promise<Outcome> {
  const { env, platform } = context;
  const names = JudgeName.options.filter((n) => n !== "claude" || platform !== "win32");
  const recommended = context.judge ?? recommend(env, platform);
  out(
    [
      "  A judge classifies each reply to an agent run, for quench corrections. Everything else works without one.",
      "  jev     Jev (typesafe.ai) with your TYPESAFE_API_KEY",
      ...(names.includes("claude") ? ["  claude  claude -p, signed in as you"] : []),
      "  openai  any OpenAI-compatible endpoint: base URL, model and optional key",
      "  none    no model calls",
      "",
    ].join("\n"),
  );
  for (;;) {
    const answer = context.yes
      ? recommended
      : await context.ask(`  Judge [${recommended}] (or skip): `);
    if (answer === null) return "stopped";
    const name = answer.trim() || recommended;
    if (context.yes) out(`  Judge: ${name}\n`);
    if (name === "skip") return "skipped";
    if (!names.includes(name as JudgeName)) {
      out(`  Pick one of ${names.join(", ")}, or skip.\n`);
      if (context.yes) return "stopped";
      continue;
    }
    const stored = await details(context, name as JudgeName);
    if (stored === null) return "stopped";
    if (stored instanceof Error) {
      out(`  ${stored.message}\n`);
      if (context.yes) return "stopped";
      continue;
    }
    const choice = judgeChoice({ judge: stored }, env, stored.name);
    if (choice instanceof Error) {
      out(`  ${choice.message}\n`);
      if (context.yes) return "stopped";
      continue;
    }
    const tested = await trial(choice, env, platform);
    if (tested instanceof Error) {
      out(`  Test failed: ${tested.message}\n`);
      if (context.yes) return "stopped";
      continue;
    }
    out(`  ${tested}\n`);
    context.config = { ...context.config, judge: stored };
    const path = await writeConfig(context.home.dir, context.config);
    out(
      `  Saved to ${shortPath(path, context.home.dir)}, ${platform === "win32" ? "protected only by your user profile folder's permissions" : "readable only by you"}. QUENCH_JUDGE and the key variables override it.\n`,
    );
    return "done";
  }
}

async function details(
  context: Context,
  name: JudgeName,
): Promise<NonNullable<Config["judge"]> | Error | null> {
  const { env } = context;
  const previous = context.config.judge?.name === name ? context.config.judge : undefined;
  const field = async (variable: string, label: string, hint: string, hidden = false) => {
    const known = env[variable]?.trim() || undefined;
    if (known || context.yes) return { value: known, typed: false };
    const value = await context.ask(`  ${label}${hint ? ` [${hint}]` : ""}: `, hidden);
    return value === null ? null : { value: value.trim() || undefined, typed: true };
  };
  if (name === "jev") {
    const hint = previous?.apiKey ? "keep saved key" : "";
    const key = await field("TYPESAFE_API_KEY", "TypeSafe API key", hint, true);
    if (key === null) return null;
    const fromEnv = Boolean(env.TYPESAFE_API_KEY?.trim());
    const apiKey = key.typed || !fromEnv ? (key.value ?? previous?.apiKey) : undefined;
    if (!apiKey && !fromEnv)
      return new Error("Jev needs a TypeSafe API key: set TYPESAFE_API_KEY or type it.");
    const problem = apiKey ? keyProblem(apiKey) : null;
    if (problem) return new Error(`Jev: ${problem}.`);
    return { name, ...(apiKey ? { apiKey } : {}) };
  }
  if (name === "openai") {
    const base = await field("QUENCH_OPENAI_BASE_URL", "Base URL", previous?.baseUrl ?? "");
    if (base === null) return null;
    const baseUrl = base.value ?? previous?.baseUrl;
    const model = await field("QUENCH_OPENAI_MODEL", "Model", previous?.model ?? "");
    if (model === null) return null;
    const modelName = model.value ?? previous?.model;
    const key = await field(
      "QUENCH_OPENAI_API_KEY",
      "API key",
      previous?.apiKey ? "keep saved key" : "none",
      true,
    );
    if (key === null) return null;
    const fromEnv = Boolean(env.QUENCH_OPENAI_API_KEY?.trim());
    const apiKey = key.typed || !fromEnv ? (key.value ?? previous?.apiKey) : undefined;
    if (!baseUrl || !modelName)
      return new Error(
        "openai needs a base URL and model: type them, or set QUENCH_OPENAI_BASE_URL and QUENCH_OPENAI_MODEL.",
      );
    const problem = endpointProblem(baseUrl) ?? (apiKey ? keyProblem(apiKey) : null);
    if (problem) return new Error(`openai: ${problem}.`);
    return {
      name,
      ...(base.typed || !env.QUENCH_OPENAI_BASE_URL?.trim() ? { baseUrl } : {}),
      ...(model.typed || !env.QUENCH_OPENAI_MODEL?.trim() ? { model: modelName } : {}),
      ...(apiKey ? { apiKey } : {}),
    };
  }
  return { name };
}

async function trial(
  choice: JudgeChoice,
  env: Env,
  platform: NodeJS.Platform,
): Promise<string | Error> {
  const chosen = provider(choice, env, platform);
  if (chosen.id === null) return "No judge: quench corrections stays off; nothing else changes.";
  let judgment: Judgment | undefined;
  try {
    const judge = await chosen.create();
    if (!judge) return new Error(`${chosen.label} is not configured.`);
    out(`  Testing ${chosen.id} with one made-up exchange; no history is sent…\n`);
    [judgment] = await judge.classify([CANNED_EXCHANGE]);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  if (!judgment) return new Error("no answer");
  if (judgment instanceof Error) return judgment;
  return `Test passed: ${chosen.id} answered "${judgment.kind}" for a made-up correction.`;
}

async function hub(): Promise<Outcome> {
  out(
    "  Not available yet: hub pairing arrives with quench connect. Run quench setup hub once it ships.\n",
  );
  return "skipped";
}

async function ui(): Promise<Outcome> {
  out(
    [
      "  Not available yet: quench ui is still being built. Your first screen is the summary above:",
      "  quench                any time, for that summary",
      "  quench profile        every table",
      "  quench corrections    correction rates, with the judge you picked",
      "",
    ].join("\n"),
  );
  return "skipped";
}

function recommend(env: Env, platform: NodeJS.Platform): JudgeName {
  if (env.TYPESAFE_API_KEY?.trim()) return "jev";
  if (platform !== "win32" && Bun.which("claude", env.PATH === undefined ? {} : { PATH: env.PATH }))
    return "claude";
  return "none";
}

const out = (text: string) => process.stdout.write(text);
