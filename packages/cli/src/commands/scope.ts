import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { discoverAll, isInside, readSessions, type Home, type SessionRef } from "@quench/history";
import { Cause, type Causes, type Judged, type Reply, type SessionRuns } from "@quench/judge";

export type Scope = { files: string[]; sessions: string[] };

type Wanted = { label: string; path: string };

export type ScopedRefs = { refs: SessionRef[]; wanted: Wanted[] };

export async function scopeRefs(home: Home, scope: Scope): Promise<ScopedRefs | string> {
  const all = await Promise.all(
    (await discoverAll(home)).map(async (r) => ({
      ...r,
      path: await realpath(r.path).catch(() => r.path),
    })),
  );
  const wanted: Wanted[] = [];
  for (const file of scope.files) {
    const path = await realpath(resolve(file)).catch(() => null);
    if (!path) return `${file} does not exist`;
    if (!all.some((r) => r.path === path && !r.parent))
      return `${file} is not a session any known harness wrote`;
    wanted.push({ label: file, path });
  }
  for (const id of scope.sessions) {
    const candidates = all.filter((r) => !r.parent && basename(r.path).includes(id));
    let path: string | null = null;
    for await (const outcome of readSessions(candidates))
      if (outcome.ok && outcome.session.id === id) path = outcome.session.path;
    if (!path) return `No session with id ${id} in any harness home`;
    wanted.push({ label: id, path });
  }
  const paths = new Set(wanted.map((w) => w.path));
  const refs = all.filter(
    (r) =>
      paths.has(r.path) ||
      (r.parent !== null && [...paths].some((p) => isInside(r.path, p.replace(/\.jsonl$/, "")))),
  );
  return { refs, wanted };
}

export const unread = (scoped: ScopedRefs, sessions: readonly SessionRuns[]) =>
  scoped.wanted.find((w) => !sessions.some((s) => s.path === w.path));

const kinds = { person: "human", automation: "agent" } as const;
const sources = { host: "host-history", harness: "harness", judge: "model", unknown: "none" };

export function scopedReport(
  judge: string,
  sessions: readonly SessionRuns[],
  judged: Judged,
  causes: Causes | null,
) {
  const caused = new Map(causes?.caused.map((c) => [c.reply, c]));
  const corrections = judged.replies
    .filter((r) => r.kind === "correction")
    .sort((a, b) => a.path.localeCompare(b.path) || a.position - b.position)
    .map((r) => entry(r, caused.get(r)));
  const count = (kind: string) => corrections.filter((c) => c.sender.kind === kind).length;
  return {
    schemaVersion: 1,
    judge,
    summary: {
      sessionsRead: sessions.length,
      runs: sessions.reduce((n, s) => n + s.runs.length, 0),
      corrections: { human: count("human"), agent: count("agent"), unknown: count("unknown") },
    },
    corrections,
  };
}

function entry(r: Reply, caused: Causes["caused"][number] | undefined) {
  const cause = Cause.safeParse(caused?.cause);
  return {
    sessionId: r.sessionId,
    harness: r.harness,
    file: r.path,
    runIndex: r.position,
    at: r.run.replyAt?.toISOString() ?? null,
    sender: { kind: r.sender ? kinds[r.sender] : "unknown", source: sources[r.senderSource] },
    cause: cause.success ? cause.data : null,
    cached: r.classified !== "new" && caused?.judged !== "new",
    locator: {
      promptLine: r.run.promptLine,
      agentLines: r.run.agentLines,
      replyLine: r.run.replyLine,
    },
  };
}
