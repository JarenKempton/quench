export type HarnessId = "claude-code" | "codex" | "pi";

export type Author = "user" | "assistant" | "injected";

export type Origin = "typed" | "scheduled" | "host" | "unknown";

export type SenderEvidence = {
  sender: "person" | "automation";
  source: string;
  messageId: string;
};

export type SessionEnricher = (session: Session) => Session;

export type Usage = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
};

export const contextOf = (u: Usage) => u.input + u.cacheRead + u.cacheWrite;

export type CompactionTrigger = "auto" | "manual" | "unknown";

export type FileReadRequest = { path: string; offset: number | null; limit: number | null };

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

export type EventKind =
  | { type: "message"; author: Author; origin: Origin; text: string; sender?: SenderEvidence }
  | { type: "inference"; model: string | null; effort: string | null; usage: Usage }
  | { type: "tool_call"; id: string | null; name: string; fileRead?: FileReadRequest }
  | {
      type: "tool_result";
      callId: string | null;
      isError: boolean | null;
      chars: number;
      fileRead?: FileReadResult;
    }
  | { type: "compaction"; trigger: CompactionTrigger; tokensBefore: number | null }
  | { type: "instructions"; files: InjectedInstruction[]; unreadable: number };

export type Event = EventKind & { at: Date | null };

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
  parent: string | null;
  events: Event[];
  diagnostics: Diagnostics;
};

export const inferences = (s: Session): Inference[] =>
  s.events.filter((e): e is Inference => e.type === "inference");

export const startedAt = (s: Session): Date | null => s.events.find((e) => e.at)?.at ?? null;
