import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "quench-test-"));
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

spawn([process.execPath, join(import.meta.dir, "reap.ts"), root], {
  stdin: "pipe",
  stdout: "ignore",
  stderr: "ignore",
}).unref();
