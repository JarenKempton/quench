import {
  checkWorktrees,
  linkedWorktrees,
  projects,
  sessionPlaces,
  type Home,
  type WorktreeCheck,
} from "@quench/history";
import { placeCache } from "../cache.ts";
import { reading } from "../progress.ts";
import { json, plural, shortPath } from "../format.ts";

export async function worktrees(
  home: Home,
  options: { days: number; json: boolean; cache: boolean },
): Promise<number> {
  const since = new Date(Date.now() - options.days * 86_400_000);
  const cache = options.cache ? await placeCache(home.dir) : undefined;
  const { places } = await sessionPlaces(home, since, reading(), cache);
  await cache?.save();
  const found = await projects(places);
  const repositories = [];
  for (const project of found.projects.filter((p) => p.git)) {
    const linked = await linkedWorktrees(project.root);
    if (!linked?.length) continue;
    const checked = checkWorktrees(
      project.root,
      linked,
      project.directories.map((d) => d.path),
    );
    repositories.push({ root: project.root, ...checked });
  }
  const result = {
    observedAt: new Date().toISOString(),
    days: options.days,
    repositories,
    limitations: [
      `Idle means no session from Claude Code, Codex or Pi ran in the worktree in the last ${options.days} days; work done outside those agents is not seen.`,
      "Safe to remove means idle, not locked, no uncommitted or untracked changes, and its branch or commit is merged into the base branch or its upstream branch was deleted.",
      "`git worktree remove` keeps the branch but deletes ignored files in the worktree, such as .env files or build output.",
      "Nothing is removed by Quench.",
    ],
  };
  if (options.json) {
    process.stdout.write(json(result));
    return 0;
  }
  const short = (path: string) => shortPath(path, home.dir);
  const shell = (path: string) => {
    const shown = short(path);
    return /^[\w@%+=:,./~-]+$/.test(shown) ? shown : `'${path.replaceAll("'", `'\\''`)}'`;
  };
  const lines = [
    `Quench worktrees · idle means no session in the last ${options.days} days · nothing is removed`,
  ];
  if (!repositories.length)
    lines.push("", "No linked worktrees found in the repositories your sessions used.");
  for (const repo of repositories) {
    const list = repo.worktrees;
    const idle = list.filter((w) => !w.active && !w.missing);
    const removable = list.filter((w) => w.removable);
    const kept = idle.filter((w) => !w.removable);
    const missing = list.filter((w) => w.missing);
    lines.push(
      "",
      `${short(repo.root)} · ${plural(list.length, "linked worktree")} · ${count(list.length - idle.length - missing.length)} active · ${count(idle.length)} idle · base ${repo.base ?? "unknown"}`,
    );
    if (removable.length) {
      lines.push(`  Safe to remove (${count(removable.length)}):`);
      for (const w of removable)
        lines.push(`    git -C ${shell(repo.root)} worktree remove ${shell(w.path)}${label(w)}`);
    }
    if (kept.length) {
      lines.push(`  Idle but kept (${count(kept.length)}):`);
      for (const w of kept) lines.push(`    ${short(w.path)}${label(w)} · ${w.reasons.join(", ")}`);
    }
    if (missing.length)
      lines.push(
        `  Folders already gone (${count(missing.length)}): git -C ${shell(repo.root)} worktree prune`,
      );
  }
  lines.push("", ...result.limitations);
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

const count = (n: number) => n.toLocaleString("en-US");

const label = (w: WorktreeCheck) => (w.branch ? `   # ${w.branch}` : "   # detached");
