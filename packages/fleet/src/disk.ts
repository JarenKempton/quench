import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import type { BundleManifest } from "./bundle.ts";
import { byPlacement, cmp, FleetFile, resolve } from "./fleet.ts";
import { importSkillsRepo, type SkillsRepo } from "./import.ts";
import {
  canonicalPath,
  excluded,
  sha256,
  sortedEntries,
  treeHash,
  type TreeEntry,
} from "./tree-hash.ts";

export const FLEET_FILE = "quench-fleet.yaml";

export async function readTree(dir: string): Promise<TreeEntry[]> {
  const root = await realpath(dir);
  const entries: TreeEntry[] = [];
  const walk = async (rel: string) => {
    for (const name of await readdir(join(root, rel))) {
      const path = rel ? `${rel}/${name}` : name;
      if (excluded(canonicalPath(path))) continue;
      const full = join(root, path);
      const info = await lstat(full);
      if (info.isDirectory()) await walk(path);
      else if (info.isSymbolicLink())
        entries.push({
          path,
          mode: "120000",
          bytes: new TextEncoder().encode(canonicalPath(await readlink(full))),
        });
      else if (info.isFile())
        entries.push({
          path,
          mode: process.platform !== "win32" && info.mode & 0o111 ? "100755" : "100644",
          bytes: await readFile(full),
        });
      else throw new Error(`${full}: not a file, folder or symlink`);
    }
  };
  await walk("");
  return sortedEntries(entries);
}

export async function installedTree(dir: string) {
  const info = await lstat(dir).catch(() => null);
  if (!info) return undefined;
  return { treeHash: treeHash(await readTree(dir)), symlink: info.isSymbolicLink() };
}

const text = (path: string) => readFile(path, "utf8").catch(() => null);

async function manifests(dir: string): Promise<Record<string, string>> {
  const names = (await readdir(dir).catch(() => []))
    .filter((n) => n.endsWith(".manifest"))
    .sort(cmp);
  const found: Record<string, string> = {};
  for (const name of names)
    found[basename(name, ".manifest")] = (await text(join(dir, name))) ?? "";
  return found;
}

export async function readSkillsRepo(dir: string): Promise<SkillsRepo | null> {
  const registry = await text(join(dir, "registry.yaml"));
  if (registry === null) return null;
  const overridesDir = join(dir, "hosts", "overrides");
  const overrides: SkillsRepo["overrides"] = {};
  const entries = await readdir(overridesDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => cmp(a.name, b.name)))
    overrides[entry.name] = await manifests(join(overridesDir, entry.name));
  return { registry, manifests: await manifests(join(dir, "hosts")), overrides };
}

export async function loadFleet(dir: string): Promise<{ fleet: FleetFile; warnings: string[] }> {
  const own = await text(join(dir, FLEET_FILE));
  if (own !== null) return { fleet: FleetFile.parse(Bun.YAML.parse(own)), warnings: [] };
  const repo = await readSkillsRepo(dir);
  if (!repo) throw new Error(`${dir} has neither ${FLEET_FILE} nor registry.yaml`);
  return importSkillsRepo(repo);
}

export async function buildBundle(
  dir: string,
  fleet: FleetFile,
  machine: string,
  revision: string | null = null,
) {
  const warnings: string[] = [];
  const bundle: BundleManifest = { version: 1, machine, revision, skills: {}, placements: [] };
  const hashes = new Map<string, string | null>();
  for (const placement of resolve(fleet, machine).sort(byPlacement)) {
    if (!hashes.has(placement.skill)) {
      const path = join(dir, ...fleet.skills[placement.skill]!.path.split("/"));
      const tree = await readTree(path).catch(() => null);
      if (!tree?.some((e) => e.path === "SKILL.md")) {
        warnings.push(
          `${placement.skill}: no SKILL.md at ${fleet.skills[placement.skill]!.path}, skipped`,
        );
        hashes.set(placement.skill, null);
        continue;
      }
      const hash = treeHash(tree);
      hashes.set(placement.skill, hash);
      bundle.skills[hash] = {
        name: placement.skill,
        files: tree.map((e) => ({
          path: e.path,
          mode: e.mode,
          size: e.bytes.length,
          sha256: sha256(e.bytes),
        })),
      };
    }
    const hash = hashes.get(placement.skill);
    if (hash) bundle.placements.push({ ...placement, treeHash: hash });
  }
  return { bundle, warnings };
}
