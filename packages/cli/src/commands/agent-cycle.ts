import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { HARNESSES, owned, Snapshot, SkillReport, type Plan } from "@quench/fleet";
import { readLedger, type ApplyInput } from "@quench/fleet/apply";
import type { Home } from "@quench/history";
import { SCHEMA_VERSION } from "../skills/records.ts";
import { withVersions } from "../skills/versions.ts";
import {
  absolute,
  collectSkills,
  skillsApply,
  skillsPlan,
  stateDir,
  type SkillsOptions,
} from "./skills.ts";

export const SKILL_DAYS = 30;

export const statusFile = (home: Home) => join(stateDir(home), "status.json");

export async function readStatus(home: Home): Promise<Record<string, unknown> | null> {
  const text = await readFile(statusFile(home), "utf8").catch(() => null);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function previousGeneration(home: Home) {
  const parsed = Snapshot.safeParse((await readStatus(home))?.snapshot);
  return parsed.success ? parsed.data.generation : 0;
}

async function skillReport(
  home: Home,
  ledger: Awaited<ReturnType<typeof readLedger>>,
): Promise<SkillReport> {
  const { judge, records, unrecognised, evidence } = await collectSkills(home, {
    days: SKILL_DAYS,
    cache: true,
  });
  return SkillReport.parse({
    schemaVersion: SCHEMA_VERSION,
    days: SKILL_DAYS,
    judge,
    records: withVersions(records, ledger, evidence, (path) => absolute(home, path)),
    unrecognised,
  });
}

type Reported = { revision: string | null; staleSince?: string };

function snapshotOf(
  plan: Plan | null,
  ledger: Awaited<ReturnType<typeof readLedger>>,
  generation: number,
  skills: SkillReport | null,
  reported: Reported,
): Snapshot {
  const mine = owned(ledger);
  const harnesses: Snapshot["harnesses"] = {};
  for (const harness of HARNESSES) {
    const items = plan?.items.filter((i) => i.harness === harness) ?? [];
    harnesses[harness] = {
      complete: plan !== null,
      conflicts: items.filter((i) => i.action === "conflict").length,
      installs: items.flatMap((i) => {
        if (!i.path || !i.installed) return [];
        const ours = mine.get(i.path);
        return [
          {
            skill: i.skill,
            path: i.path,
            location:
              i.location.scope === "project"
                ? {
                    scope: "project" as const,
                    remote: i.location.remote,
                    checkout: i.location.checkout ?? "",
                  }
                : { scope: "global" as const },
            treeHash: i.installed.treeHash,
            state: !ours
              ? "foreign"
              : ours.treeHash === i.installed.treeHash
                ? "owned"
                : "modified",
          },
        ];
      }),
    };
  }
  return Snapshot.parse({
    version: 1,
    id: crypto.randomUUID(),
    generation,
    takenAt: new Date().toISOString(),
    revision: reported.revision,
    harnesses,
    ...(skills ? { skills } : {}),
    ...(reported.staleSince ? { staleSince: reported.staleSince } : {}),
  });
}

export async function applyAndReport(
  home: Home,
  options: SkillsOptions | null,
  reported: Reported,
  hooks: Pick<ApplyInput, "now"> = {},
) {
  const generation = (await previousGeneration(home)) + 1;
  let report;
  try {
    if (!options) throw new Error("no bundle to apply yet");
    const outcome = await skillsApply(home, { ...options, planHash: null }, hooks);
    report = {
      error: null,
      recovered: outcome.recovered,
      planHash: outcome.plan.hash ?? null,
      applied: outcome.applied,
      conflicts: outcome.conflicts,
      notes: outcome.notes,
      plan: await skillsPlan(home, options),
    };
  } catch (error) {
    report = {
      error: (error as Error).message,
      recovered: null,
      planHash: null,
      applied: [],
      conflicts: [],
      notes: [],
      plan: null,
    };
  }
  const { plan, ...rest } = report;
  const ledger = await readLedger(stateDir(home));
  let skills: SkillReport | null = null;
  let skillsError: string | null = null;
  try {
    skills = await skillReport(home, ledger);
  } catch (error) {
    skillsError = (error as Error).message;
  }
  return { ...rest, skillsError, snapshot: snapshotOf(plan, ledger, generation, skills, reported) };
}

export async function writeStatus<T>(home: Home, status: T) {
  const file = statusFile(home);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify(status, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
  return status;
}

export async function agentCycle(
  home: Home,
  options: SkillsOptions & { source: string },
  hooks: Pick<ApplyInput, "now"> = {},
) {
  return writeStatus(home, {
    version: 1,
    source: resolve(options.source),
    machine: options.machine,
    ...(await applyAndReport(home, options, { revision: null }, hooks)),
  });
}
