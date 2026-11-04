import {
  harnessById,
  type HarnessId,
  type McpServer,
  type McpToolLoad,
  type SessionPlace,
} from "@quench/history";
import { chars, count, table } from "../format.ts";
import { dim, heading } from "../style.ts";
import { normalize } from "./recorded-mcp.ts";

const SHOWN = 16;

export type McpToolRecord = {
  harness: HarnessId;
  server: string;
  loading: McpToolLoad["loading"] | null;
  tools: number | null;
  chars: number | null;
  sessions: number;
  source: "request" | "deferred tool list" | null;
};

export function mcpToolRecords(
  places: readonly SessionPlace[],
  configured: readonly McpServer[],
): McpToolRecord[] {
  const latestFirst = [...places].sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
  const seen = new Map<string, McpToolRecord>();
  const recorded = new Set<string>();
  for (const place of latestFirst) {
    for (const load of place.start.mcp) {
      const server = `${place.harness}\0${normalize(load.server)}`;
      const key = `${server}\0${load.loading}`;
      recorded.add(server);
      const known = seen.get(key);
      if (known) known.sessions++;
      else
        seen.set(key, {
          harness: place.harness,
          ...load,
          sessions: 1,
          source: load.chars === null ? "deferred tool list" : "request",
        });
    }
  }
  const missing = new Map<string, McpToolRecord>();
  for (const server of configured) {
    const key = `${server.harness}\0${normalize(server.name)}`;
    if (server.enabled === false || recorded.has(key) || missing.has(key)) continue;
    missing.set(key, {
      harness: server.harness,
      server: server.name,
      loading: null,
      tools: null,
      chars: null,
      sessions: 0,
      source: null,
    });
  }
  return [...[...seen.values()].sort(byLoad), ...[...missing.values()].sort(byName)];
}

const rank = (r: McpToolRecord) => (r.loading === "up front" ? 0 : 1);
const byName = (a: McpToolRecord, b: McpToolRecord) =>
  a.server.localeCompare(b.server) || a.harness.localeCompare(b.harness);
const byLoad = (a: McpToolRecord, b: McpToolRecord) =>
  rank(a) - rank(b) ||
  (b.chars ?? -1) - (a.chars ?? -1) ||
  (b.tools ?? 0) - (a.tools ?? 0) ||
  byName(a, b);

export function renderMcpTools(records: readonly McpToolRecord[], days: number): string[] {
  if (!records.length) return [];
  const shown = records.slice(0, SHOWN);
  return [
    "",
    heading(`MCP tool definitions · from session history · last ${days} days`),
    ...table(
      [
        ["Server", "Agent", "Loads", "Tools", "Schema", "Sessions", "Source"],
        ...shown.map((r) => [
          r.server,
          harnessById[r.harness].label,
          r.loading ?? "not recorded",
          r.tools === null ? "—" : count(r.tools),
          r.chars !== null ? chars(r.chars) : r.loading ? "not recorded" : "—",
          count(r.sessions),
          r.source ?? "—",
        ]),
      ],
      [3, 4, 5],
    ),
    ...(records.length > shown.length
      ? [`  … ${records.length - shown.length} more in --json`]
      : []),
    `  ${dim("Up front: every request carries the schemas. Deferred: listed by name, schemas load on demand (tool search), not part of the starting load.")}`,
    `  ${dim("Numbers are from the latest session that recorded the server. Not recorded: no session in range logged its tools; nothing is estimated.")}`,
  ];
}
