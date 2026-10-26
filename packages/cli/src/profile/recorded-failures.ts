import { heading } from "../style.ts";
import { harnessById, type HarnessId, type SessionPlace } from "@quench/history";
import { chars, count, projectName, table } from "../format.ts";

const SHOWN = 15;

export type RepeatedFailure = {
  root: string;
  kind: string;
  what: string;
  harnesses: HarnessId[];
  failures: number;
  sessions: number;
  longestRun: number;
  chars: number;
};

export type FailureSummary = { failures: number; chars: number; repeated: RepeatedFailure[] };

const KINDS: Record<string, string> = {
  rejected: "rejected",
  "invalid-input": "bad input",
  "missing-program": "no such command",
  "missing-path": "no such file",
  "exit-code": "exit code",
  error: "error",
};

export function repeatedFailures(placesByRoot: Map<string, SessionPlace[]>): FailureSummary {
  const rows = new Map<string, RepeatedFailure>();
  let failures = 0;
  let total = 0;
  for (const [root, places] of placesByRoot)
    for (const place of places)
      for (const f of place.failures) {
        failures += f.failures;
        total += f.chars;
        if (f.what === null) continue;
        const what = f.what.startsWith(`${root}/`) ? f.what.slice(root.length + 1) : f.what;
        const key = `${root}\0${f.kind}\0${what}`;
        const row =
          rows.get(key) ??
          rows
            .set(key, {
              root,
              kind: f.kind,
              what,
              harnesses: [],
              failures: 0,
              sessions: 0,
              longestRun: 0,
              chars: 0,
            })
            .get(key)!;
        if (!row.harnesses.includes(place.harness)) row.harnesses.push(place.harness);
        row.failures += f.failures;
        row.sessions++;
        row.longestRun = Math.max(row.longestRun, f.longestRun);
        row.chars += f.chars;
      }
  const repeated = [...rows.values()]
    .filter((r) => r.failures >= 3 || r.sessions >= 2)
    .sort((a, b) => b.failures - a.failures || b.chars - a.chars);
  return { failures, chars: total, repeated };
}

export function renderFailures(summary: FailureSummary, days: number, homeDir: string): string[] {
  if (!summary.repeated.length) return [];
  const shown = summary.repeated.slice(0, SHOWN);
  const lines = [
    "",
    heading(`Repeated failures · tool calls that failed the same way · last ${days} days`),
    ...table(
      [
        ["Project", "Kind", "What", "Failures", "Sessions", "In a row", "Output", "Agents"],
        ...shown.map((r) => [
          projectName(r.root, homeDir),
          KINDS[r.kind] ?? r.kind,
          r.what.length > 60 ? `${r.what.slice(0, 59)}…` : r.what,
          count(r.failures),
          count(r.sessions),
          count(r.longestRun),
          chars(r.chars),
          r.harnesses.map((h) => harnessById[h].label).join(", "),
        ]),
      ],
      [3, 4, 5, 6],
    ),
  ];
  if (summary.repeated.length > shown.length)
    lines.push(`  … ${summary.repeated.length - shown.length} more in --json`);
  lines.push(
    `  ${count(summary.failures)} failed tool calls in all, returning ${chars(summary.chars)} of output. In a row: the longest streak of this failure with no other result between.`,
  );
  return lines;
}
