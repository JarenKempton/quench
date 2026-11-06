import { expect, test } from "bun:test";
import { freshness, plan, type Repository, type Worktree } from "../src/housekeeping.ts";

const worktree = (over: Partial<Worktree> & { path: string }): Worktree => ({
  branch: "feature",
  head: "abc",
  locked: false,
  missing: false,
  active: false,
  dirty: false,
  merged: true,
  upstreamGone: false,
  removable: true,
  reasons: [],
  ...over,
});

const repo: Repository = {
  root: "/work/it's repo",
  base: "origin/main",
  worktrees: [
    worktree({ path: "/work/trees/done one" }),
    worktree({ path: "/work/trees/plain" }),
    worktree({
      path: "/work/trees/dirty",
      removable: false,
      dirty: true,
      reasons: ["uncommitted or untracked changes"],
    }),
    worktree({ path: "/work/trees/busy", active: true, removable: false, reasons: ["x"] }),
    worktree({ path: "/work/trees/gone", missing: true, removable: false, reasons: ["y"] }),
  ],
};

test("only worktrees the CLI marks removable get a command, quoted for the viewer's shell", () => {
  const posix = plan(repo, "posix");
  expect(posix.removable.map((r) => r.command)).toEqual([
    `git -C '/work/it'\\''s repo' worktree remove '/work/trees/done one'`,
    `git -C '/work/it'\\''s repo' worktree remove /work/trees/plain`,
  ]);
  expect(posix.kept.map((w) => w.path)).toEqual(["/work/trees/dirty"]);
  expect(posix.active).toBe(1);
  expect(posix.prune).toBe(`git -C '/work/it'\\''s repo' worktree prune`);
  expect(plan(repo, "powershell").removable[0]!.command).toBe(
    `git -C '/work/it''s repo' worktree remove '/work/trees/done one'`,
  );
});

test("a served result says how old it is and whether a newer one is on the way", () => {
  const now = Date.parse("2026-11-06T12:00:00Z");
  expect(freshness("2026-11-06T11:59:40Z", false, now)).toBe("as of just now");
  expect(freshness("2026-11-06T11:48:00Z", true, now)).toBe("as of 12 min ago · refreshing…");
  expect(freshness("2026-11-06T09:00:00Z", false, now)).toBe("as of 3 h ago");
});
