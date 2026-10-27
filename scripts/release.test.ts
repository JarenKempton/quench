import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  nextVersion,
  nightlyVersion,
  planNightly,
  planStable,
  previewedVersion,
} from "./release.ts";

test("the next version follows conventional commits, with minor bumps before 1.0", () => {
  expect(nextVersion(null, ["feat: a"])).toBe("0.1.0");
  expect(nextVersion("v0.1.0", ["fix: a", "docs: b"])).toBe("0.1.1");
  expect(nextVersion("v0.1.3", ["fix: a", "feat(cli): b"])).toBe("0.2.0");
  expect(nextVersion("v0.4.1", ["refactor!: a"])).toBe("0.5.0");
  expect(nextVersion("v1.2.3", ["fix: a"])).toBe("1.2.4");
  expect(nextVersion("v1.2.3", ["feat: a"])).toBe("1.3.0");
  expect(nextVersion("v1.2.3", ["fix: a\n\nBREAKING CHANGE: b"])).toBe("2.0.0");
});

test("nightly versions carry the version they preview, the day and the run", () => {
  const version = nightlyVersion("0.2.0", new Date("2026-10-27T12:00:00Z"), 14);
  expect(version).toBe("0.2.0-nightly.20261027.14");
  expect(previewedVersion(`v${version}`)).toBe("0.2.0");
  expect(previewedVersion("v0.2.0")).toBeNull();
});

const refusal = (version: string) =>
  planStable(version).then(
    () => "",
    (error: Error) => error.message,
  );

test("promoting ships the latest nightly's commit as the version it previewed", async () => {
  const repo = await mkdtemp(join(tmpdir(), "quench-release-"));
  const git = (...args: string[]) => $`git -C ${repo} ${args}`.quiet();
  await git("init", "-q");
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "t");
  const commit = async (message: string) => {
    await git("commit", "-q", "--allow-empty", "-m", message);
    return (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
  };
  const cwd = process.cwd();
  process.chdir(repo);
  try {
    await commit("feat: first");
    const first = await planNightly(1, new Date("2026-10-27T00:00:00Z"));
    expect(first).toMatchObject({
      tag: "v0.1.0-nightly.20261027.1",
      prerelease: true,
      previous: "",
    });
    await git("tag", first.tag);
    const fixed = await commit("fix: later");
    const second = await planNightly(2, new Date("2026-10-27T00:00:00Z"));
    expect(second).toMatchObject({
      tag: "v0.1.0-nightly.20261027.2",
      previous: first.tag,
      sha: fixed,
    });
    await git("tag", second.tag);
    await commit("feat: not in a nightly yet");

    expect(await planStable("")).toMatchObject({
      tag: "v0.1.0",
      version: "0.1.0",
      sha: fixed,
      prerelease: false,
      previous: "",
    });
    await git("tag", "v0.1.0", fixed);
    expect(await refusal("")).toContain("v0.1.0 is already released.");
    expect(await refusal("0.0.9")).toContain("not newer than v0.1.0");
    expect(await refusal("banana")).toContain("is not a version");

    const third = await planNightly(3, new Date("2026-10-28T00:00:00Z"));
    expect(third).toMatchObject({ tag: "v0.2.0-nightly.20261028.3", previous: second.tag });
  } finally {
    process.chdir(cwd);
  }
});
