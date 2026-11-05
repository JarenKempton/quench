import { z } from "zod";
import { HarnessId, MachineName, Remote, SkillName, TreeHash } from "./common.ts";
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

export const PlanAction = z.enum([
  "install",
  "update",
  "unchanged",
  "remove",
  "conflict",
  "unresolved",
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
  installed: Record<string, Installed | undefined>;
  ledger: LedgerEntry[];
  warnings: string[];
};

const where = (item: PlanItem) =>
  item.location.scope === "project" ? `\0${item.location.remote}` : (item.path ?? "");

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
      });
      continue;
    }
    const path = targetPath(roots[p.harness], p.skill);
    wanted.add(path);
    const now = installed[path] ?? null;
    const ours = mine.get(path);
    const action: PlanAction = !now
      ? "install"
      : now.treeHash === p.treeHash
        ? "unchanged"
        : ours?.treeHash === now.treeHash
          ? "update"
          : "conflict";
    items.push({
      skill: p.skill,
      harness: p.harness,
      location: { scope: "global" },
      path,
      desired: p.treeHash,
      installed: now,
      action,
    });
  }
  for (const [path, entry] of mine) {
    if (wanted.has(path) || entry.location.scope !== "global") continue;
    const now = installed[path] ?? null;
    items.push({
      skill: entry.skill,
      harness: entry.harness,
      location: { scope: "global" },
      path,
      desired: null,
      installed: now,
      action: !now || now.treeHash === entry.treeHash ? "remove" : "conflict",
    });
  }
  items.sort(
    (a, b) => cmp(a.harness, b.harness) || cmp(a.skill, b.skill) || cmp(where(a), where(b)),
  );
  const counts = Object.fromEntries(
    PlanAction.options.map((a) => [a, items.filter((i) => i.action === a).length]),
  );
  return { version: 1, machine: bundle.machine, items, counts: counts as Plan["counts"], warnings };
}
