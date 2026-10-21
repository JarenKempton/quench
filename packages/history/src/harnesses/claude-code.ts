import { join, basename } from "node:path";
import { z } from "zod";
import { filesWithExt, modified, subdirs } from "../files.ts";
import type { Harness, SessionRef } from "../harness.ts";
import type { Home } from "../home.ts";
import { date, injectedTag, jsonlLines, textOf } from "../jsonl.ts";
import type {
  CompactionTrigger,
  Diagnostics,
  Event,
  EventKind,
  Origin,
  Session,
  Usage,
} from "../model.ts";

const count = z.number().nullish();

const Line = z.looseObject({
  type: z.string(),
  timestamp: z.string().nullish(),
  cwd: z.string().nullish(),
  isMeta: z.boolean().nullish(),
  isCompactSummary: z.boolean().nullish(),
  effort: z.string().nullish(),
  perTurnEffort: z.string().nullish(),
  promptSource: z.string().nullish(),
  turnOrigin: z.string().nullish(),
  origin: z.looseObject({ kind: z.string().nullish() }).optional(),
  subtype: z.string().nullish(),
  compactMetadata: z.looseObject({ trigger: z.string().nullish(), preTokens: count }).optional(),
  message: z
    .looseObject({
      id: z.string().nullish(),
      model: z.string().nullish(),
      content: z.unknown().optional(),
      usage: z
        .looseObject({
          input_tokens: count,
          cache_read_input_tokens: count,
          cache_creation_input_tokens: count,
          output_tokens: count,
        })
        .optional(),
    })
    .optional(),
});
type Line = z.infer<typeof Line>;

const Block = z.looseObject({
  type: z.string(),
  id: z.string().nullish(),
  name: z.string().nullish(),
  text: z.unknown().optional(),
  tool_use_id: z.string().nullish(),
  is_error: z.boolean().nullish(),
  content: z.unknown().optional(),
});
type Block = z.infer<typeof Block>;

const HARNESS_NOTES = ["Caveat:", "[Request interrupted by user"];

export const claudeCode: Harness = {
  id: "claude-code",

  async discover(home: Home): Promise<SessionRef[]> {
    const projects = join(home.pathFrom("CLAUDE_CONFIG_DIR", ".claude"), "projects");
    const refs: SessionRef[] = [];
    for (const dir of await subdirs(projects)) {
      for (const path of await filesWithExt(dir, ".jsonl", 0)) {
        refs.push(await ref(path, null));
        const id = stem(path);
        for (const child of await filesWithExt(join(dir, id, "subagents"), ".jsonl", 0)) {
          refs.push(await ref(child, id));
        }
      }
    }
    return refs;
  },

  async read(r: SessionRef): Promise<Session> {
    const diagnostics: Diagnostics = { lines: 0, unparsed: 0 };
    const events: Event[] = [];
    const inferenceAt = new Map<string, number>();
    let cwd: string | null = null;
    for await (const line of jsonlLines(r.path, Line, diagnostics)) {
      cwd ??= line.cwd ?? null;
      const at = date(line.timestamp);
      for (const kind of eventsOf(line)) {
        const id = line.message?.id;
        const seen = kind.type === "inference" && id ? inferenceAt.get(id) : undefined;
        if (seen !== undefined) {
          events[seen] = { ...kind, at: events[seen]?.at ?? at };
          continue;
        }
        if (kind.type === "inference" && id) inferenceAt.set(id, events.length);
        events.push({ ...kind, at });
      }
    }
    return {
      id: stem(r.path),
      harness: "claude-code",
      path: r.path,
      cwd,
      parent: r.parent,
      events,
      diagnostics,
    };
  },
};

async function ref(path: string, parent: string | null): Promise<SessionRef> {
  return { harness: "claude-code", path, modified: await modified(path), parent };
}

const stem = (path: string) => basename(path, ".jsonl");

function eventsOf(line: Line): EventKind[] {
  switch (line.type) {
    case "system":
      return line.subtype === "compact_boundary" ? [compaction(line)] : [];
    case "assistant":
      return assistant(line);
    case "user":
      return user(line);
    default:
      return [];
  }
}

function compaction(line: Line): EventKind {
  const trigger = line.compactMetadata?.trigger;
  return {
    type: "compaction",
    trigger:
      trigger === "auto" || trigger === "manual" ? (trigger as CompactionTrigger) : "unknown",
    tokensBefore: line.compactMetadata?.preTokens ?? null,
  };
}

function assistant(line: Line): EventKind[] {
  const out: EventKind[] = [];
  const u = line.message?.usage;
  if (u) {
    const usage: Usage = {
      input: u.input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
    };
    if (usage.input + usage.cacheRead + usage.cacheWrite + usage.output > 0) {
      out.push({
        type: "inference",
        model: line.message?.model ?? null,
        effort: line.perTurnEffort ?? line.effort ?? null,
        usage,
      });
    }
  }
  for (const block of blocks(line.message?.content)) {
    if (block.type === "text") {
      out.push({
        type: "message",
        author: "assistant",
        origin: "unknown",
        text: textOf(block.text),
      });
    } else if (block.type === "tool_use") {
      out.push({ type: "tool_call", id: block.id ?? null, name: block.name ?? "" });
    }
  }
  return out;
}

function user(line: Line): EventKind[] {
  const content = line.message?.content;
  const results = blocks(content).filter((b) => b.type === "tool_result");
  if (results.length > 0) {
    return results.map((b) => ({
      type: "tool_result",
      callId: b.tool_use_id ?? null,
      isError: b.is_error ?? null,
      chars: textOf(b.content).length,
    }));
  }
  const text = textOf(content);
  if (!text.trim()) return [];
  const flagged = line.isMeta === true || line.isCompactSummary === true;
  const command = slashCommand(text);
  if (command && !flagged)
    return [{ type: "message", author: "user", origin: origin(line), text: command }];
  const injected = flagged || injectedTag(text) || HARNESS_NOTES.some((n) => text.startsWith(n));
  return [
    {
      type: "message",
      author: injected ? "injected" : "user",
      origin: origin(line),
      text,
    },
  ];
}

function blocks(content: unknown): Block[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => {
    const parsed = Block.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function origin(line: Line): Origin {
  if (line.origin?.kind === "human" || line.promptSource === "typed") return "typed";
  if (line.promptSource === "system" || line.turnOrigin === "scheduled") return "scheduled";
  if (line.promptSource === "sdk") return "host";
  return "unknown";
}

function slashCommand(text: string): string | null {
  const name = between(text, "<command-name>", "</command-name>");
  if (name === null) return null;
  const args = between(text, "<command-args>", "</command-args>") ?? "";
  return `${name} ${args}`.trim();
}

function between(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open);
  if (start < 0) return null;
  const end = text.indexOf(close, start + open.length);
  return end < 0 ? null : text.slice(start + open.length, end).trim();
}
