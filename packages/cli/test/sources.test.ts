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

test("sources traces Pi read output without inventing result paths or line ranges", async () => {
  const { home } = await fixture([]);
  const path = join(home, ".pi/agent/sessions/demo/session.jsonl");
  const requested = { path: "docs/guide.md", offset: 4, limit: 1 };
  const output = "Historical rule 🧭\n\n[10 more lines in file. Use offset=5 to continue.]";
  const piCall = (id: string, name = "read", args: unknown = requested) => ({
    type: "message",
    timestamp: stamp,
    message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
  });
  const piResult = (id: string, extra: Record<string, unknown> = {}) => ({
    type: "message",
    timestamp: stamp,
    message: {
      role: "toolResult",
      toolCallId: id,
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: output }],
      ...extra,
    },
  });
  await Bun.write(
    path,
    [
      { type: "session", id: "pi-source", cwd: "/historical/project" },
      piCall("docs"),
      piResult("docs"),
      piCall("empty", "read", { path: "empty.md", offset: null, limit: null }),
      piResult("empty", { content: [{ type: "text", text: "" }] }),
      piCall("failed"),
      piResult("failed", { isError: true }),
      piCall("missing"),
      piCall("image"),
      piResult("image", { content: [{ type: "image", data: "unused" }] }),
      piCall("mixed"),
      piResult("mixed", { content: [{ type: "text", text: output }, { type: "image" }] }),
      piCall("malformed"),
      piResult("malformed", { content: [{ type: "text", text: 42 }] }),
      piCall("wrong-tool"),
      piResult("wrong-tool", { toolName: "bash" }),
      piCall("uncertain"),
      piResult("uncertain", { isError: null }),
      piCall("mcp", "mcp__read"),
      piResult("mcp", { toolName: "mcp__read" }),
      piCall("invalid", "read", { ...requested, offset: -1 }),
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  const before = await Bun.file(path).text();
  const result = await run(home, path, "--json");
  expect(result.code).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.coverage).toEqual({
    nativeFileReads: "supported",
    otherToolCalls: 2,
    unmatchedFileResults: 0,
    unparsedRecords: 0,
    injectedInstructions: "unrecorded",
    unreadableInstructions: 0,
  });
  expect(report.reads[0]).toMatchObject({
    callId: "docs",
    requested,
    status: "returned",
    returned: {
      path: null,
      startLine: null,
      lineCount: null,
      totalLines: null,
      returnedTextChars: output.length,
      returnedTextSha256: new Bun.CryptoHasher("sha256").update(output).digest("hex"),
    },
  });
  expect(report.reads[1].returned.returnedTextChars).toBe(0);
  expect(report.reads[1].requested).toEqual({ path: "empty.md", offset: null, limit: null });
  expect(report.reads.map((read: { status: string }) => read.status)).toEqual([
    "returned",
    "returned",
    "failed",
    "missing-result",
    "unknown",
    "unknown",
    "unknown",
    "unknown",
    "unknown",
  ]);
  const text = await run(home, path);
  expect(text.code).toBe(0);
  expect(text.stdout).toContain("returned · docs/guide.md");
  expect(text.stdout).toContain("result path unknown · line range unknown");
  expect(text.stdout).not.toContain("0 reported lines");
  expect(await Bun.file(path).text()).toBe(before);
  expect(await Bun.file(join(home, ".quench")).exists()).toBe(false);
});

test("sources reports instructions each harness recorded as injected, without reading today's files", async () => {
  const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
  const global = "# Personal\n\n- Ask before publishing.";
  const nested = "- Keep admin changes small.";
  const { home, path } = await fixture([
    {
      type: "attachment",
      timestamp: stamp,
      attachment: {
        type: "instructions",
        files: [
          { path: "/historical/home/.claude/CLAUDE.md", type: "User", content: global },
          { path: "/historical/project/CLAUDE.md", type: "Project", content: "" },
          { path: 42, type: "Project", content: "malformed" },
        ],
      },
    },
    {
      type: "attachment",
      timestamp: "2026-10-22T10:05:00Z",
      attachment: {
        type: "nested_memory",
        path: "/historical/project/admin/CLAUDE.md",
        content: {
          path: "/historical/project/admin/CLAUDE.md",
          type: "Project",
          content: nested,
          contentDiffersFromDisk: true,
        },
      },
    },
    { type: "attachment", timestamp: stamp, attachment: { type: "skill_listing", content: "x" } },
  ]);
  const out = await run(home, path, "--json");
  expect(out.code).toBe(0);
  const report = JSON.parse(out.stdout);
  expect(report.coverage.injectedInstructions).toBe("per-file");
  expect(report.coverage.unparsedRecords).toBe(0);
  expect(report.instructions).toEqual([
    {
      at: "2026-10-22T10:00:00.000Z",
      path: "/historical/home/.claude/CLAUDE.md",
      directory: null,
      label: "User",
      textSha256: sha(global),
      textChars: global.length,
      differsFromDisk: null,
    },
    {
      at: "2026-10-22T10:00:00.000Z",
      path: "/historical/project/CLAUDE.md",
      directory: null,
      label: "Project",
      textSha256: sha(""),
      textChars: 0,
      differsFromDisk: null,
    },
    {
      at: "2026-10-22T10:05:00.000Z",
      path: "/historical/project/admin/CLAUDE.md",
      directory: null,
      label: "Project",
      textSha256: sha(nested),
      textChars: nested.length,
      differsFromDisk: true,
    },
  ]);
  expect(report.warnings.join(" ")).toContain("1 recorded instruction entry");
  const text = await run(home, path);
  expect(text.stdout).toContain("Injected instructions: per-file · 3 recorded");
  expect(text.stdout).toContain(
    "/historical/project/admin/CLAUDE.md · Project · differs from disk at the time",
  );

  const codex = join(home, ".codex/sessions/2026/10/22/rollout.jsonl");
  const block = "# Personal\n\n- Ask before publishing.\n\n--- project-doc ---\n\n- Run checks.";
  const message = (text: string) => ({
    type: "response_item",
    timestamp: stamp,
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  });
  await Bun.write(
    codex,
    [
      {
        type: "session_meta",
        timestamp: stamp,
        payload: { id: "codex", cwd: "/historical/project" },
      },
      message(
        `# AGENTS.md instructions for /historical/project\n\n<INSTRUCTIONS>\n${block}\n</INSTRUCTIONS>`,
      ),
      {
        type: "response_item",
        timestamp: stamp,
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "<recommended_plugins>\nnone\n</recommended_plugins>" },
            {
              type: "input_text",
              text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nOlder header.\n</INSTRUCTIONS>",
            },
            {
              type: "input_text",
              text: "<environment_context>\n  <cwd>/historical/project</cwd>\n</environment_context>",
            },
          ],
        },
      },
      message("# AGENTS.md instructions for /historical/project\n\nno closing tag"),
      message("Please mention # AGENTS.md instructions for /x <INSTRUCTIONS>a</INSTRUCTIONS>"),
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  const combined = JSON.parse((await run(home, codex, "--json")).stdout);
  expect(combined.coverage.injectedInstructions).toBe("combined");
  expect(combined.instructions).toEqual([
    {
      at: "2026-10-22T10:00:00.000Z",
      path: null,
      directory: "/historical/project",
      label: "AGENTS.md instructions",
      textSha256: sha(block),
      textChars: block.length,
      differsFromDisk: null,
    },
    {
      at: "2026-10-22T10:00:00.000Z",
      path: null,
      directory: null,
      label: "AGENTS.md instructions",
      textSha256: sha("Older header."),
      textChars: "Older header.".length,
      differsFromDisk: null,
    },
  ]);
  expect(combined.warnings.join(" ")).toContain("1 recorded instruction entry");
  expect(combined.limitations.join(" ")).toContain("combined");

  const pi = join(home, ".pi/agent/sessions/demo/session.jsonl");
  await Bun.write(
    pi,
    JSON.stringify({ type: "session", id: "pi", cwd: "/historical/project" }) + "\n",
  );
  const none = JSON.parse((await run(home, pi, "--json")).stdout);
  expect(none.coverage.injectedInstructions).toBe("unrecorded");
  expect(none.instructions).toEqual([]);
  expect(none.warnings.join(" ")).toContain("does not record injected instructions");
  expect(await Bun.file(join(home, ".quench")).exists()).toBe(false);
});
