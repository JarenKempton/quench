import { lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { Home } from "./home.ts";
import type { HarnessId, ListedSkill } from "./model.ts";
import { removeFolder, removeLink, type Shell } from "./removal.ts";
import type { Skill, SkillRoot } from "./skills.ts";

export type SkillOrigin =
  | { kind: "built-in" }
  | { kind: "plugin"; plugin: string; installedByDefault: boolean | null }
  | {
      kind: "folder";
      scope: SkillRoot["scope"];
      path: string;
      realPath: string;
      link: boolean;
    }
  | { kind: "not-found"; path: string | null; plugin: string | null };

export type SkillCut = { command: string | null; note: string | null };

export type CutContext = { home: Home; shell: Shell };

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
      if (same)
        return { kind: "folder", scope: source.scope, ...onDiskPath(removable(source.path)) };
    }
  return null;
}

export function notFound(skill: ListedSkill, plugin: string | null = null): SkillOrigin {
  return { kind: "not-found", path: skill.path, plugin };
}

export function folderCut(origin: SkillOrigin, shell: Shell): SkillCut | null {
  if (origin.kind === "folder")
    return {
      command: origin.link ? removeLink(origin.path, shell) : removeFolder(origin.path, shell),
      note: origin.link ? "removes the link only, not the folder it points to" : null,
    };
  if (origin.kind === "not-found")
    return {
      command: null,
      note: "not found on disk now; removed since, or loaded from elsewhere",
    };
  return null;
}

const removable = (path: string) => (/[\\/]SKILL\.md$/.test(path) ? dirname(path) : path);

const resolved = new Map<string, { path: string; realPath: string; link: boolean }>();

function onDiskPath(path: string) {
  const known = resolved.get(path);
  if (known) return known;
  const realPath = (() => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  })();
  const link = lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
  const found = { path, realPath, link };
  resolved.set(path, found);
  return found;
}
