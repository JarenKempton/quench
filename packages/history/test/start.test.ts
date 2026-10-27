import { expect, test } from "bun:test";
import { startingContext, type Event, type Session } from "../src/index.ts";

const session = (events: Event[]): Session => ({
  id: "s",
  harness: "claude-code",
  path: "/dev/null",
  cwd: null,
  parent: null,
  events,
  diagnostics: { lines: events.length, unparsed: 0 },
});
const tool = (name: string, server: string | null, chars: number, deferred = false) => ({
  name,
  server,
  chars,
  deferred,
});

test("starting context splits what the first request carried, by source", () => {
  const start = startingContext(
    session([
      { type: "deferred_tools", names: ["mcp__b__z"], chars: 9, at: null },
      { type: "instructions", files: [], unreadable: 0, at: null },
      {
        type: "prompt",
        system: 100,
        tools: [
          tool("Read", null, 40),
          tool("mcp__a__x", "a", 30),
          tool("mcp__a__y", "a", 20),
          tool("mcp__b__z", "b", 50),
          tool("ToolSearch", null, 70, true),
        ],
        at: null,
      },
      {
        type: "inference",
        model: null,
        effort: null,
        usage: { input: 5, cacheRead: 90, cacheWrite: 5, output: 1 },
        at: null,
      },
      { type: "prompt", system: 999, tools: [], at: null },
    ]),
  );
  expect(start).toEqual({
    tokens: 100,
    parts: [
      { kind: "system", chars: 100 },
      { kind: "tools", count: 1, chars: 40 },
      { kind: "mcp_tools", server: "a", count: 2, chars: 50 },
      { kind: "deferred_tools", count: 1, chars: 9 },
      { kind: "instructions", files: 0, chars: 0 },
    ],
    unrecorded: [],
  });
});

test("a session without a recorded request says which parts are missing", () => {
  expect(startingContext(session([])).unrecorded).toEqual(["system", "tools", "mcp_tools"]);
});
