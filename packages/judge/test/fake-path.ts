import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const script = join(import.meta.dir, "fake-harness.ts");

export async function fakeHarnessPath(): Promise<{ PATH: string; FAKE_LOG: string }> {
  const dir = await mkdtemp(join(tmpdir(), "quench-fake-harness-"));
  for (const name of ["claude", "codex"]) {
    if (process.platform === "win32") {
      await Bun.write(
        join(dir, `${name}.cmd`),
        `@"${process.execPath}" "${script}" ${name} %*\r\n`,
      );
    } else {
      await Bun.write(
        join(dir, name),
        `#!/bin/sh\nexec "${process.execPath}" "${script}" ${name} "$@"\n`,
      );
      await chmod(join(dir, name), 0o755);
    }
  }
  return { PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`, FAKE_LOG: join(dir, "log.jsonl") };
}

export async function fakeCalls(log: string): Promise<
  {
    name: string;
    argv: string[];
    stdin: string;
    cwd: string;
    child: string | null;
    claudecode: string | null;
  }[]
> {
  const file = Bun.file(log);
  if (!(await file.exists())) return [];
  return (await file.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
