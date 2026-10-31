import { heading } from "../style.ts";
import { dirname, relative, sep } from "node:path";
import {
  checkout,
  compareWithDisk,
  harnessById,
  isInside,
  pathParts,
  type DiskComparison,
  type HarnessId,
  type InjectedInstruction,
  type SessionPlace,
} from "@quench/history";
import { ago, chars, count, projectName, shortPath, table } from "../format.ts";

export type RecordedFile = {
  root: string | null;
  file: string;
  combined: boolean;
  harnesses: HarnessId[];
  sessions: number;
  lastRecorded: string | null;
  textChars: number;
  textSha256: string;
  checkouts: { path: string; lastRecorded: string | null; disk: DiskComparison }[];
};

type Copy = { at: string | null; record: InjectedInstruction };

type Row = { root: string | null; file: string; places: SessionPlace[]; copies: Map<string, Copy> };

const SHOWN = 15;

export async function recordedFiles(places: readonly SessionPlace[]): Promise<RecordedFile[]> {
  const checkouts = new Map<string, ReturnType<typeof checkout>>();
  const checkoutOf = (dir: string) =>
    checkouts.get(dir) ?? checkouts.set(dir, checkout(dir)).get(dir)!;
  const rows = new Map<string, Row>();
  for (const place of places) {
    const at = place.at?.toISOString() ?? null;
    for (const record of place.instructions ?? []) {
      const target = record.path ?? record.directory;
      const repo = target ? await checkoutOf(record.path ? dirname(target) : target) : null;
      const file = repo && target ? relative(repo.top, target) || "." : (target ?? "unknown");
      const key = `${repo?.root ?? ""}\0${file}\0${record.path === null}`;
      const row =
        rows.get(key) ??
        rows.set(key, { root: repo?.root ?? null, file, places: [], copies: new Map() }).get(key)!;
      if (row.places.at(-1) !== place) row.places.push(place);
      const copy = target ?? "unknown";
      if ((at ?? "") >= (row.copies.get(copy)?.at ?? "")) row.copies.set(copy, { at, record });
    }
  }
  const files = await Promise.all([...rows.values()].map(summarize));
  return files.sort((a, b) => b.sessions - a.sessions || a.file.localeCompare(b.file));
}

async function summarize(row: Row): Promise<RecordedFile> {
  const copies = [...row.copies].sort(([, a], [, b]) => (b.at ?? "").localeCompare(a.at ?? ""));
  const [, newest] = copies[0]!;
  return {
    root: row.root,
    file: row.file,
    combined: newest.record.path === null,
    harnesses: [...new Set(row.places.map((p) => p.harness))],
    sessions: row.places.length,
    lastRecorded: newest.at,
    textChars: newest.record.textChars,
    textSha256: newest.record.textSha256,
    checkouts: await Promise.all(
      copies.map(async ([path, { at, record }]) => ({
        path,
        lastRecorded: at,
        disk: await compareWithDisk(record),
      })),
    ),
  };
}

export function renderRecordedFiles(
  files: RecordedFile[],
  context: { homeDir: string; claudeHome: string; roots: string[] },
): string[] {
  if (!files.length) return [];
  const shown = files.slice(0, SHOWN);
  const lines = [
    "",
    heading("Recorded instructions · what session histories logged loading · worktrees folded"),
    ...table(
      [
        ["File", "Agents", "Sessions", "Last recorded", "Size", "Disk now"],
        ...shown.map((r) => [
          fileLabel(r, context),
          r.harnesses.map((h) => harnessById[h].label).join(", "),
          count(r.sessions),
          ago(r.lastRecorded),
          chars(r.textChars),
          diskNow(r),
        ]),
      ],
      [2, 4],
    ),
  ];
  if (files.length > shown.length) lines.push(`  … ${files.length - shown.length} more in --json`);
  return lines;
}

function fileLabel(
  r: RecordedFile,
  { homeDir, claudeHome, roots }: { homeDir: string; claudeHome: string; roots: string[] },
): string {
  if (r.combined)
    return r.root === null
      ? "combined block, directory not recorded"
      : `${projectName(r.root, homeDir)}${r.file === "." ? "" : `${sep}${r.file}`} (combined block)`;
  if (r.root !== null) return `${projectName(r.root, homeDir)}${sep}${r.file}`;
  const memory = autoMemory(r.file, claudeHome, roots);
  return memory
    ? `${projectName(memory.root, homeDir)} auto memory${sep}${memory.file}`
    : shortPath(r.file, homeDir);
}

export function autoMemory(path: string, claudeHome: string, roots: string[]) {
  if (!isInside(path, claudeHome)) return null;
  const [projects, slug, kind, ...rest] = pathParts(path.slice(claudeHome.length));
  const root = roots.find((r) => r.replace(/[^A-Za-z0-9]/g, "-") === slug);
  return projects === "projects" && root && kind === "memory"
    ? { root, file: rest.join(sep) }
    : null;
}

function diskNow(file: RecordedFile): string {
  const states = [...new Set(file.checkouts.map((c) => c.disk))];
  if (states.length === 1) return states[0]!;
  return states
    .map((state) => `${file.checkouts.filter((c) => c.disk === state).length} ${state}`)
    .join(", ");
}
