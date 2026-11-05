import { realpath } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { checkout, type SessionPlace, type SteeringFile } from "@quench/history";
import { fileLocations, fold } from "./steering-findings.ts";

export type RankedItem = {
  id: string;
  path: string;
  scope: "global" | "project";
  chars: number;
  sessions: number;
  loadedChars: number;
};

export type LoadCoverage = { sessions: number; unrecorded: number; combinedOnly: number };

export async function rankedItems(
  files: SteeringFile[],
  places: readonly SessionPlace[],
  project: string,
): Promise<{ items: RankedItem[]; coverage: LoadCoverage; here: SessionPlace[] }> {
  const checkouts = new Map<string, ReturnType<typeof checkout>>();
  const checkoutOf = (dir: string) =>
    checkouts.get(dir) ?? checkouts.set(dir, checkout(dir)).get(dir)!;
  const keyOf = async (path: string) => {
    const repo = await checkoutOf(dirname(path));
    return fold(repo ? `${repo.root}\0${relative(repo.top, path)}` : path);
  };
  const rootOf = async (dir: string) => {
    const real = await realpath(dir).catch(() => dir);
    return fold((await checkoutOf(real))?.root ?? real);
  };
  const located = files.flatMap((file) =>
    fileLocations(file).map((location) => ({ ...location, file, id: fold(location.realPath) })),
  );
  const byKey = new Map<string, (typeof located)[number]>();
  for (const location of located)
    for (const source of location.file.sources.filter((s) => fold(s.realPath) === location.id))
      for (const path of [source.path, source.realPath]) byKey.set(await keyOf(path), location);
  const root = await rootOf(project);
  const loads = new Map<string, { sessions: number; chars: number }>();
  const coverage: LoadCoverage = { sessions: 0, unrecorded: 0, combinedOnly: 0 };
  const here: SessionPlace[] = [];
  for (const place of places) {
    if (!place.cwd || (await rootOf(place.cwd)) !== root) continue;
    here.push(place);
    coverage.sessions++;
    if (!place.instructions) {
      coverage.unrecorded++;
      continue;
    }
    if (place.instructions.length && place.instructions.every((r) => r.path === null))
      coverage.combinedOnly++;
    const records = new Set<string>();
    const counted = new Set<string>();
    for (const record of place.instructions) {
      if (!record.path) continue;
      const key = await keyOf(record.path);
      const location =
        byKey.get(key) ??
        byKey.get(await keyOf(await realpath(record.path).catch(() => record.path!)));
      const identity = `${key}\0${record.label ?? ""}`;
      if (!location || records.has(identity)) continue;
      records.add(identity);
      const load = loads.get(location.id) ?? { sessions: 0, chars: 0 };
      loads.set(location.id, {
        sessions: load.sessions + (counted.has(location.id) ? 0 : 1),
        chars: load.chars + record.textChars,
      });
      counted.add(location.id);
    }
  }
  const items = located.map((location) => {
    const load = loads.get(location.id) ?? { sessions: 0, chars: 0 };
    return {
      id: location.file.id,
      path: location.path,
      scope: location.global ? ("global" as const) : ("project" as const),
      chars: location.file.chars,
      sessions: load.sessions,
      loadedChars: load.chars,
    };
  });
  items.sort((a, b) => b.loadedChars - a.loadedChars || b.chars - a.chars);
  return { items, coverage, here };
}
