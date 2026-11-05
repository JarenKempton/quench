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
import { sha256, treeHash, type TreeHash } from "@quench/fleet";
import { inside, readTree } from "@quench/fleet/disk";
import { median } from "../format.ts";
import type { Occurrence } from "../profile/recorded-skills.ts";
import type { CoOccurrence } from "./co-occurrence.ts";

export const SCHEMA_VERSION = 1;

export const ORIGINS = ["user", "project", "plugin", "vendored"] as const;
export type Origin = (typeof ORIGINS)[number];

export const RECORDED_ONLY = "recorded-only";

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

type Draft = {
  skill: string;
  harness: HarnessId;
  location: string;
  origin: Origin | null;
  folder: string | null;
  listingChars: number | null;
  bodyBytes: number | null;
  sessions: string[];
  listedChars: number[];
  used: number;
  usedByUser: number;
};

export type RecordInputs = {
  onDisk: readonly Skill[];
  occurrences: readonly Occurrence[];
  sessionKeys: readonly string[];
  recordedHarnesses: ReadonlySet<HarnessId>;
  roots: readonly string[];
  coOccurrence: (skill: string, sessions: readonly string[]) => CoOccurrence;
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

function folderOrigin(
  scope: Skill["sources"][number]["scope"],
  realPath: string,
  homes: readonly string[],
): Origin {
  if (scope === "project" || scope === "ancestor") return "project";
  if (scope === "system" || !homes.some((dir) => inside(dir, realPath))) return "vendored";
  return "user";
}

const originOf = (origin: SkillOrigin, homes: readonly string[]): Origin | null =>
  origin.kind === "plugin"
    ? "plugin"
    : origin.kind === "built-in"
      ? "vendored"
      : origin.kind === "folder"
        ? folderOrigin(origin.scope, origin.realPath, homes)
        : null;

async function bodyOf(path: string): Promise<number | null> {
  const info = await stat(path).catch(() => null);
  if (info?.isFile()) return info.size;
  const skill = info?.isDirectory() ? await stat(join(path, "SKILL.md")).catch(() => null) : null;
  return skill?.isFile() ? skill.size : null;
}

const keyOf = (r: { skill: string; harness: HarnessId; location: string }) =>
  `${r.harness}\0${r.skill}\0${r.location}`;

export async function skillRecords(home: Home, inputs: RecordInputs): Promise<SkillRecord[]> {
  const homes = [home.dir, await realpath(home.dir).catch(() => home.dir)];
  const onDiskNow = new Map<string, Promise<boolean>>();
  const known = (path: string) =>
    onDiskNow.get(path) ??
    onDiskNow
      .set(
        path,
        inputs.roots.some((root) => inside(root, path))
          ? stat(path).then(
              () => true,
              () => false,
            )
          : Promise.resolve(false),
      )
      .get(path)!;
  const placeOf = async (
    origin: SkillOrigin,
    path: string | null,
  ): Promise<{ location: string; folder: string | null }> => {
    if (origin.kind === "built-in") return { location: "built-in", folder: null };
    if (origin.kind === "folder" && (await known(origin.path)))
      return {
        location: origin.repo
          ? `${display(home.dir, origin.repo.root)}/${origin.repo.path}`
          : display(home.dir, origin.path),
        folder: origin.realPath,
      };
    if (origin.kind === "plugin") {
      const folder = path && skillFolder(path);
      return folder && (await known(folder))
        ? { location: display(home.dir, folder), folder }
        : { location: `plugin:${origin.plugin}`, folder: null };
    }
    return { location: RECORDED_ONLY, folder: null };
  };

  const drafts = new Map<string, Draft>();
  const draftOf = (base: Omit<Draft, "sessions" | "listedChars" | "used" | "usedByUser">) =>
    drafts.get(keyOf(base)) ??
    drafts
      .set(keyOf(base), { ...base, sessions: [], listedChars: [], used: 0, usedByUser: 0 })
      .get(keyOf(base))!;
  for (const skill of inputs.onDisk)
    for (const source of skill.sources) {
      const folder = skillFolder(source.path);
      draftOf({
        skill: skill.name,
        harness: source.harness,
        location: display(home.dir, folder),
        origin: folderOrigin(source.scope, skill.realPath, homes),
        folder: folder === source.path ? null : folder,
        listingChars: skill.modelInvocable ? skill.indexChars : 0,
        bodyBytes: skill.bodyBytes,
      });
    }
  for (const o of inputs.occurrences) {
    const place = await placeOf(o.origin, o.path);
    const draft = draftOf({
      skill: o.name,
      harness: o.harness,
      ...place,
      origin: originOf(o.origin, homes),
      listingChars: null,
      bodyBytes: null,
    });
    draft.sessions.push(inputs.sessionKeys[o.session]!);
    if (o.chars !== null) draft.listedChars.push(o.chars);
    if (o.used) draft.used++;
    if (o.byUser) draft.usedByUser++;
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
    [...drafts.values()].map(async (d) => {
      const recorded = inputs.recordedHarnesses.has(d.harness);
      const counted = recorded && harnessById[d.harness].skillUse;
      return {
        id: `sha256:${sha256(`${d.skill}\0${d.harness}\0${d.location}`)}`,
        skill: d.skill,
        harness: d.harness,
        location: d.location,
        origin: d.origin,
        contentVersion: d.folder ? await hashOf(d.folder) : null,
        listingChars: d.listingChars,
        recordedListingChars: median(d.listedChars),
        bodyBytes: d.bodyBytes ?? (d.folder ? await bodyOf(d.folder) : null),
        use: {
          sessionsListed: recorded ? d.sessions.length : null,
          used: counted ? d.used : null,
          usedByUser: counted ? d.usedByUser : null,
          lowerBound: d.harness === "codex",
        },
        coOccurrence: inputs.coOccurrence(d.skill, d.sessions),
      };
    }),
  );
  const order = harnesses.map((h) => h.id);
  return records
    .map((r) => ({
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
    }))
    .sort(
      (a, b) =>
        a.skill.localeCompare(b.skill) ||
        order.indexOf(a.harness) - order.indexOf(b.harness) ||
        a.location.localeCompare(b.location),
    );
}
