import {
  contextOf,
  startedAt,
  startingContext,
  unhandled,
  type HarnessId,
  type Session,
  type StartPart,
} from "@quench/history";
import { distribution, type Distribution } from "./distribution.ts";
import { runs } from "./run.ts";

export type Count = { name: string; count: number };

export type Day = { day: string; sessions: number; startingLoad: number | null };

export type StartShare = {
  kind: StartPart["kind"];
  server: string | null;
  chars: number;
  sessions: number;
};

export type HarnessReport = {
  harness: HarnessId;
  sessions: number;
  subagentSessions: number;
  runs: number;
  inferences: number;
  inferencesWithoutTokens: number;
  tokensProcessed: number | null;
  startingLoadTokens: number | null;
  startingLoad: Distribution;
  peakContext: Distribution;
  compactions: number;
  compactedSessions: number;
  toolCalls: number;
  toolErrors: number;
  toolResultsWithStatus: number;
  models: Count[];
  efforts: Count[];
  unparsedLines: number;
  days: Day[];
  startParts: StartShare[];
};

export const startingShare = (r: HarnessReport) =>
  r.tokensProcessed === null || r.startingLoadTokens === null
    ? null
    : r.tokensProcessed
      ? r.startingLoadTokens / r.tokensProcessed
      : 0;

export class ReportBuilder {
  private readonly tallies = new Map<HarnessId, Tally>();

  add(session: Session): void {
    let tally = this.tallies.get(session.harness);
    if (!tally) {
      tally = new Tally(session.harness);
      this.tallies.set(session.harness, tally);
    }
    tally.add(session);
  }

  finish(): HarnessReport[] {
    return [...this.tallies.values()]
      .sort((a, b) => a.harness.localeCompare(b.harness))
      .map((t) => t.finish());
  }
}

class Tally {
  private sessions = 0;
  private subagentSessions = 0;
  private runs = 0;
  private inferences = 0;
  private inferencesWithoutTokens = 0;
  private tokensProcessed = 0;
  private startingLoadTokens = 0;
  private compactions = 0;
  private compactedSessions = 0;
  private toolCalls = 0;
  private toolErrors = 0;
  private toolResultsWithStatus = 0;
  private unparsedLines = 0;
  private readonly starts: number[] = [];
  private readonly peaks: number[] = [];
  private readonly models = new Map<string, number>();
  private readonly efforts = new Map<string, number>();
  private readonly days = new Map<string, { sessions: number; starts: number[] }>();
  private readonly parts = new Map<string, StartShare>();

  constructor(readonly harness: HarnessId) {}

  add(s: Session): void {
    this.unparsedLines += s.diagnostics.unparsed;
    if (s.parent) this.subagentSessions += 1;
    else {
      this.sessions += 1;
      this.runs += runs(s).length;
    }
    let started = false;
    let first: number | null = null;
    let peak = 0;
    let peakKnown = true;
    let compacted = false;
    for (const e of s.events) {
      switch (e.type) {
        case "inference": {
          const context = contextOf(e.usage);
          if (!started) first = context;
          started = true;
          this.inferences += 1;
          bump(this.models, e.model);
          bump(this.efforts, e.effort);
          if (context === null) {
            this.inferencesWithoutTokens += 1;
            peakKnown = false;
            break;
          }
          this.tokensProcessed += context;
          if (first !== null) this.startingLoadTokens += Math.min(first, context);
          peak = Math.max(peak, context);
          break;
        }
        case "compaction":
          this.compactions += 1;
          compacted = true;
          break;
        case "tool_call":
          this.toolCalls += 1;
          break;
        case "tool_result":
          this.toolResultsWithStatus += e.isError === null ? 0 : 1;
          this.toolErrors += e.isError === true ? 1 : 0;
          break;
        case "message":
        case "instructions":
        case "skills":
        case "invocation":
        case "prompt":
        case "deferred_tools":
        case "mcp_instructions":
        case "mcp_call":
          break;
        default:
          unhandled(e);
      }
    }
    this.compactedSessions += compacted ? 1 : 0;
    if (!s.parent && first !== null) this.starts.push(first);
    if (!s.parent && started && peakKnown) this.peaks.push(peak);
    if (!s.parent) this.addStart(s, first);
  }

  private addStart(s: Session, first: number | null): void {
    const day = startedAt(s)?.toISOString().slice(0, 10);
    if (day) {
      const entry = this.days.get(day) ?? { sessions: 0, starts: [] };
      entry.sessions += 1;
      if (first !== null) entry.starts.push(first);
      this.days.set(day, entry);
    }
    for (const part of startingContext(s).parts) {
      const server = part.kind === "mcp_tools" ? part.server : null;
      const key = `${part.kind}:${server ?? ""}`;
      const entry = this.parts.get(key) ?? { kind: part.kind, server, chars: 0, sessions: 0 };
      entry.chars += part.chars;
      entry.sessions += 1;
      this.parts.set(key, entry);
    }
  }

  finish(): HarnessReport {
    return {
      harness: this.harness,
      sessions: this.sessions,
      subagentSessions: this.subagentSessions,
      runs: this.runs,
      inferences: this.inferences,
      inferencesWithoutTokens: this.inferencesWithoutTokens,
      tokensProcessed: this.inferencesWithoutTokens ? null : this.tokensProcessed,
      startingLoadTokens: this.inferencesWithoutTokens ? null : this.startingLoadTokens,
      startingLoad: distribution(this.starts),
      peakContext: distribution(this.peaks),
      compactions: this.compactions,
      compactedSessions: this.compactedSessions,
      toolCalls: this.toolCalls,
      toolErrors: this.toolErrors,
      toolResultsWithStatus: this.toolResultsWithStatus,
      models: ranked(this.models),
      efforts: ranked(this.efforts),
      unparsedLines: this.unparsedLines,
      days: [...this.days]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, d]) => ({
          day,
          sessions: d.sessions,
          startingLoad: distribution(d.starts).p50,
        })),
      startParts: [...this.parts.values()]
        .filter((p) => p.chars)
        .sort((a, b) => b.chars - a.chars || a.kind.localeCompare(b.kind)),
    };
  }
}

function bump(map: Map<string, number>, key: string | null): void {
  const name = key ?? "unknown";
  map.set(name, (map.get(name) ?? 0) + 1);
}

const ranked = (map: Map<string, number>): Count[] =>
  [...map]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
