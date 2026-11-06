import type { ReactNode } from "react";
import {
  agentLabel,
  contributors,
  percent,
  shareOf,
  startingShare,
  tokens,
  windowDays,
  type Count,
  type HarnessReport,
  type Report,
} from "./report.ts";
import { TrendChart } from "./trend-chart.tsx";

export const skillsOf = (agent: string) => `#skills?agent=${encodeURIComponent(agent)}`;

export function OverviewView({ report }: { report: Report }) {
  const window = windowDays(report.days);
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        What every session pays before any work starts, per agent.
        {report.unreadable ? ` ${report.unreadable} session files could not be read.` : ""}
      </p>
      {report.harnesses.map((h) => (
        <Agent key={h.harness} h={h} window={window} />
      ))}
      <p className="text-xs text-muted-foreground">
        Starting load is the context of a session's first model call: system prompt, tools,
        instructions and skill listings. Share is starting load summed over every model call that
        resent it, against all tokens processed. Contributors are the characters each agent recorded
        sending, averaged over its sessions; parts an agent does not record are missing.
      </p>
    </div>
  );
}

function Agent({ h, window }: { h: HarnessReport; window: string[] }) {
  const share = startingShare(h);
  return (
    <article className="rounded-lg border border-border">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-5 py-3">
        <h2 className="text-sm font-semibold">{agentLabel(h.harness)}</h2>
        <span className="font-mono text-xs text-muted-foreground">
          {h.sessions.toLocaleString("en-US")} sessions
          {h.subagentSessions ? ` · +${h.subagentSessions.toLocaleString("en-US")} subagent` : ""}
          {` · ${h.runs.toLocaleString("en-US")} runs`}
        </span>
      </header>
      <dl className="grid grid-cols-2 gap-px border-b border-border bg-border md:grid-cols-4">
        <Stat label="Starting load, median" value={tokens(h.startingLoad.p50)}>
          p10 {tokens(h.startingLoad.p10)} · p90 {tokens(h.startingLoad.p90)}
        </Stat>
        <Stat label="Share of tokens processed" value={share === null ? "–" : percent(share, 1)}>
          {tokens(h.startingLoadTokens)} of {tokens(h.tokensProcessed)}
        </Stat>
        <Stat label="Peak context, median" value={tokens(h.peakContext.p50)}>
          p90 {tokens(h.peakContext.p90)}
        </Stat>
        <Stat label="Tokens processed" value={tokens(h.tokensProcessed)}>
          {h.inferences.toLocaleString("en-US")} calls · {h.compactions} compactions
        </Stat>
      </dl>
      <div className="grid gap-8 p-5 lg:grid-cols-[3fr_2fr]">
        <section>
          <Heading>Median starting load per day</Heading>
          <TrendChart window={window} days={h.days} />
          <details className="mt-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer hover:text-foreground">Show as table</summary>
            <table className="mt-2 w-full font-mono">
              <thead>
                <tr className="text-left">
                  <th className="py-1 font-normal">Day</th>
                  <th className="py-1 text-right font-normal">Sessions</th>
                  <th className="py-1 text-right font-normal">Median start</th>
                </tr>
              </thead>
              <tbody>
                {h.days.map((d) => (
                  <tr key={d.day} className="border-t border-border text-foreground">
                    <td className="py-1">{d.day}</td>
                    <td className="py-1 text-right">{d.sessions}</td>
                    <td className="py-1 text-right">{tokens(d.startingLoad)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </section>
        <div className="space-y-6">
          <Contributors h={h} />
          <div className="grid grid-cols-2 gap-6">
            <Shares title="Models" counts={h.models} />
            <Shares title="Effort" counts={h.efforts} />
          </div>
        </div>
      </div>
    </article>
  );
}

function Stat({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return (
    <div className="bg-background px-5 py-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tracking-tight">{value}</dd>
      <dd className="mt-0.5 font-mono text-xs text-muted-foreground">{children}</dd>
    </div>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <h3 className="mb-3 text-xs font-medium text-muted-foreground">{children}</h3>;
}

function Contributors({ h }: { h: HarnessReport }) {
  const rows = contributors(h);
  if (!rows.length)
    return (
      <section>
        <Heading>Largest contributors to starting load</Heading>
        <p className="text-sm text-muted-foreground">
          {agentLabel(h.harness)} doesn't record what its first request sends.
        </p>
      </section>
    );
  const total = rows.reduce((n, r) => n + r.chars, 0);
  const widest = Math.max(...rows.map((r) => r.chars));
  return (
    <section>
      <Heading>Largest contributors to starting load</Heading>
      <ul className="space-y-2.5">
        {rows.map((r) => (
          <li
            key={r.label}
            className="text-sm"
            title={`${r.chars.toLocaleString("en-US")} characters`}
          >
            <div className="flex items-baseline justify-between gap-3">
              {r.skills ? (
                <a
                  href={skillsOf(h.harness)}
                  className="underline decoration-border underline-offset-4 hover:decoration-foreground"
                >
                  {r.label} →
                </a>
              ) : (
                <span>{r.label}</span>
              )}
              <span className="font-mono text-xs text-muted-foreground">
                {tokens(Math.round(r.perSession))} chars · {percent(r.chars, total)}
              </span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-[var(--series-1)]"
                style={{ width: `${Math.max(1, (100 * r.chars) / widest)}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Shares({ title, counts }: { title: string; counts: Count[] }) {
  return (
    <section>
      <Heading>{title}</Heading>
      <ul className="space-y-1 text-sm">
        {shareOf(counts)
          .slice(0, 4)
          .map((c) => (
            <li key={c.name} className="flex items-baseline justify-between gap-3">
              <span className="truncate font-mono text-xs" title={c.name}>
                {c.name}
              </span>
              <span className="font-mono text-xs text-muted-foreground">{percent(c.share, 1)}</span>
            </li>
          ))}
      </ul>
    </section>
  );
}
