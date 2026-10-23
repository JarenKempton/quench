import { stat } from "node:fs/promises";
import {
  harnesses,
  linkedWorktrees,
  mcpInventory,
  projects,
  sessionPlaces,
  skillInventory,
  steeringInventory,
  usedIn,
  type Home,
  type McpServer,
  type Project,
  type SessionPlace,
  type Skill,
} from "@quench/history";
import { json, median } from "../format.ts";
import { recordedFiles } from "../profile/recorded-instructions.ts";
import { mcpUse } from "../profile/recorded-mcp.ts";
import { skillUse } from "../profile/recorded-skills.ts";
import { render, type Profile, type ProfiledProject } from "../profile/render.ts";
import { splitInstructions, splitSkills, type InstructionFile } from "../profile/setup.ts";

export { HOME_FLAGS } from "../profile/render.ts";

const LIMITATIONS = [
  "Worktrees and subdirectories of one git repository are grouped under its main checkout.",
  "Instructions are current files in each project's most recently used directory, not proof of what a past session loaded; other worktrees may differ.",
  "Recorded instructions are the text each session's history logged injecting, global files included. Older harness versions recorded none, so a missing record is unknown, not zero. Codex records one combined block per directory without file boundaries.",
  "A recorded file is the same as disk now when its hash matches the file's text exactly, or with one final newline removed as Claude Code does. Anything else differs: usually the file changed since, possibly other processing by the harness.",
  "Skills are SKILL.md folders in each agent's documented locations on disk now. Up-front size is name plus description before each agent's own caps and budgets; bodies load on demand. Built-in and plugin skills, managed and /etc locations, and Codex agents/openai.yaml policies are not read. Codex and Pi project trust is approximated from user config, or assumed for Pi.",
  "Recorded skills are the skill lists session histories logged: Claude Code's listing, Codex's skills block and Pi's skills section. Listing size is the first listing in each session. Use counts sessions where the model invoked a listed skill (Claude Code's Skill tool), read its SKILL.md, or ran a shell command or code naming that exact listed path, or the user ran it as a command. Relative paths are not resolved, so shell-based use (how Codex loads skills) is a lower bound, and a command editing the file counts too.",
  "MCP servers called are the server names in MCP tool calls sessions recorded: Claude Code's mcp__server__tool calls and Codex's direct or code-mode tools.mcp__server__tool calls. In local config means a configured server of the same agent has the same name, ignoring case and punctuation; anything else came from an account connector, a plugin, a server the host app passed in (such as --mcp-config), or config since removed.",
  "MCP servers are entries in each agent's config files, shown by name, transport and command name or URL host only; arguments, environment, headers and full URLs are never read out. Tool definitions need a live connection and are not counted. Plugin and managed servers are not read.",
];

export async function profile(
  home: Home,
  options: { days: number; scan: string[]; json: boolean },
): Promise<number> {
  const since = new Date(Date.now() - options.days * 86_400_000);
  const { places, unreadable } = await sessionPlaces(home, since);
  let found: Awaited<ReturnType<typeof projects>>;
  try {
    found = await projects(places, options.scan);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const globalInstructions = new Map<string, InstructionFile>();
  const globalSkills = new Map<string, Skill>();
  const globalMcp = new Map<string, McpServer>();
  const profiled: ProfiledProject[] = [];
  for (const project of found.projects) {
    const shared = await profileProject(home, project, found.placesByRoot.get(project.root) ?? []);
    for (const file of shared.instructions) globalInstructions.set(file.id, file);
    for (const skill of shared.skills) globalSkills.set(skill.realPath, skill);
    for (const server of shared.mcpServers)
      globalMcp.set(`${server.harness}\0${server.name}`, server);
    profiled.push(shared.project);
  }
  const result: Profile & { observedAt: string; limitations: string[] } = {
    observedAt: new Date().toISOString(),
    days: options.days,
    homes: await Promise.all(
      harnesses.map(async (h) => ({
        harness: h.id,
        path: home.of(h.home),
        found: (await stat(home.of(h.home)).catch(() => null))?.isDirectory() ?? false,
        sessions: places.filter((p) => p.harness === h.id).length,
      })),
    ),
    unreadable,
    globalInstructions: [...globalInstructions.values()],
    globalSkills: [...globalSkills.values()],
    globalMcpServers: [...globalMcp.values()],
    recordedInstructions: await recordedFiles(places),
    recordedSkills: skillUse(places),
    recordedMcp: mcpUse(places, [...globalMcp.values(), ...profiled.flatMap((p) => p.mcpServers)]),
    projects: profiled,
    missingDirectories: found.missing,
    limitations: [
      `Projects come from the working directories of sessions modified in the last ${options.days} days, plus --scan; projects with no recent sessions are not found.`,
      ...LIMITATIONS,
    ],
  };
  process.stdout.write(options.json ? json(result) : render(result, home.dir).join("\n") + "\n");
  return 0;
}

async function profileProject(home: Home, project: Project, places: SessionPlace[]) {
  const directory = project.directories[0]?.path ?? project.root;
  const steering = await steeringInventory(home, directory);
  const skills = await skillInventory(home, directory);
  const mcp = await mcpInventory(home, directory);
  const instructions = splitInstructions(steering.files);
  const skillSplit = splitSkills(skills.skills);
  const loads = places.flatMap((p) =>
    p.instructions ? [p.instructions.reduce((n, f) => n + f.textChars, 0)] : [],
  );
  const linked = project.git ? await linkedWorktrees(project.root) : null;
  const directories = project.directories.map((d) => d.path);
  return {
    instructions: instructions.global,
    skills: skillSplit.global,
    mcpServers: mcp.servers.filter((s) => s.scope === "user"),
    project: {
      ...project,
      instructions: { directory, files: instructions.local },
      recordedLoad: { sessions: loads.length, medianChars: median(loads) },
      worktrees: linked && {
        linked: linked.length,
        idle: linked.filter((w) => !w.missing && !usedIn(w.path, directories)).length,
        missing: linked.filter((w) => w.missing).length,
      },
      skills: skillSplit.local,
      mcpServers: mcp.servers.filter((s) => s.scope !== "user"),
      warnings: [...steering.warnings, ...skills.warnings, ...mcp.warnings],
    },
  };
}
