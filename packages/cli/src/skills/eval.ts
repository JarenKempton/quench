import { installations, type LedgerEntry, type TreeHash } from "@quench/fleet";
import { startedAt, type Session } from "@quench/history";
import { promptLoads, triggeredBy } from "./prompt-loads.ts";
import type { Replay } from "./replay.ts";

export const DEFAULT_PROMPTS = 5;
export const MAX_PROMPTS = 20;
export const DEFAULT_MAX_COST = 1;
export const MAX_COST = 10;
export const BASE_TOKENS = 6_000;
const TURNS = 3;
const OUTPUT_TOKENS = 1_000;
const TIE_BAND = 0.1;

const PRICES: Record<string, { input: number; output: number }> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

export const SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = ["linux", "darwin"];
export const evalSupported = (platform: NodeJS.Platform) => SUPPORTED_PLATFORMS.includes(platform);

export type EvalPrompt = {
  session: string;
  at: Date;
  text: string;
  model: string | null;
  original: { triggered: true; tokens: number | null; output: string | null };
};

export type Selection = {
  sessionsRead: number;
  notCurrentVersion: number;
  notTriggered: number;
  prompts: EvalPrompt[];
};

const replayModel = (model: string | null) =>
  model && /^claude-[a-z0-9-]+$/.test(model) ? model : null;

export function selectPrompts(
  sessions: readonly Session[],
  skill: string,
  current: TreeHash,
  ledger: LedgerEntry[],
  limit: number,
): Selection {
  const live = installations(ledger).filter(
    (i) =>
      i.harness === "claude-code" &&
      i.skill === skill &&
      i.location.scope === "global" &&
      i.treeHash === current,
  );
  const liveAt = (at: Date) =>
    live.some((i) => new Date(i.from) <= at && (i.to === null || at < new Date(i.to)));
  let notCurrentVersion = 0;
  let notTriggered = 0;
  const found: EvalPrompt[] = [];
  const own = sessions.filter((s) => s.harness === "claude-code" && s.parent === null);
  for (const session of own) {
    const at = startedAt(session);
    if (!at || !liveAt(at)) {
      notCurrentVersion++;
      continue;
    }
    const first = promptLoads(session)[0];
    if (!first || !triggeredBy(first, skill)) {
      notTriggered++;
      continue;
    }
    found.push({
      session: session.id,
      at,
      text: first.text,
      model: replayModel(first.model),
      original: { triggered: true, tokens: first.tokens, output: first.reply },
    });
  }
  found.sort((a, b) => b.at.getTime() - a.at.getTime());
  return {
    sessionsRead: own.length,
    notCurrentVersion,
    notTriggered,
    prompts: found.slice(0, limit),
  };
}

export type Estimate = { tokens: number; usd: number | null; unpriced: string[] };

export const SPEND_STOP = "spend cap reached";

const priceOf = (model: string | null) => (model ? PRICES[model] : undefined);

const runTokens = (p: EvalPrompt, bytes: number) =>
  TURNS * (BASE_TOKENS + Math.ceil(p.text.length / 4) + Math.ceil(bytes / 4));

export function runCost(p: EvalPrompt, bytes: number): number | null {
  const price = priceOf(p.model);
  return price ? (runTokens(p, bytes) * price.input + OUTPUT_TOKENS * price.output) / 1e6 : null;
}

export function estimate(
  prompts: readonly EvalPrompt[],
  currentBytes: number,
  candidateBytes: number,
): Estimate {
  let tokens = 0;
  let usd: number | null = 0;
  const unpriced = new Set<string>();
  for (const p of prompts)
    for (const bytes of [currentBytes, candidateBytes]) {
      tokens += runTokens(p, bytes) + OUTPUT_TOKENS;
      const cost = runCost(p, bytes);
      if (cost === null) unpriced.add(p.model ?? "the account default model");
      else if (usd !== null) usd += cost;
    }
  return { tokens, usd: unpriced.size ? null : usd, unpriced: [...unpriced] };
}

export type Outcome = "win" | "loss" | "tie" | "excluded" | "errored" | "failed" | "not run";

export function outcomeOf(current: Replay | null, candidate: Replay | null): Outcome {
  if (!current || !candidate) return "not run";
  if (!current.ok) return "failed";
  if (current.errored) return "errored";
  if (!current.triggered) return "excluded";
  if (!candidate.ok) return "failed";
  if (candidate.errored) return "errored";
  if (!candidate.triggered) return "loss";
  if (candidate.tokens < current.tokens * (1 - TIE_BAND)) return "win";
  if (candidate.tokens > current.tokens * (1 + TIE_BAND)) return "loss";
  return "tie";
}

export type Row = { prompt: EvalPrompt; current: Replay | null; candidate: Replay | null };

export function summarise(rows: readonly Row[], stopped: string | null) {
  const tally = { win: 0, loss: 0, tie: 0, excluded: 0, errored: 0, failed: 0, "not run": 0 };
  for (const row of rows) tally[outcomeOf(row.current, row.candidate)]++;
  const reproducible = tally.win + tally.loss + tally.tie + tally.excluded;
  const spentUsd = rows
    .flatMap((r) => [r.current, r.candidate])
    .reduce((sum, r) => sum + (r?.ok && r.costUsd !== null ? r.costUsd : 0), 0);
  return {
    wins: tally.win,
    losses: tally.loss,
    ties: tally.tie,
    excluded: tally.excluded,
    errored: tally.errored,
    failed: tally.failed,
    notRun: tally["not run"],
    exclusionRate: reproducible ? tally.excluded / reproducible : null,
    spentUsd,
    stopped,
  };
}

const side = (r: Replay | null) =>
  r === null
    ? null
    : r.ok
      ? { triggered: r.triggered, errored: r.errored, tokens: r.tokens, costUsd: r.costUsd }
      : { failed: r.reason };

export const rowJson = (row: Row) => ({
  session: row.prompt.session,
  at: row.prompt.at.toISOString(),
  model: row.prompt.model,
  original: { triggered: true, tokens: row.prompt.original.tokens, costUsd: null },
  current: side(row.current),
  candidate: side(row.candidate),
  outcome: outcomeOf(row.current, row.candidate),
});
