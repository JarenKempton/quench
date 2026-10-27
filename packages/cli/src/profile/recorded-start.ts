import {
  harnessById,
  harnesses,
  type HarnessId,
  type SessionPlace,
  type StartPart,
} from "@quench/history";
import { bold, dim, heading } from "../style.ts";
import { table } from "../format.ts";

export type StartSplit = {
  harness: HarnessId;
  sessions: number;
  parts: { part: string; chars: number }[];
  unrecorded: { part: string; sessions: number }[];
};

const SHOWN = 8;

const LABELS: Record<StartPart["kind"], string> = {
  system: "system",
  tools: "built-in tools",
  mcp_tools: "MCP tools",
  deferred_tools: "deferred tools",
  mcp_instructions: "MCP instructions",
  instructions: "instructions",
  skills: "skills",
};

const labelOf = (part: StartPart) =>
  part.kind === "mcp_tools" ? `MCP ${part.server}` : LABELS[part.kind];

export function startSplit(places: readonly SessionPlace[]): StartSplit[] {
  return harnesses.flatMap((harness) => {
    const starts = places.flatMap((p) => (p.harness === harness.id ? [p.start] : []));
    if (!starts.length) return [];
    const parts = new Map<string, number>();
    const unrecorded = new Map<string, number>();
    for (const start of starts) {
      for (const part of start.parts)
        parts.set(labelOf(part), (parts.get(labelOf(part)) ?? 0) + part.chars);
      for (const kind of start.unrecorded)
        unrecorded.set(LABELS[kind], (unrecorded.get(LABELS[kind]) ?? 0) + 1);
    }
    return [
      {
        harness: harness.id,
        sessions: starts.length,
        parts: [...parts]
          .filter(([, chars]) => chars)
          .map(([part, chars]) => ({ part, chars }))
          .sort((a, b) => b.chars - a.chars || a.part.localeCompare(b.part)),
        unrecorded: [...unrecorded].map(([part, sessions]) => ({ part, sessions })),
      },
    ];
  });
}

export function renderStartSplit(splits: readonly StartSplit[]): string[] {
  if (!splits.some((s) => s.parts.length)) return [];
  return [
    "",
    heading("First request goes to"),
    ...table(
      splits.flatMap((s) => [
        [
          bold(harnessById[s.harness].label),
          s.parts.length ? shares(s.parts) : dim("not recorded"),
        ],
        ...(s.parts.length && s.unrecorded.length ? [["", missing(s)]] : []),
      ]),
    ),
    `  ${dim("Shares of the characters each harness recorded sending, summed over sessions.")}`,
  ];
}

const missing = (s: StartSplit) =>
  dim(
    `not recorded: ${s.unrecorded.map((u) => `${u.part} in ${u.sessions}/${s.sessions}`).join(", ")}`,
  );

function shares(parts: StartSplit["parts"]): string {
  const total = parts.reduce((n, p) => n + p.chars, 0);
  const shown = parts.slice(0, SHOWN);
  const rest = parts.slice(SHOWN).reduce((n, p) => n + p.chars, 0);
  return [
    ...shown.map((p) => `${p.part} ${share(p.chars, total)}`),
    ...(rest ? [`${parts.length - SHOWN} more ${share(rest, total)}`] : []),
  ].join(dim(" · "));
}

const share = (chars: number, total: number) => {
  const percent = Math.round((100 * chars) / total);
  return percent ? `${percent}%` : "<1%";
};
