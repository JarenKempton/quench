import { expect, test } from "bun:test";
import type { Event, Failure, Session } from "@quench/history";
import {
  judgedTasks,
  MIN_BASELINE,
  runs,
  segments,
  segmentSignals,
  type JudgedSegment,
} from "../src/index.ts";

const at = (mins: number, secs = 0) => new Date(Date.UTC(2026, 9, 20, 10, mins, secs));
const exit: Failure = { kind: "exit-code", detail: null, exitCode: 1 };

let ids = 0;
const shell = (mins: number, command: string, failure: Failure | null = null): Event[] => {
  const id = `c${ids++}`;
  return [
    { type: "tool_call", id, name: "Bash", at: at(mins, 1), shell: [{ command, workdir: null }] },
    {
      type: "tool_result",
      callId: id,
      isError: failure !== null,
      chars: 10,
      at: at(mins, 2),
      ...(failure ? { failure } : {}),
    },
  ];
};

const turn = (mins: number, body: Event[] = [], tokens = 1_000): Event[] => [
  { type: "message", author: "user", origin: "typed", text: `step ${mins}`, at: at(mins) },
  {
    type: "inference",
    model: "m",
    effort: null,
    usage: { context: tokens, input: 0, cacheRead: tokens, cacheWrite: 0, output: 0 },
    at: at(mins, 1),
  },
  ...body,
  { type: "message", author: "assistant", origin: "typed", text: "done", at: at(mins, 30) },
];

const judged = (id: string, events: Event[], corrected: number[] = []): JudgedSegment[] => {
  const session: Session = {
    id,
    harness: "claude-code",
    path: `/dev/null/${id}`,
    cwd: null,
    branch: `t3/${id}`,
    parent: null,
    events,
    diagnostics: { lines: events.length, unparsed: 0 },
  };
  const all = runs(session);
  return segments(session, all, new Set()).map((s) => ({
    ...s,
    signals: segmentSignals(all, s, new Set(corrected)),
  }));
};

const only = (segs: JudgedSegment[]) => judgedTasks(segs)[0]!;

test("a merged PR lands, and a later revert or correction fails it", () => {
  const merged = [...turn(0, shell(0, "bun test")), ...turn(5, shell(5, "gh pr merge 12"))];
  expect(only(judged("a", merged)).landed).toEqual({
    verdict: "pass",
    reason: "merged",
    evidence: ["claude-code:a#1"],
  });
  expect(only(judged("b", [...merged, ...turn(9, shell(9, "git revert HEAD"))])).landed).toEqual({
    verdict: "fail",
    reason: "reverted",
    evidence: ["claude-code:b#1", "claude-code:b#2"],
  });
  expect(only(judged("c", [...merged, ...turn(9)], [1])).landed.reason).toBe("corrected");
  expect(only(judged("d", [...turn(0), ...turn(5)], [0])).landed).toEqual({
    verdict: "unknown",
    reason: "not-seen",
    evidence: [],
  });
});

test("a blocked merge does not land, and a closed ticket does", () => {
  expect(only(judged("a", turn(0, shell(0, "gh pr merge 3", exit)))).landed.verdict).toBe(
    "unknown",
  );
  expect(only(judged("b", turn(0, shell(0, "gh issue close 3")))).landed.reason).toBe("closed");
  const sameTurn = turn(0, [...shell(0, "git revert abc"), ...shell(0, "gh pr merge 3")]);
  expect(only(judged("c", sameTurn)).landed.verdict).toBe("pass");
});

test("the same failure three times, three corrections in a row, or rising failing cost is a spiral", () => {
  const loop = turn(
    0,
    [1, 2, 3].flatMap(() => shell(0, "bun test", exit)),
  );
  expect(only(judged("a", loop)).spiral).toEqual({
    verdict: "fail",
    reason: "retry-loop",
    evidence: ["claude-code:a#0"],
  });
  const calm = [0, 5, 10].flatMap((m) => turn(m, shell(m, "ls")));
  expect(only(judged("b", calm)).spiral).toEqual({ verdict: "pass", reason: "none", evidence: [] });
  expect(only(judged("c", calm, [0, 1, 2])).spiral).toEqual({
    verdict: "fail",
    reason: "repeated-correction",
    evidence: ["claude-code:c#2"],
  });
  const rising = (commands: string[]) =>
    commands.flatMap((c, i) => turn(i * 5, shell(i * 5, c, exit), 1_000 * (i + 1)));
  expect(only(judged("d", rising(["bun test", "bun test", "bun test"]))).spiral.reason).toBe(
    "rising-cost",
  );
  expect(only(judged("f", rising(["grep foo", "ls missing", "bun test"]))).spiral.verdict).toBe(
    "pass",
  );
  expect(only(judged("e", turn(0))).spiral.verdict).toBe("unknown");
});

test("efficiency reports no baseline until enough landed tasks of the same kind exist", () => {
  const landed = (id: string, tokens: number) =>
    judged(id, turn(0, shell(0, "gh pr merge 1"), tokens)).map((s) => ({
      ...s,
      startedAt: `2026-10-${10 + Number(id.slice(1))}T10:00:00.000Z`,
    }));
  const peers = Array.from({ length: MIN_BASELINE }, (_, i) => landed(`p${i}`, 1_000));
  const thin = judgedTasks(peers.slice(1).flat());
  expect(thin.map((t) => t.efficiency.reason)).toEqual(Array(MIN_BASELINE - 1).fill("no-baseline"));
  const all = judgedTasks([...peers.flat(), ...landed("p9", 50_000), ...landed("p8", 1_500)]);
  const by = (id: string) => all.find((t) => t.members[0]!.sessionId === id)!.efficiency;
  expect(by("p9")).toEqual(expect.objectContaining({ verdict: "fail", reason: "over-baseline" }));
  expect(by("p8")).toEqual(expect.objectContaining({ verdict: "pass", reason: "within-baseline" }));
  expect(by("p8").evidence).toHaveLength(MIN_BASELINE + 1);
});
