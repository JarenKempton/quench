import { z } from "zod";
import {
  HARNESSES,
  HarnessId,
  MachineName,
  own,
  RelativePath,
  Scope,
  SkillName,
} from "./common.ts";

export const Target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }).strict(),
  z.object({ kind: z.literal("tag"), tag: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("person"), person: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("machine"), machine: MachineName }).strict(),
]);
export type Target = z.infer<typeof Target>;

export const Assignment = z
  .object({
    skill: SkillName,
    target: Target,
    scope: Scope,
    harnesses: z.union([z.literal("all"), z.array(HarnessId).min(1)]),
    mode: z.enum(["include", "exclude"]),
  })
  .strict();
export type Assignment = z.infer<typeof Assignment>;

export const FleetSkill = z
  .object({
    path: RelativePath,
    scope: z.string().min(1).optional(),
  })
  .strict();

export const FleetMachine = z
  .object({
    tags: z.array(z.string().min(1)).default([]),
    person: z.string().min(1).optional(),
    scopes: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type FleetMachine = z.infer<typeof FleetMachine>;

export const FleetFile = z
  .object({
    version: z.literal(1),
    openScopes: z.array(z.string().min(1)).default([]),
    skills: z.record(SkillName, FleetSkill),
    machines: z.record(MachineName, FleetMachine).default({}),
    assignments: z.array(Assignment).default([]),
  })
  .strict()
  .superRefine((fleet, ctx) => {
    fleet.assignments.forEach((a, i) => {
      if (!own(fleet.skills, a.skill))
        ctx.addIssue({
          code: "custom",
          path: ["assignments", i, "skill"],
          message: `unknown skill ${a.skill}`,
        });
    });
  });
export type FleetFile = z.infer<typeof FleetFile>;

export type Placement = { skill: string; harness: HarnessId; scope: Scope };
export type Denied = Placement & { reason: string };

const SPECIFICITY = { all: 0, tag: 1, person: 2, machine: 3 } as const;

const matches = (target: Target, name: string, machine: FleetMachine | undefined) =>
  target.kind === "all" ||
  (target.kind === "machine" && target.machine === name) ||
  (target.kind === "tag" && !!machine?.tags.includes(target.tag)) ||
  (target.kind === "person" && machine?.person === target.person);

export const scopeKey = (scope: Scope) => (scope.kind === "global" ? "" : scope.remote);

export function resolve(
  fleet: FleetFile,
  machineName: string,
): { placements: Placement[]; denied: Denied[] } {
  const machine = own(fleet.machines, machineName);
  const winners = new Map<
    string,
    { rank: number; mode: Assignment["mode"]; placement: Placement }
  >();
  for (const a of fleet.assignments) {
    if (!matches(a.target, machineName, machine)) continue;
    const rank = SPECIFICITY[a.target.kind];
    for (const harness of a.harnesses === "all" ? HARNESSES : a.harnesses) {
      const key = `${a.skill}\0${harness}\0${scopeKey(a.scope)}`;
      const known = winners.get(key);
      if (known && (known.rank > rank || (known.rank === rank && known.mode === "exclude")))
        continue;
      winners.set(key, {
        rank,
        mode: a.mode,
        placement: { skill: a.skill, harness, scope: a.scope },
      });
    }
  }
  const included = [...winners.values()]
    .filter((w) => w.mode === "include")
    .map((w) => w.placement)
    .sort(byPlacement);
  const accepts = (scope: string | undefined) =>
    !scope || fleet.openScopes.includes(scope) || !!machine?.scopes.includes(scope);
  return {
    placements: included.filter((p) => accepts(own(fleet.skills, p.skill)!.scope)),
    denied: included
      .filter((p) => !accepts(own(fleet.skills, p.skill)!.scope))
      .map((p) => ({
        ...p,
        reason: `scope ${own(fleet.skills, p.skill)!.scope} is not accepted by ${machineName}`,
      })),
  };
}

export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const byPlacement = (a: Placement, b: Placement) =>
  cmp(a.skill, b.skill) || cmp(a.harness, b.harness) || cmp(scopeKey(a.scope), scopeKey(b.scope));
