import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { gitChanges } from "../src/commands/git-history.ts";
import { day, git } from "./correction-home.ts";

function perFile(file: string) {
  const out = Bun.spawnSync(
    [
      "git",
      "-C",
      dirname(file),
      "log",
      "--format=@%ct",
      "--raw",
      "--no-abbrev",
      "--",
      basename(file),
    ],
    { stdout: "pipe" },
  ).stdout.toString();
  const found: { at: number; blob: string }[] = [];
  let at: number | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("@")) at = Number(line.slice(1)) * 1000;
    else if (line.startsWith(":") && at !== null) {
      found.push({ at, blob: line.split("\t")[0]!.split(" ")[3]! });
      at = null;
    }
  }
  return found;
}

test("one read per repo finds the same commits per file as git log on that file alone", async () => {
  const repo = await realpath(await mkdtemp(join(tmpdir(), "quench-git-history-")));
  const write = (path: string, text: string) => Bun.write(join(repo, path), text);
  const commit = async (at: string, message: string) => {
    await git(repo, at, "add", "-A");
    await git(repo, at, "commit", "-q", "-m", message);
  };
  await git(repo, day(1, 1), "init", "-q", "-b", "main");
  await git(repo, day(1, 1), "config", "core.autocrlf", "false");
  await write("a.md", "a1\n");
  await write("b/c.md", "c1\n");
  await write("old/SKILL.md", "dir\n");
  await commit(day(1, 1), "one");
  await git(repo, day(1, 2), "checkout", "-q", "-b", "side");
  await write("a.md", "a-side\n");
  await write("b/c.md", "c2\n");
  await commit(day(1, 3), "side");
  await git(repo, day(1, 4), "checkout", "-q", "main");
  await write("b/c.md", "c2\n");
  await commit(day(1, 4), "same change on main");
  await write("a.md", "a-main\n");
  await commit(day(1, 5), "main");
  await git(repo, day(1, 6), "merge", "-q", "-s", "ours", "--no-edit", "side");
  await rm(join(repo, "old"), { recursive: true });
  await write("old", "now a file\n");
  await commit(day(1, 7), "dir to file");
  await mkdir(join(repo, "d"));
  await write("d/e.md", "e1\n");
  await commit(day(1, 8), "late");
  const files = ["a.md", "b/c.md", "old", "d/e.md", "never.md"].map((f) => join(repo, f));
  const found = await gitChanges(files);
  for (const file of files)
    expect((found.get(file) ?? []).map(({ at, blob }) => ({ at, blob }))).toEqual(perFile(file));
  expect(found.get(join(repo, "a.md"))!.length).toBe(2);
  expect(found.get(join(repo, "old"))!.length).toBe(2);
  await rm(repo, { recursive: true, force: true });
});
