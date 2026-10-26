import { basename } from "node:path";
import type { Failure, FailureKind, Session } from "./model.ts";
import { intern } from "./recorded.ts";
import { commandSignature } from "./shell.ts";

export type SessionFailure = {
  kind: FailureKind;
  what: string | null;
  failures: number;
  longestRun: number;
  chars: number;
};

const SCANNED = 4000;

const NOTHING_FOUND = new Set(["grep", "egrep", "fgrep", "rg", "diff", "cmp", "test", "["]);

export function failureOf(text: string, isError: boolean | null, rejected = false): Failure | null {
  const head = text.slice(0, SCANNED);
  const exitCode = exitCodeOf(head);
  if (isError !== true && !exitCode) return null;
  if (/invalid arguments|InputValidationError|validation error|No such tool available/i.test(head))
    return { kind: "invalid-input", detail: summary(head), exitCode };
  if (rejected) return { kind: "rejected", detail: summary(head), exitCode };
  const program =
    head.match(/command not found: ([\w.+-]+)/) ?? head.match(/([\w.+-]+): command not found/);
  if (program || exitCode === 127)
    return { kind: "missing-program", detail: program ? program[1]! : null, exitCode };
  const path =
    head.match(/No such file or directory(?::|,\s*\w+) '([^']+)'/) ??
    head.match(/([^\s:'"`[\]]*[/.~][^\s:'"`[\]]*)'?: No such file or directory/) ??
    head.match(/no matches found: (\S+)/);
  if (path || /No such file or directory|File does not exist|ENOENT/i.test(head))
    return { kind: "missing-path", detail: path ? path[1]! : null, exitCode };
  if (exitCode) return { kind: "exit-code", detail: null, exitCode };
  return { kind: "error", detail: summary(head), exitCode };
}

function exitCodeOf(text: string): number | null {
  const codes = [
    ...text.matchAll(
      /^Exit code (-?\d+)|"exit_code\\?"\s*:\s*(-?\d+)|Process exited with code (-?\d+)/gm,
    ),
  ].map((m) => Number(m[1] ?? m[2] ?? m[3]));
  return codes.find((c) => c !== 0) ?? null;
}

function summary(text: string): string | null {
  const line = text
    .replace(/<\/?[a-z_]+>/g, "")
    .replace(/^\s*[\w:]+ hook error:\s*/i, "")
    .replace(/\[[^\]]*\]:?\s*/g, "")
    .replace(/^\s*(Exit code -?\d+\s*|Error:\s*)+/, "")
    .split(/\n|\.\s/)
    .find((l) => l.trim());
  if (!line) return null;
  return line
    .trim()
    .replace(/\S*\/\S*/g, (token) => basename(token.replace(/[\]:,.]+$/, "")))
    .replace(/\b[0-9a-f]{7,}\b/g, "…")
    .replace(/\d+/g, "N")
    .split(/\s+/)
    .slice(0, 12)
    .join(" ")
    .slice(0, 100)
    .replace(/[.:]$/, "");
}

export function recordedFailures(session: Session): SessionFailure[] {
  const calls = new Map<string, Extract<Session["events"][number], { type: "tool_call" }>>();
  const seen = new Set<string>();
  const rows = new Map<string, SessionFailure>();
  let previous: string | null = null;
  let run = 0;
  for (const event of session.events) {
    if (event.type === "tool_call" && event.id !== null) calls.set(event.id, event);
    if (event.type !== "tool_result") continue;
    if (event.callId !== null) {
      if (seen.has(event.callId)) continue;
      seen.add(event.callId);
    }
    if (!event.failure) {
      previous = null;
      continue;
    }
    const call = event.callId === null ? undefined : calls.get(event.callId);
    const shell = call?.shell?.length === 1 ? call.shell[0]!.command : null;
    const signature = shell ? commandSignature(shell) : null;
    const { kind, detail, exitCode } = event.failure;
    if (
      kind === "exit-code" &&
      exitCode === 1 &&
      NOTHING_FOUND.has(signature?.split(" ")[0] ?? "")
    ) {
      previous = null;
      continue;
    }
    const what =
      detail ??
      (kind === "missing-path" ? call?.fileRead?.path : null) ??
      signature ??
      (kind === "exit-code" || kind === "missing-program" ? null : (call?.name ?? null));
    const key = `${kind}\0${what}`;
    run = key === previous ? run + 1 : 1;
    previous = key;
    const row =
      rows.get(key) ??
      rows
        .set(key, {
          kind,
          what: what && intern(what),
          failures: 0,
          longestRun: 0,
          chars: 0,
        })
        .get(key)!;
    row.failures++;
    row.longestRun = Math.max(row.longestRun, run);
    row.chars += event.chars;
  }
  return [...rows.values()];
}
