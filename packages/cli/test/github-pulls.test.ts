import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JudgedSegment } from "@quench/insights";
import { githubPulls, repoOf } from "../src/commands/github-pulls.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const segment = (endedAt: string, markers: string[]): JudgedSegment => ({
  harness: "claude-code",
  sessionId: "s",
  firstTurn: 0,
  lastTurn: 0,
  startedAt: endedAt,
  endedAt,
  runs: 1,
  markers,
  boundary: "session-start",
  repo: "acme/widget",
  cwd: "/wt/one",
});

const listed = (state: string, number = 7) =>
  JSON.stringify([
    {
      number,
      headRefName: "t3/lane",
      headRepositoryOwner: { login: "someone" },
      isCrossRepository: number !== 7,
      state,
      createdAt: "2026-10-20T09:00:00Z",
      closedAt: state === "OPEN" ? "" : "2026-10-20T12:00:00Z",
      mergedAt: state === "MERGED" ? "2026-10-20T12:00:00Z" : "",
    },
  ]);

test("settled PRs and issue numbers come from the archive cache, and an open PR is asked for again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quench-pulls-"));
  dirs.push(dir);
  const calls: string[][] = [];
  let state = "OPEN";
  const gh = async (command: string[]) => (calls.push(command), listed(state));
  const segs = [segment("2026-10-20T11:00:00Z", ["branch:t3/lane", "github:acme/widget#7"])];
  const now = Date.parse("2026-10-21T00:00:00Z");
  const first = await githubPulls(dir, segs, now, gh);
  expect(first.pulls.map((p) => [p.number, p.head, p.state])).toEqual([[7, "t3/lane", "OPEN"]]);
  expect(calls[0]).toEqual(expect.arrayContaining(["gh", "pr", "list", "-R", "acme/widget"]));
  expect(calls[0]).not.toContain("--search");
  state = "MERGED";
  const second = await githubPulls(dir, segs, now + 1, gh);
  expect(calls[1]).toEqual(expect.arrayContaining(["--search", "updated:>=2026-10-21"]));
  expect(second.pulls[0]!.mergedAt).toBe("2026-10-20T12:00:00Z");
  const issue = [{ ...segs[0]!, markers: [...segs[0]!.markers, "github:acme/widget#3"] }];
  const third = await githubPulls(dir, issue, now + 2, gh);
  expect(calls).toHaveLength(2);
  expect(third).toEqual({ pulls: second.pulls, fetched: 0, offline: 0 });
});

test("with no gh the repo stays offline through its backoff and no PR state is invented", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quench-pulls-"));
  dirs.push(dir);
  const result = await githubPulls(
    dir,
    [segment("2026-10-20T11:00:00Z", [])],
    Date.now(),
    async () => null,
  );
  expect(result).toEqual({ pulls: [], fetched: 0, offline: 1 });
  let asked = 0;
  const later = await githubPulls(
    dir,
    [segment("2026-10-20T11:00:00Z", [])],
    Date.now(),
    async () => (asked++, null),
  );
  expect([asked, later.offline]).toEqual([0, 1]);
});

test("a fork's head never looks like a local branch, and only GitHub remotes name a repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quench-pulls-"));
  dirs.push(dir);
  const fork = await githubPulls(dir, [segment("2026-10-20T11:00:00Z", [])], Date.now(), async () =>
    listed("MERGED", 8),
  );
  expect(fork.pulls[0]!.head).toBe("someone:t3/lane");
  const remote = (url: string) => async () => `${url}\n`;
  expect(await repoOf("/wt", remote("git@github.com:Acme/Widget.git"))).toBe("acme/widget");
  expect(await repoOf("/wt", remote("https://github.com/acme/widget"))).toBe("acme/widget");
  expect(await repoOf("/wt", remote("https://gitlab.com/acme/widget.git"))).toBeNull();
  expect(await repoOf(null)).toBeNull();
});

test("an open PR linked only by branch is asked for again with no new activity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quench-pulls-"));
  dirs.push(dir);
  const calls: string[][] = [];
  const gh = async (command: string[]) => (calls.push(command), listed("OPEN"));
  const now = Date.parse("2026-10-21T00:00:00Z");
  await githubPulls(dir, [segment("2026-10-20T11:00:00Z", ["branch:t3/lane"])], now, gh);
  await githubPulls(dir, [segment("2026-10-20T11:00:00Z", ["branch:t3/lane"])], now + 1, gh);
  await githubPulls(dir, [segment("2026-10-20T11:00:00Z", ["branch:t3/done"])], now + 2, gh);
  expect(calls).toHaveLength(2);
});
