import { z } from "zod";
import { HarnessId, SkillName, Timestamp, TreeHash } from "./common.ts";

export const BASIS = "co-occurrence, not cause";

const Count = z.number().int().nonnegative();

export const RecordName = z
  .string()
  .max(128)
  .refine((name) => name.split(":").every((part) => SkillName.safeParse(part).success), {
    message: "each : segment must be a skill name",
  });

const Label = z
  .string()
  .min(1)
  .max(1024)
  .refine((text) => text.isWellFormed() && !/\p{Cc}/u.test(text), {
    message: "no control characters",
  });

export const CoOccurrence = z
  .object({
    basis: z.literal(BASIS),
    sessionsLoaded: Count.nullable(),
    withHumanCorrection: Count.nullable(),
    unjudgedSessions: Count.nullable(),
    noFollowUp: Count.nullable(),
  })
  .strict();

export const VersionCounts = z
  .object({
    sessions: Count,
    judged: Count,
    withHumanCorrection: Count,
    unjudged: Count,
    noFollowUp: Count,
  })
  .strict()
  .refine((c) => c.judged + c.unjudged + c.noFollowUp === c.sessions, {
    message: "judged, unjudged and no follow-up must add up to sessions",
  })
  .refine((c) => c.withHumanCorrection <= c.judged, {
    message: "corrections cannot exceed judged sessions",
  });
export type VersionCounts = z.infer<typeof VersionCounts>;

export const SkillVersion = z
  .object({
    treeHash: TreeHash,
    from: Timestamp,
    to: Timestamp.nullable(),
    loaded: VersionCounts,
    without: VersionCounts,
  })
  .strict();
export type SkillVersion = z.infer<typeof SkillVersion>;

export const SkillRecord = z
  .object({
    id: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    skill: RecordName,
    harness: HarnessId,
    location: Label,
    origin: z.enum(["user", "project", "plugin", "vendored"]).nullable(),
    contentVersion: TreeHash.nullable(),
    listedBy: z.array(HarnessId),
    listingChars: Count.nullable(),
    recordedListingChars: z.number().nonnegative().nullable(),
    bodyBytes: Count.nullable(),
    use: z
      .object({
        sessionsListed: Count.nullable(),
        used: Count.nullable(),
        usedByUser: Count.nullable(),
        lowerBound: z.boolean(),
      })
      .strict(),
    coOccurrence: CoOccurrence,
    versions: z.array(SkillVersion).max(200).optional(),
  })
  .strict();
export type SkillRecord = z.infer<typeof SkillRecord>;

export const SkillReport = z
  .object({
    schemaVersion: z.literal(1),
    days: z.number().int().positive(),
    judge: Label.max(128).nullable(),
    records: z.array(SkillRecord).max(5000),
    unrecognised: z
      .object({
        recognised: z.literal(false),
        count: Count,
        sessionsListed: Count,
        used: Count,
        usedByUser: Count,
      })
      .strict(),
  })
  .strict();
export type SkillReport = z.infer<typeof SkillReport>;
