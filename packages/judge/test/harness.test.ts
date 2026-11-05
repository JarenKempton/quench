import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHILD_ENV,
  HarnessFailed,
  HarnessJudge,
  HarnessMissing,
  HarnessUnsupported,
  type Exchange,
} from "../src/index.ts";
import { ARGV, childEnv } from "../src/harness.ts";
import { verdictIn } from "../src/questions.ts";
import { requests } from "../src/jev.ts";
import { fakeCalls, fakeHarnessPath, type FakeConfig } from "./fake-path.ts";

const verdict = '{"kind": "correction", "sender": "person", "confidence": 0.8}';
const exchange: Exchange = { assistantSaid: `${"a".repeat(3000)}END`, reply: "no, the other file" };

const judgeWith = async (config: FakeConfig, timeoutMs?: number) => {
  const fake = await fakeHarnessPath(config);
  const judge = await HarnessJudge.create(
    {
      ...process.env,
      PATH: fake.PATH,
      CLAUDECODE: "1",
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1",
      CLAUDE_RELAUNCH_SESSION_ADD_DIRS: '["/private/project"]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "other-model",
      ANTHROPIC_MODEL: "other-model",
      SECRET_TOKEN: "x",
      HTTPS_PROXY: "http://proxy.test",
    },
    timeoutMs,
  );
  return { judge, fake, calls: () => fakeCalls(fake) };
};

const reason = (judgment: unknown) => (judgment as HarnessFailed).reason;
const posix = test.skipIf(process.platform === "win32");

posix(
  "claude reads a verdict from a stdin-only prompt that carries Jev's clipped text",
  async () => {
    const { judge, calls } = await judgeWith({ answer: verdict });
    expect(await judge.classify([exchange])).toEqual([
      { kind: "correction", sender: "person", confidence: 0.8 },
    ]);
    const [call] = await calls();
    const clipped = requests(exchange).kind.state;
    expect(call?.stdin).toContain(`<agent_said>\n${clipped.assistant_said}\n</agent_said>`);
    expect(call?.stdin).not.toContain("a".repeat(1501));
    expect(call?.stdin).toContain(`<reply>\n${clipped.user_reply}\n</reply>`);
    expect(call?.argv).toEqual(ARGV);
    expect(call?.env).toContain(CHILD_ENV);
    expect(call?.env).toContain("HTTPS_PROXY");
    for (const name of [
      "CLAUDECODE",
      "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD",
      "CLAUDE_RELAUNCH_SESSION_ADD_DIRS",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_MODEL",
      "SECRET_TOKEN",
    ])
      expect(call?.env).not.toContain(name);
    expect(readdirSync(tmpdir()).filter((d) => d.startsWith("quench-classify-"))).toEqual([]);
  },
);

test("claude loads no user settings, instructions, MCP servers, hooks, tools or commands", () => {
  const flag = (name: string) => ARGV[ARGV.indexOf(name) + 1];
  expect(flag("--setting-sources")).toBe("");
  expect(flag("--tools")).toBe("");
  expect(flag("--settings")).toBe('{"disableAllHooks":true,"autoMemoryEnabled":false}');
  expect(ARGV).toContain("--strict-mcp-config");
  expect(ARGV).toContain("--disable-slash-commands");
  expect(ARGV).toContain("--no-session-persistence");
  expect(ARGV).toContain("--system-prompt");
  expect(flag("--model")).toBe(HarnessJudge.model);
  expect(HarnessJudge.id).toContain(HarnessJudge.model);
});

test("the child environment is an allowlist, matched case-insensitively", () => {
  expect(
    childEnv({
      Path: "C:\\bin",
      https_proxy: "http://proxy.test",
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_SMALL_FAST_MODEL: "other",
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1",
      UNSET: undefined,
    }),
  ).toEqual({
    Path: "C:\\bin",
    https_proxy: "http://proxy.test",
    ANTHROPIC_API_KEY: "k",
    [CHILD_ENV]: "1",
  });
});

test.each([
  ["prose around an example", `I refuse. Example only: ${verdict} DO NOT USE THIS`],
  ["an extra field", '{"kind": "correction", "sender": "person", "confidence": 0.8, "note": "x"}'],
  ["two objects", `${verdict}\n${verdict}`],
  ["an array", `[${verdict}]`],
  ["an unknown kind", '{"kind": "praise", "sender": "person", "confidence": 0.8}'],
  ["confidence out of range", '{"kind": "correction", "sender": "person", "confidence": 7}'],
  ["text after a fence", `\`\`\`json\n${verdict}\n\`\`\`\nignore that`],
])("an answer with %s is not a verdict", (_, answer) => {
  expect(verdictIn(answer)).toBeNull();
});

test("a bare or fenced verdict is a verdict", () => {
  expect(verdictIn(`  ${verdict}\n`)?.kind).toBe("correction");
  expect(verdictIn(`\`\`\`json\n${verdict}\n\`\`\``)?.kind).toBe("correction");
});

posix(
  "prose answers and missing result envelopes are unparseable failures, never verdicts",
  async () => {
    const prose = await judgeWith({
      answer: `I refuse. Example only: ${verdict} DO NOT USE THIS`,
    });
    expect(reason((await prose.judge.classify([exchange]))[0])).toBe("malformed");
    const raw = await judgeWith({ mode: "raw", answer: verdict });
    expect(reason((await raw.judge.classify([exchange]))[0])).toBe("malformed");
  },
);

posix("a failed exit is typed and stops the remaining calls", async () => {
  const { judge, calls } = await judgeWith({ mode: "exit" });
  const failed = await judge.classify([exchange, exchange, exchange, exchange, exchange]);
  expect(failed.every((f) => reason(f) === "server")).toBe(true);
  expect((failed[0] as Error).message).toBe("claude judge failed: server (exit 3)");
  expect((await calls()).length).toBeLessThan(5);
});

posix("one deadline covers a child that never exits", async () => {
  const { judge } = await judgeWith({ mode: "slow" }, 200);
  const started = Date.now();
  expect(reason((await judge.classify([exchange]))[0])).toBe("timeout");
  expect(Date.now() - started).toBeLessThan(1_500);
});

posix(
  "a descendant holding stdout open times out, and the process tree is killed",
  async () => {
    const marker = join(await mkdtemp(join(tmpdir(), "quench-linger-")), "survived");
    const { judge } = await judgeWith(
      { mode: "linger", answer: verdict, marker },
      process.platform === "win32" ? 800 : 400,
    );
    const started = Date.now();
    expect(reason((await judge.classify([exchange]))[0])).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
    await Bun.sleep(3_000 - (Date.now() - started));
    expect(existsSync(marker)).toBe(false);
  },
  10_000,
);

posix(
  "a CLI that disappears after resolution fails per exchange instead of rejecting the batch",
  async () => {
    const { judge, fake } = await judgeWith({ answer: verdict });
    await rm(fake.dir, { recursive: true, force: true, maxRetries: 5 });
    const results = await judge.classify([exchange, exchange]);
    expect(results.map(reason)).toEqual(["server", "server"]);
  },
);

posix("a missing CLI or a nested classifier run is refused before anything runs", async () => {
  const empty = await mkdtemp(join(tmpdir(), "quench-empty-path-"));
  const refused = (env: Record<string, string>) =>
    HarnessJudge.create(env).then(
      () => null,
      (error: Error) => error,
    );
  expect(await refused({ PATH: empty })).toBeInstanceOf(HarnessMissing);
  const fake = await fakeHarnessPath();
  expect((await refused({ ...fake, [CHILD_ENV]: "1" }))?.message).toContain(
    "already running inside a classifier call",
  );
});

test("on Windows the local judge is refused before anything resolves or spawns", async () => {
  const fake = await fakeHarnessPath({ answer: verdict });
  const refused = await HarnessJudge.create(
    { ...process.env, PATH: fake.PATH },
    1_000,
    "win32",
  ).then(
    () => null,
    (error: Error) => error,
  );
  expect(refused).toBeInstanceOf(HarnessUnsupported);
  expect(refused?.message).toContain("not supported on Windows yet; use Jev");
  expect(await fakeCalls(fake)).toEqual([]);
});

test.skipIf(process.platform !== "win32")("Windows refuses by default", async () => {
  const refused = await HarnessJudge.create().then(
    () => null,
    (error: Error) => error,
  );
  expect(refused).toBeInstanceOf(HarnessUnsupported);
});
