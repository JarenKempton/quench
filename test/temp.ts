import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "quench-test-"));
for (const name of ["TMPDIR", "TEMP", "TMP"]) process.env[name] = root;

afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
