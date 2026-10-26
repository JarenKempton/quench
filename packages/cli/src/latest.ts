import { realpath } from "node:fs/promises";
import { sep } from "node:path";
import { discoverAll, harnessById, repositoryRoot, type Home } from "@quench/history";
import { ago, shortPath } from "./format.ts";

const CHECKED = 300;

export async function latestSessionIn(home: Home, folder: string): Promise<string | null> {
  const here = await realpath(folder).catch(() => folder);
  const repo = await repositoryRoot(here);
  const roots = new Map<string, Promise<string | null>>();
  const rootOf = (cwd: string) => roots.get(cwd) ?? roots.set(cwd, repositoryRoot(cwd)).get(cwd)!;
  const matches = async (cwd: string) =>
    cwd === here || cwd.startsWith(here + sep) || (repo !== null && (await rootOf(cwd)) === repo);
  const refs = (await discoverAll(home))
    .filter((r) => r.parent === null)
    .sort((a, b) => (b.modified?.getTime() ?? 0) - (a.modified?.getTime() ?? 0))
    .slice(0, CHECKED);
  for (const ref of refs) {
    const session = await harnessById[ref.harness].read(ref).catch(() => null);
    if (!session?.cwd || !(await matches(session.cwd))) continue;
    process.stderr.write(
      `Latest ${harnessById[ref.harness].label} session in ${repo ? "this repository" : "this folder"}, ${ago(ref.modified?.toISOString() ?? null)}: ${shortPath(ref.path, home.dir)}\n\n`,
    );
    return ref.path;
  }
  process.stderr.write(
    `No session found in ${shortPath(here, home.dir)} among the ${CHECKED} most recent; pass a session file.\n`,
  );
  return null;
}
