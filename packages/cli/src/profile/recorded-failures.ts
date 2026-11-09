import { heading } from "../style.ts";
import { harnessById, type HarnessId, type SessionPlace } from "@quench/history";
import { chars, count, projectName, table } from "../format.ts";

const SHOWN = 15;
const CHAINED = 3;

type Counts = Record<string, number>;

const add = (into: Counts, from: Counts | undefined) => {
  for (const [what, n] of Object.entries(from ?? {})) into[what] = (into[what] ?? 0) + n;
};

const top = (counts: Counts) =>
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, CHAINED)
    .map(([what]) => what);

export const commandLabel = (what: string, chained: readonly string[] = []) =>
  what === "several commands" && chained.length ? `chained: ${chained.join(", ")}` : what;

export type RepeatedFailure = {
  root: string;
  kind: string;
  what: string;
  chained: string[];
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
  chained: string[];
  hooks: string[];
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
  commands: (BackgroundedCount & {
    what: string;
    chained: string[];
    example: string;
  })[];
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

export function repeatedFailures(
  placesByRoot: Map<string, SessionPlace[]>,
  hookScripts: ReadonlySet<string> = new Set(),
): FailureSummary {
  const rows = new Map<
    string,
    Omit<RepeatedFailure, "chained"> & { most: number; counts: Counts }
  >();
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
              counts: {},
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
        add(row.counts, f.chained);
        row.sessions++;
        row.longestRun = Math.max(row.longestRun, f.longestRun);
        row.chars += f.chars;
        if (f.failures > row.most) [row.most, row.example] = [f.failures, place.session];
      }
  const repeated = [...rows.values()]
    .map(({ most: _, counts, ...row }) => ({ ...row, chained: top(counts) }))
    .filter((r) => r.failures >= 3 || r.sessions >= 2)
    .sort((a, b) => b.failures - a.failures || b.chars - a.chars);
  return {
    failures,
    chars: total,
    repeated,
    blocked: blockedRules([...placesByRoot], hookScripts),
    backgrounded: backgroundedCommands([...placesByRoot.values()].flat()),
  };
}

export function backgroundedCommands(places: readonly SessionPlace[]): BackgroundedCommands {
  const total: BackgroundedCount = { backgrounded: 0, rerun: 0, sessions: 0 };
  const commands = new Map<
    string,
    Omit<BackgroundedCommands["commands"][number], "chained"> & {
      most: number;
      counts: Counts;
    }
  >();
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
            counts: {},
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
      add(command.counts, r.chained);
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
    commands: ranked(commands.values()).map(({ most: _, counts, ...row }) => ({
      ...row,
      chained: top(counts),
    })),
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
          commandLabel(r.what, r.chained),
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

export function blockedRules(
  places: [root: string, places: SessionPlace[]][],
  hookScripts: ReadonlySet<string> = new Set(),
): BlockedRule[] {
  const rules = new Map<
    string,
    Omit<BlockedRule, "chained" | "hooks"> & {
      most: number;
      counts: Counts;
      hookCounts: Counts;
    }
  >();
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
              counts: {},
              hookCounts: {},
              blocks: 0,
              sessions: 0,
              projects: [],
              harnesses: [],
              example: place.session,
              most: 0,
            })
            .get(key)!;
        rule.blocks += f.failures;
        add(rule.counts, f.chained);
        add(
          rule.hookCounts,
          Object.fromEntries(Object.entries(f.hooks ?? {}).filter(([h]) => hookScripts.has(h))),
        );
        rule.sessions++;
        const project =
          rule.projects.find((p) => p.root === root) ??
          rule.projects[rule.projects.push({ root, blocks: 0 }) - 1]!;
        project.blocks += f.failures;
        if (!rule.harnesses.includes(place.harness)) rule.harnesses.push(place.harness);
        if (f.failures > rule.most) [rule.most, rule.example] = [f.failures, place.session];
      }
  return [...rules.values()]
    .map(({ most: _, counts, hookCounts, ...rule }) => ({
      ...rule,
      chained: top(counts),
      hooks: top(hookCounts),
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
          r.hooks.length ? `${r.guard} (${r.hooks.join(", ")})` : r.guard,
          r.command ? commandLabel(r.command, r.chained) : "—",
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
          commandLabel(r.what, r.chained),
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
