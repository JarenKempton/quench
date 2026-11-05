import { expect, test } from "bun:test";
import { join } from "node:path";
import { Plan } from "@quench/fleet";
import { readSkillsRepo } from "@quench/fleet/disk";
import { importSkillsRepo } from "../src/import.ts";

const root = join(import.meta.dir, "../../..");
const fixtures = join(import.meta.dir, "fixtures");

async function plan(machine: string) {
  const proc = Bun.spawn(
    [
      process.execPath,
      join(root, "packages/cli/src/main.ts"),
      "skills",
      "plan",
      "--source",
      join(fixtures, "skills-repo"),
      "--machine",
      machine,
      "--json",
    ],
    {
      env: {
        ...process.env,
        HOME: join(fixtures, "home"),
        USERPROFILE: join(fixtures, "home"),
        CLAUDE_CONFIG_DIR: "",
        CODEX_HOME: "",
        PI_CODING_AGENT_DIR: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

test("the importer turns registry, host manifests and machine overrides into the golden fleet file", async () => {
  const repo = await readSkillsRepo(join(fixtures, "skills-repo"));
  expect(importSkillsRepo(repo!)).toEqual(
    await Bun.file(join(fixtures, "skills-repo.fleet.json")).json(),
  );
});

for (const machine of ["laptop", "desktop"])
  test(`skills plan for ${machine} is byte-identical to the golden plan on every OS`, async () => {
    const { stdout, stderr, code } = await plan(machine);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toBe(await Bun.file(join(fixtures, `${machine}.plan.json`)).text());
    expect(Plan.parse(JSON.parse(stdout))).toBeTruthy();
  });

test("skills plan is read-only", async () => {
  const before = await snapshotOf(fixtures);
  await plan("laptop");
  expect(await snapshotOf(fixtures)).toEqual(before);
});

async function snapshotOf(dir: string) {
  const files = [...new Bun.Glob("**/*").scanSync({ cwd: dir, dot: true })].sort();
  return Promise.all(files.map(async (f) => [f, await Bun.file(join(dir, f)).text()]));
}

test("skills plan refuses without --source, --machine and --json", async () => {
  const proc = Bun.spawn(
    [
      process.execPath,
      join(root, "packages/cli/src/main.ts"),
      "skills",
      "plan",
      "--machine",
      "laptop",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await proc.exited).toBe(1);
});
