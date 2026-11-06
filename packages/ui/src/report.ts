import { HARNESS_LABELS, type Harness } from "./skills.ts";

export type Distribution = {
  n: number;
  p10: number | null;
  p50: number | null;
  p90: number | null;
};

export type Count = { name: string; count: number };

export type Day = { day: string; sessions: number; startingLoad: number | null };

export type PartKind =
  | "system"
  | "tools"
  | "mcp_tools"
  | "deferred_tools"
  | "mcp_instructions"
  | "instructions"
  | "skills";

export type StartShare = { kind: PartKind; server: string | null; chars: number; sessions: number };

export type HarnessReport = {
  harness: Harness;
  sessions: number;
  subagentSessions: number;
  runs: number;
  inferences: number;
  inferencesWithoutTokens: number;
  tokensProcessed: number | null;
  startingLoadTokens: number | null;
  startingLoad: Distribution;
  peakContext: Distribution;
  compactions: number;
  compactedSessions: number;
  models: Count[];
  efforts: Count[];
  days: Day[];
  startParts: StartShare[];
};

export type Report = { days: number; unreadable: number; harnesses: HarnessReport[] };

export const agentLabel = (h: Harness) => HARNESS_LABELS[h] ?? h;

export const chars = (n: number) => `${tokens(n)} chars`;

export function tokens(n: number | null): string {
  if (n === null) return "–";
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1e3).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1e6).toFixed(1)}M`;
  return `${(n / 1e9).toFixed(1)}B`;
}

export const percent = (part: number, whole: number) => {
  if (!whole) return "–";
  const p = Math.round((100 * part) / whole);
  return p || !part ? `${p}%` : "<1%";
};

export const startingShare = (h: HarnessReport) =>
  h.tokensProcessed === null || h.startingLoadTokens === null || !h.tokensProcessed
    ? null
    : h.startingLoadTokens / h.tokensProcessed;

const PART_LABELS: Record<PartKind, string> = {
  system: "System prompt",
  tools: "Built-in tools",
  mcp_tools: "MCP tools",
  deferred_tools: "Deferred tools",
  mcp_instructions: "MCP instructions",
  instructions: "Instruction files",
  skills: "Skills",
};

export const partLabel = (p: StartShare) =>
  p.kind === "mcp_tools" && p.server ? `MCP ${p.server}` : PART_LABELS[p.kind];

export const SHOWN_PARTS = 6;

export type Contributor = { label: string; chars: number; perSession: number; skills: boolean };

export function contributors(h: HarnessReport): Contributor[] {
  const row = (label: string, chars: number, skills = false) => ({
    label,
    chars,
    perSession: h.sessions ? chars / h.sessions : 0,
    skills,
  });
  const shown = h.startParts
    .slice(0, SHOWN_PARTS)
    .map((p) => row(partLabel(p), p.chars, p.kind === "skills"));
  const rest = h.startParts.slice(SHOWN_PARTS);
  return rest.length
    ? [
        ...shown,
        row(
          `${rest.length} more`,
          rest.reduce((n, p) => n + p.chars, 0),
        ),
      ]
    : shown;
}

export function windowDays(days: number, today = new Date()): string[] {
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Array.from({ length: days }, (_, i) =>
    new Date(end - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
}

export function chartDays(report: Report, today = new Date()): string[] {
  const window = windowDays(report.days, today);
  const first = report.harnesses.flatMap((h) => (h.days[0] ? [h.days[0].day] : [])).sort()[0];
  if (!first || first >= window[0]!) return window;
  const span = Math.round((Date.parse(window.at(-1)!) - Date.parse(first)) / 86_400_000) + 1;
  return windowDays(span, today);
}

export const shareOf = (counts: Count[]) => {
  const total = counts.reduce((n, c) => n + c.count, 0);
  return counts.map((c) => ({ ...c, share: total ? c.count / total : 0 }));
};
