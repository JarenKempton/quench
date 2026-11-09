import { heading } from "../style.ts";
import {
  harnessById,
  harnesses,
  type HarnessId,
  type ListedSkill,
  type SessionPlace,
  type SkillOrigin,
} from "@quench/history";
import { chars, count, median, table } from "../format.ts";
import { list, neverUsed, renderCuts, sourceOf, type SkillCuts } from "./skill-cuts.ts";

export type UsedSkill = {
  name: string;
  target: string;
  listedIn: number;
  usedIn: number;
  byUser: number;
  origin: SkillOrigin;
};

export type SkillUse = {
  harness: HarnessId;
  sessions: number;
  medianListed: number | null;
  medianChars: number | null;
  useRecorded: boolean;
  skills: UsedSkill[];
};

export type Occurrence = {
  session: number;
  harness: HarnessId;
  name: string;
  target: string;
  origin: SkillOrigin;
  path: string | null;
  chars: number | null;
  used: boolean;
  byUser: boolean;
};

export type PlaceOrigin = (place: SessionPlace, skill: ListedSkill) => SkillOrigin;

export function targetOf(harness: HarnessId, origin: SkillOrigin, name: string): string {
  if (origin.kind === "folder" && origin.repo)
    return `repo:${origin.repo.root}\0${origin.repo.path}`;
  if (origin.kind === "folder")
    return origin.link ? `link:${origin.path}` : `folder:${origin.realPath}`;
  if (origin.kind === "plugin") return `plugin:${harness}:${origin.plugin}`;
  return `${origin.kind}:${harness}:${name}`;
}

export function skillUse(places: readonly SessionPlace[], originOf: PlaceOrigin) {
  const occurrences: Occurrence[] = [];
  const uses = harnesses.flatMap((harness): SkillUse[] => {
    const recorded = places.flatMap((place, session) =>
      place.harness === harness.id && place.skills
        ? [{ place, session, skills: place.skills }]
        : [],
    );
    if (!recorded.length) return [];
    const skills = new Map<string, UsedSkill>();
    for (const { place, session, skills: listing } of recorded) {
      const used = new Map(listing.used.map((u) => [u.name, u.by]));
      for (const listed of listing.listed) {
        const origin = originOf(place, listed);
        const target = targetOf(harness.id, origin, listed.name);
        const key = `${target}\0${listed.name}`;
        const skill =
          skills.get(key) ??
          skills
            .set(key, { name: listed.name, target, listedIn: 0, usedIn: 0, byUser: 0, origin })
            .get(key)!;
        skill.listedIn++;
        if (used.has(listed.name)) skill.usedIn++;
        if (used.get(listed.name) === "user") skill.byUser++;
        occurrences.push({
          session,
          harness: harness.id,
          name: listed.name,
          target,
          origin,
          path: listed.path,
          chars: listed.chars,
          used: used.has(listed.name),
          byUser: used.get(listed.name) === "user",
        });
      }
    }
    return [
      {
        harness: harness.id,
        sessions: recorded.length,
        medianListed: median(recorded.map((r) => r.skills.upFront.count)),
        medianChars: median(recorded.map((r) => r.skills.upFront.chars)),
        useRecorded: harness.skillUse,
        skills: [...skills.values()].sort(
          (a, b) => b.usedIn - a.usedIn || b.listedIn - a.listedIn || a.name.localeCompare(b.name),
        ),
      },
    ];
  });
  return { uses, occurrences };
}

export function renderSkillUse(uses: SkillUse[], cuts: SkillCuts, days: number): string[] {
  if (!uses.length) return [];
  const lines = [
    "",
    heading(`Recorded skills · what session histories listed and used · last ${days} days`),
    ...table(
      [
        ["Agent", "Sessions", "Listed", "Listing size", "Used", "Built-in", "Never used"],
        ...uses.map((u) => [
          harnessById[u.harness].label,
          count(u.sessions),
          u.medianListed === null ? "—" : String(u.medianListed),
          u.medianChars === null ? "—" : chars(u.medianChars),
          u.useRecorded ? String(u.skills.filter((s) => s.usedIn).length) : "unknown",
          String(u.skills.filter((s) => s.origin.kind === "built-in").length),
          u.useRecorded ? String(neverUsed(u).length) : "unknown",
        ]),
      ],
      [1, 2, 3, 4, 5, 6],
    ),
  ];
  for (const u of uses) {
    const label = harnessById[u.harness].label;
    lines.push(`  Sources · ${label}: ${skillSources(u)}`);
    const used = u.skills.filter((s) => s.usedIn);
    if (u.useRecorded && used.length)
      lines.push(`  Most used · ${label}: ${list(used.map((s) => `${s.name} ${s.usedIn}`))}`);
    const builtIn = u.skills.filter((s) => s.origin.kind === "built-in" && !s.usedIn);
    if (builtIn.length)
      lines.push(`  Built in, can't be removed · ${label}: ${list(builtIn.map((s) => s.name))}`);
  }
  const unknown = uses.filter((u) => !u.useRecorded).map((u) => harnessById[u.harness].label);
  if (unknown.length)
    lines.push(`  ${unknown.join(", ")} history does not record skill use, so it is unknown.`);
  return [...lines, ...renderCuts(cuts)];
}

export function skillSources(u: SkillUse): string {
  const counts = new Map<string, number>();
  for (const s of u.skills)
    counts.set(sourceOf(s.origin), (counts.get(sourceOf(s.origin)) ?? 0) + 1);
  return [
    `${count(u.skills.length)} different, ${u.medianListed ?? 0} per session`,
    ...[...counts].sort((a, b) => b[1] - a[1]).map(([label, n]) => `${n} ${label}`),
  ].join(" · ");
}
