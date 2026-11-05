import { expect } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Home } from "@quench/history";
import { skillsApply, skillsPlan } from "../src/commands/skills.ts";

const scratch: string[] = [];
export const cleanup = () =>
  Promise.all(scratch.map((d) => rm(d, { recursive: true, force: true })));

export const temp = async (name: string) => {
  const dir = await mkdtemp(join(tmpdir(), `quench-apply-${name}-`));
  scratch.push(dir);
  return dir;
};

export const windows = process.platform === "win32";

export type Skills = Record<string, Record<string, string>>;
export type Assign = { skill: string; harnesses?: string[] | "all"; remote?: string };

export async function writeSource(dir: string, skills: Skills, assign: Assign[]) {
  await rm(dir, { recursive: true, force: true });
  for (const [name, files] of Object.entries(skills))
    for (const [path, text] of Object.entries(files)) {
      const full = join(dir, "skills", name, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, text, { mode: path.endsWith(".sh") ? 0o755 : 0o644 });
    }
  const fleet = {
    version: 1,
    skills: Object.fromEntries(Object.keys(skills).map((n) => [n, { path: `skills/${n}` }])),
    assignments: assign.map((a) => ({
      skill: a.skill,
      target: { kind: "all" },
      scope: a.remote ? { kind: "project", remote: a.remote } : { kind: "global" },
      harnesses: a.harnesses ?? "all",
      mode: "include",
    })),
  };
  await writeFile(join(dir, "quench-fleet.yaml"), JSON.stringify(fleet));
}

export const V1: Skills = {
  alpha: { "SKILL.md": "# alpha v1\n", "run.sh": "#!/bin/sh\necho v1\n" },
  beta: { "SKILL.md": "# beta\n", "notes/a.md": "beta notes\n" },
};
export const V2: Skills = {
  ...V1,
  alpha: { "SKILL.md": "# alpha v2\n", "run.sh": "#!/bin/sh\necho v2\n" },
};

export async function setup(
  skills: Skills = V1,
  assign: Assign[] = [{ skill: "alpha" }, { skill: "beta" }],
) {
  const dir = await temp("home");
  const home = new Home(join(dir, "home"), {});
  await mkdir(home.dir, { recursive: true });
  const source = join(dir, "source");
  await writeSource(source, skills, assign);
  return { dir, home, source, options: { source, machine: "laptop", projects: [] as string[] } };
}

export const claude = (home: Home, skill: string, file = "SKILL.md") =>
  join(home.dir, ".claude/skills", skill, file);

export const planAndApply = async (home: Home, options: Parameters<typeof skillsPlan>[1]) => {
  const plan = await skillsPlan(home, options);
  return skillsApply(home, { ...options, planHash: plan.hash! });
};

export const link = (target: string, path: string) =>
  symlink(target, path, windows ? "junction" : "dir");

export async function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  expect(await proc.exited).toBe(0);
}
