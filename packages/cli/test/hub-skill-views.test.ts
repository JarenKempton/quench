import { afterAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Snapshot } from "@quench/fleet";
import { Home } from "@quench/history";
import { clientDir, pair, postSnapshot } from "@quench/hub/client";
import { Jev, VerdictCache } from "@quench/judge";
import { Owner, startHub, type Running } from "../../hub/test/helpers.ts";
import { agentCycle } from "../src/commands/agent.ts";
import { cleanup, temp } from "./fleet-scratch.ts";
import { lines } from "./run.ts";

afterAll(cleanup);

const DAY = 86_400_000;
const NOW = Date.now();
const T1 = NOW - 20 * DAY;
const T2 = NOW - 10 * DAY;
const SECRET_REPLY = "QCANARY-reply-text";
const SECRET_PROMPT = "QCANARY-prompt-text";

const FLEET = `version: 1
skills:
  tidy:
    path: skills/tidy
assignments:
  - skill: tidy
    target: { kind: all }
    scope: { kind: global }
    harnesses: all
    mode: include
`;
const V1 = "---\nname: tidy\ndescription: Keep diffs small.\n---\n\nKeep each diff small.\n";
const V2 = `${V1}Also rename every variable you touch.\n`;

type Kind = "correction" | "approval" | null;
type Case = { id: string; at: number; loads: boolean; verdict: Kind };

const iso = (ms: number) => new Date(ms).toISOString();

const session = (c: Case) =>
  lines([
    {
      type: "attachment",
      sessionId: c.id,
      timestamp: iso(c.at),
      attachment: { type: "skill_listing", names: ["tidy"], content: "- tidy" },
    },
    {
      type: "user",
      timestamp: iso(c.at + 1000),
      message: { role: "user", content: SECRET_PROMPT },
    },
    {
      type: "assistant",
      timestamp: iso(c.at + 2000),
      message: {
        id: `${c.id}-m1`,
        model: "model-x",
        content: c.loads
          ? [{ type: "tool_use", id: `${c.id}-skill`, name: "Skill", input: { skill: "tidy" } }]
          : [{ type: "text", text: "working" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      type: "assistant",
      timestamp: iso(c.at + 4000),
      message: {
        id: `${c.id}-m2`,
        model: "model-x",
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      type: "user",
      timestamp: iso(c.at + 5000),
      message: { role: "user", content: `${SECRET_REPLY} ${c.id}` },
    },
  ]);

function cases(machine: string): Case[] {
  const out: Case[] = [];
  const add = (start: number, n: number, loads: boolean, verdicts: Kind[]) => {
    for (let i = 0; i < n; i++)
      out.push({
        id: `${machine}-${out.length}`,
        at: start + i * 3_600_000,
        loads,
        verdict: i < verdicts.length ? verdicts[i]! : "approval",
      });
  };
  add(T1 + DAY, 6, true, ["correction"]);
  add(T1 + 2 * DAY, 2, false, []);
  add(T2 + DAY, 6, true, ["correction", "correction", "correction", null]);
  add(T2 + 2 * DAY, 2, false, ["correction"]);
  return out;
}

async function writeSessions(home: Home, machine: string) {
  const dir = join(home.dir, ".claude/projects/demo");
  await mkdir(dir, { recursive: true });
  const cache = await VerdictCache.open(join(home.dir, ".quench/local"), Jev.id);
  for (const c of cases(machine)) {
    await Bun.write(join(dir, `${c.id}.jsonl`), session(c));
    if (c.verdict)
      await cache.remember([
        [
          { assistantSaid: "done", reply: `${SECRET_REPLY} ${c.id}` },
          { kind: c.verdict, sender: "person", confidence: 1 },
        ],
      ]);
  }
}

let running: Running | null = null;
afterAll(async () => {
  await running?.stop();
});

const short = (hash: string) => hash.slice(7, 15);

test("two machines: snapshot records reach the grid, and a version card shows only above the floor", async () => {
  running = await startHub(await temp("hub-data"));
  const { hub } = running;
  const owner = new Owner(running.url, running.cert);
  await owner.login();
  const empty = await hub.head();
  const fleetCommit = await hub.writeFile(empty, "quench-fleet.yaml", FLEET, "Add tidy");
  await hub.writeFile(fleetCommit, "skills/tidy/SKILL.md", V1, "Add tidy v1");

  const machines = ["laptop", "desktop"] as const;
  const homes = new Map<string, Home>();
  for (const machine of machines) {
    const home = new Home(join(await temp(machine), "home"), {});
    await mkdir(home.dir, { recursive: true });
    homes.set(machine, home);
    const { code, pin } = await owner.addMachine(machine);
    await pair(clientDir(home.dir), { url: running.url, code, ...(pin ? { pin } : {}) });
    const v1 = await agentCycle(
      home,
      { source: await hub.checkout(await hub.head()), machine },
      { now: () => iso(T1) },
    );
    expect(v1.error).toBeNull();
    expect(v1.applied).toHaveLength(3);
  }

  const path = "skills/tidy/SKILL.md";
  const base = await owner.head();
  const preview = await (
    await owner.post("/edit", { path, base, content: V2, action: "preview" })
  ).text();
  const previewed = /name="previewed" value="([0-9a-f]{64})"/.exec(preview)![1]!;
  const saved = await owner.post("/edit", { path, base, content: V2, previewed, action: "save" });
  expect(saved.status).toBe(303);
  const v2Commit = await hub.head();

  for (const machine of machines) {
    const home = homes.get(machine)!;
    const v2 = await agentCycle(
      home,
      { source: await hub.checkout(v2Commit), machine },
      { now: () => iso(T2) },
    );
    expect(v2.applied.map((a) => a.action)).toEqual(["update", "update", "update"]);
    await writeSessions(home, machine);
  }

  const snapshots = new Map<string, Snapshot>();
  for (const machine of machines) {
    const home = homes.get(machine)!;
    const status = await agentCycle(home, { source: await hub.checkout(v2Commit), machine });
    expect(status.skillsError).toBeNull();
    const snapshot = Snapshot.parse(status.snapshot);
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain("QCANARY");
    expect(text).not.toContain("Keep each diff small");
    const record = snapshot.skills!.records.find(
      (r) => r.skill === "tidy" && r.harness === "claude-code",
    )!;
    expect(record.location).toBe("~/.claude/skills/tidy");
    expect(record.coOccurrence.sessionsLoaded).toBe(12);
    expect(record.versions!.map((v) => [v.from, v.to])).toEqual([
      [iso(T1), iso(T2)],
      [iso(T2), null],
    ]);
    expect(record.versions![0]!.loaded).toEqual({
      sessions: 6,
      judged: 6,
      withHumanCorrection: 1,
      unjudged: 0,
      noFollowUp: 0,
    });
    expect(record.versions![1]!.loaded).toEqual({
      sessions: 6,
      judged: 5,
      withHumanCorrection: 3,
      unjudged: 1,
      noFollowUp: 0,
    });
    expect(record.versions![1]!.without).toEqual({
      sessions: 2,
      judged: 2,
      withHumanCorrection: 1,
      unjudged: 0,
      noFollowUp: 0,
    });
    snapshots.set(machine, snapshot);
  }
  const [before, after] = snapshots
    .get("laptop")!
    .skills!.records.find((r) => r.harness === "claude-code")!
    .versions!.map((v) => v.treeHash);

  await postSnapshot(clientDir(homes.get("laptop")!.dir), snapshots.get("laptop")!);
  const one = await (await owner.fetch("/")).text();
  expect(one).toContain("<h2>Skills by machine</h2>");
  expect(one).toMatch(/<th>laptop<br><small>seen \d{4}-/);
  expect(one).toContain(`desired <code>${short(after!)}</code>`);
  expect(one).toContain(`claude-code: <code>${short(after!)}</code> matches`);
  expect(one).toContain("listed 16 · used 12 · loaded 12 · corrected 4");
  expect(one).toContain("claude-code: not reported");
  expect(one).toContain(
    `tidy <code>${short(before!)}</code> → <code>${short(after!)}</code></h3><p>not enough sessions (6)</p>`,
  );
  expect(one).not.toContain("Loaded it, before");

  await postSnapshot(clientDir(homes.get("desktop")!.dir), snapshots.get("desktop")!);
  const both = await (await owner.fetch("/")).text();
  expect(both).not.toContain("not enough sessions");
  expect(both).toContain('<p class="basis">co-occurrence, not cause</p>');
  expect(both).toContain(
    "Same machines and harnesses: desktop (claude-code), laptop (claude-code)</p>",
  );
  expect(both).toContain(
    "<tr><th>Loaded it, before</th><td>12</td><td>12 (100%)</td><td>2 of 12 judged (17%)</td><td>0</td><td>0</td></tr>",
  );
  expect(both).toContain(
    "<tr><th>Loaded it, after</th><td>12</td><td>10 (83%)</td><td>6 of 10 judged (60%)</td><td>2</td><td>0</td></tr>",
  );
  expect(both).toContain(
    "<tr><th>Without it, after</th><td>4</td><td>4 (100%)</td><td>2 of 4 judged (50%)</td><td>0</td><td>0</td></tr>",
  );
  expect(both).toContain('<span class="add">+Also rename every variable you touch.</span>');
  expect(both).toContain("Nothing here is applied automatically.");
  expect(both).toContain("Do not apply anything.");
  expect(both).not.toContain("QCANARY");
  expect(await hub.head()).toBe(v2Commit);

  const form = new RegExp(
    `<form method="post" action="/revert"><input type="hidden" name="csrf" value="[^"]+"><input type="hidden" name="base" value="([0-9a-f]{40})"><input type="hidden" name="commit" value="${v2Commit}"><button>Revert commit ${v2Commit.slice(0, 12)}</button>`,
  ).exec(both);
  expect(form).not.toBeNull();
  const reverted = await owner.post("/revert", { base: form![1]!, commit: v2Commit });
  expect(reverted.status).toBe(303);
  expect(await hub.repo.show(await hub.head(), path)).toBe(V1);
  const after_revert = await (await owner.fetch("/")).text();
  expect(after_revert).toContain(`desired <code>${short(before!)}</code>`);
  expect(after_revert).toContain(
    `claude-code: <code>${short(after!)}</code> <span class="warn">differs</span>`,
  );
  expect(after_revert).toContain("No single hub commit made this change at HEAD");
}, 60_000);
