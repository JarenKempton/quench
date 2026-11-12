import { expect, test } from "bun:test";
import type { Event, Session } from "@quench/history";
import { runs } from "@quench/insights";
import type { Reply } from "@quench/judge";
import { spiralTasks } from "../src/commands/spiral-tasks.ts";
import type { Run } from "../src/commands/github-pulls.ts";

const at = (session: number, turn: number, secs = 0) =>
  new Date(Date.UTC(2026, 9, 20, 10, session * 10 + turn, secs));

const session = (n: number) => {
  const id = `s${n}`;
  const events: Event[] = [0, 1, 2, 3].flatMap((turn): Event[] => [
    { type: "message", author: "user", origin: "typed", text: `step ${turn}`, at: at(n, turn) },
    {
      type: "inference",
      model: "m",
      effort: null,
      usage: { context: 1, input: 0, cacheRead: 1, cacheWrite: 0, output: 0 },
      at: at(n, turn, 1),
    },
    {
      type: "tool_call",
      id: `${id}-${turn}`,
      name: "Bash",
      at: at(n, turn, 1),
      shell: [{ command: "gh pr view 7", workdir: null }],
    },
    { type: "tool_result", callId: `${id}-${turn}`, isError: false, chars: 1, at: at(n, turn, 2) },
    { type: "message", author: "assistant", origin: "typed", text: "done", at: at(n, turn, 30) },
  ]);
  const s: Session = {
    id,
    harness: "claude-code",
    path: `/dev/null/${id}`,
    cwd: `/work/${id}`,
    branch: "main",
    parent: null,
    events,
    diagnostics: { lines: events.length, unparsed: 0 },
  };
  return { id, path: s.path, harness: s.harness, cwd: s.cwd, branch: s.branch, runs: runs(s) };
};

const reply = (s: ReturnType<typeof session>, position: number, kind: Reply["kind"]): Reply => ({
  sessionId: s.id,
  path: s.path,
  harness: s.harness,
  cwd: s.cwd,
  position,
  run: s.runs[position]!,
  kind,
  sender: "person",
  senderSource: "harness",
  classified: "cached",
});

test("Spiral tasks join on bare gh markers through each session's repo, with bounded lookups", async () => {
  const sessions = Array.from({ length: 20 }, (_, i) => session(i));
  let inFlight = 0;
  let peak = 0;
  const looked: string[] = [];
  const exec: Run = async (command) => {
    looked.push(command[2]!);
    peak = Math.max(peak, ++inFlight);
    await Bun.sleep(1);
    inFlight--;
    return "git@github.com:Acme/Widget.git\n";
  };
  const found = await spiralTasks(
    sessions,
    [1, 2, 3].map((p) => reply(sessions[0]!, p, "correction")),
    exec,
  );
  expect(looked).toEqual(sessions.map((s) => s.cwd!));
  expect(peak).toBeLessThanOrEqual(4);
  expect(found.failed).toHaveLength(1);
  expect(found.task(reply(sessions[19]!, 1, "info"))).toBe(found.failed[0]!.taskId);
});
