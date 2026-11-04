import { expect, test } from "bun:test";
import type { SkillOrigin } from "@quench/history";
import { guardedCut } from "../src/profile/skill-guard.ts";

const link: SkillOrigin = {
  kind: "folder",
  scope: "user",
  path: "/home/me/.claude/skills/pr",
  realPath: "/src/skills/pr",
  link: true,
  repo: null,
};
const cut = { command: "rm -- /home/me/.claude/skills/pr", note: "removes the link only" };

test("a link keeps its removal command only when git confirms it is outside any repo", () => {
  const dir = "/home/me/.claude/skills";
  expect(guardedCut(cut, link, new Map([[dir, null]]))).toEqual(cut);
  expect(guardedCut(cut, link, new Map([[dir, "/home/me/.claude"]]))).toEqual({
    command: null,
    note: "inside a git repo (/home/me/.claude): remove the link /home/me/.claude/skills/pr there",
  });
  expect(guardedCut(cut, link, new Map())).toEqual({
    command: null,
    note: "git could not check /home/me/.claude/skills: remove the link /home/me/.claude/skills/pr there",
  });
});
