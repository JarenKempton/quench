import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  harnessById,
  harnesses,
  skillFolder,
  type HarnessId,
  type Home,
  type Skill,
  type SkillOrigin,
} from "@quench/history";
import { treeHash, type TreeHash } from "@quench/fleet";
import { inside, readTree } from "@quench/fleet/disk";
import { median } from "../format.ts";
import type { Occurrence, SkillUse } from "../profile/recorded-skills.ts";
import type { CoOccurrence } from "./co-occurrence.ts";

export const SCHEMA_VERSION = 1;

export const ORIGINS = ["user", "project", "plugin", "vendored"] as const;
export type Origin = (typeof ORIGINS)[number];

export type Use = {
  sessionsListed: number | null;
  used: number | null;
  usedByUser: number | null;
  lowerBound: boolean;
};

export type SkillRecord = {
  id: string;
  skill: string;
  harness: HarnessId;
  location: string;
  origin: Origin | null;
  contentVersion: TreeHash | null;
  listedBy: HarnessId[];
  listingChars: number | null;
  recordedListingChars: number | null;
  bodyBytes: number | null;
  use: Use;
  coOccurrence: CoOccurrence;
};

type Draft = Omit<SkillRecord, "id" | "listedBy" | "coOccurrence" | "contentVersion"> & {
  folder: string | null;
};

export const display = (homeDir: string, path: string) => {
  const slashed = path.replaceAll("\\", "/");
  const prefix = homeDir.replaceAll("\\", "/").replace(/\/+$/, "");
  return slashed === prefix
    ? "~"
    : slashed.startsWith(`${prefix}/`)
      ? `~${slashed.slice(prefix.length)}`
      : slashed;
};

export function originOf(origin: SkillOrigin, homes: readonly string[]): Origin | null {
  if (origin.kind === "plugin") return "plugin";
  if (origin.kind === "built-in") return "vendored";
  if (origin.kind === "not-found") return null;
  return folderOrigin(origin.scope, origin.realPath, homes);
}

function folderOrigin(
  scope: Skill["sources"][number]["scope"],
  realPath: string,
  homes: readonly string[],
): Origin {
  if (scope === "project" || scope === "ancestor") return "project";
  if (scope === "system" || !homes.some((dir) => inside(dir, realPath))) return "vendored";
  return "user";
}

export function locationOf(origin: SkillOrigin, homeDir: string): string {
  if (origin.kind === "folder" && origin.repo)
    return `${display(homeDir, origin.repo.root)}/${origin.repo.path}`;
  if (origin.kind === "folder") return display(homeDir, origin.path);
  if (origin.kind === "plugin") return `plugin:${origin.plugin}`;
  if (origin.kind === "built-in") return "built-in";
  return origin.path ? display(homeDir, skillFolder(origin.path)) : "unknown";
}

async function bodyOf(path: string): Promise<number | null> {
  const info = await stat(path).catch(() => null);
  if (info?.isFile()) return info.size;
  const skill = info?.isDirectory() ? await stat(join(path, "SKILL.md")).catch(() => null) : null;
  return skill?.isFile() ? skill.size : null;
}

const keyOf = (r: { skill: string; harness: HarnessId; location: string }) =>
  `${r.harness}\0${r.skill}\0${r.location}`;

export async function skillRecords(
  home: Home,
  onDisk: readonly Skill[],
  uses: readonly SkillUse[],
  occurrences: readonly Occurrence[],
  coOccurrence: (skill: string) => CoOccurrence,
): Promise<SkillRecord[]> {
  const homes = [home.dir, await realpath(home.dir).catch(() => home.dir)];
  const drafts = new Map<string, Draft>();
  const recordedBy = new Set(uses.map((u) => u.harness));
  const useOf = (harness: HarnessId): Use => {
    const recorded = recordedBy.has(harness);
    const counted = recorded && harnessById[harness].skillUse;
    return {
      sessionsListed: recorded ? 0 : null,
      used: counted ? 0 : null,
      usedByUser: counted ? 0 : null,
      lowerBound: harness === "codex",
    };
  };
  for (const skill of onDisk)
    for (const source of skill.sources) {
      const folder = skillFolder(source.path);
      const draft: Draft = {
        skill: skill.name,
        harness: source.harness,
        location: display(home.dir, folder),
        origin: folderOrigin(source.scope, skill.realPath, homes),
        listingChars: skill.modelInvocable ? skill.indexChars : 0,
        recordedListingChars: null,
        bodyBytes: skill.bodyBytes,
        use: useOf(source.harness),
        folder: /[\\/]SKILL\.md$/.test(source.path) ? folder : null,
      };
      if (!drafts.has(keyOf(draft))) drafts.set(keyOf(draft), draft);
    }
  const charsByKey = new Map<string, number[]>();
  for (const o of occurrences)
    if (o.chars !== null) {
      const key = keyOf({
        skill: o.name,
        harness: o.harness,
        location: locationOf(o.origin, home.dir),
      });
      charsByKey.set(key, [...(charsByKey.get(key) ?? []), o.chars]);
    }
  for (const use of uses)
    for (const s of use.skills) {
      const location = locationOf(s.origin, home.dir);
      const key = keyOf({ skill: s.name, harness: use.harness, location });
      const draft =
        drafts.get(key) ??
        drafts
          .set(key, {
            skill: s.name,
            harness: use.harness,
            location,
            origin: originOf(s.origin, homes),
            listingChars: null,
            recordedListingChars: null,
            bodyBytes: null,
            use: useOf(use.harness),
            folder: s.origin.kind === "folder" ? s.origin.realPath : null,
          })
          .get(key)!;
      draft.recordedListingChars = median(charsByKey.get(key) ?? []);
      draft.use.sessionsListed = (draft.use.sessionsListed ?? 0) + s.listedIn;
      if (draft.use.used !== null) draft.use.used += s.usedIn;
      if (draft.use.usedByUser !== null) draft.use.usedByUser += s.byUser;
    }
  const hashes = new Map<string, Promise<TreeHash | null>>();
  const hashOf = (folder: string) =>
    hashes.get(folder) ??
    hashes
      .set(
        folder,
        readTree(folder).then(
          (tree) => (tree.some((e) => e.path === "SKILL.md") ? treeHash(tree) : null),
          () => null,
        ),
      )
      .get(folder)!;
  const records = await Promise.all(
    [...drafts.values()].map(async ({ folder, ...draft }) => ({
      ...draft,
      bodyBytes: draft.bodyBytes ?? (folder ? await bodyOf(folder) : null),
      contentVersion: folder ? await hashOf(folder) : null,
    })),
  );
  const order = harnesses.map((h) => h.id);
  return records
    .map((r) => ({
      id: `${r.skill}|${r.harness}|${r.location}`,
      ...r,
      listedBy: order.filter((h) =>
        records.some(
          (o) =>
            o.harness === h &&
            o.skill === r.skill &&
            (o.use.sessionsListed ?? 0) > 0 &&
            (r.contentVersion ? o.contentVersion === r.contentVersion : o.location === r.location),
        ),
      ),
      coOccurrence: coOccurrence(r.skill),
    }))
    .sort(
      (a, b) =>
        a.skill.localeCompare(b.skill) ||
        order.indexOf(a.harness) - order.indexOf(b.harness) ||
        a.location.localeCompare(b.location),
    );
}
