import { heading } from "../style.ts";
import { harnessById, isInside, type HarnessId, type SessionPlace } from "@quench/history";
import { chars, count, projectName, table } from "../format.ts";

const SHOWN = 15;

export type RepeatedFailure = {
  root: string;
  kind: string;
  what: string;
  error: string | null;
  harnesses: HarnessId[];
  failures: number;
  sessions: number;
  longestRun: number;
  chars: number;
  example: string;
};

export type BlockedRule = {
  pattern: string;
  blocks: number;
  sessions: number;
  projects: { root: string; blocks: number }[];
  harnesses: HarnessId[];
  example: string;
};

export type FailureSummary = {
  failures: number;
  chars: number;
  repeated: RepeatedFailure[];
  blocked: BlockedRule[];
};

const KINDS: Record<string, string> = {
  rejected: "rejected",
  "invalid-input": "bad input",
  "missing-program": "no such command",
  "missing-path": "no such file",
  "exit-code": "exit code",
  error: "error",
};

export function repeatedFailures(placesByRoot: Map<string, SessionPlace[]>): FailureSummary {
  const rows = new Map<string, RepeatedFailure & { most: number }>();
  let failures = 0;
  let total = 0;
  for (const [root, places] of placesByRoot)
    for (const place of places)
      for (const f of place.failures) {
        failures += f.failures;
        total += f.chars;
        if (f.what === null || f.kind === "blocked") continue;
        const what = isInside(f.what, root) ? f.what.slice(root.length + 1) : f.what;
        const key = `${root}\0${f.kind}\0${what}\0${f.error}`;
        const row =
          rows.get(key) ??
          rows
            .set(key, {
              root,
              kind: f.kind,
              what,
              error: f.error ?? null,
              harnesses: [],
              failures: 0,
              sessions: 0,
              longestRun: 0,
              chars: 0,
              example: place.session,
              most: 0,
            })
            .get(key)!;
        if (!row.harnesses.includes(place.harness)) row.harnesses.push(place.harness);
        row.failures += f.failures;
        row.sessions++;
        row.longestRun = Math.max(row.longestRun, f.longestRun);
        row.chars += f.chars;
        if (f.failures > row.most) [row.most, row.example] = [f.failures, place.session];
      }
  const repeated = [...rows.values()]
    .map(({ most: _, ...row }) => row)
    .filter((r) => r.failures >= 3 || r.sessions >= 2)
    .sort((a, b) => b.failures - a.failures || b.chars - a.chars);
  return { failures, chars: total, repeated, blocked: blockedRules([...placesByRoot]) };
}

export function blockedRules(places: [root: string, places: SessionPlace[]][]): BlockedRule[] {
  const rules = new Map<string, BlockedRule & { most: number }>();
  for (const [root, here] of places)
    for (const place of here)
      for (const f of place.failures) {
        if (f.kind !== "blocked" || f.what === null) continue;
        const rule =
          rules.get(f.what) ??
          rules
            .set(f.what, {
              pattern: f.what,
              blocks: 0,
              sessions: 0,
              projects: [],
              harnesses: [],
              example: place.session,
              most: 0,
            })
            .get(f.what)!;
        rule.blocks += f.failures;
        rule.sessions++;
        const project =
          rule.projects.find((p) => p.root === root) ??
          rule.projects[rule.projects.push({ root, blocks: 0 }) - 1]!;
        project.blocks += f.failures;
        if (!rule.harnesses.includes(place.harness)) rule.harnesses.push(place.harness);
        if (f.failures > rule.most) [rule.most, rule.example] = [f.failures, place.session];
      }
  return [...rules.values()]
    .map(({ most: _, ...rule }) => ({
      ...rule,
      projects: rule.projects.sort((a, b) => b.blocks - a.blocks),
    }))
    .sort((a, b) => b.blocks - a.blocks || a.pattern.localeCompare(b.pattern));
}

const clip = (text: string, width: number) =>
  text.length > width ? `${text.slice(0, width - 1)}…` : text;

export function renderBlocked(
  rules: readonly BlockedRule[],
  homeDir: string,
  title: string,
): string[] {
  if (!rules.length) return [];
  const shown = rules.slice(0, SHOWN);
  const lines = [
    "",
    heading(title),
    ...table(
      [
        ["Blocked", "Blocks", "Sessions", "Projects", "Agents", "Example session"],
        ...shown.map((r) => [
          clip(r.pattern, 60),
          count(r.blocks),
          count(r.sessions),
          clip(
            r.projects.map((p) => `${projectName(p.root, homeDir)} ${count(p.blocks)}`).join(", "),
            40,
          ),
          r.harnesses.map((h) => harnessById[h].label).join(", "),
          r.example,
        ]),
      ],
      [1, 2],
    ),
  ];
  if (rules.length > shown.length) lines.push(`  … ${rules.length - shown.length} more in --json`);
  return lines;
}

export function renderFailures(summary: FailureSummary, days: number, homeDir: string): string[] {
  const lines = renderBlocked(
    summary.blocked,
    homeDir,
    `Blocked by hooks and permissions · rules agents keep hitting · last ${days} days`,
  );
  if (!summary.repeated.length) return lines;
  const shown = summary.repeated.slice(0, SHOWN);
  lines.push(
    "",
    heading(`Repeated failures · tool calls that failed the same way · last ${days} days`),
    ...table(
      [
        [
          "Project",
          "Kind",
          "What",
          "First error line",
          "Failures",
          "Sessions",
          "In a row",
          "Output",
          "Agents",
          "Example session",
        ],
        ...shown.map((r) => [
          projectName(r.root, homeDir),
          KINDS[r.kind] ?? r.kind,
          clip(r.what, 50),
          clip(r.error ?? "", 50),
          count(r.failures),
          count(r.sessions),
          count(r.longestRun),
          chars(r.chars),
          r.harnesses.map((h) => harnessById[h].label).join(", "),
          r.example,
        ]),
      ],
      [4, 5, 6, 7],
    ),
  );
  if (summary.repeated.length > shown.length)
    lines.push(`  … ${summary.repeated.length - shown.length} more in --json`);
  lines.push(
    `  ${count(summary.failures)} failed tool calls in all, returning ${chars(summary.chars)} of output. In a row: the longest streak of this failure with no other result between.`,
  );
  return lines;
}
