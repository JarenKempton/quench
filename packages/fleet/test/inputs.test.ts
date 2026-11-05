import { expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFleet } from "@quench/fleet/disk";

const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (error: Error) => error.message,
  );

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "fleet-inputs-"));
  await mkdir(join(dir, "hosts"));
  await writeFile(join(dir, "registry.yaml"), "skills:\n  a: { path: skills/a }\n");
  await writeFile(join(dir, "hosts/claude-global.manifest"), "skills/a\n");
  return dir;
}

const linked = (target: string, path: string) =>
  symlink(target, path).then(
    () => true,
    () => false,
  );

test("a dangling fleet file link fails the plan instead of falling back to the registry", async () => {
  const dir = await repo();
  if (!(await linked(join(dir, "missing.yaml"), join(dir, "quench-fleet.yaml")))) return;
  expect(await failure(loadFleet(dir))).toContain("quench-fleet.yaml is a symlink");
});

test("a registry linked from outside the repo fails the plan", async () => {
  const dir = await repo();
  const outside = await mkdtemp(join(tmpdir(), "fleet-outside-"));
  await writeFile(join(outside, "registry.yaml"), "skills:\n  a: { path: skills/a }\n");
  await Bun.file(join(dir, "registry.yaml")).delete();
  if (!(await linked(join(outside, "registry.yaml"), join(dir, "registry.yaml")))) return;
  expect(await failure(loadFleet(dir))).toContain("registry.yaml is a symlink");
});

test.skipIf(process.platform === "win32")(
  "a FIFO in place of any input fails the plan without being opened",
  async () => {
    for (const path of ["registry.yaml", "quench-fleet.yaml", "hosts/codex-global.manifest"]) {
      const dir = await repo();
      await Bun.file(join(dir, path))
        .delete()
        .catch(() => {});
      expect(Bun.spawnSync(["mkfifo", join(dir, path)]).exitCode).toBe(0);
      expect(await failure(loadFleet(dir))).toContain("not a regular file or folder");
    }
  },
  2000,
);
