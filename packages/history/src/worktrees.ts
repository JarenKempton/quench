import { realpath } from "node:fs/promises";

export type Worktree = {
  path: string;
  branch: string | null;
  head: string | null;
  locked: boolean;
  missing: boolean;
};

export type WorktreeCheck = Worktree & {
  active: boolean;
  dirty: boolean | null;
  merged: boolean | null;
  upstreamGone: boolean;
  removable: boolean;
  reasons: string[];
};

export async function linkedWorktrees(root: string): Promise<Worktree[] | null> {
  const list = git(root, "worktree", "list", "--porcelain", "-z");
  if (list === null) return null;
  const records: string[][] = [[]];
  for (const field of list.split("\0"))
    if (field) records.at(-1)!.push(field);
    else if (records.at(-1)!.length) records.push([]);
  const worktrees = records
    .filter((r) => r.length)
    .slice(1)
    .map((fields) => {
      const value = (key: string) =>
        fields.find((f) => f === key || f.startsWith(`${key} `))?.slice(key.length + 1) ?? null;
      return {
        path: value("worktree") ?? "",
        branch: value("branch")?.replace(/^refs\/heads\//, "") ?? null,
        head: value("HEAD"),
        locked: fields.some((f) => f === "locked" || f.startsWith("locked ")),
        missing: fields.some((f) => f === "prunable" || f.startsWith("prunable ")),
      };
    });
  return Promise.all(
    worktrees.map(async (w) => ({ ...w, path: await realpath(w.path).catch(() => w.path) })),
  );
}

export function checkWorktrees(
  root: string,
  worktrees: readonly Worktree[],
  activeDirectories: readonly string[],
): { base: string | null; worktrees: WorktreeCheck[] } {
  const base = baseRef(root);
  const merged = new Set(
    base
      ? lines(
          git(root, "for-each-ref", "--format=%(refname:short)", `--merged=${base}`, "refs/heads"),
        )
      : [],
  );
  const gone = new Set(
    lines(git(root, "for-each-ref", "--format=%(refname:short) %(upstream:track)", "refs/heads"))
      .filter((line) => line.endsWith(" [gone]"))
      .map((line) => line.slice(0, -" [gone]".length)),
  );
  return {
    base,
    worktrees: worktrees.map((w) => {
      const active = usedIn(w.path, activeDirectories);
      const status = w.missing || active ? null : git(w.path, "status", "--porcelain");
      const dirty = status === null ? null : status.trim().length > 0;
      const isMerged = !base
        ? null
        : w.branch
          ? merged.has(w.branch)
          : w.head
            ? git(root, "merge-base", "--is-ancestor", w.head, base) !== null
            : null;
      const upstreamGone = w.branch !== null && gone.has(w.branch);
      const reasons = [
        ...(w.missing ? ["directory no longer exists"] : []),
        ...(active ? ["sessions ran here recently"] : []),
        ...(w.locked ? ["locked"] : []),
        ...(!w.missing && !active && dirty === null ? ["status unknown"] : []),
        ...(dirty ? ["uncommitted or untracked changes"] : []),
        ...(isMerged === null && !upstreamGone
          ? ["merge state unknown"]
          : isMerged === false && !upstreamGone
            ? [w.branch ? `branch not merged into ${base}` : `commit not on ${base}`]
            : []),
      ];
      return {
        ...w,
        active,
        dirty,
        merged: isMerged,
        upstreamGone,
        removable: !reasons.length,
        reasons,
      };
    }),
  };
}

export const usedIn = (path: string, directories: readonly string[]) =>
  directories.some((d) => d === path || d.startsWith(`${path}/`));

function baseRef(root: string): string | null {
  const remote = git(
    root,
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  )?.trim();
  if (remote) return remote;
  for (const name of ["main", "master"])
    if (git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`) !== null) return name;
  return null;
}

function git(cwd: string, ...args: string[]): string | null {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
  return result.success ? result.stdout.toString() : null;
}

const lines = (text: string | null) => (text ?? "").split("\n").filter(Boolean);
