import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openT3History } from "../src/hosts/t3.ts";
import type { Event, Session } from "../src/model.ts";

const at = new Date("2026-10-20T10:00:01Z");
const say = (text: string): Extract<Event, { type: "message" }> => ({
  type: "message",
  author: "user",
  origin: "host",
  text,
  at,
});
const session = (events: Event[]): Session => ({
  id: "native",
  harness: "claude-code",
  path: "/unused",
  cwd: null,
  parent: null,
  events,
  diagnostics: { lines: events.length, unparsed: 0 },
});
const thread = (appThreadId = "thread", driver = "claudeAgent", strength = "strong") => ({
  appThreadId,
  nativeThreadRef: { driver, nativeId: "native", strength },
});
const message = (text: string, extra: Record<string, unknown> = {}) => ({
  id: text,
  threadId: "thread",
  role: "user",
  text,
  createdAt: "2026-10-20T10:00:00Z",
  createdBy: "agent",
  creationSource: "mcp",
  ...extra,
});

async function database(messages: Record<string, unknown>[], threads: unknown[] = [thread()]) {
  const path = join(await mkdtemp(join(tmpdir(), "quench-host-")), "history.sqlite");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE orchestration_v2_projection_provider_threads (payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_messages (thread_id TEXT, role TEXT, payload_json TEXT);
  `);
  for (const t of threads)
    db.query("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?)").run(
      JSON.stringify(t),
    );
  for (const m of messages)
    db.query("INSERT INTO orchestration_v2_projection_messages VALUES (?, 'user', ?)").run(
      typeof m.threadId === "string" ? m.threadId : "thread",
      JSON.stringify(m),
    );
  db.close();
  return path;
}

const senders = (s: Session) =>
  s.events.map((e) => (e.type === "message" ? e.sender?.sender : undefined));

test("host evidence is optional, read-only, and leaves transport origins and boundaries intact", async () => {
  const path = await database([
    message("typed", { createdBy: "user", creationSource: "web" }),
    message("agent", { creationSource: "web" }),
    message("imported", { createdBy: "user", creationSource: "server" }),
    message("mobile", { createdBy: "user", creationSource: "mobile" }),
    message("native override"),
  ]);
  const before = await Bun.file(path).bytes();
  const original = session([
    say("typed"),
    say("agent"),
    say("imported"),
    say("mobile"),
    { ...say("native override"), origin: "typed" },
  ]);
  const host = openT3History(path);
  try {
    const enriched = host.enrich(original);
    expect(senders(enriched)).toEqual(["person", "automation", undefined, "person", undefined]);
    expect(
      enriched.events.map((e) => [e.type, e.at, e.type === "message" ? e.origin : null]),
    ).toEqual(original.events.map((e) => [e.type, e.at, e.type === "message" ? e.origin : null]));
    expect(senders(original)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(enriched.events[1]).toMatchObject({
      sender: { sender: "automation", source: "t3-code", messageId: "agent" },
    });
    expect(host.warnings).toEqual([]);
  } finally {
    host.close();
  }
  expect(await Bun.file(path).bytes()).toEqual(before);
});

test("joins require a strong session link and unambiguous exact text in both histories within one minute", async () => {
  const path = await database([
    message("duplicate host"),
    message("duplicate host", { id: "other" }),
    message("duplicate harness"),
    message("old", { createdAt: "2026-10-20T09:58:00Z" }),
    message("future", { createdAt: "2026-10-20T10:02:00Z" }),
    message("invalid", { createdAt: "unknown" }),
    message("missing time"),
    message("different text "),
    message("different thread", { threadId: "other" }),
    message("same", { role: "assistant" }),
    message("valid"),
  ]);
  const host = openT3History(path);
  try {
    const events = [
      "duplicate host",
      "duplicate harness",
      "duplicate harness",
      "old",
      "future",
      "invalid",
      "different text",
      "different thread",
      "same",
    ].map(say);
    events.push({ ...say("missing time"), at: null });
    expect(senders(host.enrich(session(events))).every((s) => s === undefined)).toBe(true);
    expect(senders(host.enrich({ ...session([say("valid")]), id: "unlinked" }))).toEqual([
      undefined,
    ]);
    expect(senders(host.enrich({ ...session([say("valid")]), harness: "codex" }))).toEqual([
      undefined,
    ]);
  } finally {
    host.close();
  }
  for (const threads of [[thread("thread", "claudeAgent", "weak")], [thread(), thread("other")]]) {
    const ambiguous = openT3History(await database([message("valid")], threads));
    try {
      expect(senders(ambiguous.enrich(session([say("valid")])))).toEqual([undefined]);
    } finally {
      ambiguous.close();
    }
  }
});

test("the host adapter maps native provider IDs without changing the harness contract", async () => {
  for (const [driver, harness] of [
    ["codex", "codex"],
    ["pi", "pi"],
  ] as const) {
    const host = openT3History(await database([message("valid")], [thread("thread", driver)]));
    try {
      expect(senders(host.enrich({ ...session([say("valid")]), harness }))).toEqual(["automation"]);
    } finally {
      host.close();
    }
  }
});

test("a malformed thread cannot disable evidence for healthy threads read after it", async () => {
  const path = await database(
    [message("healthy"), message("malformed", { threadId: "broken", createdBy: 123 })],
    [
      thread(),
      {
        appThreadId: "broken",
        nativeThreadRef: { driver: "claudeAgent", nativeId: "broken", strength: "strong" },
      },
    ],
  );
  const healthy = session([say("healthy")]);
  const broken = { ...session([say("malformed")]), id: "broken" };
  for (const order of [
    [broken, healthy],
    [healthy, broken, healthy],
  ]) {
    const host = openT3History(path);
    try {
      expect(order.map((s) => senders(host.enrich(s))[0])).toEqual(
        order.map((s) => (s.id === "native" ? "automation" : undefined)),
      );
      expect(host.warnings).toHaveLength(1);
    } finally {
      host.close();
    }
  }
});

test("missing, incompatible, and malformed host storage never prevent reading a harness session", async () => {
  const missing = join(await mkdtemp(join(tmpdir(), "quench-host-missing-")), "absent.sqlite");
  const original = session([say("valid")]);
  const absent = openT3History(missing);
  expect(absent.enrich(original)).toBe(original);
  expect(absent.warnings).toEqual([]);
  absent.close();
  expect(await Bun.file(missing).exists()).toBe(false);

  const incompatible = join(
    await mkdtemp(join(tmpdir(), "quench-host-invalid-")),
    "changed.sqlite",
  );
  await Bun.write(incompatible, "not sqlite");
  for (const path of [incompatible, await database([{ changed: true }])]) {
    const host = openT3History(path);
    try {
      expect(host.enrich(original)).toBe(original);
      expect(host.warnings).toHaveLength(1);
    } finally {
      host.close();
    }
  }
});
