import { harnessById } from "@quench/history";
import { ago, chars, count, plural, projectName, size, table } from "../format.ts";
import type { Profile } from "./render.ts";

const BUSIEST = 5;
const WIDTH = 72;

export function summary(result: Profile, homeDir: string): string[] {
  const found = result.homes.filter((h) => h.found && h.sessions);
  const sessions = found.reduce((n, h) => n + h.sessions, 0);
  return [
    `Quench · last ${result.days} days · ${count(sessions)} sessions (${found.map((h) => `${harnessById[h.harness].label} ${count(h.sessions)}`).join(", ")})`,
    ...startingLoad(result),
    ...worthALook(result, homeDir),
    ...busiest(result, homeDir),
    "",
    "Dig in",
    "  quench profile            every table, in full",
    "  quench profile <section>  one of: projects, mcp, instructions, skills, failures",
    "  quench sources <file>     what one session read",
    "  quench --help             all commands",
  ];
}

function startingLoad(result: Profile): string[] {
  const rows = result.homes
    .filter((h) => h.found && h.sessions)
    .map((h) => {
      const global = result.globalInstructions
        .filter((f) => f.sources.some((s) => s.harness === h.harness))
        .reduce((n, f) => n + f.bytes, 0);
      const skills = result.recordedSkills.find((u) => u.harness === h.harness);
      return [
        harnessById[h.harness].label,
        global ? `${size(global)} global instructions` : "no global instructions",
        skills?.medianListed
          ? `${plural(skills.medianListed, "skill")} listed (${chars(skills.medianChars ?? 0)})`
          : "no skill listing recorded",
      ];
    });
  if (!rows.length) return [];
  return [
    "",
    "Every session starts with",
    ...table(rows),
    "  Each project adds its own instruction files on top.",
  ];
}

function worthALook(result: Profile, homeDir: string): string[] {
  const items: [string, string][] = [];
  const unused = result.recordedSkills.filter((u) => u.useRecorded);
  const never = unused.map((u) => ({
    label: harnessById[u.harness].label,
    n: u.skills.filter((s) => !s.usedIn).length,
  }));
  const neverTotal = never.reduce((n, u) => n + u.n, 0);
  if (neverTotal)
    items.push([
      `${plural(neverTotal, "skill")} were listed to agents but never used (${never
        .filter((u) => u.n)
        .map((u) => `${u.label} ${u.n}`)
        .join(", ")}). Every listed skill costs context up front.`,
      "quench profile skills",
    ]);
  const top = result.recordedFailures.repeated[0];
  if (top)
    items.push([
      `In ${projectName(top.root, homeDir)}, "${top.what}" failed ${count(top.failures)} times across ${plural(top.sessions, "session")}.`,
      "quench profile failures",
    ]);
  const loads = result.projects
    .filter((p) => p.recordedLoad.medianChars !== null && p.sessions)
    .sort((a, b) => b.recordedLoad.medianChars! - a.recordedLoad.medianChars!);
  if (
    loads.length > 1 &&
    loads[0]!.recordedLoad.medianChars! >= 2 * loads[1]!.recordedLoad.medianChars!
  )
    items.push([
      `${projectName(loads[0]!.root, homeDir)} starts a typical session with ${chars(loads[0]!.recordedLoad.medianChars!)} of instructions, the most of any project.`,
      "quench profile instructions",
    ]);
  const idle = result.projects.reduce((n, p) => n + (p.worktrees?.idle ?? 0), 0);
  if (idle)
    items.push([
      `${plural(idle, "worktree")} had no session in ${result.days} days.`,
      "quench worktrees",
    ]);
  if (!items.length) return [];
  return [
    "",
    "Worth a look",
    ...items.flatMap(([text, command]) => [...wrap(`• ${text}`, "    "), `    → ${command}`]),
  ];
}

function busiest(result: Profile, homeDir: string): string[] {
  const projects = [...result.projects]
    .filter((p) => p.sessions)
    .sort((a, b) => b.sessions - a.sessions);
  if (!projects.length) return [];
  const lines = [
    "",
    "Busiest projects",
    ...table(
      [
        ["Project", "Sessions", "Last used", "Instructions per session"],
        ...projects
          .slice(0, BUSIEST)
          .map((p) => [
            projectName(p.root, homeDir),
            count(p.sessions),
            ago(p.lastActive),
            p.recordedLoad.medianChars === null ? "—" : chars(p.recordedLoad.medianChars),
          ]),
      ],
      [1, 3],
    ),
  ];
  if (projects.length > BUSIEST)
    lines.push(`  … ${projects.length - BUSIEST} more → quench profile projects`);
  return lines;
}

function wrap(text: string, indent: string): string[] {
  const lines: string[] = [];
  let line = "  ";
  for (const word of text.split(" ")) {
    if (line.trim() && line.length + word.length + 1 > WIDTH) {
      lines.push(line.trimEnd());
      line = indent;
    }
    line += `${word} `;
  }
  lines.push(line.trimEnd());
  return lines;
}
