import run from "./samples/run.json";

export const model = run.model;
export const windowTokens = 1_000_000;
export const startTokens = run.contextStart;
export const requests = run.inferences;
export const inputTokens = run.usage.input + run.usage.cacheRead + run.usage.cacheWrite;

const order = ["system", "tools", "mcp_tools", "instructions", "skills"];

type Part = (typeof run.startingContext.parts)[number];

const name = (part: Part) =>
  ({
    system: "System prompt",
    tools: "Built-in tools",
    mcp_tools: `MCP: ${"server" in part ? part.server : ""}`,
    instructions: "Instruction files",
    skills: "Skills",
  })[part.kind] ?? part.kind;

const parts = [...run.startingContext.parts]
  .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.chars - a.chars)
  .map((p) => ({ kind: p.kind, name: name(p), chars: p.chars }));

const all = [...parts, { kind: "prompt", name: "Your prompt", chars: run.prompt.length }];
const totalChars = all.reduce((n, s) => n + s.chars, 0);
const largest = Math.max(...all.map((s) => s.chars));

export const segments = all.map((s) => ({
  ...s,
  share: s.chars / totalChars,
  tokens: (startTokens * s.chars) / totalChars,
  largest: s.chars === largest,
}));

export const kilo = (n: number) => `${(n / 1000).toFixed(1)}k`;
export const percent = (n: number) => `${(n * 100).toFixed(1)}%`;
