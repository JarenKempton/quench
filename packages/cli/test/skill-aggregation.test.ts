import { expect, test } from "bun:test";
import type { ListedSkill, SessionPlace, SkillOrigin } from "@quench/history";
import { skillUse, type PlaceOrigin } from "../src/profile/recorded-skills.ts";
import { skillCuts } from "../src/profile/skill-cuts.ts";

type Listed = [name: string, chars: number | null, used?: boolean];

const place = (harness: SessionPlace["harness"], cwd: string, listed: Listed[]) =>
  ({
    harness,
    cwd,
    skills: {
      listed: listed.map(([name, chars]) => ({ name, path: null, chars })),
      upFront: { count: listed.length, chars: 0 },
      used: listed.filter(([, , used]) => used).map(([name]) => ({ name, by: "model" })),
    },
  }) as unknown as SessionPlace;

const folder = (path: string): SkillOrigin => ({ kind: "folder", scope: "project", path });

function cuts(places: SessionPlace[], originOf: PlaceOrigin) {
  const { occurrences } = skillUse(places, originOf);
  return skillCuts(
    occurrences,
    () => true,
    (_, origin) => ({
      command: origin.kind === "folder" ? `rm -r -- ${origin.path}` : `remove ${origin.kind}`,
      note: null,
    }),
  ).cuts;
}

const brief = (c: {
  what: string;
  sessions: number;
  command: string | null;
  note: string | null;
}) => [c.what, c.sessions, c.command ?? c.note];

test("a skill name in two project folders is cut per folder, and a built-in does not hide a project skill", () => {
  const byFolder: PlaceOrigin = (p, s: ListedSkill) =>
    p.cwd === "/c" && s.name === "simplify" ? { kind: "built-in" } : folder(`${p.cwd}/${s.name}`);
  expect(
    cuts(
      [
        place("claude-code", "/a", [["foo", 10]]),
        place("claude-code", "/b", [["foo", 10]]),
        place("claude-code", "/c", [["simplify", 10]]),
        place("claude-code", "/d", [["simplify", 10]]),
      ],
      byFolder,
    ).map(brief),
  ).toEqual([
    ["foo", 1, "rm -r -- /a/foo"],
    ["foo", 1, "rm -r -- /b/foo"],
    ["simplify", 1, "rm -r -- /d/simplify"],
  ]);
});

test("a shared folder another agent still uses gets no delete command and names who uses it", () => {
  const shared: PlaceOrigin = (_, s) => folder(`/home/me/.agents/skills/${s.name}`);
  expect(
    cuts(
      [place("codex", "/w", [["notes", 10]]), place("pi", "/w", [["notes", 10, true]])],
      shared,
    ).map((c) => [c.agents, c.command, c.note]),
  ).toEqual([[["codex", "pi"], null, "no command, still used: Pi notes 1"]]);
});

test("unknown listing sizes stay unknown and rank after known ones", () => {
  const each: PlaceOrigin = (_, s) => folder(`/s/${s.name}`);
  const found = cuts(
    [
      place("claude-code", "/w", [
        ["sized", 5],
        ["unsized", null],
        ["partly", 7],
      ]),
      place("claude-code", "/w", [
        ["unsized", null],
        ["partly", null],
      ]),
    ],
    each,
  );
  expect(found.map((c) => [c.what, c.listedChars, c.unsizedSessions, c.sessions])).toEqual([
    ["partly", 7, 1, 2],
    ["sized", 5, 0, 1],
    ["unsized", 0, 2, 2],
  ]);
});

test("a plugin row counts every session that listed any of its skills", () => {
  const plugin: PlaceOrigin = () => ({ kind: "plugin", plugin: "p@m", installedByDefault: false });
  expect(
    cuts(
      [
        place("codex", "/w", [["p:a", 1]]),
        place("codex", "/w", [["p:b", 1]]),
        place("codex", "/w", [
          ["p:a", 1],
          ["p:b", 1],
        ]),
      ],
      plugin,
    ).map(brief),
  ).toEqual([["p@m", 3, "remove plugin"]]);
});
