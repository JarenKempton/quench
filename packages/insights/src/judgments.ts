import { behaviour, tokensProcessed } from "./behaviour.ts";
import { durationSeconds, type Run } from "./run.ts";
import { tasks, type Segment, type Task } from "./tasks.ts";

export const SPIRAL_REPEATS = 3;
export const MIN_BASELINE = 5;
export const BASELINE_FACTOR = 2;
export const MAX_EVIDENCE = 20;

export type Verdict = "pass" | "fail" | "unknown";

export const LANDED_REASONS = ["merged", "closed", "reverted", "corrected", "not-seen"] as const;
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

const MERGE = /\bgh\s+pr\s+merge\b/;
const CLOSE = /\bgh\s+issue\s+close\b/;
const REVERT = /\bgit\s+revert\b/;

const ran = (run: Run, pattern: RegExp) =>
  run.commands.some((c) => c.command && pattern.test(c.command) && run.calls[c.call - 1]?.ok);

const failed = (run: Run) => run.calls.some((c) => c.ok === false);

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
    rising =
      failed(run) && tokens !== null && (lastTokens === null || tokens > lastTokens)
        ? rising + 1
        : 0;
    if (rising === SPIRAL_REPEATS) signals.spiral.push(mark("rising-cost"));
    lastTokens = tokens;
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

function judgeOwn(segments: JudgedSegment[]): Own {
  const known = segments.flatMap((s) => (s.signals ? [{ segment: s, signals: s.signals }] : []));
  const all = <K extends "landed" | "undone" | "spiral">(key: K) =>
    known.flatMap(({ segment, signals }) =>
      (signals[key] as Mark<string>[]).map((m) => ({
        ...m,
        id: ref(segment, m.turn),
      })),
    );
  const landings = all("landed").sort((a, b) => a.at.localeCompare(b.at));
  const first = landings[0];
  const undone = first ? all("undone").filter((u) => u.at >= first.at) : [];
  const landed: Own["landed"] = !first
    ? { verdict: "unknown", reason: "not-seen", evidence: [] }
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

export function judgedTasks(all: readonly JudgedSegment[]): (Task & Judgments)[] {
  const byKey = new Map(all.map((s) => [`${s.harness}\0${s.sessionId}\0${s.firstTurn}`, s]));
  const own = tasks(all).map((task) => ({
    task,
    own: judgeOwn(
      task.members.map((m) => byKey.get(`${m.harness}\0${m.sessionId}\0${m.firstTurn}`)!),
    ),
  }));
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
