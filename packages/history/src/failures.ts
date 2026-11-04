import type { Event, Failure, Session } from "./model.ts";
import {
  errorClassOf,
  errorLineOf,
  exitCodeOf,
  failureSummary,
  firstLineOf,
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
  error: string | null;
  guard: string | null;
  failures: number;
  longestRun: number;
  chars: number;
};

type ToolCall = Extract<Event, { type: "tool_call" }>;
type ToolResult = Extract<Event, { type: "tool_result" }>;

const SCANNED = 4000;

export type Denial = { guard: string } | "rejected" | null;

export function failureOf(
  text: string,
  isError: boolean | null,
  denial: Denial = null,
): Failure | null {
  const head = text.slice(0, SCANNED);
  const exitCode = exitCodeOf(head);
  if (isError !== true && !exitCode) return null;
  const failure = classified(head, exitCode, denial);
  return { ...failure, errorClass: errorClassOf(head, exitCode) };
}

function classified(head: string, exitCode: number | null, denial: Denial): Failure {
  const summarised = (kind: Failure["kind"]): Failure => {
    const line = firstLineOf(head);
    return { kind, detail: line && failureSummary(line), exitCode, line };
  };
  if (denial && denial !== "rejected") return { kind: "blocked", detail: denial.guard, exitCode };
  if (mentionsInvalidInput(head)) return summarised("invalid-input");
  if (denial === "rejected") return summarised("rejected");

  const missingProgram = missingProgramOf(head);
  if (missingProgram !== null || exitCode === 127)
    return { kind: "missing-program", detail: missingProgram, exitCode };

  const missingPath = missingPathOf(head);
  if (missingPath !== null || mentionsMissingPath(head))
    return { kind: "missing-path", detail: missingPath, exitCode };

  if (exitCode) return { kind: "exit-code", detail: null, exitCode, line: errorLineOf(head) };
  return summarised("error");
}

export type Scrub = (text: string) => string;

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
    const keyed = failureKey(event.failure, call);
    if (!keyed) {
      breakRun();
      continue;
    }

    const key = `${event.failure.kind}\0${keyed.what}\0${keyed.error}\0${keyed.guard}`;
    runLength = key === previousKey ? runLength + 1 : 1;
    previousKey = key;

    const row = rowFor(rows, key, event.failure.kind, keyed);
    row.failures++;
    row.longestRun = Math.max(row.longestRun, runLength);
    row.chars += event.chars;
  }
  return [...rows.values()];
}

export function failedCall(
  failure: Failure,
  call: ToolCall | undefined,
  scrub: Scrub = (text) => text,
): { kind: Failure["kind"]; what: string | null } | null {
  const signature = shellSignatureOf(call, scrub);
  if (isNothingFound(failure, signature)) return null;
  return { kind: failure.kind, what: whatFailed(failure, call, signature, scrub) };
}

function failureKey(
  failure: Failure,
  call: ToolCall | undefined,
): { what: string | null; error: string | null; guard: string | null } | null {
  const signature = shellSignatureOf(call, (text) => text);
  if (isNothingFound(failure, signature)) return null;
  const blocked = failure.kind === "blocked";
  const chained = blocked && signature === null && call?.shell?.length;
  return {
    what: chained ? "several commands" : (signature ?? (call?.shell ? null : (call?.name ?? null))),
    error: blocked ? null : (failure.errorClass ?? "other"),
    guard: blocked ? failure.detail : null,
  };
}

function scrubbedLine(failure: Failure, scrub: Scrub): string | null {
  return failure.line ? failureSummary(scrub(failure.line)) : null;
}

function alreadyCounted(event: ToolResult, counted: Set<string>): boolean {
  if (event.callId === null) return false;
  if (counted.has(event.callId)) return true;
  counted.add(event.callId);
  return false;
}

function shellSignatureOf(call: ToolCall | undefined, scrub: Scrub): string | null {
  if (call?.shell?.length !== 1) return null;
  const command = call.shell[0]!.command;
  return command ? commandSignature(scrub(command)) : null;
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
  scrub: Scrub,
): string | null {
  if (failure.kind !== "exit-code" && failure.line) return scrubbedLine(failure, scrub);
  if (failure.detail !== null) return scrub(failure.detail);
  if (failure.kind === "missing-path" && call?.fileRead) return scrub(call.fileRead.path);
  if (signature !== null) return signature;
  if (failure.kind === "exit-code" || failure.kind === "missing-program") return null;
  return call?.name ?? null;
}

function rowFor(
  rows: Map<string, SessionFailure>,
  key: string,
  kind: Failure["kind"],
  keyed: { what: string | null; error: string | null; guard: string | null },
): SessionFailure {
  const existing = rows.get(key);
  if (existing) return existing;
  const row: SessionFailure = {
    kind,
    what: keyed.what && intern(keyed.what),
    error: keyed.error && intern(keyed.error),
    guard: keyed.guard && intern(keyed.guard),
    failures: 0,
    longestRun: 0,
    chars: 0,
  };
  rows.set(key, row);
  return row;
}
