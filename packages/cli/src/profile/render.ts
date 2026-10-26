import {
  harnessById,
  type HarnessId,
  type McpServer,
  type Project,
  type Skill,
} from "@quench/history";
import { count, plural, projectName, shortPath, size, table } from "../format.ts";
import { projectTables } from "./projects.ts";
import { renderFailures, type FailureSummary } from "./recorded-failures.ts";
import { renderRecordedFiles, type RecordedFile } from "./recorded-instructions.ts";
import { renderMcpUse, type McpUse } from "./recorded-mcp.ts";
import { renderSkillUse, type SkillUse } from "./recorded-skills.ts";
import { renderMcpServers, skillsCell, type InstructionFile } from "./setup.ts";
import { summary } from "./summary.ts";

export type ProfiledProject = Project & {
  instructions: { directory: string; files: InstructionFile[] };
  recordedLoad: { sessions: number; medianChars: number | null };
  skills: Skill[];
  mcpServers: McpServer[];
  worktrees: { linked: number; idle: number; missing: number } | null;
  warnings: string[];
};

export type Profile = {
  days: number;
  homes: { harness: HarnessId; path: string; found: boolean; sessions: number }[];
  unreadable: number;
  globalInstructions: InstructionFile[];
  globalSkills: Skill[];
  globalMcpServers: McpServer[];
  recordedInstructions: RecordedFile[];
  recordedSkills: SkillUse[];
  recordedMcp: McpUse[];
  recordedFailures: FailureSummary;
  projects: ProfiledProject[];
  missingDirectories: string[];
};

export const HOME_FLAGS = {
  "claude-home": "claude-code",
  "codex-home": "codex",
  "pi-home": "pi",
} as const;

export const SECTIONS = ["projects", "mcp", "instructions", "skills", "failures"] as const;

export type View = "summary" | "full" | (typeof SECTIONS)[number];

export function render(result: Profile, homeDir: string, view: View): string[] {
  const short = (path: string) => shortPath(path, homeDir);
  const claudeHome = result.homes.find((h) => h.harness === "claude-code")!.path;
  const sections = {
    projects: () => projectTables(result, homeDir),
    mcp: () => [
      ...renderMcpServers(result.globalMcpServers, result.projects, homeDir),
      ...renderMcpUse(result.recordedMcp, result.days),
    ],
    instructions: () => [
      ...globalInstructions(result.globalInstructions, short),
      ...renderRecordedFiles(result.recordedInstructions, {
        homeDir,
        claudeHome,
        roots: result.projects.map((p) => p.root),
      }),
    ],
    skills: () => renderSkillUse(result.recordedSkills, result.days),
    failures: () => renderFailures(result.recordedFailures, result.days, homeDir),
  };
  if (view === "summary") return summary(result, homeDir);
  if (view !== "full") {
    const lines = sections[view]();
    return lines.length
      ? lines.slice(1)
      : [`Nothing recorded for ${view} in the last ${result.days} days.`];
  }
  return [
    ...agentsTable(result, short),
    ...globalInstructions(result.globalInstructions, short),
    ...sections.projects(),
    ...sections.mcp(),
    ...renderRecordedFiles(result.recordedInstructions, {
      homeDir,
      claudeHome,
      roots: result.projects.map((p) => p.root),
    }),
    ...sections.skills(),
    ...sections.failures(),
    ...footer(result, homeDir),
  ];
}

function agentsTable(result: Profile, short: (path: string) => string): string[] {
  const sessions = result.homes.reduce((n, h) => n + h.sessions, 0);
  const lines = [
    `Quench profile · last ${result.days} days · ${count(sessions)} sessions · instruction files as they are on disk now`,
    "",
    ...table(
      [
        ["Agent", "Sessions", "Skills", "MCP", "Home"],
        ...result.homes.map((h) =>
          h.found
            ? [
                harnessById[h.harness].label,
                count(h.sessions),
                skillsCell(result.globalSkills, h.harness),
                count(result.globalMcpServers.filter((s) => s.harness === h.harness).length),
                short(h.path),
              ]
            : [
                harnessById[h.harness].label,
                "—",
                "—",
                "—",
                `${short(h.path)} not found; set ${flagFor(h.harness)}`,
              ],
        ),
      ],
      [1, 3],
    ),
  ];
  if (result.unreadable)
    lines.push(`  ${plural(result.unreadable, "session file")} could not be read`);
  return lines;
}

function globalInstructions(files: InstructionFile[], short: (path: string) => string): string[] {
  const lines = ["", "Global instructions · every project, before project files"];
  if (!files.length) return [...lines, "  none found"];
  return [
    ...lines,
    ...table(
      files.flatMap((file) =>
        file.sources.map((s) => [
          short(s.path),
          size(file.bytes),
          harnessById[s.harness].label,
          s.path === s.realPath ? "" : `→ ${short(s.realPath)}`,
        ]),
      ),
      [1],
    ),
  ];
}

function footer(result: Profile, homeDir: string): string[] {
  const lines: string[] = [];
  const warnings = result.projects.flatMap((p) =>
    p.warnings.map((w) => `  ${projectName(p.root, homeDir)}: ${w}`),
  );
  if (warnings.length) lines.push("", "Warnings", ...warnings);
  const missing = result.missingDirectories.length;
  if (missing)
    lines.push(
      "",
      missing === 1
        ? "1 session folder no longer exists; its sessions are not listed."
        : `${missing} session folders no longer exist; their sessions are not listed.`,
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

const flagFor = (id: HarnessId) =>
  `--${Object.entries(HOME_FLAGS).find(([, harness]) => harness === id)![0]}`;
