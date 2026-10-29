import { kilo, layers, servers, startTokens } from "./context.ts";

const cold = servers.find((s) => s.called === 0)!;
const order = ["system", "tools", "instructions", "mcp:tracker", "skills", "mcp:browser"];
const key = (l: (typeof layers)[number]) => (l.mcp ? `mcp:${l.name.slice(5)}` : l.kind);

export const slabWidth = 240;
export const segments = (() => {
  const ordered = order.map((k) => layers.find((l) => key(l) === k)!).filter(Boolean);
  const widths = ordered.map((l) => Math.max(6, l.share * slabWidth));
  const scale = slabWidth / widths.reduce((a, b) => a + b, 0);
  let x = 0;
  return ordered.map((l, i) => {
    const w = widths[i] * scale;
    const seg = { x, w, dead: l.name === `MCP: ${cold.server}` };
    x += w;
    return seg;
  });
})();

export const facts = {
  start: startTokens,
  startText: kilo(startTokens),
  server: `MCP: ${cold.server}`,
  unused: `${cold.called} of ${cold.tools} used`,
};
