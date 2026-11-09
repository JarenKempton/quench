import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { replacePrivateFile } from "../private-file.ts";
import type { Change } from "./git-history.ts";

export type Span = { treeHash: string; from: number; until: number | null; bytes: number | null };

export type Versions = { source: "git" | "snapshots"; spans: Span[] };

const FILE = ".quench/local/snapshots.json";
export const DELETED = /^0+$/;

type Seen = { sha256: string; bytes: number; first: number; last: number };
type Stored = { v: 1; files: Record<string, Seen[]> };

const blobId = (bytes: Uint8Array) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

async function gitVersions(
  path: string,
  changes: readonly Change[] | undefined,
): Promise<Span[] | null> {
  if (!changes?.length) return null;
  const commits = changes.map((c) => ({ ...c }));
  commits.reverse();
  for (let i = 1; i < commits.length; i++)
    commits[i]!.at = Math.max(commits[i]!.at, commits[i - 1]!.at);
  const spans: Span[] = commits.map((c, i) => ({
    treeHash: c.blob,
    from: c.at,
    until: commits[i + 1]?.at ?? null,
    bytes: c.bytes,
  }));
  const last = spans.at(-1)!;
  const disk = await Bun.file(path)
    .bytes()
    .catch(() => null);
  if (disk && blobId(disk) !== last.treeHash) {
    const changed = Math.max((await stat(path)).mtimeMs, last.from);
    last.until = changed;
    spans.push({ treeHash: blobId(disk), from: changed, until: null, bytes: disk.length });
  }
  return spans;
}

export async function snapshots(homeDir: string, write: boolean) {
  const file = join(homeDir, FILE);
  const stored = (await Bun.file(file)
    .json()
    .catch(() => null)) as Stored | null;
  const files = stored?.v === 1 ? stored.files : {};
  let changed = false;
  const now = Date.now();
  return {
    async versions(path: string): Promise<Span[]> {
      const bytes = await Bun.file(path)
        .bytes()
        .catch(() => null);
      const seen = (files[path] ??= []);
      if (bytes && write) {
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const latest = seen.at(-1);
        if (latest?.sha256 === sha256) latest.last = now;
        else seen.push({ sha256, bytes: bytes.length, first: now, last: now });
        changed = true;
      }
      if (!seen.length) delete files[path];
      return seen.map((s) => ({
        treeHash: s.sha256,
        from: s.first,
        until: s.last + 1,
        bytes: s.bytes,
      }));
    },
    async save() {
      if (!changed) return;
      await replacePrivateFile(file, JSON.stringify({ v: 1, files } satisfies Stored));
    },
  };
}

export async function versionsOf(
  path: string,
  changes: readonly Change[] | undefined,
  recorded: Awaited<ReturnType<typeof snapshots>>,
): Promise<Versions> {
  const tracked = await gitVersions(path, changes);
  return tracked
    ? { source: "git", spans: tracked }
    : { source: "snapshots", spans: await recorded.versions(path) };
}
