export type Counts = { judged: number; corrections: number };

export type Week = { week: string; fromPeople: Counts; fromAutomation: Counts };

type Tally = { replies: number; judged: number; kinds: { correction: number } };

export type Loaded = {
  name: string;
  sessions: number;
  corrections: number;
  first: string | null;
  last: string | null;
};

export type Recurring = {
  behaviour: string;
  corrections: number;
  fromPeople: number;
  fromAutomation: number;
  sessions: number;
  first: string | null;
  last: string | null;
  skills: Loaded[];
  files: Loaded[];
};

export type VersionCounts = { sessions: number; judged: number; withHumanCorrection: number };

export type FileVersion = {
  treeHash: string;
  from: string;
  to: string | null;
  bytes: number | null;
  loaded: VersionCounts;
  without: VersionCounts;
};

export type FileChange = {
  at: string;
  grewBy: number | null;
  shown: boolean;
  rates: { before: number | null; after: number | null };
  grewWithoutDrop: boolean;
};

export type FileHistory = {
  kind: "skill" | "instructions";
  name: string;
  path: string;
  source: "git" | "snapshots";
  sessions: number;
  versions: FileVersion[];
  changes: FileChange[];
};

export type CorrectionsReport = {
  days: number;
  judge: string;
  pending: number;
  calls: number;
  fromPeople: Tally;
  fromAutomation: Tally;
  weekly: Week[];
  context: {
    corrections: number;
    withoutBehaviour: number;
    singleSession: number;
    recurring: Recurring[];
    history: { basis: string; floor: number; total: number; files: FileHistory[] };
  };
};

export type CorrectionsResponse = CorrectionsReport | { judge: null };

export const rate = (corrections: number, judged: number) => (judged ? corrections / judged : null);

export const percent = (r: number | null) =>
  r === null ? "–" : `${(100 * r).toFixed(r && r < 0.1 ? 1 : 0)}%`;

export const judgeCommand = (days: number) =>
  `quench corrections${days === 30 ? "" : ` --days ${days}`}`;

export const shownFiles = (history: CorrectionsReport["context"]["history"]) =>
  [...history.files].sort(
    (a, b) =>
      Number(b.changes.some((c) => c.grewWithoutDrop)) -
        Number(a.changes.some((c) => c.grewWithoutDrop)) || b.sessions - a.sessions,
  );
