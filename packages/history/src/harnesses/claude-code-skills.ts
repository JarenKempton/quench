import { join } from "node:path";
import { readJson, record } from "../mcp.ts";
import {
  folderCut,
  folderOrigin,
  notFound,
  type CutContext,
  type OriginOf,
  type SkillCut,
  type SkillOrigin,
} from "../skill-origin.ts";

const BUILT_IN = new Set([
  "artifact-capabilities",
  "artifact-design",
  "artifact-diagramming",
  "claude-api",
  "claude-in-chrome",
  "code-review",
  "dataviz",
  "fewer-permission-prompts",
  "init",
  "keybindings-help",
  "loop",
  "plugin-authoring",
  "run",
  "schedule",
  "security-review",
  "simplify",
  "update-config",
  "workflow-authoring",
]);

export async function claudeSkillOrigins(configDir: string): Promise<OriginOf> {
  const installed = record(
    await readJson(join(configDir, "plugins/installed_plugins.json")).catch(() => null),
  );
  const settings = record(await readJson(join(configDir, "settings.json")).catch(() => null));
  const plugins = [
    ...Object.keys(record(installed.plugins)),
    ...Object.keys(record(settings.enabledPlugins)),
  ];
  return (skill, onDisk) => {
    const folder = folderOrigin("claude-code", skill, onDisk);
    if (folder) return folder;
    if (BUILT_IN.has(skill.name)) return { kind: "built-in" };
    const [prefix, rest] = skill.name.split(":");
    if (!rest) return notFound(skill);
    const plugin = plugins.find((id) => id.split("@")[0] === prefix);
    return plugin
      ? { kind: "plugin", plugin, installedByDefault: false }
      : notFound(skill, prefix ?? null);
  };
}

export function claudeSkillCut(origin: SkillOrigin, { shell }: CutContext): SkillCut {
  if (origin.kind === "built-in") return { command: null, note: "built into Claude Code" };
  if (origin.kind !== "plugin") return folderCut(origin, shell)!;
  return { command: null, note: `disable ${origin.plugin} from /plugin in Claude Code` };
}
