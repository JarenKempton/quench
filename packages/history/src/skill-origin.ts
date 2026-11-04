import { dirname } from "node:path";
import type { HarnessId, ListedSkill } from "./model.ts";
import type { Skill, SkillRoot } from "./skills.ts";

export type SkillOrigin =
  | { kind: "built-in" }
  | { kind: "plugin"; plugin: string; installedByDefault: boolean | null }
  | { kind: "folder"; scope: SkillRoot["scope"]; path: string }
  | { kind: "not-found"; path: string | null; plugin: string | null };

export type SkillCut = { command: string | null; note: string | null };

export type OriginOf = (skill: ListedSkill, onDisk: readonly Skill[]) => SkillOrigin;

export function folderOrigin(
  harness: HarnessId,
  skill: ListedSkill,
  onDisk: readonly Skill[],
): SkillOrigin | null {
  for (const found of onDisk)
    for (const source of found.sources) {
      if (source.harness !== harness) continue;
      const same = skill.path
        ? skill.path === source.path || skill.path === found.realPath
        : found.name === skill.name;
      if (same) return { kind: "folder", scope: source.scope, path: removable(source.path) };
    }
  return null;
}

export function notFound(skill: ListedSkill, plugin: string | null = null): SkillOrigin {
  return { kind: "not-found", path: skill.path, plugin };
}

export function folderCut(origin: SkillOrigin): SkillCut | null {
  if (origin.kind === "folder") return { command: `rm -r ${shellPath(origin.path)}`, note: null };
  if (origin.kind === "not-found")
    return {
      command: null,
      note: "not found on disk now; removed since, or loaded from elsewhere",
    };
  return null;
}

const shellPath = (path: string) => (/^[\w@%+=:,./~\\-]+$/.test(path) ? path : `'${path}'`);

const removable = (path: string) => (/[\\/]SKILL\.md$/.test(path) ? dirname(path) : path);
