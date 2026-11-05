import { z } from "zod";
import { MachineName, Sha256, SkillName, Timestamp, TreeHash } from "./common.ts";
import { sha256 } from "./tree-hash.ts";

export const MAX_PROPOSAL_BYTES = 64 * 1024;

export const EvidenceRef = z
  .object({
    kind: z.enum(["insight-card", "eval-summary"]),
    name: z.string().min(1).max(200),
    counts: z.record(z.string().min(1), z.number().int().nonnegative()),
  })
  .strict();

export const Claims = z
  .object({
    agent: z.string().max(200),
    harness: z.string().max(200),
    session: z.string().max(200),
  })
  .partial()
  .strict();

export const ProposalSubmission = z
  .object({
    skill: SkillName,
    baseTreeHash: TreeHash,
    file: z.literal("SKILL.md"),
    content: z
      .string()
      .refine((c) => Buffer.byteLength(c) <= MAX_PROPOSAL_BYTES, "proposal too large"),
    claims: Claims.default({}),
    evidence: z.array(EvidenceRef).default([]),
  })
  .strict();
export type ProposalSubmission = z.infer<typeof ProposalSubmission>;

export const Proposal = ProposalSubmission.extend({
  revision: Sha256,
  machine: MachineName,
  submittedAt: Timestamp,
}).readonly();
export type Proposal = z.infer<typeof Proposal>;

export const proposal = (
  submission: ProposalSubmission,
  machine: string,
  submittedAt: string,
): Proposal =>
  Proposal.parse({ ...submission, revision: sha256(submission.content), machine, submittedAt });
