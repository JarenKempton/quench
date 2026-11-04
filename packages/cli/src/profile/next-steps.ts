import type { DiskComparison } from "@quench/history";
import { chars, count, plural, shortPath } from "../format.ts";
import { accent, badge, bold, dim, heading } from "../style.ts";
import type { RecordedFile } from "./recorded-instructions.ts";
import { WITHHELD, type Cut } from "./skill-cuts.ts";

export type NextStep = {
  kind: "skill-cut" | "instruction-file";
  action: string;
  command: string | null;
  note: string | null;
  charsPerSession: number;
  sessions: number;
  totalChars: number;
  size: "exact" | "lower bound" | "upper bound";
};

type Findings = {
  cuts: readonly Cut[];
  instructions: readonly RecordedFile[];
};

const SHOWN = 5;

export function nextSteps(found: Findings, homeDir: string): NextStep[] {
  return [...found.cuts.flatMap(cutStep), ...instructionStep(found.instructions, homeDir)]
    .filter((s) => s.totalChars > 0)
    .sort((a, b) => b.totalChars - a.totalChars || a.action.localeCompare(b.action))
    .slice(0, SHOWN);
}

function cutStep(cut: Cut): NextStep[] {
  if (cut.size === "unknown" || cut.note?.startsWith(WITHHELD)) return [];
  const skills = cut.skills.length > 1 ? `, ${plural(cut.skills.length, "skill")} never used` : "";
  return [
    {
      kind: "skill-cut",
      action: `Cut ${cut.what} (${cut.source}${skills})`,
      command: cut.command,
      note: cut.note,
      charsPerSession: Math.round(cut.listedChars / cut.sessions),
      sessions: cut.sessions,
      totalChars: cut.listedChars,
      size: cut.size === "exact" ? "exact" : "lower bound",
    },
  ];
}

function instructionStep(files: readonly RecordedFile[], homeDir: string): NextStep[] {
  const largest = files
    .filter((f) => !f.combined && onDisk(f.checkouts[0]!.disk))
    .sort((a, b) => b.textChars * b.sessions - a.textChars * a.sessions)[0];
  if (!largest) return [];
  const path = largest.checkouts[0]!.path;
  return [
    {
      kind: "instruction-file",
      action: `Trim ${shortPath(path, homeDir)}`,
      command: null,
      note: "loaded in full every session; trimming it saves up to its whole size",
      charsPerSession: largest.textChars,
      sessions: largest.sessions,
      totalChars: largest.textChars * largest.sessions,
      size: "upper bound",
    },
  ];
}

const onDisk = (disk: DiskComparison) => disk === "same" || disk === "differs";

export function renderNextSteps(steps: readonly NextStep[]): string[] {
  const lines = ["", heading("Do this next · ranked by characters saved × sessions")];
  if (!steps.length) return [...lines, `  ${dim("Nothing measured is worth cutting right now.")}`];
  return [
    ...lines,
    ...steps.flatMap((step, i) => [
      ...(i ? [""] : []),
      `  ${badge(i + 1)} ${bold(step.action)}`,
      `     ${dim(`${saved(step)} per session × ${count(step.sessions)} ${step.sessions === 1 ? "session" : "sessions"}`)}`,
      ...(step.command ? [`     ${accent(`$ ${step.command}`)}`] : []),
      ...(step.note ? [`     ${dim(step.note)}`] : []),
    ]),
  ];
}

const BOUND = { exact: "", "lower bound": "≥ ", "upper bound": "up to " } as const;

const saved = (step: NextStep) => `${BOUND[step.size]}${chars(step.charsPerSession)}`;
