import { z } from "zod";
import { HarnessId, Location, SkillName, Timestamp, TreeHash } from "./common.ts";
import { SkillReport } from "./skill-report.ts";

export const SnapshotInstall = z
  .object({
    skill: SkillName,
    path: z.string().min(1),
    location: Location,
    treeHash: TreeHash,
    state: z.enum(["owned", "modified", "foreign"]),
  })
  .strict();

export const HarnessSnapshot = z
  .object({
    complete: z.boolean(),
    installs: z.array(SnapshotInstall),
    conflicts: z.number().int().nonnegative(),
  })
  .strict();

export const Snapshot = z
  .object({
    version: z.literal(1),
    id: z.uuid(),
    generation: z.number().int().nonnegative(),
    takenAt: Timestamp,
    revision: z.string().nullable(),
    harnesses: z.partialRecord(HarnessId, HarnessSnapshot),
    skills: SkillReport.optional(),
    staleSince: Timestamp.optional(),
  })
  .strict();
export type Snapshot = z.infer<typeof Snapshot>;

export const HarnessState = z
  .object({
    snapshot: HarnessSnapshot,
    generation: z.number().int().nonnegative(),
    stale: z.boolean(),
  })
  .strict();

export const MachineState = z
  .object({
    generation: z.number().int().nonnegative(),
    harnesses: z.partialRecord(HarnessId, HarnessState),
    skills: SkillReport.optional(),
    skillsTakenAt: Timestamp.optional(),
    staleness: z.object({ since: Timestamp, until: Timestamp }).strict().optional(),
  })
  .strict();
export type MachineState = z.infer<typeof MachineState>;

export function mergeSnapshot(previous: MachineState | null, next: Snapshot): MachineState {
  if (previous && next.generation <= previous.generation) return previous;
  const harnesses: MachineState["harnesses"] = {};
  for (const harness of HarnessId.options) {
    const fresh = next.harnesses[harness];
    const kept = previous?.harnesses[harness];
    if (fresh?.complete)
      harnesses[harness] = { snapshot: fresh, generation: next.generation, stale: false };
    else if (kept) harnesses[harness] = { ...kept, stale: true };
  }
  const skills = next.skills
    ? { skills: next.skills, skillsTakenAt: next.takenAt }
    : previous?.skills
      ? { skills: previous.skills, skillsTakenAt: previous.skillsTakenAt }
      : {};
  const stale = next.staleSince
    ? { staleness: { since: next.staleSince, until: next.takenAt } }
    : {};
  return { generation: next.generation, harnesses, ...skills, ...stale };
}
