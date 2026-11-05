import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  discoverAll,
  harnessById,
  harnesses,
  sessionPlaces,
  skillInventory,
  type Home,
  type SessionPlace,
  type Skill,
} from "@quench/history";
import { openT3History, t3State } from "@quench/history/hosts/t3";
import { Jev, judgeReplies, VerdictCache, type SessionRuns } from "@quench/judge";
import {
  HARNESSES,
  installations,
  normaliseRemote,
  own,
  owned,
  plan,
  targetPath,
  type HarnessId,
  type InstalledState,
  type Plan,
  type ProjectCheckout,
} from "@quench/fleet";
import { buildBundle, loadFleet } from "@quench/fleet/disk";
import {
  ACTIONABLE,
  applyPlan,
  inspect,
  pinKey,
  readJournal,
  rawState,
  readLedger,
  recover,
  resolved,
  samePath,
  withLock,
  type ApplyInput,
} from "@quench/fleet/apply";
import { placeCache } from "../cache.ts";
import { json } from "../format.ts";
import { reading } from "../progress.ts";
import { skillUse } from "../profile/recorded-skills.ts";
import { splitSkills } from "../profile/setup.ts";
import { coOccurrence } from "../skills/co-occurrence.ts";
import { drift, readSource, SourceError, type Source } from "../skills/drift.ts";
import { ORIGINS, SCHEMA_VERSION, skillRecords } from "../skills/records.ts";
import { renderSkills } from "../skills/render.ts";
import { sessionKey, type SessionContext } from "./context.ts";
import { sessionRuns } from "./session-runs.ts";
import { placeOrigins } from "./profile.ts";
import { skillsEval, type EvalFlags } from "./skills-eval.ts";

const UNREADABLE = {
  treeHash: `sha256:${"0".repeat(64)}`,
  symlink: false,
  executables: null,
};

export type SkillsOptions = { source: string; machine: string; projects?: string[] };

export const stateDir = (home: Home) => join(home.dir, ".quench", "fleet");

export async function userSkillRoot(home: Home, harness: HarnessId): Promise<string> {
  const roots = await harnessById[harness].skills(home, home.dir);
  const root = roots.find((r) => r.scope === "user" && r.layout !== "commands");
  if (!root) throw new Error(`${harness} has no user skill folder`);
  return root.path;
}

const PROJECT_ROOTS: Record<HarnessId, string> = {
  "claude-code": ".claude/skills",
  codex: ".codex/skills",
  pi: ".pi/skills",
};

const display = (home: Home, path: string) => {
  const slashed = path.replaceAll("\\", "/");
  const prefix = home.dir.replaceAll("\\", "/").replace(/\/+$/, "");
  return slashed === prefix
    ? "~"
    : slashed.startsWith(`${prefix}/`)
      ? `~${slashed.slice(prefix.length)}`
      : slashed;
};

const absolute = (home: Home, path: string) =>
  path.startsWith("~/") ? `${home.dir}/${path.slice(2)}` : path;

async function git(dir: string, ...args: string[]) {
  const proc = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`${dir}: git ${args.join(" ")} failed`);
  return out.trim();
}

async function project(home: Home, dir: string) {
  const top = await realpath(await git(dir, "rev-parse", "--show-toplevel"));
  const remote = normaliseRemote(await git(top, "remote", "get-url", "origin"));
  if (!remote) throw new Error(`${dir}: origin is not a remote Quench can match`);
  const exclude = resolve(top, await git(top, "rev-parse", "--git-path", "info/exclude"));
  const checkout = display(home, top);
  const roots = {} as Record<HarnessId, string>;
  for (const harness of HARNESSES) roots[harness] = `${checkout}/${PROJECT_ROOTS[harness]}`;
  return { remote, checkout, roots, exclude } satisfies ProjectCheckout & { exclude: string };
}

async function codexNotes(home: Home) {
  const file = join(home.of(harnessById.codex.home), "config.toml");
  const text = await Bun.file(file)
    .text()
    .catch(() => null);
  if (text === null) return [];
  const config = Bun.TOML.parse(text) as { skills?: { config?: unknown } };
  const entries = Array.isArray(config.skills?.config) ? config.skills.config : [];
  if (!entries.length) return [];
  return [
    `codex: ${entries.length} [[skills.config]] entries in ${display(home, file)}. Codex 0.166 finds skills by folder and ignores them; Quench installs folders and never edits config.toml, so remove them by hand when ready`,
  ];
}

export async function skillsContext(home: Home, options: SkillsOptions) {
  const { fleet, warnings } = await loadFleet(options.source);
  const built = await buildBundle(options.source, fleet, options.machine);
  const roots = {} as Record<HarnessId, string>;
  const linkedRoots: string[] = [];
  const pins: Record<string, string> = {};
  const shownPins: Record<string, string> = {};
  const pinned = async (base: string) => {
    const real = await resolved(base);
    if (samePath(real, base)) return;
    pins[pinKey(base)] = real;
    shownPins[display(home, base)] = real.replaceAll("\\", "/");
  };
  for (const harness of HARNESSES) {
    const root = await userSkillRoot(home, harness);
    roots[harness] = display(home, root);
    if ((await lstat(root).catch(() => null))?.isSymbolicLink()) linkedRoots.push(roots[harness]);
    await pinned(root);
  }
  const projects = [];
  for (const dir of options.projects ?? []) {
    const checkout = await project(home, dir);
    projects.push(checkout);
    const base = absolute(home, checkout.checkout);
    await pinned(base);
    for (const harness of HARNESSES) {
      let at = base;
      for (const part of PROJECT_ROOTS[harness].split("/")) {
        at = join(at, part);
        if ((await lstat(at).catch(() => null))?.isSymbolicLink()) {
          linkedRoots.push(checkout.roots[harness]);
          break;
        }
      }
    }
  }
  const state = stateDir(home);
  const ledger = await readLedger(state);
  const paths = new Set(owned(ledger).keys());
  for (const p of built.bundle.placements)
    if (p.scope.kind === "global") paths.add(targetPath(roots[p.harness], p.skill));
    else
      for (const c of projects)
        if (c.remote === p.scope.remote) paths.add(targetPath(c.roots[p.harness], p.skill));
  const installed: Record<string, InstalledState | undefined> = {};
  const mine = owned(ledger);
  for (const path of [...paths].sort())
    installed[path] = mine.has(path)
      ? await rawState(absolute(home, path)).catch(() => UNREADABLE)
      : await inspect(absolute(home, path));
  const sources: Record<string, string> = {};
  for (const name of Object.keys(built.bundle.skills))
    sources[name] = join(options.source, ...own(fleet.skills, name)!.path.split("/"));
  const interrupted = await readJournal(state);
  const result = plan({
    bundle: built.bundle,
    roots,
    installed,
    ledger,
    warnings: [
      ...warnings,
      ...built.warnings,
      ...(interrupted
        ? [
            `an apply was interrupted at ${display(home, interrupted.path)}; the next apply rolls it back first`,
          ]
        : []),
    ],
    projects,
    linkedRoots,
    pins: shownPins,
  });
  return {
    plan: result,
    apply: {
      plan: result,
      bundle: built.bundle,
      sources,
      state,
      absolute: (path: string) => absolute(home, path),
      installed,
      pins,
      projects,
    } satisfies ApplyInput,
    ledger,
    notes: await codexNotes(home),
  };
}

export const skillsPlan = async (home: Home, options: SkillsOptions) =>
  (await skillsContext(home, options)).plan;

export type ApplyOutcome = {
  plan: Plan;
  recovered: string | null;
  applied: { path: string; action: string }[];
  conflicts: { path: string | null; reason: string | null }[];
  notes: string[];
};

const conflictsOf = (p: Plan) =>
  p.items.filter((i) => i.action === "conflict").map((i) => ({ path: i.path, reason: i.reason }));

export async function skillsApply(
  home: Home,
  options: SkillsOptions & { planHash: string | null },
  hooks: Pick<ApplyInput, "interrupt" | "now"> = {},
): Promise<ApplyOutcome> {
  return withLock(stateDir(home), async () => {
    const recovered = await recover(stateDir(home));
    const context = await skillsContext(home, options);
    if (options.planHash !== null && context.plan.hash !== options.planHash)
      throw new Error(
        `${recovered ? `${recovered}; ` : ""}disk or source changed since plan ${options.planHash}; run skills plan again`,
      );
    const result = await applyPlan({ ...context.apply, ...hooks });
    return {
      plan: context.plan,
      recovered,
      applied: result.applied.map((i) => ({ path: i.path!, action: i.action })),
      conflicts: [...conflictsOf(context.plan), ...result.conflicts],
      notes: context.notes,
    };
  });
}

type Options = {
  source?: string;
  machine?: string;
  json: boolean;
  days: number;
  cache: boolean;
  hostHistory?: string | false;
};

const LIMITATIONS = [
  "One record per skill, agent and location. Skills on disk come from each agent's user and system folders now; project skills appear when a session in the period listed them. Listed, used and by you count sessions in the period, by the same rules as profile's recorded skills.",
  "Origin: plugin from an installed plugin; project from a project folder; vendored for skills the agent ships, system folders, and folders that resolve outside your home; user for any other folder in your home. A skill found nowhere on disk now has an unknown origin.",
  "Content version is the fleet tree hash of the whole skill folder on disk now; unknown when it is not a readable SKILL.md folder.",
  "Missing evidence is unknown, never zero: an agent with no recorded listing in the period has unknown counts. Codex loads skills through the shell, so its use counts are a lower bound.",
  `Loaded and corrected is session co-occurrence from corrections --context: a session loaded a skill when it invoked a listed skill, read its SKILL.md, or ran a shell read of it. A session had a human correction when a cached verdict says a person corrected a run in the period. Sessions with unjudged replies and sessions with no human follow-up are counted apart and never as no correction. Shown at 5 or more sessions with a judged human follow-up; co-occurrence, not cause.`,
];

export async function skillsStatus(home: Home, options: SkillsOptions) {
  const context = await skillsContext(home, options);
  const drift = context.plan.items
    .filter((i) => (ACTIONABLE as readonly string[]).includes(i.action))
    .map((i) => ({ path: i.path, action: i.action }));
  const journal = await readJournal(stateDir(home));
  return {
    hash: context.plan.hash,
    counts: context.plan.counts,
    conflicts: conflictsOf(context.plan),
    drift,
    interrupted: journal ? `${journal.kind} of ${journal.path}` : null,
    notes: context.notes,
    installations: installations(context.ledger),
  };
}

const USAGE = `usage: quench skills [--json] [--days N] [--source <dir>]
       quench skills plan --source <dir> --machine <name> [--project <dir>] --json
       quench skills apply --source <dir> --machine <name> --plan <hash> [--project <dir>] [--json]
       quench skills status --source <dir> --machine <name> [--project <dir>] [--json]
       quench skills eval <skill> --candidate <dir> [--limit 5] [--max-cost 1] [--yes] [--json]
`;

export type SkillsFlags = {
  source?: string;
  machine?: string;
  plan?: string;
  projects: string[];
  json: boolean;
  days: number;
  cache: boolean;
  hostHistory?: string | false;
  eval?: Omit<EvalFlags, "json" | "days">;
};

const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

const lines = (rows: string[]) => {
  if (rows.length) process.stdout.write(`${rows.join("\n")}\n`);
};

export async function skills(home: Home, rest: string[], flags: SkillsFlags) {
  const [sub] = rest;
  if (sub === undefined) return skillsReport(home, flags);
  if (sub === "eval")
    return skillsEval(home, rest.slice(1), {
      yes: false,
      ...flags.eval,
      json: flags.json,
      days: flags.days,
    });
  if (!["plan", "apply", "status"].includes(sub) || rest.length !== 1) {
    process.stderr.write(USAGE);
    return 1;
  }
  if (!flags.source || !flags.machine) {
    process.stderr.write(`skills ${sub} needs --source <dir> and --machine <name>\n`);
    return 1;
  }
  if (sub === "plan" && !flags.json) {
    process.stderr.write("skills plan needs --json\n");
    return 1;
  }
  if (sub === "apply" && !flags.plan) {
    process.stderr.write("skills apply needs --plan <hash> from skills plan\n");
    return 1;
  }
  if (sub !== "apply" && flags.plan) {
    process.stderr.write("--plan is only available for skills apply\n");
    return 1;
  }
  const options = { source: flags.source, machine: flags.machine, projects: flags.projects };
  try {
    if (sub === "plan") {
      write(await skillsPlan(home, options));
      return 0;
    }
    if (sub === "apply") {
      const outcome = await skillsApply(home, { ...options, planHash: flags.plan! });
      if (flags.json) write(outcome);
      else
        lines([
          ...(outcome.recovered ? [outcome.recovered] : []),
          ...outcome.applied.map((a) => `${a.action} ${a.path}`),
          ...outcome.conflicts.map((c) => `conflict ${c.path}: ${c.reason}`),
          ...outcome.notes.map((n) => `note ${n}`),
          `applied ${outcome.applied.length}, conflicts ${outcome.conflicts.length}`,
        ]);
      return outcome.conflicts.length ? 1 : 0;
    }
    const status = await skillsStatus(home, options);
    if (flags.json) write(status);
    else
      lines([
        ...status.conflicts.map((c) => `conflict ${c.path}: ${c.reason}`),
        ...status.drift.map((d) => `drift ${d.path}: needs ${d.action}`),
        ...(status.interrupted ? [`interrupted ${status.interrupted}; apply recovers it`] : []),
        ...status.notes.map((n) => `note ${n}`),
        `installed ${status.installations.filter((i) => i.to === null).length}, conflicts ${status.conflicts.length}, drift ${status.drift.length}`,
      ]);
    return status.conflicts.length || status.drift.length || status.interrupted ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}

async function skillsReport(home: Home, options: Options) {
  if (options.machine) {
    process.stderr.write("--machine is only available for skills plan\n");
    return 1;
  }
  let source: Source | null = null;
  try {
    source = options.source ? await readSource(options.source) : null;
  } catch (error) {
    const kind = error instanceof SourceError ? error.message : "source could not be read";
    process.stderr.write(`--source: ${kind}\n`);
    return 1;
  }
  const since = new Date(Date.now() - options.days * 86_400_000);
  const cache = options.cache ? await placeCache(home.dir) : undefined;
  const { places } = await sessionPlaces(home, since, reading(), cache);
  await cache?.save();
  const global = new Map<string, Skill>();
  for (const skill of splitSkills((await skillInventory(home, home.dir)).skills).global)
    global.set(skill.realPath, skill);
  const recorded = skillUse(places, await placeOrigins(home, places, global));
  const verdicts = await VerdictCache.open(join(home.dir, ".quench/local"), Jev.id, true);
  const host =
    options.hostHistory === false ? null : openT3History(options.hostHistory ?? t3State(home));
  const contexts = new Map<string, SessionContext>();
  let sessions: SessionRuns[];
  try {
    sessions = await sessionRuns(await discoverAll(home, since), home.dir, host?.enrich, contexts);
  } finally {
    host?.close();
  }
  const { replies } = await judgeReplies(sessions, verdicts, null);
  const { records, unrecognised } = await skillRecords(home, {
    onDisk: [...global.values()],
    occurrences: recorded.occurrences,
    sessionKeys: places.map((p) => sessionKey({ harness: p.harness, sessionId: p.session })),
    recordedHarnesses: new Set(recorded.uses.map((u) => u.harness)),
    roots: await skillRoots(home, places),
    sourceNames: new Set(source?.skills.keys()),
    coOccurrence: coOccurrence(replies, contexts, since),
  });
  const compared = source && drift(source, records);
  process.stdout.write(
    options.json
      ? json({
          schemaVersion: SCHEMA_VERSION,
          days: options.days,
          judge: verdicts.judge,
          origins: ORIGINS,
          skills: records,
          unrecognised,
          ...(compared ? { source: compared } : {}),
          limitations: LIMITATIONS,
        })
      : renderSkills(records, unrecognised, options.days, verdicts.judge, compared),
  );
  return 0;
}

async function skillRoots(home: Home, places: readonly SessionPlace[]): Promise<string[]> {
  const dirs = [home.dir, ...new Set(places.flatMap((p) => (p.cwd ? [p.cwd] : [])))];
  const roots = new Set(harnesses.map((h) => home.of(h.home)));
  for (const dir of dirs)
    for (const harness of harnesses)
      for (const root of await harness.skills(home, dir).catch(() => [])) roots.add(root.path);
  return [...roots];
}
