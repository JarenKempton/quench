import type { Progress } from "@quench/history";
import { detectInFile } from "./detect.ts";
import type { Masker } from "./mask.ts";
import { secretOf, type Secret } from "./secret.ts";

export type RepoSecret = Secret & {
  repos: string[];
  commits: number;
  files: string[];
  firstSeen: string | null;
  lastSeen: string | null;
};

type Found = RepoSecret & { commitSet: Set<string>; repoSet: Set<string>; fileSet: Set<string> };

const SHOWN_FILES = 5;
const COMMIT = "\u0001";

export async function scanRepoHistory(
  projects: readonly string[],
  mask: Masker,
  onRead?: Progress,
) {
  const found = new Map<string, Found>();
  let commits = 0;
  let failed = 0;
  let done = 0;
  for (const repo of projects) {
    let commit = "";
    let at: string | null = null;
    let file = "";
    let added: string[] = [];
    const flush = () => {
      if (added.length)
        for (const detection of detectInFile(added.join("\n"), file)) {
          const id = mask.id(detection.value);
          const known = found.get(id) ?? {
            ...secretOf(detection, mask, "repo-history"),
            repos: [],
            commits: 0,
            files: [],
            firstSeen: null,
            lastSeen: null,
            commitSet: new Set<string>(),
            repoSet: new Set<string>(),
            fileSet: new Set<string>(),
          };
          found.set(id, known);
          known.commitSet.add(commit);
          known.repoSet.add(repo);
          known.fileSet.add(file);
          if (at && (!known.firstSeen || at < known.firstSeen)) known.firstSeen = at;
          if (at && (!known.lastSeen || at > known.lastSeen)) known.lastSeen = at;
        }
      added = [];
    };
    const ok = await gitLines(repo, (line) => {
      if (line.startsWith(COMMIT)) {
        flush();
        const [sha, date] = line.slice(1).split(" ");
        commit = sha ?? "";
        at = date ? new Date(date).toISOString() : null;
        commits++;
      } else if (line.startsWith("+++ ")) {
        flush();
        file = line.slice(4).replace(/^b\//, "");
      } else if (line.startsWith("+")) added.push(line.slice(1));
      else if (line.startsWith("diff ")) flush();
    });
    flush();
    if (!ok) failed++;
    onRead?.(++done, projects.length);
  }
  const listed = [...found.values()].map(({ commitSet, repoSet, fileSet, ...secret }) => ({
    ...secret,
    repos: [...repoSet].sort(),
    commits: commitSet.size,
    files: [...fileSet].sort().slice(0, SHOWN_FILES),
  }));
  listed.sort((a, b) => b.commits - a.commits || a.provider.localeCompare(b.provider));
  return {
    repos: projects.length - failed,
    failed,
    commits,
    secrets: listed.filter((s) => s.confidence === "high"),
    lowConfidence: listed.filter((s) => s.confidence === "low"),
  };
}

async function gitLines(repo: string, onLine: (line: string) => void): Promise<boolean> {
  const proc = Bun.spawn(
    [
      "git",
      "-C",
      repo,
      "log",
      "--all",
      "-p",
      "-U0",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      `--format=${COMMIT}%H %cI`,
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of proc.stdout) {
    const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) onLine(line.replace(/\r$/, ""));
  }
  if (rest) onLine(rest);
  return (await proc.exited) === 0;
}
