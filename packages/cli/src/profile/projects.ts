import { relative } from "node:path";
import { harnessById, type HarnessId } from "@quench/history";
import { ago, chars, count, plural, projectName, shortPath, size, table } from "../format.ts";
import type { Profile, ProfiledProject } from "./render.ts";

const OTHER_FOLDERS_SHOWN = 5;

export function projectTables(result: Profile, homeDir: string): string[] {
  const agents = result.homes.filter((h) => h.found).map((h) => h.harness);
  const header = [
    "Project",
    "Sessions",
    "Last used",
    ...agents.map((h) => harnessById[h].label),
    "Recorded/session",
    "Skills",
    "MCP",
    "Instruction files",
    "Worktrees",
    "Path",
  ];
  const numeric = [1, ...agents.map((_, i) => i + 3), ...[3, 4, 5].map((i) => agents.length + i)];
  const row = (p: ProfiledProject) => [
    projectName(p.root, homeDir),
    p.sessions ? count(p.sessions) : "—",
    p.sessions ? ago(p.lastActive) : "scanned",
    ...agents.map((h) => instructionSize(p, h)),
    p.recordedLoad.medianChars === null ? "—" : chars(p.recordedLoad.medianChars),
    p.skills.length ? count(p.skills.length) : "—",
    p.mcpServers.length ? count(p.mcpServers.length) : "—",
    instructionNames(p),
    p.worktrees?.linked ? `${count(p.worktrees.linked)} · ${count(p.worktrees.idle)} idle` : "—",
    shortPath(p.root, homeDir),
  ];
  const repos = result.projects.filter((p) => p.git);
  const other = result.projects.filter((p) => !p.git);
  const lines = [
    "",
    `Projects · ${plural(repos.length, "git repository", "git repositories")} · project instruction size per agent`,
    ...(repos.length ? table([header, ...repos.map(row)], numeric) : ["  none found"]),
  ];
  if (!other.length) return lines;
  const shown = [...other].sort((a, b) => b.sessions - a.sessions).slice(0, OTHER_FOLDERS_SHOWN);
  const withoutWorktrees = (cells: string[]) => cells.filter((_, i) => i !== header.length - 2);
  lines.push(
    "",
    `Other folders · ${plural(other.length, "folder")} outside git · ${plural(
      other.reduce((n, p) => n + p.sessions, 0),
      "session",
    )}`,
    ...table([header, ...shown.map(row)].map(withoutWorktrees), numeric),
  );
  if (other.length > shown.length) lines.push(`  … ${other.length - shown.length} more in --json`);
  return lines;
}

function instructionSize(p: ProfiledProject, harness: HarnessId): string {
  const bytes = p.instructions.files
    .filter((f) => f.sources.some((s) => s.harness === harness))
    .reduce((n, f) => n + f.bytes, 0);
  return bytes ? size(bytes) : "—";
}

function instructionNames(p: ProfiledProject): string {
  const names = p.instructions.files.flatMap((f) =>
    f.sources.map((s) => relative(p.instructions.directory, s.path)),
  );
  return [...new Set(names)].join(", ") || "none";
}
