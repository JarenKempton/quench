import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = join(import.meta.dir, "../src/main.ts");
const stamp = "2026-10-22T10:00:00Z";
const call = (id: string, name: string, input: unknown) => ({
  type: "assistant",
  timestamp: stamp,
  cwd: "/historical/project",
  message: { content: [{ type: "tool_use", id, name, input }] },
});
const result = (id: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "user",
  timestamp: stamp,
  message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: false }] },
  ...extra,
});
const metadata = (path: string) => ({
  type: "text",
  file: {
    filePath: path,
    content: "Historical instructions.",
    startLine: 5,
    numLines: 1,
    totalLines: 20,
  },
});

async function fixture(rows: unknown[]) {
  const home = await mkdtemp(join(tmpdir(), "quench-sources-"));
  const dir = join(home, ".claude/projects/demo");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "session.jsonl");
  await Bun.write(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { home, path };
}

async function run(home: string, ...args: string[]) {
  const proc = Bun.spawn(["bun", main, "sources", ...args], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: "",
      CODEX_HOME: "",
      PI_CODING_AGENT_DIR: "",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      TYPESAFE_API_KEY: "must-not-be-used",
      TYPESAFE_BASE_URL: "http://127.0.0.1:1",
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

test("sources traces recorded document reads without consulting today's source files", async () => {
  const source = "/historical/project/docs/arbitrary-guide.md";
  const returnedText = "     5→Historical instructions.";
  const { home, path } = await fixture([
    call("docs", "Read", { file_path: source, offset: 5, limit: 1 }),
    result("docs", returnedText, { toolUseResult: metadata(source) }),
    call("shell", "Bash", { command: "cat README.md" }),
    result("shell", "Not attributed from command text."),
  ]);
  const before = await Bun.file(path).text();
  const json = await run(home, path, "--json");
  expect(json.code).toBe(0);
  const out = JSON.parse(json.stdout);
  expect(out.evidence).toBe("session-history");
  expect(out.session).toMatchObject({ path, harness: "claude-code", cwd: "/historical/project" });
  expect(out.coverage).toMatchObject({
    nativeFileReads: "supported",
    otherToolCalls: 1,
    unmatchedFileResults: 0,
  });
  expect(out.reads).toHaveLength(1);
  expect(out.reads[0]).toMatchObject({
    callId: "docs",
    status: "returned",
    requested: { path: source, offset: 5, limit: 1 },
    returned: {
      path: source,
      startLine: 5,
      lineCount: 1,
      totalLines: 20,
      returnedTextChars: returnedText.length,
      returnedTextSha256: new Bun.CryptoHasher("sha256").update(returnedText).digest("hex"),
    },
  });
  const text = await run(home, path);
  expect(text.stdout).toContain("Recorded file reads");
  expect(text.stdout).toContain(source);
  expect(text.stdout).toContain("reported lines 5–5 of 20");
  expect(text.stdout).toContain("Shell/MCP reads");
  expect(await Bun.file(path).text()).toBe(before);
  expect(await Bun.file(join(home, ".quench")).exists()).toBe(false);
  await rename(join(home, ".claude"), join(home, "store"));
  await symlink("store", join(home, ".claude"));
  for (const alias of [path, join(home, "store/projects/demo/session.jsonl")]) {
    const aliased = await run(home, alias, "--json");
    expect(aliased.code).toBe(0);
    expect(JSON.parse(aliased.stdout).reads).toEqual(out.reads);
  }
});

test("sources distinguishes failed, missing, ambiguous and unverified reads", async () => {
  const pathName = "/historical/project/README.md";
  const input = { file_path: pathName };
  const { home, path } = await fixture([
    call("failed", "Read", input),
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "failed", content: "Not found", is_error: true },
        ],
      },
      toolUseResult: metadata(pathName),
    },
    call("missing", "Read", input),
    call("unknown", "Read", input),
    result("unknown", "Some unverified text"),
    call("alias", "mcp__read", input),
    result("alias", "Not a native read", { toolUseResult: metadata(pathName) }),
    call("duplicate", "Read", input),
    call("duplicate", "Read", input),
    result("duplicate", "Ambiguous", { toolUseResult: metadata(pathName) }),
    result("early", "Out of order", { toolUseResult: metadata(pathName) }),
    call("early", "Read", input),
    call("many", "Read", input),
    result("many", "One", { toolUseResult: metadata(pathName) }),
    result("many", "Two", { toolUseResult: metadata(pathName) }),
    call("malformed", "Read", input),
    result("malformed", "Bad metadata", {
      toolUseResult: { type: "text", file: { filePath: pathName, startLine: "five" } },
    }),
    call("range", "Read", input),
    result("range", "Inconsistent range", {
      toolUseResult: {
        type: "text",
        file: { filePath: pathName, startLine: 5, numLines: 10, totalLines: 6 },
      },
    }),
    result("orphan", "No call", { toolUseResult: metadata(pathName) }),
  ]);
  const outcome = await run(home, path, "--json");
  expect(outcome.code).toBe(0);
  const out = JSON.parse(outcome.stdout);
  expect(out.reads.map((r: { status: string }) => r.status)).toEqual([
    "failed",
    "missing-result",
    "unknown",
    "unknown",
    "unknown",
    "unknown",
    "unknown",
    "unknown",
    "unknown",
  ]);
  expect(out.reads.every((r: { returned: unknown }) => r.returned === null)).toBe(true);
  expect(out.coverage.otherToolCalls).toBe(1);
  expect(out.coverage.unmatchedFileResults).toBeGreaterThan(0);
  expect(out.warnings.length).toBeGreaterThan(0);
});

test("sources reports unsupported adapters and invalid input explicitly", async () => {
  const { home, path } = await fixture([]);
  const codex = join(home, ".codex/sessions/test.jsonl");
  await Bun.write(
    codex,
    JSON.stringify({ type: "session_meta", payload: { id: "codex", cwd: "/historical/project" } }) +
      "\n",
  );
  const out = await run(home, codex, "--json");
  expect(out.code).toBe(0);
  expect(JSON.parse(out.stdout).coverage.nativeFileReads).toBe("unsupported");
  expect(JSON.parse(out.stdout).warnings.join(" ")).toContain("does not yet trace");
  expect((await run(home)).code).toBe(1);
  expect((await run(home, path, "extra")).code).toBe(1);
  expect((await run(home, join(home, "missing"))).code).toBe(1);
  const unknown = join(home, "unrecognized.jsonl");
  await Bun.write(unknown, "{}\n");
  expect((await run(home, unknown)).code).toBe(1);
});
