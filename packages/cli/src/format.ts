import { durationSeconds, type Run } from "@quench/insights";

export function tokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1e3).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1e6).toFixed(1)}M`;
  return `${(n / 1e9).toFixed(1)}B`;
}

export function duration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`;
}

export function quote(text: string | null, width = 90): string {
  if (text === null) return "(session ended)";
  const line = text.split(/\s+/).filter(Boolean).join(" ");
  return line.length > width ? `"${line.slice(0, width)}…"` : `"${line}"`;
}

export function runFacts(run: Run): string {
  const parts = [
    run.model ?? "unknown model",
    run.effort ?? "effort unknown",
    `context ${tokens(run.contextStart ?? 0)} → ${tokens(run.contextPeak)}`,
    plural(run.inferences, "model call"),
    plural(run.toolCalls, "tool call"),
  ];
  if (run.toolErrors) parts.push(plural(run.toolErrors, "tool error"));
  if (run.subagents) parts.push(plural(run.subagents, "subagent"));
  if (run.compactions) parts.push(plural(run.compactions, "compaction"));
  const secs = durationSeconds(run);
  if (secs !== null) parts.push(duration(secs));
  return parts.join(" · ");
}

export const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
