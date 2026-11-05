import { join } from "node:path";
import {
  discoverAll,
  readSessions,
  startedAt,
  type Home,
  type SessionEnricher,
} from "@quench/history";
import { openT3History, t3State } from "@quench/history/hosts/t3";
import { linkSubagents, runs } from "@quench/insights";
import {
  HarnessMissing,
  HarnessUnsupported,
  Jev,
  JevCauses,
  JevThemes,
  type Judge,
  type Provider,
  judgeCauses,
  type CauseInput,
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
import { dateOf, latestLine, renderCauses } from "./causes.ts";
import { contextOf, inContext, renderInContext, type SessionContext } from "./context.ts";
import { json, quote, shortPath } from "../format.ts";

const MIN_BUCKET = 15;

const NO_KEY = `Classifying replies uses Jev (typesafe.ai) with your own key. For each reply to an agent run
it sends the reply and the last 1,500 characters of the agent message before it.
Set TYPESAFE_API_KEY to opt in, or pass --dry-run to see what would be sent.
Answers are cached per judge in ~/.quench/local/judgments/, so each reply is paid for once.
Without a key, --judge claude classifies through claude -p and your own Claude account,
and --judge openai through any OpenAI-compatible endpoint. Run quench setup to pick one.
`;

const NO_JUDGE = `Reply classification is off: the judge is none, so no model is called.
Inventory, drift, costs and behaviour (quench, profile, report, runs, steering) work without one.
Pick a judge with quench setup judge, or pass --judge jev|claude|openai.
`;

type Options = {
  days: number;
  examples: number;
  json: boolean;
  dryRun: boolean;
  hostHistory?: string | false;
  themes: boolean;
  themeLimit: number;
  causes: boolean;
  context: boolean;
  cachedOnly: boolean;
  judge: Provider;
  typesafeKey: string | undefined;
};

export async function corrections(home: Home, options: Options): Promise<number> {
  const chosen = options.judge;
  if (chosen.id === null) {
    process.stderr.write(NO_JUDGE);
    return 2;
  }
  if (chosen.name === "claude" && process.platform === "win32") {
    process.stderr.write(`${new HarnessUnsupported(process.platform).message}\n`);
    return 1;
  }
  const asking = !options.dryRun && !options.cachedOnly;
  let replyJudge: Judge | null = null;
  try {
    replyJudge = asking ? await chosen.create() : null;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    process.stderr.write(
      `${error.message}${error instanceof HarnessMissing ? `. Install it or pick another --judge.` : ""}\n`,
    );
    return 1;
  }
  const optIn = options.themes || options.causes || options.context;
  if (asking && !optIn && !replyJudge) {
    process.stderr.write(NO_KEY);
    return 2;
  }
  const label = chosen.label;
  const callsPerReply = chosen.callsPerReply;
  const cache = await VerdictCache.open(
    join(home.dir, ".quench/local"),
    chosen.id,
    replyJudge === null,
  );
  const host =
    options.hostHistory === false ? null : openT3History(options.hostHistory ?? t3State(home));
  let sessions: SessionRuns[];
  const contexts = new Map<string, SessionContext>();
  const since = new Date(Date.now() - options.days * 86_400_000);
  try {
    sessions = await sessionRuns(home, since, host?.enrich, contexts);
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
  const themeJudge =
    options.themes && !options.dryRun && options.typesafeKey
      ? new JevThemes(options.typesafeKey)
      : null;
  const themes = options.themes
    ? await groupCorrections(
        judged.replies,
        await ThemeCache.open(join(home.dir, ".quench/local/themes.jsonl"), JevThemes.id),
        themeJudge,
        { limit: options.themeLimit, examples: options.examples, since },
      )
    : null;
  const causeJudge =
    options.causes && !options.dryRun && options.typesafeKey
      ? new JevCauses(options.typesafeKey)
      : null;
  let causes = null;
  try {
    causes = options.causes
      ? await judgeCauses(
          judged.replies,
          await ThemeCache.open<CauseInput>(
            join(home.dir, ".quench/local/causes.jsonl"),
            JevCauses.id,
          ),
          causeJudge,
        )
      : null;
  } catch (error) {
    if (!(error instanceof KeyRejected)) throw error;
    process.stderr.write(`${error.message}. Check TYPESAFE_API_KEY has no extra characters.\n`);
    return 1;
  }
  const context = options.context
    ? inContext(judged.replies, contexts, since, options.examples)
    : null;
  const path = (file: string) => shortPath(file, home.dir);
  const tokens = replyJudge && "tokens" in replyJudge ? (replyJudge.tokens as Tokens) : null;
  const calls = { label, perReply: callsPerReply, judge: cache.judge };
  process.stdout.write(
    options.json
      ? json({
          days: options.days,
          judge: cache.judge,
          newlyJudged: judged.newlyJudged,
          pending: judged.pending,
          calls: judged.pending * callsPerReply,
          failed: judged.failures.length,
          tokens,
          warnings,
          ...summary,
          ...(themes ? { themes: { ...themes, tokens: themeJudge?.tokens ?? null } } : {}),
          ...(causes
            ? {
                causes: {
                  ...causes,
                  tokens: causeJudge?.tokens ?? null,
                  caused: causes.caused.map((c) => ({ ...example(c.reply), cause: c.cause })),
                },
              }
            : {}),
          ...(context
            ? {
                context: {
                  ...context,
                  recurring: context.recurring.map((r) => ({
                    ...r,
                    files: r.files.map((f) => ({ ...f, name: path(f.name) })),
                  })),
                },
              }
            : {}),
          latest: summary.latest.map(example),
          latestAutomation: summary.latestAutomation.map(example),
        })
      : (themes
          ? renderThemes(themes, judged, options.days, calls)
          : render(summary, judged, options.days, cache.judge, tokens, options.cachedOnly, calls)) +
          (causes ? renderCauses(causes, options.examples) : "") +
          (context ? renderInContext(context, path) : ""),
  );
  if (optIn && (themes?.failed || causes?.failed || judged.failures.length)) return 1;
  if (
    optIn &&
    !options.dryRun &&
    ((judged.pending && !options.cachedOnly) ||
      themes?.pending ||
      themes?.blocked ||
      causes?.pending)
  ) {
    process.stderr.write(
      "Classifying missing replies, grouping and asking causes use Jev. Set TYPESAFE_API_KEY to opt in, or use --dry-run to preview each stage.\n",
    );
    return 2;
  }
  return 0;
}

async function sessionRuns(
  home: Home,
  since: Date,
  enrich?: SessionEnricher,
  contexts?: Map<string, SessionContext>,
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
      contexts?.set(`${s.harness}:${s.id}`, contextOf(s, home.dir));
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

type Calls = { label: string; perReply: number; judge: string };
type Tokens = Jev["tokens"];

function renderThemes(themes: Themes, judged: Judged, days: number, calls: Calls): string {
  const recurring = themes.themes.filter((t) => t.recurring);
  const lines = [
    `Last ${days} days · correction themes · ${themes.judge}`,
    `Reply classification by ${calls.judge}: ${judged.newlyJudged} new · ${judged.pending} pending · ${judged.failures.length} failed`,
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
      `Uncached replies: ${judged.pending} (${judged.pending * calls.perReply} classification requests); additional corrections may become eligible for grouping.`,
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
  tokens: Tokens | null,
  cachedOnly: boolean,
  calls: Calls,
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
    for (const r of latest) lines.push(`  ${latestLine(r)}`);
  }
  if (judged.pending) {
    lines.push(
      "",
      cachedOnly
        ? `${judged.pending} replies not judged yet stay unclassified (--cached-only).`
        : `Dry run: ${judged.pending} replies not judged yet would be sent to ${calls.label} in ${judged.pending * calls.perReply} requests.`,
    );
  }
  if (tokens && judged.newlyJudged) {
    lines.push(
      "",
      `${calls.label} used ${tokens.input} input and ${tokens.output} output tokens this run.`,
    );
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
  position: r.position,
  date: dateOf(r),
  kind: r.kind,
  sender: r.sender,
  senderSource: r.senderSource,
});

const percent = (n: number, of: number) => `${((100 * n) / Math.max(of, 1)).toFixed(1)}%`;
