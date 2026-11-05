import { afterAll, expect, test } from "bun:test";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { readJournal, readLedger, withLock } from "@quench/fleet/apply";
import { skillsApply, skillsPlan, stateDir } from "../src/commands/skills.ts";
import {
  cleanup,
  claude,
  git,
  link,
  planAndApply,
  setup,
  temp,
  V1,
  V2,
  windows,
  writeSource,
} from "./fleet-scratch.ts";

afterAll(cleanup);

const gone = async (path: string) => (await lstat(path).catch(() => null)) === null;

async function outside(dir: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  return dir;
}

const snapshotOf = async (dir: string) =>
  (await readdir(dir, { recursive: true })).map(String).sort();

async function interrupted(
  home: Parameters<typeof skillsPlan>[0],
  options: Parameters<typeof skillsPlan>[1],
  at: string,
  act: () => Promise<void>,
) {
  const plan = await skillsPlan(home, options);
  let done = false;
  return skillsApply(
    home,
    { ...options, planHash: plan.hash! },
    {
      interrupt: async (step) => {
        if (step !== at || done) return;
        done = true;
        await act();
      },
    },
  );
}

test("a target swapped for a symlink after the plan is a conflict for that item only", async () => {
  const { dir, home, source, options } = await setup();
  await planAndApply(home, options);
  await writeSource(source, V2, [{ skill: "alpha" }, { skill: "beta" }]);
  const elsewhere = await outside(join(dir, "elsewhere"), { "SKILL.md": "not yours\n" });
  const outcome = await interrupted(home, options, "staged", async () => {
    await rm(join(home.dir, ".claude/skills/alpha"), { recursive: true });
    await link(elsewhere, join(home.dir, ".claude/skills/alpha"));
  });
  expect(outcome.conflicts.find((c) => c.path === "~/.claude/skills/alpha")?.reason).toContain(
    "symlink",
  );
  expect(await snapshotOf(elsewhere)).toEqual(["SKILL.md"]);
  expect(await readFile(join(home.dir, ".codex/skills/alpha/SKILL.md"), "utf8")).toBe(
    "# alpha v2\n",
  );
  expect(await readJournal(stateDir(home))).toBeNull();
});

test("a harness root swapped for a symlink mid-apply stops its updates and removals", async () => {
  const { dir, home, source, options } = await setup();
  await planAndApply(home, options);
  await writeSource(source, V2, [{ skill: "alpha" }]);
  const copy = join(dir, "codex-copy");
  const outcome = await interrupted(home, options, "staged", async () => {
    await cp(join(home.dir, ".codex/skills"), copy, { recursive: true });
    await rm(join(home.dir, ".codex/skills"), { recursive: true });
    await link(copy, join(home.dir, ".codex/skills"));
  });
  const codex = outcome.conflicts.filter((c) => c.path?.startsWith("~/.codex/"));
  expect(codex.map((c) => c.path)).toEqual(["~/.codex/skills/alpha", "~/.codex/skills/beta"]);
  expect(await readFile(join(copy, "beta/SKILL.md"), "utf8")).toBe("# beta\n");
  expect(await readFile(join(copy, "alpha/SKILL.md"), "utf8")).toBe("# alpha v1\n");
  expect(await gone(join(home.dir, ".claude/skills/beta"))).toBe(true);
});

async function project(dir: string) {
  const checkout = join(dir, "app");
  await mkdir(checkout, { recursive: true });
  await git(checkout, "init", "-q");
  await git(checkout, "remote", "add", "origin", "https://github.com/acme/app.git");
  return checkout;
}

const PROJECT = [{ skill: "alpha", harnesses: ["claude-code"], remote: "github.com/acme/app" }];

test("a project skill root under a symlinked folder is a conflict and nothing is written through it", async () => {
  const { dir, home, options } = await setup(V1, PROJECT);
  const checkout = await project(dir);
  const elsewhere = await outside(join(dir, "elsewhere"), { "keep.md": "keep\n" });
  await link(elsewhere, join(checkout, ".claude"));
  const outcome = await planAndApply(home, { ...options, projects: [checkout] });
  expect(outcome.applied).toEqual([]);
  expect(outcome.conflicts[0]?.reason).toContain("symlink");
  expect(await snapshotOf(elsewhere)).toEqual(["keep.md"]);
  expect(await readLedger(stateDir(home))).toEqual([]);
});

test.skipIf(windows)(
  "a symlinked .git/info/exclude is a conflict and is never followed",
  async () => {
    const { dir, home, options } = await setup(V1, PROJECT);
    const checkout = await project(dir);
    const target = join(dir, "victim.txt");
    await writeFile(target, "keep\n");
    await mkdir(join(checkout, ".git/info"), { recursive: true });
    await rm(join(checkout, ".git/info/exclude"), { force: true });
    await symlink(target, join(checkout, ".git/info/exclude"));
    const outcome = await planAndApply(home, { ...options, projects: [checkout] });
    expect(outcome.conflicts[0]?.reason).toContain("exclude");
    expect(await readFile(target, "utf8")).toBe("keep\n");
    expect(await gone(join(checkout, ".claude/skills/alpha"))).toBe(true);
    expect(await readLedger(stateDir(home))).toEqual([]);
  },
);

test("a target swapped right after the rename is caught before the ledger records it", async () => {
  const { dir, home, source, options } = await setup(V1, [
    { skill: "alpha", harnesses: ["claude-code"] },
  ]);
  await planAndApply(home, options);
  await writeSource(source, V2, [{ skill: "alpha", harnesses: ["claude-code"] }]);
  const elsewhere = await outside(join(dir, "elsewhere"), { "SKILL.md": "# alpha v2\n" });
  const target = join(home.dir, ".claude/skills/alpha");
  const result = await interrupted(home, options, "swapped", async () => {
    await rename(target, join(dir, "moved"));
    await link(elsewhere, target);
  }).catch((e: Error) => e);
  expect(result instanceof Error ? result.message : JSON.stringify(result.conflicts)).toContain(
    "symlink",
  );
  const ledger = await readLedger(stateDir(home));
  expect(ledger.map((e) => e.kind)).toEqual(["install"]);
  expect(await snapshotOf(elsewhere)).toEqual(["SKILL.md"]);
});

test("staging never deletes or writes through paths Quench did not create", async () => {
  const { dir, home, options } = await setup(V1, [{ skill: "alpha", harnesses: ["claude-code"] }]);
  const root = join(home.dir, ".claude/skills");
  await mkdir(join(root, ".quench-stage/alpha.1.new"), { recursive: true });
  await writeFile(join(root, ".quench-stage/alpha.1.new/keep.txt"), "mine\n");
  await mkdir(join(root, "elsewhere"), { recursive: true });
  const elsewhere = await outside(join(dir, "elsewhere"), {});
  await mkdir(elsewhere, { recursive: true });
  await link(elsewhere, join(root, ".quench-stage/alpha.1.old"));
  const outcome = await planAndApply(home, options);
  expect(outcome.applied).toHaveLength(1);
  expect(await readFile(join(root, ".quench-stage/alpha.1.new/keep.txt"), "utf8")).toBe("mine\n");
  expect(await snapshotOf(elsewhere)).toEqual([]);
});

for (const step of ["staged", "committed"] as const)
  test(`recovery after "${step}" leaves stage entries whose bytes changed and reports a conflict`, async () => {
    const { home, source, options } = await setup(V1, [
      { skill: "alpha", harnesses: ["claude-code"] },
    ]);
    await planAndApply(home, options);
    await writeSource(source, V2, [{ skill: "alpha", harnesses: ["claude-code"] }]);
    const plan = await skillsPlan(home, options);
    await skillsApply(
      home,
      { ...options, planHash: plan.hash! },
      {
        interrupt: (at) => {
          if (at === step) throw new Error("killed");
        },
      },
    ).catch(() => undefined);
    const op = await readJournal(stateDir(home));
    const left = step === "staged" ? op!.stage! : op!.backup;
    await writeFile(join(left, "added.md"), "someone's work\n");
    const next = await skillsPlan(home, options);
    const result = await skillsApply(home, { ...options, planHash: next.hash! }).catch(
      (e: Error) => e,
    );
    expect(result instanceof Error ? result.message : "").toContain("conflict");
    expect(await readFile(join(left, "added.md"), "utf8")).toBe("someone's work\n");
  });

test("an empty or partial lock file is never treated as stale", async () => {
  const state = await temp("lock");
  await writeFile(join(state, "lock"), "");
  const result = await withLock(state, async () => "ran").catch((e: Error) => e.message);
  expect(result).toContain("another apply");
  await writeFile(join(state, "lock"), '{"pid":');
  expect(await withLock(state, async () => "ran").catch((e: Error) => e.message)).toContain(
    "another apply",
  );
});

test("24 processes contending for the lock never overlap", async () => {
  const dir = await temp("contend");
  const state = join(dir, "state");
  const log = join(dir, "log");
  const script = join(dir, "contend.ts");
  await writeFile(
    script,
    `import { appendFileSync } from "node:fs";
import { withLock } from ${JSON.stringify(join(import.meta.dir, "../../fleet/src/apply.ts"))};
const [state, log] = process.argv.slice(2);
for (;;) {
  try {
    await withLock(state, async () => {
      appendFileSync(log, "start " + process.pid + "\\n");
      await Bun.sleep(3);
      appendFileSync(log, "end " + process.pid + "\\n");
    });
    break;
  } catch (error) {
    if (!String(error.message).includes("another apply")) throw error;
    await Bun.sleep(Math.random() * 15);
  }
}
`,
  );
  const procs = Array.from({ length: 24 }, () =>
    Bun.spawn([process.execPath, script, state, log], { stdout: "ignore", stderr: "pipe" }),
  );
  const codes = await Promise.all(procs.map((p) => p.exited));
  expect(codes.every((c) => c === 0)).toBe(true);
  const lines = (await readFile(log, "utf8")).trim().split("\n");
  expect(lines).toHaveLength(48);
  for (let i = 0; i < lines.length; i += 2) {
    expect(lines[i]!.startsWith("start ")).toBe(true);
    expect(lines[i + 1]).toBe(lines[i]!.replace("start", "end"));
  }
}, 60_000);

test.skipIf(windows)(
  "a local chmod after the plan is a conflict at the pre-swap check",
  async () => {
    const { home, source, options } = await setup(V1, [
      { skill: "alpha", harnesses: ["claude-code"] },
    ]);
    await planAndApply(home, options);
    await writeSource(source, V2, [{ skill: "alpha", harnesses: ["claude-code"] }]);
    const outcome = await interrupted(home, options, "staged", () =>
      chmod(claude(home, "alpha", "run.sh"), 0o644),
    );
    expect(outcome.applied).toEqual([]);
    expect(outcome.conflicts[0]?.path).toBe("~/.claude/skills/alpha");
    expect(await readFile(claude(home, "alpha"), "utf8")).toBe("# alpha v1\n");
  },
);

test.skipIf(windows)("the plan hash changes when only the desired file mode changes", async () => {
  const { home, source, options } = await setup(V1, [
    { skill: "alpha", harnesses: ["claude-code"] },
  ]);
  const before = (await skillsPlan(home, options)).hash;
  await chmod(join(source, "skills/alpha/run.sh"), 0o644);
  expect((await skillsPlan(home, options)).hash).not.toBe(before);
});

test("removing a project skill keeps an exclude line that was there before Quench", async () => {
  const { dir, home, source, options } = await setup(V1, PROJECT);
  const checkout = await project(dir);
  const exclude = join(checkout, ".git/info/exclude");
  await mkdir(join(checkout, ".git/info"), { recursive: true });
  await writeFile(exclude, "/.claude/skills/alpha/\n");
  const withProject = { ...options, projects: [checkout] };
  await planAndApply(home, withProject);
  expect((await readLedger(stateDir(home)))[0]?.gitExclude).toBeNull();
  await writeSource(source, V1, []);
  const removed = await planAndApply(home, withProject);
  expect(removed.applied.map((a) => a.action)).toEqual(["remove"]);
  expect((await readFile(exclude, "utf8")).split("\n")).toContain("/.claude/skills/alpha/");
});

const ALPHA = [{ skill: "alpha", harnesses: ["claude-code"] }];

for (const step of ["staged", "backed-up"] as const)
  test(`recovery after "${step}" keeps a foreign folder at the target even when its content matches`, async () => {
    const { home, source, options } = await setup(V1, ALPHA);
    if (step === "backed-up") {
      await planAndApply(home, options);
      await writeSource(source, V2, ALPHA);
    }
    const target = join(home.dir, ".claude/skills/alpha");
    await interrupted(home, options, step, async () => {
      await cp(join(source, "skills/alpha"), target, { recursive: true });
      throw new Error("crash");
    }).catch(() => undefined);
    const plan = await skillsPlan(home, options);
    await skillsApply(home, { ...options, planHash: plan.hash! }).catch(() => undefined);
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe(
      step === "staged" ? "# alpha v1\n" : "# alpha v2\n",
    );
  });

test("plan reports a symlinked project root as a conflict, like apply", async () => {
  const { dir, home, options } = await setup(V1, PROJECT);
  const checkout = await project(dir);
  const elsewhere = await outside(join(dir, "elsewhere"), {});
  await mkdir(elsewhere, { recursive: true });
  await mkdir(join(checkout, ".claude"));
  await link(elsewhere, join(checkout, ".claude/skills"));
  const withProject = { ...options, projects: [checkout] };
  const plan = await skillsPlan(home, withProject);
  expect(plan.items.map((i) => i.action)).toEqual(["conflict"]);
  expect(plan.items[0]?.reason).toContain("another writer");
  const outcome = await skillsApply(home, { ...withProject, planHash: plan.hash! });
  expect(outcome.applied).toEqual([]);
  expect(await snapshotOf(elsewhere)).toEqual([]);
});

test("plan reports an owned folder under a newly symlinked root as a conflict, never a removal", async () => {
  const { home, source, options } = await setup(V1, ALPHA);
  await planAndApply(home, options);
  const root = join(home.dir, ".claude/skills");
  await rename(root, `${root}.saved`);
  await link(`${root}.saved`, root);
  await writeSource(source, V1, []);
  const plan = await skillsPlan(home, options);
  expect(plan.items.map((i) => i.action)).toEqual(["conflict"]);
  await skillsApply(home, { ...options, planHash: plan.hash! });
  expect(await readFile(join(`${root}.saved`, "alpha/SKILL.md"), "utf8")).toBe("# alpha v1\n");
});

async function dotfiles(dir: string, home: { dir: string }) {
  const first = join(dir, "dotfiles-a");
  await mkdir(first, { recursive: true });
  await link(first, join(home.dir, ".claude"));
  return first;
}

test("a symlinked ~/.claude is followed while it stays where the plan resolved it", async () => {
  const { dir, home, options } = await setup(V1, ALPHA);
  const first = await dotfiles(dir, home);
  const outcome = await planAndApply(home, options);
  expect(outcome.conflicts).toEqual([]);
  expect(await readFile(join(first, "skills/alpha/SKILL.md"), "utf8")).toBe("# alpha v1\n");
});

test("re-pointing a symlinked ~/.claude after the plan changes the plan hash", async () => {
  const { dir, home, options } = await setup(V1, ALPHA);
  await dotfiles(dir, home);
  const plan = await skillsPlan(home, options);
  const second = join(dir, "dotfiles-b");
  await mkdir(second, { recursive: true });
  await rm(join(home.dir, ".claude"), { recursive: true });
  await link(second, join(home.dir, ".claude"));
  const refused = await skillsApply(home, { ...options, planHash: plan.hash! }).catch(
    (e: Error) => e,
  );
  expect((refused as Error).message).toContain("changed since plan");
  expect(await snapshotOf(second)).toEqual([]);
});

test("re-pointing a symlinked ~/.claude mid-apply is a conflict and nothing is written through it", async () => {
  const { dir, home, source, options } = await setup(V1, ALPHA);
  const first = await dotfiles(dir, home);
  await planAndApply(home, options);
  await writeSource(source, V2, ALPHA);
  const second = join(dir, "dotfiles-b");
  const outcome = await interrupted(home, options, "staged", async () => {
    await cp(first, second, { recursive: true });
    await rm(join(home.dir, ".claude"), { recursive: true });
    await link(second, join(home.dir, ".claude"));
  }).catch((e: Error) => e);
  expect(outcome instanceof Error ? outcome.message : JSON.stringify(outcome.conflicts)).toContain(
    "resolves",
  );
  expect(await readFile(join(second, "skills/alpha/SKILL.md"), "utf8")).toBe("# alpha v1\n");
  expect(await readFile(join(first, "skills/alpha/SKILL.md"), "utf8")).toBe("# alpha v1\n");
});

for (const update of [false, true])
  test(`recovery after "swapped" keeps edits made to the placed ${update ? "update" : "install"}`, async () => {
    const { home, source, options } = await setup(V1, ALPHA);
    if (update) {
      await planAndApply(home, options);
      await writeSource(source, V2, ALPHA);
    }
    await interrupted(home, options, "swapped", async () => {
      throw new Error("crash");
    }).catch(() => undefined);
    await writeFile(claude(home, "alpha"), "edited after the crash\n");
    await writeFile(claude(home, "alpha", "private.txt"), "private\n");
    const plan = await skillsPlan(home, options);
    const result = await skillsApply(home, { ...options, planHash: plan.hash! }).catch(
      (e: Error) => e,
    );
    expect(result instanceof Error ? result.message : "").toContain("conflict");
    expect(await readFile(claude(home, "alpha"), "utf8")).toBe("edited after the crash\n");
    expect(await readFile(claude(home, "alpha", "private.txt"), "utf8")).toBe("private\n");
    expect(await readJournal(stateDir(home))).not.toBeNull();
  });

test.skipIf(windows)(
  'recovery after "swapped" keeps a placed folder whose only change is a file mode',
  async () => {
    const { home, options } = await setup(V1, ALPHA);
    await interrupted(home, options, "swapped", async () => {
      throw new Error("crash");
    }).catch(() => undefined);
    await chmod(claude(home, "alpha", "run.sh"), 0o644);
    const plan = await skillsPlan(home, options);
    const result = await skillsApply(home, { ...options, planHash: plan.hash! }).catch(
      (e: Error) => e,
    );
    expect(result instanceof Error ? result.message : "").toContain("conflict");
    expect(await readFile(claude(home, "alpha"), "utf8")).toBe("# alpha v1\n");
  },
);
