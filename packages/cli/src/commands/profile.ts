import { stat } from "node:fs/promises";
import { basename, dirname, relative } from "node:path";
import {
  checkout,
  compareWithDisk,
  harnessById,
  harnesses,
  linkedWorktrees,
  mcpInventory,
  projects,
  sessionPlaces,
  skillInventory,
  steeringInventory,
  usedIn,
  type DiskComparison,
  type HarnessId,
  type Home,
  type InjectedInstruction,
  type McpServer,
  type Project,
  type SessionPlace,
  type Skill,
  type SteeringFile,
} from "@quench/history";
import { ago, json, plural, size, table, tokens } from "../format.ts";

type InstructionFile = Omit<SteeringFile, "rules"> & { rules: number };

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
  const global = new Map<string, InstructionFile>();
  const globalSkills = new Map<string, Skill>();
  const globalMcp = new Map<string, McpServer>();
  const profiled = [];
  for (const project of found.projects) {
    const directory = project.directories[0]?.path ?? project.root;
    const inventory = await steeringInventory(home, directory);
    const local: InstructionFile[] = [];
    for (const file of inventory.files) {
      const summary = { ...file, rules: file.rules.length };
      const user = file.sources.filter((s) => s.scope === "user");
      const other = file.sources.filter(
        (s) => s.scope !== "user" && !user.some((u) => u.realPath === s.realPath),
      );
      if (user.length) global.set(file.id, { ...summary, sources: user });
      if (other.length) local.push({ ...summary, sources: other });
    }
    const skills = await skillInventory(home, directory);
    const projectSkills: Skill[] = [];
    for (const skill of skills.skills) {
      const shared = skill.sources.filter((s) => s.scope === "user" || s.scope === "system");
      const own = skill.sources.filter((s) => !shared.includes(s));
      if (shared.length) globalSkills.set(skill.realPath, { ...skill, sources: shared });
      if (own.length) projectSkills.push({ ...skill, sources: own });
    }
    const mcp = await mcpInventory(home, directory);
    for (const server of mcp.servers.filter((s) => s.scope === "user"))
      globalMcp.set(`${server.harness}\0${server.name}`, server);
    const loads = (found.placesByRoot.get(project.root) ?? []).flatMap((p) =>
      p.instructions ? [p.instructions.reduce((n, f) => n + f.textChars, 0)] : [],
    );
    const linked = project.git ? await linkedWorktrees(project.root) : null;
    const directories = project.directories.map((d) => d.path);
    profiled.push({
      ...project,
      instructions: { directory, files: local },
      recordedLoad: { sessions: loads.length, medianChars: median(loads) },
      worktrees: linked && {
        linked: linked.length,
        idle: linked.filter((w) => !w.missing && !usedIn(w.path, directories)).length,
        missing: linked.filter((w) => w.missing).length,
      },
      skills: projectSkills,
      mcpServers: mcp.servers.filter((s) => s.scope !== "user"),
      warnings: [...inventory.warnings, ...skills.warnings, ...mcp.warnings],
    });
  }
  const result = {
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
    globalInstructions: [...global.values()],
    globalSkills: [...globalSkills.values()],
    globalMcpServers: [...globalMcp.values()],
    recordedInstructions: await recordedFiles(places),
    projects: profiled,
    missingDirectories: found.missing,
    limitations: [
      `Projects come from the working directories of sessions modified in the last ${options.days} days, plus --scan; projects with no recent sessions are not found.`,
      "Worktrees and subdirectories of one git repository are grouped under its main checkout.",
      "Instructions are current files in each project's most recently used directory, not proof of what a past session loaded; other worktrees may differ.",
      "Recorded instructions are the text each session's history logged injecting, global files included. Older harness versions recorded none, so a missing record is unknown, not zero. Codex records one combined block per directory without file boundaries.",
      "A recorded file is the same as disk now when its hash matches the file's text exactly, or with one final newline removed as Claude Code does. Anything else differs: usually the file changed since, possibly other processing by the harness.",
      "Skills are SKILL.md folders in each agent's documented locations on disk now. Up-front size is name plus description before each agent's own caps and budgets; bodies load on demand. Built-in and plugin skills, managed and /etc locations, and Codex agents/openai.yaml policies are not read. Codex and Pi project trust is approximated from user config, or assumed for Pi.",
      "MCP servers are entries in each agent's config files, shown by name, transport and command name or URL host only; arguments, environment, headers and full URLs are never read out. Tool definitions need a live connection and are not counted. Plugin and managed servers are not read.",
    ],
  };
  if (options.json) {
    process.stdout.write(json(result));
    return 0;
  }
  process.stdout.write(render(result, home.dir).join("\n") + "\n");
  return 0;
}

type RecordedFile = {
  root: string | null;
  file: string;
  combined: boolean;
  harnesses: HarnessId[];
  sessions: number;
  lastRecorded: string | null;
  textChars: number;
  textSha256: string;
  checkouts: { path: string; lastRecorded: string | null; disk: DiskComparison }[];
};

type Recorded = { at: string | null; record: InjectedInstruction };

async function recordedFiles(places: readonly SessionPlace[]): Promise<RecordedFile[]> {
  const checkouts = new Map<string, ReturnType<typeof checkout>>();
  const checkoutOf = (dir: string) =>
    checkouts.get(dir) ?? checkouts.set(dir, checkout(dir)).get(dir)!;
  const rows = new Map<
    string,
    { root: string | null; file: string; places: SessionPlace[]; latest: Map<string, Recorded> }
  >();
  for (const place of places) {
    const at = place.at?.toISOString() ?? null;
    for (const record of place.instructions ?? []) {
      const target = record.path ?? record.directory;
      const repo = target ? await checkoutOf(record.path ? dirname(target) : target) : null;
      const file = repo && target ? relative(repo.top, target) || "." : (target ?? "unknown");
      const key = `${repo?.root ?? ""}\0${file}\0${record.path === null}`;
      const row =
        rows.get(key) ??
        rows.set(key, { root: repo?.root ?? null, file, places: [], latest: new Map() }).get(key)!;
      if (row.places.at(-1) !== place) row.places.push(place);
      const copy = target ?? "unknown";
      if ((at ?? "") >= (row.latest.get(copy)?.at ?? "")) row.latest.set(copy, { at, record });
    }
  }
  return Promise.all(
    [...rows.values()].map(async (row) => {
      const copies = [...row.latest].sort(([, a], [, b]) => (b.at ?? "").localeCompare(a.at ?? ""));
      const [, newest] = copies[0]!;
      return {
        root: row.root,
        file: row.file,
        combined: newest.record.path === null,
        harnesses: unique(row.places.map((p) => p.harness)),
        sessions: row.places.length,
        lastRecorded: newest.at,
        textChars: newest.record.textChars,
        textSha256: newest.record.textSha256,
        checkouts: await Promise.all(
          copies.map(async ([path, { at, record }]) => ({
            path,
            lastRecorded: at,
            disk: await compareWithDisk(record),
          })),
        ),
      };
    }),
  ).then((files) => files.sort((a, b) => b.sessions - a.sessions || a.file.localeCompare(b.file)));
}

const unique = <T>(values: T[]) => [...new Set(values)];

function diskNow(file: RecordedFile): string {
  const states = unique(file.checkouts.map((c) => c.disk));
  if (states.length === 1) return states[0]!;
  return states
    .map((state) => `${file.checkouts.filter((c) => c.disk === state).length} ${state}`)
    .join(", ");
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

type Profile = {
  days: number;
  homes: { harness: HarnessId; path: string; found: boolean; sessions: number }[];
  unreadable: number;
  globalInstructions: InstructionFile[];
  globalSkills: Skill[];
  globalMcpServers: McpServer[];
  recordedInstructions: RecordedFile[];
  projects: (Project & {
    instructions: { directory: string; files: InstructionFile[] };
    recordedLoad: { sessions: number; medianChars: number | null };
    skills: Skill[];
    mcpServers: McpServer[];
    worktrees: { linked: number; idle: number; missing: number } | null;
    warnings: string[];
  })[];
  missingDirectories: string[];
};

const OTHER_FOLDERS_SHOWN = 5;
const RECORDED_SHOWN = 15;

const chars = (n: number) => `${tokens(n)} chars`;

function skillsCell(skills: Skill[], harness: HarnessId): string {
  const visible = skills.filter(
    (s) => s.modelInvocable && s.sources.some((source) => source.harness === harness),
  );
  if (!visible.length) return "0";
  return `${count(visible.length)} · ${chars(visible.reduce((n, s) => n + s.indexChars, 0))}`;
}

const count = (n: number) => n.toLocaleString("en-US");

function render(result: Profile, homeDir: string): string[] {
  const short = (path: string) =>
    path === homeDir || path.startsWith(`${homeDir}/`) ? `~${path.slice(homeDir.length)}` : path;
  const agents = result.homes.filter((h) => h.found);
  const sessions = result.homes.reduce((n, h) => n + h.sessions, 0);
  const lines = [
    `Quench profile · last ${result.days} days · ${count(sessions)} sessions · instruction files as they are on disk now`,
    "",
    ...table(
      [
        ["Agent", "Sessions", "Skills", "MCP", "Home"],
        ...result.homes.map((h) => [
          harnessById[h.harness].label,
          h.found ? count(h.sessions) : "—",
          h.found ? skillsCell(result.globalSkills, h.harness) : "—",
          h.found
            ? count(result.globalMcpServers.filter((s) => s.harness === h.harness).length)
            : "—",
          h.found ? short(h.path) : `${short(h.path)} not found; set ${flagFor(h.harness)}`,
        ]),
      ],
      [1, 3],
    ),
  ];
  if (result.unreadable)
    lines.push(`  ${plural(result.unreadable, "session file")} could not be read`);

  lines.push("", "Global instructions · every project, before project files");
  if (!result.globalInstructions.length) lines.push("  none found");
  else
    lines.push(
      ...table(
        result.globalInstructions.flatMap((file) =>
          file.sources.map((s) => [
            short(s.path),
            size(file.bytes),
            harnessById[s.harness].label,
            s.path === s.realPath ? "" : `→ ${short(s.realPath)}`,
          ]),
        ),
        [1],
      ),
    );

  const repos = result.projects.filter((p) => p.git);
  const other = result.projects.filter((p) => !p.git);
  const loaded = (p: Profile["projects"][number], harness: HarnessId) => {
    const bytes = p.instructions.files
      .filter((f) => f.sources.some((s) => s.harness === harness))
      .reduce((n, f) => n + f.bytes, 0);
    return bytes ? size(bytes) : "—";
  };
  const fileNames = (p: Profile["projects"][number]) =>
    [
      ...new Set(
        p.instructions.files.flatMap((f) =>
          f.sources.map((s) => relative(p.instructions.directory, s.path)),
        ),
      ),
    ].join(", ") || "none";
  const row = (p: Profile["projects"][number]) => [
    p.root === homeDir ? "~" : basename(p.root),
    p.sessions ? count(p.sessions) : "—",
    p.sessions ? ago(p.lastActive) : "scanned",
    ...agents.map((h) => loaded(p, h.harness)),
    p.recordedLoad.medianChars === null ? "—" : chars(p.recordedLoad.medianChars),
    p.skills.length ? count(p.skills.length) : "—",
    p.mcpServers.length ? count(p.mcpServers.length) : "—",
    fileNames(p),
    p.worktrees?.linked ? `${count(p.worktrees.linked)} · ${count(p.worktrees.idle)} idle` : "—",
    short(p.root),
  ];
  const header = [
    "Project",
    "Sessions",
    "Last used",
    ...agents.map((h) => harnessById[h.harness].label),
    "Recorded/session",
    "Skills",
    "MCP",
    "Instruction files",
    "Worktrees",
    "Path",
  ];
  const numeric = [1, ...agents.map((_, i) => i + 3), ...[3, 4, 5].map((i) => agents.length + i)];

  lines.push(
    "",
    `Projects · ${plural(repos.length, "git repository", "git repositories")} · project instruction size per agent`,
  );
  lines.push(...(repos.length ? table([header, ...repos.map(row)], numeric) : ["  none found"]));

  if (other.length) {
    const shown = [...other].sort((a, b) => b.sessions - a.sessions).slice(0, OTHER_FOLDERS_SHOWN);
    lines.push(
      "",
      `Other folders · ${plural(other.length, "folder")} outside git · ${plural(
        other.reduce((n, p) => n + p.sessions, 0),
        "session",
      )}`,
      ...table(
        [header, ...shown.map(row)].map((cells) => cells.filter((_, i) => i !== header.length - 2)),
        numeric,
      ),
    );
    if (other.length > shown.length)
      lines.push(`  … ${other.length - shown.length} more in --json`);
  }

  const servers = [
    ...result.globalMcpServers.map((s) => ({ ...s, where: "all projects" })),
    ...result.projects.flatMap((p) =>
      p.mcpServers.map((s) => ({ ...s, where: p.root === homeDir ? "~" : basename(p.root) })),
    ),
  ];
  if (servers.length)
    lines.push(
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
    );

  if (result.recordedInstructions.length) {
    const shown = result.recordedInstructions.slice(0, RECORDED_SHOWN);
    const projectName = (root: string) => (root === homeDir ? "~" : basename(root));
    const claudeProjects = `${result.homes.find((h) => h.harness === "claude-code")!.path}/projects/`;
    const memoryOwner = (path: string) => {
      const [slug, ...rest] = path.slice(claudeProjects.length).split("/");
      const root = result.projects.find((p) => p.root.replace(/[^A-Za-z0-9]/g, "-") === slug)?.root;
      return root && rest[0] === "memory"
        ? `${projectName(root)} auto memory/${rest.slice(1).join("/")}`
        : null;
    };
    const name = (r: RecordedFile) =>
      r.combined
        ? r.root === null
          ? "combined block, directory not recorded"
          : `${projectName(r.root)}${r.file === "." ? "" : `/${r.file}`} (combined block)`
        : r.root !== null
          ? `${projectName(r.root)}/${r.file}`
          : ((r.file.startsWith(claudeProjects) ? memoryOwner(r.file) : null) ?? short(r.file));
    lines.push(
      "",
      "Recorded instructions · what session histories logged loading · worktrees folded",
      ...table(
        [
          ["File", "Agents", "Sessions", "Last recorded", "Size", "Disk now"],
          ...shown.map((r) => [
            name(r),
            r.harnesses.map((h) => harnessById[h].label).join(", "),
            count(r.sessions),
            ago(r.lastRecorded),
            chars(r.textChars),
            diskNow(r),
          ]),
        ],
        [2, 4],
      ),
    );
    if (result.recordedInstructions.length > shown.length)
      lines.push(`  … ${result.recordedInstructions.length - shown.length} more in --json`);
  }

  const warnings = result.projects.flatMap((p) =>
    p.warnings.map((w) => `  ${basename(p.root)}: ${w}`),
  );
  if (warnings.length) lines.push("", "Warnings", ...warnings);
  if (result.missingDirectories.length)
    lines.push(
      "",
      result.missingDirectories.length === 1
        ? "1 session folder no longer exists; its sessions are not listed."
        : `${result.missingDirectories.length} session folders no longer exist; their sessions are not listed.`,
    );
  if (result.projects.some((p) => p.worktrees?.idle))
    lines.push(
      "",
      `Idle worktrees had no session in the last ${result.days} days. \`quench worktrees\` shows which are safe to remove.`,
    );
  lines.push(
    "",
    "Agent columns: the project's own instruction files on disk now in its most recently used folder; global files come on top.",
    "Recorded/session: median instruction text sessions logged loading, global files included. Older harness versions logged none.",
  );
  if (result.recordedInstructions.length)
    lines.push("Disk now: whether the last recorded text still matches the file today.");
  lines.push(
    "Skills: model-visible skills and their up-front name + description size; bodies load on demand. Built-in and plugin skills are not counted yet.",
  );
  return lines;
}

export const HOME_FLAGS = {
  "claude-home": "claude-code",
  "codex-home": "codex",
  "pi-home": "pi",
} as const;

const flagFor = (id: string) =>
  `--${Object.entries(HOME_FLAGS).find(([, harness]) => harness === id)![0]}`;
