import { afterAll } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const alive = (pid: number) => {
  try {
    return process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
const remove = (dir: string) => rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
for (const name of readdirSync(tmpdir())) {
  const pid = Number(/^quench-test-(\d+)-/.exec(name)?.[1]);
  if (pid && !alive(pid)) remove(join(tmpdir(), name));
}
const root = mkdtempSync(join(tmpdir(), `quench-test-${process.pid}-`));
for (const name of ["TMPDIR", "TEMP", "TMP"]) process.env[name] = root;

const { spawn, spawnSync } = Bun;
const inherit = <Run extends typeof spawn | typeof spawnSync>(run: Run) =>
  ((first: string[] | object, options?: object) =>
    Reflect.apply(
      run,
      Bun,
      Array.isArray(first)
        ? [first, { env: process.env, ...options }]
        : [{ env: process.env, ...first }],
    )) as Run;
Bun.spawn = inherit(spawn);
Bun.spawnSync = inherit(spawnSync);

afterAll(() => remove(root));
