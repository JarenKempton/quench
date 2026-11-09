import { stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { z } from "zod";
import { filesWithExt, subdirs } from "../files.ts";
import { sessionRef, type Harness, type SessionRef } from "../harness.ts";
import type { Home } from "../home.ts";
import { checkout, repositoryRoot } from "../files.ts";
import { describeServer, readJson, record, type McpEntry } from "../mcp.ts";
import { listOf, type ConfigFile, type RiskyPermission } from "../settings.ts";
import { pluginSourceSpec, type SkillSource } from "../skill-sources.ts";
import { claudeSkillCut, claudeSkillOrigins } from "./claude-code-skills.ts";
import type { SkillRoot } from "../skills.ts";
import { ancestorDirs, type SteeringRoot } from "../steering.ts";
import { failureOf, type Denial } from "../failures.ts";
import { date, injectedTag, jsonlLines, mcpCalls, sha256, textOf } from "../jsonl.ts";
import type {
  CompactionTrigger,
  Diagnostics,
  Event,
  EventKind,
  FileReadResult,
  Origin,
  Session,
} from "../model.ts";
import { knownUsage, mcpServerOf } from "../model.ts";

const count = z.number().nullish();

const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "trunk"]);

export const ApiUsage = z.looseObject({
  /** Uncached input tokens. */
  input_tokens: count,
  /** Input tokens served from the prompt cache. */
  cache_read_input_tokens: count,
  /** Input tokens written to the prompt cache. */
  cache_creation_input_tokens: count,
  /** Generated tokens, including thinking. */
  output_tokens: count,
});

export const ApiMessage = z.looseObject({
  /** API message id; one response is split across several lines that share it. */
  id: z.string().nullish(),
  /** Model id that produced an assistant message. */
  model: z.string().nullish(),
  /** A string, or an array of content blocks (see `Block`). */
  content: z.unknown().optional(),
  /** Token counts for one API call; repeated on every line of the same message. */
  usage: ApiUsage.optional(),
});

const Line = z.looseObject({
  /** Line kind: `user`, `assistant` and `system` carry the conversation; others (`attachment`, `ai-title`, `queue-operation`…) are host bookkeeping. */
  type: z.string(),
  /** Line id; Claude Code occasionally writes the same line twice. */
  uuid: z.string().nullish(),
  /** ISO 8601 time the line was written. */
  timestamp: z.string().nullish(),
  /** Working directory when the line was written; follows `cd` in the shell. */
  cwd: z.string().nullish(),
  /** Git branch checked out in the working directory, when it is a repository; `HEAD` when detached. */
  gitBranch: z.string().nullish(),
  /** True when Claude Code injected the user line itself (reminders, command output), not the person. */
  isMeta: z.boolean().nullish(),
  /** True on the user line that carries the summary written after a compaction. */
  isCompactSummary: z.boolean().nullish(),
  /** Session-wide reasoning effort: `low`, `medium`, `high`, `xhigh`. */
  effort: z.string().nullish(),
  /** Effort in force for this turn; wins over `effort` when present. */
  perTurnEffort: z.string().nullish(),
  /** Who sent the prompt: `typed` by a person, `sdk` from a host app, `system` from Claude Code itself. */
  promptSource: z.string().nullish(),
  /** Why the turn started, e.g. `scheduled`, `sdk`, `task_notification`. */
  turnOrigin: z.string().nullish(),
  /** Sender of the prompt; `kind` is `human`, `peer` or `task-notification`. */
  origin: z.looseObject({ kind: z.string().nullish() }).optional(),
  /** Kind of `system` line, e.g. `compact_boundary`, `api_error`, `local_command`. */
  subtype: z.string().nullish(),
  /** Present on `compact_boundary` lines. */
  compactMetadata: z
    .looseObject({
      /** `auto` when the context filled up, `manual` for `/compact`. */
      trigger: z.string().nullish(),
      /** Context size in tokens just before compacting. */
      preTokens: count,
    })
    .optional(),
  /** The Anthropic Messages API message, as sent or received. */
  message: ApiMessage.optional(),
  /** On `attachment` lines: context Claude Code added for the model (see `Attachment`). */
  attachment: z.unknown().optional(),
  /** On `api-request-shape` lines: the system prompt and tool definitions of the API request. */
  shape: z
    .looseObject({
      system: z.array(z.looseObject({ text: z.string().nullish() })).nullish(),
      tools: z
        .array(z.looseObject({ name: z.string(), defer_loading: z.boolean().nullish() }))
        .nullish(),
    })
    .nullish(),
  toolUseResult: z.unknown().optional(),
  /** On a tool result line: how the call was allowed or refused; `source` is `hook`, `config`, `user_abort`, `user_reject`… */
  permissionDecision: z
    .looseObject({
      decision: z.string().nullish(),
      source: z.string().nullish(),
      reasonCode: z.string().nullish(),
    })
    .nullish(),
  /** On a refused tool result line in older versions: `permission-rule`, `automode-blocked`, `user-rejected`, `interrupted`… */
  toolDenialKind: z.string().nullish(),
});
type Line = z.infer<typeof Line>;

const BashInput = z.looseObject({
  /** Shell command the model ran. */
  command: z.string(),
});

const SkillInput = z.looseObject({
  /** Name of the skill the model invoked. */
  skill: z.string(),
});

const Attachment = z.looseObject({
  /** `instructions` (memory files loaded at start), `nested_memory` (a subdirectory file loaded on demand), `skill_listing` (skills listed to the model). */
  type: z.string(),
  /** On `instructions`: one entry per loaded file (see `InstructionFile`). */
  files: z.array(z.unknown()).nullish(),
  /** On `nested_memory`: the loaded file (see `InstructionFile`); on `skill_listing`: the listing text. */
  content: z.unknown().optional(),
  /** On `skill_listing`: names of the skills listed. */
  names: z.array(z.string()).nullish(),
  /** On `deferred_tools_delta` and `mcp_instructions_delta`: names added. */
  addedNames: z.array(z.string()).nullish(),
  /** On `deferred_tools_delta`: the lines naming each deferred tool. */
  addedLines: z.array(z.string()).nullish(),
  /** On `mcp_instructions_delta`: each server's instructions. */
  addedBlocks: z.array(z.string()).nullish(),
  commandMode: z.string().nullish(),
  prompt: z.unknown().optional(),
  isMeta: z.boolean().nullish(),
  origin: z.looseObject({ kind: z.string().nullish() }).nullish(),
});

const InstructionFile = z.looseObject({
  /** Absolute path Claude Code loaded the text from. */
  path: z.string(),
  /** Memory type: `User`, `Project`, `Local`, `AutoMem`… */
  type: z.string().nullish(),
  /** Text as injected, after Claude Code's own processing; may differ from the file's bytes. */
  content: z.string(),
  /** True when the injected text differs from the file's raw bytes, e.g. after Claude Code strips HTML comments. */
  contentDiffersFromDisk: z.boolean().nullish(),
});

export const Block = z.looseObject({
  /** `text`, `thinking`, `tool_use`, `tool_result` or `image`. */
  type: z.string(),
  /** Tool call id on `tool_use` blocks. */
  id: z.string().nullish(),
  /** Tool name on `tool_use` blocks, as the host named it. */
  name: z.string().nullish(),
  input: z.unknown().optional(),
  /** Text of a `text` block. */
  text: z.unknown().optional(),
  /** On `tool_result` blocks, the `id` of the `tool_use` it answers. */
  tool_use_id: z.string().nullish(),
  /** True when the tool failed; Claude Code omits it on success. */
  is_error: z.boolean().nullish(),
  /** Output of a `tool_result` block: a string or an array of blocks. */
  content: z.unknown().optional(),
});
type Block = z.infer<typeof Block>;

const HARNESS_NOTES = ["Caveat:", "[Request interrupted by user"];

const ReadInput = z.object({
  file_path: z.string().min(1),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
});

const ReadResult = z.object({
  type: z.literal("text"),
  file: z.object({
    filePath: z.string().min(1),
    startLine: z.number().int().positive(),
    numLines: z.number().int().nonnegative(),
    totalLines: z.number().int().nonnegative(),
  }),
});

const HOME = { variable: "CLAUDE_CONFIG_DIR", fallback: ".claude" };

const SLUG_LIMIT = 200;

export function claudeProjectSlug(path: string): string {
  const slug = path.replace(/[^A-Za-z0-9]/g, "-");
  if (slug.length <= SLUG_LIMIT) return slug;
  let hash = 0;
  for (let i = 0; i < path.length; i++) hash = ((hash << 5) - hash + path.charCodeAt(i)) | 0;
  return `${slug.slice(0, SLUG_LIMIT)}-${Math.abs(hash).toString(36)}`;
}

const globalConfigOf = (home: Home) => {
  const configDir = home.of(HOME);
  return configDir === join(home.dir, ".claude")
    ? join(home.dir, ".claude.json")
    : join(configDir, ".claude.json");
};

const settingsFiles = (configDir: string, project: string): ConfigFile[] => [
  { path: join(configDir, "settings.json"), scope: "user", kind: "settings" },
  { path: join(configDir, "settings.local.json"), scope: "user", kind: "settings" },
  { path: join(project, ".claude/settings.json"), scope: "project", kind: "settings" },
  { path: join(project, ".claude/settings.local.json"), scope: "local", kind: "settings" },
];

export const claudeCode: Harness<"claude-code"> = {
  id: "claude-code",
  label: "Claude Code",
  home: HOME,
  sourceReads: true,
  injectedInstructions: "per-file",
  skillUse: true,

  async steering(home, project) {
    const user = home.of(HOME);
    const roots: SteeringRoot[] = [
      { path: join(user, "CLAUDE.md"), scope: "user" },
      { path: join(user, "rules"), scope: "user", directory: true },
    ];
    for (const dir of await ancestorDirs(project)) {
      const scope = dir === project ? "project" : "ancestor";
      for (const name of [
        "CLAUDE.md",
        ".claude/CLAUDE.md",
        "CLAUDE.local.md",
        "AGENTS.md",
        ".claude/AGENTS.md",
      ])
        roots.push({ path: join(dir, name), scope });
      roots.push({ path: join(dir, ".claude/rules"), scope, directory: true });
    }
    const repo = await checkout(project);
    for (const dir of new Set([repo?.root ?? project, project]))
      roots.push({
        path: join(user, "projects", claudeProjectSlug(dir), "memory", "MEMORY.md"),
        scope: "project",
      });
    return roots;
  },

  async skills(home, project) {
    const dirs = await ancestorDirs(project, true);
    const repo = await checkout(project);
    const scope = (dir: string) => (dir === project ? "project" : "ancestor");
    const own = await stat(join(repo?.top ?? project, ".claude/skills")).catch(() => null);
    const main = repo && repo.top !== repo.root && !own ? [repo.root] : [];
    return [
      { path: join(home.of(HOME), "skills"), scope: "user", layout: "folders" },
      { path: join(home.of(HOME), "commands"), scope: "user", layout: "commands" },
      ...main.map(
        (dir): SkillRoot => ({
          path: join(dir, ".claude/skills"),
          scope: "project",
          layout: "folders",
        }),
      ),
      ...dirs.flatMap((dir): SkillRoot[] => [
        { path: join(dir, ".claude/skills"), scope: scope(dir), layout: "folders" },
        { path: join(dir, ".claude/commands"), scope: scope(dir), layout: "commands" },
      ]),
    ];
  },

  async mcp(home, project) {
    const configDir = home.of(HOME);
    const globalConfig = globalConfigOf(home);
    const global = record(await readJson(globalConfig));
    const key = (await repositoryRoot(project)) ?? project;
    const settings = await Promise.all(
      [
        join(configDir, "settings.json"),
        join(project, ".claude/settings.json"),
        join(project, ".claude/settings.local.json"),
      ].map(async (path) => record(await readJson(path).catch(() => null))),
    );
    const listed = (field: string) =>
      settings.flatMap((s) => (Array.isArray(s[field]) ? (s[field] as unknown[]) : []));
    const servers = new Map<string, McpEntry>();
    const add = (
      entries: unknown,
      scope: McpEntry["scope"],
      source: string,
      enabled: (name: string) => boolean | null,
    ) => {
      for (const [name, config] of Object.entries(record(entries)))
        servers.set(name, {
          name,
          scope,
          source,
          enabled: enabled(name),
          ...describeServer(config),
        });
    };
    add(global.mcpServers, "user", globalConfig, () => true);
    for (const dir of await ancestorDirs(project)) {
      const path = join(dir, ".mcp.json");
      const file = await readJson(path).catch(() => null);
      if (file)
        add(file.mcpServers, "project", path, (name) =>
          listed("disabledMcpjsonServers").includes(name)
            ? false
            : settings.some((s) => s.enableAllProjectMcpServers === true) ||
                listed("enabledMcpjsonServers").includes(name)
              ? true
              : null,
        );
    }
    add(record(record(global.projects)[key]).mcpServers, "local", globalConfig, () => true);
    return [...servers.values()];
  },

  async skillSources(home, project) {
    const configDir = home.of(HOME);
    const knownPath = join(configDir, "plugins/known_marketplaces.json");
    const known = record(await readJson(knownPath).catch(() => null));
    const sources = new Map<string, SkillSource>();
    const add = (kind: SkillSource["kind"], name: string, source: string, value: unknown) => {
      const spec = pluginSourceSpec(value);
      if (spec) sources.set(`${kind}:${name}`, { name, kind, source, ...spec });
    };
    for (const [name, entry] of Object.entries(known))
      add("marketplace", name, knownPath, record(entry).source);
    for (const path of [
      join(configDir, "settings.json"),
      join(project, ".claude/settings.json"),
      join(project, ".claude/settings.local.json"),
    ]) {
      const settings = record(await readJson(path).catch(() => null));
      for (const [name, entry] of Object.entries(record(settings.extraKnownMarketplaces)))
        add("marketplace", name, path, record(entry).source);
      for (const [id, on] of Object.entries(record(settings.enabledPlugins))) {
        const [plugin, market] = id.split("@");
        const location = record(known[market ?? ""]).installLocation;
        if (on !== true || !plugin || typeof location !== "string") continue;
        const manifest = join(location, ".claude-plugin/marketplace.json");
        const listed = listOf(record(await readJson(manifest).catch(() => null)).plugins);
        const entry = listed.map(record).find((p) => p.name === plugin);
        if (entry) add("plugin", id, manifest, entry.source);
      }
    }
    return [...sources.values()];
  },

  skillOrigins: (home) => claudeSkillOrigins(home.of(HOME)),
  skillCut: claudeSkillCut,

  async configs(home, project) {
    const configDir = home.of(HOME);
    const mcpFiles = (await ancestorDirs(project)).map(
      (dir): ConfigFile => ({ path: join(dir, ".mcp.json"), scope: "project", kind: "mcp" }),
    );
    return [
      { path: globalConfigOf(home), scope: "user", kind: "mcp" },
      { path: join(configDir, ".credentials.json"), scope: "user", kind: "credentials" },
      { path: join(configDir, "history.jsonl"), scope: "user", kind: "prompts" },
      ...settingsFiles(configDir, project),
      ...mcpFiles,
    ];
  },

  async permissions(home, project) {
    const found: RiskyPermission[] = [];
    for (const { path } of settingsFiles(home.of(HOME), project)) {
      const settings = record(await readJson(path).catch(() => null));
      const permissions = record(settings.permissions);
      const add = (kind: RiskyPermission["kind"], setting: string) =>
        found.push({ source: path, kind, setting });
      if (permissions.defaultMode === "bypassPermissions")
        add("bypass", "permissions.defaultMode = bypassPermissions");
      if (settings.skipDangerousModePermissionPrompt === true)
        add("bypass", "skipDangerousModePermissionPrompt = true");
      for (const rule of listOf(permissions.allow)) {
        if (typeof rule !== "string") continue;
        if (/^Bash(\((\*|:\*)\))?$/.test(rule)) add("wildcard-shell", `permissions.allow ${rule}`);
        if (/^mcp__(?:(?!__).)+(?:__\*)?$|^mcp__\*$/.test(rule))
          add("auto-approved-mcp", `permissions.allow ${rule}`);
      }
      if (settings.enableAllProjectMcpServers === true)
        add("auto-approved-mcp", "enableAllProjectMcpServers = true");
      for (const name of listOf(settings.enabledMcpjsonServers))
        if (typeof name === "string") add("auto-approved-mcp", `enabledMcpjsonServers ${name}`);
    }
    return found;
  },

  async discover(home: Home): Promise<SessionRef[]> {
    const projects = join(home.of(HOME), "projects");
    const refs: SessionRef[] = [];
    for (const dir of await subdirs(projects)) {
      for (const path of await filesWithExt(dir, ".jsonl", 0)) {
        refs.push(await sessionRef("claude-code", path));
        const id = stem(path);
        for (const child of await filesWithExt(join(dir, id, "subagents"), ".jsonl", 0)) {
          refs.push(await sessionRef("claude-code", child, id));
        }
      }
    }
    return refs;
  },

  async read(r: SessionRef): Promise<Session> {
    const diagnostics: Diagnostics = { lines: 0, unparsed: 0 };
    const events: Event[] = [];
    const inferenceAt = new Map<string, number>();
    const attachments = new Set<string>();
    const queued = new Map<string, Event[]>();
    const delivered = new Set<Event>();
    let cwd: string | null = null;
    let branch: string | null = null;
    const position = { line: 0 };
    for await (const line of jsonlLines(r.path, Line, diagnostics, position)) {
      cwd ??= line.cwd ?? null;
      if (
        line.gitBranch &&
        line.gitBranch !== "HEAD" &&
        (!branch || !DEFAULT_BRANCHES.has(line.gitBranch))
      )
        branch = line.gitBranch;
      if (line.type === "attachment" && line.uuid) {
        if (attachments.has(line.uuid)) continue;
        attachments.add(line.uuid);
      }
      const at = date(line.timestamp);
      for (const kind of eventsOf(line)) {
        const id = line.message?.id;
        const seen = kind.type === "inference" && id ? inferenceAt.get(id) : undefined;
        if (seen !== undefined) {
          events[seen] = {
            ...kind,
            at: events[seen]?.at ?? at,
            line: events[seen]?.line ?? position.line,
          };
          continue;
        }
        if (kind.type === "inference" && id) inferenceAt.set(id, events.length);
        if (kind.type === "inference") queued.clear();
        const event = { ...kind, at, line: position.line };
        if (kind.type === "message" && kind.author === "user") {
          const waiting = queued.get(kind.text) ?? [];
          if (line.type === "attachment") queued.set(kind.text, [...waiting, event]);
          else if (waiting.length) delivered.add(waiting.shift()!);
        }
        events.push(event);
      }
    }
    return {
      id: stem(r.path),
      harness: "claude-code",
      path: r.path,
      cwd,
      branch,
      parent: r.parent,
      events: delivered.size ? events.filter((e) => !delivered.has(e)) : events,
      diagnostics,
    };
  },
};

const stem = (path: string) => basename(path, ".jsonl");

function eventsOf(line: Line): EventKind[] {
  switch (line.type) {
    case "system":
      return line.subtype === "compact_boundary" ? [compaction(line)] : [];
    case "assistant":
      return assistant(line);
    case "user":
      return user(line);
    case "api-request-shape":
      return line.shape ? [requestShape(line.shape)] : [];
    case "attachment":
      return [
        ...instructions(line.attachment),
        ...skillListing(line.attachment),
        ...promptParts(line.attachment),
        ...queuedPrompt(line.attachment),
      ];
    default:
      return [];
  }
}

const joinedLength = (parts: string[]) => parts.join("\n").length;

function requestShape(shape: NonNullable<Line["shape"]>): EventKind {
  return {
    type: "prompt",
    system: shape.system ? joinedLength(shape.system.map((part) => part.text ?? "")) : null,
    tools:
      shape.tools?.map((tool) => ({
        name: tool.name,
        server: mcpServerOf(tool.name),
        chars: JSON.stringify(tool).length,
        deferred: tool.defer_loading === true,
      })) ?? null,
  };
}

function queuedPrompt(raw: unknown): EventKind[] {
  const attachment = Attachment.safeParse(raw);
  if (!attachment.success) return [];
  const a = attachment.data;
  if (a.type !== "queued_command" || a.commandMode !== "prompt" || typeof a.prompt !== "string")
    return [];
  if (!a.prompt.trim()) return [];
  const injected = a.isMeta === true || injectedTag(a.prompt);
  return [
    {
      type: "message",
      author: injected ? "injected" : "user",
      origin: a.origin?.kind === "human" ? "typed" : "unknown",
      text: a.prompt,
      queued: true,
    },
  ];
}

function promptParts(raw: unknown): EventKind[] {
  const attachment = Attachment.safeParse(raw);
  if (!attachment.success) return [];
  const a = attachment.data;
  if (a.type === "deferred_tools_delta" && a.addedNames?.length)
    return [
      { type: "deferred_tools", names: a.addedNames, chars: joinedLength(a.addedLines ?? []) },
    ];
  if (a.type === "mcp_instructions_delta" && a.addedNames?.length)
    return [
      {
        type: "mcp_instructions",
        servers: a.addedNames,
        chars: joinedLength(a.addedBlocks ?? []),
      },
    ];
  return [];
}

function skillListing(raw: unknown): EventKind[] {
  const attachment = Attachment.safeParse(raw);
  if (!attachment.success || attachment.data.type !== "skill_listing" || !attachment.data.names)
    return [];
  const content = typeof attachment.data.content === "string" ? attachment.data.content : "";
  const chars = entryChars(content, attachment.data.names);
  return [
    {
      type: "skills",
      listed: attachment.data.names.map((name) => ({
        name,
        path: null,
        chars: chars.get(name) ?? null,
      })),
      chars: content.length,
    },
  ];
}

function entryChars(content: string, names: string[]): Map<string, number> {
  const longestFirst = [...names].sort((a, b) => b.length - a.length);
  const chars = new Map<string, number>();
  for (const entry of content.split(/\n(?=- )/)) {
    const name = longestFirst.find((n) => entry.startsWith(`- ${n}:`));
    if (name && !chars.has(name)) chars.set(name, entry.length);
  }
  return chars;
}

function instructions(raw: unknown): EventKind[] {
  const attachment = Attachment.safeParse(raw);
  if (!attachment.success) return [];
  const entries =
    attachment.data.type === "instructions"
      ? (attachment.data.files ?? [])
      : attachment.data.type === "nested_memory"
        ? [attachment.data.content]
        : null;
  if (!entries) return [];
  const files = entries.flatMap((entry) => {
    const file = InstructionFile.safeParse(entry);
    return file.success
      ? [
          {
            path: file.data.path,
            directory: null,
            label: file.data.type ?? null,
            textSha256: sha256(file.data.content),
            textChars: file.data.content.length,
            textDiffersFromFile: file.data.contentDiffersFromDisk ?? null,
          },
        ]
      : [];
  });
  return [{ type: "instructions", files, unreadable: entries.length - files.length }];
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
    const usage = knownUsage(
      u.input_tokens ?? 0,
      u.cache_read_input_tokens ?? 0,
      u.cache_creation_input_tokens ?? 0,
      u.output_tokens ?? 0,
    );
    if (usage.context + usage.output > 0) {
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
      const input = block.name === "Read" ? ReadInput.safeParse(block.input) : null;
      const skill = block.name === "Skill" ? SkillInput.safeParse(block.input) : null;
      const shell = block.name === "Bash" ? BashInput.safeParse(block.input) : null;
      if (skill?.success) out.push({ type: "invocation", name: skill.data.skill, by: "model" });
      out.push(...mcpCalls(block.name ?? "", { prefix: "^", suffix: "$", id: block.id ?? null }));
      out.push({
        type: "tool_call",
        id: block.id ?? null,
        name: block.name ?? "",
        ...(shell?.success
          ? { shell: [{ command: shell.data.command, workdir: line.cwd ?? null }] }
          : {}),
        ...(input?.success
          ? {
              fileRead: {
                path: input.data.file_path,
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

const rejected = (text: string) =>
  /^\s*<tool_use_error>|hook error|permission request|doesn't want to|interrupted before/.test(
    text.slice(0, 400),
  );

const BLOCKED_BY = new Set(["hook", "config"]);
const BLOCKED_KINDS = new Set(["permission-rule", "automode-blocked"]);

function denial(line: Line, text: string, single: boolean): Denial {
  const decision = line.permissionDecision;
  const blocked = decision
    ? decision.decision === "reject" && BLOCKED_BY.has(decision.source ?? "")
    : BLOCKED_KINDS.has(line.toolDenialKind ?? "");
  if (single && blocked) return { guard: guardOf(line) };
  return rejected(text) ? "rejected" : null;
}

const HOOK_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "UserPromptSubmit",
  "Notification",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "SessionStart",
  "SessionEnd",
]);

function guardOf(line: Line): string {
  const decision = line.permissionDecision;
  if (decision?.source === "hook") {
    const event = decision.reasonCode?.replace(/^hook:/, "");
    return event && HOOK_EVENTS.has(event) ? `${event} hook` : "hook";
  }
  if (decision?.source === "config") return "permission rule";
  return line.toolDenialKind === "automode-blocked" ? "auto mode" : "permission rule";
}

const ToolReference = z.object({ type: z.literal("tool_reference"), tool_name: z.string() });

function referencedTools(content: unknown): { loadedTools?: string[] } {
  if (!Array.isArray(content)) return {};
  const names = content.flatMap((item) => {
    const ref = ToolReference.safeParse(item);
    return ref.success ? [ref.data.tool_name] : [];
  });
  return names.length ? { loadedTools: names } : {};
}

function user(line: Line): EventKind[] {
  const content = line.message?.content;
  const results = blocks(content).filter((b) => b.type === "tool_result");
  if (results.length > 0) {
    return results.map((b) => {
      const text = textOf(b.content);
      const fileRead =
        results.length === 1 &&
        b.is_error !== true &&
        (typeof b.content === "string" || text.length > 0)
          ? readResult(line.toolUseResult, text)
          : null;
      const failure = failureOf(text, b.is_error ?? null, denial(line, text, results.length === 1));
      return {
        type: "tool_result",
        callId: b.tool_use_id ?? null,
        isError: b.is_error === true,
        chars: text.length,
        ...referencedTools(b.content),
        ...(failure ? { failure } : {}),
        ...(fileRead ? { fileRead } : {}),
      };
    });
  }
  const text = textOf(content);
  if (!text.trim()) return [];
  const flagged = line.isMeta === true || line.isCompactSummary === true;
  const command = slashCommand(text);
  if (command && !flagged)
    return [
      { type: "message", author: "user", origin: origin(line), text: command },
      { type: "invocation", name: command.split(" ")[0]!.replace(/^\//, ""), by: "user" },
    ];
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

function readResult(raw: unknown, text: string): FileReadResult | null {
  const parsed = ReadResult.safeParse(raw);
  if (!parsed.success) return null;
  const file = parsed.data.file;
  if (file.numLines > 0 && file.startLine + file.numLines - 1 > file.totalLines) return null;
  return {
    path: file.filePath,
    startLine: file.startLine,
    lineCount: file.numLines,
    totalLines: file.totalLines,
    returnedTextSha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
    returnedTextChars: text.length,
  };
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
