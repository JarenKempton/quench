import { harnessById, type HarnessId } from "@quench/history";
import { behaviour, behaviourLabel, type Behaviour } from "@quench/insights";
import type { Reply, Sender } from "@quench/judge";
import { plural } from "../format.ts";

export type SessionContext = { skills: string[] | null; files: string[] | null };

export type Loaded = {
  name: string;
  sessions: number;
  corrections: number;
  first: string | null;
  last: string | null;
};

export type Evidence = {
  harness: HarnessId;
  sessionId: string;
  position: number;
  date: string | null;
  sender: Sender;
  excerpt: string | null;
};

export type Recurring = {
  behaviour: string;
  corrections: number;
  fromPeople: number;
  fromAutomation: number;
  sessions: number;
  first: string | null;
  last: string | null;
  unrecorded: { skills: number; files: number };
  skills: Loaded[];
  files: Loaded[];
  evidence: Evidence[];
};

export type InContext = {
  corrections: number;
  withoutBehaviour: number;
  singleSession: number;
  recurring: Recurring[];
};

type Correction = { reply: Reply & { sender: Sender }; date: string | null; key: string };

export function inContext(
  replies: readonly Reply[],
  contexts: ReadonlyMap<string, SessionContext>,
  excerpt: (text: string) => string | null,
  examples: number,
): InContext {
  const corrections = replies.filter(
    (r): r is Reply & { sender: Sender } => r.kind === "correction" && r.sender !== null,
  );
  const groups = new Map<string, Correction[]>();
  let withoutBehaviour = 0;
  for (const reply of corrections) {
    const found = behaviour(reply.run);
    if (!found.length) withoutBehaviour++;
    const date = reply.run.replyAt?.toISOString().slice(0, 10) ?? null;
    for (const name of new Set(found.map(behaviourKey)))
      groups.set(name, [...(groups.get(name) ?? []), { reply, date, key: sessionKey(reply) }]);
  }
  const recurring = [...groups]
    .map(([name, group]) => summarize(name, group, contexts, excerpt, examples))
    .sort((a, b) => b.sessions - a.sessions || b.corrections - a.corrections);
  return {
    corrections: corrections.length,
    withoutBehaviour,
    singleSession: recurring.filter((r) => r.sessions < 2).length,
    recurring: recurring.filter((r) => r.sessions >= 2),
  };
}

export const sessionKey = (s: { harness: HarnessId; sessionId: string }) =>
  `${s.harness}:${s.sessionId}`;

function summarize(
  name: string,
  group: Correction[],
  contexts: ReadonlyMap<string, SessionContext>,
  excerpt: (text: string) => string | null,
  examples: number,
): Recurring {
  const sessions = [...new Set(group.map((c) => c.key))];
  const recorded = (pick: (c: SessionContext) => string[] | null) =>
    sessions.filter((key) => !pick(contexts.get(key) ?? { skills: null, files: null })).length;
  const dates = group.flatMap((c) => (c.date ? [c.date] : [])).sort();
  return {
    behaviour: name,
    corrections: group.length,
    fromPeople: group.filter((c) => c.reply.sender === "person").length,
    fromAutomation: group.filter((c) => c.reply.sender === "automation").length,
    sessions: sessions.length,
    first: dates[0] ?? null,
    last: dates.at(-1) ?? null,
    unrecorded: { skills: recorded((c) => c.skills), files: recorded((c) => c.files) },
    skills: loaded(group, contexts, (c) => c.skills),
    files: loaded(group, contexts, (c) => c.files),
    evidence: [...group]
      .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
      .slice(0, examples)
      .map(({ reply, date }) => ({
        harness: reply.harness,
        sessionId: reply.sessionId,
        position: reply.position,
        date,
        sender: reply.sender,
        excerpt: reply.run.reply === null ? null : excerpt(reply.run.reply),
      })),
  };
}

function loaded(
  group: Correction[],
  contexts: ReadonlyMap<string, SessionContext>,
  pick: (c: SessionContext) => string[] | null,
): Loaded[] {
  const byName = new Map<string, { sessions: Set<string>; corrections: number; dates: string[] }>();
  for (const { key, date } of group)
    for (const name of pick(contexts.get(key) ?? { skills: null, files: null }) ?? []) {
      const entry = byName.get(name) ?? { sessions: new Set(), corrections: 0, dates: [] };
      entry.sessions.add(key);
      entry.corrections++;
      if (date) entry.dates.push(date);
      byName.set(name, entry);
    }
  return [...byName]
    .map(([name, e]) => {
      const dates = e.dates.sort();
      return {
        name,
        sessions: e.sessions.size,
        corrections: e.corrections,
        first: dates[0] ?? null,
        last: dates.at(-1) ?? null,
      };
    })
    .sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
}

function behaviourKey(b: Behaviour): string {
  const label = behaviourLabel[b.kind];
  switch (b.kind) {
    case "retry-loop":
      return `${label}: ${b.failure} on ${b.what ?? b.tools.join(", ")}`;
    case "bad-tool-input":
      return `${label}: ${b.tools.join(", ")}`;
    default:
      return label;
  }
}

export function renderInContext(
  found: InContext,
  scrub: (text: string) => string,
  path: (file: string) => string,
): string {
  const lines = [
    "",
    "Recurring corrections and what was in context",
    `${found.corrections} corrections with an attributed sender · ${found.withoutBehaviour} had no behaviour signal in the run before · ${found.singleSession} behaviours recurred in one session only`,
    "Grouped by the behaviour recorded in the run before each correction, across 2+ sessions.",
  ];
  if (!found.recurring.length) lines.push("  None in the processed evidence.");
  for (const r of found.recurring) {
    lines.push(
      "",
      `  ${scrub(r.behaviour)}`,
      `    ${plural(r.corrections, "correction")} (people ${r.fromPeople} · agents ${r.fromAutomation}) · ${r.sessions} sessions · ${span(r)}`,
      `    Skills invoked${gap(r.unrecorded.skills, r.sessions)}:${list(r.skills, r.sessions, (name) => name)}`,
      `    Instruction and memory files loaded${gap(r.unrecorded.files, r.sessions)}:${list(r.files, r.sessions, path)}`,
      "    Latest corrections:",
    );
    for (const e of r.evidence)
      lines.push(
        `      ${e.date ?? "undated"} · ${e.sender} · ${harnessById[e.harness].label} ${e.sessionId} run ${e.position}${e.excerpt === null ? "" : `  "${e.excerpt}"`}`,
      );
  }
  lines.push(
    "",
    "Being in context is a correlation, not a cause. Read-only: no skill or instruction file is changed.",
  );
  return `${lines.join("\n")}\n`;
}

const span = (d: { first: string | null; last: string | null }) =>
  d.first === null ? "undated" : d.first === d.last ? d.first : `${d.first} → ${d.last}`;

const gap = (missing: number, of: number) =>
  missing ? ` (${missing} of ${of} sessions have no record)` : "";

function list(items: Loaded[], sessions: number, show: (name: string) => string): string {
  if (!items.length) return " none recorded";
  const shared = items.filter((i) => i.sessions >= 2);
  const once = items.length - shared.length;
  return (
    shared
      .map(
        (i) =>
          `\n      ${show(i.name)}  ${i.sessions}/${sessions} sessions · ${plural(i.corrections, "correction")} · ${span(i)}`,
      )
      .join("") + (once ? `\n      ${once} more in one session each` : "")
  );
}
