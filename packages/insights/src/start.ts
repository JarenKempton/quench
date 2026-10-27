import { contextOf, type PromptTool, type Session } from "@quench/history";

export type StartPart =
  | { kind: "system"; chars: number }
  | { kind: "tools"; count: number; chars: number }
  | { kind: "mcp_tools"; server: string; count: number; chars: number }
  | { kind: "deferred_tools"; count: number; chars: number }
  | { kind: "mcp_instructions"; servers: string[]; chars: number }
  | { kind: "instructions"; files: number; chars: number }
  | { kind: "skills"; count: number; chars: number };

export type StartingContext = {
  tokens: number | null;
  parts: StartPart[];
  unrecorded: StartPart["kind"][];
};

export function startingContext(session: Session): StartingContext {
  let tokens: number | null = null;
  let system: number | null = null;
  let tools: PromptTool[] | null = null;
  let deferred: string[] = [];
  let deferredChars = 0;
  const parts: StartPart[] = [];
  for (const event of session.events) {
    if (event.type === "inference") {
      tokens = contextOf(event.usage);
      break;
    }
    if (event.type === "prompt") {
      system = event.system ?? system;
      tools = event.tools ?? tools;
    } else if (event.type === "deferred_tools") {
      deferred = event.names;
      deferredChars = event.chars;
    } else if (event.type === "mcp_instructions") {
      parts.push({ kind: "mcp_instructions", servers: event.servers, chars: event.chars });
    } else if (event.type === "instructions") {
      parts.push({
        kind: "instructions",
        files: event.files.length,
        chars: event.files.reduce((n, f) => n + f.textChars, 0),
      });
    } else if (event.type === "skills") {
      parts.push({ kind: "skills", count: event.listed.length, chars: event.chars });
    }
  }
  const sent = (tools ?? []).filter((t) => !t.deferred && !deferred.includes(t.name));
  const builtIn = sent.filter((t) => t.server === null);
  const servers = Map.groupBy(
    sent.filter((t) => t.server !== null),
    (t) => t.server!,
  );
  const measured: StartPart[] = [
    ...(system === null ? [] : [{ kind: "system" as const, chars: system }]),
    ...(tools === null
      ? []
      : [{ kind: "tools" as const, count: builtIn.length, chars: sum(builtIn) }]),
    ...[...servers].map(([server, list]) => ({
      kind: "mcp_tools" as const,
      server,
      count: list.length,
      chars: sum(list),
    })),
    ...(deferred.length
      ? [{ kind: "deferred_tools" as const, count: deferred.length, chars: deferredChars }]
      : []),
    ...parts,
  ];
  return {
    tokens,
    parts: measured,
    unrecorded: [
      ...(system === null ? (["system"] as const) : []),
      ...(tools === null ? (["tools", "mcp_tools"] as const) : []),
    ],
  };
}

const sum = (tools: PromptTool[]) => tools.reduce((n, t) => n + t.chars, 0);
