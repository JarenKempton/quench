import { discoverAll, harnessById, readSessions, type Home } from "@quench/history";
import {
  ReportBuilder,
  startingShare,
  type Count,
  type Distribution,
  type HarnessReport,
} from "@quench/insights";
import { json, tokens } from "../format.ts";

export async function report(
  home: Home,
  options: { days: number; json: boolean },
): Promise<number> {
  const since = new Date(Date.now() - options.days * 86_400_000);
  const builder = new ReportBuilder();
  let unreadable = 0;
  for await (const outcome of readSessions(await discoverAll(home, since))) {
    if (outcome.ok) builder.add(outcome.session);
    else unreadable += 1;
  }
  const harnesses = builder.finish();
  process.stdout.write(
    options.json
      ? json({ days: options.days, unreadable, harnesses })
      : render(harnesses, options.days, unreadable),
  );
  return 0;
}

function render(harnesses: HarnessReport[], days: number, unreadable: number): string {
  if (harnesses.length === 0) return `No sessions found in the last ${days} days.\n`;
  const blocks = harnesses.map((h) => {
    const rows: [string, string][] = [
      ["Sessions", `${h.sessions} (+${h.subagentSessions} subagent)`],
      ["Agent runs", String(h.runs)],
      ["Model calls", String(h.inferences)],
      ["Tokens processed", tokens(h.tokensProcessed)],
      [
        "Starting load",
        `${spread(h.startingLoad)}  (${Math.round(startingShare(h) * 100)}% of tokens processed)`,
      ],
      ["Peak context", spread(h.peakContext)],
      ["Compactions", `${h.compactions} in ${h.compactedSessions} sessions`],
      ["Tool calls", toolCalls(h)],
      ["Models", top(h.models)],
      ["Effort", top(h.efforts)],
    ];
    if (h.unparsedLines) rows.push(["Unparsed lines", String(h.unparsedLines)]);
    return [
      harnessById[h.harness].label,
      ...rows.map(([label, value]) => `  ${label.padEnd(18)}${value}`),
    ].join("\n");
  });
  const footer = unreadable ? `\n${unreadable} session files could not be read.\n` : "";
  return `Last ${days} days\n\n${blocks.join("\n\n")}\n${footer}`;
}

const spread = (d: Distribution) =>
  d.n === 0 ? "none" : `median ${tokens(d.p50)}  (p10 ${tokens(d.p10)}, p90 ${tokens(d.p90)})`;

const toolCalls = (h: HarnessReport) =>
  h.toolResultsWithStatus === 0
    ? `${h.toolCalls} (errors not recorded)`
    : `${h.toolCalls} (${h.toolErrors} errors)`;

function top(counts: Count[]): string {
  const total = counts.reduce((a, c) => a + c.count, 0) || 1;
  return counts
    .slice(0, 4)
    .map((c) => `${c.name} ${Math.round((100 * c.count) / total)}%`)
    .join(", ");
}
