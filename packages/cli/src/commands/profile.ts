import { stat } from "node:fs/promises";
import { basename, relative } from "node:path";
import {
  discoverAll,
  harnessById,
  harnesses,
  projects,
  readSessions,
  steeringInventory,
  type HarnessId,
  type Home,
  type Project,
  type SessionPlace,
  type SteeringFile,
} from "@quench/history";
import { ago, json, plural, size, table } from "../format.ts";

type InstructionFile = Omit<SteeringFile, "rules"> & { rules: number };

export async function profile(
  home: Home,
  options: { days: number; scan: string[]; json: boolean },
): Promise<number> {
  const since = new Date(Date.now() - options.days * 86_400_000);
  const refs = await discoverAll(home, since);
  const modified = new Map(refs.map((ref) => [ref.path, ref.modified]));
  const places: SessionPlace[] = [];
  let unreadable = 0;
  for await (const outcome of readSessions(refs, 8)) {
    if (!outcome.ok) unreadable++;
    else
      places.push({
        cwd: outcome.session.cwd,
        harness: outcome.session.harness,
        at: modified.get(outcome.session.path) ?? null,
      });
  }
  let found: Awaited<ReturnType<typeof projects>>;
  try {
    found = await projects(places, options.scan);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const global = new Map<string, InstructionFile>();
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
    profiled.push({
      ...project,
      instructions: { directory, files: local },
      warnings: inventory.warnings,
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
    projects: profiled,
    missingDirectories: found.missing,
    limitations: [
      `Projects come from the working directories of sessions modified in the last ${options.days} days, plus --scan; projects with no recent sessions are not found.`,
      "Worktrees and subdirectories of one git repository are grouped under its main checkout.",
      "Instructions are current files in each project's most recently used directory, not proof of what a past session loaded; other worktrees may differ.",
      "Skills, MCP servers and plugins are not profiled yet.",
    ],
  };
  if (options.json) {
    process.stdout.write(json(result));
    return 0;
  }
  process.stdout.write(render(result, home.dir).join("\n") + "\n");
  return 0;
}

type Profile = {
  days: number;
  homes: { harness: HarnessId; path: string; found: boolean; sessions: number }[];
  unreadable: number;
  globalInstructions: InstructionFile[];
  projects: (Project & {
    instructions: { directory: string; files: InstructionFile[] };
    warnings: string[];
  })[];
  missingDirectories: string[];
};

const OTHER_FOLDERS_SHOWN = 5;

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
        ["Agent", "Sessions", "Home"],
        ...result.homes.map((h) => [
          harnessById[h.harness].label,
          h.found ? count(h.sessions) : "—",
          h.found ? short(h.path) : `${short(h.path)} not found; set ${flagFor(h.harness)}`,
        ]),
      ],
      [1],
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
    fileNames(p),
    short(p.root),
  ];
  const header = [
    "Project",
    "Sessions",
    "Last used",
    ...agents.map((h) => harnessById[h.harness].label),
    "Instruction files",
    "Path",
  ];
  const numeric = [1, ...agents.map((_, i) => i + 3)];

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
      ...table([header, ...shown.map(row)], numeric),
    );
    if (other.length > shown.length)
      lines.push(`  … ${other.length - shown.length} more in --json`);
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
  lines.push(
    "",
    "Sizes are the project's own instruction files each agent would find in its most recently used folder; global files come on top.",
    "Files on disk now are not proof of what a past session loaded. Skills, MCP servers and plugins are not counted yet.",
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
