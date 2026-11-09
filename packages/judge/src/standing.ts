import { basename, join } from "node:path";
import { ruleCandidates, type Session } from "@quench/history";
import type { Run } from "@quench/insights";

export type Rule = {
  evidence: string;
  from: number;
  kind: "correction" | "standing" | "standard";
  text: string;
  ambiguous: boolean;
};

const RULE_CHARS = 300;
const FILE_BYTES = 256 * 1024;
const STANDING =
  /^(?:always|never)\b|\b(?:from now on|going forward|from here on|every time|whenever|in (?:the )?future)\b/i;
const CUE = /\b(?:always|never|don'?t|do not|must(?: not)?|no more)\b/i;
const NOT_A_RULE = /\bnever ?mind\b/i;

export const clip = (text: string, chars = RULE_CHARS) => Array.from(text).slice(0, chars).join("");

type Cue = { text: string; ambiguous: boolean };

export function cueSentences(text: string): Cue[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) =>
      s
        .replace(/^(?:\s*>\s?)+/, "")
        .replace(/^\s*(?:[-+*]|\d+[.)])\s+/, "")
        .trim(),
    )
    .flatMap((s): Cue[] =>
      s.length < 8 || NOT_A_RULE.test(s)
        ? []
        : STANDING.test(s)
          ? [{ text: clip(s), ambiguous: false }]
          : CUE.test(s)
            ? [{ text: clip(s), ambiguous: true }]
            : [],
    );
}

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

async function loadedText(path: string, digest: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists()) || file.size > FILE_BYTES) return null;
  const text = await file.text().catch(() => null);
  return text !== null && (sha256(text) === digest || sha256(text.trim()) === digest) ? text : null;
}

async function currentText(path: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists()) || file.size > FILE_BYTES) return null;
  return file.text().catch(() => null);
}

const fileRules = (text: string, label: string, from: number): Rule[] =>
  ruleCandidates(text).flatMap((candidate) =>
    cueSentences(candidate.text).map((s) => ({
      evidence: `${label}:${candidate.startLine}`,
      from,
      kind: "standard" as const,
      ...s,
    })),
  );

export async function loadedStandards(
  session: Session,
  runs: readonly Run[],
  skillRoots: readonly string[],
): Promise<Rule[]> {
  const turnAt = (at: Date | null) =>
    at ? runs.findLastIndex((r) => r.startedAt !== null && r.startedAt <= at) : -1;
  const skillPaths = new Map<string, string>();
  const rules: Rule[] = [];
  const seen = new Set<string>();
  for (const event of session.events) {
    if (event.type === "skills")
      for (const skill of event.listed)
        if (skill.path && !skillPaths.has(skill.name)) skillPaths.set(skill.name, skill.path);
    if (event.type === "instructions")
      for (const file of event.files) {
        const path = file.path ?? (file.directory ? join(file.directory, "AGENTS.md") : null);
        if (!path || seen.has(path)) continue;
        seen.add(path);
        const text = await loadedText(path, file.textSha256);
        if (text) rules.push(...fileRules(text, basename(path), -1));
      }
    if (event.type === "invocation") {
      const listed = skillPaths.get(event.name);
      const paths = listed
        ? [listed.endsWith(".md") ? listed : join(listed, "SKILL.md")]
        : event.name.includes(":")
          ? []
          : skillRoots.map((root) => join(root, event.name, "SKILL.md"));
      let text: string | null = null;
      for (const path of paths) if (!text && !seen.has(path)) text = await currentText(path);
      for (const path of paths) seen.add(path);
      if (text) rules.push(...fileRules(text, `skill:${event.name}`, turnAt(event.at)));
    }
  }
  return rules;
}
