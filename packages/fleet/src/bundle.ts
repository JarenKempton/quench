import { z } from "zod";
import { HarnessId, MachineName, Scope, Sha256, SkillName, TreeHash } from "./common.ts";
import { FileMode } from "./tree-hash.ts";

export const BundleFile = z
  .object({
    path: z.string().min(1),
    mode: FileMode,
    size: z.number().int().nonnegative(),
    sha256: Sha256,
  })
  .strict();

export const BundleSkill = z.object({ name: SkillName, files: z.array(BundleFile) }).strict();

export const BundlePlacement = z
  .object({ skill: SkillName, treeHash: TreeHash, harness: HarnessId, scope: Scope })
  .strict();
export type BundlePlacement = z.infer<typeof BundlePlacement>;

export const BundleManifest = z
  .object({
    version: z.literal(1),
    machine: MachineName,
    revision: z.string().nullable(),
    skills: z.record(TreeHash, BundleSkill),
    placements: z.array(BundlePlacement),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    bundle.placements.forEach((p, i) => {
      if (bundle.skills[p.treeHash]?.name !== p.skill)
        ctx.addIssue({
          code: "custom",
          path: ["placements", i],
          message: `no ${p.skill} at ${p.treeHash}`,
        });
    });
  });
export type BundleManifest = z.infer<typeof BundleManifest>;
