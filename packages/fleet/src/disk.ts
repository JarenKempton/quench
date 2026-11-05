import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import type { BundleManifest } from "./bundle.ts";
import { own } from "./common.ts";
import { byPlacement, cmp, FleetFile, resolve } from "./fleet.ts";
import { importSkillsRepo, type SkillsRepo } from "./import.ts";
import { excluded, sha256, sortedEntries, treeHash, type TreeEntry } from "./tree-hash.ts";

export const FLEET_FILE = "quench-fleet.yaml";

export async function readTree(dir: string): Promise<TreeEntry[]> {
  const root = await realpath(dir);
  const entries: TreeEntry[] = [];
  const walk = async (rel: string) => {
    for (const name of await readdir(join(root, rel))) {
      const path = rel ? `${rel}/${name}` : name;
      if (excluded(path)) continue;
      const full = join(root, path);
      const info = await lstat(full);
      if (info.isDirectory()) await walk(path);
      else if (info.isSymbolicLink())
        entries.push({
          path,
          mode: "120000",
          bytes: await readlink(full, { encoding: "buffer" }),
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
  const tree = await readTree(dir);
  return {
    treeHash: treeHash(tree),
    symlink: info.isSymbolicLink(),
    executables:
      process.platform === "win32"
        ? null
        : tree
            .filter((e) => e.mode === "100755")
            .map((e) => e.path)
            .sort(),
  };
}

const absent = (error: NodeJS.ErrnoException) => error.code === "ENOENT";

const failed = (path: string) => (error: NodeJS.ErrnoException) => {
  throw new Error(`cannot read ${path}: ${error.code ?? error.message}`);
};

const plain = (
  path: string,
  info: { isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean },
) => {
  if (info.isSymbolicLink())
    throw new Error(`${path} is a symlink; the importer does not follow links in its input`);
  if (!info.isFile() && !info.isDirectory())
    throw new Error(`${path} is not a regular file or folder`);
};

const kind = async (path: string) => {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) =>
    absent(error) ? null : failed(path)(error),
  );
  if (info) plain(path, info);
  return info;
};

async function text(path: string) {
  const info = await kind(path);
  if (!info) return null;
  if (!info.isFile()) throw new Error(`${path} is not a file`);
  return readFile(path, "utf8").catch(failed(path));
}

async function folder(dir: string) {
  const info = await kind(dir);
  if (!info) return [];
  if (!info.isDirectory()) throw new Error(`${dir} is not a folder`);
  const entries = await readdir(dir, { withFileTypes: true }).catch(failed(dir));
  for (const entry of entries) plain(join(dir, entry.name), entry);
  return entries.sort((a, b) => cmp(a.name, b.name));
}

export const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel.split(/[\\/]/)[0] !== "..");
};

async function manifests(dir: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const entry of (await folder(dir)).filter((e) => e.name.endsWith(".manifest"))) {
    const path = join(dir, entry.name);
    if (!entry.isFile()) throw new Error(`${path} is not a file`);
    found[basename(entry.name, ".manifest")] = await readFile(path, "utf8").catch(failed(path));
  }
  return found;
}

export async function readSkillsRepo(dir: string): Promise<SkillsRepo | null> {
  const registry = await text(join(dir, "registry.yaml"));
  if (registry === null) return null;
  const overridesDir = join(dir, "hosts", "overrides");
  const overrides: SkillsRepo["overrides"] = {};
  const hosts = await manifests(join(dir, "hosts"));
  for (const entry of (await folder(overridesDir)).filter((e) => e.isDirectory()))
    overrides[entry.name] = await manifests(join(overridesDir, entry.name));
  const refs = new Set<string>();
  for (const entry of Object.values(
    (Bun.YAML.parse(registry) as { skills?: Record<string, { path?: unknown }> })?.skills ?? {},
  ))
    if (typeof entry?.path === "string") refs.add(entry.path);
  for (const text of [...Object.values(hosts), ...Object.values(overrides).flatMap(Object.values)])
    for (const line of text.split(/\r?\n/)) {
      const ref = line.trim().replace(/^[+-]/, "").trim();
      if (ref.includes("/") && !ref.startsWith("#")) refs.add(ref);
    }
  const root = await realpath(dir);
  const folders: Record<string, string> = {};
  for (const ref of [...refs].sort(cmp)) {
    const real = await realpath(join(dir, ...ref.split("/"))).catch(() => null);
    if (real && inside(root, real)) folders[ref] = real;
  }
  return { registry, manifests: hosts, overrides, folders };
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
  const bundle: BundleManifest = {
    version: 1,
    machine,
    revision,
    skills: {},
    placements: [],
    unavailable: [],
  };
  const { placements, denied } = resolve(fleet, machine);
  for (const d of denied) warnings.push(`${d.skill} (${d.harness}): ${d.reason}`);
  const root = await realpath(dir);
  const failures = new Map<string, string>();
  for (const placement of placements.sort(byPlacement)) {
    const source = own(fleet.skills, placement.skill)!.path;
    if (!own(bundle.skills, placement.skill) && !failures.has(placement.skill)) {
      const real = await realpath(join(dir, ...source.split("/"))).catch(() => null);
      const tree =
        real && !inside(root, real)
          ? `${source} resolves outside the source repo, rejected`
          : await readTree(join(dir, ...source.split("/"))).then(
              (t) => (t.some((e) => e.path === "SKILL.md") ? t : `no SKILL.md at ${source}`),
              (error: Error) => `cannot read ${source}: ${error.message.split(",")[0]}`,
            );
      if (typeof tree === "string") {
        failures.set(placement.skill, tree);
        warnings.push(`${placement.skill}: ${tree}`);
      } else
        bundle.skills[placement.skill] = {
          treeHash: treeHash(tree),
          files: tree.map((e) => ({
            path: e.path,
            mode: e.mode,
            size: e.bytes.length,
            sha256: sha256(e.bytes),
          })),
        };
    }
    const failure = failures.get(placement.skill);
    const skill = own(bundle.skills, placement.skill);
    if (failure) bundle.unavailable.push({ ...placement, reason: failure });
    else if (skill) bundle.placements.push({ ...placement, treeHash: skill.treeHash });
  }
  return { bundle, warnings };
}
