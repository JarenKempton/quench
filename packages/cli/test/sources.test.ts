import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rename, symlink, utimes } from "node:fs/promises";
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
    result("shell", "# Readme"),
  ]);
  const before = await Bun.file(path).text();
  const json = await run(home, path, "--json");
  expect(json.code).toBe(0);
  const out = JSON.parse(json.stdout);
  expect(out.evidence).toBe("session-history");
  expect(out.session).toMatchObject({ path, harness: "claude-code", cwd: "/historical/project" });
  expect(out.coverage).toMatchObject({
    nativeFileReads: "supported",
    otherToolCalls: 0,
    shellCommands: 1,
    unmatchedFileResults: 0,
  });
  expect(out.shell).toMatchObject([
    {
      program: "cat",
      path: "/historical/project/README.md",
      base: "session folder",
      status: "ran",
      outputChars: 8,
    },
  ]);
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
  expect(text.stdout).toContain(
    "ran · cat · /historical/project/README.md · relative to session folder · call shell",
  );
  expect(text.stdout).toContain("MCP calls are listed by server and tool");
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
    shellCommands: 0,
    unrecordedCommands: 0,
    unmatchedFileResults: 0,
    unparsedRecords: 0,
    injectedInstructions: "per-file",
    unreadableInstructions: 0,
    skillListings: 0,
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
  const loaded = {
    type: "attachment",
    uuid: "replayed-line",
    timestamp: stamp,
    attachment: {
      type: "instructions",
      files: [
        { path: "/historical/home/.claude/CLAUDE.md", type: "User", content: global },
        { path: "/historical/project/CLAUDE.md", type: "Project", content: "" },
        { path: 42, type: "Project", content: "malformed" },
      ],
    },
  };
  const { home, path } = await fixture([
    loaded,
    loaded,
    {
      type: "attachment",
      timestamp: stamp,
      attachment: {
        type: "skill_listing_placeholder",
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
      textDiffersFromFile: null,
    },
    {
      at: "2026-10-22T10:00:00.000Z",
      path: "/historical/project/CLAUDE.md",
      directory: null,
      label: "Project",
      textSha256: sha(""),
      textChars: 0,
      textDiffersFromFile: null,
    },
    {
      at: "2026-10-22T10:05:00.000Z",
      path: "/historical/project/admin/CLAUDE.md",
      directory: null,
      label: "Project",
      textSha256: sha(nested),
      textChars: nested.length,
      textDiffersFromFile: true,
    },
  ]);
  expect(report.warnings.join(" ")).toContain("1 recorded instruction entry");
  const text = await run(home, path);
  expect(text.stdout).toContain("Injected instructions: per-file · 3 recorded");
  expect(text.stdout).toContain(
    "/historical/project/admin/CLAUDE.md · Project · injected text differs from the file (processed by the harness)",
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
      {
        type: "compacted",
        timestamp: "2026-10-22T11:00:00Z",
        payload: {
          message: "",
          replacement_history: [
            {
              type: "message",
              role: "developer",
              content: [{ type: "input_text", text: "<permissions/>" }],
            },
            {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: `# AGENTS.md instructions for /historical/project\n\n<INSTRUCTIONS>\n${block}\n</INSTRUCTIONS>`,
                },
              ],
            },
            { type: "compaction" },
          ],
        },
      },
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
      textDiffersFromFile: null,
    },
    {
      at: "2026-10-22T10:00:00.000Z",
      path: null,
      directory: null,
      label: "AGENTS.md instructions",
      textSha256: sha("Older header."),
      textChars: "Older header.".length,
      textDiffersFromFile: null,
    },
    {
      at: "2026-10-22T11:00:00.000Z",
      path: null,
      directory: "/historical/project",
      label: "AGENTS.md instructions",
      textSha256: sha(block),
      textChars: block.length,
      textDiffersFromFile: null,
    },
  ]);
  expect(combined.warnings.join(" ")).toContain("1 recorded instruction entry");
  expect(combined.limitations.join(" ")).toContain("combined");

  const pi = join(home, ".pi/agent/sessions/demo/session.jsonl");
  const piContext = (files: [string, string][]) =>
    `<project_context>\nProject-specific instructions and guidelines:\n\n${files
      .map(([p, c]) => `<project_instructions path="${p}">\n${c}\n</project_instructions>`)
      .join("\n\n")}\n</project_context>`;
  const system = (sections: Record<string, string | null>, at = stamp) => ({
    type: "message",
    timestamp: at,
    message: { role: "system", content: "", sections },
  });
  await Bun.write(
    pi,
    [
      { type: "session", id: "pi", cwd: "/historical/project" },
      system({
        preamble: "You are an expert coding assistant.",
        project_context: piContext([
          ["/historical/home/.pi/agent/AGENTS.md", global],
          ["/historical/project/AGENTS.md", nested],
        ]),
        cwd: "<cwd>/historical/project</cwd>",
      }),
      system({ project_context: null }, "2026-10-22T10:10:00Z"),
      system({ skills: "<skills></skills>" }, "2026-10-22T10:11:00Z"),
      system(
        { project_context: '<project_context>\n<project_instructions path="/x">\nunterminated' },
        "2026-10-22T10:12:00Z",
      ),
      {
        type: "compaction",
        timestamp: "2026-10-22T10:20:00Z",
        tokensBefore: 100,
        systemMessage: {
          role: "system",
          content: "",
          sections: { project_context: piContext([["/historical/project/AGENTS.md", nested]]) },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  const piReport = JSON.parse((await run(home, pi, "--json")).stdout);
  expect(piReport.coverage.injectedInstructions).toBe("per-file");
  expect(piReport.coverage.unreadableInstructions).toBe(1);
  expect(
    piReport.instructions.map((i: { at: string; path: string; textSha256: string }) => [
      i.at,
      i.path,
      i.textSha256,
    ]),
  ).toEqual([
    ["2026-10-22T10:00:00.000Z", "/historical/home/.pi/agent/AGENTS.md", sha(global)],
    ["2026-10-22T10:00:00.000Z", "/historical/project/AGENTS.md", sha(nested)],
    ["2026-10-22T10:20:00.000Z", "/historical/project/AGENTS.md", sha(nested)],
  ]);
  const bare = join(home, ".pi/agent/sessions/demo/bare.jsonl");
  await Bun.write(
    bare,
    JSON.stringify({ type: "session", id: "bare", cwd: "/historical/project" }) + "\n",
  );
  const none = JSON.parse((await run(home, bare, "--json")).stdout);
  expect(none.instructions).toEqual([]);
  expect(none.warnings.join(" ")).toContain(
    "No injected instructions are recorded in this session",
  );
  expect(await Bun.file(join(home, ".quench")).exists()).toBe(false);
});

test("recorded instructions do not move run boundaries or timing", async () => {
  const { home, path } = await fixture([
    {
      type: "user",
      timestamp: stamp,
      promptSource: "typed",
      message: { role: "user", content: "work" },
    },
    {
      type: "assistant",
      timestamp: "2026-10-22T10:00:01Z",
      message: {
        id: "a",
        model: "m",
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      type: "attachment",
      timestamp: "2026-10-22T10:00:09Z",
      attachment: {
        type: "nested_memory",
        content: { path: "/historical/project/sub/CLAUDE.md", type: "Project", content: "- Rule." },
      },
    },
  ]);
  const proc = Bun.spawn(["bun", main, "runs", path, "--json"], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: "",
      CODEX_HOME: "",
      PI_CODING_AGENT_DIR: "",
    },
    stdout: "pipe",
  });
  const out = JSON.parse(await new Response(proc.stdout).text());
  expect(await proc.exited).toBe(0);
  const runs = out.runs ?? out;
  expect(runs.at(-1).endedAt).toBe("2026-10-22T10:00:01.000Z");
});

test("sources traces shell reads in Codex code-mode scripts and older shell calls", async () => {
  const home = await mkdtemp(join(tmpdir(), "quench-sources-"));
  const codex = join(home, ".codex/sessions/2026/10/22/rollout.jsonl");
  const item = (payload: Record<string, unknown>) => ({
    type: "response_item",
    timestamp: stamp,
    payload,
  });
  await Bun.write(
    codex,
    [
      {
        type: "session_meta",
        timestamp: stamp,
        payload: { id: "codex", cwd: "/historical/project" },
      },
      item({
        type: "custom_tool_call",
        name: "exec",
        call_id: "script",
        input: [
          'const a = await tools.exec_command({cmd:"sed -n \\"1,40p\\" AGENTS.md && cat docs/guide.md","max_output_tokens":4000});',
          'const b = await tools.exec_command({workdir:"/elsewhere", cmd:"head -5 notes.md"});',
          "const c = await tools.exec_command({cmd: command});",
        ].join("\n"),
      }),
      item({ type: "custom_tool_call_output", call_id: "script", output: "Script completed" }),
      item({
        type: "function_call",
        name: "shell",
        call_id: "old",
        arguments: JSON.stringify({ command: ["bash", "-lc", "cat README.md"], workdir: "/older" }),
      }),
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  const result = await run(home, codex, "--json");
  expect(result.code).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.coverage).toMatchObject({
    shellCommands: 4,
    unrecordedCommands: 1,
    otherToolCalls: 0,
  });
  expect(
    report.shell.map((r: { path: string; base: string; status: string; callId: string }) => [
      r.path,
      r.base,
      r.status,
      r.callId,
    ]),
  ).toEqual([
    ["/historical/project/AGENTS.md", "session folder", "ran", "script"],
    ["/historical/project/docs/guide.md", "session folder", "ran", "script"],
    ["/elsewhere/notes.md", "workdir", "ran", "script"],
    ["/older/README.md", "workdir", "missing-result", "old"],
  ]);
  expect(report.warnings.join(" ")).toContain("1 shell command was not recorded as literal text");
});

test("sources lists MCP calls by server and tool, never their arguments", async () => {
  const secret = { query: "private customer name", token: "sk-hidden" };
  const { home, path } = await fixture([
    call("docs", "mcp__docs_site__fetch_page", secret),
    call("docs", "mcp__docs_site__fetch_page", secret),
    result("docs", "Page text"),
    call("broken", "mcp__tracker__get_issue", secret),
    {
      type: "user",
      timestamp: stamp,
      message: {
        content: [
          { type: "tool_result", tool_use_id: "broken", content: "Denied", is_error: true },
        ],
      },
    },
    call("pending", "mcp__tracker__search", secret),
    call("plain", "Grep", { pattern: "x" }),
  ]);
  const json = await run(home, path, "--json");
  expect(json.code).toBe(0);
  const report = JSON.parse(json.stdout);
  expect(
    report.mcp.map((c: Record<string, unknown>) => [c.server, c.tool, c.status, c.outputChars]),
  ).toEqual([
    ["docs_site", "fetch_page", "unknown", null],
    ["tracker", "get_issue", "failed", 6],
    ["tracker", "search", "missing-result", null],
  ]);
  expect(report.coverage.otherToolCalls).toBe(1);
  const text = await run(home, path);
  expect(text.stdout).toContain("MCP calls: 3 to 2 servers");
  expect(text.stdout).toContain("  failed · tracker · get_issue · 6 characters · call broken");
  for (const out of [json.stdout, text.stdout]) {
    expect(out).not.toContain("private customer name");
    expect(out).not.toContain("sk-hidden");
  }

  const codexHome = await mkdtemp(join(tmpdir(), "quench-sources-"));
  const codex = join(codexHome, ".codex/sessions/2026/10/22/rollout.jsonl");
  const item = (payload: Record<string, unknown>) => ({
    type: "response_item",
    timestamp: stamp,
    payload,
  });
  await Bun.write(
    codex,
    [
      { type: "session_meta", timestamp: stamp, payload: { id: "codex", cwd: "/project" } },
      item({
        type: "function_call",
        name: "mcp__docs_site__fetch_page",
        call_id: "direct",
        arguments: JSON.stringify(secret),
      }),
      item({ type: "function_call_output", call_id: "direct", output: "Page text" }),
      item({
        type: "custom_tool_call",
        name: "exec",
        call_id: "script",
        input:
          "await tools.mcp__tracker__search({q:'private customer name'}); await tools.mcp__tracker__search({q:2});",
      }),
      item({ type: "custom_tool_call_output", call_id: "script", output: "Script completed" }),
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  const fromCodex = await run(codexHome, codex, "--json");
  expect(fromCodex.code).toBe(0);
  const codexReport = JSON.parse(fromCodex.stdout);
  expect(
    codexReport.mcp.map((c: Record<string, unknown>) => [c.server, c.callId, c.inScript, c.status]),
  ).toEqual([
    ["docs_site", "direct", false, "returned"],
    ["tracker", "script", true, "returned"],
    ["tracker", "script", true, "returned"],
  ]);
  expect(codexReport.coverage.otherToolCalls).toBe(0);
  expect(fromCodex.stdout).not.toContain("private customer name");
});

test("sources traces skill listings and the loads each harness recorded", async () => {
  const content = "- review: does review\n- deploy: does deploy";
  const { home, path } = await fixture([
    {
      type: "attachment",
      timestamp: stamp,
      cwd: "/historical/project",
      attachment: { type: "skill_listing", names: ["review", "deploy"], content },
    },
    call("s1", "Skill", { skill: "review" }),
    {
      type: "user",
      timestamp: stamp,
      cwd: "/historical/project",
      message: { content: "<command-name>/deploy</command-name>\n<command-args></command-args>" },
    },
  ]);
  const json = await run(home, path, "--json");
  expect(json.code).toBe(0);
  const report = JSON.parse(json.stdout);
  expect(report.coverage.skillListings).toBe(1);
  expect(report.skills.listings).toMatchObject([
    {
      chars: content.length,
      listed: [
        { name: "review", path: null },
        { name: "deploy", path: null },
      ],
    },
  ]);
  expect(
    report.skills.loads.map((l: Record<string, unknown>) => [l.name, l.how, l.by, l.path]),
  ).toEqual([
    ["review", "invoked", "model", null],
    ["deploy", "invoked", "user", null],
  ]);
  expect(report.warnings.join(" ")).toContain("name no file paths");
  const text = await run(home, path);
  expect(text.stdout).toContain("Skill loading: 1 listing · 2 listed · 2 loads");
  expect(text.stdout).toContain("  invoked · review · by model · path not recorded");

  const pi = join(home, ".pi/agent/sessions/demo/session.jsonl");
  const skillPath = "/historical/skills/notes/SKILL.md";
  const body = "# Notes skill";
  const piRow = (message: Record<string, unknown>) => ({
    type: "message",
    timestamp: stamp,
    message,
  });
  await Bun.write(
    pi,
    [
      { type: "session", id: "pi-skills", cwd: "/historical/project" },
      piRow({
        role: "system",
        content: "",
        sections: {
          skills: `<skill><name>notes</name><description>Take notes</description><location>${skillPath}</location></skill>`,
        },
      }),
      piRow({
        role: "assistant",
        content: [{ type: "toolCall", id: "skill", name: "read", arguments: { path: skillPath } }],
      }),
      piRow({
        role: "toolResult",
        toolCallId: "skill",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: body }],
      }),
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  const piReport = JSON.parse((await run(home, pi, "--json")).stdout);
  expect(piReport.skills.listings).toMatchObject([
    { listed: [{ name: "notes", path: skillPath }] },
  ]);
  expect(piReport.skills.loads).toMatchObject([
    {
      name: "notes",
      how: "read",
      path: skillPath,
      status: "returned",
      chars: body.length,
      callId: "skill",
    },
  ]);
  expect(piReport.warnings.join(" ")).not.toContain("name no file paths");

  const codex = join(home, ".codex/sessions/2026/10/22/rollout.jsonl");
  const item = (payload: Record<string, unknown>) => ({
    type: "response_item",
    timestamp: stamp,
    payload,
  });
  const block = [
    "<skills_instructions>",
    "- `r0` = `/historical/skills`",
    "- notes: Take notes (file: r0/notes/SKILL.md)",
    "</skills_instructions>",
  ].join("\n");
  await Bun.write(
    codex,
    [
      {
        type: "session_meta",
        timestamp: stamp,
        payload: { id: "codex", cwd: "/historical/project" },
      },
      item({ type: "message", role: "developer", content: [{ type: "input_text", text: block }] }),
      item({
        type: "function_call",
        name: "shell",
        call_id: "load",
        arguments: JSON.stringify({ command: ["bash", "-lc", `cat ${skillPath}`] }),
      }),
      item({ type: "function_call_output", call_id: "load", output: body }),
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  const codexReport = JSON.parse((await run(home, codex, "--json")).stdout);
  expect(codexReport.skills.loads).toMatchObject([
    { name: "notes", how: "shell-read", path: skillPath, status: "ran", callId: "load" },
  ]);

  const bare = join(home, ".pi/agent/sessions/demo/bare.jsonl");
  await Bun.write(bare, JSON.stringify({ type: "session", id: "bare", cwd: "/x" }) + "\n");
  const none = JSON.parse((await run(home, bare, "--json")).stdout);
  expect(none.skills).toEqual({ listings: [], loads: [] });
  expect(none.warnings.join(" ")).toContain("No skill listings are recorded in this session");
  expect(none.limitations.join(" ")).toContain("Skill loading");
});

test("sources with no file reads the latest session in this repository, worktrees included", async () => {
  const home = await mkdtemp(join(tmpdir(), "quench-sources-"));
  const here = await mkdtemp(join(tmpdir(), "quench-here-"));
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=q", "-c", "user.email=q@q", ...args], { cwd: here });
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "init");
  const worktree = `${here}-wt`;
  git("worktree", "add", "-q", worktree);
  const dir = join(home, ".claude/projects/demo");
  await mkdir(dir, { recursive: true });
  const session = (id: string, cwd: string) =>
    Bun.write(
      join(dir, `${id}.jsonl`),
      JSON.stringify({ ...call(id, "Bash", { command: "cat notes.md" }), cwd, sessionId: id }) +
        "\n",
    );
  await session("old-here", worktree);
  await session("elsewhere", "/somewhere/else");
  const past = new Date(Date.now() - 3_600_000);
  await utimes(join(dir, "old-here.jsonl"), past, past);
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: "",
    CODEX_HOME: "",
    PI_CODING_AGENT_DIR: "",
  };
  const spawn = async (cwd: string) => {
    const proc = Bun.spawn(["bun", main, "sources", "--json"], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  };
  const found = await spawn(here);
  expect(found.code).toBe(0);
  expect(found.stderr).toContain(
    "Latest Claude Code session in this repository, today: ~/.claude/projects/demo/old-here.jsonl",
  );
  expect(JSON.parse(found.stdout).shell[0].path).toBe(join(worktree, "notes.md"));
  const none = await spawn(home);
  expect(none.code).toBe(1);
  expect(none.stderr).toContain("No session found in ~");
});
