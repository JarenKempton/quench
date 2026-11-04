import type { Progress } from "@quench/history";
import { detectInFile, type Detection } from "./detect.ts";
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

type Origin = { paths: Set<string>; commit: string | null; at: number; order: number };

type Found = RepoSecret & {
  repoSet: Set<string>;
  fileSet: Set<string>;
  first: [number, number];
};

const BINARY_PROBE = 8000;
const MAX_BYTES = 10 * 1024 * 1024;
const COMMIT = "\u0001";
const RAW_SHA = /^:\d{6} \d{6} [0-9a-f]+ ([0-9a-f]+) [A-Z]\d*\t(.*)$/;
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
    const scanned = await scanRepo(repo).catch(() => null);
    const origins = scanned && (await originsOf(repo, scanned.hits).catch(() => null));
    if (!scanned || !origins) {
      failed++;
      onRead?.(++done, projects.length);
      continue;
    }
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += scanned[key];
    for (const [sha, detections] of scanned.hits) {
      const origin = origins.get(sha)!;
      for (const detection of detections) {
        const id = mask.id(detection.value);
        const known = found.get(id) ?? {
          ...secretOf(detection, mask, "repo-history"),
          repos: [],
          files: [],
          versions: 0,
          introducedIn: null,
          introducedAt: null,
          first: [Infinity, Infinity] as [number, number],
          repoSet: new Set<string>(),
          fileSet: new Set<string>(),
        };
        found.set(id, known);
        known.versions++;
        known.repoSet.add(repo);
        for (const path of origin.paths) known.fileSet.add(path);
        if (origin.commit && before([origin.at, origin.order], known.first)) {
          known.first = [origin.at, origin.order];
          known.introducedIn = origin.commit.slice(0, 12);
          known.introducedAt = new Date(origin.at * 1000).toISOString();
        }
      }
    }
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

const before = (a: [number, number], b: [number, number]) =>
  a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

async function scanRepo(repo: string) {
  const paths = new Map<string, string>();
  for (const line of (await git(repo, ["rev-list", "--all", "--objects"])).split("\n")) {
    const space = line.indexOf(" ");
    const path = line.slice(space + 1);
    if (space > 0 && path && !allowedPath(path)) paths.set(line.slice(0, space), path);
  }
  const checked = await git(
    repo,
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    [...paths.keys()].join("\n"),
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
  const hits = new Map<string, Detection[]>();
  const decoder = new TextDecoder();
  await catFile(repo, shas, (sha, bytes) => {
    if (bytes.subarray(0, BINARY_PROBE).includes(0)) binary++;
    else {
      const found = detectInFile(decoder.decode(bytes), paths.get(sha));
      if (found.length) hits.set(sha, found);
    }
  });
  const commits = Number(await git(repo, ["rev-list", "--all", "--count"]));
  return { commits, blobs: shas.length - binary, binary, oversize, hits };
}

async function originsOf(repo: string, hits: Map<string, unknown>): Promise<Map<string, Origin>> {
  const origins = new Map<string, Origin>();
  for (const sha of hits.keys())
    origins.set(sha, { paths: new Set(), commit: null, at: Infinity, order: Infinity });
  if (!origins.size) return origins;
  let commit = "";
  let at = 0;
  let order = 0;
  await gitLines(
    repo,
    [
      "log",
      "--all",
      "--reverse",
      "--date-order",
      "--raw",
      "--no-abbrev",
      "--no-renames",
      "--no-color",
      `--format=${COMMIT}%H %ct`,
    ],
    (line) => {
      if (line.startsWith(COMMIT)) {
        const [sha, time] = line.slice(1).split(" ");
        commit = sha!;
        at = Number(time);
        order++;
        return;
      }
      const [, sha, path] = RAW_SHA.exec(line) ?? [];
      const origin = sha && !NO_BLOB.test(sha) ? origins.get(sha) : undefined;
      if (!origin) return;
      origin.paths.add(path!);
      if (!origin.commit) {
        origin.commit = commit;
        origin.at = at;
        origin.order = order;
      }
    },
  );
  return origins;
}

async function gitLines(repo: string, args: string[], onLine: (line: string) => void) {
  const proc = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "ignore" });
  const decoder = new TextDecoder();
  let partial: string[] = [];
  for await (const chunk of proc.stdout) {
    const lines = decoder.decode(chunk, { stream: true }).split("\n");
    const last = lines.pop() ?? "";
    for (const line of lines) {
      onLine(partial.length ? partial.join("") + line : line);
      partial = [];
    }
    if (last) partial.push(last);
  }
  if (partial.length) onLine(partial.join(""));
  if ((await proc.exited) !== 0) throw new Error(`git ${args[0]} failed in ${repo}`);
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
