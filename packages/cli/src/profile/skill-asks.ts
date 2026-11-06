import { createHash } from "node:crypto";
import {
  harnessById,
  harnesses,
  type HarnessId,
  type SessionPlace,
  type Skill,
  type SkillAsk,
} from "@quench/history";
import type { AskStatus } from "@quench/judge";
import { count, plural, table } from "../format.ts";
import { dim, heading } from "../style.ts";

export type AskRow = {
  harness: HarnessId;
  name: string;
  used: number;
  measured: "matched" | "judged" | "not measured";
  asked: number | null;
  askedAndLoaded: number | null;
  askedNotLoaded: number | null;
  mentions: number;
  relayed: number;
  relayedAndLoaded: number;
  unknownSender: number;
  pending: number;
  failed: number;
  fix: string | null;
};

export type SkillAsks = {
  judge: string | null;
  newlyJudged: number;
  rows: AskRow[];
  relayed: { messages: number; skills: number };
  unknownSender: { messages: number; skills: number };
};

export type AskVerdicts = (place: SessionPlace, ask: SkillAsk) => AskStatus | null;

export const FIX = "only loads from /name";

export function vocabulary(skills: readonly Skill[], host: boolean) {
  const names = new Map<HarnessId, string[]>(harnesses.map((h) => [h.id, []]));
  for (const skill of skills)
    for (const source of new Set(skill.sources.map((s) => s.harness)))
      names.get(source)!.push(skill.name);
  const key = createHash("sha256")
    .update(JSON.stringify([host, ...[...names].map(([h, n]) => [h, [...new Set(n)].sort()])]))
    .digest("hex")
    .slice(0, 16);
  return { key, names: (harness: HarnessId) => names.get(harness) ?? [] };
}

export const personOneWord = (ask: SkillAsk) => ask.oneWord && ask.sender === "person";

export function skillAsks(
  places: readonly SessionPlace[],
  onDisk: readonly Skill[],
  verdict: AskVerdicts,
  judge: string | null,
  newlyJudged = 0,
): SkillAsks {
  const rows = new Map<string, AskRow>();
  const relayed = { messages: new Set<string>(), skills: new Set<string>() };
  const unknown = { messages: new Set<string>(), skills: new Set<string>() };
  for (const place of places)
    for (const ask of place.asks?.found ?? []) {
      const key = `${place.harness}\0${ask.name}`;
      const row = rows.get(key) ?? rows.set(key, emptyRow(place.harness, ask, judge)).get(key)!;
      const message = `${place.path}\0${ask.event}`;
      if (ask.sender === "automation") {
        row.relayed++;
        if (ask.loaded) row.relayedAndLoaded++;
        relayed.messages.add(message);
        relayed.skills.add(key);
        continue;
      }
      if (ask.sender === "unknown") {
        row.unknownSender++;
        unknown.messages.add(message);
        unknown.skills.add(key);
        continue;
      }
      row.mentions++;
      const status = ask.oneWord ? verdict(place, ask) : "asked";
      if (status === "pending" || status === null) row.pending++;
      if (status === "failed") row.failed++;
      if (status !== "asked") continue;
      row.asked = (row.asked ?? 0) + 1;
      if (ask.loaded) row.askedAndLoaded = (row.askedAndLoaded ?? 0) + 1;
      else row.askedNotLoaded = (row.askedNotLoaded ?? 0) + 1;
    }
  for (const row of rows.values()) {
    row.used = places.filter(
      (p) => p.harness === row.harness && p.skills?.used.some((u) => u.name === row.name),
    ).length;
    if (row.measured === "judged" && row.pending) row.measured = "not measured";
    if (row.measured === "not measured") {
      row.asked = row.askedAndLoaded = row.askedNotLoaded = null;
    } else {
      row.asked ??= 0;
      row.askedAndLoaded ??= 0;
      row.askedNotLoaded ??= 0;
    }
    const manualOnly = onDisk.some(
      (s) =>
        s.name === row.name &&
        !s.modelInvocable &&
        s.sources.some((source) => source.harness === row.harness),
    );
    if (manualOnly && row.harness === "claude-code" && (row.asked ?? row.mentions) > 0)
      row.fix = FIX;
  }
  return {
    judge,
    newlyJudged,
    rows: [...rows.values()].sort(
      (a, b) =>
        (b.askedNotLoaded ?? -1) - (a.askedNotLoaded ?? -1) ||
        b.mentions - a.mentions ||
        b.relayed - a.relayed ||
        a.name.localeCompare(b.name),
    ),
    relayed: { messages: relayed.messages.size, skills: relayed.skills.size },
    unknownSender: { messages: unknown.messages.size, skills: unknown.skills.size },
  };
}

function emptyRow(harness: HarnessId, ask: SkillAsk, judge: string | null): AskRow {
  return {
    harness,
    name: ask.name,
    used: 0,
    measured: !ask.oneWord ? "matched" : judge ? "judged" : "not measured",
    asked: null,
    askedAndLoaded: null,
    askedNotLoaded: null,
    mentions: 0,
    relayed: 0,
    relayedAndLoaded: 0,
    unknownSender: 0,
    pending: 0,
    failed: 0,
    fix: null,
  };
}

export const askedFor = (asks: SkillAsks) => {
  const keys = new Set(
    asks.rows
      .filter((r) => r.asked !== 0 || r.relayed || r.unknownSender || r.pending || r.failed)
      .map((r) => `${r.harness}\0${r.name}`),
  );
  return (harness: HarnessId, name: string) => keys.has(`${harness}\0${name}`);
};

export function renderAsks(asks: SkillAsks, days: number): string[] {
  if (!asks.rows.length) return [];
  const shown = asks.rows.filter((r) => r.mentions);
  const lines = [
    "",
    heading(`Asked in plain words · messages people typed that named a skill · last ${days} days`),
  ];
  if (shown.length)
    lines.push(
      ...table(
        [
          ["Agent", "Skill", "Used", "Asked", "Asked and loaded", "Asked, not loaded", "Note"],
          ...shown.map((r) => [
            harnessById[r.harness].label,
            r.name,
            count(r.used),
            known(r.asked),
            known(r.askedAndLoaded),
            known(r.askedNotLoaded),
            note(r),
          ]),
        ],
        [2, 3, 4, 5],
      ),
    );
  else lines.push("  No message a person typed named a skill.");
  lines.push(
    `  Relayed by agents or automation, not counted as asked: ${plural(asks.relayed.messages, "message")} naming ${plural(asks.relayed.skills, "skill")}`,
  );
  if (asks.unknownSender.messages)
    lines.push(
      `  Sender not recorded, not counted as asked: ${plural(asks.unknownSender.messages, "message")} naming ${plural(asks.unknownSender.skills, "skill")}`,
    );
  if (shown.some((r) => r.measured === "not measured"))
    lines.push(
      `  ${dim("A one-word name is an ordinary word too; it counts as asked only when quench profile skills --asks has Jev (TYPESAFE_API_KEY) judge the message.")}`,
    );
  lines.push(
    `  ${dim("Used: sessions that loaded the skill. Asked: messages; loaded means in the run that message started. Skills asked for are left out of the cut list.")}`,
  );
  return lines;
}

const known = (n: number | null) => (n === null ? "not measured" : count(n));

function note(r: AskRow): string {
  return [
    r.fix && `${r.fix.replace("/name", `/${r.name}`)} (disable-model-invocation)`,
    r.measured === "not measured" && `${plural(r.mentions, "mention")}, one-word name`,
    r.failed && `${count(r.failed)} judge failures`,
  ]
    .filter(Boolean)
    .join(" · ");
}
