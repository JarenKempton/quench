import { win32 } from "node:path";
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
import { chainedSignatures, commandSignature, isChained, mainCommandSignature } from "./shell.ts";
import { knownTool } from "./subcommands.ts";

export type SessionBackgrounded = {
  what: string;
  chained: Record<string, number>;
  model: string | null;
  backgrounded: number;
  rerun: number;
};

export type SessionFailure = {
  kind: Failure["kind"];
  what: string | null;
  error: string | null;
  guard: string | null;
  hooks: Record<string, number>;
  chained: Record<string, number>;
  failures: number;
  longestRun: number;
  chars: number;
};

type ToolCall = Extract<Event, { type: "tool_call" }>;
type ToolResult = Extract<Event, { type: "tool_result" }>;

const SCANNED = 4000;

const HOOK_SCRIPT = /^[A-Za-z0-9][\w.-]{0,63}\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1)$/;

export const hookScriptsIn = (command: string): string[] =>
  (command.match(/[^\s"']+/g) ?? [])
    .map((word) => win32.basename(word))
    .filter((name) => HOOK_SCRIPT.test(name));

export type Denial = { guard: string; hook?: string | null } | "rejected" | null;

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
  if (denial && denial !== "rejected")
    return {
      kind: "blocked",
      detail: denial.guard,
      exitCode,
      hook: denial.hook ?? null,
    };
  if (mentionsInvalidInput(head)) return summarised("invalid-input");
  if (denial === "rejected") return summarised("rejected");

  const missingProgram = missingProgramOf(head);
  if (missingProgram !== null || exitCode === 127)
    return { kind: "missing-program", detail: missingProgram, exitCode };

  const missingPath = missingPathOf(head);
  if (missingPath !== null || mentionsMissingPath(head))
    return { kind: "missing-path", detail: missingPath, exitCode };

  if (exitCode)
    return {
      kind: "exit-code",
      detail: null,
      exitCode,
      line: errorLineOf(head),
    };
  return summarised("error");
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
    if (call && keyed.what === "several commands") countChained(row.chained, call);
    if (keyed.hook) row.hooks[keyed.hook] = (row.hooks[keyed.hook] ?? 0) + 1;
    row.longestRun = Math.max(row.longestRun, runLength);
    row.chars += event.chars;
  }
  return [...rows.values()];
}

export function failedCall(
  failure: Failure,
  call: ToolCall | undefined,
): { kind: Failure["kind"]; what: string | null; error: string | null } | null {
  const keyed = failureKey(failure, call);
  return keyed && { kind: failure.kind, what: keyed.what, error: keyed.error };
}

function failureKey(
  failure: Failure,
  call: ToolCall | undefined,
): {
  what: string | null;
  error: string | null;
  guard: string | null;
  hook: string | null;
} | null {
  const signature = shellSignatureOf(call);
  if (isNothingFound(failure, signature)) return null;
  const blocked = failure.kind === "blocked";
  const chained = call?.shell?.some((shell) => shell.command && isChained(shell.command));
  return {
    what: chained
      ? "several commands"
      : (signature ?? (call?.shell || !call ? null : knownTool(call.name))),
    error: blocked ? null : (failure.errorClass ?? "other"),
    guard: blocked ? failure.detail : null,
    hook: blocked ? (failure.hook ?? null) : null,
  };
}

export function recordedBackgrounded(session: Session): SessionBackgrounded[] {
  const calls = new Map<string, { call: ToolCall; model: string | null }>();
  const started: { call: ToolCall; text: string; line: number }[] = [];
  const running: { text: string; from: number; until: number | null }[] = [];
  const rows = new Map<string, SessionBackgrounded>();
  const rowOf = (call: ToolCall) => {
    const what = mainCommandOf(call);
    const model = calls.get(call.id!)!.model;
    const key = `${what}\0${model}`;
    return (
      rows.get(key) ??
      rows.set(key, { what, chained: {}, model, backgrounded: 0, rerun: 0 }).get(key)!
    );
  };
  let model: string | null = null;
  for (const event of session.events) {
    if (event.type === "inference") model = event.model ?? model;
    if (
      event.type === "tool_call" &&
      event.id !== null &&
      event.shell?.length &&
      !calls.has(event.id)
    ) {
      calls.set(event.id, { call: event, model });
      started.push({
        call: event,
        text: commandText(event),
        line: event.line ?? 0,
      });
    }
    if (event.type !== "tool_result" || !event.backgrounded || event.callId === null) continue;
    const call = calls.get(event.callId)?.call;
    if (!call) continue;
    const row = rowOf(call);
    row.backgrounded++;
    if (row.what === "several commands") countChained(row.chained, call);
    running.push({
      text: commandText(call),
      from: event.line ?? 0,
      until: event.backgrounded.finishedLine,
    });
  }
  const rerun = started.filter(({ text, line }) =>
    running.some((r) => line > r.from && (r.until === null || line < r.until) && text === r.text),
  );
  for (const { call } of rerun) rowOf(call).rerun++;
  return [...rows.values()];
}

const mainCommandOf = (call: ToolCall) =>
  (call.shell!.length === 1 && call.shell![0]!.command
    ? mainCommandSignature(call.shell![0]!.command)
    : "several commands") ?? "other command";

function countChained(counts: Record<string, number>, call: ToolCall) {
  const chained = (call.shell ?? []).flatMap((shell) =>
    shell.command && isChained(shell.command) ? chainedSignatures(shell.command) : [],
  );
  for (const what of new Set(chained))
    if (what !== "other command") counts[what] = (counts[what] ?? 0) + 1;
}

const commandText = (call: ToolCall) =>
  call.shell!.map((shell) => shell.command?.trim() ?? "").join("\n");

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

function rowFor(
  rows: Map<string, SessionFailure>,
  key: string,
  kind: Failure["kind"],
  keyed: {
    what: string | null;
    error: string | null;
    guard: string | null;
    hook: string | null;
  },
): SessionFailure {
  const existing = rows.get(key);
  if (existing) return existing;
  const row: SessionFailure = {
    kind,
    what: keyed.what && intern(keyed.what),
    error: keyed.error && intern(keyed.error),
    guard: keyed.guard && intern(keyed.guard),
    hooks: {},
    chained: {},
    failures: 0,
    longestRun: 0,
    chars: 0,
  };
  rows.set(key, row);
  return row;
}
