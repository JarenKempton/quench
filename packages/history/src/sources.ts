import { harnessById } from "./harnesses/index.ts";
import type { Event, FileReadRequest, FileReadResult, Session } from "./model.ts";

type SourceRead = {
  callId: string | null;
  requestedAt: Date | null;
  resultAt: Date | null;
  requested: FileReadRequest;
  status: "returned" | "failed" | "missing-result" | "unknown";
  reason: string | null;
  returned: FileReadResult | null;
};

export function sourceTrace(session: Session) {
  const calls = new Map<string, number[]>();
  const results = new Map<string, number[]>();
  const usedResults = new Set<number>();
  let otherToolCalls = 0;
  session.events.forEach((event, index) => {
    if (event.type === "tool_call") {
      if (event.id !== null) calls.set(event.id, [...(calls.get(event.id) ?? []), index]);
      if (!event.fileRead) otherToolCalls++;
    }
    if (event.type === "tool_result" && event.callId !== null)
      results.set(event.callId, [...(results.get(event.callId) ?? []), index]);
  });
  const reads: SourceRead[] = session.events.flatMap((event, index) => {
    if (event.type !== "tool_call" || !event.fileRead) return [];
    const read: SourceRead = {
      callId: event.id,
      requestedAt: event.at,
      resultAt: null,
      requested: event.fileRead,
      status: "unknown",
      reason: null,
      returned: null,
    };
    const matches = event.id === null ? [] : (results.get(event.id) ?? []);
    if (event.id === null || calls.get(event.id)?.length !== 1 || matches.length > 1) {
      read.reason = "Call and result cannot be matched uniquely.";
    } else if (matches.length === 0) {
      read.status = "missing-result";
      read.reason = "No result is recorded for this call.";
    } else if (matches[0]! <= index) {
      read.reason = "The result precedes its call in the transcript.";
    } else {
      const result = session.events[matches[0]!] as Extract<Event, { type: "tool_result" }>;
      read.resultAt = result.at;
      usedResults.add(matches[0]!);
      if (result.isError === true) {
        read.status = "failed";
        read.reason = "The tool reported an error.";
      } else if (result.fileRead) {
        read.status = "returned";
        read.returned = result.fileRead;
      } else {
        read.reason = "The result lacks supported text-file source metadata.";
      }
    }
    return [read];
  });
  const unmatchedFileResults = session.events.filter(
    (event, index) => event.type === "tool_result" && event.fileRead && !usedResults.has(index),
  ).length;
  const supported = harnessById[session.harness].sourceReads;
  const warnings: string[] = [];
  if (!supported)
    warnings.push(
      "This adapter does not yet trace native file reads; an empty report does not mean no sources were read.",
    );
  if (unmatchedFileResults)
    warnings.push(
      `${unmatchedFileResults} file results could not be linked to a unique native read call.`,
    );
  if (reads.some((read) => read.status === "unknown"))
    warnings.push(
      "Some read attempts lack reliable source attribution; inspect their recorded reasons.",
    );
  if (session.diagnostics.unparsed)
    warnings.push(
      `${session.diagnostics.unparsed} history records could not be parsed; coverage is incomplete.`,
    );
  return {
    evidence: "session-history" as const,
    session: { id: session.id, harness: session.harness, path: session.path, cwd: session.cwd },
    coverage: {
      nativeFileReads: supported ? "supported" : "unsupported",
      otherToolCalls,
      unmatchedFileResults,
      unparsedRecords: session.diagnostics.unparsed,
    },
    reads,
    warnings,
    limitations: [
      "Only recorded native text-file reads are traced. Shell/MCP reads, injected instructions, imports and skill loading are not reconstructed.",
      "Returned output is transcript evidence, not proof it was used, obeyed or retained after compaction. Reported line ranges do not guarantee complete file delivery.",
      "No current source files are opened. Hashes identify recorded tool text, including wrappers, not source-file bytes.",
    ],
  };
}
