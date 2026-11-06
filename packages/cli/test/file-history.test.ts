import { expect, test } from "bun:test";
import { appendFile, chmod, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { HarnessJudge, Jev } from "@quench/judge";
import { cliRunsTimeout, quench } from "./run.ts";
import { day, fixture, git, SKILL } from "./correction-home.ts";

async function run(home: string, ...flags: string[]) {
  const args = ["corrections", "--context", "--cached-only", "--days", "36500", ...flags];
  const out = await quench(home, ...args, "--json");
  expect(out.stderr).toBe("");
  const { stdout } = await quench(home, ...args);
  return { json: JSON.parse(out.stdout).context, text: stdout };
}

type History = {
  kind: string;
  name: string;
  path: string;
  source: string;
  versions: {
    from: string;
    bytes: number | null;
    loaded: { sessions: number; withHumanCorrection: number; judged: number };
  }[];
  changes: { grewBy: number; shown: boolean; grewWithoutDrop: boolean; rates: object }[];
};

async function tree(dir: string): Promise<string[]> {
  const entries = (await readdir(dir, { recursive: true })).sort();
  return Promise.all(entries.map(async (e) => `${e}:${(await stat(join(dir, e))).mtimeMs}`));
}

test.each([
  ["Jev", Jev.id, []],
  ["claude", HarnessJudge.id, ["--judge", "claude"]],
])(
  "a tracked instruction file splits at its git commits and is flagged when it grew with no drop in corrections, from %s verdicts",
  async (_, judge, flags) => {
    if (flags.length && process.platform === "win32") return;
    const home = await fixture(judge);
    const before = [await tree(join(home, ".claude")), await tree(join(home, "work"))];
    const { json, text } = await run(home, ...flags);
    expect([await tree(join(home, ".claude")), await tree(join(home, "work"))]).toEqual(before);
    const file = (json.history.files as History[]).find((f) => f.path.endsWith("CLAUDE.md"))!;
    expect(file).toMatchObject({ kind: "instructions", source: "git" });
    expect(
      file.versions.map((v) => [
        v.from.slice(0, 10),
        v.bytes,
        v.loaded.sessions,
        v.loaded.withHumanCorrection,
      ]),
    ).toEqual([
      ["2026-01-01", 9, 10, 3],
      ["2026-02-01", 48, 10, 5],
    ]);
    expect(file.changes).toEqual([
      expect.objectContaining({
        grewBy: 39,
        shown: true,
        grewWithoutDrop: true,
        rates: { before: 0.3, after: 0.5 },
      }),
    ]);
    expect(json.history.basis).toBe("correlation, not cause");
    expect(text).toMatch(
      /Grew 39 B on 2026-02-01 with no drop in correction rate \(30% → 50%\); correlation, not cause/,
    );
  },
  cliRunsTimeout,
);

test(
  "a file that grew while corrections dropped is not flagged",
  async () => {
    const home = await fixture(Jev.id, 1);
    const { json } = await run(home);
    const file = (json.history.files as History[]).find((f) => f.path.endsWith("CLAUDE.md"))!;
    expect(file.changes[0]).toMatchObject({ shown: true, grewWithoutDrop: false });
  },
  cliRunsTimeout,
);

test(
  "an untracked skill gets its history from snapshots Quench records, split when its content changes",
  async () => {
    const home = await fixture();
    const skill = join(home, ".claude/skills/verify/SKILL.md");
    const skillOf = (json: { history: { files: History[] } }) =>
      json.history.files.find((f) => f.kind === "skill")!;
    const first = skillOf((await run(home)).json);
    expect(first).toMatchObject({ name: "verify", source: "snapshots" });
    expect(first.versions).toHaveLength(1);
    expect(first.versions[0]!.loaded.sessions).toBe(0);
    await run(home, "--dry-run");
    await Bun.write(skill, `${SKILL}\nAlso run the linter.\n`);
    const second = skillOf((await run(home)).json);
    expect(second.versions.map((v) => v.bytes)).toEqual([SKILL.length, SKILL.length + 22]);
    expect(await Bun.file(skill).text()).toBe(`${SKILL}\nAlso run the linter.\n`);
  },
  cliRunsTimeout,
);

test(
  "a dry run records no snapshot",
  async () => {
    const home = await fixture();
    await quench(home, "corrections", "--context", "--dry-run", "--days", "36500");
    expect(await Bun.file(join(home, ".quench/local/snapshots.json")).exists()).toBe(false);
  },
  cliRunsTimeout,
);

test(
  "a memory entry that overlaps a skill is flagged with both locations",
  async () => {
    const home = await fixture();
    const { json, text } = await run(home);
    expect(json.overlaps).toEqual([
      {
        entry: { path: expect.stringMatching(/memory.checks\.md$/), startLine: 1, endLine: 1 },
        copies: 1,
        skill: expect.objectContaining({ name: "verify", startLine: 6 }),
        shared: expect.any(Number),
        duplicate: false,
      },
    ]);
    expect(text).toMatch(/checks\.md:1 {2}↔ {2}skill verify .*SKILL\.md:6/);
  },
  cliRunsTimeout,
);

test(
  "git runs with the repo's, global and system config neutralised, so no planted program runs",
  async () => {
    if (process.platform === "win32") return;
    const home = await fixture();
    const work = join(home, "work");
    const marker = join(home, "PWNED");
    const script = join(home, "gpg.sh");
    await Bun.write(script, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    await chmod(script, 0o755);
    await Bun.write(join(work, "CLAUDE.md"), "Use Bun.\nSigned.\n");
    await git(work, day(3, 1), "add", "CLAUDE.md");
    const tree = Bun.spawnSync(["git", "write-tree"], { cwd: work }).stdout.toString().trim();
    const parent = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: work })
      .stdout.toString()
      .trim();
    const stamp = Date.parse(day(3, 1)) / 1000;
    const commit = `tree ${tree}\nparent ${parent}\nauthor t <t@t> ${stamp} +0000\ncommitter t <t@t> ${stamp} +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEz\n -----END PGP SIGNATURE-----\n\nsigned\n`;
    const made = Bun.spawnSync(["git", "hash-object", "-t", "commit", "-w", "--stdin"], {
      cwd: work,
      stdin: Buffer.from(commit),
    });
    await git(work, day(3, 1), "update-ref", "HEAD", made.stdout.toString().trim());
    const planted = `[log]\n\tshowSignature = true\n[gpg]\n\tprogram = ${script}\n[core]\n\tpager = ${script}\n\tfsmonitor = ${script}\n`;
    await appendFile(join(work, ".git/config"), planted);
    await Bun.write(join(home, ".gitconfig"), planted);
    Bun.spawnSync(["git", "log", "-1", "--format=%H"], {
      cwd: work,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await Bun.file(marker).exists()).toBe(true);
    await rm(marker);
    const { json } = await run(home);
    expect(await Bun.file(marker).exists()).toBe(false);
    const file = (json.history.files as History[]).find((f) => f.path.endsWith("CLAUDE.md"))!;
    expect(file.versions).toHaveLength(3);
  },
  cliRunsTimeout,
);

test(
  "commit dates that go backwards in log order never make a span end before it starts",
  async () => {
    const home = await fixture();
    const work = join(home, "work");
    await Bun.write(join(work, "CLAUDE.md"), "Use Bun.\nSkewed.\n");
    await git(work, "2025-12-01T00:00:00Z", "commit", "-q", "-am", "skewed");
    const { json } = await run(home);
    const file = (json.history.files as History[]).find((f) => f.path.endsWith("CLAUDE.md"))!;
    const spans = file.versions as unknown as { from: string; to: string | null }[];
    expect(spans).toHaveLength(3);
    for (const [i, v] of spans.entries()) {
      if (v.to !== null) expect(Date.parse(v.to)).toBeGreaterThanOrEqual(Date.parse(v.from));
      if (i) expect(Date.parse(v.from)).toBeGreaterThanOrEqual(Date.parse(spans[i - 1]!.from));
    }
  },
  cliRunsTimeout,
);

test(
  "a blob missing from a partial clone counts as unknown size and is never fetched",
  async () => {
    if (process.platform === "win32") return;
    const home = await fixture();
    const work = join(home, "work");
    const origin = join(home, "origin");
    await rename(work, origin);
    await git(origin, day(3, 1), "config", "uploadpack.allowFilter", "true");
    await git(home, day(3, 1), "clone", "-q", "--filter=blob:none", `file://${origin}`, work);
    const marker = join(home, "FETCHED");
    const script = join(home, "ssh.sh");
    await Bun.write(script, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    await chmod(script, 0o755);
    await git(work, day(3, 1), "remote", "set-url", "origin", "ssh://example.invalid/repo.git");
    await git(work, day(3, 1), "config", "core.sshCommand", script);
    await git(work, day(3, 1), "config", "remote.origin.uploadpack", script);
    const old = Bun.spawnSync(["git", "rev-parse", "HEAD~1:CLAUDE.md"], { cwd: work })
      .stdout.toString()
      .trim();
    Bun.spawnSync(["git", "cat-file", "--batch-check"], {
      cwd: work,
      stdin: Buffer.from(`${old}\n`),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await Bun.file(marker).exists()).toBe(true);
    await rm(marker);
    const { json } = await run(home);
    expect(await Bun.file(marker).exists()).toBe(false);
    const file = (json.history.files as History[]).find((f) => f.path.endsWith("CLAUDE.md"))!;
    expect(file.source).toBe("git");
    expect(file.versions.map((v) => v.bytes)).toEqual([null, 48]);
  },
  cliRunsTimeout,
);
