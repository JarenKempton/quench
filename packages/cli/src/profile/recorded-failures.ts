import { heading } from "../style.ts";
import { harnessById, type HarnessId, type SessionPlace } from "@quench/history";
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
  guard: string;
  command: string | null;
  blocks: number;
  sessions: number;
  projects: { root: string; blocks: number }[];
  harnesses: HarnessId[];
  example: string;
};

export type BackgroundedCount = {
  backgrounded: number;
  rerun: number;
  sessions: number;
};

export type BackgroundedCommands = BackgroundedCount & {
  commands: (BackgroundedCount & { what: string; example: string })[];
  models: (BackgroundedCount & { model: string | null; harness: HarnessId })[];
};

export type FailureSummary = {
  failures: number;
  chars: number;
  repeated: RepeatedFailure[];
  blocked: BlockedRule[];
  backgrounded: BackgroundedCommands;
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
        const what = f.what;
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
  return {
    failures,
    chars: total,
    repeated,
    blocked: blockedRules([...placesByRoot]),
    backgrounded: backgroundedCommands([...placesByRoot.values()].flat()),
  };
}

export function backgroundedCommands(places: readonly SessionPlace[]): BackgroundedCommands {
  const total: BackgroundedCount = { backgrounded: 0, rerun: 0, sessions: 0 };
  const commands = new Map<string, BackgroundedCommands["commands"][number] & { most: number }>();
  const models = new Map<string, BackgroundedCommands["models"][number]>();
  for (const place of places) {
    const rows = place.backgrounded;
    if (!rows.some((r) => r.backgrounded)) continue;
    total.sessions++;
    const seen = new Set<BackgroundedCount>();
    for (const r of rows) {
      const command =
        commands.get(r.what) ??
        commands
          .set(r.what, {
            what: r.what,
            backgrounded: 0,
            rerun: 0,
            sessions: 0,
            example: place.session,
            most: 0,
          })
          .get(r.what)!;
      const modelKey = `${r.model}\0${place.harness}`;
      const model =
        models.get(modelKey) ??
        models
          .set(modelKey, {
            model: r.model,
            harness: place.harness,
            backgrounded: 0,
            rerun: 0,
            sessions: 0,
          })
          .get(modelKey)!;
      for (const row of [total, command, model]) {
        row.backgrounded += r.backgrounded;
        row.rerun += r.rerun;
      }
      seen.add(command).add(model);
      if (r.backgrounded > command.most)
        [command.most, command.example] = [r.backgrounded, place.session];
    }
    for (const row of seen) row.sessions++;
  }
  const ranked = <T extends BackgroundedCount>(rows: Iterable<T>) =>
    [...rows]
      .filter((r) => r.backgrounded || r.rerun)
      .sort((a, b) => b.backgrounded - a.backgrounded || b.rerun - a.rerun);
  return {
    ...total,
    commands: ranked(commands.values()).map(({ most: _, ...row }) => row),
    models: ranked(models.values()),
  };
}

export function renderBackgrounded(summary: BackgroundedCommands, days: number): string[] {
  if (!summary.backgrounded) return [];
  const commands = summary.commands.slice(0, SHOWN);
  const lines = [
    "",
    heading(
      `Kept running after a timeout · moved to the background, then re-run · last ${days} days`,
    ),
    ...table(
      [
        ["Command", "Backgrounded", "Re-run before done", "Sessions", "Example session"],
        ...commands.map((r) => [
          r.what,
          count(r.backgrounded),
          count(r.rerun),
          count(r.sessions),
          r.example,
        ]),
      ],
      [1, 2, 3],
    ),
    "",
    ...table(
      [
        ["Model", "Agent", "Backgrounded", "Re-run before done", "Sessions"],
        ...summary.models
          .slice(0, SHOWN)
          .map((r) => [
            r.model ?? "unknown",
            harnessById[r.harness].label,
            count(r.backgrounded),
            count(r.rerun),
            count(r.sessions),
          ]),
      ],
      [2, 3, 4],
    ),
  ];
  if (summary.commands.length > commands.length)
    lines.push(`  … ${summary.commands.length - commands.length} more in --json`);
  lines.push(
    `  ${count(summary.backgrounded)} commands hit their timeout and kept running in the background. Re-run before done: the same command started again before the first reported finishing.`,
  );
  return lines;
}

export function blockedRules(places: [root: string, places: SessionPlace[]][]): BlockedRule[] {
  const rules = new Map<string, BlockedRule & { most: number }>();
  for (const [root, here] of places)
    for (const place of here)
      for (const f of place.failures) {
        if (f.kind !== "blocked" || f.guard === null) continue;
        const key = `${f.guard}\0${f.what}`;
        const rule =
          rules.get(key) ??
          rules
            .set(key, {
              guard: f.guard,
              command: f.what,
              blocks: 0,
              sessions: 0,
              projects: [],
              harnesses: [],
              example: place.session,
              most: 0,
            })
            .get(key)!;
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
    .sort((a, b) => b.blocks - a.blocks || a.guard.localeCompare(b.guard));
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
        ["Guard", "Command", "Blocks", "Sessions", "Projects", "Agents", "Example session"],
        ...shown.map((r) => [
          r.guard,
          r.command ?? "—",
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
      [2, 3],
    ),
  ];
  if (rules.length > shown.length) lines.push(`  … ${rules.length - shown.length} more in --json`);
  return lines;
}

export function renderFailures(summary: FailureSummary, days: number, homeDir: string): string[] {
  const lines = [
    ...renderBlocked(
      summary.blocked,
      homeDir,
      `Blocked by hooks and permissions · rules agents keep hitting · last ${days} days`,
    ),
    ...renderBackgrounded(summary.backgrounded, days),
  ];
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
          "Command or tool",
          "Error",
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
          r.what,
          r.error ?? "",
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
