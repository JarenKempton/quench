import { pathParts } from "./files.ts";
import { harnesses } from "./harnesses/index.ts";
import type { Home } from "./home.ts";
import type { HarnessId } from "./model.ts";

export type McpServer = {
  harness: HarnessId;
  name: string;
  scope: "user" | "local" | "project";
  source: string;
  transport: string;
  target: string | null;
  enabled: boolean | null;
};

export type McpEntry = Omit<McpServer, "harness">;

export async function mcpInventory(home: Home, project: string) {
  const servers: McpServer[] = [];
  const warnings: string[] = [];
  for (const harness of harnesses) {
    const found = await harness.mcp(home, project).catch((error: Error) => {
      warnings.push(`${harness.label}: ${error.message}`);
      return [];
    });
    servers.push(...found.map((server) => ({ ...server, harness: harness.id })));
  }
  return { servers, warnings };
}

export function describeServer(config: unknown): Pick<McpServer, "transport" | "target"> {
  const entry = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
  const url = typeof entry.url === "string" ? entry.url : null;
  const command = typeof entry.command === "string" ? entry.command : null;
  const type = typeof entry.type === "string" ? entry.type : null;
  if (url) return { transport: type ?? "http", target: host(url) };
  if (command) return { transport: type ?? "stdio", target: pathParts(command).at(-1) ?? null };
  return { transport: type ?? "unknown", target: null };
}

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

export async function readJson(path: string): Promise<Record<string, unknown> | null> {
  const text = await Bun.file(path)
    .text()
    .catch(() => null);
  if (text === null) return null;
  const parsed: unknown = JSON.parse(text);
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
}

export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
