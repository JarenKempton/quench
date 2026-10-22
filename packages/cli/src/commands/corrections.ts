import { join } from "node:path";
import {
  discoverAll,
  harnessById,
  readSessions,
  startedAt,
  type Home,
  type SessionEnricher,
} from "@quench/history";
import { openT3History } from "@quench/history/hosts/t3";
import { linkSubagents, runs } from "@quench/insights";
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
  type SessionRuns,
  type Summary,
  type Tally,
  type Themes,
} from "@quench/judge";
import { json, quote, runFacts } from "../format.ts";

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
  const jev = options.dryRun || options.themes ? null : Jev.fromEnv();
  if (!options.dryRun && !options.themes && !jev) {
    process.stderr.write(NO_KEY);
    return 2;
  }
  const cache = await VerdictCache.open(
    join(home.dir, ".quench/local/judgments.jsonl"),
    Jev.id,
    options.themes,
  );
  const host =
    options.hostHistory === false
      ? null
      : openT3History(options.hostHistory ?? join(home.dir, ".t3/userdata/statev2.sqlite"));
  let sessions: SessionRuns[];
  try {
    sessions = await sessionRuns(
      home,
      new Date(Date.now() - options.days * 86_400_000),
      host?.enrich,
    );
  } finally {
    host?.close();
  }
  const warnings = host?.warnings ?? [];
  for (const warning of warnings) process.stderr.write(`${warning}\n`);
  let judged: Judged;
  try {
    judged = await judgeReplies(sessions, cache, jev);
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
        { limit: options.themeLimit, examples: options.examples },
      )
    : null;
  const tokens = jev?.tokens ?? null;
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
          latest: summary.latest.map((r) => ({
            harness: r.harness,
            folder: folder(r.cwd),
            reply: r.run.reply,
            senderSource: r.senderSource,
            run: r.run,
          })),
        })
      : themes
        ? renderThemes(themes, options.days)
        : render(summary, judged, options.days, cache.judge, tokens),
  );
  if (themes?.failed) return 1;
  if (themes?.pending && !options.dryRun && !themeJudge) {
    process.stderr.write(
      "Grouping cached person corrections uses Jev. Set TYPESAFE_API_KEY to opt in, or use --dry-run. It sends up to 500 assistant characters and 1,000 correction characters per exchange, including earlier exemplars.\n",
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
  for await (const outcome of readSessions(await discoverAll(home, since))) {
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

function renderThemes(themes: Themes, days: number): string {
  const recurring = themes.themes.filter((t) => t.recurring);
  const lines = [
    `Last ${days} days · correction themes · ${themes.judge}`,
    `${themes.selectedCorrections} of ${themes.eligibleCorrections} person corrections selected (${themes.selectedInputs} unique inputs, oldest first); ${themes.omittedCorrections} omitted by limit.`,
    `${themes.cacheHits} cached decisions · ${themes.newlyGrouped} new · ${themes.pending} pending · ${themes.blocked} blocked by an earlier missing/failed decision · ${themes.failed} failed · ${themes.unclear} unclear corrections`,
    `Excluded: ${themes.excluded.automationCorrections} automation corrections · ${themes.excluded.unknownSenderCorrections} unresolved-sender corrections · ${themes.excluded.unclassifiedReplies} unclassified replies (not sent).`,
    "",
    "Recurring across sessions (representative quotations, not draft rules)",
  ];
  if (!recurring.length) lines.push("  None established in the processed evidence.");
  for (const theme of recurring) {
    lines.push(
      `  ${theme.corrections} corrections · ${theme.sessions} sessions · preceding-run models: ${theme.models.join(", ") || "unknown"} (${theme.unknownModels} unknown)`,
      `    ${quote(theme.representative)}`,
      `    Senders: ${theme.senderSources.harness} harness · ${theme.senderSources.host} host · ${theme.senderSources.judge} model-inferred`,
    );
    for (const example of theme.examples)
      lines.push(
        `      ${example.harness}:${example.sessionId} run ${example.position} · ${example.path}  ${quote(example.reply)}`,
      );
  }
  lines.push(
    "",
    `${themes.themes.length - recurring.length} groups occur in only one session. Grouping is exploratory, not proof of a cause or an ignored rule.`,
  );
  if (themes.pending || themes.blocked)
    lines.push(
      `Up to ${themes.pending + themes.blocked} grouping requests remain; no uncached reply classifications will be sent.`,
    );
  for (const warning of themes.warnings) lines.push(`Warning: ${warning}`);
  for (const failure of themes.failures) lines.push(`Failure: ${failure}`);
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
  const status = [`${judged.newlyJudged} new`, `${judged.failures.length} failed`];
  if (judged.pending) status.push(`${judged.pending} not judged yet`);
  const lines = [
    `Last ${days} days · ${people.replies + bots.replies} replies to agent runs · judged by ${judge} (${status.join(", ")})`,
    `Sender attribution: ${summary.senderSources.harness} harness · ${summary.senderSources.host} host · ${summary.senderSources.judge} model-inferred · ${summary.senderSources.unknown} unresolved`,
    "",
    `Corrections from people         ${share(people)}`,
    `Corrections relayed by agents   ${share(bots)}  not counted below`,
    "",
    `${"What came before a person's reply".padEnd(36)}${"replies".padStart(9)}${"corrected".padStart(12)}`,
  ];
  for (const signal of summary.signals) {
    const shown = signal.buckets.filter((b) => b.replies >= MIN_BUCKET);
    if (shown.length < 2) continue;
    lines.push(signal.name);
    for (const b of shown) {
      lines.push(
        `  ${b.label.padEnd(34)}${String(b.replies).padStart(9)}${percent(b.corrections, b.replies).padStart(12)}`,
      );
    }
  }
  lines.push(
    "",
    `Buckets under ${MIN_BUCKET} replies are hidden. These are correlations, not causes.`,
  );
  lines.push("", "Latest corrections from people");
  for (const r of summary.latest) {
    const when = r.run.endedAt?.toISOString().slice(0, 10) ?? "";
    lines.push(
      `  ${when}  ${harnessById[r.harness].label} · ${folder(r.cwd) ?? "?"}  ${quote(r.run.reply)}`,
      `      after: ${runFacts(r.run)}`,
    );
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
  `${String(t.kinds.correction).padStart(5)} of ${String(t.judged).padStart(5)} replies  (${percent(t.kinds.correction, t.judged)})`;

const percent = (n: number, of: number) => `${((100 * n) / Math.max(of, 1)).toFixed(1)}%`;

const folder = (cwd: string | null) => cwd?.split("/").filter(Boolean).pop() ?? null;
