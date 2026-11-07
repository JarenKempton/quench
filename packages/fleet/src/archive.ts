import { z } from "zod";
import { HarnessId, insideFolder, Sha256, Timestamp } from "./common.ts";

export const ANALYSIS_VERSION = 1;
export const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_SESSION_ROWS = 500;
export const MAX_TASK_ROWS = 100;
export const MAX_TASK_MEMBERS = 500;

export const TranscriptPath = z
  .string()
  .max(1024)
  .refine((path) => path.endsWith(".jsonl") && insideFolder(path), {
    message: "a transcript path is a .jsonl file inside its harness home, with forward slashes",
  });

const Count = z.number().int().nonnegative();
const Tokens = Count.nullable();
const Label = z.string().min(1).max(200);

export const SessionResult = z
  .object({
    harness: HarnessId,
    sessionId: Label,
    parent: Label.nullable(),
    path: TranscriptPath,
    sha256: Sha256,
    cwd: z.string().max(4096).nullable(),
    branch: z.string().max(500).nullable(),
    startedAt: Timestamp.nullable(),
    endedAt: Timestamp.nullable(),
    runs: Count,
    finishedRuns: Count,
    models: z.array(Label).max(50),
    inputTokens: Tokens,
    cacheReadTokens: Tokens,
    cacheWriteTokens: Tokens,
    outputTokens: Tokens,
    toolCalls: Count,
    toolErrors: Count,
    compactions: Count,
    subagents: Count,
    replies: z.record(Label, Count),
    corrections: z.partialRecord(z.enum(["person", "automation", "unknown"]), Count),
    unclassifiedReplies: Count,
    signals: z.record(Label, Count),
    skillsInvoked: z.array(Label).max(500),
    judgeId: z.string().max(200),
    analysisVersion: Count,
  })
  .strict();
export type SessionResult = z.infer<typeof SessionResult>;

export const SessionResults = z
  .object({ sessions: z.array(SessionResult).max(MAX_SESSION_ROWS) })
  .strict();

export const TaskResult = z
  .object({
    taskId: z.string().regex(/^[0-9a-f]{32}$/),
    removed: z.boolean(),
    startedAt: Timestamp,
    endedAt: Timestamp,
    split: z.enum(["marker", "heuristic"]),
    boundary: z.enum(["session-start", "marker", "new-goal", "idle-gap"]),
    markers: z.array(z.string().min(1).max(600)).max(100),
    members: z
      .array(
        z
          .object({ harness: HarnessId, sessionId: Label, firstTurn: Count, lastTurn: Count })
          .strict(),
      )
      .max(MAX_TASK_MEMBERS),
    harnesses: z.array(HarnessId).max(20),
    sessions: Count,
    runs: Count,
    analysisVersion: Count,
  })
  .strict();
export type TaskResult = z.infer<typeof TaskResult>;

export const TaskResults = z.object({ tasks: z.array(TaskResult).max(MAX_TASK_ROWS) }).strict();

export const TranscriptUpload = z
  .object({
    harness: HarnessId,
    path: TranscriptPath,
    sha256: Sha256,
    sessionId: Label,
    modifiedAt: Timestamp,
  })
  .strict();
export type TranscriptUpload = z.infer<typeof TranscriptUpload>;

export const RETENTION = /^(never|[1-9][0-9]{0,3}[dmy])$/;
export const DEFAULT_RETENTION = "5y";

export function retentionInterval(retention: string) {
  if (!RETENTION.test(retention))
    throw new Error("--retention must look like 90d, 18m, 5y or never");
  if (retention === "never") return null;
  const unit = { d: "DAY", m: "MONTH", y: "YEAR" }[retention.slice(-1) as "d" | "m" | "y"];
  return `INTERVAL ${Number(retention.slice(0, -1))} ${unit}`;
}

export function retentionCutoff(retention: string, now: Date) {
  if (retentionInterval(retention) === null) return null;
  const n = Number(retention.slice(0, -1));
  const at = new Date(now);
  const unit = retention.slice(-1);
  if (unit === "d") at.setUTCDate(at.getUTCDate() - n);
  if (unit === "m") at.setUTCMonth(at.getUTCMonth() - n);
  if (unit === "y") at.setUTCFullYear(at.getUTCFullYear() - n);
  return at;
}
