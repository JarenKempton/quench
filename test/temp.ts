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

afterAll(() => {
  const started = Date.now();
  const names = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? [join(dir, e.name), ...names(join(dir, e.name))] : [join(dir, e.name)],
    );
  console.log(`DIAG temp root entries: ${names(root).length}`);
  try {
    remove(root);
  } catch (error) {
    console.log(`DIAG remove failed: ${(error as Error).message}`);
  }
  console.log(`DIAG remove took ${Date.now() - started}ms`);
}, 60_000);
