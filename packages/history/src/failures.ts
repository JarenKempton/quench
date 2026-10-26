import type { Event, Failure, Session } from "./model.ts";
import {
  exitCodeOf,
  failureSummary,
  mentionsInvalidInput,
  mentionsMissingPath,
  missingPathOf,
  missingProgramOf,
} from "./failure-text.ts";
import { intern } from "./recorded.ts";
import { commandSignature } from "./shell.ts";

export type SessionFailure = {
  kind: Failure["kind"];
  what: string | null;
  failures: number;
  longestRun: number;
  chars: number;
};

type ToolCall = Extract<Event, { type: "tool_call" }>;
type ToolResult = Extract<Event, { type: "tool_result" }>;

const SCANNED = 4000;

export function failureOf(text: string, isError: boolean | null, rejected = false): Failure | null {
  const head = text.slice(0, SCANNED);
  const exitCode = exitCodeOf(head);
  if (isError !== true && !exitCode) return null;

  if (mentionsInvalidInput(head))
    return { kind: "invalid-input", detail: failureSummary(head), exitCode };
  if (rejected) return { kind: "rejected", detail: failureSummary(head), exitCode };

  const missingProgram = missingProgramOf(head);
  if (missingProgram !== null || exitCode === 127)
    return { kind: "missing-program", detail: missingProgram, exitCode };

  const missingPath = missingPathOf(head);
  if (missingPath !== null || mentionsMissingPath(head))
    return { kind: "missing-path", detail: missingPath, exitCode };

  if (exitCode) return { kind: "exit-code", detail: null, exitCode };
  return { kind: "error", detail: failureSummary(head), exitCode };
}

export function recordedFailures(session: Session): SessionFailure[] {
  const callsById = new Map<string, ToolCall>();
  const countedResults = new Set<string>();
  const rows = new Map<string, SessionFailure>();
  let previousKey: string | null = null;
  let runLength = 0;

  const breakRun = () => {
    previousKey = null;
  };

  for (const event of session.events) {
    if (event.type === "tool_call" && event.id !== null) callsById.set(event.id, event);
    if (event.type !== "tool_result") continue;
    if (alreadyCounted(event, countedResults)) continue;
    if (!event.failure) {
      breakRun();
      continue;
    }

    const call = event.callId === null ? undefined : callsById.get(event.callId);
    const signature = shellSignatureOf(call);
    if (isNothingFound(event.failure, signature)) {
      breakRun();
      continue;
    }

    const what = whatFailed(event.failure, call, signature);
    const key = `${event.failure.kind}\0${what}`;
    runLength = key === previousKey ? runLength + 1 : 1;
    previousKey = key;

    const row = rowFor(rows, key, event.failure.kind, what);
    row.failures++;
    row.longestRun = Math.max(row.longestRun, runLength);
    row.chars += event.chars;
  }
  return [...rows.values()];
}

function alreadyCounted(event: ToolResult, counted: Set<string>): boolean {
  if (event.callId === null) return false;
  if (counted.has(event.callId)) return true;
  counted.add(event.callId);
  return false;
}

function shellSignatureOf(call: ToolCall | undefined): string | null {
  if (call?.shell?.length !== 1) return null;
  const command = call.shell[0]!.command;
  return command ? commandSignature(command) : null;
}

const NOTHING_FOUND = new Set(["grep", "egrep", "fgrep", "rg", "diff", "cmp", "test", "["]);

function isNothingFound(failure: Failure, signature: string | null): boolean {
  if (failure.kind !== "exit-code" || failure.exitCode !== 1) return false;
  return NOTHING_FOUND.has(signature?.split(" ")[0] ?? "");
}

function whatFailed(
  failure: Failure,
  call: ToolCall | undefined,
  signature: string | null,
): string | null {
  if (failure.detail !== null) return failure.detail;
  if (failure.kind === "missing-path" && call?.fileRead) return call.fileRead.path;
  if (signature !== null) return signature;
  if (failure.kind === "exit-code" || failure.kind === "missing-program") return null;
  return call?.name ?? null;
}

function rowFor(
  rows: Map<string, SessionFailure>,
  key: string,
  kind: Failure["kind"],
  what: string | null,
): SessionFailure {
  const existing = rows.get(key);
  if (existing) return existing;
  const row: SessionFailure = {
    kind,
    what: what && intern(what),
    failures: 0,
    longestRun: 0,
    chars: 0,
  };
  rows.set(key, row);
  return row;
}
