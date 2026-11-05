import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { harnessById, type Home } from "@quench/history";
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
  readLedger,
  recover,
  resolved,
  samePath,
  withLock,
  type ApplyInput,
} from "@quench/fleet/apply";

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
  for (const path of [...paths].sort()) installed[path] = await inspect(absolute(home, path));
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

const USAGE = `usage: quench skills plan --source <dir> --machine <name> [--project <dir>] --json
       quench skills apply --source <dir> --machine <name> --plan <hash> [--project <dir>] [--json]
       quench skills status --source <dir> --machine <name> [--project <dir>] [--json]
`;

export type SkillsFlags = {
  source?: string;
  machine?: string;
  plan?: string;
  projects: string[];
  json: boolean;
};

const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

const lines = (rows: string[]) => {
  if (rows.length) process.stdout.write(`${rows.join("\n")}\n`);
};

export async function skills(home: Home, rest: string[], flags: SkillsFlags) {
  const [sub] = rest;
  if (!sub || !["plan", "apply", "status"].includes(sub) || rest.length !== 1) {
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
