import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  mcpInventory,
  skillSourceInventory,
  type Ecosystem,
  type HarnessId,
  type Home,
} from "@quench/history";
import type { Masker } from "./mask.ts";
import { unpinned } from "./pins.ts";
import { findingId } from "./secret.ts";

export type UnpinnedSource = {
  id: string;
  harness: HarnessId;
  kind: "mcp" | "marketplace" | "plugin" | "package";
  name: string;
  spec: string;
  reason: string;
  pinTo: string;
  source: string;
};

type Candidate = Omit<UnpinnedSource, "id" | "reason" | "pinTo"> & { ecosystem: Ecosystem };

export async function unpinnedSources(home: Home, projects: readonly string[], mask: Masker) {
  const candidates = new Map<string, Candidate>();
  const warnings: string[] = [];
  for (const project of [home.dir, ...projects]) {
    const mcp = await mcpInventory(home, project);
    const skills = await skillSourceInventory(home, project);
    warnings.push(...mcp.warnings, ...skills.warnings);
    for (const server of mcp.servers)
      if (server.launch)
        candidates.set(`${server.harness}\n${server.source}\nmcp\n${server.name}`, {
          harness: server.harness,
          kind: "mcp",
          name: server.name,
          spec: server.launch.spec,
          ecosystem: server.launch.ecosystem,
          source: server.source,
        });
    for (const skill of skills.sources)
      candidates.set(`${skill.harness}\n${skill.source}\n${skill.kind}\n${skill.name}`, skill);
  }
  const cached = npxCache(home.dir);
  const found: UnpinnedSource[] = [];
  for (const { ecosystem, ...candidate } of candidates.values()) {
    const installed = ecosystem === "npm" ? await cached(packageName(candidate.spec)) : null;
    const pin = unpinned(ecosystem, candidate.spec, installed);
    const id = findingId(
      mask,
      "unpinned",
      candidate.harness,
      candidate.source,
      candidate.kind,
      candidate.name,
    );
    if (pin) found.push({ id, ...candidate, ...pin });
  }
  const order = (s: UnpinnedSource) => `${s.harness}\n${s.kind}\n${s.name}`;
  return {
    found: found.sort((a, b) => order(a).localeCompare(order(b))),
    warnings: [...new Set(warnings)],
  };
}

const packageName = (spec: string) => {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
};

function npxCache(homeDir: string) {
  const root = join(homeDir, ".npm/_npx");
  const dirs = readdir(root).catch(() => []);
  return async (name: string): Promise<string | null> => {
    for (const dir of await dirs) {
      const manifest = await Bun.file(join(root, dir, "node_modules", name, "package.json"))
        .json()
        .catch(() => null);
      if (typeof manifest?.version === "string") return manifest.version;
    }
    return null;
  };
}
