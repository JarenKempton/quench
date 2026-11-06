import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, win32 } from "node:path";
import type { SteeringFile } from "@quench/history";

export type RuleAt = {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
};

export type StaleReason = { name: string; kind: "file" | "command" | "script" };

const MIN_CHARS = 20;
const MIN_ACTION_WORDS = 3;
const NEGATION = /\b(?:never|not|no|don t|dont|avoid|without|stop)\b/;
const MODAL = /\b(?:never|not|no|don t|dont|do|avoid|without|stop|always|must|should|please)\b/g;
const FILE_TYPES = new Set(
  "md ts tsx js jsx mjs cjs json jsonl yml yaml toml sh ps1 py rb go rs lock txt sql css html".split(
    " ",
  ),
);
const RUNNERS = new Set(["bun", "npm", "pnpm", "yarn"]);

export const normal = (text: string) =>
  text
    .toLowerCase()
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const isGlobal = (file: SteeringFile) => file.sources.some((s) => s.scope === "user");

const located = (file: SteeringFile) =>
  file.rules.map((rule) => ({ ...rule, path: file.sources[0]!.realPath }));

export const fold = (path: string) =>
  process.platform === "darwin" || process.platform === "win32" ? path.toLowerCase() : path;

export type FileLocation = { realPath: string; path: string; global: boolean };

export function fileLocations(file: SteeringFile): FileLocation[] {
  const locations = new Map<string, FileLocation>();
  for (const source of file.sources) {
    const key = fold(source.realPath);
    const known = locations.get(key);
    locations.set(key, {
      realPath: source.realPath,
      path: known?.path ?? source.path,
      global: (known?.global ?? false) || source.scope === "user",
    });
  }
  return [...locations.values()];
}

const everyLocation = (file: SteeringFile) =>
  fileLocations(file).flatMap((location) =>
    file.rules.map((rule) => ({ ...rule, path: location.realPath, global: location.global })),
  );

const codeSpans = (text: string) =>
  [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!.trim()).filter(Boolean);

const at = ({ global: _, ...rule }: RuleAt & { global: boolean }): RuleAt => rule;

export function duplicateRules(files: SteeringFile[]): RuleAt[][] {
  const groups = new Map<string, { paths: Set<string>; rules: RuleAt[] }>();
  for (const file of files)
    for (const rule of everyLocation(file)) {
      const key = normal(rule.text);
      if (key.length < MIN_CHARS) continue;
      const group = groups.get(key) ?? groups.set(key, { paths: new Set(), rules: [] }).get(key)!;
      group.paths.add(fold(rule.path));
      group.rules.push(at(rule));
    }
  return [...groups.values()].filter((g) => g.paths.size > 1).map((g) => g.rules);
}

export function conflictingRules(files: SteeringFile[]): { global: RuleAt; project: RuleAt }[] {
  const rules = files.flatMap(everyLocation);
  const global = rules.filter((r) => r.global);
  const project = rules.filter((r) => !r.global);
  const negated = (rule: RuleAt) => NEGATION.test(normal(rule.text));
  const core = (rule: RuleAt) => normal(rule.text).replace(MODAL, " ").replace(/\s+/g, " ").trim();
  return global.flatMap((g) =>
    project
      .filter(
        (p) =>
          negated(g) !== negated(p) &&
          core(g).split(" ").length >= MIN_ACTION_WORDS &&
          core(g) === core(p),
      )
      .map((p) => ({ global: at(g), project: at(p) })),
  );
}

export async function staleRules(
  files: SteeringFile[],
  context: { homeDir: string; project: string; top: string },
): Promise<(RuleAt & { missing: StaleReason[] })[]> {
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
    const scripts = isGlobal(file) ? null : await scriptsFor(file, context.top);
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
      : isAbsolute(span) || win32.isAbsolute(span)
        ? [span]
        : bases.map((base) => join(base, span));
    if (!candidates.length) return null;
    for (const path of candidates) if (await stat(path).catch(() => null)) return null;
    return { name: span, kind: "file" };
  }
  const [program, sub, script] = words as [string, string, string | undefined];
  if (!/^[a-z][\w.-]*$/.test(program) || !/^[\w-]/.test(sub)) return null;
  if (!Bun.which(program)) return { name: program, kind: "command" };
  if (scripts && RUNNERS.has(program) && sub === "run" && script)
    if (/^[\w:.-]+$/.test(script) && !scripts.has(script))
      return { name: `${program} run ${script}`, kind: "script" };
  return null;
}

function pathLike(span: string): boolean {
  const path = span.replace(/^[A-Za-z]:(?=[\\/])/, "");
  if (/[\s*?<>{}@:|$"'()[\],=]/.test(path) || span.includes("://")) return false;
  const extension = /\.([A-Za-z0-9]+)$/.exec(span)?.[1]?.toLowerCase();
  const stem = span.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
  return Boolean(extension && FILE_TYPES.has(extension) && stem);
}

async function scriptsFor(file: SteeringFile, top: string): Promise<Set<string> | null> {
  const manifests = new Set<string | null>();
  for (const source of file.sources)
    manifests.add(await nearestManifest(dirname(source.path), top));
  const [manifest] = manifests;
  if (manifests.size !== 1 || !manifest) return null;
  const parsed = (await Bun.file(manifest)
    .json()
    .catch(() => null)) as { scripts?: Record<string, unknown> } | null;
  return parsed ? new Set(Object.keys(parsed.scripts ?? {})) : null;
}

async function nearestManifest(dir: string, top: string): Promise<string | null> {
  for (let at = dir; ; at = dirname(at)) {
    const inside = relative(top, at);
    if (inside.startsWith("..") || isAbsolute(inside)) return null;
    const manifest = join(at, "package.json");
    if (await Bun.file(manifest).exists()) return manifest;
    if (!inside) return null;
  }
}
