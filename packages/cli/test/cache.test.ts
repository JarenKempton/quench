import { expect, test } from "bun:test";
import { mkdir, mkdtemp, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = join(import.meta.dir, "../src/main.ts");

async function quench(home: string, ...args: string[]) {
  const proc = Bun.spawn(["bun", main, ...args], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: "",
      CODEX_HOME: "",
      PI_CODING_AGENT_DIR: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout, code };
}

test("profile reuses cached session results until the session file changes", async () => {
  const home = await mkdtemp(join(tmpdir(), "quench-cache-"));
  const project = join(home, "code/app");
  await mkdir(project, { recursive: true });
  const session = join(home, ".codex/sessions/2026/10/20/a.jsonl");
  await mkdir(join(session, ".."), { recursive: true });
  const write = (cwd: string) =>
    Bun.write(session, JSON.stringify({ type: "session_meta", payload: { id: "a", cwd } }) + "\n");
  const cwds = async (...args: string[]) =>
    JSON.parse((await quench(home, "profile", "--json", ...args)).stdout).projects.map(
      (p: { root: string }) => p.root,
    );
  await write(project);

  expect(await cwds("--no-cache")).toEqual([project]);
  const cacheFile = join(home, ".quench/local/session-places.json");
  expect(await Bun.file(cacheFile).exists()).toBe(false);

  expect(await cwds()).toEqual([project]);
  expect((await stat(cacheFile)).mode & 0o777).toBe(0o600);

  const cached = await Bun.file(cacheFile).json();
  await mkdir(join(home, "from-cache"));
  cached.entries[session].place.cwd = join(home, "from-cache");
  await Bun.write(cacheFile, JSON.stringify(cached));
  expect(await cwds()).toEqual([join(home, "from-cache")]);
  expect(await cwds("--no-cache")).toEqual([project]);

  const later = new Date(Date.now() + 60_000);
  await write(project);
  await utimes(session, later, later);
  expect(await cwds()).toEqual([project]);
});
