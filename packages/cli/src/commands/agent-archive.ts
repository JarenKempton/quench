import { readFile, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import {
  ANALYSIS_VERSION,
  MAX_SESSION_ROWS,
  MAX_TRANSCRIPT_BYTES,
  sha256,
  TranscriptPath,
  type SessionResult,
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
import { putTranscript, postSessions } from "@quench/hub/client";
import { behaviour, runs } from "@quench/insights";
import { Jev, judgeReplies, VerdictCache } from "@quench/judge";
import { replacePrivateFile } from "../private-file.ts";

export const IDLE_MS = 30 * 60_000;
export const CYCLE_BYTES = 256 * 1024 * 1024;

type Shipped = Record<string, { sha256: string; size: number; mtimeMs: number }>;

export type ArchiveStatus = {
  uploaded: number;
  results: number;
  bytes: number;
  stored: number;
  waiting: number;
  skipped: Record<string, number>;
  error: string | null;
};

const stateFile = (dir: string) => join(dir, "archive.json");

async function readShipped(dir: string): Promise<Shipped> {
  try {
    return JSON.parse(await readFile(stateFile(dir), "utf8")) as Shipped;
  } catch {
    return {};
  }
}

const count = <K extends string>(map: Partial<Record<K, number>>, key: K) => {
  map[key] = (map[key] ?? 0) + 1;
};

const unique = (values: (string | null)[]) =>
  [...new Set(values.filter((v): v is string => !!v))].sort();

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

export async function archiveCycle(
  home: Home,
  dir: string,
  now = Date.now(),
): Promise<ArchiveStatus> {
  const status: ArchiveStatus = {
    uploaded: 0,
    results: 0,
    bytes: 0,
    stored: 0,
    waiting: 0,
    skipped: {},
    error: null,
  };
  const shipped = await readShipped(dir);
  const refs = await discoverAll(home);
  const children = new Map<string, number>();
  for (const ref of refs)
    if (ref.parent)
      children.set(
        `${ref.harness}\0${ref.parent}`,
        (children.get(`${ref.harness}\0${ref.parent}`) ?? 0) + 1,
      );
  const due: { ref: SessionRef; path: string; size: number; mtimeMs: number }[] = [];
  for (const ref of refs) {
    const path = relative(home.of(harnessById[ref.harness].home), ref.path).split(sep).join("/");
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
    if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) continue;
    if (info.size > MAX_TRANSCRIPT_BYTES) {
      count(status.skipped, "too-large");
      continue;
    }
    due.push({ ref, path, size: info.size, mtimeMs: info.mtimeMs });
  }
  due.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const verdicts = await VerdictCache.open(join(home.dir, ".quench/local"), Jev.id, true);
  const pending: { key: string; entry: Shipped[string]; result: SessionResult | null }[] = [];
  const flush = async () => {
    const results = pending.flatMap((p) => (p.result ? [p.result] : []));
    for (let i = 0; i < results.length; i += MAX_SESSION_ROWS)
      await postSessions(dir, results.slice(i, i + MAX_SESSION_ROWS));
    status.results += results.length;
    for (const p of pending) shipped[p.key] = p.entry;
    pending.length = 0;
    await replacePrivateFile(stateFile(dir), `${JSON.stringify(shipped)}\n`);
  };
  try {
    for (const item of due) {
      if (status.bytes >= CYCLE_BYTES) {
        status.waiting++;
        continue;
      }
      const bytes = await readFile(item.ref.path);
      const digest = sha256(bytes);
      const key = keyOf(item.ref, item.path);
      const entry = { sha256: digest, size: bytes.length, mtimeMs: item.mtimeMs };
      if (shipped[key]?.sha256 === digest) {
        shipped[key] = entry;
        continue;
      }
      const session = await harnessById[item.ref.harness].read(item.ref).catch(() => null);
      if (!session) count(status.skipped, "unreadable");
      const compressed = await Bun.zstdCompress(bytes, { level: 10 });
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
  } catch (error) {
    status.error = (error as Error).message;
  }
  return status;
}

export const archiveLine = (status: ArchiveStatus) =>
  status.error
    ? `; archive: ${status.error}`
    : status.uploaded || status.waiting
      ? `; archived ${status.uploaded} sessions (${status.results} results), ${status.waiting} waiting`
      : "";
