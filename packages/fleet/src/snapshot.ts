import { z } from "zod";
import { HarnessId, Location, SkillName, Timestamp, TreeHash } from "./common.ts";

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
  })
  .strict();
export type Snapshot = z.infer<typeof Snapshot>;

export const replaces = (next: Snapshot, previous: Snapshot | null) =>
  (previous === null || next.generation > previous.generation) &&
  Object.values(next.harnesses).every((h) => h.complete);
