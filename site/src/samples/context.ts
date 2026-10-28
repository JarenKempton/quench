export const model = "claude-opus-5-5";
export const windowTokens = 1_000_000;
export const startTokens = 26004;
export const calls = 13;
export const inputTokens = 377040;

export const prompt = { text: "Add rate limiting to the orders endpoint", chars: 40 };

export const layers = [
  { key: "system", name: "System prompt", chars: 9000, detail: "9.0k chars" },
  { key: "tools", name: "Built-in tools", chars: 18000, detail: "18.0k chars · 12 tools" },
  { key: "mcp", name: "MCP servers", chars: 52000, detail: "52.0k chars · 26 tools, 2 servers" },
  { key: "instructions", name: "Instruction files", chars: 12987, detail: "13.0k chars · 2 files" },
  { key: "skills", name: "Skills", chars: 1103, detail: "1.1k chars · 12 listed" },
];

export const startChars = layers.reduce((sum, l) => sum + l.chars, 0) + prompt.chars;

export const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
