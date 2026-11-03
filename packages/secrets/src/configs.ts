import { basename, dirname } from "node:path";
import {
  harnessSettings,
  type ConfigFile,
  type HarnessId,
  type Home,
  type RiskyPermission,
} from "@quench/history";
import { detect, detectInFile } from "./detect.ts";
import { secretOf, textOf, tracked, type Secret } from "./secret.ts";

export type FileSecrets = {
  path: string;
  harness: HarnessId | null;
  kind: string;
  scope: string | null;
  tracked: boolean | null;
  secrets: Secret[];
};

export async function scanConfigs(home: Home, projects: readonly string[]) {
  const seen = new Set<string>();
  const files: FileSecrets[] = [];
  const permissions = new Map<string, RiskyPermission & { harness: HarnessId }>();
  const credentials: (ConfigFile & { harness: HarnessId })[] = [];
  const warnings: string[] = [];
  for (const project of [home.dir, ...projects]) {
    const found = await harnessSettings(home, project);
    warnings.push(...found.warnings);
    for (const risk of found.permissions) permissions.set(`${risk.source}\n${risk.setting}`, risk);
    for (const config of found.configs) {
      if (seen.has(config.path)) continue;
      seen.add(config.path);
      if (config.kind === "credentials") {
        credentials.push(config);
        continue;
      }
      const text = await textOf(config.path);
      if (text === null) continue;
      const secrets = (config.kind === "prompts" ? detect(text) : detectInFile(text)).map(secretOf);
      if (!secrets.length) continue;
      files.push({
        path: config.path,
        harness: config.harness,
        kind: config.kind,
        scope: config.scope,
        tracked:
          basename(config.path) === ".mcp.json"
            ? await tracked(basename(config.path), dirname(config.path))
            : null,
        secrets,
      });
    }
  }
  return { files, permissions: [...permissions.values()], credentials, warnings };
}
