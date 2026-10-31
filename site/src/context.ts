import run from "./samples/run.json";

type Part = (typeof run.startingContext.parts)[number];

export const windowTokens = 1_000_000;
export const startTokens = run.contextStart;
export const peakTokens = run.contextPeak;
export const requests = run.inferences;
export const inputTokens = run.usage.input + run.usage.cacheRead + run.usage.cacheWrite;

export const skillUse = { listed: 12, used: 3 };

const order = ["system", "tools", "mcp_tools", "instructions", "skills"];

const name = (p: Part) =>
  ({
    system: "System prompt",
    tools: "Built-in tools",
    mcp_tools: `MCP: ${"server" in p ? p.server : ""}`,
    instructions: "Instruction files",
    skills: "Skill list",
  })[p.kind] ?? p.kind;

export const layerChars = run.startingContext.parts.reduce((n, p) => n + p.chars, 0);

export const layers = [...run.startingContext.parts]
  .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.chars - a.chars)
  .map((p) => ({
    kind: p.kind,
    name: name(p),
    chars: p.chars,
    share: p.chars / layerChars,
    mcp: p.kind === "mcp_tools",
  }));

export const servers = run.startingContext.parts
  .filter((p) => p.kind === "mcp_tools")
  .map((p) => {
    const server = "server" in p ? p.server : "";
    return {
      server,
      tools: "count" in p ? p.count : 0,
      called: new Set(run.calls.filter((c) => c.server === server).map((c) => c.tool)).size,
    };
  });

const failure = (tool: string) =>
  tool === "Read" ? "no such file: docs/runbook.md" : "guard: blocked — force push";

export const calls = run.calls.map((c) => ({
  tool: c.server ? `${c.server}: ${c.tool}` : c.tool,
  ok: c.ok,
  why: c.ok ? "" : failure(c.tool),
}));

export const kilo = (n: number) => `${(n / 1000).toFixed(1)}k`;
export const percent = (n: number, digits = 0) => `${(n * 100).toFixed(digits)}%`;
