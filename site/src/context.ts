import run from "./samples/run.json";

type Part = (typeof run.startingContext.parts)[number];

export const model = run.model;
export const windowTokens = 1_000_000;
export const startTokens = run.contextStart;
export const peakTokens = run.contextPeak;
export const requests = run.inferences;
export const inputTokens = run.usage.input + run.usage.cacheRead + run.usage.cacheWrite;
export const promptChars = run.prompt.length;

const order = ["system", "tools", "mcp_tools", "instructions", "skills"];
const totalChars = run.startingContext.parts.reduce((n, p) => n + p.chars, 0) + promptChars;

const builtInCalls = run.calls.filter((c) => c.server === null && c.tool !== "Skill");
const skillLoads = run.calls.filter((c) => c.tool === "Skill").length;

const describe = (p: Part) => {
  const server = "server" in p ? p.server : "";
  const count = "count" in p ? p.count : 0;
  const files = "files" in p ? p.files : 0;
  const called = run.calls.filter((c) => c.server === server).length;
  return (
    {
      system: { name: "System prompt", loaded: "1 prompt", called: "always read" },
      tools: {
        name: "Built-in tools",
        loaded: `${count} tools`,
        called: `${new Set(builtInCalls.map((c) => c.tool)).size} of ${count}`,
      },
      mcp_tools: { name: `MCP server: ${server}`, loaded: `${count} tools`, called: `${called} of ${count}` },
      instructions: { name: "Instruction files", loaded: `${files} files`, called: "always read" },
      skills: { name: "Skills", loaded: `${count} listed`, called: `${skillLoads} of ${count}` },
    } as Record<string, { name: string; loaded: string; called: string }>
  )[p.kind];
};

export const layers = [...run.startingContext.parts]
  .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.chars - a.chars)
  .map((p) => ({
    kind: p.kind,
    ...describe(p),
    chars: p.chars,
    tokens: (startTokens * p.chars) / totalChars,
    uncalled: p.kind === "mcp_tools" && !run.calls.some((c) => c.server === ("server" in p ? p.server : "")),
  }));

export const promptTokens = (startTokens * promptChars) / totalChars;
export const largestKind = layers.reduce((a, b) => (b.chars > a.chars ? b : a)).name;
export const uncalledChars = layers.filter((l) => l.uncalled).reduce((n, l) => n + l.chars, 0);
export const uncalledShare = uncalledChars / totalChars;

export const kilo = (n: number) => `${(n / 1000).toFixed(1)}k`;
export const percent = (n: number, digits = 0) => `${(n * 100).toFixed(digits)}%`;
