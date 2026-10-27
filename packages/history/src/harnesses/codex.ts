import { join } from "node:path";
import { z } from "zod";
import { filesWithExt } from "../files.ts";
import { NotASession, sessionRef, type Harness, type SessionRef } from "../harness.ts";
import type { Home } from "../home.ts";
import { repositoryRoot } from "../files.ts";
import { describeServer, record, type McpEntry } from "../mcp.ts";
import type { SkillRoot } from "../skills.ts";
import { ancestorDirs, type SteeringRoot } from "../steering.ts";
import { failureOf } from "../failures.ts";
import { date, injectedTag, jsonlLines, mcpCalls, sha256, textOf } from "../jsonl.ts";
import type { Diagnostics, Event, EventKind, ShellCommand } from "../model.ts";
import { mcpServerOf } from "../model.ts";

const count = z.number().nullish();

const TokenUsage = z.looseObject({
  /** All input tokens, including the cached ones counted below. */
  input_tokens: count,
  /** Input tokens served from the prompt cache. */
  cached_input_tokens: count,
  /** Input tokens written to the prompt cache. */
  cache_write_input_tokens: count,
  /** Generated tokens, including reasoning. */
  output_tokens: count,
});
type TokenUsage = z.infer<typeof TokenUsage>;

const Line = z.looseObject({
  /** `session_meta`, `turn_context`, `response_item`, `event_msg`, `token_usage_record` or `compacted`. */
  type: z.string(),
  /** ISO 8601 time the line was written. */
  timestamp: z.string().nullish(),
  /** Fields depend on `type`; only the ones Quench reads are listed. */
  payload: z
    .looseObject({
      /** Item kind on `response_item` (`message`, `function_call`, `reasoning`…) and `event_msg` (`token_count`, `task_started`…). */
      type: z.string().nullish(),
      /** Session id, on `session_meta`. */
      id: z.string().nullish(),
      /** Working directory, on `session_meta` and `turn_context`. */
      cwd: z.string().nullish(),
      /** Model for the turns that follow, on `turn_context`. */
      model: z.string().nullish(),
      /** Reasoning effort for the turns that follow, on `turn_context`. */
      effort: z.string().nullish(),
      /** Message author: `user`, `assistant` or `developer`. AGENTS.md and environment context arrive as `user` too. */
      role: z.string().nullish(),
      /** Tool name on tool calls. */
      name: z.string().nullish(),
      /** Tool input on `custom_tool_call`: code or a command, as text. */
      input: z.unknown().optional(),
      /** Tool arguments on `function_call`, as JSON text. */
      arguments: z.unknown().optional(),
      /** Links a tool call to its output. */
      call_id: z.string().nullish(),
      /** Message content: an array of `input_text` / `output_text` parts. */
      content: z.unknown().optional(),
      /** Tool output on `function_call_output` and `custom_tool_call_output`. */
      output: z.unknown().optional(),
      /** On `compacted`: the items that replace the history, including re-injected instructions; inherited from the parent in forked sessions. */
      replacement_history: z.array(z.unknown()).nullish(),
      /** On `session_meta`: the system instructions the session started with. */
      base_instructions: z.looseObject({ text: z.string().nullish() }).nullish(),
      /** On `additional_tools`: tool definitions sent to the model, grouped in namespaces. */
      tools: z
        .array(
          z.looseObject({
            name: z.string(),
            tools: z.array(z.looseObject({ name: z.string() })).nullish(),
          }),
        )
        .nullish(),
      /** One API call's tokens, on `token_usage_record`. */
      usage: TokenUsage.optional(),
      /** On `token_count` events; older sessions only have this, not `token_usage_record`. */
      info: z
        .looseObject({
          /** Tokens of the latest API call. */
          last_token_usage: TokenUsage.optional(),
        })
        .nullish(),
    })
    .optional(),
});
type Line = z.infer<typeof Line>;

const INJECTED_HEADINGS = ["# AGENTS.md instructions"];

const HOME = { variable: "CODEX_HOME", fallback: ".codex" };

export const codex: Harness<"codex"> = {
  id: "codex",
  label: "Codex",
  home: HOME,
  sourceReads: false,
  injectedInstructions: "combined",
  skillUse: true,

  async skills(home, project) {
    const codex = home.of(HOME);
    const dirs = await ancestorDirs(project, true);
    const scope = (dir: string) => (dir === project ? "project" : "ancestor");
    const trusted = await trustedProject(home, project);
    return [
      ...(trusted
        ? dirs.map(
            (dir): SkillRoot => ({
              path: join(dir, ".codex/skills"),
              scope: scope(dir),
              layout: "folders",
            }),
          )
        : []),
      { path: join(codex, "skills"), scope: "user", layout: "folders" },
      { path: join(home.dir, ".agents/skills"), scope: "user", layout: "folders" },
      { path: join(codex, "skills/.system"), scope: "system", layout: "folders" },
      ...dirs.map(
        (dir): SkillRoot => ({
          path: join(dir, ".agents/skills"),
          scope: scope(dir),
          layout: "folders",
        }),
      ),
    ];
  },

  async mcp(home, project) {
    const servers = new Map<string, McpEntry>();
    const add = (path: string, config: Record<string, unknown>, scope: McpEntry["scope"]) => {
      for (const [name, entry] of Object.entries(record(config.mcp_servers)))
        servers.set(name, {
          name,
          scope,
          source: path,
          enabled: record(entry).enabled !== false,
          ...describeServer(entry),
        });
    };
    const user = join(home.of(HOME), "config.toml");
    add(user, await readToml(user), "user");
    if (await trustedProject(home, project))
      for (const dir of await ancestorDirs(project, true)) {
        const path = join(dir, ".codex/config.toml");
        if (path !== user) add(path, await readToml(path), "project");
      }
    return [...servers.values()];
  },

  async steering(home, project) {
    const user = home.of(HOME);
    const roots: SteeringRoot[] = [
      { path: join(user, "AGENTS.override.md"), scope: "user" },
      { path: join(user, "AGENTS.md"), scope: "user" },
    ];
    for (const dir of await ancestorDirs(project, true))
      for (const name of ["AGENTS.override.md", "AGENTS.md"])
        roots.push({ path: join(dir, name), scope: dir === project ? "project" : "ancestor" });
    return roots;
  },

  async discover(home: Home): Promise<SessionRef[]> {
    const sessions = join(home.of(HOME), "sessions");
    const paths = await filesWithExt(sessions, ".jsonl", 3);
    return Promise.all(paths.map((path) => sessionRef("codex", path)));
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
      const at = date(line.timestamp);
      const kind = eventOf(line, turn);
      if (kind) {
        const event = { ...kind, at };
        if (line.type === "event_msg") fallbackUsage.add(event);
        events.push(event);
      }
      const prompt = promptOf(line);
      if (prompt) events.push({ ...prompt, at });
      const loaded = instructions(line);
      if (loaded) events.push({ ...loaded, at });
      const listing = skillListing(line);
      if (listing) events.push({ ...listing, at });
      for (const call of mcpCallsOf(line)) events.push({ ...call, at });
    }
    if (!meta) throw new NotASession(r.path, "Codex");
    return {
      id: meta.id ?? "",
      harness: "codex",
      path: r.path,
      cwd: meta.cwd ?? null,
      parent: null,
      events: hasRecords ? events.filter((e) => !fallbackUsage.has(e)) : events,
      diagnostics,
    };
  },
};

type Turn = { model: string | null; effort: string | null };

function promptOf(line: Line): EventKind | null {
  const p = line.payload;
  if (line.type === "session_meta" && p?.base_instructions?.text)
    return { type: "prompt", system: p.base_instructions.text.length, tools: null };
  if (line.type === "response_item" && p?.type === "additional_tools" && p.tools)
    return {
      type: "prompt",
      system: null,
      tools: p.tools.flatMap((namespace) =>
        (namespace.tools ?? [namespace]).map((tool) => ({
          name: tool.name,
          server: mcpServerOf(namespace.name) ?? mcpServerOf(tool.name),
          chars: JSON.stringify(tool).length,
          deferred: false,
        })),
      ),
    };
  return null;
}

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
      return {
        type: "tool_call",
        id: p.call_id ?? null,
        name: p.name ?? "",
        ...shellOf(p.name ?? "", p.input ?? p.arguments),
      };
    case "function_call_output":
    case "custom_tool_call_output": {
      const text = textOf(p.output);
      const failure = failureOf(
        text.replace(/^Script completed\nWall time [^\n]*\nOutput:\n/, ""),
        null,
      );
      return {
        type: "tool_result",
        callId: p.call_id ?? null,
        isError: failure ? true : null,
        chars: text.length,
        ...(failure ? { failure } : {}),
      };
    }
    default:
      return null;
  }
}

function mcpCallsOf(line: Line): EventKind[] {
  const p = line.payload;
  if (line.type !== "response_item") return [];
  if (p?.type !== "function_call" && p?.type !== "custom_tool_call") return [];
  const input = p.input ?? p.arguments;
  return [
    ...mcpCalls(p.name ?? "", { prefix: "^", suffix: "$", id: p.call_id ?? null }),
    ...(typeof input === "string"
      ? mcpCalls(input, { prefix: "tools\\.", suffix: "\\(", id: p.call_id ?? null }).map(
          (call) => ({ ...call, inScript: true }),
        )
      : []),
  ];
}

const ShellArgs = z.looseObject({
  /** Command on `exec_command`, as one string. */
  cmd: z.string().nullish(),
  /** Command on `shell` (an argv array) or `shell_command` (a string). */
  command: z.union([z.string(), z.array(z.string())]).nullish(),
  /** Folder the command ran in. */
  workdir: z.string().nullish(),
});

function shellOf(name: string, input: unknown): { shell?: ShellCommand[] } {
  if (typeof input !== "string") return {};
  if (name === "exec") {
    const shell = [...input.matchAll(/\bexec_command\(\s*\{/g)].map((m) =>
      literalFields(input, m.index + m[0].length),
    );
    return shell.length
      ? { shell: shell.map((f) => ({ command: f.cmd ?? null, workdir: f.workdir ?? null })) }
      : {};
  }
  if (!["exec_command", "shell", "shell_command"].includes(name)) return {};
  const args = ShellArgs.safeParse(parseJson(input));
  if (!args.success) return { shell: [{ command: null, workdir: null }] };
  const argv = args.data.command;
  const command = Array.isArray(argv)
    ? argv.length === 3 && /(^|\/)(ba|z)?sh$/.test(argv[0]!) && /^-l?c$/.test(argv[1]!)
      ? argv[2]!
      : argv.join(" ")
    : (args.data.cmd ?? argv ?? null);
  return { shell: [{ command, workdir: args.data.workdir ?? null }] };
}

const FIELD =
  /\s*([A-Za-z_]+|"[A-Za-z_]+")\s*:\s*("(?:[^"\\]|\\.)*"|`(?:[^`\\$]|\\.)*`|[^,}]*)\s*([,}])/y;

function literalFields(code: string, from: number): Record<string, string | null> {
  const fields: Record<string, string | null> = {};
  FIELD.lastIndex = from;
  for (let m = FIELD.exec(code); m; m = FIELD.exec(code)) {
    const value = m[2]!.trim();
    fields[m[1]!.replaceAll('"', "")] = value.startsWith('"')
      ? (parseJson(value) as string)
      : value.startsWith("`")
        ? value.slice(1, -1).replace(/\\(.)/g, "$1")
        : null;
    if (m[3] === "}") break;
  }
  return fields;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const INSTRUCTIONS =
  /^# AGENTS\.md instructions(?: for (.+))?\n\n<INSTRUCTIONS>\n([\s\S]*)\n<\/INSTRUCTIONS>\s*$/;

const HistoryItem = z.looseObject({
  /** `message`, `compaction`, `function_call`… */
  type: z.string().nullish(),
  /** `user`, `assistant` or `developer`. */
  role: z.string().nullish(),
  /** Message content: an array of `input_text` / `output_text` parts. */
  content: z.unknown().optional(),
});

const SKILLS = /<skills_instructions>([\s\S]*?)<\/skills_instructions>/;

function skillListing(line: Line): EventKind | null {
  const p = line.payload;
  if (line.type !== "response_item" || p?.type !== "message" || p.role !== "developer") return null;
  const block = SKILLS.exec(textOf(p.content))?.[1];
  if (!block) return null;
  const roots = new Map(
    [...block.matchAll(/^- `(r\d+)` = `([^`]+)`$/gm)].map(([, id, path]) => [id!, path!]),
  );
  const listed = [...block.matchAll(/^- (\S+): .*\(file: ([^)]+)\)$/gm)].map(([, name, file]) => {
    const [root, ...rest] = file!.split("/");
    const base = roots.get(root!);
    return { name: name!, path: base ? [base, ...rest].join("/") : file! };
  });
  return { type: "skills", listed, chars: block.length };
}

function instructions(line: Line): EventKind | null {
  const p = line.payload;
  const messages =
    line.type === "response_item" && p?.role === "user"
      ? [p.content]
      : line.type === "compacted" && Array.isArray(p?.replacement_history)
        ? p.replacement_history.flatMap((raw) => {
            const item = HistoryItem.safeParse(raw);
            return item.success && item.data.type === "message" && item.data.role === "user"
              ? [item.data.content]
              : [];
          })
        : [];
  const parts = messages
    .flatMap((content) => (Array.isArray(content) ? content : [content]))
    .map((part) => textOf([part]))
    .filter((text) => text.startsWith(INJECTED_HEADINGS[0]!));
  if (!parts.length) return null;
  const files = parts.flatMap((text) => {
    const match = INSTRUCTIONS.exec(text);
    return match
      ? [
          {
            path: null,
            directory: match[1] ?? null,
            label: "AGENTS.md instructions",
            textSha256: sha256(match[2]!),
            textChars: match[2]!.length,
            textDiffersFromFile: null,
          },
        ]
      : [];
  });
  return { type: "instructions", files, unreadable: parts.length - files.length };
}

const injected = (text: string) =>
  injectedTag(text) || INJECTED_HEADINGS.some((h) => text.startsWith(h));

async function readToml(path: string): Promise<Record<string, unknown>> {
  const text = await Bun.file(path)
    .text()
    .catch(() => null);
  return text === null ? {} : record(Bun.TOML.parse(text));
}

async function trustedProject(home: Home, project: string): Promise<boolean> {
  const projects = record((await readToml(join(home.of(HOME), "config.toml"))).projects);
  const candidates = [...(await ancestorDirs(project)), (await repositoryRoot(project)) ?? project];
  return candidates.some((dir) => record(projects[dir]).trust_level === "trusted");
}
