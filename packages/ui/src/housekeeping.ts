import { quoteArg, type Shell } from "@quench/history/quote";

export type Worktree = {
  path: string;
  branch: string | null;
  head: string | null;
  locked: boolean;
  missing: boolean;
  active: boolean;
  dirty: boolean | null;
  merged: boolean | null;
  upstreamGone: boolean;
  removable: boolean;
  reasons: string[];
};

export type Repository = { root: string; base: string | null; worktrees: Worktree[] };

export type WorktreesReport = {
  observedAt: string;
  days: number;
  repositories: Repository[];
  limitations: string[];
};

export type Secret = {
  id: string;
  tag: string;
  masked: string;
  provider: string;
  confidence: "high" | "low";
  issuer: string | null;
  rotate: string | null;
};

export type HistorySecret = Secret & {
  sessions: number;
  firstSeen: string | null;
  lastSeen: string | null;
  exposures: { by: string }[];
};

export type FileSecrets = {
  path: string;
  kind: string;
  tracked: boolean | null;
  secrets: Secret[];
};

export type CredentialFile = {
  id: string;
  path: string;
  label: string;
  present: boolean;
  plaintext: boolean | null;
  mode: string | null;
  othersCanRead: boolean | null;
  tracked: boolean | null;
  values: Secret[];
  readInSessions: number;
  printedInSessions: boolean;
};

export type RepoSecret = Secret & { versions: number; repos: string[]; files: string[] };

export type SecretsReport = {
  observedAt: string;
  history: {
    sessions: number;
    hostMessages: number;
    secrets: HistorySecret[];
    lowConfidence: HistorySecret[];
  };
  configs: FileSecrets[];
  instructions: { scanned: number; files: FileSecrets[] };
  credentialFiles: CredentialFile[];
  repoHistory: { secrets: RepoSecret[]; lowConfidence: RepoSecret[] } | null;
  limitations: string[];
  warnings: string[];
};

export type RepositoryPlan = {
  root: string;
  base: string | null;
  active: number;
  removable: { worktree: Worktree; command: string }[];
  kept: Worktree[];
  prune: string | null;
};

const removeCommand = (root: string, path: string, shell: Shell) =>
  `git -C ${quoteArg(root, shell)} worktree remove ${quoteArg(path, shell)}`;

export function plan(repo: Repository, shell: Shell): RepositoryPlan {
  const idle = repo.worktrees.filter((w) => !w.active && !w.missing);
  return {
    root: repo.root,
    base: repo.base,
    active: repo.worktrees.filter((w) => w.active && !w.missing).length,
    removable: idle
      .filter((w) => w.removable)
      .map((worktree) => ({ worktree, command: removeCommand(repo.root, worktree.path, shell) })),
    kept: idle.filter((w) => !w.removable),
    prune: repo.worktrees.some((w) => w.missing)
      ? `git -C ${quoteArg(repo.root, shell)} worktree prune`
      : null,
  };
}

export function rotations(report: SecretsReport) {
  const rows = new Map<
    string,
    { provider: string; issuer: string | null; rotate: string | null }
  >();
  for (const s of [
    ...report.history.secrets,
    ...(report.repoHistory?.secrets ?? []),
    ...report.configs.flatMap((f) => f.secrets),
    ...report.instructions.files.flatMap((f) => f.secrets),
    ...report.credentialFiles.flatMap((f) => f.values),
  ].filter((s) => s.confidence === "high"))
    rows.set(`${s.provider}\n${s.issuer ?? ""}`, {
      provider: s.provider,
      issuer: s.issuer,
      rotate: s.rotate,
    });
  return [...rows.values()].sort((a, b) =>
    `${a.provider}${a.issuer}`.localeCompare(`${b.provider}${b.issuer}`),
  );
}

export function freshness(computedAt: string, refreshing: boolean, now: number): string {
  const minutes = Math.floor((now - Date.parse(computedAt)) / 60_000);
  const age =
    minutes < 1
      ? "just now"
      : minutes < 60
        ? `${minutes} min ago`
        : `${Math.floor(minutes / 60)} h ago`;
  return refreshing ? `as of ${age} · refreshing…` : `as of ${age}`;
}
