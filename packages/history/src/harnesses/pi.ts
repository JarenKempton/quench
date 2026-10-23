import { join } from "node:path";
import { z } from "zod";
import { filesWithExt } from "../files.ts";
import { NotASession, sessionRef, type Harness, type SessionRef } from "../harness.ts";
import type { Home } from "../home.ts";
import { ancestorDirs, type SteeringRoot } from "../steering.ts";
import { date, jsonlLines, sha256, textOf } from "../jsonl.ts";
import type { Author, Diagnostics, Event, EventKind } from "../model.ts";

const count = z.number().nullish();

export const Message = z.looseObject({
  /** `user`, `assistant`, `system` or `toolResult`. */
  role: z.string().nullish(),
  /** Model id that produced an assistant message. */
  model: z.string().nullish(),
  /** Reasoning effort for an assistant message, e.g. `off`, `medium`, `high`. */
  thinkingLevel: z.string().nullish(),
  /** On `toolResult` messages, the id of the tool call it answers. */
  toolCallId: z.string().nullish(),
  toolName: z.string().nullish(),
  /** True when the tool failed. */
  isError: z.boolean().nullish(),
  /** A string, or an array of items (see `Item`). */
  content: z.unknown().optional(),
  /** On `system` messages: prompt sections by name, replacing earlier ones; `null` removes one. `project_context` lists loaded context files. */
  sections: z.record(z.string(), z.string().nullable()).nullish(),
  /** One API call's tokens, on assistant messages. */
  usage: z
    .looseObject({
      /** Uncached input tokens. */
      input: count,
      /** Generated tokens. */
      output: count,
      /** Input tokens served from the prompt cache. */
      cacheRead: count,
      /** Input tokens written to the prompt cache. */
      cacheWrite: count,
    })
    .optional(),
});
type Message = z.infer<typeof Message>;

export const Line = z.looseObject({
  /** `session` (the header), `message`, `compaction`, `model_change`, `thinking_level_change` or `session_info`. */
  type: z.string(),
  /** Session id on the `session` header; entry id otherwise. */
  id: z.string().nullish(),
  /** Working directory, on the `session` header. */
  cwd: z.string().nullish(),
  /** ISO 8601 time the line was written. */
  timestamp: z.string().nullish(),
  /** Context size in tokens just before a `compaction`. */
  tokensBefore: count,
  /** Present on `message` lines. */
  message: Message.optional(),
  /** On `compaction`: the replayed system message that leads the compacted context. */
  systemMessage: Message.nullish(),
});

export const Item = z.looseObject({
  /** `text`, `thinking`, `toolCall` or `image`. */
  type: z.string(),
  /** Tool call id on `toolCall` items. */
  id: z.string().nullish(),
  /** Tool name on `toolCall` items, as the host named it. */
  name: z.string().nullish(),
  arguments: z.unknown().optional(),
  /** Text of a `text` item. */
  text: z.unknown().optional(),
});

const ReadInput = z.object({
  path: z.string().min(1),
  offset: z.number().int().positive().nullish(),
  limit: z.number().int().positive().nullish(),
});

const ReadContent = z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1);

export const pi: Harness<"pi"> = {
  id: "pi",
  label: "Pi",
  sourceReads: true,
  injectedInstructions: "per-file",

  async steering(home, project) {
    const user = home.pathFrom("PI_CODING_AGENT_DIR", ".pi/agent");
    const roots: SteeringRoot[] = [];
    const names = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
    for (const name of names) roots.push({ path: join(user, name), scope: "user" });
    for (const dir of await ancestorDirs(project))
      for (const name of names)
        roots.push({ path: join(dir, name), scope: dir === project ? "project" : "ancestor" });
    return roots;
  },

  async discover(home: Home): Promise<SessionRef[]> {
    const sessions = join(home.pathFrom("PI_CODING_AGENT_DIR", ".pi/agent"), "sessions");
    const paths = await filesWithExt(sessions, ".jsonl", 1);
    return Promise.all(paths.map((path) => sessionRef("pi", path)));
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
            ? [
                { type: "compaction", trigger: "unknown", tokensBefore: line.tokensBefore ?? null },
                ...instructions(line.systemMessage?.sections),
              ]
            : [];
      for (const kind of kinds) events.push({ ...kind, at });
    }
    if (!header) throw new NotASession(r.path, "Pi");
    return {
      id: header.id ?? "",
      harness: "pi",
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
      return [...text("injected", m.content), ...instructions(m.sections)];
    case "toolResult": {
      const value = textOf(m.content);
      return [
        {
          type: "tool_result",
          callId: m.toolCallId ?? null,
          isError: m.isError ?? null,
          chars: value.length,
          ...(m.toolName === "read" &&
          m.isError === false &&
          ReadContent.safeParse(m.content).success
            ? {
                fileRead: {
                  path: null,
                  startLine: null,
                  lineCount: null,
                  totalLines: null,
                  returnedTextSha256: new Bun.CryptoHasher("sha256").update(value).digest("hex"),
                  returnedTextChars: value.length,
                },
              }
            : {}),
        },
      ];
    }
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
    if (item.data.type === "toolCall") {
      const input = item.data.name === "read" ? ReadInput.safeParse(item.data.arguments) : null;
      out.push({
        type: "tool_call",
        id: item.data.id ?? null,
        name: item.data.name ?? "",
        ...(input?.success
          ? {
              fileRead: {
                path: input.data.path,
                offset: input.data.offset ?? null,
                limit: input.data.limit ?? null,
              },
            }
          : {}),
      });
    }
  }
  return out;
}

const CONTEXT_FILE = /<project_instructions path="([^"]*)">\n([\s\S]*?)\n<\/project_instructions>/g;

function instructions(sections: Message["sections"]): EventKind[] {
  const context = sections?.project_context;
  if (!context) return [];
  const files = [...context.matchAll(CONTEXT_FILE)].map(([, path, content]) => ({
    path: path!,
    directory: null,
    label: "project_context",
    textSha256: sha256(content!),
    textChars: content!.length,
    textDiffersFromFile: null,
  }));
  const declared = context.split("<project_instructions path=").length - 1;
  return [{ type: "instructions", files, unreadable: Math.max(0, declared - files.length) }];
}
