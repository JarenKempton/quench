import { join } from "node:path";
import {
  discoverAll,
  harnessById,
  pathParts,
  readSessions,
  startedAt,
  type Home,
  type SessionEnricher,
} from "@quench/history";
import { openT3History } from "@quench/history/hosts/t3";
import { behaviour, behaviourLabel, linkSubagents, runs, type Behaviour } from "@quench/insights";
import {
  Jev,
  JevThemes,
  groupCorrections,
  ThemeCache,
  judgeReplies,
  KeyRejected,
  summarize,
  VerdictCache,
  type Judged,
  type Reply,
  type SessionRuns,
  type Summary,
  type Tally,
  type Themes,
} from "@quench/judge";
import { reading } from "../progress.ts";
import { duration, json, quote, runFacts, tokens as tokenCount } from "../format.ts";

const MIN_BUCKET = 15;

const NO_KEY = `Classifying replies uses Jev (typesafe.ai) with your own key. For each reply to an agent run
it sends the reply and the last 1,500 characters of the agent message before it.
Set TYPESAFE_API_KEY to opt in, or pass --dry-run to see what would be sent.
Answers are cached in ~/.quench/local/judgments.jsonl, so each reply is paid for once.
`;

type Options = {
  days: number;
  examples: number;
  json: boolean;
  dryRun: boolean;
  hostHistory?: string | false;
  themes: boolean;
  themeLimit: number;
};

export async function corrections(home: Home, options: Options): Promise<number> {
  const replyJudge = options.dryRun ? null : Jev.fromEnv();
  if (!options.dryRun && !options.themes && !replyJudge) {
    process.stderr.write(NO_KEY);
    return 2;
  }
  const cache = await VerdictCache.open(
    join(home.dir, ".quench/local/judgments.jsonl"),
    Jev.id,
    replyJudge === null,
  );
  const host =
    options.hostHistory === false
      ? null
      : openT3History(options.hostHistory ?? join(home.dir, ".t3/userdata/statev2.sqlite"));
  let sessions: SessionRuns[];
  const since = new Date(Date.now() - options.days * 86_400_000);
  try {
    sessions = await sessionRuns(home, since, host?.enrich);
  } finally {
    host?.close();
  }
  const warnings = host?.warnings ?? [];
  for (const warning of warnings) process.stderr.write(`${warning}\n`);
  let judged: Judged;
  try {
    judged = await judgeReplies(sessions, cache, replyJudge);
  } catch (error) {
    if (!(error instanceof KeyRejected)) throw error;
    process.stderr.write(`${error.message}. Check TYPESAFE_API_KEY has no extra characters.\n`);
    return 1;
  }
  const summary = summarize(judged.replies, options.examples);
  const themeJudge = options.themes && !options.dryRun ? JevThemes.fromEnv() : null;
  const themes = options.themes
    ? await groupCorrections(
        judged.replies,
        await ThemeCache.open(join(home.dir, ".quench/local/themes.jsonl"), JevThemes.id),
        themeJudge,
        { limit: options.themeLimit, examples: options.examples, since },
      )
    : null;
  const tokens = replyJudge?.tokens ?? null;
  process.stdout.write(
    options.json
      ? json({
          days: options.days,
          judge: cache.judge,
          newlyJudged: judged.newlyJudged,
          pending: judged.pending,
          failed: judged.failures.length,
          tokens,
          warnings,
          ...summary,
          ...(themes ? { themes: { ...themes, tokens: themeJudge?.tokens ?? null } } : {}),
          latest: summary.latest.map(example),
          latestAutomation: summary.latestAutomation.map(example),
        })
      : themes
        ? renderThemes(themes, judged, options.days)
        : render(summary, judged, options.days, cache.judge, tokens),
  );
  if (themes && (themes.failed || judged.failures.length)) return 1;
  if (themes && !options.dryRun && !replyJudge && (judged.pending || themes.pending)) {
    process.stderr.write(
      "Classifying missing replies and grouping corrections use Jev. Set TYPESAFE_API_KEY to opt in, or use --dry-run to preview both stages.\n",
    );
    return 2;
  }
  return 0;
}

async function sessionRuns(
  home: Home,
  since: Date,
  enrich?: SessionEnricher,
): Promise<SessionRuns[]> {
  const parents = new Map<string, SessionRuns>();
  const childStarts = new Map<string, (Date | null)[]>();
  for await (const outcome of readSessions(await discoverAll(home, since), 4, reading())) {
    if (!outcome.ok) continue;
    const s = outcome.session;
    if (s.parent) {
      const key = `${s.harness}:${s.parent}`;
      childStarts.set(key, [...(childStarts.get(key) ?? []), startedAt(s)]);
    } else {
      parents.set(`${s.harness}:${s.id}`, {
        id: s.id,
        path: s.path,
        harness: s.harness,
        cwd: s.cwd,
        runs: runs(enrich?.(s) ?? s),
      });
    }
  }
  for (const [key, session] of parents) linkSubagents(session.runs, childStarts.get(key) ?? []);
  return [...parents.values()];
}

function renderThemes(themes: Themes, judged: Judged, days: number): string {
  const recurring = themes.themes.filter((t) => t.recurring);
  const lines = [
    `Last ${days} days · correction themes · ${themes.judge}`,
    `Reply classification: ${judged.newlyJudged} new · ${judged.pending} pending · ${judged.failures.length} failed`,
    `${themes.selectedCorrections} of ${themes.eligibleCorrections} corrections from people and agents / automation selected (${themes.selectedInputs} unique inputs, oldest first); ${themes.omittedCorrections} omitted by limit.`,
    `${themes.cacheHits} cached decisions · ${themes.newlyGrouped} new · ${themes.pending} pending · ${themes.blocked} blocked by an earlier missing/failed decision · ${themes.failed} failed · ${themes.unclear} unclear corrections`,
    `Excluded: ${themes.excluded.outsideWindowCorrections} corrections outside the period · ${themes.excluded.unknownTimeCorrections} without reply timestamps · ${themes.excluded.unknownSenderCorrections} unresolved-sender corrections · ${themes.excluded.unclassifiedReplies} unclassified replies (not grouped).`,
    "",
    "Recurring across sessions (representative quotations, not draft rules)",
  ];
  if (!recurring.length) lines.push("  None established in the processed evidence.");
  for (const theme of recurring) {
    lines.push(
      `  ${theme.corrections} corrections · ${theme.sessions} sessions · preceding-run models: ${theme.models.join(", ") || "unknown"} (${theme.unknownModels} unknown)`,
      `    People: ${theme.fromPeople.corrections} corrections across ${theme.fromPeople.sessions} sessions · agents / automation: ${theme.fromAutomation.corrections} across ${theme.fromAutomation.sessions} sessions`,
      `    ${theme.representativeSender}: ${quote(theme.representative)}`,
      `    Attribution: ${theme.senderSources.harness} harness · ${theme.senderSources.host} host · ${theme.senderSources.judge} model-inferred`,
    );
    for (const example of theme.examples)
      lines.push(
        `      ${example.sender} (${example.senderSource}) · ${example.harness}:${example.sessionId} run ${example.position} · ${example.path}  ${quote(example.reply)}`,
      );
  }
  lines.push(
    "",
    `${themes.themes.length - recurring.length} groups occur in only one session. Grouping is exploratory, not proof of a cause or an ignored rule.`,
    "Session counts are native IDs, not independent occurrences: copied fork history can inflate evidence.",
    "Agent corrections are supervision evidence, not confirmed human preferences or rule proposals.",
  );
  if (judged.pending)
    lines.push(
      `Uncached replies: ${judged.pending} (${judged.pending * 2} classification requests); additional corrections may become eligible for grouping.`,
    );
  if (themes.pending || themes.blocked)
    lines.push(
      `Up to ${themes.pending + themes.blocked} grouping requests remain for currently classified corrections.`,
    );
  for (const warning of themes.warnings) lines.push(`Warning: ${warning}`);
  for (const failure of judged.failures) lines.push(`Classification failure: ${failure.message}`);
  for (const failure of themes.failures) lines.push(`Grouping failure: ${failure}`);
  return `${lines.join("\n")}\n`;
}

function render(
  summary: Summary,
  judged: Judged,
  days: number,
  judge: string,
  tokens: Jev["tokens"] | null,
): string {
  const people = summary.fromPeople;
  const bots = summary.fromAutomation;
  const unknown = summary.fromUnknown;
  const status = [`${judged.newlyJudged} new`, `${judged.failures.length} failed`];
  if (judged.pending) status.push(`${judged.pending} not judged yet`);
  const lines = [
    `Last ${days} days · ${people.replies + bots.replies + unknown.replies} replies to agent runs · judged by ${judge} (${status.join(", ")})`,
    `Sender attribution: ${summary.senderSources.harness} harness · ${summary.senderSources.host} host · ${summary.senderSources.judge} model-inferred · ${summary.senderSources.unknown} unresolved`,
    "",
    `Corrections from people         ${share(people)}`,
    `Corrections from agents / automation ${share(bots)}`,
    `Unresolved senders              ${unknown.replies} replies · ${unknown.judged} classified · ${unknown.kinds.correction} corrections; excluded from attributed rates and signals`,
  ];
  for (const [label, signals] of [
    ["people", summary.signals],
    ["agents / automation", summary.automationSignals],
  ] as const) {
    lines.push(
      "",
      `What came before replies from ${label}`,
      `${"".padEnd(36)}${"replies".padStart(9)}${"corrected".padStart(12)}`,
    );
    for (const signal of signals) {
      const shown = signal.buckets.filter((b) => b.replies >= MIN_BUCKET);
      if (shown.length < 2) continue;
      lines.push(signal.name);
      for (const b of shown) {
        lines.push(
          `  ${b.label.padEnd(34)}${String(b.replies).padStart(9)}${percent(b.corrections, b.replies).padStart(12)}`,
        );
      }
    }
  }
  lines.push(
    "",
    `Buckets under ${MIN_BUCKET} replies are hidden. These are correlations, not causes.`,
    "Behaviour rows come from the run's own log: repeated failures, invalid tool input, time and tokens.",
  );
  for (const [label, latest] of [
    ["people", summary.latest],
    ["agents / automation", summary.latestAutomation],
  ] as const) {
    lines.push("", `Latest corrections from ${label}`);
    for (const r of latest) {
      const when = r.run.replyAt?.toISOString().slice(0, 10) ?? "";
      lines.push(
        `  ${when}  ${harnessById[r.harness].label} · ${folder(r.cwd) ?? "?"}  ${quote(r.run.reply)}`,
        `      ${r.senderSource} attribution · ${r.path} run ${r.position}`,
        `      after: ${runFacts(r.run)}`,
      );
      const found = behaviour(r.run);
      if (found.length) lines.push(`      behaviour: ${found.map(describe).join(" · ")}`);
    }
  }
  if (judged.pending) {
    lines.push(
      "",
      `Dry run: ${judged.pending} replies not judged yet would be sent to Jev in ${judged.pending * 2} requests.`,
    );
  }
  if (tokens && judged.newlyJudged) {
    lines.push("", `Jev used ${tokens.input} input and ${tokens.output} output tokens this run.`);
  }
  const failure = judged.failures[0];
  if (failure) lines.push("", `First failure: ${failure.message}`);
  return `${lines.join("\n")}\n`;
}

const share = (t: Tally) =>
  `${String(t.kinds.correction).padStart(5)} of ${String(t.judged).padStart(5)} classified replies  (${t.judged ? percent(t.kinds.correction, t.judged) : "unknown"})`;

const example = (r: Reply) => ({
  harness: r.harness,
  sessionId: r.sessionId,
  path: r.path,
  position: r.position,
  folder: folder(r.cwd),
  reply: r.run.reply,
  sender: r.sender,
  senderSource: r.senderSource,
  run: r.run,
  behaviour: behaviour(r.run),
});

function describe(b: Behaviour): string {
  const label = behaviourLabel[b.kind].toLowerCase();
  switch (b.kind) {
    case "retry-loop":
      return `${label} (${b.failure} ×${b.calls.length}: ${b.what ?? b.tools.join(", ")}; calls ${b.calls.join(", ")})`;
    case "bad-tool-input":
      return `${label} (${b.tools.join(", ")}; calls ${b.calls.join(", ")})`;
    case "long-run":
      return `${label} (${duration(b.seconds)})`;
    case "costly-run":
      return `${label} (${tokenCount(b.tokens)})`;
  }
}

const percent = (n: number, of: number) => `${((100 * n) / Math.max(of, 1)).toFixed(1)}%`;

const folder = (cwd: string | null) => (cwd ? (pathParts(cwd).at(-1) ?? null) : null);
