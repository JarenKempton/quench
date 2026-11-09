import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoKey, type JudgedSegment, type Pull } from "@quench/insights";
import { replacePrivateFile } from "../private-file.ts";

export type Run = (command: string[]) => Promise<string | null>;

type Cache = Record<string, { fetchedAt: string; pulls: Pull[] }>;

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

function dueRepos(cache: Cache, segments: readonly JudgedSegment[]) {
  const states = new Map(
    Object.entries(cache).map(([repo, c]) => [
      repo,
      {
        byNumber: new Map(c.pulls.map((p) => [p.number, p.state])),
        last: c.pulls.at(-1)?.number ?? 0,
      },
    ]),
  );
  const unsettled = (repo: string, n: number) => {
    const known = states.get(repo)!;
    const state = known.byNumber.get(n);
    return state ? state === "OPEN" : n > known.last;
  };
  const due = new Set<string>();
  for (const s of segments) {
    if (!s.repo || due.has(s.repo)) continue;
    const known = cache[s.repo];
    const prefix = `github:${s.repo}#`;
    if (
      !known ||
      s.endedAt > known.fetchedAt ||
      s.markers.some(
        (m) => m.startsWith(prefix) && unsettled(s.repo!, Number(m.slice(prefix.length))),
      )
    )
      due.add(s.repo);
  }
  return [...due].sort();
}

export async function githubPulls(
  dir: string,
  segments: readonly JudgedSegment[],
  now = Date.now(),
  exec: Run = run,
) {
  let cache: Cache = {};
  try {
    cache = JSON.parse(await readFile(pullsFile(dir), "utf8")) as Cache;
  } catch {}
  const due = dueRepos(cache, segments);
  let offline = 0;
  for (const repo of due) {
    const known = cache[repo];
    const since = known ? ["--search", `updated:>=${known.fetchedAt.slice(0, 10)}`] : [];
    const fetchedAt = new Date(now).toISOString();
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
      offline++;
      continue;
    }
    const merged = new Map(known?.pulls.map((p) => [p.number, p]));
    for (const p of fresh) merged.set(p.number, p);
    cache[repo] = { fetchedAt, pulls: [...merged.values()].sort((a, b) => a.number - b.number) };
  }
  if (due.length > offline) await replacePrivateFile(pullsFile(dir), `${JSON.stringify(cache)}\n`);
  return {
    pulls: Object.values(cache).flatMap((c) => c.pulls),
    fetched: due.length - offline,
    offline,
  };
}
