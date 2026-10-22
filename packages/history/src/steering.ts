import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { harnesses } from "./harnesses/index.ts";
import type { Home } from "./home.ts";
import type { HarnessId } from "./model.ts";

export type SteeringRoot = {
  path: string;
  scope: "user" | "ancestor" | "project";
  directory?: boolean;
};

export type RuleCandidate = {
  startLine: number;
  endLine: number;
  text: string;
};

export type SteeringFile = {
  id: string;
  bytes: number;
  sources: {
    harness: HarnessId;
    path: string;
    realPath: string;
    scope: SteeringRoot["scope"];
  }[];
  rules: RuleCandidate[];
};

const MAX_BYTES = 262144;
const MAX_FILES = 256;
const MAX_DIRECTORIES = 256;
const MAX_DIRECTORY_PATHS = 1024;

export async function ancestorDirs(project: string, stopAtGit = false): Promise<string[]> {
  const dirs: string[] = [];
  for (let dir = project; ; dir = dirname(dir)) {
    dirs.unshift(dir);
    if (stopAtGit && (await stat(join(dir, ".git")).catch(() => null))) return dirs;
    if (dir === dirname(dir)) return stopAtGit ? [project] : dirs;
  }
}

export async function steeringInventory(home: Home, directory: string) {
  const project = await realpath(resolve(directory));
  if (!(await stat(project)).isDirectory()) throw new Error(`${directory} is not a directory`);
  const files = new Map<string, SteeringFile>();
  const physical = new Map<string, SteeringFile | null>();
  const warnings: string[] = [];
  const traversed = new Set<string>();
  const directories = new Map<string, Dirent[]>();
  let visitedFiles = 0;
  let limitReported = false;
  const warnLimit = () => {
    if (!limitReported)
      warnings.push(
        `Inventory stopped at ${MAX_FILES} files, ${MAX_DIRECTORIES} rule directories or ${MAX_DIRECTORY_PATHS} directory paths; coverage is incomplete.`,
      );
    limitReported = true;
  };
  for (const harness of harnesses) {
    const roots = await harness.steering(home, project);
    for (const root of roots) await visit(root, harness.id, new Set());
  }
  return {
    project,
    observedAt: new Date().toISOString(),
    evidence: "current-disk" as const,
    historicalLoad: "unknown" as const,
    files: [...files.values()],
    warnings,
    limitations: [
      "Current files are not proof of instructions loaded in a past session, an ignored rule, or a preference never written.",
      "This is a candidate inventory, not an effective instruction chain: precedence, settings, exclusions, trust, imports, managed policy, auto memory and runtime overrides are not resolved.",
      "Only built-in instruction filenames on the selected directory's ancestor chain, user locations and recognized rule directories are scanned; descendants, other worktrees and custom fallback filenames are not searched.",
      "Rule candidates are source bullets or paragraphs, not semantic rules; headings, frontmatter and fenced code are omitted. Conditions and imports are not interpreted.",
      "Identical file bytes share a content ID across paths and worktrees; this does not prove equivalent scope or that a harness deduplicates its context.",
      `Reads are bounded to ${MAX_BYTES} bytes per file, ${MAX_FILES} files, ${MAX_DIRECTORIES} rule directories and ${MAX_DIRECTORY_PATHS} directory paths; skipped or unreadable sources produce warnings.`,
    ],
  };

  async function visit(
    root: SteeringRoot,
    harness: HarnessId,
    parents: Set<string>,
  ): Promise<void> {
    let canonical: string;
    try {
      canonical = await realpath(root.path);
      const info = await stat(canonical);
      if (root.directory) {
        if (!info.isDirectory()) throw new Error("not a directory");
        if (parents.has(canonical)) {
          warnings.push(`${root.path}: symlink cycle skipped`);
          return;
        }
        const key = JSON.stringify([harness, root.path, root.scope]);
        if (traversed.has(key)) return;
        if (traversed.size >= MAX_DIRECTORY_PATHS) return warnLimit();
        let entries = directories.get(canonical);
        if (!entries) {
          if (directories.size >= MAX_DIRECTORIES) return warnLimit();
          entries = (await readdir(canonical, { withFileTypes: true })).sort((a, b) =>
            a.name.localeCompare(b.name),
          );
          directories.set(canonical, entries);
        }
        traversed.add(key);
        const next = new Set([...parents, canonical]);
        for (const entry of entries) {
          const path = join(root.path, entry.name);
          if (entry.isDirectory() || entry.isSymbolicLink()) {
            const target = await stat(path).catch(() => null);
            if (!target) {
              warnings.push(`${path}: unreadable rule entry`);
              continue;
            }
            if (target.isDirectory()) {
              await visit({ ...root, path }, harness, next);
              continue;
            }
          }
          if (entry.name.endsWith(".md"))
            await visit({ ...root, path, directory: false }, harness, next);
        }
        return;
      }
      if (!info.isFile()) throw new Error("not a regular file");
      let file = physical.get(canonical);
      if (file === undefined) {
        if (visitedFiles >= MAX_FILES) return warnLimit();
        visitedFiles++;
        physical.set(canonical, null);
        if (info.size > MAX_BYTES) throw new Error(`exceeds ${MAX_BYTES} byte file limit`);
        const bytes = await Bun.file(canonical)
          .slice(0, MAX_BYTES + 1)
          .bytes();
        if (bytes.length > MAX_BYTES) throw new Error(`exceeds ${MAX_BYTES} byte file limit`);
        const id = createHash("sha256").update(bytes).digest("hex");
        file = files.get(id) ?? {
          id,
          bytes: bytes.length,
          sources: [],
          rules: ruleCandidates(new TextDecoder().decode(bytes)),
        };
        files.set(id, file);
        physical.set(canonical, file);
      }
      if (
        file &&
        !file.sources.some(
          (source) =>
            source.harness === harness && source.path === root.path && source.scope === root.scope,
        )
      )
        file.sources.push({ harness, path: root.path, realPath: canonical, scope: root.scope });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        (await lstat(root.path).catch(() => null))?.isSymbolicLink()
      )
        warnings.push(`${root.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function ruleCandidates(text: string): RuleCandidate[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const rules: RuleCandidate[] = [];
  let start: number | null = null;
  let fence: { char: string; length: number } | null = null;
  let first = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line));
    if (end >= 0) {
      try {
        const metadata: unknown = Bun.YAML.parse(lines.slice(1, end).join("\n"));
        if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) first = end + 1;
      } catch {
        first = 0;
      }
    }
  }
  const flush = (end: number) => {
    if (start !== null)
      rules.push({ startLine: start + 1, endLine: end, text: lines.slice(start, end).join("\n") });
    start = null;
  };
  for (let i = first; i < lines.length; i++) {
    const line = lines[i]!;
    const content = line.replace(/^(?:\s*>\s?)+/, "").trimStart();
    const marker = /^(`{3,}|~{3,})(.*)$/.exec(content.replace(/^(?:[-+*]|\d+[.)])\s+/, ""));
    if (fence) {
      if (
        marker &&
        marker[1]![0] === fence.char &&
        marker[1]!.length >= fence.length &&
        !marker[2]!.trim()
      )
        fence = null;
      continue;
    }
    if (marker && (marker[1]![0] !== "`" || !marker[2]!.includes("`"))) {
      flush(i);
      fence = { char: marker[1]![0]!, length: marker[1]!.length };
    } else if (
      start !== null &&
      /^ {0,3}(?:=+|-+)\s*$/.test(content) &&
      !/^\s*(?:[-+*]|\d+[.)])\s+/.test(lines[start]!)
    ) {
      start = null;
    } else if (
      !line.trim() ||
      /^ {0,3}#{1,6}(\s|$)/.test(line) ||
      /^ {0,3}(?:[-*_]\s*){3,}$/.test(line)
    ) {
      flush(i);
    } else {
      if (/^\s*(?:[-+*]|\d+[.)])\s+/.test(line)) flush(i);
      start ??= i;
    }
  }
  flush(lines.length);
  return rules;
}
