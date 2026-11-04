import { harnessById, type HarnessId, type SkillOrigin } from "@quench/history";
import { chars, count, plural, table } from "../format.ts";
import { dim, heading } from "../style.ts";
import type { SkillUse, UsedSkill } from "./recorded-skills.ts";

export type Cut = {
  what: string;
  source: string;
  skills: string[];
  alsoUsed: string[];
  sessions: number;
  listedChars: number;
  command: string | null;
  note: string | null;
};

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

export function cutList(skills: readonly UsedSkill[]): Cut[] {
  const cuts = new Map<string, Cut>();
  const pluginOf = (s: UsedSkill) => (s.origin.kind === "plugin" ? s.origin.plugin : null);
  for (const skill of skills) {
    const { origin } = skill;
    if (skill.usedIn || origin.kind === "built-in" || origin.kind === "not-found") continue;
    const key = origin.kind === "plugin" ? origin.plugin : origin.path;
    const cut =
      cuts.get(key) ??
      cuts
        .set(key, {
          what: origin.kind === "plugin" ? origin.plugin : skill.name,
          source:
            origin.kind === "plugin" && origin.installedByDefault
              ? "plugin, installed by default"
              : sourceOf(origin),
          skills: [],
          alsoUsed: skills.filter((s) => s.usedIn && pluginOf(s) === key).map((s) => s.name),
          sessions: 0,
          listedChars: 0,
          command: skill.cut.command,
          note: skill.cut.note,
        })
        .get(key)!;
    cut.skills.push(skill.name);
    cut.sessions = Math.max(cut.sessions, skill.listedIn);
    cut.listedChars += skill.listedChars;
  }
  return [...cuts.values()].sort(
    (a, b) => b.listedChars - a.listedChars || a.what.localeCompare(b.what),
  );
}

export function renderCuts(uses: readonly SkillUse[], homeDir: string): string[] {
  const rows = uses
    .flatMap((u) => u.cuts.map((cut) => ({ harness: u.harness, cut })))
    .sort((a, b) => b.cut.listedChars - a.cut.listedChars);
  const missing = uses.flatMap((u) => {
    const names = neverUsed(u).filter((s) => s.origin.kind === "not-found");
    return names.length
      ? [`${harnessById[u.harness].label}: ${list(names.map((s) => s.name))}`]
      : [];
  });
  if (!rows.length && !missing.length) return [];
  const lines = [
    "",
    heading("Cut list · listed, never used · ranked by listing size × sessions listed"),
  ];
  if (rows.length)
    lines.push(
      ...table(
        [
          ["Listed", "Sessions", "Agent", "Cut", "Source", "Command"],
          ...rows.slice(0, SHOWN).map(({ harness, cut }) => row(harness, cut, homeDir)),
        ],
        [0, 1],
      ),
    );
  if (rows.length > SHOWN) lines.push(`  ${dim(`… ${rows.length - SHOWN} more in --json`)}`);
  for (const line of missing) lines.push(`  Not on disk now, nothing to cut · ${line}`);
  lines.push(
    `  ${dim("Listed: each skill's own entry in the recorded skill listings, summed over the sessions that listed it.")}`,
  );
  return lines;
}

function row(harness: HarnessId, cut: Cut, homeDir: string): string[] {
  const what =
    cut.skills.length > 1 ? `${cut.what} (${plural(cut.skills.length, "skill")})` : cut.what;
  const also = cut.alsoUsed.length ? ` · also removes used ${cut.alsoUsed.join(", ")}` : "";
  return [
    chars(cut.listedChars),
    count(cut.sessions),
    harnessById[harness].label,
    what,
    cut.source,
    [cut.command && home(cut.command, homeDir), cut.note].filter(Boolean).join(" · ") + also,
  ];
}

const home = (command: string, homeDir: string) =>
  command.replace(` ${homeDir}/`, " ~/").replace(` ${homeDir}\\`, " ~\\");

export const list = (items: string[], shown = 8) =>
  items.slice(0, shown).join(", ") +
  (items.length > shown ? `, … ${items.length - shown} more in --json` : "");
