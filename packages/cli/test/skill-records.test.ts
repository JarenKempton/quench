import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treeHash } from "@quench/fleet";
import { readTree } from "@quench/fleet/disk";
import type { Session } from "@quench/history";
import { Jev, VerdictCache } from "@quench/judge";
import { contextOf } from "../src/commands/context.ts";
import { coOccurrence } from "../src/skills/co-occurrence.ts";
import { lines, quench } from "./run.ts";

const CANARY = "QCANARY9z";

const at = (second: number) => new Date(Date.UTC(2026, 9, 20, 10, 0, second)).toISOString();

type Case = {
  id: string;
  skill: string | null;
  args?: string;
  reply: string | null;
  userRuns?: boolean;
  listed?: string[];
};

const session = (c: Case) =>
  lines([
    {
      type: "attachment",
      sessionId: c.id,
      timestamp: at(0),
      attachment: {
        type: "skill_listing",
        names: c.listed ?? ["verify", "deploy"],
        content: (c.listed ?? ["verify", "deploy"]).map((n) => `- ${n}`).join("\n"),
      },
    },
    { type: "user", timestamp: at(1), message: { role: "user", content: "fix the build" } },
    {
      type: "assistant",
      timestamp: at(2),
      message: {
        id: `${c.id}-m1`,
        model: "model-x",
        content: c.skill
          ? [
              {
                type: "tool_use",
                id: `${c.id}-skill`,
                name: "Skill",
                input: { skill: c.skill, ...(c.args ? { args: c.args } : {}) },
              },
            ]
          : [{ type: "text", text: "working" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      type: "assistant",
      timestamp: at(4),
      message: {
        id: `${c.id}-m2`,
        model: "model-x",
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    ...(c.userRuns
      ? [
          {
            type: "user",
            timestamp: at(6),
            message: { role: "user", content: `<command-name>/${c.skill}</command-name>` },
          },
        ]
      : []),
    ...(c.reply === null
      ? []
      : [{ type: "user", timestamp: at(5), message: { role: "user", content: c.reply } }]),
  ]);

const skillFile = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: ${name} things${extra}\n---\nBody of ${name}.\n`;

async function fixture(cases: Case[], corrected: string[], uncached: string[] = []) {
  const home = await mkdtemp(join(tmpdir(), "quench-cli-skills-"));
  for (const name of ["verify", "deploy"])
    await Bun.write(join(home, ".claude/skills", name, "SKILL.md"), skillFile(name));
  await Bun.write(join(home, ".codex/skills/solo/SKILL.md"), skillFile("solo"));
  const dir = join(home, ".claude/projects/demo");
  await mkdir(dir, { recursive: true });
  const cache = await VerdictCache.open(join(home, ".quench/local"), Jev.id);
  for (const c of cases) {
    await Bun.write(join(dir, `${c.id}.jsonl`), session(c));
    if (uncached.includes(c.id) || c.reply === null) continue;
    await cache.remember([
      [
        { assistantSaid: "done", reply: c.reply },
        {
          kind: corrected.includes(c.id) ? "correction" : "approval",
          sender: "person",
          confidence: 1,
        },
      ],
    ]);
  }
  return home;
}

type Record = {
  id: string;
  skill: string;
  harness: string;
  location: string;
  origin: string | null;
  contentVersion: string | null;
  listedBy: string[];
  listingChars: number | null;
  bodyBytes: number | null;
  use: {
    sessionsListed: number | null;
    used: number | null;
    usedByUser: number | null;
    lowerBound: boolean;
  };
  coOccurrence: {
    basis: string;
    sessionsLoaded: number;
    withHumanCorrection: number | null;
    unjudgedSessions: number | null;
  };
};

const report = async (home: string, ...flags: string[]) => {
  const args = ["skills", "--days", "36500", "--no-host-history", ...flags];
  const out = await quench(home, ...args, "--json");
  expect(out.code).toBe(0);
  const text = await quench(home, ...args);
  return { json: JSON.parse(out.stdout), text: text.stdout };
};

const ordinary: Case[] = [
  ...["a", "b", "c", "d", "e"].map((id) => ({ id, skill: "verify", reply: `reply ${id}` })),
  { id: "f", skill: "deploy", reply: "reply f" },
  { id: "g", skill: null, reply: "reply g" },
];

test("one record per skill, agent and location, with tree hash, use and co-occurrence", async () => {
  const home = await fixture(ordinary, ["a", "c", "f"]);
  const { json, text } = await report(home);
  expect(json.schemaVersion).toBe(1);
  const records: Record[] = json.skills;
  const verify = records.find((r) => r.skill === "verify" && r.harness === "claude-code")!;
  expect(records.filter((r) => r.skill === "verify")).toHaveLength(1);
  expect(verify).toMatchObject({
    location: "~/.claude/skills/verify",
    origin: "user",
    listedBy: ["claude-code"],
    bodyBytes: skillFile("verify").length,
    use: { sessionsListed: 7, used: 5, usedByUser: 0, lowerBound: false },
    coOccurrence: {
      basis: "co-occurrence, not cause",
      sessionsLoaded: 5,
      withHumanCorrection: 2,
      unjudgedSessions: 0,
    },
  });
  expect(verify.id).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect((await report(home)).json.skills.find((r: Record) => r.id === verify.id)).toBeTruthy();
  expect(verify.contentVersion).toBe(treeHash(await readTree(join(home, ".claude/skills/verify"))));
  const deploy = records.find((r) => r.skill === "deploy")!;
  expect(deploy.coOccurrence).toMatchObject({ sessionsLoaded: 1, withHumanCorrection: null });
  const solo = records.find((r) => r.skill === "solo")!;
  expect(solo).toMatchObject({
    harness: "codex",
    origin: "user",
    use: { sessionsListed: null, used: null, usedByUser: null, lowerBound: true },
    coOccurrence: {
      sessionsLoaded: null,
      withHumanCorrection: null,
      unjudgedSessions: null,
      noFollowUp: null,
    },
  });
  expect(text).toContain("co-occurrence, not cause");
  expect(text).toMatch(/verify {2}5 sessions loaded it · 2 had a human correction/);
  expect(text).not.toMatch(/deploy {2}\d+ sessions loaded it/);
});

async function snapshot(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return (
    await Promise.all(entries.map(async (e) => `${e}:${(await stat(join(dir, e))).mtimeMs}`))
  ).sort();
}

test("--source compares by tree hash and changes nothing", async () => {
  const home = await fixture(ordinary, []);
  const source = await mkdtemp(join(tmpdir(), "quench-cli-skills-source-"));
  await Bun.write(join(source, "skills/verify/SKILL.md"), skillFile("verify"));
  await Bun.write(join(source, "skills/deploy/SKILL.md"), skillFile("deploy", " edited"));
  await Bun.write(join(source, "skills/extra/SKILL.md"), skillFile("extra"));
  const before = [await snapshot(source), await snapshot(join(home, ".claude"))];
  const { json, text } = await report(home, "--source", source);
  expect([await snapshot(source), await snapshot(join(home, ".claude"))]).toEqual(before);
  const at = (d: { skill: string; harness?: string }) => [d.skill, d.harness ?? null];
  expect(json.source.inSourceNotInstalled.map(at)).toEqual([["extra", null]]);
  expect(json.source.installedNotInSource.map(at)).toEqual([["solo", "codex"]]);
  expect(json.source.contentDiffers.map(at)).toEqual([["deploy", "claude-code"]]);
  expect(json.source.contentDiffers[0].source).toBe(
    treeHash(await readTree(join(source, "skills/deploy"))),
  );
  expect(text).toContain("Content differs: deploy (Claude Code)");
});

test("no skill name, argument, description or reply text from history reaches the output", async () => {
  const home = await fixture(
    [
      ...ordinary.map((c) => ({
        ...c,
        args: `--token ${CANARY}a`,
        reply: `Cookie: sid=${CANARY}b ${c.id}`,
      })),
      { id: "h", skill: `Cookie: sid=${CANARY}c`, args: `curl -u ${CANARY}d:pw`, reply: "ok" },
    ],
    ["a"],
  );
  await Bun.write(
    join(home, ".claude/skills/verify/SKILL.md"),
    skillFile("verify", ` ${CANARY}e`) + `password=${CANARY}f\n`,
  );
  const { json, text } = await report(home);
  expect(json.skills.length).toBeGreaterThan(0);
  expect(JSON.stringify(json)).not.toContain(CANARY);
  expect(text).not.toContain(CANARY);
  expect(text).not.toContain("Cookie");
});

const noHashes = (json: { skills: Record[] }) =>
  expect(json.skills.filter((r) => r.skill.startsWith("sha256:"))).toEqual([]);

test("a listed name with no skill on disk or in --source folds into one unrecognised entry", async () => {
  const leak = `Cookie: sid=${CANARY}g`;
  const listed = ["verify", leak, "ghost", `x${CANARY}h`.repeat(20)];
  const home = await fixture(
    ordinary.map((c) => ({ ...c, listed, skill: c.id === "a" ? leak : c.skill })),
    [],
  );
  const { json, text } = await report(home);
  expect(json.skills.map((r: Record) => r.skill)).toEqual(["deploy", "solo", "verify"]);
  noHashes(json);
  expect(json.unrecognised).toEqual({
    recognised: false,
    count: 3,
    sessionsListed: 7,
    used: 1,
    usedByUser: 0,
  });
  expect(JSON.stringify(json)).not.toContain(CANARY);
  expect(text).not.toContain(CANARY);
  expect(text).not.toContain("Cookie");
  const source = await mkdtemp(join(tmpdir(), "quench-cli-skills-source-"));
  await Bun.write(join(source, "skills/ghost/SKILL.md"), skillFile("ghost"));
  const named = (await report(home, "--source", source)).json.skills;
  expect(named.find((r: Record) => r.skill === "ghost")).toMatchObject({
    location: "recorded-only",
  });
});

test("--source validation errors name a fixed kind, never the value", async () => {
  const home = await fixture(ordinary, []);
  const source = await mkdtemp(join(tmpdir(), "quench-cli-skills-source-"));
  await Bun.write(
    join(source, "registry.yaml"),
    `skills:\n  "Cookie: sid=${CANARY}i": { path: "skills/${CANARY}j" }\n`,
  );
  const out = await quench(
    home,
    "skills",
    "--days",
    "36500",
    "--no-host-history",
    "--source",
    source,
  );
  expect(out.code).toBe(1);
  expect(out.stderr).toMatch(/^--source: invalid registry\.yaml/m);
  expect(out.stderr + out.stdout).not.toContain(CANARY);
  await Bun.write(join(source, "registry.yaml"), `skills: [${CANARY}k\n`);
  const bad = await quench(
    home,
    "skills",
    "--days",
    "36500",
    "--no-host-history",
    "--source",
    source,
  );
  expect(bad.code).toBe(1);
  expect(bad.stderr).toMatch(/^--source: unparseable registry\.yaml/m);
  expect(bad.stderr).not.toContain(CANARY);
});

async function codexSession(home: string, id: string, entries: string[]) {
  const codex = join(home, ".codex");
  const block = [
    "<skills_instructions>",
    "### Skill roots",
    `- \`r0\` = \`${join(codex, "skills")}\``,
    `- \`r1\` = \`${join(codex, "plugins/cache")}\``,
    "### Available skills",
    ...entries,
    "</skills_instructions>",
  ].join("\n");
  await Bun.write(
    join(codex, `sessions/2026/10/20/${id}.jsonl`),
    lines([
      { type: "session_meta", payload: { id, cwd: home } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: block }],
        },
      },
    ]),
  );
}

test("a recorded path that is not on disk now never becomes a location or id", async () => {
  const home = await fixture(ordinary, []);
  await Bun.write(
    join(home, ".codex/plugins/cache/debug/sample/1.0/skills/hello/SKILL.md"),
    skillFile("hello"),
  );
  await codexSession(home, "c1", [
    `- leak: Leak (file: r0/Cookie: sid=${CANARY}p/leak/SKILL.md)`,
    `- sample:hello: Hello (file: r1/debug/sample/Cookie: sid=${CANARY}q/skills/hello/SKILL.md)`,
  ]);
  const { json, text } = await report(home);
  expect(
    json.skills.filter((r: Record) => r.harness === "codex").map((r: Record) => r.skill),
  ).toEqual(["solo"]);
  noHashes(json);
  expect(json.unrecognised).toMatchObject({ recognised: false, count: 2, sessionsListed: 1 });
  expect(JSON.stringify(json)).not.toContain(CANARY);
  expect(text).not.toContain(CANARY);
});

test("a namespace is shown only when it is the installed plugin's folder", async () => {
  const home = await fixture(ordinary, []);
  await Bun.write(join(home, ".codex/skills/verify/SKILL.md"), skillFile("verify"));
  await Bun.write(
    join(home, ".codex/plugins/cache/debug/sample/1.0/skills/hello/SKILL.md"),
    skillFile("hello"),
  );
  await codexSession(home, "c1", [
    `- sk_live_${CANARY}s:verify: Verify (file: r0/verify/SKILL.md)`,
    `- other${CANARY}t:hello: Hello (file: r1/debug/sample/1.0/skills/hello/SKILL.md)`,
    "- sample:hello: Hello (file: r1/debug/sample/1.0/skills/hello/SKILL.md)",
  ]);
  const { json, text } = await report(home);
  expect(
    json.skills.filter((r: Record) => r.harness === "codex").map((r: Record) => r.skill),
  ).toEqual(["sample:hello", "solo", "verify"]);
  expect(json.unrecognised).toMatchObject({ count: 2, sessionsListed: 1 });
  noHashes(json);
  expect(JSON.stringify(json)).not.toContain(CANARY);
  expect(text).not.toContain(CANARY);
});

test("plugin skills at different version folders stay separate records", async () => {
  const home = await fixture(ordinary, []);
  const cache = join(home, ".codex/plugins/cache/debug/sample");
  await Bun.write(join(cache, "1.0/skills/hello/SKILL.md"), skillFile("hello"));
  await Bun.write(join(cache, "2.0/skills/hello/SKILL.md"), skillFile("hello", " longer"));
  await codexSession(home, "c1", [
    "- sample:hello: Hello (file: r1/debug/sample/1.0/skills/hello/SKILL.md)",
  ]);
  await codexSession(home, "c2", [
    "- sample:hello: Hello (file: r1/debug/sample/2.0/skills/hello/SKILL.md)",
  ]);
  const hello = (await report(home)).json.skills.filter((r: Record) => r.skill === "sample:hello");
  expect(hello.map((r: Record) => [r.location, r.use.sessionsListed, r.bodyBytes])).toEqual([
    ["~/.codex/plugins/cache/debug/sample/1.0/skills/hello", 1, skillFile("hello").length],
    [
      "~/.codex/plugins/cache/debug/sample/2.0/skills/hello",
      1,
      skillFile("hello", " longer").length,
    ],
  ]);
  expect(hello[0].contentVersion).not.toBe(hello[1].contentVersion);
  expect(hello.every((r: Record) => r.origin === "plugin")).toBe(true);
});

test("co-occurrence counts only the record's own sessions", async () => {
  const home = await fixture(ordinary, ["a", "c"]);
  await Bun.write(join(home, ".codex/skills/verify/SKILL.md"), skillFile("verify", " codex"));
  await codexSession(home, "c1", ["- verify: Verify (file: r0/verify/SKILL.md)"]);
  const records: Record[] = (await report(home)).json.skills;
  const codex = records.find((r) => r.skill === "verify" && r.harness === "codex")!;
  expect(codex.use.sessionsListed).toBe(1);
  expect(codex.coOccurrence).toMatchObject({ sessionsLoaded: 0, withHumanCorrection: null });
  const claude = records.find((r) => r.skill === "verify" && r.harness === "claude-code")!;
  expect(claude.coOccurrence).toMatchObject({ sessionsLoaded: 5, withHumanCorrection: 2 });
});

test("unjudged sessions are counted apart and do not reach the floor", async () => {
  const home = await fixture(ordinary, ["a"], ["e"]);
  const verify = (await report(home)).json.skills.find(
    (r: Record) => r.skill === "verify" && r.harness === "claude-code",
  );
  expect(verify.coOccurrence).toEqual({
    basis: "co-occurrence, not cause",
    sessionsLoaded: 5,
    withHumanCorrection: null,
    unjudgedSessions: 1,
    noFollowUp: 0,
  });
});

test("sessions with no human follow-up are counted apart and do not reach the floor", async () => {
  const home = await fixture(
    ordinary.map((c) => (c.skill === "verify" ? { ...c, reply: null } : c)),
    [],
  );
  const verify = (await report(home)).json.skills.find(
    (r: Record) => r.skill === "verify" && r.harness === "claude-code",
  );
  expect(verify.coOccurrence).toEqual({
    basis: "co-occurrence, not cause",
    sessionsLoaded: 5,
    withHumanCorrection: null,
    unjudgedSessions: 0,
    noFollowUp: 5,
  });
});

test("a user run after a model invocation counts as used by the user", async () => {
  const home = await fixture(
    ordinary.map((c) => (c.id === "a" ? { ...c, userRuns: true } : c)),
    [],
  );
  const verify = (await report(home)).json.skills.find(
    (r: Record) => r.skill === "verify" && r.harness === "claude-code",
  );
  expect(verify.use).toMatchObject({ used: 5, usedByUser: 1 });
});

test("--source warnings are a fixed vocabulary, never manifest text", async () => {
  const home = await fixture(ordinary, []);
  const source = await mkdtemp(join(tmpdir(), "quench-cli-skills-source-"));
  await Bun.write(join(source, "skills/verify/SKILL.md"), skillFile("verify"));
  await Bun.write(join(source, "registry.yaml"), "skills:\n  verify: { path: skills/verify }\n");
  await Bun.write(join(source, "hosts/claude-global.manifest"), "verify\n");
  await Bun.write(
    join(source, "hosts/overrides/m/claude-global.manifest"),
    `Cookie: sid=${CANARY}r\n`,
  );
  const { json, text } = await report(home, "--source", source);
  expect(json.source.warnings).toEqual([{ kind: "ignored-line", count: 1 }]);
  expect(JSON.stringify(json)).not.toContain(CANARY);
  expect(text).not.toContain(CANARY);
});

test("a load counts only toward the version whose path it read", () => {
  const v1 = "/c/plugins/cache/debug/sample/1.0/skills/hello";
  const v2 = "/c/plugins/cache/debug/sample/2.0/skills/hello";
  const listing = (folder: string) => ({
    type: "skills",
    at: null,
    chars: 1,
    listed: [{ name: "sample:hello", path: `${folder}/SKILL.md`, chars: 1 }],
  });
  const context = contextOf(
    {
      harness: "codex",
      cwd: "/",
      diagnostics: { unparsed: 0 },
      events: [
        listing(v1),
        listing(v2),
        {
          type: "tool_call",
          at: null,
          id: "1",
          name: "x",
          shell: [{ command: `cat ${v1}/SKILL.md`, workdir: "/" }],
        },
        { type: "tool_result", at: null, callId: "1", isError: null, chars: 1 },
      ],
    } as unknown as Session,
    "/home",
  );
  const of = coOccurrence([], new Map([["codex:s", context]]), new Date(0));
  expect(of("sample:hello", ["codex:s"], [v2]).sessionsLoaded).toBe(0);
  expect(of("sample:hello", ["codex:s"], [v1]).sessionsLoaded).toBe(1);
});
