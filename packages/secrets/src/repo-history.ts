import type { Progress } from "@quench/history";
import { detectInFile } from "./detect.ts";
import type { Masker } from "./mask.ts";
import { allowedPath } from "./rules.ts";
import { secretOf, type Secret } from "./secret.ts";

export type RepoSecret = Secret & { repos: string[]; files: string[]; versions: number };

type Found = RepoSecret & { repoSet: Set<string>; fileSet: Set<string> };

const SHOWN_FILES = 5;
const BINARY_PROBE = 8000;

export async function scanRepoHistory(
  projects: readonly string[],
  mask: Masker,
  onRead?: Progress,
) {
  const found = new Map<string, Found>();
  let commits = 0;
  let blobs = 0;
  let failed = 0;
  let done = 0;
  for (const repo of projects) {
    const scanned = await scanRepo(repo, (path, text) => {
      for (const detection of detectInFile(text, path)) {
        const id = mask.id(detection.value);
        const known = found.get(id) ?? {
          ...secretOf(detection, mask, "repo-history"),
          repos: [],
          files: [],
          versions: 0,
          repoSet: new Set<string>(),
          fileSet: new Set<string>(),
        };
        found.set(id, known);
        known.versions++;
        known.repoSet.add(repo);
        known.fileSet.add(path);
      }
    }).catch(() => null);
    if (scanned) {
      commits += scanned.commits;
      blobs += scanned.blobs;
    } else failed++;
    onRead?.(++done, projects.length);
  }
  const listed = [...found.values()].map(({ repoSet, fileSet, ...secret }) => ({
    ...secret,
    repos: [...repoSet].sort(),
    files: [...fileSet].sort().slice(0, SHOWN_FILES),
  }));
  listed.sort((a, b) => b.versions - a.versions || a.provider.localeCompare(b.provider));
  return {
    repos: projects.length - failed,
    failed,
    commits,
    blobs,
    secrets: listed.filter((s) => s.confidence === "high"),
    lowConfidence: listed.filter((s) => s.confidence === "low"),
  };
}

async function scanRepo(repo: string, onBlob: (path: string, text: string) => void) {
  const commits = Number(await git(repo, ["rev-list", "--all", "--count"]));
  const paths = new Map<string, string>();
  for (const line of (await git(repo, ["rev-list", "--all", "--objects"])).split("\n")) {
    const [sha, path] = [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)];
    if (line.includes(" ") && path && !paths.has(sha) && !allowedPath(path)) paths.set(sha, path);
  }
  const checked = await git(
    repo,
    ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
    [...paths.keys()].join("\n"),
  );
  const shas = checked
    .split("\n")
    .filter((line) => line.endsWith(" blob"))
    .map((line) => line.split(" ")[0]!);
  const decoder = new TextDecoder();
  await catFile(repo, shas, (sha, bytes) => {
    if (bytes.subarray(0, BINARY_PROBE).includes(0)) return;
    onBlob(paths.get(sha)!, decoder.decode(bytes));
  });
  return { commits, blobs: shas.length };
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
