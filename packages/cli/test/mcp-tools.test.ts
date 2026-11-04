import { expect, test } from "bun:test";
import type { McpServer, McpToolLoad, SessionPlace } from "@quench/history";
import { mcpDuplicates } from "../src/profile/mcp-duplicates.ts";
import { mcpToolRecords } from "../src/profile/recorded-mcp-tools.ts";

const place = (at: string, mcp: McpToolLoad[]) =>
  ({
    harness: "claude-code",
    at: new Date(at),
    start: { tokens: null, parts: [], unrecorded: [], mcp },
  }) as unknown as SessionPlace;

const server = (name: string, scope: McpServer["scope"], endpoint: string): McpServer => ({
  harness: "claude-code",
  name,
  scope,
  source: "config",
  transport: "http",
  target: null,
  endpoint,
  enabled: true,
  launch: null,
});

test("a server's loading and schemas come from its newest recording, sessions from all", () => {
  const records = mcpToolRecords(
    [
      place("2026-10-01", [{ server: "docs", loading: "up front", tools: 3, chars: 900 }]),
      place("2026-10-05", [{ server: "docs", loading: "deferred", tools: 4, chars: null }]),
    ],
    [],
  );
  expect(records).toEqual([
    {
      harness: "claude-code",
      server: "docs",
      loading: "deferred",
      tools: 4,
      chars: null,
      sessions: 2,
      source: "deferred tool list",
    },
  ]);
});

test("a project server overrides the global one of the same name before duplicates are found", () => {
  const global = [server("docs", "user", "A")];
  const project = {
    name: "app",
    mcpServers: [server("docs", "project", "B"), server("other", "project", "A")],
  };
  expect(mcpDuplicates(global, [project])).toEqual([]);
  const copy = { name: "app", mcpServers: [server("other", "project", "A")] };
  expect(mcpDuplicates(global, [copy])).toEqual([
    {
      harness: "claude-code",
      servers: [
        { name: "docs", scope: "user" },
        { name: "other", scope: "project" },
      ],
      same: "url",
      where: "app",
    },
  ]);
});
