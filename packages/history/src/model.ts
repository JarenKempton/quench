export type HarnessId = "claude-code" | "codex" | "pi";

export type Author = "user" | "assistant" | "injected";

export type Origin = "typed" | "scheduled" | "host" | "unknown";

export type SenderEvidence = {
  sender: "person" | "automation";
  source: string;
  messageId: string;
  notice?: true;
};

export type SessionEnricher = (session: Session) => Session;

export type Usage = {
  context: number | null;
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
};

export const contextOf = (u: Usage) => u.context;

export const sumOf = (...parts: (number | null)[]) =>
  parts.some((p) => p === null) ? null : (parts as number[]).reduce((a, b) => a + b, 0);

export const knownUsage = (
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number,
) => ({
  context: input + cacheRead + cacheWrite,
  input,
  cacheRead,
  cacheWrite,
  output,
});

export type CompactionTrigger = "auto" | "manual" | "unknown";

export type FileReadRequest = {
  path: string;
  offset: number | null;
  limit: number | null;
};

export type FileReadResult = {
  path: string | null;
  startLine: number | null;
  lineCount: number | null;
  totalLines: number | null;
  returnedTextSha256: string;
  returnedTextChars: number;
};

export type InjectedInstruction = {
  path: string | null;
  directory: string | null;
  label: string | null;
  textSha256: string;
  textChars: number;
  textDiffersFromFile: boolean | null;
};

export type ShellCommand = { command: string | null; workdir: string | null };

export type FailureKind =
  | "blocked"
  | "rejected"
  | "invalid-input"
  | "missing-program"
  | "missing-path"
  | "exit-code"
  | "error";

export type Failure = {
  kind: FailureKind;
  detail: string | null;
  exitCode: number | null;
  line?: string | null;
  errorClass?: string;
  hook?: string | null;
};

export type ListedSkill = {
  name: string;
  path: string | null;
  chars: number | null;
};

export type PromptTool = {
  name: string;
  server: string | null;
  chars: number;
  deferred: boolean;
};

export const mcpServerOf = (name: string): string | null => /^mcp__(.+?)__/.exec(name)?.[1] ?? null;

export type EventKind =
  | {
      type: "message";
      author: Author;
      origin: Origin;
      text: string;
      sender?: SenderEvidence;
      queued?: true;
    }
  | {
      type: "inference";
      model: string | null;
      effort: string | null;
      usage: Usage;
    }
  | {
      type: "tool_call";
      id: string | null;
      name: string;
      fileRead?: FileReadRequest;
      shell?: ShellCommand[];
    }
  | { type: "invocation"; name: string; by: "model" | "user" }
  | {
      type: "mcp_call";
      id: string | null;
      server: string;
      tool: string;
      inScript?: boolean;
    }
  | {
      type: "tool_result";
      callId: string | null;
      isError: boolean | null;
      chars: number;
      loadedTools?: string[];
      failure?: Failure;
      fileRead?: FileReadResult;
      backgrounded?: { task: string; finishedLine: number | null };
    }
  | {
      type: "compaction";
      trigger: CompactionTrigger;
      tokensBefore: number | null;
    }
  | { type: "instructions"; files: InjectedInstruction[]; unreadable: number }
  | { type: "skills"; listed: ListedSkill[]; chars: number }
  | { type: "prompt"; system: number | null; tools: PromptTool[] | null }
  | { type: "deferred_tools"; names: string[]; chars: number }
  | { type: "mcp_instructions"; servers: string[]; chars: number }
  | { type: "unknown_model"; model: string }
  | { type: "mcp_status"; failed: { server: string; code: string | null }[]; needsLogin: string[] };

export type Event = EventKind & { at: Date | null; line?: number };

export function unhandled(event: never): never {
  throw new Error(`unhandled event ${JSON.stringify(event)}`);
}

export type Inference = Extract<Event, { type: "inference" }>;

export type Diagnostics = {
  lines: number;
  unparsed: number;
};

export type Session = {
  id: string;
  harness: HarnessId;
  path: string;
  cwd: string | null;
  branch: string | null;
  parent: string | null;
  events: Event[];
  diagnostics: Diagnostics;
};

export const inferences = (s: Session): Inference[] =>
  s.events.filter((e): e is Inference => e.type === "inference");

export const startedAt = (s: Session): Date | null => s.events.find((e) => e.at)?.at ?? null;
