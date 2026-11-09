import { join } from "node:path";
import {
  modelFamily,
  modelNamesIn,
  modelVersion,
  type Home,
  type SessionPlace,
} from "@quench/history";
import { count, plural, shortPath, table } from "../format.ts";
import { heading } from "../style.ts";

export type PinnedModel = {
  model: string;
  files: string[];
  failed: number;
  newer: string | null;
};

const MAX_BYTES = 262144;

export function hostConfigFiles(home: Home, claudeHomes: readonly string[]): string[] {
  return [
    ...claudeHomes.flatMap((dir) => [join(dir, "settings.json"), join(dir, "settings.local.json")]),
    join(home.dir, ".codex/config.toml"),
    join(home.dir, ".pi/agent/settings.json"),
  ];
}

export async function pinnedModels(
  files: readonly string[],
  places: readonly SessionPlace[],
): Promise<PinnedModel[]> {
  const pinned = new Map<string, Set<string>>();
  for (const file of new Set(files)) {
    const blob = Bun.file(file);
    if ((await blob.exists().catch(() => false)) === false || blob.size > MAX_BYTES) continue;
    const text = await blob.text().catch(() => "");
    for (const model of modelNamesIn(text))
      (pinned.get(model) ?? pinned.set(model, new Set()).get(model)!).add(file);
  }
  const used = new Map<string, number>();
  const failed = new Map<string, number>();
  for (const place of places) {
    for (const model of place.models.used) used.set(model, (used.get(model) ?? 0) + 1);
    for (const model of place.models.unknown) failed.set(model, (failed.get(model) ?? 0) + 1);
  }
  return [...pinned]
    .flatMap(([model, where]) => {
      if (used.has(model)) return [];
      const version = modelVersion(model);
      const newer =
        version === null
          ? undefined
          : [...used]
              .filter(([m]) => modelFamily(m) === modelFamily(model))
              .filter(([m]) => (modelVersion(m) ?? 0) > version)
              .sort((a, b) => b[1] - a[1])[0]?.[0];
      const fails = failed.get(model) ?? 0;
      return fails || newer
        ? [{ model, files: [...where].sort(), failed: fails, newer: newer ?? null }]
        : [];
    })
    .sort((a, b) => b.failed - a.failed || a.model.localeCompare(b.model));
}

export const pinnedDetail = (p: PinnedModel) =>
  p.failed
    ? `failed as unknown model in ${plural(p.failed, "session")}`
    : `sessions used ${p.newer}`;

export function renderPinnedModels(rows: readonly PinnedModel[], homeDir: string): string[] {
  if (!rows.length) return [];
  return [
    "",
    heading("Pinned model names · in instructions, skills and host config on disk now"),
    ...table([
      ["Model", "Why", "Pinned in"],
      ...rows.map((p) => [
        p.model,
        pinnedDetail(p),
        p.files.map((f) => shortPath(f, homeDir)).join(", "),
      ]),
    ]),
    `  ${count(rows.length)} pinned ${rows.length === 1 ? "name" : "names"} no session used: older than a same-family model sessions used, or failed as unknown.`,
  ];
}
