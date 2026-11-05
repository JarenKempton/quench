import { z } from "zod";
import { foldKey, insideFolder, type TreeHash } from "./common.ts";

export const FileMode = z.enum(["100644", "100755", "120000"]);
export type FileMode = z.infer<typeof FileMode>;

export type TreeEntry = { path: string; mode: FileMode; bytes: Uint8Array };
export type HashedEntry = { path: string; mode: FileMode; sha256: string };

export const hashMode = (mode: FileMode) => (mode === "120000" ? "120000" : "100644");

export const EXCLUDED_NAMES = [".git", ".DS_Store", "Thumbs.db"] as const;

export const excluded = (path: string) =>
  path.split("/").some((part) => (EXCLUDED_NAMES as readonly string[]).includes(part));

const utf8 = new TextEncoder();
const byBytes = (a: string, b: string) => Buffer.compare(utf8.encode(a), utf8.encode(b));

export const sha256 = (bytes: Uint8Array | string) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export const foldCollision = (paths: string[]) => {
  const seen = new Map<string, { path: string; file: boolean }>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      const file = i === parts.length;
      const other = seen.get(foldKey(prefix));
      if (other && (other.path !== prefix || other.file || file))
        return [other.path, prefix] as const;
      seen.set(foldKey(prefix), { path: prefix, file });
    }
  }
  return null;
};

export function sortedEntries(entries: TreeEntry[]): TreeEntry[] {
  const kept = entries.filter((entry) => !excluded(entry.path));
  for (const { path } of kept)
    if (!insideFolder(path)) throw new Error(`${JSON.stringify(path)} is not a portable NFC path`);
  const collision = foldCollision(kept.map((e) => e.path));
  if (collision) throw new Error(`duplicate path ${collision.join(" and ")}`);
  return kept.sort((a, b) => byBytes(a.path, b.path));
}

export const treeHash = (entries: TreeEntry[]): TreeHash =>
  treeHashOf(
    sortedEntries(entries).map((e) => ({ path: e.path, mode: e.mode, sha256: sha256(e.bytes) })),
  );

export function treeHashOf(entries: HashedEntry[]): TreeHash {
  const hasher = new Bun.CryptoHasher("sha256");
  const sorted = [...entries].sort((a, b) => byBytes(a.path, b.path));
  for (const entry of sorted)
    hasher.update(`${hashMode(entry.mode)} ${entry.path}\0${entry.sha256}\n`);
  return `sha256:${hasher.digest("hex")}`;
}
