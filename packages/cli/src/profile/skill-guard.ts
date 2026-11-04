import { dirname } from "node:path";
import type { SkillCut, SkillOrigin } from "@quench/history";

type Folder = Extract<SkillOrigin, { kind: "folder" }>;

export const gitDirOf = (origin: Folder) =>
  origin.link
    ? dirname(origin.path)
    : /\.md$/i.test(origin.realPath)
      ? dirname(origin.realPath)
      : origin.realPath;

export function guardedCut(
  cut: SkillCut,
  origin: SkillOrigin,
  git: ReadonlyMap<string, string | null>,
): SkillCut {
  if (origin.kind !== "folder" || origin.repo) return cut;
  const dir = gitDirOf(origin);
  const top = git.get(dir);
  if (top === null) return cut;
  const where = top ? `inside a git repo (${top})` : `git could not check ${dir}`;
  return origin.link
    ? { command: null, note: `${where}: remove the link ${origin.path} there` }
    : { command: null, note: `remove ${origin.path} · ${where}` };
}
