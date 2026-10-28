export const model = "claude-opus-5-5";
export const windowTokens = 1_000_000;
export const startTokens = 26004;

export const prompt = { text: "Add rate limiting to the orders endpoint", chars: 40 };

export const layers = [
  { key: "system", name: "System prompt", chars: 9000, note: "" },
  { key: "tools", name: "Built-in tools", chars: 18000, note: "12 tools" },
  { key: "mcp", name: "MCP servers", chars: 52000, note: "26 tools, 2 servers" },
  { key: "instructions", name: "Instruction files", chars: 12987, note: "2 files" },
  { key: "skills", name: "Skill list", chars: 1103, note: "12 skills" },
];

export const layerChars = layers.reduce((sum, l) => sum + l.chars, 0);

export const report = { days: 30, processed: 2_000_000, startShare: 0.7 };

export const servers = [
  { name: "browser", tools: 22, called: 0 },
  { name: "tracker", tools: 4, called: 2 },
];

export const skills = { listed: 12, used: 3 };

export const toolCalls = [
  { tool: "Read", ok: true },
  { tool: "Read", ok: true },
  { tool: "Bash", ok: true },
  { tool: "Bash", ok: true },
  { tool: "Skill", ok: true },
  { tool: "tracker", ok: true },
  { tool: "tracker", ok: true },
  { tool: "Read", ok: false, why: "docs/runbook.md: no such file" },
  { tool: "Bash", ok: false, why: "git push --force: blocked" },
  { tool: "Bash", ok: false, why: "git push --force: blocked" },
  { tool: "Bash", ok: false, why: "git push --force: blocked" },
  { tool: "Bash", ok: false, why: "git push --force: blocked" },
];

export const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
export const pct = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`;
