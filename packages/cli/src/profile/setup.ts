import {
  harnessById,
  type HarnessId,
  type McpServer,
  type Skill,
  type SteeringFile,
} from "@quench/history";
import { chars, count, projectName, table } from "../format.ts";

export type InstructionFile = Omit<SteeringFile, "rules"> & { rules: number };

export function splitInstructions(files: SteeringFile[]) {
  const global: InstructionFile[] = [];
  const local: InstructionFile[] = [];
  for (const file of files) {
    const summary = { ...file, rules: file.rules.length };
    const user = file.sources.filter((s) => s.scope === "user");
    const other = file.sources.filter(
      (s) => s.scope !== "user" && !user.some((u) => u.realPath === s.realPath),
    );
    if (user.length) global.push({ ...summary, sources: user });
    if (other.length) local.push({ ...summary, sources: other });
  }
  return { global, local };
}

export function splitSkills(skills: Skill[]) {
  const global: Skill[] = [];
  const local: Skill[] = [];
  for (const skill of skills) {
    const shared = skill.sources.filter((s) => s.scope === "user" || s.scope === "system");
    const own = skill.sources.filter((s) => !shared.includes(s));
    if (shared.length) global.push({ ...skill, sources: shared });
    if (own.length) local.push({ ...skill, sources: own });
  }
  return { global, local };
}

export function skillsCell(skills: Skill[], harness: HarnessId): string {
  const visible = skills.filter(
    (s) => s.modelInvocable && s.sources.some((source) => source.harness === harness),
  );
  if (!visible.length) return "0";
  return `${count(visible.length)} · ${chars(visible.reduce((n, s) => n + s.indexChars, 0))}`;
}

export function renderMcpServers(
  global: McpServer[],
  projects: { root: string; mcpServers: McpServer[] }[],
  homeDir: string,
): string[] {
  const servers = [
    ...global.map((s) => ({ ...s, where: "all projects" })),
    ...projects.flatMap((p) =>
      p.mcpServers.map((s) => ({ ...s, where: projectName(p.root, homeDir) })),
    ),
  ];
  if (!servers.length) return [];
  return [
    "",
    "MCP servers · configured on disk now · tool definitions not counted",
    ...table([
      ["Server", "Agent", "Scope", "Transport", "Target", "State", "Where"],
      ...servers.map((s) => [
        s.name,
        harnessById[s.harness].label,
        s.scope,
        s.transport,
        s.target ?? "—",
        s.enabled === null ? "needs approval" : s.enabled ? "on" : "off",
        s.where,
      ]),
    ]),
  ];
}
