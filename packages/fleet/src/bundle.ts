import { z } from "zod";
import {
  HarnessId,
  MachineName,
  RelativePath,
  Scope,
  Sha256,
  SkillName,
  TreeHash,
} from "./common.ts";
import { FileMode, treeHashOf } from "./tree-hash.ts";

export const BundleFile = z
  .object({
    path: RelativePath,
    mode: FileMode,
    size: z.number().int().nonnegative(),
    sha256: Sha256,
  })
  .strict();

export const BundleSkill = z
  .object({ treeHash: TreeHash, files: z.array(BundleFile) })
  .strict()
  .superRefine((skill, ctx) => {
    if (new Set(skill.files.map((f) => f.path)).size !== skill.files.length)
      ctx.addIssue({ code: "custom", path: ["files"], message: "duplicate file path" });
    if (treeHashOf(skill.files) !== skill.treeHash)
      ctx.addIssue({
        code: "custom",
        path: ["treeHash"],
        message: "tree hash does not match files",
      });
  });

export const BundlePlacement = z
  .object({ skill: SkillName, treeHash: TreeHash, harness: HarnessId, scope: Scope })
  .strict();
export type BundlePlacement = z.infer<typeof BundlePlacement>;

export const Unavailable = z
  .object({ skill: SkillName, harness: HarnessId, scope: Scope, reason: z.string().min(1) })
  .strict();
export type Unavailable = z.infer<typeof Unavailable>;

export const BundleManifest = z
  .object({
    version: z.literal(1),
    machine: MachineName,
    revision: z.string().nullable(),
    skills: z.record(SkillName, BundleSkill),
    placements: z.array(BundlePlacement),
    unavailable: z.array(Unavailable),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    for (const [name, skill] of Object.entries(bundle.skills))
      skill.files.forEach((f, i) => {
        if (!RelativePath.safeParse(f.path).success)
          ctx.addIssue({
            code: "custom",
            path: ["skills", name, "files", i],
            message: "outside skill folder",
          });
      });
    bundle.placements.forEach((p, i) => {
      if (bundle.skills[p.skill]?.treeHash !== p.treeHash)
        ctx.addIssue({
          code: "custom",
          path: ["placements", i],
          message: `no ${p.skill} at ${p.treeHash}`,
        });
    });
  });
export type BundleManifest = z.infer<typeof BundleManifest>;
