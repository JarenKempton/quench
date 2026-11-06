import { createHash } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  ruleCandidates,
  skillInventory,
  type Home,
  type RuleCandidate,
  type Skill,
} from "@quench/history";
import type { SessionContext } from "./context.ts";
import { normal } from "../profile/steering-findings.ts";

const MIN_WORDS = 5;
const SHARE = 0.6;

export type Located = { path: string; startLine: number; endLine: number };

export type Overlap = {
  entry: Located;
  copies: number;
  skill: Located & { name: string; copies: number };
  shared: number;
  duplicate: boolean;
};

type Entry = Located & { words: Set<string>; key: string };

const located = (e: Entry): Located => ({
  path: e.path,
  startLine: e.startLine,
  endLine: e.endLine,
});

const FILLER = new Set(
  `about after again also always another anything asks because been being both could does doing
  each even every from have here into just like make makes many more most much must need needs
  never only other over please really same says should some such than that their them then there
  these they this those through user users very want wants were what when where which while will
  with without would your yours trigger triggers skill skills used uses using`.split(/\s+/),
);

const words = (text: string) =>
  new Set(
    normal(text)
      .split(" ")
      .filter((w) => w.length >= 4 && !FILLER.has(w)),
  );

const entriesOf = (path: string, rules: RuleCandidate[]): Entry[] =>
  rules.map((r) => ({
    path,
    startLine: r.startLine,
    endLine: r.endLine,
    words: words(r.text),
    key: normal(r.text),
  }));

async function memoryEntries(path: string): Promise<string[]> {
  if (basename(path) !== "MEMORY.md") return [path];
  const dir = dirname(path);
  const names = await readdir(dir).catch(() => []);
  return [
    path,
    ...names.filter((n) => n.endsWith(".md") && n !== "MEMORY.md").map((n) => join(dir, n)),
  ];
}

function skillEntries(skill: Skill, text: string): Entry[] {
  const lines = text.split(/\r?\n/);
  const line =
    Math.max(
      0,
      lines.findIndex((l) => /^description\s*:/.test(l)),
    ) + 1;
  return [
    ...entriesOf(skill.realPath, [{ startLine: line, endLine: line, text: skill.description }]),
    ...entriesOf(skill.realPath, ruleCandidates(text)),
  ];
}

type Unique = { path: string; copies: number; text: string };

async function unique(paths: Iterable<string>): Promise<Map<string, Unique>> {
  const seen = new Map<string, Unique>();
  for (const path of paths) {
    const real = await realpath(path).catch(() => null);
    const text =
      real &&
      (await Bun.file(real)
        .text()
        .catch(() => null));
    if (!text) continue;
    const hash = createHash("sha256").update(text).digest("hex");
    const known = seen.get(hash);
    if (known) known.copies++;
    else seen.set(hash, { path, copies: 1, text });
  }
  return seen;
}

export async function skillOverlaps(
  instructionPaths: readonly string[],
  skills: readonly Skill[],
): Promise<Overlap[]> {
  const byPath = new Map(skills.map((s) => [s.realPath, s]));
  const index = new Map<string, { entry: Entry; name: string; copies: number }[]>();
  for (const { path, copies, text } of (await unique(byPath.keys())).values()) {
    const skill = byPath.get(path)!;
    for (const entry of skillEntries(skill, text))
      for (const word of entry.words) {
        const hits = index.get(word) ?? index.set(word, []).get(word)!;
        hits.push({ entry, name: skill.name, copies });
      }
  }
  const seen = await unique(
    new Set((await Promise.all(instructionPaths.map(memoryEntries))).flat()),
  );
  const found: Overlap[] = [];
  for (const { path, copies, text } of seen.values()) {
    for (const entry of entriesOf(path, ruleCandidates(text))) {
      if (entry.words.size < MIN_WORDS) continue;
      const shared = new Map<Entry, { name: string; copies: number; count: number }>();
      for (const word of entry.words)
        for (const hit of index.get(word) ?? []) {
          const known = shared.get(hit.entry) ?? { name: hit.name, copies: hit.copies, count: 0 };
          known.count++;
          shared.set(hit.entry, known);
        }
      const best = new Map<string, Overlap>();
      for (const [skill, { name, copies: skillCopies, count }] of shared) {
        const duplicate = skill.key === entry.key;
        if (!duplicate && (count < MIN_WORDS || count < SHARE * entry.words.size)) continue;
        if ((best.get(skill.path)?.shared ?? -1) >= count) continue;
        best.set(skill.path, {
          entry: located(entry),
          copies,
          skill: { ...located(skill), name, copies: skillCopies },
          shared: count,
          duplicate,
        });
      }
      found.push(...best.values());
    }
  }
  return found.sort(
    (a, b) =>
      a.entry.path.localeCompare(b.entry.path) ||
      a.entry.startLine - b.entry.startLine ||
      a.skill.path.localeCompare(b.skill.path),
  );
}

export function renderOverlaps(found: Overlap[], path: (file: string) => string): string {
  const lines = ["", "Instruction and memory entries that overlap a skill"];
  if (!found.length) lines.push("  None found in the instruction and memory files in context.");
  for (const o of found)
    lines.push(
      `  ${path(o.entry.path)}:${o.entry.startLine}${o.copies > 1 ? ` (and ${o.copies - 1} identical copies)` : ""}  ↔  skill ${o.skill.name} ${path(o.skill.path)}:${o.skill.startLine}${o.skill.copies > 1 ? ` (and ${o.skill.copies - 1} identical copies)` : ""}  ${o.duplicate ? "duplicate" : `${o.shared} shared words`}`,
    );
  lines.push(
    "Overlap is a word-match heuristic over the files on disk today. Read-only: nothing is changed.",
  );
  return `${lines.join("\n")}\n`;
}

export async function skillsInContext(home: Home, contexts: ReadonlyMap<string, SessionContext>) {
  const byCwd = new Map<string, Map<string, Set<string>>>();
  const skills = new Map<string, Skill>();
  const cwds = new Set([
    home.dir,
    ...[...contexts.values()].flatMap((c) => (c.cwd ? [c.cwd] : [])),
  ]);
  for (const cwd of cwds) {
    const names = new Map<string, Set<string>>();
    for (const skill of (await skillInventory(home, cwd).catch(() => null))?.skills ?? []) {
      skills.set(skill.realPath, skill);
      names.set(skill.name, (names.get(skill.name) ?? new Set()).add(skill.realPath));
    }
    byCwd.set(cwd, names);
  }
  const skillPath = (cwd: string | null, name: string) => {
    const found = byCwd.get(cwd ?? home.dir)?.get(name);
    return found?.size === 1 ? [...found][0]! : null;
  };
  return { skills: [...skills.values()], skillPath };
}
