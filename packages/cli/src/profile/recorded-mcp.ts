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

const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "_");

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
