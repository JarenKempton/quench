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

export async function fakeHarnessPath(): Promise<{ PATH: string; FAKE_LOG: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "quench-fake-harness-"));
  if (process.platform === "win32") {
    const bin = join(dir, "node_modules/@anthropic-ai/claude-code/bin");
    await mkdir(bin, { recursive: true });
    await Bun.write(join(bin, "claude.exe"), Bun.file(await (compiled ??= compile())));
    await Bun.write(
      join(dir, "claude.cmd"),
      `@ECHO off\r\nSET dp0=%~dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n`,
    );
  } else {
    await Bun.write(
      join(dir, "claude"),
      `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
    );
    await chmod(join(dir, "claude"), 0o755);
  }
  return {
    PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
    FAKE_LOG: join(dir, "log.jsonl"),
    dir,
  };
}

export async function fakeCalls(
  log: string,
): Promise<
  { argv: string[]; stdin: string; cwd: string; child: string | null; claudecode: string | null }[]
> {
  const file = Bun.file(log);
  if (!(await file.exists())) return [];
  return (await file.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
