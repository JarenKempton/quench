import { harnessById, harnesses, type HarnessId, type SessionPlace } from "@quench/history";
import { table, tokens } from "./format.ts";

export type SkillUse = {
  harness: HarnessId;
  sessions: number;
  medianListed: number | null;
  medianChars: number | null;
  useRecorded: boolean;
  skills: { name: string; listedIn: number; usedIn: number; byUser: number }[];
};

const SHOWN = 8;

export function skillUse(places: readonly SessionPlace[]): SkillUse[] {
  return harnesses.flatMap((harness) => {
    const recorded = places.flatMap((p) =>
      p.harness === harness.id && p.skills ? [p.skills] : [],
    );
    if (!recorded.length) return [];
    const skills = new Map<string, SkillUse["skills"][number]>();
    const entry = (name: string) =>
      skills.get(name) ?? skills.set(name, { name, listedIn: 0, usedIn: 0, byUser: 0 }).get(name)!;
    for (const session of recorded) {
      for (const skill of session.listed) entry(skill.name).listedIn++;
      for (const use of session.used) {
        entry(use.name).usedIn++;
        if (use.by === "user") entry(use.name).byUser++;
      }
    }
    return [
      {
        harness: harness.id,
        sessions: recorded.length,
        medianListed: median(recorded.map((s) => s.upFront.count)),
        medianChars: median(recorded.map((s) => s.upFront.chars)),
        useRecorded: harness.skillUse,
        skills: [...skills.values()].sort(
          (a, b) => b.usedIn - a.usedIn || b.listedIn - a.listedIn || a.name.localeCompare(b.name),
        ),
      },
    ];
  });
}

export function renderSkillUse(uses: SkillUse[], days: number): string[] {
  if (!uses.length) return [];
  const known = uses.filter((u) => u.useRecorded);
  const lines = [
    "",
    `Recorded skills · what session histories listed and used · last ${days} days`,
    ...table(
      [
        ["Agent", "Sessions", "Listed", "Listing size", "Used", "Never used"],
        ...uses.map((u) => [
          harnessById[u.harness].label,
          u.sessions.toLocaleString("en-US"),
          u.medianListed === null ? "—" : String(u.medianListed),
          u.medianChars === null ? "—" : `${tokens(u.medianChars)} chars`,
          u.useRecorded ? String(u.skills.filter((s) => s.usedIn).length) : "unknown",
          u.useRecorded ? String(u.skills.filter((s) => !s.usedIn).length) : "unknown",
        ]),
      ],
      [1, 2, 3, 4, 5],
    ),
  ];
  for (const u of known) {
    const label = harnessById[u.harness].label;
    const used = u.skills.filter((s) => s.usedIn);
    const unused = u.skills.filter((s) => !s.usedIn);
    if (used.length)
      lines.push(`  Most used · ${label}: ${list(used.map((s) => `${s.name} ${s.usedIn}`))}`);
    if (unused.length)
      lines.push(`  Listed, never used · ${label}: ${list(unused.map((s) => s.name))}`);
  }
  const unknown = uses.filter((u) => !u.useRecorded).map((u) => harnessById[u.harness].label);
  if (unknown.length)
    lines.push(`  ${unknown.join(", ")} history does not record skill use, so it is unknown.`);
  return lines;
}

const list = (items: string[]) =>
  items.slice(0, SHOWN).join(", ") +
  (items.length > SHOWN ? `, … ${items.length - SHOWN} more in --json` : "");

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
