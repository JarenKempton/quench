import { mcpServerOf, type PromptTool } from "./model.ts";

export type McpToolLoad = {
  server: string;
  loading: "up front" | "deferred";
  tools: number;
  chars: number | null;
};

type Entry = { server: string; loading: McpToolLoad["loading"]; chars: number | null };

export function mcpToolLoads(tools: PromptTool[] | null, deferred: string[]): McpToolLoad[] {
  const shaped = new Set((tools ?? []).map((t) => t.name));
  const entries: Entry[] = [
    ...(tools ?? []).flatMap((t) =>
      t.server === null
        ? []
        : [
            {
              server: t.server,
              loading: t.deferred || deferred.includes(t.name) ? "deferred" : "up front",
              chars: t.chars,
            } as const,
          ],
    ),
    ...deferred.flatMap((name) => {
      const server = mcpServerOf(name);
      return server && !shaped.has(name)
        ? [{ server, loading: "deferred", chars: null } as const]
        : [];
    }),
  ];
  return [...Map.groupBy(entries, (e) => `${e.server}\0${e.loading}`).values()]
    .map((group) => ({
      server: group[0]!.server,
      loading: group[0]!.loading,
      tools: group.length,
      chars: group.some((e) => e.chars === null) ? null : group.reduce((n, e) => n + e.chars!, 0),
    }))
    .sort((a, b) => a.server.localeCompare(b.server) || a.loading.localeCompare(b.loading));
}
