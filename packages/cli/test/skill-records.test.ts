import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treeHash } from "@quench/fleet";
import { readTree } from "@quench/fleet/disk";
import { Jev, VerdictCache } from "@quench/judge";
import { lines, quench } from "./run.ts";

const CANARY = "QCANARY9z";

const at = (second: number) => new Date(Date.UTC(2026, 9, 20, 10, 0, second)).toISOString();

type Case = { id: string; skill: string | null; args?: string; reply: string };

const session = (c: Case) =>
  lines([
    {
      type: "attachment",
      sessionId: c.id,
      timestamp: at(0),
      attachment: {
        type: "skill_listing",
        names: ["verify", "deploy"],
        content: "- verify\n- deploy",
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
    { type: "user", timestamp: at(5), message: { role: "user", content: c.reply } },
  ]);

const skillFile = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: ${name} things${extra}\n---\nBody of ${name}.\n`;

async function fixture(cases: Case[], corrected: string[]) {
  const home = await mkdtemp(join(tmpdir(), "quench-cli-skills-"));
  for (const name of ["verify", "deploy"])
    await Bun.write(join(home, ".claude/skills", name, "SKILL.md"), skillFile(name));
  await Bun.write(join(home, ".codex/skills/solo/SKILL.md"), skillFile("solo"));
  const dir = join(home, ".claude/projects/demo");
  await mkdir(dir, { recursive: true });
  const cache = await VerdictCache.open(join(home, ".quench/local"), Jev.id);
  for (const c of cases) {
    await Bun.write(join(dir, `${c.id}.jsonl`), session(c));
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
    id: "verify|claude-code|~/.claude/skills/verify",
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
  expect(verify.contentVersion).toBe(treeHash(await readTree(join(home, ".claude/skills/verify"))));
  const deploy = records.find((r) => r.skill === "deploy")!;
  expect(deploy.coOccurrence).toMatchObject({ sessionsLoaded: 1, withHumanCorrection: null });
  const solo = records.find((r) => r.skill === "solo")!;
  expect(solo).toMatchObject({
    harness: "codex",
    origin: "user",
    use: { sessionsListed: null, used: null, usedByUser: null, lowerBound: true },
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
