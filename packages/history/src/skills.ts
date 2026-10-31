import { readdir, realpath, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { harnesses } from "./harnesses/index.ts";
import type { Home } from "./home.ts";
import type { HarnessId } from "./model.ts";

export type SkillRoot = {
  path: string;
  scope: "user" | "system" | "project" | "ancestor";
  layout: "folders" | "nested" | "commands";
};

export type Skill = {
  name: string;
  description: string;
  indexChars: number;
  bodyBytes: number;
  modelInvocable: boolean;
  realPath: string;
  sources: { harness: HarnessId; path: string; scope: SkillRoot["scope"] }[];
};

export async function skillInventory(home: Home, project: string) {
  const skills = new Map<string, Skill>();
  const warnings: string[] = [];
  for (const harness of harnesses)
    for (const root of await harness.skills(home, project))
      for (const path of root.layout === "commands"
        ? await commandFiles(root.path, 3)
        : await skillFiles(root.path, root.layout === "nested" ? 3 : 0)) {
        const real = await realpath(path).catch(() => path);
        const known = skills.get(real);
        const source = { harness: harness.id, path, scope: root.scope };
        if (known) {
          if (!known.sources.some((s) => s.harness === harness.id && s.path === path))
            known.sources.push(source);
          continue;
        }
        const name =
          root.layout === "commands"
            ? relative(root.path, path).replace(/\.md$/, "").replaceAll(/[\\/]/g, ":")
            : null;
        const skill = await readSkill(path, real, name).catch((error: Error) => {
          warnings.push(`${path}: ${error.message}`);
          return null;
        });
        if (skill) skills.set(real, { ...skill, sources: [source] });
      }
  return { skills: [...skills.values()], warnings };
}

async function skillFiles(root: string, depth: number): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const found = await Promise.all(
    entries.map(async (entry) => {
      if (entry.name.startsWith(".") || entry.name === "node_modules") return [];
      const dir = join(root, entry.name);
      const file = join(dir, "SKILL.md");
      if ((await stat(file).catch(() => null))?.isFile()) return [file];
      return depth > 0 && (await stat(dir).catch(() => null))?.isDirectory()
        ? skillFiles(dir, depth - 1)
        : [];
    }),
  );
  return found.flat().sort();
}

async function commandFiles(dir: string, depth: number): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const found = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      const info = await stat(path).catch(() => null);
      if (info?.isFile()) return entry.name.endsWith(".md") ? [path] : [];
      return info?.isDirectory() && depth > 0 ? commandFiles(path, depth - 1) : [];
    }),
  );
  return found.flat().sort();
}

async function readSkill(
  path: string,
  realPath: string,
  commandName: string | null,
): Promise<Omit<Skill, "sources">> {
  const text = await Bun.file(path).text();
  const meta = frontmatter(text);
  const name =
    commandName ?? (typeof meta.name === "string" ? meta.name : basename(join(path, "..")));
  const description =
    typeof meta.description === "string"
      ? meta.description.trim()
      : commandName === null
        ? ""
        : firstLine(text);
  return {
    name,
    description,
    indexChars: name.length + description.length,
    bodyBytes: Buffer.byteLength(text),
    modelInvocable: meta["disable-model-invocation"] !== true,
    realPath,
  };
}

function frontmatter(text: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/.exec(text);
  if (!match) return {};
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(match[1]!);
  } catch {
    return plainFields(match[1]!);
  }
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

function plainFields(yaml: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [, key, value] of yaml.matchAll(/^([A-Za-z][\w-]*):[ \t]*(.*)$/gm))
    fields[key!] = value === "true" ? true : value === "false" ? false : value!.trim();
  return fields;
}

const firstLine = (text: string) =>
  text
    .replace(/^---\r?\n[\s\S]*?\r?\n---\s*(\r?\n|$)/, "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? "";
