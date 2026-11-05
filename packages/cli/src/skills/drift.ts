import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { SkillName, treeHash, type HarnessId, type TreeHash } from "@quench/fleet";
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

export type Source = { skills: Map<string, TreeHash | null>; warnings: string[] };

export async function readSource(dir: string): Promise<Source> {
  const { folders, warnings } = await sourceSkills(dir);
  const root = await realpath(dir).catch((error) => {
    throw sourceError(error, "folder");
  });
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
  return { skills: source, warnings };
}

export function drift(
  { skills: source, warnings }: Source,
  records: readonly SkillRecord[],
): Drift {
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

const REGISTRY = "registry.yaml";

export class SourceError extends Error {}

const DISK_ERRORS = [
  [/is a symlink/, "input is a symlink"],
  [/is not a regular file or folder/, "input is not a regular file or folder"],
  [/is not a file$/, "input is not a file"],
  [/is not a folder$/, "input is not a folder"],
  [/has neither /, "not a skills repo"],
] as const;

function sourceError(error: unknown, file: string): SourceError {
  const issues = (error as { name?: unknown; issues?: unknown })?.issues;
  if (error instanceof Error && error.name === "ZodError" && Array.isArray(issues)) {
    const codes = new Map<string, number>();
    for (const { code } of issues as { code: unknown }[]) {
      const kind = typeof code === "string" && /^[a-z_]+$/.test(code) ? code : "other";
      codes.set(kind, (codes.get(kind) ?? 0) + 1);
    }
    const shown = [...codes].map(([code, n]) => `${code} ×${n}`).join(", ");
    return new SourceError(`invalid ${file} (${shown})`);
  }
  if (error instanceof SyntaxError) return new SourceError(`unparseable ${file}`);
  const code = (error as NodeJS.ErrnoException)?.code;
  if (typeof code === "string" && /^E[A-Z]+$/.test(code))
    return new SourceError(`unreadable input (${code})`);
  const message = error instanceof Error ? error.message : "";
  const read = /^cannot read .*: (E[A-Z]+)$/.exec(message)?.[1];
  if (read) return new SourceError(`unreadable input (${read})`);
  const known = DISK_ERRORS.find(([pattern]) => pattern.test(message))?.[1];
  return new SourceError(known ?? "source could not be read");
}

async function sourceSkills(dir: string) {
  const fleetFile = await Bun.file(join(dir, FLEET_FILE)).exists();
  const declared = fleetFile || (await Bun.file(join(dir, REGISTRY)).exists());
  const file = fleetFile ? FLEET_FILE : REGISTRY;
  if (!declared)
    return {
      folders: await skillFolders(dir, 3).catch((error) => {
        throw sourceError(error, "folder");
      }),
      warnings: [],
    };
  const { fleet, warnings } = await loadFleet(dir).catch((error) => {
    throw sourceError(error, file);
  });
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
    if ((await stat(join(path, "SKILL.md")).catch(() => null))?.isFile()) {
      if (SkillName.safeParse(entry.name).success) found.push([entry.name, path]);
    } else if (depth > 0) found.push(...(await skillFolders(path, depth - 1)));
  }
  return found;
}
