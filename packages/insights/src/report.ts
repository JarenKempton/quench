import { contextOf, unhandled, type HarnessId, type Session } from "@quench/history";
import { distribution, type Distribution } from "./distribution.ts";
import { runs } from "./run.ts";

export type Count = { name: string; count: number };

export type HarnessReport = {
  harness: HarnessId;
  sessions: number;
  subagentSessions: number;
  runs: number;
  inferences: number;
  tokensProcessed: number;
  startingLoadTokens: number;
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
};

export const startingShare = (r: HarnessReport) =>
  r.tokensProcessed ? r.startingLoadTokens / r.tokensProcessed : 0;

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

  constructor(readonly harness: HarnessId) {}

  add(s: Session): void {
    this.unparsedLines += s.diagnostics.unparsed;
    if (s.parent) this.subagentSessions += 1;
    else {
      this.sessions += 1;
      this.runs += runs(s).length;
    }
    let first: number | null = null;
    let peak = 0;
    let compacted = false;
    for (const e of s.events) {
      switch (e.type) {
        case "inference": {
          const context = contextOf(e.usage);
          first ??= context;
          this.inferences += 1;
          this.tokensProcessed += context;
          this.startingLoadTokens += Math.min(first, context);
          peak = Math.max(peak, context);
          bump(this.models, e.model);
          bump(this.efforts, e.effort);
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
        case "mcp_call":
          break;
        default:
          unhandled(e);
      }
    }
    this.compactedSessions += compacted ? 1 : 0;
    if (!s.parent && first !== null) {
      this.starts.push(first);
      this.peaks.push(peak);
    }
  }

  finish(): HarnessReport {
    return {
      harness: this.harness,
      sessions: this.sessions,
      subagentSessions: this.subagentSessions,
      runs: this.runs,
      inferences: this.inferences,
      tokensProcessed: this.tokensProcessed,
      startingLoadTokens: this.startingLoadTokens,
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
