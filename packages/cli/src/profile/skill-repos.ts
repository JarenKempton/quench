import { dirname, relative } from "node:path";
import { checkout } from "@quench/history";

export type RepoPath = { root: string; path: string };

const BATCH = 16;

export async function trackedInRepo(folders: Iterable<string>): Promise<Map<string, RepoPath>> {
  const byTop = new Map<string, { root: string; rels: Map<string, string> }>();
  for (const folder of new Set(folders)) {
    const repo = await checkout(dirname(folder));
    if (!repo) continue;
    const rel = relative(repo.top, folder).replaceAll("\\", "/");
    const top =
      byTop.get(repo.top) ??
      byTop.set(repo.top, { root: repo.root, rels: new Map() }).get(repo.top)!;
    top.rels.set(rel, folder);
  }
  const found = new Map<string, RepoPath>();
  const tops = [...byTop];
  for (let i = 0; i < tops.length; i += BATCH)
    await Promise.all(
      tops.slice(i, i + BATCH).map(async ([top, { root, rels }]) => {
        const entries = [...rels.keys()].flatMap((rel) => [rel, `${rel}/SKILL.md`]);
        const tracked = new Set(await trackedFiles(top, entries));
        for (const [rel, folder] of rels)
          if (tracked.has(rel) || tracked.has(`${rel}/SKILL.md`))
            found.set(folder, { root, path: rel });
      }),
    );
  return found;
}

async function trackedFiles(top: string, paths: string[]): Promise<string[]> {
  const proc = Bun.spawn(
    ["git", "--literal-pathspecs", "-C", top, "ls-files", "-z", "--", ...paths],
    {
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 ? out.split("\0").filter(Boolean) : [];
}
