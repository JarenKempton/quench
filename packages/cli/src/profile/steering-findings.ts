import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { SteeringFile } from "@quench/history";

export type RuleAt = {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
};

export type StaleReason = { name: string; kind: "file" | "command" | "script" };

const MIN_CHARS = 20;
const NEGATION = /\b(?:never|not|no|don t|dont|avoid|without|stop)\b/;
const MODAL = /\b(?:never|not|no|don t|dont|do|avoid|without|stop|always|must|should|please)\b/g;
const FILE_TYPES = new Set(
  "md ts tsx js jsx mjs cjs json jsonl yml yaml toml sh ps1 py rb go rs lock txt sql css html".split(
    " ",
  ),
);
const RUNNERS = new Set(["bun", "npm", "pnpm", "yarn"]);

const normal = (text: string) =>
  text
    .toLowerCase()
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const isGlobal = (file: SteeringFile) => file.sources.some((s) => s.scope === "user");

const located = (file: SteeringFile) =>
  file.rules.map((rule) => ({ ...rule, path: file.sources[0]!.realPath }));

const codeSpans = (text: string) =>
  [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!.trim()).filter(Boolean);

export function duplicateRules(files: SteeringFile[]): RuleAt[][] {
  const groups = new Map<string, { ids: Set<string>; rules: RuleAt[] }>();
  for (const file of files)
    for (const rule of located(file)) {
      const key = normal(rule.text);
      if (key.length < MIN_CHARS) continue;
      const group = groups.get(key) ?? groups.set(key, { ids: new Set(), rules: [] }).get(key)!;
      group.ids.add(file.id);
      group.rules.push(rule);
    }
  return [...groups.values()].filter((g) => g.ids.size > 1).map((g) => g.rules);
}

export function conflictingRules(files: SteeringFile[]): { global: RuleAt; project: RuleAt }[] {
  const global = files.filter(isGlobal).flatMap(located);
  const project = files.filter((f) => !isGlobal(f)).flatMap(located);
  const negated = (rule: RuleAt) => NEGATION.test(normal(rule.text));
  const core = (rule: RuleAt) => normal(rule.text).replace(MODAL, " ").replace(/\s+/g, " ").trim();
  return global.flatMap((g) =>
    project
      .filter((p) => {
        if (negated(g) === negated(p)) return false;
        if (core(g).length >= MIN_CHARS && core(g) === core(p)) return true;
        const spans = new Set(codeSpans(g.text).filter((s) => s.length > 2));
        return codeSpans(p.text).some((s) => spans.has(s));
      })
      .map((p) => ({ global: g, project: p })),
  );
}

export async function staleRules(
  files: SteeringFile[],
  context: { homeDir: string; project: string; top: string },
): Promise<(RuleAt & { missing: StaleReason[] })[]> {
  const scripts = await packageScripts(context.top);
  const found: (RuleAt & { missing: StaleReason[] })[] = [];
  for (const file of files) {
    const bases = isGlobal(file)
      ? []
      : [
          ...new Set([
            ...file.sources.flatMap((s) => [dirname(s.path), dirname(s.realPath)]),
            context.project,
            context.top,
          ]),
        ];
    for (const rule of located(file)) {
      const missing: StaleReason[] = [];
      for (const span of new Set(codeSpans(rule.text))) {
        const reason = await staleSpan(span, bases, scripts, context.homeDir);
        if (reason && !missing.some((m) => m.name === reason.name)) missing.push(reason);
      }
      if (missing.length) found.push({ ...rule, missing });
    }
  }
  return found;
}

async function staleSpan(
  span: string,
  bases: string[],
  scripts: Set<string> | null,
  homeDir: string,
): Promise<StaleReason | null> {
  const words = span.split(/\s+/);
  if (words.length === 1) {
    if (!pathLike(span)) return null;
    const home = /^~[\\/]/.test(span);
    const candidates = home
      ? [join(homeDir, span.slice(2))]
      : isAbsolute(span)
        ? [span]
        : bases.map((base) => join(base, span));
    if (!candidates.length) return null;
    for (const path of candidates) if (await stat(path).catch(() => null)) return null;
    return { name: span, kind: "file" };
  }
  const [program, sub, script] = words as [string, string, string | undefined];
  if (!/^[a-z][\w.-]*$/.test(program) || !/^[\w-]/.test(sub)) return null;
  if (!Bun.which(program)) return { name: program, kind: "command" };
  if (bases.length && scripts && RUNNERS.has(program) && sub === "run" && script)
    if (/^[\w:.-]+$/.test(script) && !scripts.has(script))
      return { name: `${program} run ${script}`, kind: "script" };
  return null;
}

function pathLike(span: string): boolean {
  if (/[\s*?<>{}@:|$"'()[\],=]/.test(span) || span.includes("://")) return false;
  const extension = /\.([A-Za-z0-9]+)$/.exec(span)?.[1]?.toLowerCase();
  const stem = span.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
  return Boolean(extension && FILE_TYPES.has(extension) && stem);
}

async function packageScripts(top: string): Promise<Set<string> | null> {
  const manifest = (await Bun.file(join(top, "package.json"))
    .json()
    .catch(() => null)) as { scripts?: Record<string, unknown> } | null;
  return manifest ? new Set(Object.keys(manifest.scripts ?? {})) : null;
}
