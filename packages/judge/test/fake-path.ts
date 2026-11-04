import { setDefaultTimeout } from "bun:test";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const script = join(import.meta.dir, "fake-harness.ts");
let compiled: Promise<string> | undefined;
if (process.platform === "win32") setDefaultTimeout(60_000);

const compile = async () => {
  const dir = await mkdtemp(join(tmpdir(), "quench-fake-exe-"));
  const out = join(dir, "claude.exe");
  const built = Bun.spawnSync([process.execPath, "build", "--compile", script, "--outfile", out]);
  if (built.exitCode !== 0) throw new Error(built.stderr.toString());
  return out;
};

export type FakeConfig = { mode?: string; answer?: string; marker?: string };
export type Fake = { PATH: string; dir: string; state: string };

export async function fakeHarnessPath(config: FakeConfig = {}): Promise<Fake> {
  const dir = await mkdtemp(join(tmpdir(), "quench-fake-harness-"));
  let state = dir;
  if (process.platform === "win32") {
    state = join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin");
    await mkdir(state, { recursive: true });
    await Bun.write(join(state, "claude.exe"), Bun.file(await (compiled ??= compile())));
    await Bun.write(
      join(dir, "claude.cmd"),
      `@ECHO off\r\nSET dp0=%~dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n`,
    );
  } else {
    await Bun.write(
      join(dir, "claude"),
      `#!/bin/sh\nFAKE_DIR="${dir}" exec "${process.execPath}" "${script}" "$@"\n`,
    );
    await chmod(join(dir, "claude"), 0o755);
  }
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
