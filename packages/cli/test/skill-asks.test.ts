import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { namesSkill, prose, wordsOf } from "@quench/history";

const main = join(import.meta.dir, "../src/main.ts");

async function quench(home: string, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", main, ...args], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: "",
      CODEX_HOME: "",
      PI_CODING_AGENT_DIR: "",
      TYPESAFE_API_KEY: "",
      TYPESAFE_BASE_URL: "http://127.0.0.1:1",
      ...env,
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

const lines = (records: object[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
const at = (second: number) => `2026-10-20T10:00:${String(second).padStart(2, "0")}Z`;

const SAID = {
  shipIt: "please ship it now",
  codeCheck: "code check this branch",
  again: "run the code-check again",
  revue: "Deep revue of the diff",
  weather: "is the weather skill any good",
  wach: "night wach on the deploy",
  relayClaude: "relay from the lane: code check passed, ship it, tidy notes later",
  tidePole: "tide pole the logs",
  delegatePrompt: "use the tide pool skill on the logs",
  deployGate: "deploy gate this",
  deepLane: "deep review the change in a lane",
  queuedAsk: "tide pool the db",
  queuedFollowUp: "also check the replica",
  reveiw: "deep reveiw the patch",
  relayCodex: "relay: deep review again",
  unknown: "deep review now",
};

async function skill(dir: string, name: string, extra = "") {
  await Bun.write(
    join(dir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: Does ${name}\n${extra}---\nBody\n`,
  );
}

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "quench-asks-")));
  const project = join(home, "work");
  await mkdir(project, { recursive: true });
  const claudeSkills = join(home, ".claude/skills");
  for (const name of [
    "code-check",
    "deep-review",
    "night-watch",
    "weather",
    "tidy-notes",
    "tide-pool",
  ])
    await skill(claudeSkills, name);
  await skill(join(project, ".claude/skills"), "deploy-gate", "disable-model-invocation: true\n");
  await skill(claudeSkills, "ship-it", "disable-model-invocation: true\n");
  const codexSkills = join(home, ".codex/skills");
  for (const name of ["deep-review", "tidy-notes"]) await skill(codexSkills, name);

  const listing = {
    type: "attachment",
    cwd: project,
    timestamp: at(0),
    attachment: {
      type: "skill_listing",
      names: ["code-check", "deep-review", "night-watch", "weather", "tidy-notes", "tide-pool"],
      content:
        "- code-check: x\n- deep-review: x\n- night-watch: x\n- weather: x\n- tidy-notes: x\n- tide-pool: x",
    },
  };
  const typed = (text: string, second: number) => ({
    type: "user",
    cwd: project,
    timestamp: at(second),
    origin: { kind: "human" },
    message: { role: "user", content: text },
  });
  const viaHost = (text: string, second: number) => ({
    type: "user",
    cwd: project,
    timestamp: at(second),
    promptSource: "sdk",
    message: { role: "user", content: text },
  });
  const skillCall = (name: string, second: number) => ({
    type: "assistant",
    cwd: project,
    timestamp: at(second),
    message: {
      content: [
        { type: "tool_use", id: `${name}${second}`, name: "Skill", input: { skill: name } },
      ],
    },
  });
  const said = (second: number) => ({
    type: "assistant",
    cwd: project,
    timestamp: at(second),
    message: { content: [{ type: "text", text: "ok" }] },
  });
  await Bun.write(
    join(home, ".claude/projects/p/terminal.jsonl"),
    lines([
      listing,
      typed(SAID.shipIt, 1),
      said(2),
      typed(SAID.codeCheck, 3),
      skillCall("code-check", 4),
      typed(SAID.again, 5),
      said(6),
      typed(SAID.revue, 7),
      said(8),
      typed(SAID.weather, 9),
      said(10),
      {
        ...typed("<command-name>/ship-it</command-name>\n<command-args></command-args>", 11),
      },
      typed(SAID.tidePole, 12),
      said(16),
      typed(SAID.deployGate, 20),
      said(21),
    ]),
  );
  await Bun.write(
    join(home, ".claude/projects/p/terminal/subagents/agent-a.jsonl"),
    lines([
      { ...listing, timestamp: at(13) },
      viaHost(SAID.delegatePrompt, 13),
      skillCall("tide-pool", 14),
      said(15),
    ]),
  );
  await Bun.write(
    join(home, ".claude/projects/p/queued.jsonl"),
    lines([
      listing,
      typed(SAID.queuedAsk, 40),
      {
        type: "attachment",
        cwd: project,
        timestamp: at(41),
        attachment: {
          type: "queued_command",
          commandMode: "prompt",
          prompt: SAID.queuedFollowUp,
          origin: { kind: "human" },
        },
      },
      said(42),
    ]),
  );
  await Bun.write(
    join(home, ".claude/projects/p/queued/subagents/agent-q.jsonl"),
    lines([{ ...listing, timestamp: at(59) }, viaHost("go", 59), skillCall("tide-pool", 59)]),
  );
  await Bun.write(
    join(home, ".claude/projects/p/lane.jsonl"),
    lines([
      { ...listing, timestamp: at(31) },
      viaHost("go", 31),
      skillCall("deep-review", 32),
      said(33),
    ]),
  );
  await Bun.write(
    join(home, ".claude/projects/p/hosted.jsonl"),
    lines([
      listing,
      viaHost(SAID.wach, 1),
      skillCall("night-watch", 2),
      viaHost(SAID.relayClaude, 3),
      said(4),
      viaHost(SAID.deepLane, 30),
      said(34),
    ]),
  );

  const block = [
    "<skills_instructions>",
    "## Skills",
    "### Skill roots",
    `- \`r0\` = \`${codexSkills}\``,
    "### Available skills",
    "- deep-review: Review (file: r0/deep-review/SKILL.md)",
    "- tidy-notes: Notes (file: r0/tidy-notes/SKILL.md)",
    "</skills_instructions>",
  ].join("\n");
  const codex = (id: string, records: object[]) =>
    Bun.write(
      join(home, `.codex/sessions/2026/10/20/${id}.jsonl`),
      lines([
        { type: "session_meta", timestamp: at(0), payload: { id, cwd: project } },
        {
          type: "response_item",
          timestamp: at(0),
          payload: {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: block }],
          },
        },
        ...records,
      ]),
    );
  const ask = (text: string, second: number) => ({
    type: "response_item",
    timestamp: at(second),
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  });
  await codex("hosted-codex", [
    ask(SAID.reveiw, 1),
    {
      type: "response_item",
      timestamp: at(2),
      payload: {
        type: "custom_tool_call",
        name: "exec",
        call_id: "x",
        input: `text(await tools.exec_command({cmd:"cat ${codexSkills.replaceAll(sep, "/")}/deep-review/SKILL.md"}))`,
      },
    },
    ask(SAID.relayCodex, 3),
  ]);
  await codex("terminal-codex", [ask(SAID.unknown, 1)]);

  await mkdir(join(home, ".t3/userdata"), { recursive: true });
  const db = new Database(join(home, ".t3/userdata/statev2.sqlite"));
  db.exec(`
    CREATE TABLE orchestration_v2_projection_provider_threads (payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_messages (thread_id TEXT, role TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_subagents (thread_id TEXT, child_thread_id TEXT);
  `);
  const link = (thread: string, driver: string, nativeId: string) =>
    db.query("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?)").run(
      JSON.stringify({
        appThreadId: thread,
        nativeThreadRef: { driver, nativeId, strength: "strong" },
      }),
    );
  const message = (thread: string, text: string, second: number, person: boolean) =>
    db.query("INSERT INTO orchestration_v2_projection_messages VALUES (?, 'user', ?)").run(
      thread,
      JSON.stringify({
        id: `${thread}${second}`,
        threadId: thread,
        role: "user",
        text,
        createdAt: at(second - 1),
        createdBy: person ? "user" : "agent",
        creationSource: person ? "web" : "mcp",
      }),
    );
  link("t-claude", "claudeAgent", "hosted");
  link("t-codex", "codex", "hosted-codex");
  link("t-lane", "claudeAgent", "lane");
  db.query("INSERT INTO orchestration_v2_projection_subagents VALUES ('t-claude', 't-lane')").run();
  message("t-claude", SAID.deepLane, 30, true);
  message("t-lane", "go", 31, false);
  message("t-claude", SAID.wach, 1, true);
  message("t-claude", SAID.relayClaude, 3, false);
  message("t-codex", SAID.reveiw, 1, true);
  message("t-codex", SAID.relayCodex, 3, false);
  db.close();
  return home;
}

const row = (r: Record<string, unknown>) => ({
  harness: r.harness,
  name: r.name,
  used: r.used,
  measured: r.measured,
  asked: r.asked,
  askedAndLoaded: r.askedAndLoaded,
  askedNotLoaded: r.askedNotLoaded,
  viaDelegate: r.viaDelegate,
  relayed: r.relayed,
  unknownSender: r.unknownSender,
  fix: r.fix,
});

test("profile skills counts plain-word asks per skill, relays apart, and keeps asked skills off the cut list", async () => {
  const home = await fixture();
  const text = await quench(home, ["profile", "skills"]);
  expect(text.code).toBe(0);
  expect(text.stdout).toContain(
    [
      "Asked in plain words · messages people typed that named a skill · last 30 days",
      "  Agent        Skill        Used         Asked  Asked and loaded  Asked, not loaded  Note",
      "  Claude Code  code-check      1             2                 1                  1",
      "  Claude Code  deep-review     1             2                 1                  1  1 loaded by a delegate",
      "  Claude Code  ship-it         1             1                 0                  1  only loads from /ship-it (disable-model-invocation)",
      "  Claude Code  deploy-gate     0             1                 0                  1  only loads from /deploy-gate (disable-model-invocation)",
      "  Claude Code  tide-pool       2             2                 2                  0  2 loaded by a delegate",
      "  Codex        deep-review     1             1                 1                  0",
      "  Claude Code  night-watch     1             1                 1                  0",
      "  Claude Code  weather         0  not measured      not measured       not measured  1 mention, one-word name",
      "  Relayed by agents or automation, not counted as asked: 3 messages naming 5 skills",
      "  Sender not recorded, not counted as asked: 1 message naming 1 skill",
    ].join("\n"),
  );
  const cut = text.stdout.slice(
    text.stdout.indexOf("Cut list"),
    text.stdout.indexOf("Asked in plain words"),
  );
  expect(cut).toContain("tidy-notes");
  expect(cut).not.toContain("deep-review");
  expect(cut).not.toContain("weather");
  for (const said of Object.values(SAID)) expect(text.stdout).not.toContain(said);

  const out = await quench(home, ["profile", "skills", "--json"]);
  const parsed = JSON.parse(out.stdout);
  expect(parsed.recordedSkillAsks.rows.map(row)).toEqual([
    {
      harness: "claude-code",
      name: "code-check",
      used: 1,
      measured: "matched",
      asked: 2,
      askedAndLoaded: 1,
      askedNotLoaded: 1,
      viaDelegate: 0,
      relayed: 1,
      unknownSender: 0,
      fix: null,
    },
    {
      harness: "claude-code",
      name: "deep-review",
      used: 1,
      measured: "matched",
      asked: 2,
      askedAndLoaded: 1,
      askedNotLoaded: 1,
      viaDelegate: 1,
      relayed: 0,
      unknownSender: 0,
      fix: null,
    },
    {
      harness: "claude-code",
      name: "ship-it",
      used: 1,
      measured: "matched",
      asked: 1,
      askedAndLoaded: 0,
      askedNotLoaded: 1,
      viaDelegate: 0,
      relayed: 1,
      unknownSender: 0,
      fix: "only loads from /name",
    },
    {
      harness: "claude-code",
      name: "deploy-gate",
      used: 0,
      measured: "matched",
      asked: 1,
      askedAndLoaded: 0,
      askedNotLoaded: 1,
      viaDelegate: 0,
      relayed: 0,
      unknownSender: 0,
      fix: "only loads from /name",
    },
    {
      harness: "claude-code",
      name: "tide-pool",
      used: 2,
      measured: "matched",
      asked: 2,
      askedAndLoaded: 2,
      askedNotLoaded: 0,
      viaDelegate: 2,
      relayed: 1,
      unknownSender: 0,
      fix: null,
    },
    {
      harness: "codex",
      name: "deep-review",
      used: 1,
      measured: "matched",
      asked: 1,
      askedAndLoaded: 1,
      askedNotLoaded: 0,
      viaDelegate: 0,
      relayed: 1,
      unknownSender: 1,
      fix: null,
    },
    {
      harness: "claude-code",
      name: "night-watch",
      used: 1,
      measured: "matched",
      asked: 1,
      askedAndLoaded: 1,
      askedNotLoaded: 0,
      viaDelegate: 0,
      relayed: 0,
      unknownSender: 0,
      fix: null,
    },
    {
      harness: "claude-code",
      name: "tidy-notes",
      used: 0,
      measured: "matched",
      asked: 0,
      askedAndLoaded: 0,
      askedNotLoaded: 0,
      viaDelegate: 0,
      relayed: 1,
      unknownSender: 0,
      fix: null,
    },
    {
      harness: "claude-code",
      name: "weather",
      used: 0,
      measured: "not measured",
      asked: null,
      askedAndLoaded: null,
      askedNotLoaded: null,
      viaDelegate: 0,
      relayed: 0,
      unknownSender: 0,
      fix: null,
    },
  ]);
  expect(parsed.recordedSkillAsks.relayed).toEqual({ messages: 3, skills: 5 });
  for (const said of Object.values(SAID)) expect(out.stdout).not.toContain(said);
  expect(parsed.limitations.some((l: string) => l.includes("Codex and Pi record no sender"))).toBe(
    true,
  );
  const tidy = parsed.recordedSkillCuts.cuts.find(
    (c: { agents: string[]; skills: string[] }) =>
      c.agents.includes("claude-code") && c.skills.includes("tidy-notes"),
  );
  expect(tidy.relayed).toBe(1);
  const cuts = parsed.recordedSkillCuts.cuts.flatMap((c: { skills: string[] }) => c.skills);
  expect(cuts).toContain("tidy-notes");
  expect(cuts).not.toContain("deep-review");
  expect(cuts).not.toContain("weather");
});

test("one-word names count as asked only through the opt-in Jev judgment, cached", async () => {
  const home = await fixture();
  const sent: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    routes: {
      "/v1/systemone": {
        POST: async (request) => {
          sent.push(await request.json());
          return Response.json({
            model: "jev-test",
            answers: { ask: { type: "choice", choice: "mentioned" } },
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        },
      },
    },
    fetch: () => new Response("not found", { status: 404 }),
  });
  try {
    const env = { TYPESAFE_API_KEY: "ts_test_key", TYPESAFE_BASE_URL: server.url.origin };
    const out = await quench(home, ["profile", "skills", "--json", "--asks"], env);
    expect(out.code).toBe(0);
    const parsed = JSON.parse(out.stdout);
    const weather = parsed.recordedSkillAsks.rows.find(
      (r: { name: string }) => r.name === "weather",
    );
    expect(row(weather)).toMatchObject({ measured: "judged", asked: 0, askedNotLoaded: 0 });
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain(SAID.weather);
    const cuts = parsed.recordedSkillCuts.cuts.flatMap((c: { skills: string[] }) => c.skills);
    expect(cuts).toContain("weather");
    await quench(home, ["profile", "skills", "--json", "--asks"], env);
    expect(sent).toHaveLength(1);
  } finally {
    await server.stop(true);
  }
});

test("names match as words outside code, paths and URLs, with typos and sound-alikes anchored by an exact word", () => {
  const ask = (text: string, name: string) => namesSkill(prose(text), wordsOf(name));
  expect(ask("tide pool it", "tide-pool")).toBe(true);
  expect(ask("tidepool", "tide-pool")).toBe(true);
  expect(ask("Tide pole please", "tide-pool")).toBe(true);
  expect(ask("Tied pool", "tide-pool")).toBe(true);
  expect(ask("deep revue", "deep-review")).toBe(true);
  expect(ask("tied pole", "tide-pool")).toBe(false);
  expect(ask("or check", "qa-check")).toBe(false);
  expect(ask("night wach", "night-watch")).toBe(true);
  expect(ask("let's go stag tonight", "go-stg")).toBe(false);
  expect(ask("unit reviews are slow", "unit-review")).toBe(false);
  expect(ask("see ~/.claude/skills/ship-it/SKILL.md", "ship-it")).toBe(false);
  expect(ask("see https://github.com/x/ship-it/pull/3", "ship-it")).toBe(false);
  expect(ask("try this:\n```\nship_it()\n```", "ship-it")).toBe(false);
  expect(ask("run `ship-it` later", "ship-it")).toBe(false);
  expect(ask("ship it now", "ship-it")).toBe(true);
  expect(ask("branch tide-pool-fix is stale", "tide-pool")).toBe(false);
  expect(ask("git push origin fix-tide-pool", "tide-pool")).toBe(false);
  expect(ask("Unknown skill: tide-pool", "tide-pool")).toBe(true);
  expect(ask("the weather", "weather")).toBe(true);
});
