import { heading } from "../style.ts";
import {
  harnessById,
  harnesses,
  type HarnessId,
  type McpServer,
  type SessionPlace,
} from "@quench/history";
import { count, table } from "../format.ts";

const SHOWN = 12;

export type McpUse = {
  harness: HarnessId;
  server: string;
  sessions: number;
  calls: number;
  configured: boolean;
};

export type McpHealth = {
  harness: HarnessId;
  server: string;
  state: "unused" | "failing" | "needs login";
  sessions: number;
  code: string | null;
};

export function mcpUse(places: readonly SessionPlace[], configured: McpServer[]): McpUse[] {
  return harnesses
    .flatMap((harness) => {
      const names = new Set(
        configured.filter((s) => s.harness === harness.id).map((s) => normalize(s.name)),
      );
      const servers = new Map<string, McpUse>();
      for (const place of places) {
        if (place.harness !== harness.id) continue;
        for (const { server, calls } of place.mcp) {
          if (!calls) continue;
          const use =
            servers.get(server) ??
            servers
              .set(server, {
                harness: harness.id,
                server,
                sessions: 0,
                calls: 0,
                configured: names.has(normalize(server)),
              })
              .get(server)!;
          use.sessions++;
          use.calls += calls;
        }
      }
      return [...servers.values()];
    })
    .sort((a, b) => b.calls - a.calls || a.server.localeCompare(b.server));
}

export function mcpHealth(places: readonly SessionPlace[], configured: McpServer[]): McpHealth[] {
  const rows = new Map<string, McpHealth & { codes: Map<string, number> }>();
  const called = new Set<string>();
  const ran = new Set(places.map((p) => p.harness));
  const row = (harness: HarnessId, server: string, state: McpHealth["state"]) => {
    const key = `${harness}\0${normalize(server)}\0${state}`;
    return (
      rows.get(key) ??
      rows.set(key, { harness, server, state, sessions: 0, code: null, codes: new Map() }).get(key)!
    );
  };
  for (const place of places)
    for (const use of place.mcp) {
      if (use.calls) called.add(`${place.harness}\0${normalize(use.server)}`);
      if (use.failed !== undefined) {
        const failing = row(place.harness, use.server, "failing");
        failing.sessions++;
        if (use.failed) failing.codes.set(use.failed, (failing.codes.get(use.failed) ?? 0) + 1);
      }
      if (use.needsLogin) row(place.harness, use.server, "needs login").sessions++;
    }
  const seen = new Set([...rows.values()].map((r) => `${r.harness}\0${normalize(r.server)}`));
  for (const server of configured) {
    const key = `${server.harness}\0${normalize(server.name)}`;
    if (server.enabled !== true || !ran.has(server.harness) || called.has(key) || seen.has(key))
      continue;
    seen.add(key);
    row(server.harness, server.name, "unused");
  }
  const order = { failing: 0, "needs login": 1, unused: 2 };
  return [...rows.values()]
    .map(({ codes, ...r }) => ({
      ...r,
      code: [...codes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null,
    }))
    .sort(
      (a, b) =>
        order[a.state] - order[b.state] ||
        b.sessions - a.sessions ||
        a.server.localeCompare(b.server),
    );
}

export function renderMcpHealth(rows: McpHealth[], days: number): string[] {
  if (!rows.length) return [];
  return [
    "",
    heading(`MCP servers not working · unused, failing or waiting for login · last ${days} days`),
    ...table(
      [
        ["Server", "Agent", "State", "Sessions", "Error code"],
        ...rows.map((r) => [
          r.server,
          harnessById[r.harness].label,
          r.state,
          r.state === "unused" ? "—" : count(r.sessions),
          r.code ?? "",
        ]),
      ],
      [3],
    ),
    "  Unused: on in config, never called. Failing and needs login: as Claude Code recorded at session start.",
  ];
}

export const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "_");

export function renderMcpUse(uses: McpUse[], days: number): string[] {
  if (!uses.length) return [];
  const shown = uses.slice(0, SHOWN);
  const lines = [
    "",
    heading(`MCP servers called · from session history · last ${days} days`),
    ...table(
      [
        ["Server", "Agent", "Sessions", "Calls", "In local config"],
        ...shown.map((u) => [
          u.server,
          harnessById[u.harness].label,
          count(u.sessions),
          count(u.calls),
          u.configured ? "yes" : "no",
        ]),
      ],
      [2, 3],
    ),
  ];
  if (uses.length > shown.length) lines.push(`  … ${uses.length - shown.length} more in --json`);
  if (uses.some((u) => !u.configured))
    lines.push(
      "  Not in local config: an account connector (claude.ai, ChatGPT apps), a plugin, a server the host app passed in, or config since removed.",
    );
  return lines;
}
