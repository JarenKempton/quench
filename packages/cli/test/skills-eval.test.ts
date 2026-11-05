import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treeHash } from "@quench/fleet";
import { readTree } from "@quench/fleet/disk";
import { evalSupported } from "../src/skills/eval.ts";
import { lines } from "./run.ts";

const main = join(import.meta.dir, "../src/main.ts");
const windows = process.platform === "win32";
const CANARY = "QCANARY7e";
const scratch: string[] = [];
afterAll(() => Promise.all(scratch.map((d) => rm(d, { recursive: true, force: true }))));

const temp = async (name: string) => {
  const dir = await mkdtemp(join(tmpdir(), `quench-eval-test-${name}-`));
  scratch.push(dir);
  return dir;
};

const FAKE = (log: string) => `#!/usr/bin/env bun
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const prompt = await new Response(Bun.stdin.stream()).text();
const config = process.env.CLAUDE_CONFIG_DIR;
const [name] = readdirSync(join(config, "skills"));
const body = readFileSync(join(config, "skills", name, "SKILL.md"), "utf8");
const mode = (p) => (statSync(p).mode & 0o777).toString(8);
const modes = [join(config, ".."), config, process.env.HOME, process.cwd()].map(mode);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, home: process.env.HOME, config, cwd: process.cwd(), envKeys: Object.keys(process.env).sort(), name, modes }) + "\\n");
const at = (i) => argv[argv.indexOf(i) + 1];
const settings = JSON.parse(at("--settings"));
const plugins = prompt.includes("leak plugin") ? [{ name: "stray" }] : Object.values(settings.enabledPlugins).some(Boolean) ? [{ name: "builtin" }] : [];
const out = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
out({ type: "system", subtype: "init", tools: at("--tools").split(","), mcp_servers: [], plugins, skills: [name] });
if (prompt.includes("hang")) {
  appendFileSync(${JSON.stringify(log)}.replace(/jsonl$/, "hang"), JSON.stringify({ pid: process.pid, config }) + "\\n");
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
const triggered = body.includes("TRIGGERS") && prompt.includes("zebra");
if (triggered) out({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Skill", input: { skill: name } }] } });
if (triggered && prompt.includes("deny")) out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "Permission to use Bash has been denied." }] } });
out({ type: "assistant", message: { content: [{ type: "text", text: "reply about " + prompt }] } });
out({ type: "result", subtype: "success", is_error: false, result: "answer to " + prompt, total_cost_usd: prompt.includes("costly") ? 0.75 : 0.001, usage: { input_tokens: 10, cache_read_input_tokens: 1000 + (triggered ? body.length : 0), cache_creation_input_tokens: 0, output_tokens: 20 } });
`;

const at = (day: number, second = 0) =>
  new Date(Date.UTC(2026, 9, day, 10, 0, second)).toISOString();

const session = (id: string, day: number, prompts: { text: string; skill: string | null }[]) =>
  lines([
    {
      type: "attachment",
      sessionId: id,
      timestamp: at(day),
      attachment: { type: "skill_listing", names: ["zebra"], content: "- zebra" },
    },
    ...prompts.flatMap((p, i) => [
      { type: "user", timestamp: at(day, 10 * i + 1), message: { role: "user", content: p.text } },
      {
        type: "assistant",
        timestamp: at(day, 10 * i + 2),
        message: {
          id: `${id}-m${i}`,
          model: "claude-haiku-5-5",
          content: [
            ...(p.skill
              ? [{ type: "tool_use", id: `${id}-s${i}`, name: "Skill", input: { skill: p.skill } }]
              : []),
            { type: "text", text: `original reply ${i}` },
          ],
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      },
    ]),
  ]);

const LONG_BODY = `---\nname: zebra\ndescription: Use for anything about zebras.\n---\nTRIGGERS\n${"Zebra facts. ".repeat(400)}\n`;
const SHORT_BODY = `---\nname: zebra\ndescription: Use for anything about zebras.\n---\nTRIGGERS\nShort.\n`;

async function fixture(
  prompts: { id: string; day: number; text: string; skill: string | null; later?: string }[],
) {
  const root = await temp("root");
  const home = join(root, "home");
  await Bun.write(join(home, ".claude/skills/zebra/SKILL.md"), LONG_BODY);
  const hash = treeHash(await readTree(join(home, ".claude/skills/zebra")));
  await Bun.write(
    join(home, ".quench/fleet/ledger.json"),
    JSON.stringify([
      {
        path: "~/.claude/skills/zebra",
        skill: "zebra",
        treeHash: hash,
        executables: [],
        harness: "claude-code",
        location: { scope: "global" },
        kind: "install",
        sequence: 1,
        appliedAt: at(10),
        gitExclude: null,
      },
    ]),
  );
  const dir = join(home, ".claude/projects/demo");
  await mkdir(dir, { recursive: true });
  for (const p of prompts)
    await Bun.write(
      join(dir, `${p.id}.jsonl`),
      session(p.id, p.day, [
        { text: p.text, skill: p.later ? null : p.skill },
        ...(p.later ? [{ text: "second prompt", skill: p.later }] : []),
      ]),
    );
  const candidate = join(root, "candidate");
  await Bun.write(join(candidate, "SKILL.md"), SHORT_BODY);
  const bin = join(root, "bin");
  const log = join(root, "claude-calls.jsonl");
  await Bun.write(join(bin, "claude"), FAKE(log));
  await chmod(join(bin, "claude"), 0o755);
  return { root, home, candidate, bin, log };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function evalRun(f: Fixture, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", main, "skills", "eval", ...args], {
    env: {
      PATH: `${f.bin}:${process.env.PATH}`,
      HOME: f.home,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      ANTHROPIC_API_KEY: "sk-test-not-real",
      ...env,
    },
    stdin: "ignore",
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

const calls = async (log: string) =>
  (await Bun.file(log).exists())
    ? (await Bun.file(log).text())
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];

async function listing(home: string): Promise<string[]> {
  const out: string[] = [];
  for (const dir of [join(home, ".claude"), join(home, ".quench")])
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true }))
      if (entry.isFile()) {
        const path = join(entry.parentPath, entry.name);
        out.push(`${path}:${(await stat(path)).mtimeMs}`);
      }
  return out.sort();
}

const STANDARD = [
  { id: "s1", day: 20, text: `tell me about zebra stripes ${CANARY}`, skill: "zebra" },
  { id: "s2", day: 21, text: "what do zebra foals eat", skill: "zebra" },
  { id: "s3", day: 22, text: "striped horses of africa", skill: "zebra" },
  { id: "s4", day: 23, text: "zebra crossing rules", skill: null },
  { id: "s5", day: 24, text: "zebra migration", skill: null, later: "zebra" },
  { id: "s6", day: 5, text: "zebra before the ledger", skill: "zebra" },
];

test("support is Linux and macOS only", () => {
  expect(evalSupported("linux")).toBe(true);
  expect(evalSupported("darwin")).toBe(true);
  expect(evalSupported("win32")).toBe(false);
});

test.if(windows)("Windows returns an unsupported result and runs nothing", async () => {
  const f = await fixture(STANDARD);
  const out = await evalRun(f, ["zebra", "--candidate", f.candidate, "--yes", "--json"]);
  expect(out.code).toBe(2);
  expect(JSON.parse(out.stdout)).toMatchObject({ supported: false, platform: "win32" });
});

test.skipIf(windows)(
  "replays first prompts on the installed version and the candidate in scratch homes",
  async () => {
    const f = await fixture(STANDARD);
    const before = await listing(f.home);
    const out = await evalRun(f, ["zebra", "--candidate", f.candidate, "--yes", "--json"]);
    expect(out.stderr).toContain("Replays send each prompt");
    expect(out.stderr).toContain("Estimate: ~");
    expect(out.code).toBe(0);
    expect(out.stdout).not.toContain(CANARY);
    expect(out.stdout).not.toContain("answer to");
    const result = JSON.parse(out.stdout);
    expect(result.selection).toEqual({
      sessionsRead: 6,
      notCurrentVersion: 1,
      notTriggered: 2,
      prompts: 3,
    });
    expect(result.prompts.map((p: { session: string }) => p.session)).toEqual(["s3", "s2", "s1"]);
    expect(result.prompts.map((p: { outcome: string }) => p.outcome)).toEqual([
      "excluded",
      "win",
      "win",
    ]);
    expect(result.summary).toMatchObject({ wins: 2, losses: 0, ties: 0, excluded: 1, failed: 0 });
    expect(result.summary.exclusionRate).toBeCloseTo(1 / 3);
    expect(result.summary.spentUsd).toBeCloseTo(0.006);
    expect(result.prompts[1].current).toMatchObject({ triggered: true, costUsd: 0.001 });

    const seen = await calls(f.log);
    expect(seen).toHaveLength(6);
    for (const call of seen) {
      expect(call.argv).toEqual(
        expect.arrayContaining(["-p", "--no-session-persistence", "--strict-mcp-config"]),
      );
      expect(call.argv[call.argv.indexOf("--tools") + 1]).toBe("Skill");
      expect(call.argv[call.argv.indexOf("--setting-sources") + 1]).toBe("user");
      expect(JSON.parse(call.argv[call.argv.indexOf("--settings") + 1])).toMatchObject({
        disableAllHooks: true,
      });
      expect(call.argv[call.argv.indexOf("--model") + 1]).toBe("claude-haiku-5-5");
      expect(call.home.startsWith(f.home)).toBe(false);
      expect(call.config.startsWith(f.home)).toBe(false);
      expect(call.config.includes("quench-eval-")).toBe(true);
      expect(call.name).toBe("zebra");
      expect(call.modes).toEqual(["700", "700", "700", "700"]);
      expect(await stat(call.config).catch(() => null)).toBeNull();
    }
    expect(await listing(f.home)).toEqual(before);
  },
);

test.skipIf(windows)("the text view shows the three columns side by side", async () => {
  const f = await fixture(STANDARD.slice(0, 2));
  const out = await evalRun(f, ["zebra", "--candidate", f.candidate, "--yes"]);
  expect(out.code).toBe(0);
  expect(out.stdout).toContain("original (recorded)");
  expect(out.stdout).toMatch(
    /original \(recorded\)\s+│ current [0-9a-f]{12}\s+│ candidate [0-9a-f]{12}/,
  );
  expect(out.stdout).toContain(`prompt: tell me about zebra stripes ${CANARY}`);
  expect(out.stdout).toContain("Wins 2 · losses 0 · ties 0");
  expect(out.stdout).toContain("exclusion rate 0%");
});

test.skipIf(windows)("nothing runs without confirmation", async () => {
  const f = await fixture(STANDARD);
  const out = await evalRun(f, ["zebra", "--candidate", f.candidate]);
  expect(out.code).toBe(1);
  expect(out.stderr).toContain("Run these replays?");
  expect(out.stderr).toContain("Not run.");
  expect(await calls(f.log)).toHaveLength(0);
});

test.skipIf(windows)("refuses without a credential the scratch home can use", async () => {
  const f = await fixture(STANDARD);
  const out = await evalRun(f, ["zebra", "--candidate", f.candidate, "--yes"], {
    ANTHROPIC_API_KEY: "",
  });
  expect(out.code).toBe(1);
  expect(out.stderr).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  expect(await calls(f.log)).toHaveLength(0);
});

test.skipIf(windows)("hard caps on prompts and spend", async () => {
  const f = await fixture(STANDARD);
  const many = await evalRun(f, ["zebra", "--candidate", f.candidate, "--yes", "--limit", "21"]);
  expect(many.code).toBe(1);
  expect(many.stderr).toContain("--limit must be a number above 0 and at most 20");
  const rich = await evalRun(f, ["zebra", "--candidate", f.candidate, "--yes", "--max-cost", "11"]);
  expect(rich.code).toBe(1);
  const cheap = await evalRun(f, [
    "zebra",
    "--candidate",
    f.candidate,
    "--yes",
    "--max-cost",
    "0.0001",
  ]);
  expect(cheap.code).toBe(1);
  expect(cheap.stderr).toContain("is above --max-cost");
  expect(await calls(f.log)).toHaveLength(0);
});

test.skipIf(windows)("a replay that loads a plugin is stopped and counted as failed", async () => {
  const f = await fixture([{ id: "p1", day: 20, text: "zebra leak plugin", skill: "zebra" }]);
  const out = await evalRun(f, ["zebra", "--candidate", f.candidate, "--yes", "--json"]);
  expect(out.code).toBe(0);
  const result = JSON.parse(out.stdout);
  expect(result.prompts[0].current).toEqual({ failed: "isolation not confirmed: plugins loaded" });
  expect(result.summary).toMatchObject({ failed: 1, wins: 0, exclusionRate: null });
});

test.skipIf(windows)("no replay starts once the next one could pass the spend cap", async () => {
  const f = await fixture([
    { id: "c1", day: 20, text: "zebra costly one", skill: "zebra" },
    { id: "c2", day: 21, text: "zebra costly two", skill: "zebra" },
  ]);
  const out = await evalRun(f, ["zebra", "--candidate", f.candidate, "--yes", "--json"]);
  expect(out.code).toBe(0);
  const seen = await calls(f.log);
  expect(seen).toHaveLength(1);
  expect(seen[0].argv[seen[0].argv.indexOf("--max-budget-usd") + 1]).toBe("1.0000");
  const result = JSON.parse(out.stdout);
  expect(result.summary).toMatchObject({ notRun: 2, stopped: "spend cap reached" });
  expect(result.summary.spentUsd).toBeCloseTo(0.75);
});

test.skipIf(windows)("a skill that errors when it runs never wins or ties", async () => {
  const f = await fixture([{ id: "d1", day: 20, text: "zebra deny shell", skill: "zebra" }]);
  const out = await evalRun(f, ["zebra", "--candidate", f.candidate, "--yes", "--json"]);
  expect(out.code).toBe(0);
  const result = JSON.parse(out.stdout);
  expect(result.prompts[0].current).toMatchObject({ triggered: true, errored: true });
  expect(result.prompts[0].outcome).toBe("errored");
  expect(result.summary).toMatchObject({ wins: 0, ties: 0, losses: 0, errored: 1 });
});

test.skipIf(windows)(
  "an interrupt stops the replay's process group and removes its scratch home",
  async () => {
    const f = await fixture([{ id: "h1", day: 20, text: "zebra hang", skill: "zebra" }]);
    const proc = Bun.spawn(
      ["bun", main, "skills", "eval", "zebra", "--candidate", f.candidate, "--yes", "--json"],
      {
        env: {
          PATH: `${f.bin}:${process.env.PATH}`,
          HOME: f.home,
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
          ANTHROPIC_API_KEY: "sk-test-not-real",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const hang = f.log.replace(/jsonl$/, "hang");
    let child: { pid: number; config: string } | null = null;
    for (let i = 0; i < 500 && !child; i++) {
      child = (await Bun.file(hang).exists()) ? JSON.parse(await Bun.file(hang).text()) : null;
      if (!child) await Bun.sleep(10);
    }
    expect(child).not.toBeNull();
    process.kill(proc.pid, "SIGINT");
    expect(await proc.exited).toBe(130);
    const alive = (() => {
      try {
        process.kill(child!.pid, 0);
        return true;
      } catch {
        return false;
      }
    })();
    if (alive) process.kill(-child!.pid, "SIGKILL");
    expect(alive).toBe(false);
    expect(await stat(join(child!.config, "..")).catch(() => null)).toBeNull();
  },
);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = async (check: () => Promise<boolean> | boolean, ms = 5000) => {
  for (let waited = 0; waited < ms; waited += 50) {
    if (await check()) return true;
    await Bun.sleep(50);
  }
  return false;
};

test.skipIf(windows)(
  "abandoned scratch homes are reclaimed, their process groups killed, live ones kept",
  async () => {
    const f = await fixture(STANDARD.slice(0, 1));
    const tmp = await temp("tmp");
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    const sleeper = Bun.spawn(["sleep", "60"], { detached: true, stdout: "ignore" });
    const home = async (name: string, marker: object | null) => {
      const dir = join(tmp, `quench-eval-${name}`);
      await Bun.write(join(dir, "config/sessions/1.key"), "peer token");
      if (marker) await Bun.write(join(dir, "quench-eval.json"), JSON.stringify(marker));
      return dir;
    };
    const dead = await home("dead", { owner: gone.pid, group: sleeper.pid, createdAt: Date.now() });
    const old = await home("old", null);
    await utimes(old, new Date(Date.now() - 7_200_000), new Date(Date.now() - 7_200_000));
    const kept = await home("live", { owner: process.pid, group: null, createdAt: Date.now() });
    const out = await evalRun(f, ["zebra", "--candidate", f.candidate, "--yes", "--json"], {
      TMPDIR: tmp,
    });
    expect(out.code).toBe(0);
    expect(await stat(dead).catch(() => null)).toBeNull();
    expect(await stat(old).catch(() => null)).toBeNull();
    expect(await stat(kept).catch(() => null)).not.toBeNull();
    expect(await until(() => !alive(sleeper.pid))).toBe(true);
  },
);

test.skipIf(windows)(
  "without a parent-death signal, a watchdog stops the replay when Quench is killed",
  async () => {
    const f = await fixture([]);
    const tmp = await temp("watch");
    const hang = f.log.replace(/jsonl$/, "hang");
    const runner = join(f.root, "runner.ts");
    await Bun.write(
      runner,
      `Object.defineProperty(process, "platform", { value: "darwin" });
const { replay } = await import(${JSON.stringify(join(import.meta.dir, "../src/skills/replay.ts"))});
await replay({ command: ${JSON.stringify(join(f.bin, "claude"))}, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "sk-test-not-real" }, skill: "zebra", tree: [{ path: "SKILL.md", mode: "100644", bytes: new TextEncoder().encode("TRIGGERS") }], prompt: "zebra hang", model: null, budgetUsd: 1 });
`,
    );
    const proc = Bun.spawn(["bun", runner], {
      env: { PATH: process.env.PATH!, TMPDIR: tmp, HOME: f.home },
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await until(() => Bun.file(hang).exists())).toBe(true);
    const child = JSON.parse(await Bun.file(hang).text());
    process.kill(proc.pid, "SIGKILL");
    await proc.exited;
    const stopped = await until(() => !alive(child.pid));
    if (!stopped) process.kill(-child.pid, "SIGKILL");
    expect(stopped).toBe(true);
    expect(
      await until(async () => (await stat(join(child.config, "..")).catch(() => null)) === null),
    ).toBe(true);
  },
);
