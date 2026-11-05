import { afterAll, expect, test } from "bun:test";
import {
  cleanup,
  claude,
  git,
  link,
  planAndApply,
  setup,
  V1,
  V2,
  windows,
  writeSource,
} from "./fleet-scratch.ts";
import { lstat, mkdir, readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { installations } from "@quench/fleet";
import { readJournal, readLedger } from "@quench/fleet/apply";
import { Home } from "@quench/history";
import {
  agentCycle,
  agentInstall,
  agentUninstall,
  serviceFor,
  statusFile,
} from "../src/commands/agent.ts";
import { skillsApply, skillsPlan, skillsStatus, stateDir } from "../src/commands/skills.ts";

afterAll(cleanup);

const leftovers = async (home: Home) =>
  (await readdir(join(home.dir, ".claude/skills"))).filter((n) => n.startsWith(".quench"));

test("apply installs whole skill folders into every harness and records sequence, tree hash and time", async () => {
  const { home, options } = await setup();
  const plan = await skillsPlan(home, options);
  expect(plan.counts.install).toBe(6);
  const outcome = await skillsApply(home, { ...options, planHash: plan.hash! });
  expect(outcome.applied).toHaveLength(6);
  expect(outcome.conflicts).toEqual([]);
  for (const root of [".claude/skills", ".codex/skills", ".pi/agent/skills"]) {
    expect(await readFile(join(home.dir, root, "alpha/SKILL.md"), "utf8")).toBe("# alpha v1\n");
    expect(await readFile(join(home.dir, root, "beta/notes/a.md"), "utf8")).toBe("beta notes\n");
    if (!windows)
      expect((await stat(join(home.dir, root, "alpha/run.sh"))).mode & 0o111).toBeTruthy();
  }
  const ledger = await readLedger(stateDir(home));
  expect(ledger.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(
    ledger.every((e) => e.kind === "install" && e.appliedAt && e.treeHash.startsWith("sha256:")),
  ).toBe(true);
  const status = await skillsStatus(home, options);
  expect(status.conflicts).toEqual([]);
  expect(status.drift).toEqual([]);
  expect(status.installations.filter((i) => i.to === null)).toHaveLength(6);
  expect(await leftovers(home)).toEqual([]);
});

test("apply refuses a plan hash once disk has changed since the plan", async () => {
  const { home, options } = await setup();
  const plan = await skillsPlan(home, options);
  await mkdir(dirname(claude(home, "alpha")), { recursive: true });
  await writeFile(claude(home, "alpha"), "mine\n");
  const refused = await skillsApply(home, { ...options, planHash: plan.hash! }).catch(
    (e: Error) => e,
  );
  expect((refused as Error).message).toContain("changed since plan");
  expect(await readFile(claude(home, "alpha"), "utf8")).toBe("mine\n");
  expect(await readLedger(stateDir(home))).toEqual([]);
});

test("foreign and locally edited folders are conflicts and are never overwritten or removed", async () => {
  const { home, source, options } = await setup();
  await mkdir(dirname(claude(home, "alpha")), { recursive: true });
  await writeFile(claude(home, "alpha"), "someone else's\n");
  const first = await planAndApply(home, options);
  expect(first.conflicts).toEqual([
    {
      path: "~/.claude/skills/alpha",
      reason: "installed folder differs and Quench did not write it",
    },
  ]);
  expect(first.applied).toHaveLength(5);
  expect(await readFile(claude(home, "alpha"), "utf8")).toBe("someone else's\n");

  await writeFile(claude(home, "beta"), "edited by hand\n");
  await writeSource(source, V2, [{ skill: "alpha" }]);
  const second = await planAndApply(home, options);
  expect(second.conflicts.map((c) => c.path)).toEqual([
    "~/.claude/skills/alpha",
    "~/.claude/skills/beta",
  ]);
  expect(second.conflicts[1]?.reason).toBe("edited since Quench wrote it");
  expect(await readFile(claude(home, "beta"), "utf8")).toBe("edited by hand\n");
  expect(await lstat(join(home.dir, ".codex/skills/beta")).catch(() => null)).toBeNull();
  expect(await readFile(join(home.dir, ".codex/skills/alpha/SKILL.md"), "utf8")).toBe(
    "# alpha v2\n",
  );
  const status = await skillsStatus(home, options);
  expect(status.conflicts).toHaveLength(2);
});

for (const step of ["staged", "backed-up", "swapped", "committed"] as const)
  test(`an apply interrupted after "${step}" is recovered by the next apply`, async () => {
    const { home, source, options } = await setup();
    await planAndApply(home, options);
    await writeSource(source, V2, [
      { skill: "alpha", harnesses: ["claude-code"] },
      { skill: "beta" },
    ]);
    const plan = await skillsPlan(home, options);
    const killed = await skillsApply(
      home,
      { ...options, planHash: plan.hash! },
      {
        interrupt: (at) => {
          if (at === step) throw new Error("killed");
        },
      },
    ).catch((e: Error) => e);
    expect((killed as Error).message).toBe("killed");
    expect(await readJournal(stateDir(home))).not.toBeNull();
    const pending = await skillsStatus(home, options);
    expect(pending.interrupted).toContain("alpha");

    const next = await skillsPlan(home, options);
    expect(next.warnings.join()).toContain("interrupted");
    const retried = await skillsApply(home, { ...options, planHash: next.hash! }).catch(
      (e: Error) => e,
    );
    if (retried instanceof Error) expect(retried.message).toContain("recovered an interrupted");
    expect(await readJournal(stateDir(home))).toBeNull();
    const done = await planAndApply(home, options);
    expect(done.conflicts).toEqual([]);
    expect(await readFile(claude(home, "alpha"), "utf8")).toBe("# alpha v2\n");
    expect(await leftovers(home)).toEqual([]);
    const status = await skillsStatus(home, options);
    expect(status.drift).toEqual([]);
    expect(status.conflicts).toEqual([]);
  });

test("applying an earlier source rolls back and the ledger keeps every interval and prior hash", async () => {
  const { home, source, options } = await setup(V1, [
    { skill: "alpha", harnesses: ["claude-code"] },
  ]);
  await planAndApply(home, options);
  const v1 = (await skillsPlan(home, options)).items[0]!.desired!;
  await writeSource(source, V2, [{ skill: "alpha", harnesses: ["claude-code"] }]);
  await planAndApply(home, options);
  expect(await readFile(claude(home, "alpha"), "utf8")).toBe("# alpha v2\n");
  const v2 = (await skillsPlan(home, options)).items[0]!.desired!;
  await writeSource(source, V1, [{ skill: "alpha", harnesses: ["claude-code"] }]);
  const back = await planAndApply(home, options);
  expect(back.applied).toEqual([{ path: "~/.claude/skills/alpha", action: "update" }]);
  expect(await readFile(claude(home, "alpha"), "utf8")).toBe("# alpha v1\n");
  const spans = installations(await readLedger(stateDir(home)));
  expect(spans.map((s) => s.treeHash)).toEqual([v1, v2, v1]);
  expect(spans.map((s) => s.to === null)).toEqual([false, false, true]);

  await writeSource(source, V1, []);
  const removed = await planAndApply(home, options);
  expect(removed.applied).toEqual([{ path: "~/.claude/skills/alpha", action: "remove" }]);
  expect(await lstat(join(home.dir, ".claude/skills/alpha")).catch(() => null)).toBeNull();
  expect(installations(await readLedger(stateDir(home))).every((s) => s.to !== null)).toBe(true);
});

test("a symlink left by another linker is a conflict and apply refuses to take the folder", async () => {
  const { dir, home, source, options } = await setup();
  const linker = join(dir, "linker-checkout", "alpha");
  await mkdir(linker, { recursive: true });
  await writeFile(join(linker, "SKILL.md"), "# alpha v1\n");
  await mkdir(join(home.dir, ".claude/skills"), { recursive: true });
  await link(linker, join(home.dir, ".claude/skills/alpha"));
  const outcome = await planAndApply(home, options);
  const conflict = outcome.conflicts.find((c) => c.path === "~/.claude/skills/alpha");
  expect(conflict?.reason).toContain("managed by another writer");
  expect((await lstat(join(home.dir, ".claude/skills/alpha"))).isSymbolicLink()).toBe(true);
  expect(await readFile(join(linker, "SKILL.md"), "utf8")).toBe("# alpha v1\n");

  const piRoot = join(home.dir, ".pi/agent/skills");
  const linkedRoot = join(dir, "linker-root");
  await mkdir(linkedRoot, { recursive: true });
  await rm(piRoot, { recursive: true, force: true });
  await link(linkedRoot, piRoot);
  await writeSource(source, V2, [{ skill: "alpha" }, { skill: "beta" }]);
  const second = await planAndApply(home, options);
  expect(second.conflicts.filter((c) => c.path?.startsWith("~/.pi/")).map((c) => c.reason)).toEqual(
    [expect.stringContaining("another writer"), expect.stringContaining("another writer")],
  );
  expect(await readlink(piRoot)).toBeTruthy();
  const status = await skillsStatus(home, options);
  expect(status.conflicts.length).toBeGreaterThan(0);
});

test("project installs go into the checkout, add a .git/info/exclude entry and record it", async () => {
  const { dir, home, options } = await setup(V1, [
    { skill: "alpha", harnesses: ["claude-code"], remote: "github.com/acme/app" },
  ]);
  const checkout = join(dir, "app");
  await mkdir(checkout, { recursive: true });
  await git(checkout, "init", "-q");
  await git(checkout, "remote", "add", "origin", "git@github.com:Acme/app.git");
  const withProject = { ...options, projects: [checkout] };
  expect((await skillsPlan(home, options)).counts.unresolved).toBe(1);
  const outcome = await planAndApply(home, withProject);
  expect(outcome.applied).toHaveLength(1);
  expect(await readFile(join(checkout, ".claude/skills/alpha/SKILL.md"), "utf8")).toBe(
    "# alpha v1\n",
  );
  const exclude = join(checkout, ".git/info/exclude");
  expect((await readFile(exclude, "utf8")).split("\n")).toContain("/.claude/skills/alpha/");
  const [entry] = await readLedger(stateDir(home));
  expect(entry?.gitExclude).toBe("/.claude/skills/alpha/");
  expect(entry?.location).toMatchObject({ scope: "project", remote: "github.com/acme/app" });

  await writeSource(options.source, V1, []);
  const removed = await planAndApply(home, withProject);
  expect(removed.applied.map((a) => a.action)).toEqual(["remove"]);
  expect(await lstat(join(checkout, ".claude/skills/alpha")).catch(() => null)).toBeNull();
  expect((await readFile(exclude, "utf8")).split("\n")).not.toContain("/.claude/skills/alpha/");
});

test("Codex [[skills.config]] entries are reported, folders are installed, config.toml is never edited", async () => {
  const { home, options } = await setup();
  const config = join(home.dir, ".codex/config.toml");
  const text = `[[skills.config]]\npath = "/elsewhere/alpha"\nenabled = true\n\n[[skills.config]]\npath = "/elsewhere/beta"\nenabled = true\n`;
  await mkdir(dirname(config), { recursive: true });
  await writeFile(config, text);
  const outcome = await planAndApply(home, options);
  expect(outcome.notes).toEqual([expect.stringContaining("codex: 2 [[skills.config]] entries")]);
  expect(await readFile(join(home.dir, ".codex/skills/alpha/SKILL.md"), "utf8")).toBe(
    "# alpha v1\n",
  );
  expect(await readFile(config, "utf8")).toBe(text);
  expect((await skillsStatus(home, options)).notes).toHaveLength(1);
});

test("an agent cycle applies the source and writes a snapshot status file with a rising generation", async () => {
  const { home, source, options } = await setup();
  const first = await agentCycle(home, options);
  expect(first.error).toBeNull();
  expect(first.applied).toHaveLength(6);
  await writeSource(source, V2, [{ skill: "alpha" }, { skill: "beta" }]);
  const second = await agentCycle(home, options);
  expect(second.applied.map((a) => a.action)).toEqual(["update", "update", "update"]);
  const status = JSON.parse(await readFile(statusFile(home), "utf8"));
  expect(status.snapshot.generation).toBe(2);
  expect(status.snapshot.harnesses["claude-code"].complete).toBe(true);
  expect(
    status.snapshot.harnesses["claude-code"].installs.map((i: { state: string }) => i.state),
  ).toEqual(["owned", "owned"]);
});

test("agent service definitions restart the agent and never call update", async () => {
  const home = new Home("/home/u", {});
  const argv = ["/opt/quench", "agent", "run", "--source", "/src dir", "--machine", "m"];
  const linux = serviceFor("linux", home, argv, { uid: 1000, user: "u" });
  expect(linux.contents).toContain(
    'ExecStart=/opt/quench agent run --source "/src dir" --machine m',
  );
  expect(linux.contents).toContain("Restart=always");
  const mac = serviceFor("darwin", home, argv, { uid: 501, user: "u" });
  expect(mac.file.replaceAll("\\", "/")).toBe("/home/u/Library/LaunchAgents/sh.quench.agent.plist");
  expect(mac.contents).toContain("<key>KeepAlive</key>");
  expect(mac.install).toEqual([["launchctl", "bootstrap", "gui/501", mac.file]]);
  const win = serviceFor("win32", home, argv, { uid: 0, user: "PC\\u" });
  const xml = Buffer.from(win.contents as Uint8Array).toString("utf16le");
  expect(xml).toContain("<LogonTrigger>");
  expect(xml).toContain("<RestartOnFailure>");
  expect(xml).toContain(
    "<Arguments>agent run --source &quot;/src dir&quot; --machine m</Arguments>",
  );
  for (const service of [linux, mac, win])
    expect(JSON.stringify(service).includes(" update")).toBe(false);
});

test("agent install writes the unit into the user's home, enables it and warns when linger is off", async () => {
  const { home, options } = await setup();
  const ran: string[][] = [];
  const run = async (command: string[]) => {
    ran.push(command);
    return { code: 0, output: command[0] === "loginctl" ? "no" : "" };
  };
  const { file, warnings } = await agentInstall(
    home,
    { ...options, interval: 60, homeFlags: [] },
    run,
    "linux",
  );
  expect(file).toBe(join(home.dir, ".config/systemd/user/quench-agent.service"));
  expect(await readFile(file, "utf8")).toContain(`--source ${options.source}`.split(" ")[0]!);
  expect(ran.slice(0, 2)).toEqual([
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", "quench-agent.service"],
  ]);
  expect(warnings.join()).toContain("linger is off");
  await agentUninstall(home, run, "linux");
  expect(await lstat(file).catch(() => null)).toBeNull();
});
