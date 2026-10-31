import { chmod, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PlaceCache, SessionPlace } from "@quench/history";
import { compiled } from "./version.ts";

const FILE = ".quench/local/session-places.json";

type Entry = { stamp: string; place: SessionPlace };
type Stored = { v: 1; build: string; entries: Record<string, Entry> };

export async function placeCache(homeDir: string): Promise<PlaceCache & { save(): Promise<void> }> {
  const path = join(homeDir, FILE);
  const build = await buildStamp();
  const stored = (await Bun.file(path)
    .json()
    .catch(() => null)) as Stored | null;
  const entries = stored?.v === 1 && stored.build === build ? stored.entries : {};
  let changed = false;
  return {
    get(file, stamp) {
      const entry = entries[file];
      if (entry?.stamp !== stamp) return undefined;
      return { ...entry.place, at: entry.place.at && new Date(entry.place.at) };
    },
    set(file, stamp, place) {
      entries[file] = { stamp, place };
      changed = true;
    },
    async save() {
      if (!changed) return;
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}`;
      await Bun.write(temporary, JSON.stringify({ v: 1, build, entries } satisfies Stored));
      await chmod(temporary, 0o600);
      await rename(temporary, path);
    },
  };
}

async function buildStamp(): Promise<string> {
  if (compiled) {
    const info = await stat(process.execPath);
    return `binary:${info.size}:${info.mtimeMs}`;
  }
  const sources = join(import.meta.dir, "../..");
  let newest = 0;
  for await (const file of new Bun.Glob("*/src/**/*.ts").scan(sources))
    newest = Math.max(newest, (await stat(join(sources, file))).mtimeMs);
  return `source:${newest}`;
}
