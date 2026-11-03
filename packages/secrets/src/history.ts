import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import {
  discoverAll,
  harnessById,
  jsonlLines,
  shellReads,
  type Event,
  type Home,
  type Progress,
  type Session,
  type SessionRef,
} from "@quench/history";
import { t3Messages } from "@quench/history/hosts/t3";
import { detectInFile, type Detection } from "./detect.ts";
import type { Masker } from "./mask.ts";
import { secretOf, type Secret } from "./secret.ts";

export type Exposure = {
  source: string;
  session: string;
  path: string;
  by: string;
  at: string | null;
};

export type HistorySecret = Secret & {
  sessions: number;
  occurrences: number;
  firstSeen: string | null;
  lastSeen: string | null;
  exposures: Exposure[];
};

type Hit = { found: Detection; ids: string[]; role: string | null; at: string | null };

const ID_KEYS = new Set(["id", "tool_use_id", "call_id", "toolCallId"]);
const SHOWN_EXPOSURES = 5;

export async function scanHistory(
  home: Home,
  mask: Masker,
  options: { hostHistory: string | false; onRead?: Progress },
) {
  const refs = await discoverAll(home);
  const secrets = new Map<string, HistorySecret & { seenIn: Set<string> }>();
  const reads = new Map<string, Set<string>>();
  const cwds = new Set<string>();
  let unreadable = 0;
  const record = (found: Detection, exposure: Exposure) => {
    const id = mask.id(found.value);
    const secret = secretOf(found, mask, "history");
    const known = secrets.get(id) ?? {
      ...secret,
      sessions: 0,
      occurrences: 0,
      firstSeen: null,
      lastSeen: null,
      exposures: [],
      seenIn: new Set<string>(),
    };
    secrets.set(id, known);
    known.occurrences++;
    const key = `${exposure.source}:${exposure.session}`;
    if (!known.seenIn.has(key)) {
      known.seenIn.add(key);
      known.exposures.push(exposure);
    }
    if (exposure.at && (!known.firstSeen || exposure.at < known.firstSeen))
      known.firstSeen = exposure.at;
    if (exposure.at && (!known.lastSeen || exposure.at > known.lastSeen))
      known.lastSeen = exposure.at;
  };
  let done = 0;
  await pool(refs, 8, async (ref) => {
    const scanned = await scanSession(ref).catch(() => null);
    options.onRead?.(++done, refs.length);
    if (!scanned) {
      unreadable++;
      return;
    }
    const { session, hits } = scanned;
    if (session.cwd) cwds.add(session.cwd);
    for (const path of readPaths(session, home.dir)) {
      const seen = reads.get(path) ?? new Set<string>();
      reads.set(path, seen.add(`${session.harness}:${session.id}`));
    }
    const calls = callsOf(session, mask);
    const fallback = ref.modified?.toISOString() ?? null;
    for (const hit of hits)
      record(hit.found, {
        source: session.harness,
        session: session.id,
        path: session.path,
        by: hit.ids.map((id) => calls.get(id)).find(Boolean) ?? `${hit.role ?? "record"} message`,
        at: hit.at ?? fallback,
      });
  });
  let hostMessages = 0;
  if (options.hostHistory)
    for (const message of t3Messages(options.hostHistory)) {
      hostMessages++;
      for (const found of detectInFile(message.text))
        record(found, {
          source: "t3",
          session: message.thread,
          path: options.hostHistory,
          by: `${message.role} message`,
          at: message.at?.toISOString() ?? null,
        });
    }
  const printed = new Set(secrets.keys());
  const sessionsOf = new Map([...secrets.values()].map((s) => [s.tag, [...s.seenIn].sort()]));
  const listed = [...secrets.values()].map(({ seenIn, ...secret }) => ({
    ...secret,
    sessions: seenIn.size,
    exposures: secret.exposures
      .sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""))
      .slice(0, SHOWN_EXPOSURES),
  }));
  return {
    sessions: refs.length - unreadable,
    unreadable,
    hostMessages,
    printed,
    sessionsOf,
    secrets: listed.sort((a, b) => b.sessions - a.sessions || a.provider.localeCompare(b.provider)),
    reads,
    cwds,
  };
}

async function scanSession(ref: SessionRef): Promise<{ session: Session; hits: Hit[] }> {
  const hits: Hit[] = [];
  for await (const line of jsonlLines(ref.path, z.unknown(), { lines: 0, unparsed: 0 })) {
    const context = contextOf(line);
    for (const { text, ids } of context.strings)
      if (text.length >= 8)
        for (const found of detectInFile(text))
          hits.push({ found, ids, role: context.role, at: context.at });
  }
  return { session: await harnessById[ref.harness].read(ref), hits };
}

function contextOf(line: unknown) {
  const strings: { text: string; ids: string[] }[] = [];
  let role: string | null = null;
  let at: string | null = null;
  const walk = (value: unknown, key: string, ids: string[]) => {
    if (typeof value === "string") {
      if (key === "role") role ??= value;
      else if (key === "timestamp") at ??= value;
      else if (!ID_KEYS.has(key)) strings.push({ text: value, ids });
    } else if (Array.isArray(value)) for (const item of value) walk(item, key, ids);
    else if (value && typeof value === "object") {
      const entries = Object.entries(value);
      const own = entries.flatMap(([name, item]) =>
        ID_KEYS.has(name) && typeof item === "string" ? [item] : [],
      );
      const scoped = own.length ? [...own, ...ids] : ids;
      for (const [name, item] of entries) walk(item, name, scoped);
    }
  };
  walk(line, "", []);
  const type = (line as { type?: unknown } | null)?.type;
  return { strings, role: role ?? (typeof type === "string" ? type : null), at: iso(at) };
}

const iso = (value: string | null) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
};

function callsOf(session: Session, mask: Masker): Map<string, string> {
  const calls = new Map<string, string>();
  for (const event of session.events) {
    if (event.type === "mcp_call" && event.id)
      calls.set(event.id, `${event.server} MCP ${event.tool}`);
    if (event.type === "tool_call" && event.id && !calls.has(event.id))
      calls.set(event.id, describeCall(event, mask));
  }
  return calls;
}

function describeCall(call: Extract<Event, { type: "tool_call" }>, mask: Masker): string {
  const command = call.shell?.find((shell) => shell.command)?.command;
  if (command) return `${call.name}: ${mask.scrubbed(command)}`;
  if (call.fileRead) return `${call.name} ${call.fileRead.path}`;
  return call.name;
}

function readPaths(session: Session, homeDir: string): string[] {
  const paths: string[] = [];
  const at = (path: string) => (isAbsolute(path) ? path : resolve(session.cwd ?? homeDir, path));
  for (const event of session.events) {
    if (event.type !== "tool_call") continue;
    if (event.fileRead) paths.push(at(event.fileRead.path));
    for (const shell of event.shell ?? [])
      if (shell.command)
        for (const read of shellReads(shell.command, {
          workdir: shell.workdir,
          sessionFolder: session.cwd,
          home: homeDir,
        }))
          if (read.path) paths.push(read.path);
  }
  return paths;
}

async function pool<T>(items: readonly T[], size: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}
