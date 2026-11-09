import { createHash } from "node:crypto";
import type { HarnessId, Session } from "@quench/history";
import type { Run } from "./run.ts";

export const IDLE_GAP_MS = 60 * 60_000;
export const MAX_RUN_IDS = 3;

export type Boundary = "session-start" | "marker" | "new-goal" | "idle-gap";
export type Split = "marker" | "heuristic";

export type Segment = {
  harness: HarnessId;
  sessionId: string;
  firstTurn: number;
  lastTurn: number;
  startedAt: string;
  endedAt: string;
  runs: number;
  markers: string[];
  boundary: Boundary;
  repo?: string | null;
  cwd?: string | null;
};

export type TaskMember = Pick<Segment, "harness" | "sessionId" | "firstTurn" | "lastTurn">;

export type Task = {
  taskId: string;
  startedAt: string;
  endedAt: string;
  split: Split;
  boundary: Boundary;
  markers: string[];
  members: TaskMember[];
  harnesses: HarnessId[];
  sessions: number;
  runs: number;
};

const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "trunk", "HEAD"]);
const GITHUB_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)/g;
const GH_COMMAND =
  /\bgh\s+(?:pr|issue)\s+\w+\s+(\d+)\b[^\n|;&]*?(?:-R|--repo)[\s=]+([\w.-]+\/[\w.-]+)/g;
const GH_BARE = /\bgh\s+pr\s+\w+\s+(\d+)\b/g;
const HAS_REPO = /\s(?:-R|--repo)[\s=]/;
const JIRA_IN_BRANCH = /(?:^|\/)([a-z][a-z0-9]{1,9}-\d+)(?=[-_/]|$)/i;

export const repoKey = (repo: string) => repo.toLowerCase().replace(/\.git$/, "");

export function branchMarkers(branch: string | null): string[] {
  if (!branch || DEFAULT_BRANCHES.has(branch)) return [];
  const jira = JIRA_IN_BRANCH.exec(branch)?.[1];
  return [`branch:${branch}`, ...(jira ? [`jira:${jira.toUpperCase()}`] : [])];
}

export function runMarkers(run: Run, repo: string | null = null): string[] {
  const ids = new Set<string>();
  const commands = run.commands.map((c) => c.command);
  for (const text of [run.prompt, run.assistantSaid, ...commands]) {
    if (!text) continue;
    for (const [, repo, n] of text.matchAll(GITHUB_URL)) ids.add(`github:${repoKey(repo!)}#${n}`);
    for (const [, n, repo] of text.matchAll(GH_COMMAND)) ids.add(`github:${repoKey(repo!)}#${n}`);
  }
  if (repo)
    for (const command of commands)
      if (command && !HAS_REPO.test(command))
        for (const [, n] of command.matchAll(GH_BARE)) ids.add(`github:${repoKey(repo)}#${n}`);
  return ids.size > MAX_RUN_IDS ? [] : [...ids].sort();
}

const markerRepo = (runs: readonly Run[]) => {
  const seen = new Map<string, number>();
  for (const run of runs)
    for (const id of runMarkers(run)) {
      const repo = id.slice("github:".length, id.lastIndexOf("#"));
      seen.set(repo, (seen.get(repo) ?? 0) + 1);
    }
  return [...seen].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

const iso = (at: Date | null) => at?.toISOString() ?? null;

export function segments(
  session: Pick<Session, "harness" | "id" | "parent" | "branch" | "cwd">,
  runs: readonly Run[],
  newGoals: ReadonlySet<number>,
  knownRepo: string | null = null,
  idleMs = IDLE_GAP_MS,
): Segment[] {
  if (session.parent) return [];
  const repo = knownRepo ? repoKey(knownRepo) : markerRepo(runs);
  const branch = branchMarkers(session.branch);
  const out: (Segment & { ids: Set<string> })[] = [];
  let current: (typeof out)[number] | null = null;
  let lastAt: number | null = null;
  runs.forEach((run, turn) => {
    const startedAt = iso(run.startedAt);
    const endedAt = iso(run.endedAt) ?? startedAt;
    const ids = runMarkers(run, repo);
    if (!startedAt || !endedAt) return;
    const at = Date.parse(startedAt);
    const boundary = ((): Boundary | null => {
      if (!current) return "session-start";
      if (branch.length) return null;
      if (ids.length && current.ids.size)
        return ids.some((id) => current!.ids.has(id)) ? null : "marker";
      if (newGoals.has(turn)) return "new-goal";
      if (lastAt !== null && at - lastAt > idleMs) return "idle-gap";
      return null;
    })();
    if (boundary) {
      current = {
        harness: session.harness,
        sessionId: session.id,
        firstTurn: turn,
        lastTurn: turn,
        startedAt,
        endedAt,
        runs: 0,
        markers: [],
        boundary,
        repo,
        cwd: session.cwd,
        ids: new Set(branch),
      };
      out.push(current);
    }
    const segment = current!;
    for (const id of ids) segment.ids.add(id);
    segment.lastTurn = turn;
    segment.runs++;
    if (endedAt > segment.endedAt) segment.endedAt = endedAt;
    lastAt = Date.parse(endedAt);
  });
  return out.map(({ ids, ...segment }) => ({ ...segment, markers: [...ids].sort() }));
}

const order = (a: Segment, b: Segment) =>
  a.startedAt.localeCompare(b.startedAt) ||
  a.harness.localeCompare(b.harness) ||
  a.sessionId.localeCompare(b.sessionId) ||
  a.firstTurn - b.firstTurn;

export function tasks(all: readonly Segment[]): Task[] {
  const sorted = [...all].sort(order);
  const root = sorted.map((_, i) => i);
  const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i]!)));
  const branch = sorted.map((s) => s.markers.find((m) => m.startsWith("branch:")) ?? null);
  const owner = new Map<string, number>();
  sorted.forEach((segment, i) => {
    for (const marker of segment.markers) {
      const j = owner.get(marker);
      if (j === undefined) {
        owner.set(marker, i);
        continue;
      }
      const [a, b] = [find(i), find(j)].sort((x, y) => x - y) as [number, number];
      if (a === b || (branch[a] && branch[b] && branch[a] !== branch[b])) continue;
      root[b] = a;
      branch[a] ??= branch[b]!;
    }
  });
  const groups = new Map<number, Segment[]>();
  sorted.forEach((segment, i) => {
    const r = find(i);
    const group = groups.get(r);
    if (group) group.push(segment);
    else groups.set(r, [segment]);
  });
  return [...groups.values()].map((members) => {
    const first = members[0]!;
    const markers = [...new Set(members.flatMap((m) => m.markers))].sort();
    return {
      taskId: createHash("sha256")
        .update(`${first.harness}\0${first.sessionId}\0${first.firstTurn}`)
        .digest("hex")
        .slice(0, 32),
      startedAt: first.startedAt,
      endedAt: members.reduce((end, m) => (m.endedAt > end ? m.endedAt : end), first.endedAt),
      split: markers.length ? "marker" : "heuristic",
      boundary: first.boundary,
      markers,
      members: members.map(({ harness, sessionId, firstTurn, lastTurn }) => ({
        harness,
        sessionId,
        firstTurn,
        lastTurn,
      })),
      harnesses: [...new Set(members.map((m) => m.harness))].sort(),
      sessions: new Set(members.map((m) => `${m.harness}\0${m.sessionId}`)).size,
      runs: members.reduce((n, m) => n + m.runs, 0),
    };
  });
}
