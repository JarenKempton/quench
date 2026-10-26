import { harnessById } from "./harnesses/index.ts";
import { shellReads, type ShellRead } from "./shell.ts";
import type {
  Event,
  FileReadRequest,
  FileReadResult,
  InjectedInstruction,
  Session,
} from "./model.ts";

type SourceRead = {
  callId: string | null;
  requestedAt: Date | null;
  resultAt: Date | null;
  requested: FileReadRequest;
  status: "returned" | "failed" | "missing-result" | "unknown";
  reason: string | null;
  returned: FileReadResult | null;
};

type ShellSourceRead = ShellRead & {
  callId: string | null;
  requestedAt: Date | null;
  workdir: string | null;
  status: "ran" | "failed" | "missing-result" | "unknown";
  reason: string | null;
  outputChars: number | null;
};

type McpSourceCall = {
  server: string;
  tool: string;
  callId: string | null;
  requestedAt: Date | null;
  inScript: boolean;
  status: "returned" | "failed" | "missing-result" | "unknown";
  reason: string | null;
  outputChars: number | null;
};

type ToolResult = Extract<Event, { type: "tool_result" }>;
type Match =
  | { result: ToolResult; index: number }
  | { result: null; problem: string; missing: boolean };

export function sourceTrace(session: Session, home: string | null) {
  const calls = new Map<string, number[]>();
  const results = new Map<string, number[]>();
  const usedResults = new Set<number>();
  const mcpCallIds = new Set(
    session.events.flatMap((e) => (e.type === "mcp_call" && e.id !== null ? [e.id] : [])),
  );
  let otherToolCalls = 0;
  session.events.forEach((event, index) => {
    if (event.type === "tool_call") {
      if (event.id !== null) calls.set(event.id, [...(calls.get(event.id) ?? []), index]);
      if (!event.fileRead && !event.shell && !(event.id !== null && mcpCallIds.has(event.id)))
        otherToolCalls++;
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
    const match = matchOf(event.id, index);
    if (!match.result) {
      read.status = match.missing ? "missing-result" : "unknown";
      read.reason = match.problem;
    } else {
      const result = match.result;
      read.resultAt = result.at;
      usedResults.add(match.index);
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
  let unrecordedCommands = 0;
  const shell: ShellSourceRead[] = session.events.flatMap((event, index) => {
    if (event.type !== "tool_call" || !event.shell) return [];
    const match = matchOf(event.id, index);
    return event.shell.flatMap(({ command, workdir }) => {
      if (command === null) {
        unrecordedCommands++;
        return [];
      }
      return shellReads(command, { workdir, sessionFolder: session.cwd, home }).map((read) => ({
        ...read,
        callId: event.id,
        requestedAt: event.at,
        workdir,
        status: !match.result
          ? match.missing
            ? "missing-result"
            : "unknown"
          : match.result.isError === true
            ? "failed"
            : "ran",
        reason: match.result
          ? match.result.isError === true
            ? "The command reported an error."
            : null
          : match.problem,
        outputChars: match.result?.chars ?? null,
      }));
    });
  });
  const seenMcp = new Set<string>();
  const mcp: McpSourceCall[] = session.events.flatMap((event, index) => {
    if (event.type !== "mcp_call") return [];
    if (event.id !== null && !event.inScript) {
      if (seenMcp.has(event.id)) return [];
      seenMcp.add(event.id);
    }
    const match = matchOf(event.id, index);
    const failed = match.result?.isError === true;
    return [
      {
        server: event.server,
        tool: event.tool,
        callId: event.id,
        requestedAt: event.at,
        inScript: event.inScript ?? false,
        status: !match.result
          ? match.missing
            ? "missing-result"
            : "unknown"
          : failed
            ? "failed"
            : "returned",
        reason: !match.result
          ? match.problem
          : failed
            ? "The tool reported an error."
            : event.inScript
              ? "Output covers the whole script, not this call alone."
              : null,
        outputChars: match.result?.chars ?? null,
      },
    ];
  });
  function matchOf(id: string | null, index: number): Match {
    const matches = id === null ? [] : (results.get(id) ?? []);
    if (id === null || calls.get(id)?.length !== 1 || matches.length > 1)
      return {
        result: null,
        problem: "Call and result cannot be matched uniquely.",
        missing: false,
      };
    if (matches.length === 0)
      return { result: null, problem: "No result is recorded for this call.", missing: true };
    if (matches[0]! <= index)
      return {
        result: null,
        problem: "The result precedes its call in the transcript.",
        missing: false,
      };
    return { result: session.events[matches[0]!] as ToolResult, index: matches[0]! };
  }
  const instructions: (InjectedInstruction & { at: Date | null })[] = [];
  let unreadableInstructions = 0;
  for (const event of session.events) {
    if (event.type !== "instructions") continue;
    unreadableInstructions += event.unreadable;
    for (const file of event.files) instructions.push({ at: event.at, ...file });
  }
  const unmatchedFileResults = session.events.filter(
    (event, index) => event.type === "tool_result" && event.fileRead && !usedResults.has(index),
  ).length;
  const supported = harnessById[session.harness].sourceReads;
  const injected = harnessById[session.harness].injectedInstructions;
  const warnings: string[] = [];
  if (!supported)
    warnings.push(
      "This adapter does not yet trace native file reads; an empty report does not mean no sources were read.",
    );
  if (!instructions.length && !unreadableInstructions)
    warnings.push(
      "No injected instructions are recorded in this session. Older harness versions did not record them, so this does not mean none were loaded.",
    );
  if (unreadableInstructions)
    warnings.push(
      `${unreadableInstructions} recorded instruction ${unreadableInstructions === 1 ? "entry" : "entries"} could not be parsed; instruction coverage is incomplete.`,
    );
  if (unmatchedFileResults)
    warnings.push(
      `${unmatchedFileResults} file results could not be linked to a unique native read call.`,
    );
  if (unrecordedCommands)
    warnings.push(
      `${unrecordedCommands} shell ${unrecordedCommands === 1 ? "command was" : "commands were"} not recorded as literal text; their reads are not traced.`,
    );
  if (shell.some((read) => read.path === null))
    warnings.push(
      "Some shell reads name a path built at run time or relative to an unknown folder; their paths are not resolved.",
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
      shellCommands: session.events.reduce(
        (n, e) => n + (e.type === "tool_call" ? (e.shell?.length ?? 0) : 0),
        0,
      ),
      unrecordedCommands,
      unmatchedFileResults,
      unparsedRecords: session.diagnostics.unparsed,
      injectedInstructions: injected,
      unreadableInstructions,
    },
    reads,
    shell,
    mcp,
    instructions,
    warnings,
    limitations: [
      "Native text-file reads are traced from the harness's read tool. Shell reads are parsed from recorded commands: cat, head, tail, sed without -i, nl, bat, less and more, plus < input. Searches (grep, rg, ag, git grep) are listed separately with their pattern and the files or folders searched; their output is only matching lines, so a search is not a read of the file. Inline Python, JavaScript and Ruby code (-c, -e or a heredoc) is scanned for file opens with a written-out path or a variable set once to one, listed as script reads or writes; a script only puts a file into context if it prints it. Script files run are listed by name; what they open is not known. Editors and other programs are not parsed. Imports and skill loading are not reconstructed.",
      "Shell read paths are resolved against a cd earlier in the same command, the recorded working folder (Codex), or else the session folder. Claude Code keeps the shell folder between commands, so a relative path after an earlier cd may resolve wrong. Paths built from variables, globs or substitutions are not resolved. Output size covers the whole command, not one file, and a command that ran is not proof the file was printed.",
      "MCP calls are listed by server and tool with the size of their output. Their arguments are never read out, so which document, page or record a call fetched is not shown. Calls made inside a Codex code-mode script share that script's output and status.",
      "Injected instructions are the text the harness recorded adding to context, hashed as recorded, including entries re-injected after compaction or inherited by a fork. Claude Code and Pi record each file; Codex records one combined block per directory without file boundaries. Harnesses may process text before injecting it (Claude Code strips HTML comments), so hashes need not match the file's bytes. Recorded text is not proof a rule was followed.",
      "Returned output is transcript evidence, not proof it was used, obeyed or retained after compaction. Reported line ranges do not guarantee complete file delivery.",
      "No current source files are opened. Hashes identify recorded tool text, including wrappers, not source-file bytes.",
    ],
  };
}
