import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHILD_ENV,
  HarnessFailed,
  HarnessJudge,
  HarnessMissing,
  type Exchange,
} from "../src/index.ts";
import { requests } from "../src/jev.ts";
import { fakeCalls, fakeHarnessPath } from "./fake-path.ts";

const verdict = '{"kind": "correction", "sender": "person", "confidence": 0.8}';
const exchange: Exchange = { assistantSaid: `${"a".repeat(3000)}END`, reply: "no, the other file" };

const judgeWith = async (
  name: "claude" | "codex",
  env: Record<string, string>,
  timeoutMs?: number,
) => {
  const fake = await fakeHarnessPath();
  const judge = HarnessJudge.create(
    name,
    { ...process.env, ...fake, CLAUDECODE: "1", ...env },
    timeoutMs,
  );
  return { judge, calls: () => fakeCalls(fake.FAKE_LOG) };
};

test.each(["claude", "codex"] as const)(
  "%s reads a verdict from stdin-only prompts that carry Jev's clipped text",
  async (name) => {
    const { judge, calls } = await judgeWith(name, { FAKE_ANSWER: `Sure:\n${verdict}` });
    expect(await judge.classify([exchange])).toEqual([
      { kind: "correction", sender: "person", confidence: 0.8 },
    ]);
    const [call] = await calls();
    const clipped = requests(exchange).kind.state;
    expect(call?.stdin).toContain(`<agent_said>\n${clipped.assistant_said}\n</agent_said>`);
    expect(call?.stdin).not.toContain("a".repeat(1501));
    expect(call?.stdin).toContain(`<reply>\n${clipped.user_reply}\n</reply>`);
    expect(call?.argv).toContain(name === "claude" ? "--no-session-persistence" : "--ephemeral");
    expect(call?.argv.join(" ")).not.toContain("other file");
    expect([call?.child, call?.claudecode]).toEqual(["1", null]);
    expect(readdirSync(tmpdir()).filter((d) => d.startsWith("quench-classify-"))).toEqual([]);
  },
);

test("claude runs with no tools, no MCP servers and no hooks", async () => {
  const { judge, calls } = await judgeWith("claude", { FAKE_ANSWER: verdict });
  await judge.classify([exchange]);
  const [call] = await calls();
  expect(call?.argv).toEqual([
    "-p",
    "--no-session-persistence",
    "--model",
    "haiku",
    "--output-format",
    "json",
    "--tools",
    "",
    "--strict-mcp-config",
    "--settings",
    '{"disableAllHooks":true,"autoMemoryEnabled":false}',
  ]);
});

test("unparseable answers, timeouts and failed exits are typed failures, not verdicts", async () => {
  const garbage = await judgeWith("claude", { FAKE_MODE: "garbage" });
  const [unparsed] = await garbage.judge.classify([exchange]);
  expect(unparsed).toBeInstanceOf(HarnessFailed);
  expect((unparsed as HarnessFailed).reason).toBe("unparseable");

  const outOfRange = await judgeWith("codex", {
    FAKE_ANSWER: '{"kind": "correction", "sender": "person", "confidence": 7}',
  });
  expect(((await outOfRange.judge.classify([exchange]))[0] as HarnessFailed).reason).toBe(
    "unparseable",
  );

  const slow = await judgeWith("codex", { FAKE_MODE: "slow" }, 200);
  expect(((await slow.judge.classify([exchange]))[0] as HarnessFailed).reason).toBe("timeout");

  const failing = await judgeWith("claude", { FAKE_MODE: "exit" });
  const failed = await failing.judge.classify([exchange, exchange, exchange, exchange, exchange]);
  expect(failed.every((f) => f instanceof HarnessFailed && f.reason === "exit")).toBe(true);
  expect((failed[0] as Error).message).toContain("not logged in");
  expect((await failing.calls()).length).toBeLessThan(5);
});

test("a missing CLI or a nested classifier run is refused before anything runs", async () => {
  const empty = await mkdtemp(join(tmpdir(), "quench-empty-path-"));
  expect(() => HarnessJudge.create("codex", { PATH: empty })).toThrow(HarnessMissing);
  const fake = await fakeHarnessPath();
  expect(() => HarnessJudge.create("claude", { ...fake, [CHILD_ENV]: "1" })).toThrow(
    "already running inside a classifier call",
  );
  expect(HarnessJudge.idOf("claude")).not.toBe(HarnessJudge.idOf("codex"));
});
