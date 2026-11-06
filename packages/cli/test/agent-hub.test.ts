import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHub, stopHubs, Owner, type Running } from "../../hub/test/helpers.ts";

const main = join(import.meta.dir, "../src/main.ts");

const FLEET = `version: 1
skills:
  tidy:
    path: skills/tidy
assignments: []
`;
const TIDY = "---\nname: tidy\ndescription: Keep diffs small.\n---\n\nKeep each diff small.\n";

let root = "";
afterAll(async () => {
  await stopHubs();
  if (root) await rm(root, { recursive: true, force: true });
});

const temp = async (name: string) => {
  root ||= await mkdtemp(join(tmpdir(), "quench-agent-hub-"));
  return mkdtemp(join(root, `${name}-`));
};

async function quench(home: string, args: string[], stdin = "") {
  const proc = Bun.spawn([process.execPath, main, ...args], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: "",
      CODEX_HOME: "",
      PI_CODING_AGENT_DIR: "",
      TYPESAFE_API_KEY: "",
      QUENCH_JUDGE: "",
    },
    stdin: new TextEncoder().encode(stdin),
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

const poll = (home: string) => quench(home, ["agent", "run", "--once", "--interval", "60"]);

const installed = (home: string) => join(home, ".claude/skills/tidy/SKILL.md");

const status = async (home: string) =>
  JSON.parse(await readFile(join(home, ".quench/fleet/status.json"), "utf8"));

test("a skill toggled in the hub lands on only that machine, survives the hub going down, and staleness is reported then cleared", async () => {
  const data = join(await temp("hub"), "data");
  let running: Running = await startHub(data);
  const port = Number(running.server.port);
  const owner = new Owner(running.url, running.cert);
  await owner.login();
  const empty = await running.hub.head();
  const fleet = await running.hub.writeFile(empty, "quench-fleet.yaml", FLEET, "Add tidy");
  await running.hub.writeFile(fleet, "skills/tidy/SKILL.md", TIDY, "Add tidy v1");

  const laptop = join(await temp("laptop"), "home");
  const desktop = join(await temp("desktop"), "home");
  for (const home of [laptop, desktop]) await mkdir(home, { recursive: true });

  const line = (await owner.addMachine("laptop")).command;
  expect(line).toContain("--pin sha256:");
  const paired = await quench(laptop, ["setup", "hub"], `${line}\nn\n`);
  expect(paired.stderr).toBe("");
  expect(paired.stdout).toContain(`Connected to ${running.url} as laptop`);
  expect(paired.stdout).toContain("Next: quench agent install");
  const again = await quench(laptop, ["setup", "hub", "--yes"]);
  expect(again.stdout).toContain(`Paired with ${running.url} as laptop.`);

  const { code, pin } = await owner.addMachine("desktop");
  const connected = await quench(desktop, [
    "connect",
    running.url,
    "--code",
    code,
    ...(pin ? ["--pin", pin] : []),
  ]);
  expect(connected.code).toBe(0);

  for (const home of [laptop, desktop]) {
    const first = await poll(home);
    expect(first.code).toBe(0);
    expect(existsSync(installed(home))).toBe(false);
  }

  const toggled = await owner.post("/toggle", {
    base: await owner.head(),
    skill: "tidy",
    machine: "laptop",
    on: "1",
  });
  expect(toggled.status).toBe(303);
  const head = await running.hub.head();
  const hash = (await running.hub.repo.treeHashAt(head, "skills/tidy"))!;

  for (const home of [laptop, desktop]) expect((await poll(home)).code).toBe(0);
  expect(await readFile(installed(laptop), "utf8")).toBe(TIDY);
  expect(existsSync(installed(desktop))).toBe(false);
  expect(existsSync(join(desktop, ".codex/skills/tidy"))).toBe(false);

  const state = running.hub.store.machineState("laptop")!;
  const install = state.harnesses["claude-code"]!.snapshot.installs.find(
    (i) => i.skill === "tidy",
  )!;
  expect(install).toMatchObject({ treeHash: hash, state: "owned" });
  expect(state.skills!.records.some((r) => r.skill === "tidy")).toBe(true);
  expect(
    running.hub.store.machineState("desktop")!.harnesses["claude-code"]!.snapshot.installs,
  ).toEqual([]);
  const page = await (await owner.fetch("/")).text();
  expect(page).toContain(`claude-code: <code>${hash.slice(7, 15)}</code> matches`);
  const synced = (await status(laptop)).hub.lastSync;
  expect((await status(laptop)).snapshot.revision).toBe(head);

  await running.stop();
  const offline = await poll(laptop);
  expect(offline.code).toBe(1);
  expect(offline.stdout).toContain("hub unavailable");
  expect(offline.stdout).toContain("kept bundle sha256:");
  expect(await readFile(installed(laptop), "utf8")).toBe(TIDY);
  expect((await status(laptop)).hub.failedSince).not.toBeNull();

  running = await startHub(data, { port });
  const back = await poll(laptop);
  expect(back.code).toBe(0);
  expect(back.stdout).toContain(`caught up, stale since ${synced}`);
  expect(running.hub.store.machineState("laptop")!.staleness?.since).toBe(synced);
  expect(await (await owner.fetch("/")).text()).toContain(`stale from ${synced} until `);

  const cleared = await poll(laptop);
  expect(cleared.code).toBe(0);
  expect(cleared.stdout).not.toContain("stale since");
  expect(running.hub.store.machineState("laptop")!.staleness).toBeUndefined();
  expect(await (await owner.fetch("/")).text()).not.toContain("stale from");
  expect(await readFile(installed(laptop), "utf8")).toBe(TIDY);
}, 120_000);

test("a machine with no bundle yet and no hub applies nothing and removes nothing", async () => {
  const home = join(await temp("unpaired"), "home");
  await mkdir(join(home, ".claude/skills/mine"), { recursive: true });
  await Bun.write(join(home, ".claude/skills/mine/SKILL.md"), "# mine\n");
  const run = await poll(home);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain("not paired with a hub");
  expect(existsSync(join(home, ".claude/skills/mine/SKILL.md"))).toBe(true);
}, 60_000);
