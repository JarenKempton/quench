import { join } from "node:path";
import { z } from "zod";
import { filesWithExt, modified } from "../files.ts";
import { NotASession, type Harness, type SessionRef } from "../harness.ts";
import type { Home } from "../home.ts";
import { date, jsonlLines, textOf } from "../jsonl.ts";
import type { Author, Diagnostics, Event, EventKind } from "../model.ts";

const count = z.number().nullish();

const Message = z.looseObject({
  role: z.string().nullish(),
  model: z.string().nullish(),
  thinkingLevel: z.string().nullish(),
  toolCallId: z.string().nullish(),
  isError: z.boolean().nullish(),
  content: z.unknown().optional(),
  usage: z
    .looseObject({ input: count, output: count, cacheRead: count, cacheWrite: count })
    .optional(),
});
type Message = z.infer<typeof Message>;

const Line = z.looseObject({
  type: z.string(),
  id: z.string().nullish(),
  cwd: z.string().nullish(),
  timestamp: z.string().nullish(),
  tokensBefore: count,
  message: Message.optional(),
});

const Item = z.looseObject({
  type: z.string(),
  id: z.string().nullish(),
  name: z.string().nullish(),
  text: z.unknown().optional(),
});

export const pi: Harness = {
  id: "pi",

  async discover(home: Home): Promise<SessionRef[]> {
    const sessions = join(home.pathFrom("PI_CODING_AGENT_DIR", ".pi/agent"), "sessions");
    const paths = await filesWithExt(sessions, ".jsonl", 1);
    return Promise.all(
      paths.map(async (path) => ({
        harness: "pi" as const,
        path,
        modified: await modified(path),
        parent: null,
      })),
    );
  },

  async read(r: SessionRef) {
    const diagnostics: Diagnostics = { lines: 0, unparsed: 0 };
    const events: Event[] = [];
    let header: z.infer<typeof Line> | undefined;
    for await (const line of jsonlLines(r.path, Line, diagnostics)) {
      if (line.type === "session") header ??= line;
      const at = date(line.timestamp);
      const kinds: EventKind[] =
        line.type === "message" && line.message
          ? message(line.message)
          : line.type === "compaction"
            ? [{ type: "compaction", trigger: "unknown", tokensBefore: line.tokensBefore ?? null }]
            : [];
      for (const kind of kinds) events.push({ ...kind, at });
    }
    if (!header) throw new NotASession(r.path, "Pi");
    return {
      id: header.id ?? "",
      harness: "pi" as const,
      path: r.path,
      cwd: header.cwd ?? null,
      parent: null,
      events,
      diagnostics,
    };
  },
};

function message(m: Message): EventKind[] {
  switch (m.role) {
    case "user":
      return text("user", m.content);
    case "system":
      return text("injected", m.content);
    case "toolResult":
      return [
        {
          type: "tool_result",
          callId: m.toolCallId ?? null,
          isError: m.isError ?? null,
          chars: textOf(m.content).length,
        },
      ];
    case "assistant":
      return assistant(m);
    default:
      return [];
  }
}

function text(author: Author, content: unknown): EventKind[] {
  const value = textOf(content);
  return value.trim() ? [{ type: "message", author, origin: "unknown", text: value }] : [];
}

function assistant(m: Message): EventKind[] {
  const out: EventKind[] = [];
  const usage = {
    input: m.usage?.input ?? 0,
    cacheRead: m.usage?.cacheRead ?? 0,
    cacheWrite: m.usage?.cacheWrite ?? 0,
    output: m.usage?.output ?? 0,
  };
  if (usage.input + usage.cacheRead + usage.cacheWrite + usage.output > 0) {
    out.push({ type: "inference", model: m.model ?? null, effort: m.thinkingLevel ?? null, usage });
  }
  for (const raw of Array.isArray(m.content) ? m.content : []) {
    const item = Item.safeParse(raw);
    if (!item.success) continue;
    if (item.data.type === "text") out.push(...text("assistant", item.data.text));
    if (item.data.type === "toolCall")
      out.push({ type: "tool_call", id: item.data.id ?? null, name: item.data.name ?? "" });
  }
  return out;
}
