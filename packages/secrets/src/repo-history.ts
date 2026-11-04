import type { Progress } from "@quench/history";
import { detectInFile } from "./detect.ts";
import type { Masker } from "./mask.ts";
import { allowedPath } from "./rules.ts";
import { secretOf, type Secret } from "./secret.ts";

export type RepoSecret = Secret & {
  repos: string[];
  files: string[];
  versions: number;
  introducedIn: string | null;
  introducedAt: string | null;
};

type Blob = { paths: Set<string>; commit: string | null; at: number };

type Found = RepoSecret & { repoSet: Set<string>; fileSet: Set<string>; first: number };

const BINARY_PROBE = 8000;
const MAX_BYTES = 10 * 1024 * 1024;
const COMMIT = "\u0001";
const NO_BLOB = /^0+$/;

export async function scanRepoHistory(
  projects: readonly string[],
  mask: Masker,
  onRead?: Progress,
) {
  const found = new Map<string, Found>();
  const totals = { commits: 0, blobs: 0, binary: 0, oversize: 0 };
  let failed = 0;
  let done = 0;
  for (const repo of projects) {
    const scanned = await scanRepo(repo, (blob, text) => {
      const paths = [...blob.paths].sort();
      const path = paths.find((p) => !allowedPath(p)) ?? paths[0]!;
      for (const detection of detectInFile(text, path)) {
        const id = mask.id(detection.value);
        const known = found.get(id) ?? {
          ...secretOf(detection, mask, "repo-history"),
          repos: [],
          files: [],
          versions: 0,
          introducedIn: null,
          introducedAt: null,
          first: Infinity,
          repoSet: new Set<string>(),
          fileSet: new Set<string>(),
        };
        found.set(id, known);
        known.versions++;
        known.repoSet.add(repo);
        for (const p of paths) known.fileSet.add(p);
        if (blob.commit && blob.at < known.first) {
          known.first = blob.at;
          known.introducedIn = blob.commit.slice(0, 12);
          known.introducedAt = new Date(blob.at * 1000).toISOString();
        }
      }
    }).catch(() => null);
    if (scanned)
      for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += scanned[key];
    else failed++;
    onRead?.(++done, projects.length);
  }
  const listed = [...found.values()].map(({ repoSet, fileSet, first: _, ...secret }) => ({
    ...secret,
    repos: [...repoSet].sort(),
    files: [...fileSet].sort(),
  }));
  listed.sort((a, b) => b.versions - a.versions || a.provider.localeCompare(b.provider));
  return {
    repos: projects.length - failed,
    failed,
    commits: totals.commits,
    blobs: totals.blobs,
    skipped: { binary: totals.binary, oversize: totals.oversize },
    secrets: listed.filter((s) => s.confidence === "high"),
    lowConfidence: listed.filter((s) => s.confidence === "low"),
  };
}

async function scanRepo(repo: string, onBlob: (blob: Blob, text: string) => void) {
  const blobs = await blobsOf(repo);
  const scannable = new Map(
    [...blobs].filter(([, blob]) => [...blob.paths].some((path) => !allowedPath(path))),
  );
  const checked = await git(
    repo,
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    [...scannable.keys()].join("\n"),
  );
  const shas: string[] = [];
  let oversize = 0;
  let binary = 0;
  for (const line of checked.split("\n")) {
    const [sha, type, size] = line.split(" ");
    if (type !== "blob") continue;
    if (Number(size) > MAX_BYTES) oversize++;
    else shas.push(sha!);
  }
  const decoder = new TextDecoder();
  await catFile(repo, shas, (sha, bytes) => {
    if (bytes.subarray(0, BINARY_PROBE).includes(0)) binary++;
    else onBlob(scannable.get(sha)!, decoder.decode(bytes));
  });
  const commits = Number(await git(repo, ["rev-list", "--all", "--count"]));
  return { commits, blobs: shas.length - binary, binary, oversize };
}

async function blobsOf(repo: string): Promise<Map<string, Blob>> {
  const blobs = new Map<string, Blob>();
  const add = (sha: string, path: string, commit: string | null, at: number) => {
    const blob = blobs.get(sha) ?? { paths: new Set<string>(), commit: null, at: Infinity };
    blobs.set(sha, blob);
    blob.paths.add(path);
    if (commit && at < blob.at) {
      blob.commit = commit;
      blob.at = at;
    }
  };
  const log = await git(repo, [
    "log",
    "--all",
    "--reverse",
    "--date-order",
    "--raw",
    "--no-abbrev",
    "--no-renames",
    "--no-color",
    `--format=${COMMIT}%H %ct`,
  ]);
  let commit = "";
  let at = 0;
  for (const line of log.split("\n")) {
    if (line.startsWith(COMMIT)) {
      const [sha, time] = line.slice(1).split(" ");
      commit = sha!;
      at = Number(time);
    } else if (line.startsWith(":")) {
      const tab = line.indexOf("\t");
      const [, , , sha] = line.slice(0, tab).split(" ");
      if (sha && !NO_BLOB.test(sha)) add(sha, line.slice(tab + 1), commit, at);
    }
  }
  for (const line of (await git(repo, ["rev-list", "--all", "--objects"])).split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0 && !blobs.has(line.slice(0, space)))
      add(line.slice(0, space), line.slice(space + 1), null, Infinity);
  }
  return blobs;
}

async function git(repo: string, args: string[], input?: string): Promise<string> {
  const proc = Bun.spawn(["git", "-C", repo, ...args], {
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "ignore",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args[0]} failed in ${repo}`);
  return out.trim();
}

async function catFile(
  repo: string,
  shas: string[],
  onObject: (sha: string, bytes: Uint8Array) => void,
) {
  const proc = Bun.spawn(["git", "-C", repo, "cat-file", "--batch"], {
    stdin: new Blob([shas.join("\n") + "\n"]),
    stdout: "pipe",
    stderr: "ignore",
  });
  const chunks: Uint8Array[] = [];
  let queued = 0;
  const take = (n: number) => {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const head = chunks[0]!;
      const used = Math.min(head.length, n - filled);
      out.set(head.subarray(0, used), filled);
      filled += used;
      if (used === head.length) chunks.shift();
      else chunks[0] = head.subarray(used);
    }
    queued -= n;
    return out;
  };
  const headerEnd = () => {
    let offset = 0;
    for (const chunk of chunks) {
      const at = chunk.indexOf(10);
      if (at !== -1) return offset + at;
      offset += chunk.length;
    }
    return -1;
  };
  let pending: { sha: string; size: number } | null = null;
  for await (const chunk of proc.stdout) {
    chunks.push(chunk);
    queued += chunk.length;
    while (true) {
      if (!pending) {
        const end = headerEnd();
        if (end === -1) break;
        const [sha, , size] = new TextDecoder()
          .decode(take(end + 1))
          .trim()
          .split(" ");
        pending = { sha: sha!, size: Number(size) || 0 };
      }
      if (queued < pending.size + 1) break;
      const bytes = take(pending.size + 1).subarray(0, pending.size);
      onObject(pending.sha, bytes);
      pending = null;
    }
  }
  if ((await proc.exited) !== 0) throw new Error(`git cat-file failed in ${repo}`);
}
