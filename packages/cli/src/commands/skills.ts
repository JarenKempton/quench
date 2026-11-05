import { join } from "node:path";
import {
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
import { HARNESSES, plan, targetPath, type HarnessId, type InstalledState } from "@quench/fleet";
import { buildBundle, installedTree, loadFleet } from "@quench/fleet/disk";
import { placeCache } from "../cache.ts";
import { json } from "../format.ts";
import { reading } from "../progress.ts";
import { skillUse } from "../profile/recorded-skills.ts";
import { splitSkills } from "../profile/setup.ts";
import { coOccurrence } from "../skills/co-occurrence.ts";
import { drift } from "../skills/drift.ts";
import { ORIGINS, SCHEMA_VERSION, skillRecords } from "../skills/records.ts";
import { renderSkills } from "../skills/render.ts";
import { sessionKey, type SessionContext } from "./context.ts";
import { sessionRuns } from "./corrections.ts";
import { placeOrigins } from "./profile.ts";

export async function userSkillRoot(home: Home, harness: HarnessId): Promise<string> {
  const roots = await harnessById[harness].skills(home, home.dir);
  const root = roots.find((r) => r.scope === "user" && r.layout !== "commands");
  if (!root) throw new Error(`${harness} has no user skill folder`);
  return root.path;
}

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

export async function skillsPlan(home: Home, options: { source: string; machine: string }) {
  const { fleet, warnings } = await loadFleet(options.source);
  const built = await buildBundle(options.source, fleet, options.machine);
  const roots = {} as Record<HarnessId, string>;
  for (const harness of HARNESSES)
    roots[harness] = display(home, await userSkillRoot(home, harness));
  const installed: Record<string, InstalledState | undefined> = {};
  for (const p of built.bundle.placements) {
    if (p.scope.kind !== "global") continue;
    const path = targetPath(roots[p.harness], p.skill);
    installed[path] = await installedTree(absolute(home, path));
  }
  return plan({
    bundle: built.bundle,
    roots,
    installed,
    ledger: [],
    warnings: [...warnings, ...built.warnings],
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

export async function skills(home: Home, rest: string[], options: Options) {
  const [sub] = rest;
  if (sub === undefined) return skillsReport(home, options);
  if (sub !== "plan" || rest.length !== 1) {
    process.stderr.write(
      "usage: quench skills [--json] [--days N] [--source <dir>]\n       quench skills plan --source <dir> --machine <name> --json\n",
    );
    return 1;
  }
  if (!options.source || !options.machine || !options.json) {
    process.stderr.write("skills plan needs --source <dir>, --machine <name> and --json\n");
    return 1;
  }
  try {
    const result = await skillsPlan(home, { source: options.source, machine: options.machine });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
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
    sessions = await sessionRuns(home, since, host?.enrich, contexts);
  } finally {
    host?.close();
  }
  const { replies } = await judgeReplies(sessions, verdicts, null);
  const records = await skillRecords(home, {
    onDisk: [...global.values()],
    occurrences: recorded.occurrences,
    sessionKeys: places.map((p) => sessionKey({ harness: p.harness, sessionId: p.session })),
    recordedHarnesses: new Set(recorded.uses.map((u) => u.harness)),
    roots: await skillRoots(home, places),
    coOccurrence: coOccurrence(replies, contexts, since),
  });
  let compared = null;
  try {
    compared = options.source ? await drift(options.source, records) : null;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
  process.stdout.write(
    options.json
      ? json({
          schemaVersion: SCHEMA_VERSION,
          days: options.days,
          judge: verdicts.judge,
          origins: ORIGINS,
          skills: records,
          ...(compared ? { source: compared } : {}),
          limitations: LIMITATIONS,
        })
      : renderSkills(records, options.days, verdicts.judge, compared),
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
