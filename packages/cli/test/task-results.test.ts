import { expect, test } from "bun:test";
import type { Segment } from "@quench/insights";
import { JEV_USD_PER_INPUT_TOKEN, SKIPPED, type SegmentGuidance } from "@quench/judge";
import { taskResults } from "../src/commands/agent-archive.ts";

const segment = (sessionId: string, startedAt: string, markers: string[]): Segment => ({
  harness: "claude-code",
  sessionId,
  firstTurn: 0,
  lastTurn: 0,
  startedAt,
  endedAt: startedAt,
  runs: 1,
  markers,
  boundary: "session-start",
});

const entry = (segments: Segment[]) => ({ sha256: "", size: 0, mtimeMs: 0, segments });

test("a task that merges into an earlier one is posted removed, and a rerun posts nothing", () => {
  const early = entry([segment("a", "2026-10-20T10:00:00.000Z", ["branch:t3/one"])]);
  const late = entry([segment("b", "2026-11-02T10:00:00.000Z", ["github:acme/widget#5"])]);
  const first = taskResults({ a: early, b: late }, {});
  expect(first.due.map((t) => [t.sessions, t.removed])).toEqual([
    [1, false],
    [1, false],
  ]);
  const lateId = first.due[1]!.taskId;
  const joined = entry([
    segment("a", "2026-10-20T10:00:00.000Z", ["branch:t3/one", "github:acme/widget#5"]),
  ]);
  const second = taskResults({ a: joined, b: late }, first.next);
  expect(second.due.map((t) => [t.taskId === lateId, t.removed, t.sessions])).toEqual([
    [false, false, 2],
    [true, true, 0],
  ]);
  expect(second.due[1]!.startedAt).toBe("2026-11-02T10:00:00.000Z");
  expect(taskResults({ a: joined, b: late }, second.next).due).toEqual([]);
});

test("a marker too long for the hub is dropped instead of refusing the batch", () => {
  const long = `branch:${"x".repeat(700)}`;
  const { due } = taskResults({ a: entry([segment("a", "2026-10-20T10:00:00.000Z", [long])]) }, {});
  expect(due[0]!.markers).toEqual([]);
});

test("a task carries its worst guidance verdict, the broken rule's id and the summed judge cost", () => {
  const judged = (sessionId: string, marker: string, guidance: SegmentGuidance | undefined) => ({
    ...segment(sessionId, "2026-10-20T10:00:00.000Z", [marker]),
    ...(guidance ? { guidance } : {}),
  });
  const { due } = taskResults(
    {
      a: entry([
        judged("a", "branch:t3/one", { guidance: "kept", rule: null, turns: 1, tokens: 500 }),
      ]),
      b: entry([
        judged("b", "branch:t3/one", { guidance: "broken", rule: "b#3", turns: 2, tokens: 1000 }),
      ]),
      c: entry([judged("c", "branch:t3/two", SKIPPED)]),
      d: entry([judged("d", "branch:t3/three", undefined)]),
    },
    {},
  );
  expect(
    due.map((t) => [t.sessions, t.guidance, t.guidanceRule, t.guidanceTurns, t.guidanceCost]),
  ).toEqual([
    [2, "broken", "b#3", 3, 1500 * JEV_USD_PER_INPUT_TOKEN],
    [1, "skipped", null, 0, 0],
    [1, "pending", null, 0, 0],
  ]);
});
