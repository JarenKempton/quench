import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  discoverAll,
  harnessById,
  readSessions,
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
  type SkillAsk,
} from "@quench/history";
import { openT3History, t3State } from "@quench/history/hosts/t3";
import {
  askInput,
  type AskStatus,
  JevAsks,
  judgeAsks,
  KeyRejected,
  ThemeCache,
  type AskInput,
} from "@quench/judge";
import { storedCredentials } from "@quench/secrets";
import { placeCache } from "../cache.ts";
import { reading } from "../progress.ts";
import { json, median, projectName } from "../format.ts";
import { repeatedFailures } from "../profile/recorded-failures.ts";
import { recordedFiles } from "../profile/recorded-instructions.ts";
import { claudeConfigHomes, projectHookScripts } from "../profile/config-homes.ts";
import { judgeChoice, readConfig, typesafeKey } from "../config.ts";
import { mcpDuplicates } from "../profile/mcp-duplicates.ts";
import { nextSteps } from "../profile/next-steps.ts";
import { mcpUse } from "../profile/recorded-mcp.ts";
import { mcpToolRecords } from "../profile/recorded-mcp-tools.ts";
import { skillUse, type PlaceOrigin } from "../profile/recorded-skills.ts";
import { trackedInRepo } from "../profile/skill-repos.ts";
import { skillCuts } from "../profile/skill-cuts.ts";
import {
  askedFor,
  relayedFor,
  personOneWord,
  skillAsks,
  askVocabulary,
  inventories,
  type AskVerdicts,
  type Inventory,
} from "../profile/skill-asks.ts";
import { startSplit } from "../profile/recorded-start.ts";
import { render, type Profile, type ProfiledProject, type View } from "../profile/render.ts";
import { splitInstructions, splitSkills, type InstructionFile } from "../profile/setup.ts";

export { HOME_FLAGS, SECTIONS } from "../profile/render.ts";

const LIMITATIONS = [
  "Hooks or status lines that can't run are Claude Code hook and statusLine commands in each Claude home's settings.json and settings.local.json whose script path (the first word, or the one after bash, sh, node, bun, python and similar) is absolute or starts with ~ or $HOME and does not exist, or whose every line is a # comment. Commands found on PATH and project settings are not checked.",
  'Kept running after a timeout counts Claude Code Bash results that say the command did not complete within its timeout and was moved to the background. Re-run before done counts a later command with exactly the same text, started before Claude Code recorded a notification that the first finished or the agent stopped it; a session that ended first counts as never finished. A re-run with any change in text is not counted, so this is a lower bound. The command key ignores cd, export, echo and output filters such as head, tail and jq around one main command; any other chain is "several commands", shown with the top 3 known commands found in its chains. Codex and Pi record no such result.',
  "Stored credentials are the high-confidence secrets quench secrets finds in harness settings, MCP config and prompt history files of your home and the projects profiled here, each value counted once; values, prefixes and tags are never shown. Session transcripts and repo git history are not scanned for it, and quench secrets may cover other projects.",
  "Worktrees and subdirectories of one git repository are grouped under its main checkout.",
  "Instructions are current files in each project's most recently used directory, not proof of what a past session loaded; other worktrees may differ.",
  "Recorded instructions are the text each session's history logged injecting, global files included. Older harness versions recorded none, so a missing record is unknown, not zero. Codex records one combined block per directory without file boundaries.",
  "A recorded file is the same as disk now when its hash matches the file's text exactly, or with one final newline removed as Claude Code does. Anything else differs: usually the file changed since, possibly other processing by the harness.",
  "Skills are SKILL.md folders in each agent's documented locations on disk now. Up-front size is name plus description before each agent's own caps and budgets; bodies load on demand. Built-in and plugin skills, managed and /etc locations, and Codex agents/openai.yaml policies are not read. Codex and Pi project trust is approximated from user config, or assumed for Pi.",
  "Recorded skills are the skill lists session histories logged: Claude Code's listing, Codex's skills block and Pi's skills section. Listing size is the first listing in each session. Use counts sessions where the model invoked a listed skill (Claude Code's Skill tool), read its SKILL.md, or ran a shell command or code naming that exact listed path, or the user ran it as a command. Relative paths are not resolved, so shell-based use (how Codex loads skills) is a lower bound, and a command editing the file counts too.",
  "Skill sources: Claude Code records skill names only, so a name is matched to its user or project folder on disk now, then to Claude Code's own skills, then to an installed plugin by its prefix. Codex and Pi record each skill's file, so its path decides the source. Codex plugins installed by default come from the remote plugin catalog Codex caches locally. A skill found nowhere on disk now is not on disk now: removed since, or loaded from a place Quench does not read. Built-in skills are left out of never used and the cut list.",
  "The cut list groups never-used skills by what removes them: a plugin or a skill folder. Listed is the characters of each skill's own entry in the recorded listings, summed over every session that listed the target; sessions whose listing has no per-skill text make the size a lower bound, or unknown when none has it, and rank after known sizes. A target any agent still uses, or one whose use an agent does not record, gets no command. The Codex command is written for this machine's shell, carries an overridden CODEX_HOME, and is shown, never run. A project skill whose SKILL.md, or folder link, git tracks is one target per repository and path inside it, counted across every worktree; it gets no command, since removing it is a change to the repository. Any other folder is its own target. Folders and symlinks never get a command, only the path to remove; the only command is Codex plugin removal. Claude Code names are matched to a user folder first, then the project folder nearest the session's directory.",
  "Asked in plain words counts messages a person typed that name a skill: Claude Code prompts it recorded as typed, and on any agent messages T3 Code recorded as typed by you in its app. Messages an agent, automation or T3 itself sent are relayed and counted apart; Codex and Pi record no sender, so without T3 Code history their messages are sender unknown and never counted as asked. A name matches as words, hyphens read as spaces, a plugin prefix dropped, with one-letter typos or the same sound allowed in all but one of its words. A one-word name is not measured unless --asks has Jev judge each message that names it. Loaded means the skill loaded in the run that message started. Loaded also counts a Claude Code subagent or a T3 Code delegated thread that started during that run and loaded the skill; a subagent's own prompts count as relayed. Names come from the session's own listing and the skill folders on disk now for the session's folder. Skills asked for, not measured, or named by a sender Quench cannot identify are left out of the cut list; mentions only relayed by agents are not, and are shown beside the cut. Code, paths and URLs in a message are not matched. disable-model-invocation is read from SKILL.md and flagged for Claude Code only.",
  "MCP servers called are the server names in MCP tool calls sessions recorded: Claude Code's mcp__server__tool calls and Codex's direct or code-mode tools.mcp__server__tool calls. In local config means a configured server of the same agent has the same name, ignoring case and punctuation; anything else came from an account connector, a plugin, a server the host app passed in (such as --mcp-config), or config since removed.",
  "Blocked calls are tool results Claude Code recorded as refused by a hook or a permission rule (its permissionDecision, or toolDenialKind in older versions), grouped by the guard, taken only from recorded fields (a documented hook event when Claude Code records one, otherwise hook, permission rule or auto mode), and the command key. The refusal text is read only for the file name of the hook script it names, kept only when it matches a hook script configured in a Claude settings file; nothing else from it is kept. Claude Code versions that wrote neither field, Codex and Pi record no such marker, so their refusals are not counted as blocks.",
  'Repeated failures are tool results a session recorded as errors, grouped per project by kind, command key and error class. A command key is the program\'s file name when it is on a fixed list of common tools (any other program is "other command") and, for git, gh, bun, npm, pnpm, yarn, docker, kubectl, cargo, go, uv and pip, a subcommand from a fixed list; never flags, arguments or values. A command whose raw text contains &&, ;, | or a newline anywhere, quoted or not, is "several commands", shown with the top 3 known commands found in its chains. Calls that ran no shell command are keyed by tool name. The error class comes from a fixed list (auth failed, permission denied, timeout, network, not found, conflict, exit code N, other) matched on the raw result; no error or command text is stored, cached or shown. Kind comes from the first 4,000 characters of the error text. Codex records no error flag, so its failures are commands whose script printed a nonzero exit code, a lower bound. A nonzero exit is not always a mistake (grep finding nothing exits 1). Output is the failed results\' size; the tokens of the turns around them are not counted. Shown when a failure happened at least 3 times or in 2 sessions.',
  "MCP servers are entries in each agent's config files, shown by name, transport and command name or URL host only; arguments, environment, headers and full URLs are never read out. Duplicates are servers of one agent, in effect for the same project, with the same URL (ignoring query) or the same command and arguments, compared by fingerprint. Plugin and managed servers are not read.",
  "Do this next lists at most 5 measured cuts, ranked by characters × sessions: never-used skill targets with a known listing size and no use, and the largest recorded instruction file whose newest recorded copy is still on disk. A cut's characters per session is its listed total over the sessions that listed it; an instruction file's is the sizes sessions recorded loading it, summed and averaged, capped at the file's size on disk now, and trimming saves up to that; empty or unreadable files are left out. A command is shown only where one is safe, otherwise only what to remove. Duplicate MCP servers are not measured per session yet, and hook blocks are counted in calls, not characters, so neither appears.",
  "MCP tool definitions are what session history recorded at the first request: tool count and the JSON size of each schema, per server, from the latest session that recorded it. Up front means the request carried the schemas; deferred means the harness listed the tools by name for tool search, so schemas load on demand and are not starting load, and Claude Code records no schema for them. A server no session recorded is not recorded, never estimated; servers are matched to config by name, ignoring case and punctuation.",
];

export async function profile(
  home: Home,
  options: {
    days: number;
    scan: string[];
    json: boolean;
    view: View;
    cache: boolean;
    asks?: boolean;
    typesafeKey?: string | undefined;
    hostHistory?: string | false;
  },
): Promise<number> {
  const since = new Date(Date.now() - options.days * 86_400_000);
  const cache = options.cache ? await placeCache(home.dir) : undefined;
  const host =
    options.hostHistory === false ? null : openT3History(options.hostHistory ?? t3State(home));
  const inventory = inventories(home);
  const asking = askVocabulary(inventory, host !== null);
  let read: Awaited<ReturnType<typeof sessionPlaces>>;
  try {
    read = await sessionPlaces(home, since, reading(), cache, {
      vocabulary: asking.vocabulary,
      ...(host ? { enrich: host.enrich } : {}),
    });
  } finally {
    host?.close();
  }
  for (const warning of host?.warnings ?? []) process.stderr.write(`${warning}\n`);
  const { places, unreadable } = read;
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
  const skills = skillUse(places, await placeOrigins(home, places, globalSkills, inventory));
  let judged: Awaited<ReturnType<typeof askVerdicts>>;
  try {
    judged = await askVerdicts(home, places, since, options);
  } catch (error) {
    if (!(error instanceof KeyRejected)) throw error;
    process.stderr.write(`${error.message}. Check TYPESAFE_API_KEY has no extra characters.\n`);
    return 1;
  }
  const asks = skillAsks(
    places,
    [...globalSkills.values(), ...profiled.flatMap((p) => p.skills), ...asking.skills()],
    host?.delegates ?? new Map(),
    judged.verdict,
    judged.judge,
    judged.newlyJudged,
  );
  const configHomes = await claudeConfigHomes(home, since);
  const configuredMcp = [...globalMcp.values(), ...profiled.flatMap((p) => p.mcpServers)];
  const result: Omit<Profile, "nextSteps"> & {
    observedAt: string;
    limitations: string[];
  } = {
    observedAt: new Date().toISOString(),
    days: options.days,
    unjudged: await unjudged(home),
    homes: await Promise.all(
      harnesses.map(async (h) => ({
        harness: h.id,
        path: home.of(h.home),
        found: (await stat(home.of(h.home)).catch(() => null))?.isDirectory() ?? false,
        sessions: places.filter((p) => p.harness === h.id).length,
      })),
    ),
    claudeConfigHomes: configHomes,
    unreadable,
    globalInstructions: [...globalInstructions.values()],
    globalSkills: [...globalSkills.values()],
    globalMcpServers: [...globalMcp.values()],
    recordedInstructions: await recordedFiles(places),
    recordedSkills: skills.uses,
    recordedSkillCuts: skillCuts(
      skills.occurrences,
      (id) => harnessById[id].skillUse,
      (id, origin) => harnessById[id].skillCut(origin, { home, shell: shellFor() }),
      askedFor(asks),
      relayedFor(asks),
    ),
    recordedSkillAsks: asks,
    recordedMcp: mcpUse(places, configuredMcp),
    recordedMcpTools: mcpToolRecords(places, configuredMcp),
    duplicateMcpServers: mcpDuplicates(
      [...globalMcp.values()],
      profiled.map((p) => ({
        name: projectName(p.root, home.dir),
        mcpServers: p.mcpServers,
      })),
    ),
    recordedFailures: repeatedFailures(
      found.placesByRoot,
      new Set([
        ...configHomes.flatMap((h) => h.hookScripts),
        ...(await projectHookScripts(found.projects.map((p) => p.root))),
      ]),
    ),
    recordedStart: startSplit(places),
    projects: profiled,
    missingDirectories: found.missing,
    storedCredentials: await storedCredentials(
      home,
      profiled.map((p) => p.root),
    ),
    limitations: [
      `Projects come from the working directories of sessions modified in the last ${options.days} days, plus --scan; projects with no recent sessions are not found.`,
      ...LIMITATIONS,
    ],
  };
  const full = {
    ...result,
    nextSteps: await nextSteps(
      {
        cuts: result.recordedSkillCuts.cuts,
        instructions: result.recordedInstructions,
      },
      home.dir,
    ),
  };
  process.stdout.write(
    options.json ? json(full) : render(full, home.dir, options.view).join("\n") + "\n",
  );
  if (options.asks && !judged.judge)
    process.stderr.write(
      "Judging one-word skill names uses Jev. Set TYPESAFE_API_KEY to opt in; until then they are not measured.\n",
    );
  return 0;
}

async function askVerdicts(
  home: Home,
  places: readonly SessionPlace[],
  since: Date,
  options: { asks?: boolean; typesafeKey?: string | undefined },
): Promise<{
  verdict: AskVerdicts;
  judge: string | null;
  newlyJudged: number;
}> {
  const none = { verdict: () => null, judge: null, newlyJudged: 0 };
  if (!options.asks || !options.typesafeKey) return none;
  const wanted = new Map<string, SkillAsk[]>();
  for (const place of places) {
    const found = place.asks?.found.filter(personOneWord) ?? [];
    if (found.length) wanted.set(place.path, found);
  }
  const inputs = new Map<SkillAsk, AskInput>();
  const refs = (await discoverAll(home, since)).filter((ref) => wanted.has(ref.path));
  for await (const outcome of readSessions(refs, 4)) {
    if (!outcome.ok) continue;
    for (const ask of wanted.get(outcome.session.path) ?? []) {
      const event = outcome.session.events[ask.event];
      if (event?.type === "message") inputs.set(ask, askInput(ask.name, event.text));
    }
  }
  const judge = new JevAsks(options.typesafeKey);
  const cache = await ThemeCache.open<AskInput>(
    join(home.dir, ".quench/local/asks.jsonl"),
    JevAsks.id,
  );
  const asked = [...inputs];
  const result = await judgeAsks(
    asked.map(([, input]) => input),
    cache,
    judge,
  );
  const statuses = new Map<SkillAsk, AskStatus>(
    asked.map(([ask], i) => [ask, result.statuses[i]!]),
  );
  return {
    verdict: (_place, ask) => statuses.get(ask) ?? "pending",
    judge: JevAsks.id,
    newlyJudged: result.newlyJudged,
  };
}

export async function placeOrigins(
  home: Home,
  places: readonly SessionPlace[],
  globalSkills: Map<string, Skill>,
  shared?: Inventory,
): Promise<PlaceOrigin> {
  const origins = new Map(
    await Promise.all(harnesses.map(async (h) => [h.id, await h.skillOrigins(home)] as const)),
  );
  const global = [...globalSkills.values()];
  const byDirectory = new Map<string, Promise<Skill[]>>();
  const inventory = (cwd: string) =>
    shared?.(cwd) ??
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

async function unjudged(home: Home): Promise<string | null> {
  const config = await readConfig(home.dir);
  if (typeof typesafeKey(config, process.env) === "string") return null;
  const choice = judgeChoice(config, process.env);
  const judged =
    !(choice instanceof Error) &&
    choice.name !== "none" &&
    !(choice.name === "jev" && !choice.apiKey);
  return `${judged ? "grouping and causes in quench corrections" : "quench corrections"} and one-word skill names in quench profile skills --asks`;
}
