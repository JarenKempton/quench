import { join } from "node:path";
import { z } from "zod";
import { filesWithExt, modified } from "../files.ts";
import { NotASession, type Harness, type SessionRef } from "../harness.ts";
import type { Home } from "../home.ts";
import { date, injectedTag, jsonlLines, textOf } from "../jsonl.ts";
import type { Diagnostics, Event, EventKind } from "../model.ts";

const count = z.number().nullish();

const TokenUsage = z.looseObject({
  input_tokens: count,
  cached_input_tokens: count,
  cache_write_input_tokens: count,
  output_tokens: count,
});
type TokenUsage = z.infer<typeof TokenUsage>;

const Line = z.looseObject({
  type: z.string(),
  timestamp: z.string().nullish(),
  payload: z
    .looseObject({
      type: z.string().nullish(),
      id: z.string().nullish(),
      cwd: z.string().nullish(),
      model: z.string().nullish(),
      effort: z.string().nullish(),
      role: z.string().nullish(),
      name: z.string().nullish(),
      call_id: z.string().nullish(),
      content: z.unknown().optional(),
      output: z.unknown().optional(),
      usage: TokenUsage.optional(),
      info: z.looseObject({ last_token_usage: TokenUsage.optional() }).nullish(),
    })
    .optional(),
});
type Line = z.infer<typeof Line>;

const INJECTED_HEADINGS = ["# AGENTS.md instructions"];

export const codex: Harness = {
  id: "codex",

  async discover(home: Home): Promise<SessionRef[]> {
    const sessions = join(home.pathFrom("CODEX_HOME", ".codex"), "sessions");
    const paths = await filesWithExt(sessions, ".jsonl", 3);
    return Promise.all(
      paths.map(async (path) => ({
        harness: "codex" as const,
        path,
        modified: await modified(path),
        parent: null,
      })),
    );
  },

  async read(r: SessionRef) {
    const diagnostics: Diagnostics = { lines: 0, unparsed: 0 };
    const turn: Turn = { model: null, effort: null };
    const events: Event[] = [];
    const fallbackUsage = new Set<Event>();
    let meta: NonNullable<Line["payload"]> | undefined;
    let hasRecords = false;
    for await (const line of jsonlLines(r.path, Line, diagnostics)) {
      if (line.type === "session_meta") meta ??= line.payload ?? undefined;
      hasRecords ||= line.type === "token_usage_record";
      const kind = eventOf(line, turn);
      if (!kind) continue;
      const event = { ...kind, at: date(line.timestamp) };
      if (line.type === "event_msg") fallbackUsage.add(event);
      events.push(event);
    }
    if (!meta) throw new NotASession(r.path, "Codex");
    return {
      id: meta.id ?? "",
      harness: "codex" as const,
      path: r.path,
      cwd: meta.cwd ?? null,
      parent: null,
      events: hasRecords ? events.filter((e) => !fallbackUsage.has(e)) : events,
      diagnostics,
    };
  },
};

type Turn = { model: string | null; effort: string | null };

function eventOf(line: Line, turn: Turn): EventKind | null {
  const p = line.payload;
  if (!p) return line.type === "compacted" ? compacted() : null;
  switch (line.type) {
    case "turn_context":
      turn.model = p.model ?? turn.model;
      turn.effort = p.effort ?? turn.effort;
      return null;
    case "token_usage_record":
      return p.usage ? inference(p.usage, turn) : null;
    case "event_msg":
      return p.type === "token_count" && p.info?.last_token_usage
        ? inference(p.info.last_token_usage, turn)
        : null;
    case "compacted":
      return compacted();
    case "response_item":
      return responseItem(p);
    default:
      return null;
  }
}

const compacted = (): EventKind => ({ type: "compaction", trigger: "unknown", tokensBefore: null });

function inference(u: TokenUsage, turn: Turn): EventKind {
  const cached = u.cached_input_tokens ?? 0;
  const written = u.cache_write_input_tokens ?? 0;
  return {
    type: "inference",
    model: turn.model,
    effort: turn.effort,
    usage: {
      input: Math.max(0, (u.input_tokens ?? 0) - cached - written),
      cacheRead: cached,
      cacheWrite: written,
      output: u.output_tokens ?? 0,
    },
  };
}

function responseItem(p: NonNullable<Line["payload"]>): EventKind | null {
  switch (p.type) {
    case "message": {
      const text = textOf(p.content);
      if (!text.trim()) return null;
      const author =
        p.role === "assistant"
          ? "assistant"
          : p.role === "user" && !injected(text)
            ? "user"
            : "injected";
      return { type: "message", author, origin: "unknown", text };
    }
    case "function_call":
    case "custom_tool_call":
      return { type: "tool_call", id: p.call_id ?? null, name: p.name ?? "" };
    case "function_call_output":
    case "custom_tool_call_output":
      return {
        type: "tool_result",
        callId: p.call_id ?? null,
        isError: null,
        chars: textOf(p.output).length,
      };
    default:
      return null;
  }
}

const injected = (text: string) =>
  injectedTag(text) || INJECTED_HEADINGS.some((h) => text.startsWith(h));
