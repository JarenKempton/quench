import { z } from "zod";
import { foldKey, own, HarnessId, MachineName, Remote, SkillName, TreeHash } from "./common.ts";
import type { BundleManifest } from "./bundle.ts";
import { cmp } from "./fleet.ts";
import { owned, type LedgerEntry } from "./ledger.ts";

export const PlanLocation = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("global") }).strict(),
  z
    .object({ scope: z.literal("project"), remote: Remote, checkout: z.string().nullable() })
    .strict(),
]);

export const Installed = z.object({ treeHash: TreeHash, symlink: z.boolean() }).strict();
export type Installed = z.infer<typeof Installed>;
export type InstalledState = Installed & { executables: string[] | null };

const sameState = (now: InstalledState, treeHash: string, executables: string[]) =>
  now.treeHash === treeHash &&
  (now.executables === null || now.executables.join("\0") === executables.join("\0"));

const shown = (now: InstalledState | null): Installed | null =>
  now && { treeHash: now.treeHash, symlink: now.symlink };

export const PlanAction = z.enum([
  "install",
  "update",
  "unchanged",
  "remove",
  "conflict",
  "unresolved",
  "unavailable",
]);
export type PlanAction = z.infer<typeof PlanAction>;

export const PlanItem = z
  .object({
    skill: SkillName,
    harness: HarnessId,
    location: PlanLocation,
    path: z.string().nullable(),
    desired: TreeHash.nullable(),
    installed: Installed.nullable(),
    action: PlanAction,
    reason: z.string().nullable(),
  })
  .strict();
export type PlanItem = z.infer<typeof PlanItem>;

export const Plan = z
  .object({
    version: z.literal(1),
    machine: MachineName,
    items: z.array(PlanItem),
    counts: z.record(PlanAction, z.number().int().nonnegative()),
    warnings: z.array(z.string()),
  })
  .strict();
export type Plan = z.infer<typeof Plan>;

export type PlanInput = {
  bundle: BundleManifest;
  roots: Record<HarnessId, string>;
  installed: Record<string, InstalledState | undefined>;
  ledger: LedgerEntry[];
  warnings: string[];
};

const where = (item: PlanItem) =>
  item.location.scope === "project" ? `\0${item.location.remote}` : (item.path ?? "");

export const executablesOf = (bundle: BundleManifest, skill: string) =>
  (own(bundle.skills, skill)?.files ?? [])
    .filter((f) => f.mode === "100755")
    .map((f) => f.path)
    .sort();

export const targetPath = (root: string, skill: string) => `${root}/${skill}`;

export function plan({ bundle, roots, installed, ledger, warnings }: PlanInput): Plan {
  const mine = owned(ledger);
  const items: PlanItem[] = [];
  const wanted = new Set<string>();
  for (const p of bundle.placements) {
    if (p.scope.kind === "project") {
      items.push({
        skill: p.skill,
        harness: p.harness,
        location: { scope: "project", remote: p.scope.remote, checkout: null },
        path: null,
        desired: p.treeHash,
        installed: null,
        action: "unresolved",
        reason: "project checkouts are not resolved yet",
      });
      continue;
    }
    const path = targetPath(roots[p.harness], p.skill);
    wanted.add(path);
    const now = own(installed, path) ?? null;
    const ours = mine.get(path);
    const action: PlanAction = !now
      ? "install"
      : sameState(now, p.treeHash, executablesOf(bundle, p.skill))
        ? "unchanged"
        : ours && sameState(now, ours.treeHash, ours.executables)
          ? "update"
          : "conflict";
    items.push({
      skill: p.skill,
      harness: p.harness,
      location: { scope: "global" },
      path,
      desired: p.treeHash,
      installed: shown(now),
      action,
      reason: action === "conflict" ? "installed folder differs and Quench did not write it" : null,
    });
  }
  for (const u of bundle.unavailable) {
    const path = u.scope.kind === "global" ? targetPath(roots[u.harness], u.skill) : null;
    if (path) wanted.add(path);
    items.push({
      skill: u.skill,
      harness: u.harness,
      location:
        u.scope.kind === "global"
          ? { scope: "global" }
          : { scope: "project", remote: u.scope.remote, checkout: null },
      path,
      desired: null,
      installed: path ? shown(own(installed, path) ?? null) : null,
      action: "unavailable",
      reason: u.reason,
    });
  }
  for (const [path, entry] of mine) {
    if (wanted.has(path) || entry.location.scope !== "global") continue;
    const now = own(installed, path) ?? null;
    const action =
      !now || sameState(now, entry.treeHash, entry.executables) ? "remove" : "conflict";
    items.push({
      skill: entry.skill,
      harness: entry.harness,
      location: { scope: "global" },
      path,
      desired: null,
      installed: shown(now),
      action,
      reason: action === "conflict" ? "edited since Quench wrote it" : null,
    });
  }
  const byFold = new Map<string, PlanItem[]>();
  for (const item of items)
    if (item.path)
      byFold.set(foldKey(item.path), [...(byFold.get(foldKey(item.path)) ?? []), item]);
  for (const group of byFold.values())
    if (new Set(group.map((i) => i.path)).size > 1)
      for (const item of group) {
        item.action = "conflict";
        item.reason = `folder collides with ${group
          .filter((other) => other.path !== item.path)
          .map((other) => other.path)
          .join(", ")} on case- or Unicode-insensitive filesystems`;
      }
  items.sort(
    (a, b) => cmp(a.harness, b.harness) || cmp(a.skill, b.skill) || cmp(where(a), where(b)),
  );
  const counts = Object.fromEntries(
    PlanAction.options.map((a) => [a, items.filter((i) => i.action === a).length]),
  );
  return {
    version: 1,
    machine: bundle.machine,
    items,
    counts: counts as Plan["counts"],
    warnings,
  };
}
