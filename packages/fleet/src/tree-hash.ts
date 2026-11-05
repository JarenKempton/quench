import { z } from "zod";
import type { TreeHash } from "./common.ts";

export const FileMode = z.enum(["100644", "100755", "120000"]);
export type FileMode = z.infer<typeof FileMode>;

export type TreeEntry = { path: string; mode: FileMode; bytes: Uint8Array };

export const EXCLUDED_NAMES = [".git", ".DS_Store", "Thumbs.db"] as const;

export const excluded = (path: string) =>
  path.split("/").some((part) => (EXCLUDED_NAMES as readonly string[]).includes(part));

export const canonicalPath = (path: string) => path.replaceAll("\\", "/").normalize("NFC");

const utf8 = new TextEncoder();
const byBytes = (a: string, b: string) => Buffer.compare(utf8.encode(a), utf8.encode(b));

export const sha256 = (bytes: Uint8Array | string) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export function sortedEntries(entries: TreeEntry[]): TreeEntry[] {
  const kept = entries
    .map((entry) => ({ ...entry, path: canonicalPath(entry.path) }))
    .filter((entry) => !excluded(entry.path));
  const sorted = kept.sort((a, b) => byBytes(a.path, b.path));
  for (let i = 1; i < sorted.length; i++)
    if (sorted[i]!.path === sorted[i - 1]!.path)
      throw new Error(`duplicate path ${sorted[i]!.path}`);
  return sorted;
}

export function treeHash(entries: TreeEntry[]): TreeHash {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const entry of sortedEntries(entries))
    hasher.update(`${entry.mode} ${entry.path}\0${sha256(entry.bytes)}\n`);
  return `sha256:${hasher.digest("hex")}`;
}
