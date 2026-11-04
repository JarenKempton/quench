import { join } from "node:path";
import type { McpServer } from "@quench/history";
import { chars, count, plural, shortPath } from "../format.ts";
import { accent, badge, bold, dim, heading } from "../style.ts";
import type { McpDuplicate } from "./mcp-duplicates.ts";
import type { RecordedFile } from "./recorded-instructions.ts";
import { normalize } from "./recorded-mcp.ts";
import type { McpToolRecord } from "./recorded-mcp-tools.ts";
import { WITHHELD, type Cut } from "./skill-cuts.ts";

export type NextStep = {
  kind: "skill-cut" | "duplicate-mcp" | "instruction-file";
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
  duplicates: readonly McpDuplicate[];
  configured: readonly McpServer[];
  tools: readonly McpToolRecord[];
  instructions: readonly RecordedFile[];
};

const SHOWN = 5;

export function nextSteps(found: Findings, homeDir: string): NextStep[] {
  return [
    ...found.cuts.flatMap(cutStep),
    ...duplicateSteps(found, homeDir),
    ...instructionStep(found.instructions, homeDir),
  ]
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

function duplicateSteps(found: Findings, homeDir: string): NextStep[] {
  const steps = new Map<string, NextStep>();
  for (const duplicate of found.duplicates) {
    const loaded = duplicate.servers.flatMap((server) => {
      const record = found.tools.find(
        (t) =>
          t.harness === duplicate.harness &&
          normalize(t.server) === normalize(server.name) &&
          t.loading === "up front" &&
          t.chars !== null,
      );
      return record ? [{ ...server, chars: record.chars!, sessions: record.sessions }] : [];
    });
    if (loaded.length < 2) continue;
    const [drop, keep] = loaded.sort(
      (a, b) => a.sessions - b.sessions || b.name.localeCompare(a.name),
    );
    const source = found.configured.find(
      (s) => s.harness === duplicate.harness && s.name === drop!.name && s.scope === drop!.scope,
    )?.source;
    steps.set(`${duplicate.harness}\0${drop!.name}`, {
      kind: "duplicate-mcp",
      action: `Remove MCP server ${drop!.name}${source ? ` from ${shortPath(source, homeDir)}` : ""}`,
      command: null,
      note: `same ${duplicate.same} as ${keep!.name}, which stays`,
      charsPerSession: drop!.chars,
      sessions: drop!.sessions,
      totalChars: drop!.chars * drop!.sessions,
      size: "exact",
    });
  }
  return [...steps.values()];
}

function instructionStep(files: readonly RecordedFile[], homeDir: string): NextStep[] {
  const largest = files
    .filter((f) => !f.combined)
    .sort((a, b) => b.textChars * b.sessions - a.textChars * a.sessions)[0];
  if (!largest) return [];
  const path = largest.root === null ? largest.file : join(largest.root, largest.file);
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
