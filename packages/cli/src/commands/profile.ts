import { stat } from "node:fs/promises";
import {
  discoverAll,
  harnessById,
  harnesses,
  projects,
  readSessions,
  steeringInventory,
  type Home,
  type SessionPlace,
  type SteeringFile,
} from "@quench/history";
import { json, plural } from "../format.ts";

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
  const lines = [
    `Quench profile · sessions from the last ${options.days} days · current disk`,
    "",
    "Harness homes",
  ];
  for (const h of result.homes)
    lines.push(
      `  ${harnessById[h.harness].label} · ${h.path} · ${h.found ? plural(h.sessions, "session") : `not found (set ${flagFor(h.harness)})`}`,
    );
  if (unreadable) lines.push(`  ${plural(unreadable, "session file")} could not be read`);
  lines.push("", "Global instructions");
  if (!result.globalInstructions.length) lines.push("  none found");
  for (const file of result.globalInstructions) lines.push(...fileLines(file));
  const repositories = profiled.filter((p) => p.git).length;
  lines.push(
    "",
    `Projects · ${plural(repositories, "git repository", "git repositories")} · ${plural(profiled.length - repositories, "other directory", "other directories")} · ${plural(found.missing.length, "session directory", "session directories")} no longer on disk`,
  );
  for (const p of profiled) {
    const activity = p.sessions
      ? `${plural(p.directories.length, "directory", "directories")} · ${plural(p.sessions, "session")} · last ${p.lastActive?.slice(0, 10) ?? "unknown"} · ${p.harnesses.map((h) => harnessById[h].label).join(", ")}`
      : "from --scan · no recent sessions";
    lines.push("", `${p.root} · ${p.git ? "git" : "not git"} · ${activity}`);
    const files = p.instructions.files;
    lines.push(
      `  Instructions in ${p.instructions.directory}: ${plural(files.length, "file")} · ${files.reduce((n, f) => n + f.bytes, 0)} bytes`,
    );
    for (const file of files) lines.push(...fileLines(file));
    for (const warning of p.warnings) lines.push(`  Warning: ${warning}`);
  }
  lines.push("", ...result.limitations);
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

export const HOME_FLAGS = {
  "claude-home": "claude-code",
  "codex-home": "codex",
  "pi-home": "pi",
} as const;

const flagFor = (id: string) =>
  `--${Object.entries(HOME_FLAGS).find(([, harness]) => harness === id)![0]}`;

function fileLines(file: InstructionFile): string[] {
  return [
    `  ${file.id.slice(0, 12)} · ${file.bytes} bytes · ${plural(file.rules, "rule candidate")}`,
    ...file.sources.map(
      (s) =>
        `    ${harnessById[s.harness].label} · ${s.scope} · ${s.path}${s.path === s.realPath ? "" : ` → ${s.realPath}`}`,
    ),
  ];
}
