import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHILD_ENV,
  HarnessFailed,
  HarnessJudge,
  HarnessMissing,
  type Exchange,
} from "../src/index.ts";
import { ARGV, resolve, shimTarget, verdictIn } from "../src/harness.ts";
import { requests } from "../src/jev.ts";
import { fakeCalls, fakeHarnessPath } from "./fake-path.ts";

const verdict = '{"kind": "correction", "sender": "person", "confidence": 0.8}';
const exchange: Exchange = { assistantSaid: `${"a".repeat(3000)}END`, reply: "no, the other file" };

const judgeWith = async (env: Record<string, string>, timeoutMs?: number) => {
  const fake = await fakeHarnessPath();
  const judge = await HarnessJudge.create(
    { ...process.env, ...fake, CLAUDECODE: "1", FAKE_BUN: process.execPath, ...env },
    timeoutMs,
  );
  return { judge, fake, calls: () => fakeCalls(fake.FAKE_LOG) };
};

const reason = (judgment: unknown) => (judgment as HarnessFailed).reason;

test("claude reads a verdict from a stdin-only prompt that carries Jev's clipped text", async () => {
  const { judge, calls } = await judgeWith({ FAKE_ANSWER: verdict });
  expect(await judge.classify([exchange])).toEqual([
    { kind: "correction", sender: "person", confidence: 0.8 },
  ]);
  const [call] = await calls();
  const clipped = requests(exchange).kind.state;
  expect(call?.stdin).toContain(`<agent_said>\n${clipped.assistant_said}\n</agent_said>`);
  expect(call?.stdin).not.toContain("a".repeat(1501));
  expect(call?.stdin).toContain(`<reply>\n${clipped.user_reply}\n</reply>`);
  expect(call?.argv).toEqual(ARGV);
  expect([call?.child, call?.claudecode]).toEqual(["1", null]);
  expect(readdirSync(tmpdir()).filter((d) => d.startsWith("quench-classify-"))).toEqual([]);
});

test("claude loads no user settings, instructions, MCP servers, hooks, tools or commands", () => {
  const flag = (name: string) => ARGV[ARGV.indexOf(name) + 1];
  expect(flag("--setting-sources")).toBe("");
  expect(flag("--tools")).toBe("");
  expect(flag("--settings")).toBe('{"disableAllHooks":true,"autoMemoryEnabled":false}');
  expect(ARGV).toContain("--strict-mcp-config");
  expect(ARGV).toContain("--disable-slash-commands");
  expect(ARGV).toContain("--no-session-persistence");
  expect(ARGV).toContain("--system-prompt");
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

test("prose answers and missing result envelopes are unparseable failures, never verdicts", async () => {
  const prose = await judgeWith({
    FAKE_ANSWER: `I refuse. Example only: ${verdict} DO NOT USE THIS`,
  });
  expect(reason((await prose.judge.classify([exchange]))[0])).toBe("unparseable");
  const raw = await judgeWith({ FAKE_MODE: "raw", FAKE_ANSWER: verdict });
  expect(reason((await raw.judge.classify([exchange]))[0])).toBe("unparseable");
});

test("a failed exit is typed and stops the remaining calls", async () => {
  const { judge, calls } = await judgeWith({ FAKE_MODE: "exit" });
  const failed = await judge.classify([exchange, exchange, exchange, exchange, exchange]);
  expect(failed.every((f) => reason(f) === "exit")).toBe(true);
  expect((failed[0] as Error).message).toContain("not logged in");
  expect((await calls()).length).toBeLessThan(5);
});

test("one deadline covers a child that never exits", async () => {
  const { judge } = await judgeWith({ FAKE_MODE: "slow" }, 200);
  const started = Date.now();
  expect(reason((await judge.classify([exchange]))[0])).toBe("timeout");
  expect(Date.now() - started).toBeLessThan(1_500);
});

test("a descendant holding stdout open times out, and the process tree is killed", async () => {
  const marker = join(await mkdtemp(join(tmpdir(), "quench-linger-")), "survived");
  const { judge } = await judgeWith(
    { FAKE_MODE: "linger", FAKE_ANSWER: verdict, FAKE_MARKER: marker },
    process.platform === "win32" ? 800 : 400,
  );
  const started = Date.now();
  expect(reason((await judge.classify([exchange]))[0])).toBe("timeout");
  expect(Date.now() - started).toBeLessThan(2_000);
  await Bun.sleep(3_000 - (Date.now() - started));
  if (process.platform !== "win32") expect(existsSync(marker)).toBe(false);
}, 10_000);

test("a CLI that disappears after resolution fails per exchange instead of rejecting the batch", async () => {
  const { judge, fake } = await judgeWith({ FAKE_ANSWER: verdict });
  await rm(fake.dir, { recursive: true, force: true, maxRetries: 5 });
  const results = await judge.classify([exchange, exchange]);
  expect(results.map(reason)).toEqual(["spawn", "spawn"]);
});

test("a missing CLI or a nested classifier run is refused before anything runs", async () => {
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

test("an npm claude.cmd shim resolves to its claude.exe, never to cmd.exe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quench-shim-"));
  const bin = join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin");
  await mkdir(bin, { recursive: true });
  await Bun.write(join(bin, "claude.exe"), "");
  const shim = join(dir, "claude.cmd");
  await Bun.write(
    shim,
    '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n',
  );
  expect(await shimTarget(shim)).toBe(join(bin, "claude.exe"));
  await chmod(shim, 0o755);
  expect(await resolve(dir, "win32")).toBe(join(bin, "claude.exe"));
  await Bun.write(shim, '@node "%~dp0\\node_modules\\x\\cli.js" %*\r\n');
  expect(await shimTarget(shim)).toBeNull();
});
