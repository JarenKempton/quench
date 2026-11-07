import { expect, test } from "bun:test";
import type { Author, Event, HarnessId, Session } from "@quench/history";
import { runs, segments, tasks } from "../src/index.ts";

const at = (mins: number) => new Date(Date.UTC(2026, 9, 20, 10, mins));

const say = (mins: number, author: Author, text: string): Event => ({
  type: "message",
  author,
  origin: "typed",
  text,
  at: at(mins),
});

const turn = (mins: number, text: string): Event[] => [
  say(mins, "user", text),
  {
    type: "inference",
    model: "m",
    effort: null,
    usage: { context: 1, input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
    at: at(mins + 1),
  },
  say(mins + 2, "assistant", "ok"),
];

const session = (
  id: string,
  branch: string | null,
  events: Event[],
  harness: HarnessId = "claude-code",
  parent: string | null = null,
): Session => ({
  id,
  harness,
  path: `/dev/null/${id}`,
  cwd: null,
  branch,
  parent,
  events,
  diagnostics: { lines: events.length, unparsed: 0 },
});

const cut = (s: Session, newGoals: number[] = []) => segments(s, runs(s), new Set(newGoals));

test("a default-branch session splits at a new goal and an idle gap", () => {
  const s = session("s1", "main", [
    ...turn(0, "fix the login bug"),
    ...turn(5, "also the header"),
    ...turn(10, "now write release notes"),
    ...turn(200, "one more thing"),
  ]);
  const got = cut(s, [2]);
  expect(got.map((g) => [g.firstTurn, g.lastTurn, g.boundary])).toEqual([
    [0, 1, "session-start"],
    [2, 2, "new-goal"],
    [3, 3, "idle-gap"],
  ]);
  expect(tasks(got).map((t) => t.split)).toEqual(["heuristic", "heuristic", "heuristic"]);
});

test("a feature branch keeps one session one task despite new goals and gaps", () => {
  const s = session("s1", "feat/csu-42-login", [...turn(0, "a"), ...turn(300, "b")]);
  const [only, ...rest] = cut(s, [1]);
  expect(rest).toEqual([]);
  expect(only!.markers).toEqual(["branch:feat/csu-42-login", "jira:CSU-42"]);
});

test("a different PR id splits by marker, the same id holds across a gap", () => {
  const pr = (n: number) => `review https://github.com/Acme/Widget/pull/${n}`;
  const s = session("s1", null, [
    ...turn(0, pr(7)),
    ...turn(300, `${pr(7)} again`),
    ...turn(310, pr(9)),
  ]);
  expect(cut(s, [1]).map((g) => [g.firstTurn, g.boundary, g.markers])).toEqual([
    [0, "session-start", ["github:acme/widget#7"]],
    [2, "marker", ["github:acme/widget#9"]],
  ]);
});

test("one task spans sessions and harnesses that share a marker", () => {
  const lane = session("lane", "t3/abc", [...turn(0, "build it")]);
  const later = session("later", "t3/abc", [...turn(50, "finish it")], "codex");
  const other = session("other", "t3/xyz", [...turn(20, "unrelated")]);
  const child = session("child", "t3/abc", [...turn(1, "sub")], "claude-code", "lane");
  const all = [lane, later, other, child].flatMap((s) => cut(s));
  const got = tasks(all);
  expect(got.map((t) => [t.split, t.sessions, t.runs, t.harnesses])).toEqual([
    ["marker", 2, 2, ["claude-code", "codex"]],
    ["marker", 1, 1, ["claude-code"]],
  ]);
  expect(got[0]!.members).toEqual([
    { harness: "claude-code", sessionId: "lane", firstTurn: 0, lastTurn: 0 },
    { harness: "codex", sessionId: "later", firstTurn: 0, lastTurn: 0 },
  ]);
});

test("re-running on the same history in any order gives the same tasks", () => {
  const a = session("a", "t3/abc", [...turn(0, "x")]);
  const b = session("b", "main", [...turn(5, "https://github.com/acme/widget/issues/3")]);
  const c = session("c", null, [...turn(9, "see github.com/Acme/widget/issues/3")]);
  const once = tasks([a, b, c].flatMap((s) => cut(s)));
  const again = tasks([c, a, b].flatMap((s) => cut(s)));
  expect(again).toEqual(once);
  expect(once.map((t) => t.sessions)).toEqual([1, 2]);
  expect(once[0]!.taskId).toMatch(/^[0-9a-f]{32}$/);
});

test("an id cited from two branches never chains them into one task", () => {
  const url = "github.com/acme/widget/pull/5";
  const a = session("a", "t3/one", [...turn(0, url)]);
  const b = session("b", "t3/two", [...turn(5, url)]);
  const lead = session("lead", "main", [...turn(9, url)]);
  const got = tasks([a, b, lead].flatMap((s) => cut(s)));
  expect(got.map((t) => t.members.map((m) => m.sessionId))).toEqual([["a", "lead"], ["b"]]);
});

test("a run citing many ids joins nothing by them", () => {
  const text = [1, 2, 3, 4].map((n) => `github.com/acme/widget/pull/${n}`).join(" ");
  const [only] = cut(session("o", null, [...turn(0, text)]));
  expect(only!.markers).toEqual([]);
});
