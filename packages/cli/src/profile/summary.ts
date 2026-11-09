import { harnessById, quoteArg, shellFor } from "@quench/history";
import {
  ago,
  chars,
  count,
  plural,
  projectName,
  shortPath,
  size,
  table,
  tokens,
} from "../format.ts";
import { accent, badge, bar, bold, dim, good, heading, title } from "../style.ts";
import { unconfiguredHomes } from "./config-homes.ts";
import { fileLabel } from "./recorded-instructions.ts";
import { renderStartSplit } from "./recorded-start.ts";
import { commandLabel } from "./recorded-failures.ts";
import { neverUsed } from "./skill-cuts.ts";
import { skillSources } from "./recorded-skills.ts";
import { renderNextSteps } from "./next-steps.ts";
import type { McpHealth } from "./recorded-mcp.ts";
import { pinnedDetail } from "./pinned-models.ts";
import type { Profile } from "./render.ts";

const BUSIEST = 5;

const STORED_IN: Record<string, string> = {
  mcp: "MCP config",
  settings: "harness settings",
  prompts: "prompt history",
};

type Item = { headline: string; detail: string | null; command: string };

export function summary(result: Profile, homeDir: string): string[] {
  const found = result.homes.filter((h) => h.found && h.sessions);
  const sessions = found.reduce((n, h) => n + h.sessions, 0);
  return [
    `${title("QUENCH")}  ${bold(`last ${result.days} days`)} ${dim("·")} ${count(sessions)} sessions ${dim(found.map((h) => `· ${harnessById[h.harness].label} ${count(h.sessions)}`).join(" "))}`,
    ...startingLoad(result, homeDir),
    ...renderStartSplit(result.recordedStart),
    ...worthALook(result, homeDir),
    ...busiest(result, homeDir),
    ...renderNextSteps(result.nextSteps),
    ...(result.unjudged
      ? [
          "",
          `${dim(`Not measured until a judge is set up: ${result.unjudged}.`)} ${accent("→ quench setup judge")}`,
        ]
      : []),
    "",
    dim(
      "More: quench profile [projects|mcp|instructions|skills|failures] · quench sources · quench --help",
    ),
  ];
}

function startingLoad(result: Profile, homeDir: string): string[] {
  const context = {
    homeDir,
    claudeHome: result.homes.find((h) => h.harness === "claude-code")!.path,
    roots: result.projects.map((p) => p.root),
  };
  const rows = result.homes
    .filter((h) => h.found && h.sessions)
    .map((h) => {
      const global = result.globalInstructions
        .filter((f) => f.sources.some((s) => s.harness === h.harness))
        .reduce((n, f) => n + f.bytes, 0);
      const largest = result.recordedInstructions
        .flatMap((file) =>
          file.loads.filter((l) => l.harness === h.harness).map((load) => ({ file, load })),
        )
        .sort((a, b) => b.load.chars - a.load.chars)[0];
      return {
        label: harnessById[h.harness].label,
        global,
        largest,
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
    ...rows.flatMap((r) =>
      r.skills ? [`  ${dim(`${r.label} skills: ${skillSources(r.skills)}`)}`] : [],
    ),
    ...rows.flatMap((r) =>
      r.largest
        ? [
            `  ${dim(`${r.label} instructions, largest: ${fileLabel(r.largest.file, context)} · ${chars(Math.round(r.largest.load.chars / r.largest.load.sessions))} per session · ${chars(r.largest.load.chars)} over ${plural(r.largest.load.sessions, "session")}`)}`,
          ]
        : [],
    ),
  ];
}

function worthALook(result: Profile, homeDir: string): string[] {
  const items: Item[] = [];
  const { credentials, files: stored } = result.storedCredentials;
  if (credentials)
    items.push({
      headline: `${plural(credentials, "credential")} stored in plaintext in ${[...new Set(stored.map((f) => STORED_IN[f.kind] ?? f.kind))].join(" and ")}`,
      detail: stored.map((f) => shortPath(f.path, homeDir)).join(" · "),
      command: "quench secrets",
    });
  const dead = result.claudeConfigHomes.flatMap((h) => h.dead);
  if (dead.length)
    items.push({
      headline: `${plural(dead.length, "hook or status line", "hooks or status lines")} can't run`,
      detail: dead
        .map((d) =>
          d.script
            ? `${d.event} ${shortPath(d.script, homeDir)} missing`
            : `${d.event} ${d.problem}`,
        )
        .join(" · "),
      command: `edit ${[...new Set(dead.map((d) => shortPath(d.file, homeDir)))].join(" and ")}`,
    });
  const never = result.recordedSkills
    .filter((u) => u.useRecorded)
    .map((u) => ({
      label: harnessById[u.harness].label,
      n: neverUsed(u).length,
    }))
    .filter((u) => u.n);
  const neverTotal = never.reduce((n, u) => n + u.n, 0);
  if (neverTotal)
    items.push({
      headline: `${plural(neverTotal, "skill")} listed but never used`,
      detail: `${never.map((u) => `${u.label} ${u.n}`).join(" · ")} — ranked cut list with a command for each`,
      command: "quench profile skills",
    });
  const blocked = result.recordedFailures.blocked[0];
  if (blocked)
    items.push({
      headline: `${blocked.hooks.length ? `${blocked.guard} ${blocked.hooks.join(" or ")}` : blocked.guard} blocked ${blocked.command ? `"${commandLabel(blocked.command, blocked.chained)}" ` : ""}${count(blocked.blocks)}×`,
      detail: `${plural(blocked.sessions, "session")} · ${blocked.projects
        .slice(0, 3)
        .map((p) => projectName(p.root, homeDir))
        .join(", ")}`,
      command: "quench profile failures",
    });
  const kept = result.recordedFailures.backgrounded;
  if (kept.backgrounded)
    items.push({
      headline: `${plural(kept.backgrounded, "command")} kept running after a timeout`,
      detail: [
        `${count(kept.rerun)} re-run before done`,
        kept.commands
          .slice(0, 3)
          .map((c) => `${commandLabel(c.what, c.chained)} ${count(c.backgrounded)}`)
          .join(", "),
        kept.models
          .slice(0, 3)
          .map(
            (m) =>
              `${m.model ?? "unknown"} on ${harnessById[m.harness].label} ${count(m.backgrounded)}`,
          )
          .join(", "),
      ].join(" · "),
      command: "quench profile failures",
    });
  const top = result.recordedFailures.repeated[0];
  if (top)
    items.push({
      headline: `"${commandLabel(top.what, top.chained)}" failed ${count(top.failures)}× in ${projectName(top.root, homeDir)}`,
      detail: `${top.error ? `${top.error} · ` : ""}${plural(top.sessions, "session")} · ${chars(top.chars)} of output`,
      command: "quench profile failures",
    });
  const pinned = result.pinnedModels;
  if (pinned.length)
    items.push({
      headline: `${plural(pinned.length, "pinned model name")} ${pinned.length === 1 ? "looks" : "look"} outdated`,
      detail: `${pinned
        .slice(0, 3)
        .map((p) => `${p.model} in ${shortPath(p.files[0]!, homeDir)}, ${pinnedDetail(p)}`)
        .join(" · ")}${pinned.length > 3 ? ` · ${pinned.length - 3} more` : ""}`,
      command: "quench profile instructions",
    });
  const health = (state: McpHealth["state"]) => result.mcpHealth.filter((r) => r.state === state);
  const servers = (rows: McpHealth[], sessions: boolean) =>
    `${rows
      .slice(0, 3)
      .map(
        (r) =>
          `${r.server} on ${harnessById[r.harness].label}${sessions ? ` ${plural(r.sessions, "session")}` : ""}${r.code ? ` (${r.code})` : ""}`,
      )
      .join(" · ")}${rows.length > 3 ? ` · ${rows.length - 3} more` : ""}`;
  for (const [state, headline] of [
    ["failing", "failed to connect"],
    ["needs login", "waiting for login"],
    ["unused", "on but never called"],
  ] as const) {
    const rows = health(state);
    if (rows.length)
      items.push({
        headline: `${plural(rows.length, "MCP server")} ${headline}`,
        detail: servers(rows, state !== "unused"),
        command: "quench profile mcp",
      });
  }
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
  const unconfigured = unconfiguredHomes(result.claudeConfigHomes);
  for (const bare of unconfigured?.bare ?? [])
    items.push({
      headline: `${shortPath(bare.path, homeDir)} ran ${plural(bare.sessions, "session")} with no instructions or hooks`,
      detail: `${shortPath(unconfigured!.configured.path, homeDir)} has ${size(unconfigured!.configured.instructionBytes)} of instructions and ${plural(unconfigured!.configured.hooks, "hook")}`,
      command: `quench --claude-home ${quoteArg(bare.path, shellFor())}`,
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
