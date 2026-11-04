import type { HarnessId, McpServer } from "@quench/history";

export type McpDuplicate = {
  harness: HarnessId;
  servers: { name: string; scope: McpServer["scope"] }[];
  same: "command" | "url";
  where: string;
};

export function mcpDuplicates(
  global: readonly McpServer[],
  projects: readonly { name: string; mcpServers: readonly McpServer[] }[],
): McpDuplicate[] {
  return [
    ...duplicatesIn(global, "all projects", () => true),
    ...projects.flatMap((p) =>
      duplicatesIn(
        [...global.filter((g) => !overridden(g, p.mcpServers)), ...p.mcpServers],
        p.name,
        (group) => group.some((s) => s.scope !== "user"),
      ),
    ),
  ];
}

const overridden = (server: McpServer, local: readonly McpServer[]) =>
  local.some((s) => s.harness === server.harness && s.name === server.name);

function duplicatesIn(
  servers: readonly McpServer[],
  where: string,
  keep: (group: McpServer[]) => boolean,
): McpDuplicate[] {
  const groups = Map.groupBy(
    servers.filter((s) => s.endpoint !== null),
    (s) => `${s.harness}\0${s.endpoint}`,
  );
  return [...groups.values()]
    .filter((group) => group.length > 1 && keep(group))
    .map((group) => ({
      harness: group[0]!.harness,
      servers: group.map((s) => ({ name: s.name, scope: s.scope })),
      same: group[0]!.transport === "stdio" ? "command" : "url",
      where,
    }));
}
