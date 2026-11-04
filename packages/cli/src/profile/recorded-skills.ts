import { heading } from "../style.ts";
import {
  harnessById,
  harnesses,
  type HarnessId,
  type ListedSkill,
  type SessionPlace,
  type SkillCut,
  type SkillOrigin,
} from "@quench/history";
import { chars, count, median, table } from "../format.ts";
import { cutList, list, neverUsed, renderCuts, sourceOf, type Cut } from "./skill-cuts.ts";

export type UsedSkill = {
  name: string;
  listedIn: number;
  usedIn: number;
  byUser: number;
  listedChars: number;
  origin: SkillOrigin;
  cut: SkillCut;
};

export type SkillUse = {
  harness: HarnessId;
  sessions: number;
  medianListed: number | null;
  medianChars: number | null;
  useRecorded: boolean;
  skills: UsedSkill[];
  cuts: Cut[];
};

export type PlaceOrigin = (place: SessionPlace, skill: ListedSkill) => SkillOrigin;

export function skillUse(places: readonly SessionPlace[], originOf: PlaceOrigin): SkillUse[] {
  return harnesses.flatMap((harness) => {
    const recorded = places.filter((p) => p.harness === harness.id && p.skills);
    if (!recorded.length) return [];
    const skills = new Map<string, UsedSkill>();
    const entry = (name: string) =>
      skills.get(name) ??
      skills
        .set(name, {
          name,
          listedIn: 0,
          usedIn: 0,
          byUser: 0,
          listedChars: 0,
          origin: { kind: "not-found", path: null, plugin: null },
          cut: { command: null, note: null },
        })
        .get(name)!;
    for (const place of recorded) {
      for (const listed of place.skills!.listed) {
        const skill = entry(listed.name);
        skill.listedIn++;
        skill.listedChars += listed.chars ?? 0;
        if (skill.origin.kind === "not-found") skill.origin = originOf(place, listed);
      }
      for (const use of place.skills!.used) {
        entry(use.name).usedIn++;
        if (use.by === "user") entry(use.name).byUser++;
      }
    }
    for (const skill of skills.values()) skill.cut = harness.skillCut(skill.origin);
    const sorted = [...skills.values()].sort(
      (a, b) => b.usedIn - a.usedIn || b.listedIn - a.listedIn || a.name.localeCompare(b.name),
    );
    return [
      {
        harness: harness.id,
        sessions: recorded.length,
        medianListed: median(recorded.map((p) => p.skills!.upFront.count)),
        medianChars: median(recorded.map((p) => p.skills!.upFront.chars)),
        useRecorded: harness.skillUse,
        skills: sorted,
        cuts: harness.skillUse ? cutList(sorted) : [],
      },
    ];
  });
}

export function renderSkillUse(uses: SkillUse[], days: number, homeDir: string): string[] {
  if (!uses.length) return [];
  const known = uses.filter((u) => u.useRecorded);
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
    lines.push(`  Sources · ${label}: ${sources(u)}`);
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
  return [...lines, ...renderCuts(known, homeDir)];
}

function sources(u: SkillUse): string {
  const counts = new Map<string, number>();
  for (const s of u.skills)
    counts.set(sourceOf(s.origin), (counts.get(sourceOf(s.origin)) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([label, n]) => `${n} ${label}`)
    .join(" · ");
}
