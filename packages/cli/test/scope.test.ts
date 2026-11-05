import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { link, mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  causeInput,
  type CauseInput,
  Jev,
  JevCauses,
  ThemeCache,
  VerdictCache,
} from "@quench/judge";
import { cliRunsTimeout, lines, quench } from "./run.ts";

const at = (second: number) => new Date(Date.UTC(2026, 9, 20, 10, 0, second)).toISOString();
const canaries = ["qcanaryaq", "qcanarybq", "qcanarycq", "qcanarydq", "qcanaryeq", "qcanaryfq"];
const [buildText, doneText, fixText, relayText, goText, wrongText] = canaries.map(
  (c) => `say ${c}`,
) as [string, string, string, string, string, string];
const inference = (id: string, second: number, content: object[]) => ({
  type: "assistant",
  timestamp: at(second),
  message: { id, model: "model-x", content, usage: { input_tokens: 1, output_tokens: 1 } },
});
const said = (id: string, second: number, text: string) =>
  inference(id, second, [{ type: "text", text }]);
const user = (second: number, content: unknown, extra: object = {}) => ({
  type: "user",
  timestamp: at(second),
  message: { role: "user", content },
  ...extra,
});

const claude = (prompt: string, done: string, reply: string, relay: string) =>
  lines([
    user(0, prompt),
    inference("m1", 1, [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
    user(2, [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }]),
    said("m2", 3, done),
    user(4, reply, { promptSource: "typed" }),
    said("m3", 5, "fixed"),
    user(6, relay),
    said("m4", 7, "ok"),
    user(8, "thanks"),
  ]);

const codexLine = (second: number, type: string, payload: object) => ({
  timestamp: at(second),
  type,
  payload,
});
const usage = (second: number) =>
  codexLine(second, "token_usage_record", {
    usage: {
      input_tokens: 1,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 1,
    },
  });
const message = (second: number, role: string, text: string) =>
  codexLine(second, "response_item", {
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  });
const codex = lines([
  codexLine(0, "session_meta", { id: "cccc2222", cwd: "/work/demo" }),
  codexLine(0, "turn_context", { model: "model-y", cwd: "/work/demo" }),
  message(1, "user", goText),
  codexLine(2, "response_item", {
    type: "function_call",
    name: "shell",
    call_id: "k1",
    arguments: "{}",
  }),
  codexLine(3, "response_item", { type: "function_call_output", call_id: "k1", output: "ok" }),
  usage(4),
  message(5, "assistant", doneText),
  message(10, "user", wrongText),
  usage(11),
  message(12, "assistant", "ok"),
]);

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "quench-scope-")));
  const claudeFile = join(home, ".claude/projects/demo/aaaa1111.jsonl");
  const codexFile = join(
    home,
    ".codex/sessions/2026/10/20/rollout-2026-10-20T10-00-00-cccc2222.jsonl",
  );
  await Bun.write(claudeFile, claude(buildText, doneText, fixText, relayText));
  await Bun.write(
    join(home, ".claude/projects/demo/zzzz9999.jsonl"),
    claude("other", "done", "no", "relay"),
  );
  await Bun.write(codexFile, codex);
  const verdicts = await VerdictCache.open(join(home, ".quench/local"), Jev.id);
  const correction = (sender: "person" | "automation") => ({
    kind: "correction" as const,
    sender,
    confidence: 1,
  });
  await verdicts.remember([
    [{ assistantSaid: doneText, reply: fixText }, correction("person")],
    [{ assistantSaid: "fixed", reply: relayText }, correction("automation")],
    [
      { assistantSaid: "ok", reply: "thanks" },
      { kind: "info", sender: "person", confidence: 1 },
    ],
    [{ assistantSaid: doneText, reply: wrongText }, correction("person")],
    [{ assistantSaid: "done", reply: "no" }, correction("person")],
  ]);
  const causes = await ThemeCache.open<CauseInput>(
    join(home, ".quench/local/causes.jsonl"),
    JevCauses.id,
  );
  await causes.remember(causeInput({ assistantSaid: doneText, reply: fixText }), {
    choice: "misread_instruction",
    model: "cause-model",
  });
  const host = join(home, "host.sqlite");
  const db = new Database(host);
  db.exec(`CREATE TABLE orchestration_v2_projection_provider_threads (payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_messages (thread_id TEXT, role TEXT, payload_json TEXT);`);
  db.query("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?)").run(
    JSON.stringify({
      appThreadId: "synthetic-thread",
      nativeThreadRef: { driver: "codex", nativeId: "cccc2222", strength: "strong" },
    }),
  );
  db.query(
    "INSERT INTO orchestration_v2_projection_messages VALUES ('synthetic-thread', 'user', ?)",
  ).run(
    JSON.stringify({
      id: "synthetic-message",
      threadId: "synthetic-thread",
      role: "user",
      text: wrongText,
      createdAt: at(9),
      createdBy: "agent",
      creationSource: "mcp",
    }),
  );
  db.close();
  return { home, claudeFile, codexFile, host };
}

type Correction = {
  sessionId: string;
  harness: string;
  file: string;
  runIndex: number;
  sender: { kind: string; source: string };
  cause: string | null;
  cached: boolean;
  locator: { promptLine: number; agentLines: [number, number]; replyLine: number };
};

test(
  "corrections scoped to files and ids lists corrections with locators and no history text",
  async () => {
    const { home, claudeFile, codexFile, host } = await fixture();
    const scope = [claudeFile, "--session", "cccc2222", "--cached-only", "--json"];
    const withHost = await quench(home, "corrections", ...scope, "--host-history", host);
    expect(withHost.code).toBe(0);
    const out = JSON.parse(withHost.stdout);
    expect(out.schemaVersion).toBe(2);
    expect(out.judge).toBe(Jev.id);
    expect(out.summary).toEqual({
      sessionsRead: 2,
      runs: 5,
      corrections: { human: 1, agent: 2, unknown: 0 },
    });
    const list = out.corrections as Correction[];
    expect(
      list.map((c) => [c.harness, c.sessionId, c.runIndex, c.sender, c.cause, c.cached]),
    ).toEqual([
      ["claude-code", "aaaa1111", 1, { kind: "human", source: "harness" }, null, true],
      ["claude-code", "aaaa1111", 2, { kind: "agent", source: "model" }, null, true],
      ["codex", "cccc2222", 1, { kind: "agent", source: "host-history" }, null, true],
    ]);
    expect(list.map((c) => [c.file, c.locator])).toEqual([
      [claudeFile, { promptLine: 1, agentLines: [2, 4], replyLine: 5 }],
      [claudeFile, { promptLine: 5, agentLines: [6, 6], replyLine: 7 }],
      [codexFile, { promptLine: 3, agentLines: [4, 7], replyLine: 8 }],
    ]);
    const rows = (await Bun.file(claudeFile).text()).split("\n");
    expect(JSON.parse(rows[4]!).message.content).toBe(fixText);
    expect(JSON.parse(rows[6]!).message.content).toBe(relayText);
    const codexRows = (await Bun.file(codexFile).text()).split("\n");
    expect(JSON.parse(codexRows[7]!).payload.content[0].text).toBe(wrongText);

    const again = await quench(home, "corrections", ...scope, "--host-history", host);
    expect(again.stdout).toBe(withHost.stdout);

    const noHost = JSON.parse(
      (await quench(home, "corrections", ...scope, "--no-host-history")).stdout,
    );
    expect(noHost.corrections[2].sender).toEqual({ kind: "human", source: "model" });
    expect(noHost.summary.corrections).toEqual({ human: 2, agent: 1, unknown: 0 });

    const causes = await quench(
      home,
      "corrections",
      claudeFile,
      "--session",
      "cccc2222",
      "--causes",
      "--dry-run",
      "--json",
      "--no-host-history",
    );
    expect(causes.code).toBe(0);
    expect(
      (JSON.parse(causes.stdout).corrections as Correction[]).map((c) => [c.cause, c.cached]),
    ).toEqual([
      ["misread_instruction", true],
      [null, true],
      [null, true],
    ]);

    const text = await quench(
      home,
      "corrections",
      claudeFile,
      "--cached-only",
      "--no-host-history",
    );
    expect(text.code).toBe(0);
    const outputs = [withHost, noHost, causes, text].map((o) => JSON.stringify(o));
    expect(canaries.filter((c) => outputs.some((o) => o.includes(c)))).toEqual([]);
  },
  cliRunsTimeout,
);

test(
  "session scope rejects --days and names every unreadable path or unknown id",
  async () => {
    const { home, claudeFile } = await fixture();
    const days = await quench(home, "corrections", claudeFile, "--days", "30", "--json");
    expect(days.code).toBe(2);
    expect(days.stderr).toContain("--days can't be combined with session scope");
    const idDays = await quench(home, "corrections", "--session", "cccc2222", "--days", "30");
    expect(idDays.code).toBe(2);

    const missing = join(home, "missing.jsonl");
    const gone = await quench(home, "corrections", claudeFile, missing, "--cached-only", "--json");
    expect(gone.code).not.toBe(0);
    expect(gone.stdout).toBe("");
    expect(gone.stderr).toContain(missing);

    const notes = join(home, "notes.jsonl");
    await Bun.write(notes, "not a transcript\n");
    const corrupt = join(home, ".claude/projects/demo/bbbb3333.jsonl");
    await Bun.write(corrupt, "not json\n{oops\n");
    const truncated = join(home, ".claude/projects/demo/dddd4444.jsonl");
    await Bun.write(truncated, claude("go", "done", "no", "relay") + '{"type":"user","mess\n');
    const empty = join(
      home,
      ".codex/sessions/2026/10/20/rollout-2026-10-20T10-00-00-eeee5555.jsonl",
    );
    await Bun.write(empty, "\n");
    for (const bad of [notes, corrupt, truncated, empty]) {
      const rejected = await quench(home, "corrections", bad, "--cached-only", "--json");
      expect([bad, rejected.code, rejected.stdout]).toEqual([bad, 1, ""]);
      expect(rejected.stderr).toContain(bad);
    }

    const unknown = await quench(home, "corrections", "--session", "nope0000", "--cached-only");
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain("nope0000");
  },
  cliRunsTimeout,
);

const pi = lines([
  { type: "session", id: "pppp6666", cwd: "/work/demo", timestamp: at(0), version: 3 },
  {
    type: "message",
    id: "1",
    timestamp: at(1),
    message: { role: "user", content: [{ type: "text", text: "rename it" }] },
  },
  {
    type: "message",
    id: "2",
    timestamp: at(2),
    message: {
      role: "assistant",
      model: "model-z",
      content: [{ type: "text", text: "renamed" }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    },
  },
  {
    type: "message",
    id: "3",
    timestamp: at(3),
    message: { role: "user", content: [{ type: "text", text: "thanks" }] },
  },
]);

test(
  "transcripts copied outside harness homes are read by their own format",
  async () => {
    const { home, claudeFile, codexFile } = await fixture();
    const exported = join(home, "exports");
    const copies = {
      claude: join(exported, "claude.jsonl"),
      codex: join(exported, "codex.jsonl"),
      pi: join(exported, "pi.jsonl"),
    };
    await Bun.write(copies.claude, Bun.file(claudeFile));
    await Bun.write(copies.codex, Bun.file(codexFile));
    await Bun.write(copies.pi, pi);
    const args = [copies.claude, copies.codex, copies.pi, "--cached-only", "--json"];
    const result = await quench(home, "corrections", ...args, "--no-host-history");
    expect(result.code).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.summary.sessionsRead).toBe(3);
    expect(
      (out.corrections as Correction[]).map((c) => [c.harness, c.file, c.locator.replyLine]),
    ).toEqual([
      ["claude-code", copies.claude, 5],
      ["claude-code", copies.claude, 7],
      ["codex", copies.codex, 8],
    ]);
    const both = await quench(
      home,
      "corrections",
      claudeFile,
      copies.claude,
      "--cached-only",
      "--json",
    );
    expect(JSON.parse(both.stdout).summary.sessionsRead).toBe(2);
  },
  cliRunsTimeout,
);

test(
  "a slash command prompt is not part of the agent's line range",
  async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "quench-scope-")));
    const file = join(home, ".claude/projects/demo/ffff7777.jsonl");
    await Bun.write(
      file,
      lines([
        user(0, "<command-name>/review</command-name>\n<command-args></command-args>", {
          promptSource: "typed",
        }),
        said("m1", 1, "reviewed"),
        user(2, "no, the other file", { promptSource: "typed" }),
      ]),
    );
    const runs = JSON.parse((await quench(home, "runs", file, "--json")).stdout);
    expect(runs[0]).toMatchObject({ promptLine: 1, agentLines: [2, 2], replyLine: 3 });
  },
  cliRunsTimeout,
);

test(
  "unscoped corrections count a transcript linked into two folders once",
  async () => {
    const { home, claudeFile } = await fixture();
    const unscoped = [
      "corrections",
      "--days",
      "36500",
      "--cached-only",
      "--json",
      "--no-host-history",
    ];
    const before = JSON.parse((await quench(home, ...unscoped)).stdout);
    await mkdir(join(home, ".claude/projects/elsewhere"), { recursive: true });
    const linked = join(home, ".claude/projects/elsewhere/aaaa1111.jsonl");
    await link(claudeFile, linked);
    const after = JSON.parse((await quench(home, ...unscoped)).stdout);
    expect(after.fromPeople).toEqual(before.fromPeople);
    expect(after.fromAutomation).toEqual(before.fromAutomation);
    const scoped = await quench(home, "corrections", claudeFile, linked, "--cached-only", "--json");
    expect(JSON.parse(scoped.stdout).summary.sessionsRead).toBe(2);
  },
  cliRunsTimeout,
);
