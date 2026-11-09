import { stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

const GIT_TIMEOUT_MS = 10_000;
const NONE = "0".repeat(40);
const CHUNK = 200;

const OFF = [
  "log.showSignature=false",
  "gpg.program=false",
  "gpg.ssh.program=false",
  "gpg.x509.program=false",
  "core.fsmonitor=false",
  "core.pager=cat",
  "diff.external=",
  "core.hooksPath=/dev/null",
  "log.mailmap=false",
  "protocol.allow=never",
  "core.sshCommand=false",
].flatMap((setting) => ["-c", setting]);

const isolated = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_NO_LAZY_FETCH: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_LITERAL_PATHSPECS: "1",
  GIT_PAGER: "cat",
  PAGER: "cat",
});

export function git(dir: string, args: string[], input?: string): string | null {
  const result = Bun.spawnSync(
    ["git", "--no-optional-locks", "--no-pager", ...OFF, "-C", dir, ...args],
    {
      env: isolated(),
      stdin: input === undefined ? "ignore" : Buffer.from(input),
      stdout: "pipe",
      stderr: "ignore",
      timeout: GIT_TIMEOUT_MS,
    },
  );
  return result.success ? result.stdout.toString() : null;
}

export type Change = { at: number; blob: string; bytes: number | null };

type Commit = { at: number; parents: string[]; changed: Map<number, [string, string][]> };

type Tree = { key: string; entries: ReadonlyMap<string, string> };

const EMPTY: Tree = { key: "", entries: new Map() };

async function repositoryOf(dir: string): Promise<string | null> {
  const start = await stat(dir).catch(() => null);
  if (!start?.isDirectory()) return null;
  for (let at = dir; ; at = dirname(at)) {
    const here = await stat(at).catch(() => null);
    if (!here || here.dev !== start.dev) return null;
    const dot = await stat(join(at, ".git")).catch(() => null);
    if (
      dot?.isFile() ||
      (dot?.isDirectory() && (await stat(join(at, ".git", "HEAD")).catch(() => null)))
    )
      return at;
    if (dirname(at) === at) return null;
  }
}

function readLog(out: string, paths: readonly string[]) {
  const index = new Map(paths.map((p, i) => [p, i]));
  const owners = (path: string) => {
    const found: number[] = [];
    for (let at = path; ; at = at.slice(0, at.lastIndexOf("/"))) {
      const file = index.get(at);
      if (file !== undefined) found.push(file);
      if (!at.includes("/")) return found;
    }
  };
  const commits = new Map<string, Commit>();
  let head: string | null = null;
  let current: Commit | null = null;
  const tokens = out.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!.replace(/^\n/, "");
    if (token.startsWith(":")) {
      const path = tokens[++i]!;
      const blob = token.split(" ")[3]!;
      for (const file of current ? owners(path) : []) {
        const list = current!.changed.get(file) ?? [];
        list.push([path, blob]);
        current!.changed.set(file, list);
      }
    } else if (token) {
      const [hash, at, ...parents] = token.split(" ");
      current = { at: Number(at) * 1000, parents: parents.filter(Boolean), changed: new Map() };
      commits.set(hash!, current);
      head ??= hash!;
    }
  }
  return { head, commits };
}

function apply(tree: Tree, changes: readonly [string, string][]): Tree {
  const entries = new Map(tree.entries);
  for (const [path, blob] of changes)
    if (blob === NONE) entries.delete(path);
    else entries.set(path, blob);
  const key = [...entries]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, blob]) => `${path}\0${blob}`)
    .join("\0");
  return { key, entries };
}

function treesOf(commits: ReadonlyMap<string, Commit>) {
  const memo = new Map<string, readonly Tree[]>();
  return (hash: string): readonly Tree[] => {
    const chain: string[] = [];
    let at: string | undefined = hash;
    while (at !== undefined && !memo.has(at) && commits.has(at)) {
      chain.push(at);
      at = commits.get(at)!.parents[0];
    }
    let trees = (at !== undefined && memo.get(at)) || [];
    for (const id of chain.reverse()) {
      const changed = commits.get(id)!.changed;
      if (changed.size) {
        const next = [...trees];
        for (const [file, list] of changed) next[file] = apply(trees[file] ?? EMPTY, list);
        trees = next;
      }
      memo.set(id, trees);
    }
    return memo.get(hash) ?? [];
  };
}

function walk(
  file: number,
  head: string,
  commits: ReadonlyMap<string, Commit>,
  trees: ReturnType<typeof treesOf>,
): Change[] {
  const shown: Change[] = [];
  const seen = new Set([head]);
  const queue = [head];
  const key = (hash: string) => (trees(hash)[file] ?? EMPTY).key;
  while (queue.length) {
    const hash = queue.shift()!;
    const commit = commits.get(hash);
    if (!commit) continue;
    const mine = key(hash);
    let parents = commit.parents;
    let same = !parents.length && mine === "";
    for (const parent of parents)
      if (key(parent) === mine) {
        parents = [parent];
        same = true;
        break;
      }
    for (const parent of parents) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      const date = commits.get(parent)?.at ?? 0;
      const slot = queue.findIndex((q) => (commits.get(q)?.at ?? 0) < date);
      queue.splice(slot < 0 ? queue.length : slot, 0, parent);
    }
    const first = commit.changed.get(file)?.[0];
    if (!same && commit.parents.length < 2 && first)
      shown.push({ at: commit.at, blob: first[1], bytes: null });
  }
  return shown;
}

function chunkChanges(repo: string, tracked: readonly string[]): [string, Change[]][] {
  const paths = tracked.map((file) => relative(repo, file).split(sep).join("/"));
  const listed = paths.filter((p) => !/[\n\r]/.test(p));
  if (!listed.length) return [];
  const out = git(
    repo,
    [
      "log",
      "--stdin",
      "--full-history",
      "--sparse",
      "--no-renames",
      "--diff-merges=first-parent",
      "--no-show-signature",
      "--no-ext-diff",
      "--no-textconv",
      "--format=%H %ct %P",
      "--raw",
      "--no-abbrev",
      "-z",
    ],
    `--\n${listed.join("\n")}\n`,
  );
  if (!out) return [];
  const { head, commits } = readLog(out, paths);
  if (!head) return [];
  const trees = treesOf(commits);
  const walked = tracked.map((_, i) => walk(i, head, commits, trees));
  const wanted = new Set(walked.flat().map((c) => c.blob));
  wanted.delete(NONE);
  const sizes = new Map<string, number>();
  for (const line of (
    git(repo, ["cat-file", "--batch-check"], `${[...wanted].join("\n")}\n`) ?? ""
  ).split("\n")) {
    const [id, type, size] = line.split(" ");
    if (id && type === "blob") sizes.set(id, Number(size));
  }
  return tracked.map((file, i) => [
    file,
    walked[i]!.map((c) => ({ ...c, bytes: sizes.get(c.blob) ?? null })),
  ]);
}

export async function gitChanges(files: readonly string[]): Promise<Map<string, Change[]>> {
  const repos = new Map<string, string[]>();
  for (const file of new Set(files)) {
    const repo = await repositoryOf(dirname(file));
    if (repo)
      repos
        .set(repo, repos.get(repo) ?? [])
        .get(repo)!
        .push(file);
  }
  const found = new Map<string, Change[]>();
  for (const [repo, tracked] of repos)
    for (let at = 0; at < tracked.length; at += CHUNK)
      for (const [file, changes] of chunkChanges(repo, tracked.slice(at, at + CHUNK)))
        found.set(file, changes);
  return found;
}
