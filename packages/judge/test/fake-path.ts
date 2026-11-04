import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const script = join(import.meta.dir, "fake-harness.ts");
export type FakeConfig = { mode?: string; answer?: string; marker?: string };
export type Fake = { PATH: string; dir: string; state: string };

export async function fakeHarnessPath(config: FakeConfig = {}): Promise<Fake> {
  const dir = await mkdtemp(join(tmpdir(), "quench-fake-harness-"));
  const state = dir;
  await Bun.write(
    join(dir, "claude"),
    `#!/bin/sh\nFAKE_DIR="${dir}" exec "${process.execPath}" "${script}" "$@"\n`,
  );
  await chmod(join(dir, "claude"), 0o755);
  await Bun.write(join(state, "fake.json"), JSON.stringify({ bun: process.execPath, ...config }));
  return { PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`, dir, state };
}

export async function fakeCalls(
  fake: Fake,
): Promise<{ argv: string[]; stdin: string; cwd: string; env: string[] }[]> {
  const file = Bun.file(join(fake.state, "log.jsonl"));
  if (!(await file.exists())) return [];
  return (await file.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
