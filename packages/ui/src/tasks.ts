import { HARNESS_LABELS, type Harness } from "./skills.ts";

export type Verdict = "pass" | "fail" | "unknown";
export type Judgment = { verdict: Verdict; reason: string; evidence: string[] };
export type Guidance = "kept" | "skipped" | "unknown";

export type TaskRow = {
  taskId: string;
  startedAt: string;
  endedAt: string;
  split: "marker" | "heuristic";
  markers: string[];
  members: {
    harness: Harness;
    sessionId: string;
    firstTurn: number;
    lastTurn: number;
  }[];
  harnesses: Harness[];
  sessions: number;
  runs: number;
  tokens: number | null;
  seconds: number;
  landed: Judgment;
  spiral: Judgment;
  efficiency: Judgment;
  guidance: Guidance;
  guidanceTurns: number;
  guidanceCost: number;
};

export type TasksReport = { days: number; offline: number; tasks: TaskRow[] };

export const SHOW = [
  ["landed", "Landed", (t: TaskRow) => t.landed.verdict === "pass"],
  ["not-landed", "Not landed", (t: TaskRow) => t.landed.verdict === "fail"],
  ["spiral", "Spiral", (t: TaskRow) => t.spiral.verdict === "fail"],
  ["over-baseline", "Over baseline", (t: TaskRow) => t.efficiency.verdict === "fail"],
  ["kept", "Guidance kept", (t: TaskRow) => t.guidance === "kept"],
] as const;

export const REASON_LABELS: Record<string, string> = {
  merged: "merged",
  closed: "closed",
  reverted: "reverted",
  corrected: "corrected",
  open: "open",
  unmerged: "not merged",
  "not-seen": "not seen",
  "retry-loop": "retry loop",
  "repeated-correction": "repeated correction",
  "rising-cost": "rising cost",
  none: "no spiral",
  "no-tools": "no tools",
  "within-baseline": "within baseline",
  "over-baseline": "over baseline",
  "no-baseline": "no baseline",
  "no-usage": "no usage",
};

export type Evidence = { label: string; href: string | null };

const GITHUB = /^github:([\w.-]+\/[\w.-]+)#(\d+)$/;
const TURN = /^([\w-]+):(.+)#(\d+)$/;

export const shortId = (id: string) => id.slice(0, 8);

export function evidenceOf(id: string): Evidence {
  const github = GITHUB.exec(id);
  if (github)
    return {
      label: `${github[1]}#${github[2]}`,
      href: `https://github.com/${github[1]}/issues/${github[2]}`,
    };
  if (id.startsWith("jira:")) return { label: id.slice(5), href: null };
  if (id.startsWith("branch:")) return { label: id.slice(7), href: null };
  const turn = TURN.exec(id);
  if (turn && turn[1]! in HARNESS_LABELS)
    return {
      label: `${HARNESS_LABELS[turn[1] as Harness]} ${shortId(turn[2]!)} turn ${Number(turn[3]) + 1}`,
      href: null,
    };
  return { label: shortId(id), href: null };
}

export const tokens = (n: number | null) =>
  n === null
    ? "–"
    : n < 1000
      ? String(n)
      : n < 1_000_000
        ? `${(n / 1000).toFixed(1)}k`
        : `${(n / 1_000_000).toFixed(1)}M`;

export const duration = (seconds: number) =>
  seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.round(seconds / 60)}m`
      : `${(seconds / 3600).toFixed(1)}h`;
