import {
  harnessById,
  knownProgram,
  knownSubcommand,
  knownTool,
  recordedInstructions,
  sourceTrace,
  type HarnessId,
  type Session,
} from "@quench/history";
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
  outsideWindow: number;
  withoutBehaviour: number;
  singleSession: number;
  recurring: Recurring[];
};

type Correction = { reply: Reply & { sender: Sender }; date: string | null; key: string };

export function inContext(
  replies: readonly Reply[],
  contexts: ReadonlyMap<string, SessionContext>,
  since: Date,
  examples: number,
): InContext {
  const attributed = replies.filter(
    (r): r is Reply & { sender: Sender } => r.kind === "correction" && r.sender !== null,
  );
  const corrections = attributed.filter((r) => r.run.replyAt && r.run.replyAt >= since);
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
    .map(([name, group]) => summarize(name, group, contexts, examples))
    .sort((a, b) => b.sessions - a.sessions || b.corrections - a.corrections);
  return {
    corrections: corrections.length,
    outsideWindow: attributed.length - corrections.length,
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

const SHAPES = new Set(["other command", "several commands"]);

function behaviourKey(b: Behaviour): string {
  const label = behaviourLabel[b.kind];
  if (b.kind !== "retry-loop" && b.kind !== "bad-tool-input") return label;
  const tools = [...new Set(b.tools.map(knownTool))].sort();
  const command = b.kind === "retry-loop" ? knownCommand(b.what) : null;
  return `${label}: ${tools.join(", ")}${command ? ` · ${command}` : ""}`;
}

function knownCommand(what: string | null): string | null {
  if (what === null || SHAPES.has(what)) return what;
  const [program = "", sub, ...rest] = what.split(" ");
  if (rest.length || knownProgram(program) !== program) return null;
  return sub === undefined || knownSubcommand(program, sub) === sub ? what : null;
}

export function contextOf(session: Session, home: string): SessionContext {
  const files = recordedInstructions(session);
  return { skills: skillsUsed(session, home), files: files && [...new Set(files.map(fileName))] };
}

const fileName = (f: { path: string | null; directory: string | null; label: string | null }) =>
  f.path ?? `${f.directory ?? "unknown folder"} (${f.label ?? "combined instructions"})`;

function skillsUsed(session: Session, home: string): string[] | null {
  const { listings, loads } = sourceTrace(session, home).skills;
  if (!listings.length) return null;
  const listed = new Set(listings.flatMap((l) => l.listed.map((s) => s.name)));
  const used = loads.filter(
    (l) =>
      listed.has(l.name) &&
      (l.how === "invoked" ||
        (l.how === "read" && l.status === "returned") ||
        (l.how === "shell-read" && l.status === "ran")),
  );
  return [...new Set(used.map((l) => l.name))];
}

export function renderInContext(found: InContext, path: (file: string) => string): string {
  const lines = [
    "",
    "Recurring corrections and what was in context",
    `${found.corrections} corrections with an attributed sender in the period (${found.outsideWindow} outside it or undated) · ${found.withoutBehaviour} had no behaviour signal in the run before · ${found.singleSession} behaviours recurred in one session only`,
    "Grouped by the behaviour recorded in the run before each correction, across 2+ sessions.",
  ];
  if (!found.recurring.length) lines.push("  None in the processed evidence.");
  for (const r of found.recurring) {
    lines.push(
      "",
      `  ${r.behaviour}`,
      `    ${plural(r.corrections, "correction")} (people ${r.fromPeople} · agents ${r.fromAutomation}) · ${r.sessions} sessions · ${span(r)}`,
      `    Skills invoked${gap(r.unrecorded.skills, r.sessions)}:${list(r.skills, r.sessions, (name) => name)}`,
      `    Instruction and memory files loaded${gap(r.unrecorded.files, r.sessions)}:${list(r.files, r.sessions, path)}`,
      "    Latest corrections:",
    );
    for (const e of r.evidence)
      lines.push(
        `      ${e.date ?? "undated"} · ${e.sender} · ${harnessById[e.harness].label} ${e.sessionId} run ${e.position}`,
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
  return items
    .map(
      (i) =>
        `\n      ${show(i.name)}  ${i.sessions}/${sessions} sessions · ${plural(i.corrections, "correction")} · ${span(i)}`,
    )
    .join("");
}
