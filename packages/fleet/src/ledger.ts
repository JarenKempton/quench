import { z } from "zod";
import { HarnessId, Location, SkillName, Timestamp, TreeHash } from "./common.ts";

export const LedgerEntry = z
  .object({
    path: z.string().min(1),
    skill: SkillName,
    treeHash: TreeHash,
    executables: z.array(z.string()),
    harness: HarnessId,
    location: Location,
    kind: z.enum(["install", "update", "remove"]),
    appliedAt: Timestamp,
    gitExclude: z.string().nullable(),
  })
  .strict();
export type LedgerEntry = z.infer<typeof LedgerEntry>;

export const Installation = z
  .object({
    path: z.string().min(1),
    skill: SkillName,
    treeHash: TreeHash,
    executables: z.array(z.string()),
    harness: HarnessId,
    location: Location,
    from: Timestamp,
    to: Timestamp.nullable(),
  })
  .strict();
export type Installation = z.infer<typeof Installation>;

export const Provenance = z.enum(["ledger-exact", "snapshot-bracketed", "commit-time-approximate"]);
export type Provenance = z.infer<typeof Provenance>;

const byTime = (entries: LedgerEntry[]) =>
  [...entries].sort((a, b) => Date.parse(a.appliedAt) - Date.parse(b.appliedAt));

export function installations(entries: LedgerEntry[]): Installation[] {
  const done: Installation[] = [];
  const open = new Map<string, Installation>();
  for (const { kind, appliedAt, gitExclude: _, ...rest } of byTime(entries)) {
    const current = open.get(rest.path);
    if (current) done.push({ ...current, to: appliedAt });
    open.delete(rest.path);
    if (kind !== "remove") open.set(rest.path, { ...rest, from: appliedAt, to: null });
  }
  return [...done, ...open.values()];
}

export function owned(entries: LedgerEntry[]): Map<string, LedgerEntry> {
  const last = new Map<string, LedgerEntry>();
  for (const entry of byTime(entries)) last.set(entry.path, entry);
  return new Map([...last].filter(([, entry]) => entry.kind !== "remove"));
}
