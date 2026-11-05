import { harnessById } from "@quench/history";
import { heading } from "../style.ts";
import { chars, count, table } from "../format.ts";
import { list } from "../profile/skill-cuts.ts";
import { BASIS, MIN_SESSIONS } from "./co-occurrence.ts";
import type { Drift } from "./drift.ts";
import type { SkillRecord } from "./records.ts";

const unknown = (n: number | null, lowerBound = false) =>
  n === null ? "unknown" : `${lowerBound && n ? "≥" : ""}${count(n)}`;

const size = (n: number | null) => (n === null ? "unknown" : chars(n));

const version = (hash: string | null) => (hash ? hash.slice(7, 19) : "unknown");

export function renderSkills(
  records: readonly SkillRecord[],
  days: number,
  judge: string,
  drift: Drift | null,
): string {
  const lines = [
    heading(`Skills · one row per skill, agent and location · last ${days} days`),
    ...table(
      [
        [
          "Skill",
          "Agent",
          "Origin",
          "Listed",
          "Used",
          "By you",
          "Listing",
          "Body",
          "Version",
          "Location",
        ],
        ...records.map((r) => [
          r.skill,
          harnessById[r.harness].label,
          r.origin ?? "unknown",
          unknown(r.use.sessionsListed),
          unknown(r.use.used, r.use.lowerBound),
          unknown(r.use.usedByUser, r.use.lowerBound),
          size(r.recordedListingChars ?? r.listingChars),
          r.bodyBytes === null ? "unknown" : `${count(r.bodyBytes)} B`,
          version(r.contentVersion),
          r.location,
        ]),
      ],
      [3, 4, 5, 6, 7],
    ),
    "  Listed, used and by you count sessions. ≥ marks a lower bound: Codex loads skills through the shell.",
    "",
    heading(`Skills loaded and human corrections in the same session · ${BASIS}`),
  ];
  const shown = records.filter((r) => r.coOccurrence.withHumanCorrection !== null);
  if (!shown.length)
    lines.push(`  No skill was loaded in ${MIN_SESSIONS} or more judged sessions.`);
  for (const r of shown)
    lines.push(
      `  ${r.skill} · ${harnessById[r.harness].label} · ${r.location}  ${count(r.coOccurrence.sessionsLoaded)} sessions loaded it · ${count(r.coOccurrence.withHumanCorrection!)} had a human correction · ${count(r.coOccurrence.unjudgedSessions)} not judged yet`,
    );
  lines.push(
    `  Shown at ${MIN_SESSIONS} or more judged sessions of the same skill, agent and location. Verdicts from the ${judge} cache only; no model is called.`,
  );
  if (drift) lines.push("", ...renderDrift(drift));
  return `${lines.join("\n")}\n`;
}

function renderDrift(drift: Drift): string[] {
  const at = (d: { skill: string; harness: keyof typeof harnessById }) =>
    `${d.skill} (${harnessById[d.harness].label})`;
  return [
    heading("Compared with --source by tree hash · read-only"),
    `  In source, not installed: ${list(drift.inSourceNotInstalled.map((d) => d.skill)) || "none"}`,
    `  Installed, not in source: ${list(drift.installedNotInSource.map(at)) || "none"}`,
    `  Content differs: ${list(drift.contentDiffers.map(at)) || "none"}`,
    ...(drift.notCompared.length
      ? [`  Not compared, unreadable: ${list(drift.notCompared.map(at)) || "none"}`]
      : []),
    ...drift.warnings.map((w) => `  Warning: ${w.kind} ×${w.count}`),
  ];
}
