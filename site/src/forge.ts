import { inputTokens, kilo, layers, percent, requests, servers, skillUse, startTokens } from "./context.ts";

const tokens = (share: number) => Math.round(share * startTokens);

const used = (kind: string, name: string) => {
  if (kind === "skills") return { text: `${skillUse.used} of ${skillUse.listed} used`, dead: false };
  const server = servers.find((s) => `MCP: ${s.server}` === name);
  if (server) return { text: `${server.called} of ${server.tools} called`, dead: server.called === 0 };
  return null;
};

const note: Record<string, string> = {
  system: "harness",
  tools: "12 tools",
  instructions: "2 files",
};

export const rows = layers
  .map((l) => ({ ...l, tokens: tokens(l.share), used: used(l.kind, l.name), note: note[l.kind] ?? "" }))
  .sort((a, b) => b.tokens - a.tokens);

export const cut = rows.find((r) => r.used?.dead)!;
export const afterTokens = startTokens - cut.tokens;

const slabOrder = ["system", "tools", "instructions", "mcp:tracker", "skills", "mcp:browser"];
const key = (r: (typeof rows)[number]) => (r.mcp ? `mcp:${r.name.slice(5)}` : r.kind);

export const slabWidth = 170;
export const segments = (() => {
  const ordered = slabOrder.map((k) => rows.find((r) => key(r) === k)!).filter(Boolean);
  const widths = ordered.map((r) => Math.max(5, (r.tokens / startTokens) * slabWidth));
  const scale = slabWidth / widths.reduce((a, b) => a + b, 0);
  let x = 0;
  return ordered.map((r, i) => {
    const w = widths[i] * scale;
    const seg = { name: r.name, x, w, dead: r === cut };
    x += w;
    return seg;
  });
})();

export const facts = {
  start: kilo(startTokens),
  after: kilo(afterTokens),
  cut: kilo(cut.tokens),
  cutName: cut.name,
  input: kilo(inputTokens),
  share: percent((startTokens * requests) / inputTokens),
  requests,
  sessions: 19,
};
