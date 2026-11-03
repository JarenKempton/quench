import { harnesses } from "./harnesses/index.ts";
import type { Home } from "./home.ts";
import type { HarnessId } from "./model.ts";

export type ConfigFile = {
  path: string;
  scope: "user" | "project" | "local";
  kind: "mcp" | "settings" | "credentials" | "prompts";
};

export type RiskyPermission = {
  source: string;
  kind: "bypass" | "full-access" | "wildcard-shell" | "auto-approved-mcp";
  setting: string;
};

export async function harnessSettings(home: Home, project: string) {
  const configs: (ConfigFile & { harness: HarnessId })[] = [];
  const permissions: (RiskyPermission & { harness: HarnessId })[] = [];
  const warnings: string[] = [];
  for (const harness of harnesses) {
    const tag = <T>(found: T[]) => found.map((item) => ({ ...item, harness: harness.id }));
    const fail = (error: Error) => {
      warnings.push(`${harness.label}: ${error.message}`);
      return [];
    };
    configs.push(...tag(await harness.configs(home, project).catch(fail)));
    permissions.push(...tag(await harness.permissions(home, project).catch(fail)));
  }
  return { configs, permissions, warnings };
}

export const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
