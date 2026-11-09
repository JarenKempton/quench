import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pullId, repoKey, type JudgedSegment, type Pull } from "@quench/insights";
import { replacePrivateFile } from "../private-file.ts";

export type Run = (command: string[]) => Promise<string | null>;

type Cache = Record<string, { fetchedAt: string; failedAt?: string; pulls: Pull[] }>;

const FIELDS =
  "number,headRefName,headRepositoryOwner,isCrossRepository,state,createdAt,closedAt,mergedAt";
const GITHUB_REMOTE = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;

const pullsFile = (dir: string) => join(dir, "pulls.json");

export const run: Run = async (command) => {
  try {
    const proc = Bun.spawn(command, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out : null;
  } catch {
    return null;
  }
};

export async function repoOf(cwd: string | null, exec: Run = run) {
  if (!cwd) return null;
  const url = await exec(["git", "-C", cwd, "remote", "get-url", "origin"]);
  const repo = url?.trim().match(GITHUB_REMOTE)?.[1];
  return repo ? repoKey(repo) : null;
}

const parse = (repo: string, out: string): Pull[] | null => {
  try {
    return (
      JSON.parse(out) as {
        number: number;
        headRefName: string;
        headRepositoryOwner: { login: string } | null;
        isCrossRepository: boolean;
        state: Pull["state"];
        createdAt: string;
        closedAt: string | null;
        mergedAt: string | null;
      }[]
    ).map((p) => ({
      repo,
      number: p.number,
      head: p.isCrossRepository
        ? `${p.headRepositoryOwner?.login ?? ""}:${p.headRefName}`
        : p.headRefName,
      state: p.state,
      createdAt: p.createdAt,
      closedAt: p.closedAt || null,
      mergedAt: p.mergedAt || null,
    }));
  } catch {
    return null;
  }
};

const RETRY_MS = 60 * 60_000;

function dueRepos(cache: Cache, segments: readonly JudgedSegment[], now: number) {
  const open = new Set(
    Object.values(cache).flatMap((c) =>
      c.pulls.flatMap((p) =>
        p.state === "OPEN" ? [pullId(p), `${p.repo}\0branch:${p.head}`] : [],
      ),
    ),
  );
  const due = new Set<string>();
  for (const s of segments) {
    const repo = s.repo;
    if (!repo || due.has(repo)) continue;
    const known = cache[repo];
    if (known?.failedAt && now - Date.parse(known.failedAt) < RETRY_MS) continue;
    if (
      !known?.fetchedAt ||
      s.endedAt > known.fetchedAt ||
      s.markers.some((m) => open.has(m) || open.has(`${repo}\0${m}`))
    )
      due.add(repo);
  }
  return [...due].sort();
}

export async function githubPulls(
  dir: string,
  segments: readonly JudgedSegment[],
  now = Date.now(),
  exec: Run = run,
) {
  const cache = await readCache(dir);
  const due = dueRepos(cache, segments, now);
  let failed = 0;
  for (const repo of due) {
    const known = cache[repo];
    const since = known?.fetchedAt ? ["--search", `updated:>=${known.fetchedAt.slice(0, 10)}`] : [];
    const at = new Date(now).toISOString();
    const out = await exec([
      "gh",
      "pr",
      "list",
      "-R",
      repo,
      "--state",
      "all",
      "--limit",
      "5000",
      "--json",
      FIELDS,
      ...since,
    ]);
    const fresh = out === null ? null : parse(repo, out);
    if (!fresh) {
      failed++;
      cache[repo] = { fetchedAt: known?.fetchedAt ?? "", failedAt: at, pulls: known?.pulls ?? [] };
      continue;
    }
    const merged = new Map(known?.pulls.map((p) => [p.number, p]));
    for (const p of fresh) merged.set(p.number, p);
    cache[repo] = {
      fetchedAt: at,
      pulls: [...merged.values()].sort((a, b) => a.number - b.number),
    };
  }
  if (due.length) await replacePrivateFile(pullsFile(dir), `${JSON.stringify(cache)}\n`);
  return { ...known(cache, segments), fetched: due.length - failed };
}

async function readCache(dir: string): Promise<Cache> {
  try {
    return JSON.parse(await readFile(pullsFile(dir), "utf8")) as Cache;
  } catch {
    return {};
  }
}

function known(cache: Cache, segments: readonly JudgedSegment[]) {
  const needed = new Set(segments.flatMap((s) => (s.repo ? [s.repo] : [])));
  return {
    pulls: Object.values(cache).flatMap((c) => c.pulls),
    offline: [...needed].filter((repo) => cache[repo]?.failedAt).length,
  };
}

export const cachedPulls = async (dir: string, segments: readonly JudgedSegment[]) =>
  known(await readCache(dir), segments);
