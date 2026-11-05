import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jev, VerdictCache } from "@quench/judge";
import { cliRunsTimeout, lines, quench } from "./run.ts";

const at = (second: number) => new Date(Date.UTC(2026, 9, 20, 10, 0, second)).toISOString();
const canaries = ["qmidaq", "qmidbq", "qmidcq", "qmiddq", "qmideq", "qmidfq", "qmidgq", "qmidhq"];
const [firstText, secondText, steerText, againText, imageText, wrongText, moreText, nextText] =
  canaries.map((c) => `say ${c}`) as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
const imageNote = '\n\n[Attached image "image.png" is saved at: /tmp/synthetic/image.png]';

const inference = (id: string, second: number, content: object[]) => ({
  type: "assistant",
  timestamp: at(second),
  message: { id, model: "model-x", content, usage: { input_tokens: 1, output_tokens: 1 } },
});
const said = (id: string, second: number, text: string) =>
  inference(id, second, [{ type: "text", text }]);
const user = (second: number, content: unknown, extra: object = { promptSource: "sdk" }) => ({
  type: "user",
  timestamp: at(second),
  message: { role: "user", content },
  ...extra,
});
const tool = (id: string, second: number) =>
  inference(id, second, [{ type: "tool_use", id: `t-${id}`, name: "Bash", input: {} }]);
const result = (id: string, second: number) =>
  user(second, [{ type: "tool_result", tool_use_id: `t-${id}`, content: "ok" }], {});
const queue = (second: number, operation: string, extra: object = {}) => ({
  type: "queue-operation",
  operation,
  timestamp: at(second),
  ...extra,
});
const queued = (second: number, prompt: string, id: string) => ({
  type: "attachment",
  uuid: `a-${id}`,
  timestamp: at(second),
  attachment: { type: "queued_command", commandMode: "prompt", prompt, source_uuid: id },
});

const claude = lines([
  user(0, "build it", { promptSource: "typed" }),
  said("m1", 1, "built"),
  user(2, firstText),
  user(3, secondText),
  tool("m2", 4),
  result("m2", 5),
  queue(6, "enqueue", { content: steerText }),
  queue(7, "remove", { reason: "absorbed_mid_turn", commandUuid: "q1", content: steerText }),
  queued(6, steerText, "q1"),
  said("m3", 8, "done"),
  user(9, againText),
  said("m4", 10, "ok"),
  user(11, againText),
  said("m5", 12, "ok"),
  user(13, [
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
    { type: "text", text: imageText + imageNote },
  ]),
  said("m6", 14, "seen"),
  user(15, "thanks"),
]);

const delivered = lines([
  user(0, "go", { promptSource: "typed" }),
  tool("m1", 1),
  result("m1", 2),
  queued(1, nextText, "q2"),
  queue(3, "dequeue"),
  user(3, nextText),
  said("m2", 4, "ok"),
]);

const codexLine = (second: number, type: string, payload: object) => ({
  timestamp: at(second),
  type,
  payload,
});
const usage = (second: number) =>
  codexLine(second, "event_msg", {
    type: "token_count",
    info: { last_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
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
  message(1, "user", "go"),
  usage(2),
  message(3, "assistant", "done"),
  message(10, "user", wrongText),
  message(11, "user", moreText),
  usage(12),
  message(13, "assistant", "ok"),
]);

const hostMessage = (text: string, second: number, extra: object = {}) => ({
  id: `host-${second}`,
  threadId: "synthetic-thread",
  role: "user",
  text,
  createdAt: at(second),
  createdBy: "user",
  creationSource: "web",
  ...extra,
});

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "quench-midrun-")));
  const claudeFile = join(home, ".claude/projects/demo/aaaa1111.jsonl");
  const deliveredFile = join(home, ".claude/projects/demo/bbbb2222.jsonl");
  const codexFile = join(
    home,
    ".codex/sessions/2026/10/20/rollout-2026-10-20T10-00-00-cccc2222.jsonl",
  );
  await Bun.write(claudeFile, claude);
  await Bun.write(deliveredFile, delivered);
  await Bun.write(codexFile, codex);
  const correction = { kind: "correction" as const, sender: "automation" as const, confidence: 1 };
  const verdicts = await VerdictCache.open(join(home, ".quench/local"), Jev.id);
  await verdicts.remember([
    [{ assistantSaid: "built", reply: firstText }, correction],
    [{ assistantSaid: "built", reply: secondText }, correction],
    [{ assistantSaid: "", reply: steerText }, correction],
    [{ assistantSaid: "done", reply: wrongText }, correction],
    [{ assistantSaid: "done", reply: moreText }, correction],
  ]);
  const host = join(home, "host.sqlite");
  const db = new Database(host);
  db.exec(`CREATE TABLE orchestration_v2_projection_provider_threads (payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_messages (thread_id TEXT, role TEXT, payload_json TEXT);`);
  db.query("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?)").run(
    JSON.stringify({
      appThreadId: "synthetic-thread",
      nativeThreadRef: { driver: "claudeAgent", nativeId: "aaaa1111", strength: "strong" },
    }),
  );
  for (const m of [
    hostMessage(firstText, 2),
    hostMessage(secondText, 3),
    hostMessage(steerText, 6 - 300),
    hostMessage(againText, 9, { createdBy: "agent", creationSource: "mcp" }),
    hostMessage(againText, 11, { createdBy: "agent", creationSource: "mcp" }),
    hostMessage(imageText, 13, { attachments: [{ type: "image", id: "img", name: "image.png" }] }),
  ])
    db.query(
      "INSERT INTO orchestration_v2_projection_messages VALUES ('synthetic-thread', 'user', ?)",
    ).run(JSON.stringify(m));
  db.close();
  return { home, claudeFile, deliveredFile, codexFile, host };
}

type Correction = {
  harness: string;
  runIndex: number;
  sender: { kind: string; source: string };
  locator: { promptLine: number; agentLines: [number, number]; replyLine: number };
};

type RunJson = {
  promptLine: number | null;
  replyLine: number | null;
  promptSender: string;
  promptSenderSource: string;
  replySender: string;
  replySenderSource: string;
  followUps: { replyLine: number | null; replySender: string; replySenderSource: string }[];
};

test(
  "messages sent before the agent answers, or queued mid-run, are judged as replies",
  async () => {
    const { home, claudeFile, codexFile, host } = await fixture();
    const scope = [claudeFile, codexFile, "--cached-only", "--json", "--host-history", host];
    const out = await quench(home, "corrections", ...scope);
    expect(out.code).toBe(0);
    const report = JSON.parse(out.stdout);
    expect(report.schemaVersion).toBe(2);
    const list = report.corrections as Correction[];
    expect(list.map((c) => [c.harness, c.runIndex, c.locator.replyLine, c.sender])).toEqual([
      ["claude-code", 1, 3, { kind: "human", source: "host-history" }],
      ["claude-code", 1, 4, { kind: "human", source: "host-history" }],
      ["claude-code", 2, 9, { kind: "human", source: "host-history" }],
      ["codex", 1, 6, { kind: "agent", source: "model" }],
      ["codex", 1, 7, { kind: "agent", source: "model" }],
    ]);
    expect(report.summary.corrections).toEqual({ human: 3, agent: 2, unknown: 0 });
    const rows = (await Bun.file(claudeFile).text()).split("\n");
    expect(rows[8]).toContain(steerText);
    expect(canaries.filter((c) => out.stdout.includes(c) || out.stderr.includes(c))).toEqual([]);

    const runs = JSON.parse(
      (await quench(home, "runs", claudeFile, "--json", "--host-history", host)).stdout,
    ) as RunJson[];
    for (const c of list.filter((c) => c.harness === "claude-code")) {
      const run = runs[c.runIndex - 1]!;
      expect([run.replyLine, ...run.followUps.map((f) => f.replyLine)]).toContain(
        c.locator.replyLine,
      );
    }
  },
  cliRunsTimeout,
);

test(
  "runs --json names each prompt's sender and where that came from",
  async () => {
    const { home, claudeFile, deliveredFile, host } = await fixture();
    const runs = JSON.parse(
      (await quench(home, "runs", claudeFile, "--json", "--host-history", host)).stdout,
    ) as RunJson[];
    expect(runs.map((r) => [r.promptLine, r.promptSender, r.promptSenderSource])).toEqual([
      [1, "human", "harness"],
      [4, "human", "host-history"],
      [9, "human", "host-history"],
      [11, "agent", "host-history"],
      [13, "agent", "host-history"],
      [15, "human", "host-history"],
    ]);
    expect(runs[0]!.followUps).toEqual([
      expect.objectContaining({ replyLine: 4, replySender: "human" }),
    ]);
    expect(runs.at(-1)).toMatchObject({ replySender: "unknown", replySenderSource: "none" });

    const bare = JSON.parse(
      (await quench(home, "runs", claudeFile, "--json", "--no-host-history")).stdout,
    ) as RunJson[];
    expect(bare.map((r) => r.promptSenderSource)).toEqual([
      "harness",
      "none",
      "none",
      "none",
      "none",
      "none",
    ]);

    const once = JSON.parse((await quench(home, "runs", deliveredFile, "--json")).stdout);
    expect(once.map((r: RunJson) => [r.promptLine, r.replyLine, r.followUps])).toEqual([
      [1, 6, []],
      [6, null, []],
    ]);
  },
  cliRunsTimeout,
);

test(
  "unscoped corrections --json numbers every example by run, from 1",
  async () => {
    const { home, host } = await fixture();
    const args = ["--days", "36500", "--cached-only", "--json", "--host-history", host];
    const out = JSON.parse((await quench(home, "corrections", ...args)).stdout);
    expect(out.schemaVersion).toBe(2);
    expect(
      [...out.latest, ...out.latestAutomation].map((e: { runIndex: number; position: number }) => [
        e.runIndex,
        e.position,
      ]),
    ).toEqual([
      [2, 2],
      [1, 1],
      [1, 1],
      [1, 1],
      [1, 1],
    ]);
  },
  cliRunsTimeout,
);
