import { stat } from "node:fs/promises";
import {
  harnessById,
  harnesses,
  shellFor,
  skillFolder,
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
import { placeCache } from "../cache.ts";
import { reading } from "../progress.ts";
import { json, median, projectName } from "../format.ts";
import { repeatedFailures } from "../profile/recorded-failures.ts";
import { recordedFiles } from "../profile/recorded-instructions.ts";
import { mcpDuplicates } from "../profile/mcp-duplicates.ts";
import { mcpUse } from "../profile/recorded-mcp.ts";
import { mcpToolRecords } from "../profile/recorded-mcp-tools.ts";
import { skillUse, type PlaceOrigin } from "../profile/recorded-skills.ts";
import { gitDirOf, guardedCut } from "../profile/skill-guard.ts";
import { gitDiscovery, trackedInRepo } from "../profile/skill-repos.ts";
import { skillCuts } from "../profile/skill-cuts.ts";
import { startSplit } from "../profile/recorded-start.ts";
import { render, type Profile, type ProfiledProject, type View } from "../profile/render.ts";
import { splitInstructions, splitSkills, type InstructionFile } from "../profile/setup.ts";

export { HOME_FLAGS, SECTIONS } from "../profile/render.ts";

const LIMITATIONS = [
  "Worktrees and subdirectories of one git repository are grouped under its main checkout.",
  "Instructions are current files in each project's most recently used directory, not proof of what a past session loaded; other worktrees may differ.",
  "Recorded instructions are the text each session's history logged injecting, global files included. Older harness versions recorded none, so a missing record is unknown, not zero. Codex records one combined block per directory without file boundaries.",
  "A recorded file is the same as disk now when its hash matches the file's text exactly, or with one final newline removed as Claude Code does. Anything else differs: usually the file changed since, possibly other processing by the harness.",
  "Skills are SKILL.md folders in each agent's documented locations on disk now. Up-front size is name plus description before each agent's own caps and budgets; bodies load on demand. Built-in and plugin skills, managed and /etc locations, and Codex agents/openai.yaml policies are not read. Codex and Pi project trust is approximated from user config, or assumed for Pi.",
  "Recorded skills are the skill lists session histories logged: Claude Code's listing, Codex's skills block and Pi's skills section. Listing size is the first listing in each session. Use counts sessions where the model invoked a listed skill (Claude Code's Skill tool), read its SKILL.md, or ran a shell command or code naming that exact listed path, or the user ran it as a command. Relative paths are not resolved, so shell-based use (how Codex loads skills) is a lower bound, and a command editing the file counts too.",
  "Skill sources: Claude Code records skill names only, so a name is matched to its user or project folder on disk now, then to Claude Code's own skills, then to an installed plugin by its prefix. Codex and Pi record each skill's file, so its path decides the source. Codex plugins installed by default come from the remote plugin catalog Codex caches locally. A skill found nowhere on disk now is not on disk now: removed since, or loaded from a place Quench does not read. Built-in skills are left out of never used and the cut list.",
  "The cut list groups never-used skills by what removes them: a plugin or a skill folder. Listed is the characters of each skill's own entry in the recorded listings, summed over every session that listed the target; sessions whose listing has no per-skill text make the size a lower bound, or unknown when none has it, and rank after known sizes. A target any agent still uses, or one whose use an agent does not record, gets no command. Commands are written for this machine's shell, carry an overridden agent home, and are shown, never run. A project skill whose SKILL.md, or folder link, git tracks is one target per repository and path inside it, counted across every worktree; it gets no command, since removing it is a change to the repository. Any other folder is its own target. Folders never get a delete command, only the path to remove and the git work tree it is in. The only commands are Codex plugin removal and removing a symlink itself, and the symlink one only when git confirms the link is outside every work tree; any git error leaves it out. Claude Code names are matched to a user folder first, then the project folder nearest the session's directory.",
  "MCP servers called are the server names in MCP tool calls sessions recorded: Claude Code's mcp__server__tool calls and Codex's direct or code-mode tools.mcp__server__tool calls. In local config means a configured server of the same agent has the same name, ignoring case and punctuation; anything else came from an account connector, a plugin, a server the host app passed in (such as --mcp-config), or config since removed.",
  "Repeated failures are tool results a session recorded as errors, grouped per project by kind and by what failed: the missing path or command named in the error text, the read path, or the command's program and subcommand. Kind comes from the first 4,000 characters of the error text. Codex records no error flag, so its failures are commands whose script printed a nonzero exit code, a lower bound. A nonzero exit is not always a mistake (grep finding nothing exits 1). Output is the failed results' size; the tokens of the turns around them are not counted. Shown when a failure happened at least 3 times or in 2 sessions.",
  "MCP servers are entries in each agent's config files, shown by name, transport and command name or URL host only; arguments, environment, headers and full URLs are never read out. Duplicates are servers of one agent, in effect for the same project, with the same URL (ignoring query) or the same command and arguments, compared by fingerprint. Plugin and managed servers are not read.",
  "MCP tool definitions are what session history recorded at the first request: tool count and the JSON size of each schema, per server, from the latest session that recorded it. Up front means the request carried the schemas; deferred means the harness listed the tools by name for tool search, so schemas load on demand and are not starting load, and Claude Code records no schema for them. A server no session recorded is not recorded, never estimated; servers are matched to config by name, ignoring case and punctuation.",
];

export async function profile(
  home: Home,
  options: { days: number; scan: string[]; json: boolean; view: View; cache: boolean },
): Promise<number> {
  const since = new Date(Date.now() - options.days * 86_400_000);
  const cache = options.cache ? await placeCache(home.dir) : undefined;
  const { places, unreadable } = await sessionPlaces(home, since, reading(), cache);
  await cache?.save();
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
  const skills = skillUse(places, await placeOrigins(home, places, globalSkills));
  const git = await gitDiscovery(
    skills.occurrences.flatMap((o) =>
      o.origin.kind === "folder" && !o.origin.repo ? [gitDirOf(o.origin)] : [],
    ),
  );
  const configuredMcp = [...globalMcp.values(), ...profiled.flatMap((p) => p.mcpServers)];
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
    recordedSkills: skills.uses,
    recordedSkillCuts: skillCuts(
      skills.occurrences,
      (id) => harnessById[id].skillUse,
      (id, origin) =>
        guardedCut(harnessById[id].skillCut(origin, { home, shell: shellFor() }), origin, git),
    ),
    recordedMcp: mcpUse(places, configuredMcp),
    recordedMcpTools: mcpToolRecords(places, configuredMcp),
    duplicateMcpServers: mcpDuplicates(
      [...globalMcp.values()],
      profiled.map((p) => ({ name: projectName(p.root, home.dir), mcpServers: p.mcpServers })),
    ),
    recordedFailures: repeatedFailures(found.placesByRoot),
    recordedStart: startSplit(places),
    projects: profiled,
    missingDirectories: found.missing,
    limitations: [
      `Projects come from the working directories of sessions modified in the last ${options.days} days, plus --scan; projects with no recent sessions are not found.`,
      ...LIMITATIONS,
    ],
  };
  process.stdout.write(
    options.json ? json(result) : render(result, home.dir, options.view).join("\n") + "\n",
  );
  return 0;
}

async function placeOrigins(
  home: Home,
  places: readonly SessionPlace[],
  globalSkills: Map<string, Skill>,
): Promise<PlaceOrigin> {
  const origins = new Map(
    await Promise.all(harnesses.map(async (h) => [h.id, await h.skillOrigins(home)] as const)),
  );
  const global = [...globalSkills.values()];
  const byDirectory = new Map<string, Promise<Skill[]>>();
  const inventory = (cwd: string) =>
    byDirectory.get(cwd) ??
    byDirectory
      .set(
        cwd,
        stat(cwd).then(
          () => skillInventory(home, cwd).then((found) => found.skills),
          () => global,
        ),
      )
      .get(cwd)!;
  const onDisk = new Map<SessionPlace, Skill[]>();
  for (const place of places)
    if (place.skills) onDisk.set(place, place.cwd ? await inventory(place.cwd) : global);
  const repos = await trackedInRepo(
    [...onDisk.values()].flatMap((skills) =>
      skills.flatMap((s) =>
        s.sources.flatMap((source) =>
          source.scope === "project" || source.scope === "ancestor"
            ? [skillFolder(source.path)]
            : [],
        ),
      ),
    ),
  );
  return (place, skill) => {
    const origin = origins.get(place.harness)!(skill, onDisk.get(place) ?? global);
    if (origin.kind !== "folder") return origin;
    const repo = repos.get(origin.path);
    return repo ? { ...origin, repo } : origin;
  };
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
