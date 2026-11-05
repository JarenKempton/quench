import { expect, test } from "bun:test";
import type { Event, Session } from "@quench/history";
import { runRecords, runs } from "../src/index.ts";

const at = (secs: number) => new Date(Date.UTC(2026, 9, 28, 21, 0, secs));

const say = (secs: number, author: "user" | "assistant", text: string): Event => ({
  type: "message",
  author,
  origin: "unknown",
  text,
  at: at(secs),
});

const think = (secs: number): Event => ({
  type: "inference",
  model: "m",
  effort: null,
  usage: { context: 10, input: 0, cacheRead: 10, cacheWrite: 0, output: 1 },
  at: at(secs),
});

const shell = (secs: number, id: string, command: string, error = false): Event[] => [
  {
    type: "tool_call",
    id,
    name: "anything",
    shell: [{ command, workdir: "/repo" }],
    at: at(secs),
  },
  {
    type: "tool_result",
    callId: id,
    isError: error,
    chars: 1,
    ...(error ? { failure: { kind: "missing-path" as const, detail: "x", exitCode: 1 } } : {}),
    at: at(secs),
  },
];

const session = (events: Event[]): Session => ({
  id: "s",
  harness: "codex",
  path: "/history/s.jsonl",
  cwd: "/repo",
  branch: "main",
  parent: null,
  events,
  diagnostics: { lines: events.length, unparsed: 0 },
});

const harness = session([
  say(0, "user", "the harness sucks"),
  think(1),
  say(2, "assistant", "Profiling the harness job phase by phase."),
  ...shell(3, "a", "gh pr view https://github.com/o/r/pull/7 && cat notes.md"),
  think(4),
  say(60, "user", "also look at session histories"),
  think(61),
  ...shell(62, "b", "cat missing.md", true),
  think(63),
  say(64, "assistant", "The harness is slow because its tests run one at a time."),
  say(120, "user", "thanks"),
  think(121),
  say(122, "assistant", "Done."),
]);

test("a prompt sent while the agent is still working joins the run, and the outcome is the final message", () => {
  const [first, second] = runRecords(harness, [], at(130));
  expect(first).toMatchObject({
    id: "s:1",
    session: "s",
    harness: "codex",
    cwd: "/repo",
    branch: "main",
    prompt: "the harness sucks",
    steering: ["also look at session histories"],
    outcome: "The harness is slow because its tests run one at a time.",
    startedAt: at(0),
    endedAt: at(64),
    open: false,
    commands: [
      { program: "several commands", subcommand: null, error: null },
      { program: "cat", subcommand: null, error: "other" },
    ],
    failures: [{ tool: "other tool", kind: "missing-path", what: "cat" }],
    filesRead: ["/repo/notes.md", "/repo/missing.md"],
    prLinks: ["https://github.com/o/r/pull/7"],
  });
  expect(second).toMatchObject({ id: "s:2", prompt: "thanks", outcome: "Done.", open: true });
  expect(runs(harness)).toHaveLength(3);
});

test("a run closes after ten idle minutes and later activity starts another run", () => {
  const events = [
    say(0, "user", "build"),
    think(1),
    ...shell(2, "a", "make"),
    think(700),
    say(701, "user", "still there?"),
    think(702),
  ];
  const list = runRecords(session(events), [], at(800));
  expect(list.map((r) => [r.prompt, r.startedAt, r.open])).toEqual([
    ["build", at(0), false],
    [null, at(700), false],
    ["still there?", at(701), true],
  ]);
  expect(runRecords(session(events.slice(0, 4)), [], at(800))[0]?.open).toBe(false);
  expect(runRecords(session(events.slice(0, 4)), [], at(100))[0]?.open).toBe(true);
});

test("a prompt the agent has not answered yet closes the run before it", () => {
  const events = [
    say(0, "user", "build"),
    think(1),
    say(2, "assistant", "Built."),
    say(30, "user", "ship it"),
  ];
  expect(runRecords(session(events), [], at(40)).map((r) => [r.prompt, r.open])).toEqual([
    ["build", false],
  ]);
});

test("a tool result after ten idle minutes leaves the closed run unchanged", () => {
  const [call, result] = shell(2, "a", "cat later.md", true);
  const events = [
    say(0, "user", "build"),
    think(1),
    call!,
    { ...result!, at: at(700) },
    think(701),
  ];
  const [closed, late] = runRecords(session(events), [], at(800));
  expect(closed).toMatchObject({ toolErrors: 0, failures: [] });
  expect(late).toMatchObject({ prompt: null, toolErrors: 1 });
});

test("a failed command's credentials never reach the run record", () => {
  const command = "curl -u user:review-canary https://example.test";
  const [record] = runRecords(
    session([
      say(0, "user", "fetch it"),
      think(1),
      {
        type: "tool_call",
        id: "c",
        name: "Bash",
        shell: [{ command, workdir: "/repo" }],
        at: at(2),
      },
      {
        type: "tool_result",
        callId: "c",
        isError: true,
        chars: 1,
        failure: { kind: "exit-code", detail: null, exitCode: 22, line: null },
        at: at(3),
      },
      say(4, "assistant", "Failed."),
    ]),
    [],
    at(30),
  );
  expect(record!.failures).toEqual([
    { tool: "Bash", kind: "exit-code", what: "curl", error: "other" },
  ]);
});
