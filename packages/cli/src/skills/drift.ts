import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { treeHash, type HarnessId, type TreeHash } from "@quench/fleet";
import { FLEET_FILE, inside, loadFleet, readTree } from "@quench/fleet/disk";
import type { SkillRecord } from "./records.ts";

type Installed = { skill: string; harness: HarnessId; location: string };

export type Drift = {
  inSourceNotInstalled: { skill: string; contentVersion: TreeHash | null }[];
  installedNotInSource: (Installed & { contentVersion: TreeHash | null })[];
  contentDiffers: (Installed & { installed: TreeHash; source: TreeHash })[];
  notCompared: Installed[];
  warnings: { kind: WarningKind; count: number }[];
};

const WARNINGS = [
  ["not-substituted", /: registry has .* at .*, not substituted$/],
  ["not-in-registry", /: not in registry\.yaml, imported as /],
  ["unsupported-host", /\.manifest: no supported harness, skipped$/],
  ["imported-as-global", /\.manifest: imported as global$/],
  ["ignored-line", /\.manifest: ignored "/],
] as const;

type WarningKind = (typeof WARNINGS)[number][0] | "other";

function warningKinds(warnings: readonly string[]): Drift["warnings"] {
  const counts = new Map<WarningKind, number>();
  for (const warning of warnings) {
    const kind = WARNINGS.find(([, pattern]) => pattern.test(warning))?.[0] ?? "other";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts].map(([kind, count]) => ({ kind, count }));
}

export async function drift(dir: string, records: readonly SkillRecord[]): Promise<Drift> {
  const { folders, warnings } = await sourceSkills(dir);
  const root = await realpath(dir);
  const source = new Map<string, TreeHash | null>();
  for (const [skill, path] of folders) {
    const real = await realpath(path).catch(() => null);
    source.set(
      skill,
      real && inside(root, real)
        ? await readTree(real).then(
            (tree) => (tree.some((e) => e.path === "SKILL.md") ? treeHash(tree) : null),
            () => null,
          )
        : null,
    );
  }
  const installed = records.filter((r) => r.origin === "user" && r.location !== "unknown");
  const result: Drift = {
    inSourceNotInstalled: [...source]
      .filter(([skill]) => !installed.some((r) => r.skill === skill))
      .map(([skill, contentVersion]) => ({ skill, contentVersion })),
    installedNotInSource: [],
    contentDiffers: [],
    notCompared: [],
    warnings: warningKinds(warnings),
  };
  for (const r of installed) {
    const at = { skill: r.skill, harness: r.harness, location: r.location };
    if (!source.has(r.skill))
      result.installedNotInSource.push({ ...at, contentVersion: r.contentVersion });
    else if (!r.contentVersion || !source.get(r.skill)) result.notCompared.push(at);
    else if (r.contentVersion !== source.get(r.skill))
      result.contentDiffers.push({
        ...at,
        installed: r.contentVersion,
        source: source.get(r.skill)!,
      });
  }
  return result;
}

async function sourceSkills(dir: string) {
  const declared =
    (await Bun.file(join(dir, FLEET_FILE)).exists()) ||
    (await Bun.file(join(dir, "registry.yaml")).exists());
  if (!declared) return { folders: await skillFolders(dir, 3), warnings: [] };
  const { fleet, warnings } = await loadFleet(dir);
  return {
    folders: Object.entries(fleet.skills).map(
      ([skill, { path }]) => [skill, join(dir, ...path.split("/"))] as const,
    ),
    warnings,
  };
}

async function skillFolders(dir: string, depth: number): Promise<(readonly [string, string])[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: (readonly [string, string])[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules")
      continue;
    const path = join(dir, entry.name);
    if ((await stat(join(path, "SKILL.md")).catch(() => null))?.isFile())
      found.push([entry.name, path]);
    else if (depth > 0) found.push(...(await skillFolders(path, depth - 1)));
  }
  return found;
}
