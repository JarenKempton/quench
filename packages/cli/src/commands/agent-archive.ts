import { readFile, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import {
  ANALYSIS_VERSION,
  MAX_SESSION_ROWS,
  MAX_MARKER_CHARS,
  MAX_TASK_MEMBERS,
  MAX_TASK_ROWS,
  MAX_TRANSCRIPT_BYTES,
  MAX_UPLOAD_BYTES,
  sha256,
  TranscriptPath,
  type SessionResult,
  type TaskResult,
} from "@quench/fleet";
import {
  discoverAll,
  harnessById,
  startedAt,
  sumOf,
  type Home,
  type Session,
  type SessionRef,
} from "@quench/history";
import { putTranscript, postSessions, postTasks } from "@quench/hub/client";
import {
  behaviour,
  judgedTasks,
  runs,
  segments,
  segmentSignals,
  type JudgedSegment,
  type Pull,
} from "@quench/insights";
import {
  combine,
  Guidance,
  guidanceBreaks,
  Jev,
  JEV_USD_PER_INPUT_TOKEN,
  JevGuidance,
  judgeGuidance,
  judgeReplies,
  KeyRejected,
  loadedStandards,
  ThemeCache,
  VerdictCache,
  type GuidanceInput,
  type GuidanceJudge,
  type SegmentGuidance,
} from "@quench/judge";
import { judgeChoice, readConfig } from "../config.ts";
import { replacePrivateFile } from "../private-file.ts";
import { githubPulls, repoOf, run, type Run } from "./github-pulls.ts";

export const IDLE_MS = 30 * 60_000;
export const CYCLE_BYTES = 256 * 1024 * 1024;
export const RETRY_MS = 6 * 3_600_000;

export type Shipped = Record<
  string,
  {
    sha256: string;
    size: number;
    mtimeMs: number;
    guidedAt?: number;
    segments?: (JudgedSegment & { guidance?: SegmentGuidance })[];
  }
>;
type Guide = { cache: ThemeCache<GuidanceInput>; judge: GuidanceJudge | null };
type Posted = Record<string, { hash: string; startedAt: string }>;

export type ArchiveStatus = {
  uploaded: number;
  results: number;
  tasks: number;
  judgeTokens: number;
  bytes: number;
  stored: number;
  waiting: number;
  offline: number;
  skipped: Record<string, number>;
  error: string | null;
};

const stateFile = (dir: string) => join(dir, "archive.json");
export const archived = (dir: string) => readJson<Shipped>(stateFile(dir));
const tasksFile = (dir: string) => join(dir, "tasks.json");

async function readJson<T>(path: string): Promise<T | Record<string, never>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return {};
  }
}

const count = <K extends string>(map: Partial<Record<K, number>>, key: K) => {
  map[key] = (map[key] ?? 0) + 1;
};

const unique = (values: (string | null)[]) =>
  [...new Set(values.filter((v): v is string => !!v))].sort();

export async function sessionSegments(
  session: Session,
  verdicts: VerdictCache,
  guide: Guide,
  skillRoots: readonly string[] = [],
  exec: Run = run,
) {
  const sessionRuns = runs(session);
  const { replies } = await judgeReplies(
    [
      {
        id: session.id,
        path: session.path,
        harness: session.harness,
        cwd: session.cwd,
        runs: sessionRuns,
      },
    ],
    verdicts,
    null,
  );
  const at = (kind: string, shift: number) =>
    new Set(replies.flatMap((r) => (r.kind === kind ? [r.position - shift] : [])));
  const corrected = at("correction", 1);
  const standards = await loadedStandards(session, sessionRuns, [
    ...(session.cwd ? [join(session.cwd, ".claude/skills")] : []),
    ...skillRoots,
  ]);
  const found = [];
  const repo = await repoOf(session.cwd, exec);
  for (const segment of segments(session, sessionRuns, at("new_request", 0), repo))
    found.push({
      ...segment,
      signals: segmentSignals(sessionRuns, segment, corrected),
      guidance: await judgeGuidance(
        guidanceBreaks(
          session.id,
          sessionRuns,
          replies,
          segment.firstTurn,
          segment.lastTurn,
          standards,
        ),
        guide.cache,
        guide.judge,
      ),
    });
  return found;
}

const memberKey = (m: { harness: string; sessionId: string; firstTurn: number }) =>
  JSON.stringify([m.harness, m.sessionId, m.firstTurn]);

const PENDING: SegmentGuidance = {
  guidance: "pending",
  unreliableRule: null,
  turns: 0,
  tokens: 0,
};

const stored = (s: { guidance?: SegmentGuidance }) =>
  s.guidance && Guidance.safeParse(s.guidance.guidance).success ? s.guidance : PENDING;

const UNJUDGED = {
  landed: { verdict: "unknown", reason: "not-seen", evidence: [] },
  spiral: { verdict: "unknown", reason: "no-tools", evidence: [] },
  efficiency: { verdict: "unknown", reason: "no-usage", evidence: [] },
  tokens: null,
  seconds: 0,
} satisfies Partial<TaskResult>;

export function taskRows(
  all: readonly (JudgedSegment & { guidance?: SegmentGuidance })[],
  pulls: readonly Pull[] = [],
): TaskResult[] {
  const guidance = new Map(all.map((s) => [memberKey(s), stored(s)]));
  return judgedTasks(all, pulls).map((task) => {
    const judged = combine(task.members.map((m) => guidance.get(memberKey(m)) ?? PENDING));
    return {
      ...task,
      members: task.members.slice(0, MAX_TASK_MEMBERS),
      markers: task.markers.filter((m) => m.length <= MAX_MARKER_CHARS).slice(0, 100),
      removed: false,
      guidance: judged.guidance,
      guidanceUnreliableRule: judged.unreliableRule,
      guidanceTurns: judged.turns,
      guidanceCost: judged.tokens * JEV_USD_PER_INPUT_TOKEN,
      analysisVersion: ANALYSIS_VERSION,
    };
  });
}

export function taskResults(shipped: Shipped, posted: Posted, pulls: readonly Pull[] = []) {
  const rows = taskRows(
    Object.values(shipped).flatMap((entry) => entry.segments ?? []),
    pulls,
  );
  const seen = new Set(rows.map((r) => r.taskId));
  const next: Posted = {};
  const due: TaskResult[] = [];
  for (const row of rows) {
    const hash = sha256(new TextEncoder().encode(JSON.stringify(row)));
    next[row.taskId] = { hash, startedAt: row.startedAt };
    if (posted[row.taskId]?.hash !== hash) due.push(row);
  }
  for (const [taskId, { startedAt }] of Object.entries(posted))
    if (!seen.has(taskId))
      due.push({
        taskId,
        removed: true,
        startedAt,
        endedAt: startedAt,
        split: "heuristic",
        boundary: "session-start",
        markers: [],
        members: [],
        harnesses: [],
        sessions: 0,
        runs: 0,
        ...UNJUDGED,
        guidance: "skipped",
        guidanceUnreliableRule: null,
        guidanceTurns: 0,
        guidanceCost: 0,
        analysisVersion: ANALYSIS_VERSION,
      });
  return { due, next };
}

export async function sessionResult(
  session: Session,
  path: string,
  digest: string,
  subagents: number,
  verdicts: VerdictCache,
): Promise<SessionResult> {
  const sessionRuns = runs(session);
  const { replies } = await judgeReplies(
    [
      {
        id: session.id,
        path: session.path,
        harness: session.harness,
        cwd: session.cwd,
        runs: sessionRuns,
      },
    ],
    verdicts,
    null,
  );
  const kinds: Record<string, number> = {};
  const corrections: SessionResult["corrections"] = {};
  const signals: Record<string, number> = {};
  for (const reply of replies) {
    if (reply.kind) count(kinds, reply.kind);
    if (reply.kind === "correction") count(corrections, reply.sender ?? "unknown");
  }
  for (const run of sessionRuns) for (const b of behaviour(run)) count(signals, b.kind);
  const total = (field: "input" | "cacheRead" | "cacheWrite" | "output") =>
    sumOf(...sessionRuns.map((r) => r.usage[field]));
  const times = session.events.flatMap((e) => (e.at ? [e.at.getTime()] : []));
  const started = startedAt(session);
  return {
    harness: session.harness,
    sessionId: session.id,
    parent: session.parent,
    path,
    sha256: digest,
    cwd: session.cwd,
    branch: session.branch,
    startedAt: started?.toISOString() ?? null,
    endedAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
    runs: sessionRuns.length,
    finishedRuns: sessionRuns.filter((r) => r.outcome !== null).length,
    models: unique(sessionRuns.map((r) => r.model)).slice(0, 50),
    inputTokens: total("input"),
    cacheReadTokens: total("cacheRead"),
    cacheWriteTokens: total("cacheWrite"),
    outputTokens: total("output"),
    toolCalls: sessionRuns.reduce((n, r) => n + r.toolCalls, 0),
    toolErrors: sessionRuns.reduce((n, r) => n + r.toolErrors, 0),
    compactions: sessionRuns.reduce((n, r) => n + r.compactions, 0),
    subagents,
    replies: kinds,
    corrections,
    unclassifiedReplies: replies.filter((r) => r.kind === null).length,
    signals,
    skillsInvoked: unique(
      session.events.map((e) => (e.type === "invocation" ? e.name : null)),
    ).slice(0, 500),
    judgeId: replies.some((r) => r.classified === "cached") ? verdicts.judge : "",
    analysisVersion: ANALYSIS_VERSION,
  };
}

const keyOf = (ref: SessionRef, path: string) => `${ref.harness}\0${path}`;

export const transcriptPath = (home: Home, ref: SessionRef) =>
  relative(home.of(harnessById[ref.harness].home), ref.path).split(sep).join("/");

export const sessionKey = (home: Home, ref: SessionRef) => keyOf(ref, transcriptPath(home, ref));

export async function archiveCycle(
  home: Home,
  dir: string,
  now = Date.now(),
  exec: Run = run,
): Promise<ArchiveStatus> {
  const status: ArchiveStatus = {
    uploaded: 0,
    results: 0,
    tasks: 0,
    judgeTokens: 0,
    bytes: 0,
    stored: 0,
    waiting: 0,
    offline: 0,
    skipped: {},
    error: null,
  };
  const shipped: Shipped = await readJson<Shipped>(stateFile(dir));
  const choice = judgeChoice(await readConfig(home.dir), process.env);
  const judge =
    !(choice instanceof Error) && choice.name === "jev" && choice.apiKey
      ? new JevGuidance(choice.apiKey)
      : null;
  let rejected = false;
  const guide: Guide = {
    cache: await ThemeCache.open<GuidanceInput>(
      join(home.dir, ".quench/local/guidance.jsonl"),
      JevGuidance.id,
    ),
    judge: judge && {
      id: judge.id,
      guidance: async (input) => {
        if (rejected) throw new Error("judge key rejected");
        try {
          const decision = await judge.guidance(input);
          status.judgeTokens += decision.tokens ?? 0;
          return decision;
        } catch (error) {
          if (!(error instanceof KeyRejected)) throw error;
          rejected = true;
          count(status.skipped, "judge-key-rejected");
          throw new Error("judge key rejected");
        }
      },
    },
  };
  const refs = await discoverAll(home);
  const children = new Map<string, number>();
  for (const ref of refs)
    if (ref.parent)
      children.set(
        `${ref.harness}\0${ref.parent}`,
        (children.get(`${ref.harness}\0${ref.parent}`) ?? 0) + 1,
      );
  const due: {
    ref: SessionRef;
    path: string;
    size: number;
    mtimeMs: number;
    retry: boolean;
  }[] = [];
  for (const ref of refs) {
    const path = transcriptPath(home, ref);
    if (!TranscriptPath.safeParse(path).success) {
      count(status.skipped, "path");
      continue;
    }
    const info = await stat(ref.path).catch(() => null);
    if (!info) continue;
    if (now - info.mtimeMs < IDLE_MS) {
      status.waiting++;
      continue;
    }
    const known = shipped[keyOf(ref, path)];
    const retry =
      !!judge &&
      now - (known?.guidedAt ?? 0) >= RETRY_MS &&
      !!known?.segments?.some((s) => stored(s).guidance === "pending");
    if (
      known?.segments?.every((s) => s.signals && s.repo !== undefined) &&
      known.size === info.size &&
      known.mtimeMs === info.mtimeMs &&
      !retry
    )
      continue;
    if (info.size > MAX_TRANSCRIPT_BYTES) {
      count(status.skipped, "too-large");
      continue;
    }
    due.push({ ref, path, size: info.size, mtimeMs: info.mtimeMs, retry });
  }
  due.sort((a, b) => Number(a.retry) - Number(b.retry) || a.mtimeMs - b.mtimeMs);
  const verdicts = await VerdictCache.open(join(home.dir, ".quench/local"), Jev.id, true);
  const pending: {
    key: string;
    entry: Shipped[string];
    result: SessionResult | null;
  }[] = [];
  const flush = async () => {
    const results = pending.flatMap((p) => (p.result ? [p.result] : []));
    for (let i = 0; i < results.length; i += MAX_SESSION_ROWS)
      await postSessions(dir, results.slice(i, i + MAX_SESSION_ROWS));
    status.results += results.length;
    for (const p of pending) shipped[p.key] = p.entry;
    pending.length = 0;
    await replacePrivateFile(stateFile(dir), `${JSON.stringify(shipped)}\n`);
  };
  let segmented = 0;
  try {
    for (const item of due) {
      if (status.bytes + segmented >= CYCLE_BYTES) {
        status.waiting++;
        continue;
      }
      const bytes = await readFile(item.ref.path);
      const digest = sha256(bytes);
      const key = keyOf(item.ref, item.path);
      const session = await harnessById[item.ref.harness].read(item.ref).catch(() => null);
      const segments = session
        ? await sessionSegments(
            session,
            verdicts,
            guide,
            [join(home.of(harnessById["claude-code"].home), "skills")],
            exec,
          )
        : [];
      const entry = {
        sha256: digest,
        size: bytes.length,
        mtimeMs: item.mtimeMs,
        ...(judge && !rejected ? { guidedAt: now } : {}),
        segments,
      };
      if (shipped[key]?.sha256 === digest) {
        segmented += bytes.length;
        pending.push({ key, entry, result: null });
        if (pending.length >= MAX_SESSION_ROWS) await flush();
        continue;
      }
      if (!session) count(status.skipped, "unreadable");
      const compressed = await Bun.zstdCompress(bytes, { level: 10 });
      if (compressed.length > MAX_UPLOAD_BYTES) {
        count(status.skipped, "too-large");
        continue;
      }
      await putTranscript(
        dir,
        {
          harness: item.ref.harness,
          path: item.path,
          sha256: digest,
          sessionId: session?.id ?? basename(item.path, ".jsonl"),
          modifiedAt: new Date(item.mtimeMs).toISOString(),
        },
        compressed,
      );
      status.uploaded++;
      status.bytes += bytes.length;
      status.stored += compressed.length;
      const subagents = session ? (children.get(`${session.harness}\0${session.id}`) ?? 0) : 0;
      pending.push({
        key,
        entry,
        result: session
          ? await sessionResult(session, item.path, digest, subagents, verdicts)
          : null,
      });
      if (pending.length >= MAX_SESSION_ROWS) await flush();
    }
    await flush();
    const posted: Posted = await readJson<Posted>(tasksFile(dir));
    const all = Object.values(shipped).flatMap((entry) => entry.segments ?? []);
    const github = await githubPulls(dir, all, now, exec);
    status.offline = github.offline;
    const { due: taskRows, next } = taskResults(shipped, posted, github.pulls);
    for (let i = 0; i < taskRows.length; i += MAX_TASK_ROWS)
      await postTasks(dir, taskRows.slice(i, i + MAX_TASK_ROWS));
    status.tasks = taskRows.length;
    if (taskRows.length) await replacePrivateFile(tasksFile(dir), `${JSON.stringify(next)}\n`);
  } catch (error) {
    status.error = (error as Error).message;
  }
  return status;
}

const offline = (status: ArchiveStatus) =>
  status.offline
    ? `; gh could not reach ${status.offline} repo${status.offline === 1 ? "" : "s"}, Landed there uses cached PR state or transcripts`
    : "";

export const archiveLine = (status: ArchiveStatus) =>
  status.error
    ? `; archive: ${status.error}`
    : status.uploaded || status.waiting
      ? `; archived ${status.uploaded} sessions (${status.results} results, ${status.tasks} tasks), ${status.waiting} waiting${status.judgeTokens ? `, judge $${(status.judgeTokens * JEV_USD_PER_INPUT_TOKEN).toFixed(4)}` : ""}${offline(status)}`
      : offline(status);
