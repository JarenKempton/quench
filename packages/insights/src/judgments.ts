import { behaviour, tokensProcessed } from "./behaviour.ts";
import { durationSeconds, type Run } from "./run.ts";
import { tasks, type Segment, type Task } from "./tasks.ts";

export const SPIRAL_REPEATS = 3;
export const MIN_BASELINE = 5;
export const BASELINE_FACTOR = 2;
export const MAX_EVIDENCE = 20;

export type Verdict = "pass" | "fail" | "unknown";

export const LANDED_REASONS = [
  "merged",
  "closed",
  "reverted",
  "corrected",
  "open",
  "unmerged",
  "not-seen",
] as const;
export const SPIRAL_REASONS = [
  "retry-loop",
  "repeated-correction",
  "rising-cost",
  "none",
  "no-tools",
] as const;
export const EFFICIENCY_REASONS = [
  "within-baseline",
  "over-baseline",
  "no-baseline",
  "no-usage",
] as const;

export type Judgment<R extends string> = {
  verdict: Verdict;
  reason: R;
  evidence: string[];
};

export type Judgments = {
  landed: Judgment<(typeof LANDED_REASONS)[number]>;
  spiral: Judgment<(typeof SPIRAL_REASONS)[number]>;
  efficiency: Judgment<(typeof EFFICIENCY_REASONS)[number]>;
  tokens: number | null;
  seconds: number;
};

type Mark<R> = { turn: number; at: string; reason: R };

export type SegmentSignals = {
  landed: Mark<"merged" | "closed">[];
  undone: Mark<"reverted" | "corrected">[];
  spiral: Mark<"retry-loop" | "repeated-correction" | "rising-cost">[];
  tokens: number | null;
  seconds: number;
  toolCalls: number;
};

export type JudgedSegment = Segment & { signals?: SegmentSignals };

export type Pull = {
  repo: string;
  number: number;
  head: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  createdAt: string;
  closedAt: string | null;
  mergedAt: string | null;
};

export const pullId = (pull: Pick<Pull, "repo" | "number">) => `github:${pull.repo}#${pull.number}`;

const MERGE = /\bgh\s+pr\s+merge\b/;
const CLOSE = /\bgh\s+issue\s+close\b/;
const REVERT = /\bgit\s+revert\b/;

const ran = (run: Run, pattern: RegExp) =>
  run.commands.some((c) => c.command && pattern.test(c.command) && run.calls[c.call - 1]?.ok);

const failures = (run: Run) =>
  new Set(
    run.calls.flatMap((c) =>
      c.failure ? [JSON.stringify([c.failure.kind, c.failure.what, c.failure.error])] : [],
    ),
  );

export function segmentSignals(
  runs: readonly Run[],
  segment: Segment,
  corrected: ReadonlySet<number>,
): SegmentSignals {
  const signals: SegmentSignals = {
    landed: [],
    undone: [],
    spiral: [],
    tokens: 0,
    seconds: 0,
    toolCalls: 0,
  };
  let corrections = 0;
  let rising = 0;
  let lastTokens: number | null = null;
  let lastFailures = new Set<string>();
  for (let turn = segment.firstTurn; turn <= segment.lastTurn; turn++) {
    const run = runs[turn];
    if (!run) continue;
    const at = run.startedAt?.toISOString() ?? segment.startedAt;
    const mark = <R>(reason: R): Mark<R> => ({ turn, at, reason });
    if (ran(run, MERGE)) signals.landed.push(mark("merged"));
    else if (ran(run, CLOSE)) signals.landed.push(mark("closed"));
    if (ran(run, REVERT)) signals.undone.push(mark("reverted"));
    if (corrected.has(turn)) signals.undone.push(mark("corrected"));
    if (behaviour(run).some((b) => b.kind === "retry-loop"))
      signals.spiral.push(mark("retry-loop"));
    corrections = corrected.has(turn) ? corrections + 1 : 0;
    if (corrections === SPIRAL_REPEATS) signals.spiral.push(mark("repeated-correction"));
    const tokens = tokensProcessed(run);
    const failed = failures(run);
    const same = [...failed].some((f) => lastFailures.has(f));
    rising =
      !failed.size || tokens === null
        ? 0
        : same && lastTokens !== null && tokens > lastTokens
          ? rising + 1
          : 1;
    if (rising === SPIRAL_REPEATS) signals.spiral.push(mark("rising-cost"));
    lastTokens = tokens;
    lastFailures = failed;
    signals.tokens = signals.tokens === null || tokens === null ? null : signals.tokens + tokens;
    signals.seconds += durationSeconds(run) ?? 0;
    signals.toolCalls += run.toolCalls;
  }
  return signals;
}

const ref = (segment: Segment, turn: number) => `${segment.harness}:${segment.sessionId}#${turn}`;

const cap = (ids: string[]) => [...new Set(ids)].slice(0, MAX_EVIDENCE);

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

type Own = Omit<Judgments, "efficiency">;

function judgeOwn(segments: JudgedSegment[], pulls: readonly Pull[]): Own {
  const known = segments.flatMap((s) => (s.signals ? [{ segment: s, signals: s.signals }] : []));
  const all = <K extends "landed" | "undone" | "spiral">(key: K) =>
    known.flatMap(({ segment, signals }) =>
      (signals[key] as Mark<string>[]).map((m) => ({
        ...m,
        id: ref(segment, m.turn),
      })),
    );
  const merged = pulls.flatMap((p) =>
    p.mergedAt ? [{ at: p.mergedAt, reason: "merged", id: pullId(p), turn: -1 }] : [],
  );
  const landings = (pulls.length ? merged : all("landed")).sort((a, b) => a.at.localeCompare(b.at));
  const first = landings[0];
  const pending = pulls.some((p) => p.state === "OPEN");
  const undone = first
    ? all("undone").filter(
        (u) => u.at > first.at || (u.at === first.at && u.reason === "corrected"),
      )
    : [];
  const landed: Own["landed"] = !first
    ? !pulls.length
      ? { verdict: "unknown", reason: "not-seen", evidence: [] }
      : {
          verdict: pending ? "unknown" : "fail",
          reason: pending ? "open" : "unmerged",
          evidence: cap(pulls.map(pullId)),
        }
    : undone.length
      ? {
          verdict: "fail",
          reason: undone[0]!.reason as "reverted" | "corrected",
          evidence: cap([first.id, ...undone.map((u) => u.id)]),
        }
      : {
          verdict: "pass",
          reason: first.reason as "merged" | "closed",
          evidence: cap(landings.map((l) => l.id)),
        };
  const spirals = all("spiral");
  const toolCalls = known.reduce((n, k) => n + k.signals.toolCalls, 0);
  const spiral: Own["spiral"] = spirals.length
    ? {
        verdict: "fail",
        reason: spirals[0]!.reason as "retry-loop",
        evidence: cap(spirals.map((s) => s.id)),
      }
    : known.length && toolCalls
      ? { verdict: "pass", reason: "none", evidence: [] }
      : { verdict: "unknown", reason: "no-tools", evidence: [] };
  const complete = known.length === segments.length;
  const tokens = complete
    ? known.reduce<number | null>(
        (n, k) => (n === null || k.signals.tokens === null ? null : n + k.signals.tokens),
        0,
      )
    : null;
  return {
    landed,
    spiral,
    tokens,
    seconds: known.reduce((n, k) => n + k.signals.seconds, 0),
  };
}

export const taskKind = (task: Task) => task.harnesses.join("+");

const worktreeBranch = (cwd: string) => cwd.split(/[\\/]/).at(-1)!.replace("-", "/");

const closedAt = (pull: Pull) => pull.mergedAt ?? pull.closedAt ?? "\uffff";

export function taskPulls(grouped: readonly JudgedSegment[][], pulls: readonly Pull[]) {
  const byId = new Map(pulls.map((p) => [pullId(p), p]));
  const byHead = Map.groupBy(pulls, (p) => `${p.repo}\0${p.head}`);
  const headed = (m: JudgedSegment) =>
    m.markers.flatMap((marker) =>
      marker.startsWith("branch:") && m.repo
        ? (byHead.get(`${m.repo}\0${marker.slice(7)}`) ?? []).filter(
            (p) => closedAt(p) >= m.startedAt,
          )
        : [],
    );
  const byCwd = new Map<string, Set<Pull>>();
  const direct = grouped.map((members) => {
    const found = new Set<Pull>();
    for (const m of members) {
      for (const marker of m.markers) {
        const id = byId.get(marker);
        if (id) found.add(id);
      }
      for (const p of headed(m)) {
        found.add(p);
        if (m.cwd) byCwd.set(m.cwd, (byCwd.get(m.cwd) ?? new Set()).add(p));
      }
    }
    return [...found];
  });
  return grouped.map((members, i) => {
    if (direct[i]!.length) return direct[i]!;
    const found = new Set<Pull>();
    for (const m of members) {
      if (!m.cwd || !m.markers.includes(`branch:${worktreeBranch(m.cwd)}`)) continue;
      const window = [...(byCwd.get(m.cwd) ?? [])]
        .filter((p) => closedAt(p) >= m.startedAt)
        .sort((a, b) => closedAt(a).localeCompare(closedAt(b)))[0];
      if (window) found.add(window);
    }
    return [...found];
  });
}

export function judgedTasks(
  all: readonly JudgedSegment[],
  pulls: readonly Pull[] = [],
): (Task & Judgments)[] {
  const byKey = new Map(all.map((s) => [`${s.harness}\0${s.sessionId}\0${s.firstTurn}`, s]));
  const found = tasks(all);
  const grouped = found.map((task) =>
    task.members.map((m) => byKey.get(`${m.harness}\0${m.sessionId}\0${m.firstTurn}`)!),
  );
  const linked = taskPulls(grouped, pulls);
  const own = found.map((task, i) => ({ task, own: judgeOwn(grouped[i]!, linked[i]!) }));
  const landed = own.filter((o) => o.own.landed.verdict === "pass" && o.own.tokens !== null);
  return own.map(({ task, own }) => {
    const peers = landed.filter((o) => o.task !== task && taskKind(o.task) === taskKind(task));
    const efficiency: Judgments["efficiency"] =
      own.tokens === null
        ? { verdict: "unknown", reason: "no-usage", evidence: [] }
        : peers.length < MIN_BASELINE
          ? { verdict: "unknown", reason: "no-baseline", evidence: [] }
          : own.tokens <= BASELINE_FACTOR * median(peers.map((p) => p.own.tokens!)) &&
              own.seconds <= BASELINE_FACTOR * median(peers.map((p) => p.own.seconds))
            ? {
                verdict: "pass",
                reason: "within-baseline",
                evidence: cap(peers.map((p) => p.task.taskId)),
              }
            : {
                verdict: "fail",
                reason: "over-baseline",
                evidence: cap(peers.map((p) => p.task.taskId)),
              };
    return { ...task, ...own, efficiency };
  });
}
