import { harnessById } from "@quench/history";
import { ago, chars, count, plural, projectName, size, table, tokens } from "../format.ts";
import { accent, badge, bar, bold, dim, good, heading, title } from "../style.ts";
import { renderStartSplit } from "./recorded-start.ts";
import type { Profile } from "./render.ts";

const BUSIEST = 5;

type Item = { headline: string; detail: string | null; command: string };

export function summary(result: Profile, homeDir: string): string[] {
  const found = result.homes.filter((h) => h.found && h.sessions);
  const sessions = found.reduce((n, h) => n + h.sessions, 0);
  return [
    `${title("QUENCH")}  ${bold(`last ${result.days} days`)} ${dim("·")} ${count(sessions)} sessions ${dim(found.map((h) => `· ${harnessById[h.harness].label} ${count(h.sessions)}`).join(" "))}`,
    ...startingLoad(result),
    ...renderStartSplit(result.recordedStart),
    ...worthALook(result, homeDir),
    ...busiest(result, homeDir),
    "",
    dim(
      "More: quench profile [projects|mcp|instructions|skills|failures] · quench sources · quench --help",
    ),
  ];
}

function startingLoad(result: Profile): string[] {
  const rows = result.homes
    .filter((h) => h.found && h.sessions)
    .map((h) => {
      const global = result.globalInstructions
        .filter((f) => f.sources.some((s) => s.harness === h.harness))
        .reduce((n, f) => n + f.bytes, 0);
      return {
        label: harnessById[h.harness].label,
        global,
        skills: result.recordedSkills.find((u) => u.harness === h.harness),
      };
    });
  if (!rows.length) return [];
  const most = Math.max(...rows.map((r) => r.skills?.medianChars ?? 0));
  return [
    "",
    heading("Every session starts with"),
    ...table(
      rows.map((r) => [
        bold(r.label),
        r.global ? `${size(r.global)} instructions` : dim("no instructions"),
        r.skills?.medianListed ? plural(r.skills.medianListed, "skill") : dim("no skill list"),
        r.skills?.medianChars
          ? `${bar(r.skills.medianChars, most)} ${dim(chars(r.skills.medianChars))}`
          : "",
      ]),
    ),
    `  ${dim("Projects add their own instruction files on top.")}`,
  ];
}

function worthALook(result: Profile, homeDir: string): string[] {
  const items: Item[] = [];
  const never = result.recordedSkills
    .filter((u) => u.useRecorded)
    .map((u) => ({
      label: harnessById[u.harness].label,
      n: u.skills.filter((s) => !s.usedIn).length,
    }))
    .filter((u) => u.n);
  const neverTotal = never.reduce((n, u) => n + u.n, 0);
  if (neverTotal)
    items.push({
      headline: `${plural(neverTotal, "skill")} listed but never used`,
      detail: `${never.map((u) => `${u.label} ${u.n}`).join(" · ")} — each one costs context up front`,
      command: "quench profile skills",
    });
  const top = result.recordedFailures.repeated[0];
  if (top)
    items.push({
      headline: `"${top.what}" failed ${count(top.failures)}× in ${projectName(top.root, homeDir)}`,
      detail: `${plural(top.sessions, "session")} · ${chars(top.chars)} of output`,
      command: "quench profile failures",
    });
  const loads = result.projects
    .filter((p) => p.recordedLoad.medianChars !== null && p.sessions)
    .map((p) => ({ root: p.root, chars: p.recordedLoad.medianChars! }))
    .sort((a, b) => b.chars - a.chars);
  const [heaviest, next] = loads;
  if (heaviest && next && heaviest.chars >= 2 * next.chars)
    items.push({
      headline: `${projectName(heaviest.root, homeDir)} starts with ${chars(heaviest.chars)} of instructions`,
      detail: `${(heaviest.chars / next.chars).toFixed(1)}× your next project`,
      command: "quench profile instructions",
    });
  const idle = result.projects.reduce((n, p) => n + (p.worktrees?.idle ?? 0), 0);
  if (idle)
    items.push({
      headline: `${plural(idle, "worktree")} idle for ${result.days} days`,
      detail: null,
      command: "quench worktrees",
    });
  if (!items.length) return [];
  return [
    "",
    heading("Worth a look"),
    ...items.flatMap((item, i) => [
      ...(i ? [""] : []),
      `  ${badge(i + 1)} ${bold(item.headline)}`,
      ...(item.detail ? [`     ${dim(item.detail)}`] : []),
      `     ${accent(`→ ${item.command}`)}`,
    ]),
  ];
}

function busiest(result: Profile, homeDir: string): string[] {
  const projects = [...result.projects]
    .filter((p) => p.sessions)
    .sort((a, b) => b.sessions - a.sessions);
  if (!projects.length) return [];
  const shown = projects.slice(0, BUSIEST);
  const most = Math.max(...shown.map((p) => p.recordedLoad.medianChars ?? 0));
  const lines = [
    "",
    heading("Busiest projects"),
    ...table(
      shown.map((p) => {
        const used = ago(p.lastActive);
        const load = p.recordedLoad.medianChars;
        return [
          bold(projectName(p.root, homeDir)),
          `${count(p.sessions)} ${plural(p.sessions, "session").split(" ")[1]}`,
          used === "today" ? good(used) : dim(used),
          load === null
            ? dim("no instructions recorded")
            : `${bar(load, most)} ${dim(tokens(load))}`,
        ];
      }),
      [1],
    ),
  ];
  if (projects.length > BUSIEST)
    lines.push(
      `  ${dim(`… ${projects.length - BUSIEST} more`)}  ${accent("→ quench profile projects")}`,
    );
  return lines;
}
