import { isInside, pathParts } from "@quench/history";
import { behaviourLabel, durationSeconds, type Behaviour, type Run } from "@quench/insights";

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

export const plural = (n: number, noun: string, nouns = `${noun}s`) =>
  `${n} ${n === 1 ? noun : nouns}`;

export const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export function table(rows: string[][], right: number[] = [], indent = "  "): string[] {
  const width = (cell: string) => Bun.stringWidth(cell);
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => width(row[i]!))));
  return rows.map((row) =>
    (
      indent +
      row
        .map((cell, i) => {
          const pad = " ".repeat(widths[i]! - width(cell));
          return right.includes(i) ? pad + cell : cell + pad;
        })
        .join("  ")
    ).trimEnd(),
  );
}

export function size(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

export function ago(iso: string | null, now = new Date()): string {
  if (!iso) return "unknown";
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

export const count = (n: number) => n.toLocaleString("en-US");

export const chars = (n: number) => `${tokens(n)} chars`;

export const shortPath = (path: string, homeDir: string) =>
  path === homeDir || isInside(path, homeDir) ? `~${path.slice(homeDir.length)}` : path;

export const projectName = (root: string, homeDir: string) =>
  root === homeDir ? "~" : (pathParts(root).at(-1) ?? root);

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

export function describe(b: Behaviour): string {
  const label = behaviourLabel[b.kind].toLowerCase();
  switch (b.kind) {
    case "retry-loop":
      return `${label} (${b.failure} ×${b.calls.length}: ${b.what}; calls ${b.calls.join(", ")})`;
    case "bad-tool-input":
      return `${label} (${b.tools.join(", ")}; calls ${b.calls.join(", ")})`;
    case "long-run":
      return `${label} (${duration(b.seconds)})`;
    case "costly-run":
      return `${label} (${tokens(b.tokens)})`;
  }
}
