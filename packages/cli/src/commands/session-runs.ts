import { readSessions, startedAt, type SessionEnricher, type SessionRef } from "@quench/history";
import { linkSubagents, runs } from "@quench/insights";
import type { SessionRuns } from "@quench/judge";
import { reading } from "../progress.ts";
import { contextOf, type SessionContext } from "./context.ts";

export async function sessionRuns(
  refs: readonly SessionRef[],
  homeDir: string,
  enrich?: SessionEnricher,
  contexts?: Map<string, SessionContext>,
): Promise<SessionRuns[]> {
  const parents = new Map<string, SessionRuns>();
  const childStarts = new Map<string, (Date | null)[]>();
  for await (const outcome of readSessions(refs, 4, reading())) {
    if (!outcome.ok) continue;
    const s = outcome.session;
    if (s.parent) {
      const key = `${s.harness}:${s.parent}`;
      childStarts.set(key, [...(childStarts.get(key) ?? []), startedAt(s)]);
    } else {
      contexts?.set(`${s.harness}:${s.id}`, contextOf(s, homeDir));
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
