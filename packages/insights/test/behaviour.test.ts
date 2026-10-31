import { expect, test } from "bun:test";
import type { Event, Failure, Session } from "@quench/history";
import { behaviour, runs, signals } from "../src/index.ts";

const at = (secs: number) => new Date(Date.UTC(2026, 9, 20, 10, 0, secs));

let ids = 0;
const failing = (name: string, failure: Failure | null, shell?: string): Event[] => {
  const id = `c${ids++}`;
  return [
    {
      type: "tool_call",
      id,
      name,
      at: at(2),
      ...(shell ? { shell: [{ command: shell, workdir: null }] } : {}),
    },
    {
      type: "tool_result",
      callId: id,
      isError: failure !== null,
      chars: 10,
      at: at(2),
      ...(failure ? { failure } : {}),
    },
  ];
};

const missing = (detail: string): Failure => ({ kind: "missing-path", detail, exitCode: null });
const invalid: Failure = { kind: "invalid-input", detail: "bad field", exitCode: null };

const run = (body: Event[], end = 5, tokens = 1_000) => {
  const session: Session = {
    id: "s",
    harness: "claude-code",
    path: "/dev/null",
    cwd: null,
    parent: null,
    diagnostics: { lines: 0, unparsed: 0 },
    events: [
      { type: "message", author: "user", origin: "typed", text: "go", at: at(0) },
      {
        type: "inference",
        model: "m",
        effort: null,
        usage: { input: 0, cacheRead: tokens, cacheWrite: 0, output: 0 },
        at: at(1),
      },
      ...body,
      { type: "message", author: "assistant", origin: "unknown", text: "done", at: at(end) },
      { type: "message", author: "user", origin: "typed", text: "no", at: at(end + 1) },
    ],
  };
  return runs(session)[0]!;
};

test("the same failure three times in one run is a retry loop with its call positions", () => {
  const found = behaviour(
    run([
      ...failing("Read", missing("a.ts")),
      ...failing("Read", null),
      ...failing("Bash", missing("a.ts")),
      ...failing("Read", missing("a.ts")),
    ]),
  );
  expect(found).toEqual([
    {
      kind: "retry-loop",
      failure: "missing-path",
      what: "a.ts",
      tools: ["Read", "Bash"],
      calls: [1, 3, 4],
    },
  ]);
});

test("two repeats, different errors and unnamed exit codes are not retry loops", () => {
  const exit: Failure = { kind: "exit-code", detail: null, exitCode: 2 };
  expect(
    behaviour(run([...failing("Read", missing("a.ts")), ...failing("Read", missing("a.ts"))])),
  ).toEqual([]);
  expect(
    behaviour(
      run([
        ...failing("Read", missing("a.ts")),
        ...failing("Read", missing("b.ts")),
        ...failing("Read", missing("c.ts")),
      ]),
    ),
  ).toEqual([]);
  expect(behaviour(run([1, 2, 3].flatMap(() => failing("Bash", exit))))).toEqual([]);
  const nothingFound: Failure = { kind: "exit-code", detail: null, exitCode: 1 };
  expect(behaviour(run([1, 2, 3].flatMap(() => failing("Bash", nothingFound, "rg x"))))).toEqual(
    [],
  );
});

test("one shell command failing three times is a retry loop", () => {
  const exit: Failure = { kind: "exit-code", detail: null, exitCode: 1 };
  expect(behaviour(run([1, 2, 3].flatMap(() => failing("Bash", exit, "bun test")))).at(0)).toEqual(
    expect.objectContaining({ kind: "retry-loop", what: "bun test", calls: [1, 2, 3] }),
  );
});

test("invalid tool input fires from two calls, not one", () => {
  expect(behaviour(run(failing("Edit", invalid)))).toEqual([]);
  expect(
    behaviour(run([...failing("Edit", invalid), ...failing("Write", { ...invalid, detail: "x" })])),
  ).toEqual([{ kind: "bad-tool-input", tools: ["Edit", "Write"], calls: [1, 2] }]);
});

test("long and costly runs fire at their thresholds, not just under them", () => {
  expect(behaviour(run([], 898, 9_999_999))).toEqual([]);
  expect(behaviour(run([], 900, 10_000_000))).toEqual([
    { kind: "long-run", seconds: 900 },
    { kind: "costly-run", tokens: 10_000_000 },
  ]);
});

test("each behaviour is a yes/no bucket in the reply signals", () => {
  const looping = run([1, 2, 3].flatMap(() => failing("Read", missing("a.ts"))));
  const quiet = run([]);
  const table = signals([
    { harness: "claude-code", position: 1, run: looping, corrected: true },
    { harness: "claude-code", position: 2, run: quiet, corrected: false },
  ]);
  expect(table.find((s) => s.name === "Same failure 3+ times")?.buckets).toEqual([
    { label: "yes", replies: 1, corrections: 1 },
    { label: "no", replies: 1, corrections: 0 },
  ]);
});
