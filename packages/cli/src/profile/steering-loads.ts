import { realpath } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { checkout, type SessionPlace, type SteeringFile } from "@quench/history";

export type RankedItem = {
  id: string;
  path: string;
  scope: "global" | "project";
  chars: number;
  sessions: number;
  loadedChars: number;
};

export type LoadCoverage = {
  sessions: number;
  unrecorded: number;
  combinedOnly: number;
};

export async function rankedItems(
  files: SteeringFile[],
  places: readonly SessionPlace[],
  project: string,
): Promise<{ items: RankedItem[]; coverage: LoadCoverage }> {
  const checkouts = new Map<string, ReturnType<typeof checkout>>();
  const checkoutOf = (dir: string) =>
    checkouts.get(dir) ?? checkouts.set(dir, checkout(dir)).get(dir)!;
  const keyOf = async (path: string) => {
    const repo = await checkoutOf(dirname(path));
    return repo ? `${repo.root}\0${relative(repo.top, path)}` : path;
  };
  const byKey = new Map<string, SteeringFile>();
  for (const file of files)
    for (const source of file.sources)
      for (const path of [source.path, source.realPath]) byKey.set(await keyOf(path), file);
  const root = (await checkoutOf(project))?.root ?? project;
  const loads = new Map<string, { sessions: number; chars: number }>();
  const coverage: LoadCoverage = {
    sessions: 0,
    unrecorded: 0,
    combinedOnly: 0,
  };
  for (const place of places) {
    if (!place.cwd || ((await checkoutOf(place.cwd))?.root ?? place.cwd) !== root) continue;
    coverage.sessions++;
    if (!place.instructions) {
      coverage.unrecorded++;
      continue;
    }
    if (place.instructions.every((r) => r.path === null)) coverage.combinedOnly++;
    const seen = new Set<string>();
    for (const record of place.instructions) {
      if (!record.path) continue;
      const file =
        byKey.get(await keyOf(record.path)) ??
        byKey.get(await keyOf(await realpath(record.path).catch(() => record.path!)));
      if (!file || seen.has(file.id)) continue;
      seen.add(file.id);
      const load = loads.get(file.id) ?? { sessions: 0, chars: 0 };
      loads.set(file.id, {
        sessions: load.sessions + 1,
        chars: load.chars + record.textChars,
      });
    }
  }
  const items = files.map((file) => {
    const load = loads.get(file.id) ?? { sessions: 0, chars: 0 };
    return {
      id: file.id,
      path: file.sources[0]!.path,
      scope: file.sources.some((s) => s.scope === "user")
        ? ("global" as const)
        : ("project" as const),
      chars: file.chars,
      sessions: load.sessions,
      loadedChars: load.chars,
    };
  });
  items.sort((a, b) => b.loadedChars - a.loadedChars || b.chars - a.chars);
  return { items, coverage };
}
