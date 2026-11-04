import { harnessById, type HarnessId, type SkillCut, type SkillOrigin } from "@quench/history";
import { chars, count, plural, table } from "../format.ts";
import { dim, heading } from "../style.ts";
import type { Occurrence, SkillUse } from "./recorded-skills.ts";

export type Cut = {
  what: string;
  source: string;
  agents: HarnessId[];
  skills: string[];
  usedBy: string[];
  sessions: number;
  listedChars: number;
  unsizedSessions: number;
  command: string | null;
  note: string | null;
};

export type SkillCuts = { cuts: Cut[]; notOnDisk: { harness: HarnessId; skills: string[] }[] };

export type CutOf = (harness: HarnessId, origin: SkillOrigin) => SkillCut;

const SHOWN = 10;

export const neverUsed = (u: SkillUse) =>
  u.skills.filter((s) => !s.usedIn && s.origin.kind !== "built-in");

const SOURCE_LABELS: Record<string, string> = {
  "built-in": "built-in",
  plugin: "plugin",
  user: "user folder",
  system: "system folder",
  project: "project folder",
  ancestor: "parent folder",
  "not-found": "not on disk now",
};

export const sourceOf = (origin: SkillOrigin) =>
  SOURCE_LABELS[origin.kind === "folder" ? origin.scope : origin.kind]!;

type Target = {
  origin: SkillOrigin;
  harnesses: Set<HarnessId>;
  sessions: Set<number>;
  unsized: Set<number>;
  chars: number;
  names: Set<string>;
  listings: Map<string, string>;
  usedListings: Set<string>;
  uses: Map<string, number>;
};

export function skillCuts(
  occurrences: readonly Occurrence[],
  useRecorded: (harness: HarnessId) => boolean,
  cutOf: CutOf,
): SkillCuts {
  const targets = new Map<string, Target>();
  for (const o of occurrences) {
    const t =
      targets.get(o.target) ??
      targets
        .set(o.target, {
          origin: o.origin,
          harnesses: new Set(),
          sessions: new Set(),
          unsized: new Set(),
          chars: 0,
          names: new Set(),
          listings: new Map(),
          usedListings: new Set(),
          uses: new Map(),
        })
        .get(o.target)!;
    t.harnesses.add(o.harness);
    t.sessions.add(o.session);
    t.names.add(o.name);
    const listing = `${o.harness}\0${o.name}`;
    t.listings.set(listing, o.name);
    if (o.chars === null) t.unsized.add(o.session);
    else t.chars += o.chars;
    if (!o.used) continue;
    const user = `${harnessById[o.harness].label} ${o.name}`;
    t.usedListings.add(listing);
    t.uses.set(user, (t.uses.get(user) ?? 0) + 1);
  }
  const cuts: Cut[] = [];
  const notOnDisk = new Map<HarnessId, string[]>();
  for (const t of targets.values()) {
    const unused = [
      ...new Set([...t.listings].filter(([l]) => !t.usedListings.has(l)).map(([, name]) => name)),
    ];
    const recorded = [...t.harnesses].filter(useRecorded);
    if (!unused.length || !recorded.length || t.origin.kind === "built-in") continue;
    if (t.origin.kind === "not-found") {
      const [harness] = t.harnesses;
      notOnDisk.set(harness!, [...(notOnDisk.get(harness!) ?? []), ...unused]);
      continue;
    }
    const unknown = [...t.harnesses].filter((h) => !useRecorded(h));
    cuts.push(cutFrom(t, unused, cutOf(recorded[0]!, t.origin), unknown));
  }
  return {
    cuts: cuts.sort(
      (a, b) =>
        Number(a.unsizedSessions === a.sessions) - Number(b.unsizedSessions === b.sessions) ||
        b.listedChars - a.listedChars ||
        a.what.localeCompare(b.what),
    ),
    notOnDisk: [...notOnDisk].map(([harness, skills]) => ({ harness, skills })),
  };
}

function cutFrom(t: Target, unused: string[], cut: SkillCut, unknown: HarnessId[]): Cut {
  const usedBy = [...t.uses].map(([user, n]) => `${user} ${n}`);
  const withheld = usedBy.length
    ? `still used: ${usedBy.join(", ")}`
    : unknown.length
      ? `use not recorded by ${unknown.map((h) => harnessById[h].label).join(", ")}`
      : null;
  return {
    what: t.origin.kind === "plugin" ? t.origin.plugin : [...t.names].join(" / "),
    source:
      t.origin.kind === "plugin" && t.origin.installedByDefault
        ? "plugin, installed by default"
        : sourceOf(t.origin),
    agents: [...t.harnesses],
    skills: unused,
    usedBy,
    sessions: t.sessions.size,
    listedChars: t.chars,
    unsizedSessions: t.unsized.size,
    command: withheld ? null : cut.command,
    note: withheld ? `no command, ${withheld}` : cut.note,
  };
}

export function renderCuts({ cuts, notOnDisk }: SkillCuts, homeDir: string): string[] {
  if (!cuts.length && !notOnDisk.length) return [];
  const lines = [
    "",
    heading("Cut list · listed, never used · ranked by listing size × sessions listed"),
  ];
  if (cuts.length)
    lines.push(
      ...table(
        [
          ["Listed", "Sessions", "Agent", "Cut", "Source", "Command"],
          ...cuts.slice(0, SHOWN).map((cut) => row(cut, homeDir)),
        ],
        [0, 1],
      ),
    );
  if (cuts.length > SHOWN) lines.push(`  ${dim(`… ${cuts.length - SHOWN} more in --json`)}`);
  for (const { harness, skills } of notOnDisk)
    lines.push(
      `  Not on disk now, nothing to cut · ${harnessById[harness].label}: ${list(skills)}`,
    );
  lines.push(
    `  ${dim("Listed: each skill's own entry in the recorded listings, summed over the sessions that listed it; ≥ when some sessions recorded no per-skill text, unknown when none did.")}`,
  );
  return lines;
}

function row(cut: Cut, homeDir: string): string[] {
  const what =
    cut.skills.length > 1 ? `${cut.what} (${plural(cut.skills.length, "skill")})` : cut.what;
  return [
    cut.unsizedSessions === cut.sessions
      ? "unknown"
      : `${cut.unsizedSessions ? "≥" : ""}${chars(cut.listedChars)}`,
    count(cut.sessions),
    cut.agents.map((h) => harnessById[h].label).join(", "),
    what,
    cut.source,
    [cut.command && home(cut.command, homeDir), cut.note].filter(Boolean).join(" · "),
  ];
}

const home = (command: string, homeDir: string) => command.replace(` -- ${homeDir}/`, " -- ~/");

export const list = (items: string[], shown = 8) =>
  items.slice(0, shown).join(", ") +
  (items.length > shown ? `, … ${items.length - shown} more in --json` : "");
