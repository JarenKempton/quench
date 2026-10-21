import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

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
