import type { FailureKind } from "@quench/history";
import { durationSeconds, type Run } from "./run.ts";

export const RETRY_LOOP_FAILURES = 3;
export const BAD_INPUT_FAILURES = 2;
export const LONG_RUN_SECONDS = 900;
export const COSTLY_RUN_TOKENS = 10_000_000;

export type Behaviour =
  | { kind: "retry-loop"; failure: FailureKind; what: string; tools: string[]; calls: number[] }
  | { kind: "bad-tool-input"; tools: string[]; calls: number[] }
  | { kind: "long-run"; seconds: number }
  | { kind: "costly-run"; tokens: number };

export type BehaviourKind = Behaviour["kind"];

export const behaviourLabel: Record<BehaviourKind, string> = {
  "retry-loop": `Same failure ${RETRY_LOOP_FAILURES}+ times`,
  "bad-tool-input": `Invalid tool input ${BAD_INPUT_FAILURES}+ times`,
  "long-run": `Ran ${LONG_RUN_SECONDS / 60} min or more`,
  "costly-run": `${COSTLY_RUN_TOKENS / 1_000_000}M+ tokens processed`,
};

export const tokensProcessed = (run: Run) =>
  run.usage.input + run.usage.cacheRead + run.usage.cacheWrite + run.usage.output;

export function behaviour(run: Run): Behaviour[] {
  const found: Behaviour[] = [...retryLoops(run)];
  const invalid = positions(run, (call) => call.failure?.kind === "invalid-input");
  if (invalid.length >= BAD_INPUT_FAILURES)
    found.push({ kind: "bad-tool-input", tools: toolsAt(run, invalid), calls: invalid });
  const seconds = durationSeconds(run);
  if (seconds !== null && seconds >= LONG_RUN_SECONDS) found.push({ kind: "long-run", seconds });
  const tokens = tokensProcessed(run);
  if (tokens >= COSTLY_RUN_TOKENS) found.push({ kind: "costly-run", tokens });
  return found;
}

function retryLoops(run: Run): Behaviour[] {
  const repeats = new Map<string, { failure: FailureKind; what: string; calls: number[] }>();
  run.calls.forEach((call, i) => {
    const failure = call.failure;
    if (!failure || failure.what === null) return;
    const key = JSON.stringify([failure.kind, failure.what]);
    const seen = repeats.get(key) ?? { failure: failure.kind, what: failure.what, calls: [] };
    seen.calls.push(i + 1);
    repeats.set(key, seen);
  });
  return [...repeats.values()]
    .filter((r) => r.calls.length >= RETRY_LOOP_FAILURES)
    .map((r) => ({ kind: "retry-loop", ...r, tools: toolsAt(run, r.calls) }));
}

const positions = (run: Run, matches: (call: Run["calls"][number]) => boolean) =>
  run.calls.flatMap((call, i) => (matches(call) ? [i + 1] : []));

const toolsAt = (run: Run, calls: number[]) => [
  ...new Set(calls.map((position) => run.calls[position - 1]!.tool)),
];
