import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";

export async function filesWithExt(dir: string, ext: string, depth: number): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return depth > 0 ? filesWithExt(path, ext, depth - 1) : [];
      return entry.isFile() && entry.name.endsWith(ext) ? [path] : [];
    }),
  );
  return nested.flat().sort();
}

export async function modified(path: string): Promise<Date | null> {
  return stat(path)
    .then((s) => s.mtime)
    .catch(() => null);
}

export async function subdirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
}

export async function repositoryRoot(directory: string): Promise<string | null> {
  return (await checkout(directory))?.root ?? null;
}

export async function checkout(directory: string): Promise<{ top: string; root: string } | null> {
  for (let dir = directory; ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    const info = await stat(dotGit).catch(() => null);
    if (info?.isDirectory()) return { top: dir, root: dir };
    if (info?.isFile()) return { top: dir, root: (await commonRoot(dotGit)) ?? dir };
    if (dir === dirname(dir)) return null;
  }
}

async function commonRoot(dotGit: string): Promise<string | null> {
  const gitDir = /^gitdir: (.+)$/m.exec(await Bun.file(dotGit).text())?.[1]?.trim();
  if (!gitDir) return null;
  const linked = resolve(dirname(dotGit), gitDir);
  const common = await Bun.file(join(linked, "commondir"))
    .text()
    .then((text) => resolve(linked, text.trim()))
    .catch(() => null);
  if (!common) return null;
  return basename(common) === ".git" ? dirname(common) : common;
}

export const pathParts = (path: string) => path.split(/[\\/]/).filter(Boolean);

export const pathStyle = (path: string | null | undefined) =>
  path && /^([A-Za-z]:[\\/]|\\\\)/.test(path) ? win32 : posix;

export const isInside = (path: string, dir: string) =>
  path.startsWith(`${dir}/`) || path.startsWith(`${dir}\\`);
