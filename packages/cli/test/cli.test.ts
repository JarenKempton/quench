import { expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const home = join(root, "packages/history/test/fixtures/home");

async function quench(...args: string[]) {
  const proc = Bun.spawn(["bun", join(root, "packages/cli/src/main.ts"), ...args], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: "",
      CODEX_HOME: "",
      PI_CODING_AGENT_DIR: "",
      TYPESAFE_API_KEY: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

test("report --json totals each harness found in the home", async () => {
  const { stdout, code } = await quench("report", "--days", "36500", "--json");
  expect(code).toBe(0);
  const out = JSON.parse(stdout);
  expect(
    out.harnesses.map((h: { harness: string; sessions: number }) => [h.harness, h.sessions]),
  ).toEqual([
    ["claude-code", 1],
    ["codex", 1],
    ["pi", 1],
  ]);
  expect(out.unreadable).toBe(0);
});

test("runs shows each prompt, what the agent did, and the reply", async () => {
  const { stdout, code } = await quench("runs", join(home, ".claude/projects/-work-demo/s1.jsonl"));
  expect(code).toBe(0);
  expect(stdout).toContain('#1   "Add a health check endpoint"');
  expect(stdout).toContain("1 tool error · 1 subagent · 1 compaction");
  expect(stdout).toContain('→  "/review now"');
});

test("corrections asks for a key before sending anything, and a dry run counts what it would send", async () => {
  const noKey = await quench("corrections");
  expect(noKey.code).toBe(2);
  expect(noKey.stderr).toContain("Set TYPESAFE_API_KEY to opt in");

  const dry = await quench("corrections", "--days", "36500", "--dry-run", "--json");
  expect(dry.code).toBe(0);
  const out = JSON.parse(dry.stdout);
  expect([out.pending, out.newlyJudged, out.tokens]).toEqual([1, 0, null]);
  expect(await Bun.file(join(home, ".quench")).exists()).toBe(false);
});

test("unknown commands and bad input fail with a message", async () => {
  expect((await quench("frobnicate")).code).toBe(1);
  expect((await quench("report", "--days", "zero")).stderr).toContain(
    "--days must be a positive number",
  );
  expect((await quench("runs", "/nope.jsonl")).stderr).toContain("does not exist");
});
