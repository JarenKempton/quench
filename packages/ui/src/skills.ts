export type Harness = "claude-code" | "codex" | "pi";

export type SkillRecord = {
  id: string;
  skill: string;
  harness: Harness;
  location: string;
  origin: string | null;
  contentVersion: string | null;
  listingChars: number | null;
  recordedListingChars: number | null;
  bodyBytes: number | null;
  use: {
    sessionsListed: number | null;
    used: number | null;
    usedByUser: number | null;
    lowerBound: boolean;
  };
  coOccurrence: {
    sessionsLoaded: number | null;
    withHumanCorrection: number | null;
    unjudgedSessions: number | null;
    noFollowUp: number | null;
  };
};

type Installed = { skill: string; harness: Harness; location: string };

export type SkillsReport = {
  schemaVersion: number;
  days: number;
  judge: string;
  origins: string[];
  skills: SkillRecord[];
  source?: { contentDiffers: (Installed & { installed: string; source: string })[] };
};

export const HARNESS_LABELS: Record<Harness, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  pi: "Pi",
};

export const UNUSED_MIN_SESSIONS = 5;
export const HIGH_CORRECTION_RATE = 0.5;
export const LARGE_LISTING_CHARS = 1000;

export type FlagKind = "unused" | "corrections" | "drift" | "large";

export type Flag = { kind: FlagKind; label: string; reason: string; fix: string };

const same = (a: Installed, b: Installed) =>
  a.skill === b.skill && a.harness === b.harness && a.location === b.location;

export const listing = (r: SkillRecord) => r.recordedListingChars ?? r.listingChars;

export const skillFile = (r: SkillRecord) =>
  r.location.startsWith("~") || r.location.startsWith("/") || /^[A-Za-z]:/.test(r.location)
    ? r.location.toLowerCase().endsWith(".md")
      ? r.location
      : `${r.location}/SKILL.md`
    : null;

export const judgedSessions = (r: SkillRecord) => {
  const c = r.coOccurrence;
  return c.sessionsLoaded === null || c.withHumanCorrection === null
    ? null
    : c.sessionsLoaded - (c.unjudgedSessions ?? 0) - (c.noFollowUp ?? 0);
};

export const correctionRate = (r: SkillRecord) => {
  const judged = judgedSessions(r);
  return judged ? r.coOccurrence.withHumanCorrection! / judged : null;
};

const n = (value: number) => value.toLocaleString("en-US");

const where = (r: SkillRecord) => `${HARNESS_LABELS[r.harness]} at ${r.location}`;

export function flagsOf(r: SkillRecord, report: SkillsReport): Flag[] {
  const flags: Flag[] = [];
  const listed = r.use.sessionsListed;
  if (listed !== null && listed >= UNUSED_MIN_SESSIONS && r.use.used === 0)
    flags.push({
      kind: "unused",
      label: "Unused",
      reason: `Listed in ${n(listed)} sessions in the last ${report.days} days and never used${r.use.lowerBound ? " (Codex uses are a lower bound)" : ""}.`,
      fix: `It was listed to the agent in ${n(listed)} sessions over the last ${report.days} days and never used. Decide whether its description says clearly when to use it. Propose a sharper description, or tell me it should be removed.`,
    });
  const rate = correctionRate(r);
  if (rate !== null && rate >= HIGH_CORRECTION_RATE)
    flags.push({
      kind: "corrections",
      label: "High correction rate",
      reason: `A person corrected the agent in ${r.coOccurrence.withHumanCorrection} of ${judgedSessions(r)} judged sessions that loaded it (co-occurrence, not cause).`,
      fix: `A person corrected the agent in ${r.coOccurrence.withHumanCorrection} of ${judgedSessions(r)} judged sessions that loaded it. Read the skill and look for instructions that are vague, outdated or likely to lead the agent the wrong way. Propose specific edits.`,
    });
  const copies = report.skills.filter(
    (o) =>
      o.id !== r.id &&
      o.skill === r.skill &&
      o.contentVersion !== null &&
      r.contentVersion !== null &&
      o.contentVersion !== r.contentVersion,
  );
  const fromSource = report.source?.contentDiffers.some((d) => same(d, r)) ?? false;
  if (copies.length || fromSource) {
    const others = copies.map(where);
    flags.push({
      kind: "drift",
      label: "Drift",
      reason: fromSource
        ? "Its folder differs from the copy in the skills source."
        : `Its folder differs from ${copies.length === 1 ? "the copy" : `${copies.length} copies`} for ${others.join(", ")}.`,
      fix: fromSource
        ? "Its folder differs from the copy in my skills source. Compare the two, tell me what changed, and propose which version to keep."
        : `Other copies of this skill differ from it: ${others.join("; ")}. Compare them, tell me what changed, and propose one version for all of them.`,
    });
  }
  const chars = listing(r);
  if (chars !== null && chars > LARGE_LISTING_CHARS)
    flags.push({
      kind: "large",
      label: "Large listing",
      reason: `Its listing is ${n(chars)} characters, sent in every session that lists it.`,
      fix: `Its listing is ${n(chars)} characters and goes into every session that lists it. Shorten the description in its frontmatter to under ${LARGE_LISTING_CHARS / 4} characters, keeping the cues for when to use it. Move detail into the body.`,
    });
  return flags;
}

export type Suggestion = { prompt: string | null; note: string | null };

const NOT_EDITABLE = "Quench can't suggest an edit";

function readOnly(r: SkillRecord): string {
  if (r.location === "built-in") return `Built-in: ${NOT_EDITABLE}.`;
  if (r.origin === "plugin") return `From a plugin: ${NOT_EDITABLE}.`;
  if (r.origin === "vendored") return `Vendored with the agent or another tool: ${NOT_EDITABLE}.`;
  return `Not found on disk: ${NOT_EDITABLE}.`;
}

function turnOff(r: SkillRecord, flags: readonly Flag[]): string | null {
  const plugin = r.skill.includes(":") ? r.skill.slice(0, r.skill.indexOf(":")) : null;
  if (r.harness !== "claude-code" || r.origin !== "plugin" || !plugin) return null;
  const reasons = flags.filter((f) => f.kind === "unused" || f.kind === "large");
  if (!reasons.length) return null;
  return [
    `The "${r.skill}" skill comes from the "${plugin}" Claude Code plugin, which I can't edit.`,
    "",
    ...reasons.map((f) => `- ${f.fix.split(". ")[0]}.`),
    "",
    `Check whether I use any other skill, command or agent from "${plugin}". If I don't, show me how to disable the plugin (for example with /plugin, or enabledPlugins in ~/.claude/settings.json), and change nothing until I agree.`,
  ].join("\n");
}

export function suggestion(r: SkillRecord, flags: readonly Flag[]): Suggestion {
  if (!flags.length) return { prompt: null, note: null };
  const file = skillFile(r);
  if ((r.origin === "user" || r.origin === "project") && file)
    return {
      prompt: [
        `Review the "${r.skill}" skill for ${HARNESS_LABELS[r.harness]}, at ${file}.`,
        "",
        ...flags.map((f) => `- ${f.fix}`),
        "",
        "Show me the change as a diff before you write anything.",
      ].join("\n"),
      note: null,
    };
  const prompt = turnOff(r, flags);
  return {
    prompt,
    note: `${readOnly(r)}${prompt ? " The prompt below turns off the plugin instead." : ""}`,
  };
}
