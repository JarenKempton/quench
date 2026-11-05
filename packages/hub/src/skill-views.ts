import {
  BASIS,
  own,
  type FleetFile,
  type HarnessId,
  type MachineState,
  type TreeHash,
  type VersionCounts,
} from "@quench/fleet";
import { SAMPLE_FLOOR, skillCounts, type Card } from "./cards.ts";

export type Desired = Map<string, Map<string, Map<HarnessId, TreeHash>>>;

export type GridMachine = {
  name: string;
  last_seen_at: number | null;
  state: MachineState | null;
};

export type CardView = Card & {
  path: string | null;
  diff: string | null;
  revert: string | null;
};

type Html = {
  escape: (text: string) => string;
  button: (action: string, fields: Record<string, string>, label: string) => string;
};

const short = (hash: string) => hash.slice(7, 15);

const when = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : "never");

const count = (n: number | null) => (n === null ? "–" : String(n));

function installed(
  html: Html,
  state: MachineState | null,
  skill: string,
  want: Map<HarnessId, TreeHash>,
) {
  const lines: string[] = [];
  const harnesses = new Set<HarnessId>([
    ...want.keys(),
    ...(Object.keys(state?.harnesses ?? {}) as HarnessId[]),
  ]);
  for (const harness of [...harnesses].sort()) {
    const reported = state?.harnesses[harness];
    const install = reported?.snapshot.installs.find(
      (i) => i.skill === skill && i.location.scope === "global",
    );
    const desired = want.get(harness);
    const stale = reported?.stale ? " (stale)" : "";
    if (!install) {
      if (desired)
        lines.push(
          `<div class="warn">${html.escape(harness)}: ${reported ? "not installed" : "not reported"}${stale}</div>`,
        );
      continue;
    }
    const verdict =
      install.state !== "owned"
        ? `<span class="warn">conflict: ${install.state === "modified" ? "edited on the machine" : "Quench did not write it"}</span>`
        : !desired
          ? `<span class="warn">not assigned</span>`
          : desired === install.treeHash
            ? "matches"
            : `<span class="warn">differs</span>`;
    lines.push(
      `<div>${html.escape(harness)}: <code>${short(install.treeHash)}</code> ${verdict}${stale}</div>`,
    );
  }
  return lines.join("");
}

function countsLine(state: MachineState | null, skill: string) {
  const c = skillCounts(state, skill);
  if (!c) return "";
  return `<div class="n">listed ${count(c.sessionsListed)} · used ${count(c.used)} · loaded ${count(c.sessionsLoaded)} · corrected ${count(c.withHumanCorrection)}</div>`;
}

export function skillGrid(
  html: Html,
  input: {
    head: string;
    fleet: FleetFile;
    machines: GridMachine[];
    desired: Desired;
    placed: (skill: string, machine: string) => boolean;
  },
) {
  const { head, fleet } = input;
  const byName = new Map(input.machines.map((m) => [m.name, m]));
  const names = [...new Set([...byName.keys(), ...Object.keys(fleet.machines)])].sort();
  const reported = input.machines.flatMap((m) =>
    Object.values(m.state?.harnesses ?? {}).flatMap((h) => h.snapshot.installs.map((i) => i.skill)),
  );
  const skills = [...new Set([...Object.keys(fleet.skills), ...reported])].sort();
  if (!skills.length)
    return "<p>No skills yet. Import a skills repo with <code>quench hub import</code>, or add one below.</p>";
  const header = names
    .map((n) => {
      const m = byName.get(n);
      const records = m?.state?.skillsTakenAt;
      return `<th>${html.escape(n)}<br><small>seen ${when(m?.last_seen_at)}${records ? `<br>records ${html.escape(records)}` : ""}</small></th>`;
    })
    .join("");
  const rows = skills.map((skill) => {
    const source = own(fleet.skills, skill);
    const label = source
      ? `<a href="/edit?path=${encodeURIComponent(`${source.path}/SKILL.md`)}">${html.escape(skill)}</a>`
      : `${html.escape(skill)}<br><small>not in the hub</small>`;
    const cells = names.map((machine) => {
      const want = input.desired.get(machine)?.get(skill) ?? new Map<HarnessId, TreeHash>();
      const wanted = [...new Set(want.values())];
      const toggle = source
        ? (() => {
            const on = input.placed(skill, machine);
            return `<div>${on ? "on" : "off"} ${html.button("/toggle", { base: head, skill, machine, on: on ? "0" : "1" }, on ? "Turn off" : "Turn on")}</div>`;
          })()
        : "";
      const desired = wanted.length
        ? `<div>desired <code>${wanted.map(short).join("</code> <code>")}</code></div>`
        : "";
      const state = byName.get(machine)?.state ?? null;
      return `<td>${toggle}${desired}${installed(html, state, skill, want)}${countsLine(state, skill)}</td>`;
    });
    return `<tr><td>${label}</td>${cells.join("")}</tr>`;
  });
  return `<table class="grid"><tr><th>Skill</th>${header}</tr>${rows.join("")}</table><p><small>Counts are sessions in each machine's last ${input.machines.find((m) => m.state?.skills)?.state?.skills?.days ?? 30} days: listed, used, loaded, and loaded with a human correction (shown at 5 judged sessions; ${BASIS}).</small></p>`;
}

const pct = (part: number, whole: number) => (whole ? `${Math.round((100 * part) / whole)}%` : "–");

const row = (label: string, c: VersionCounts) =>
  `<tr><th>${label}</th><td>${c.sessions}</td><td>${c.judged} (${pct(c.judged, c.sessions)})</td><td>${c.withHumanCorrection} of ${c.judged} judged (${pct(c.withHumanCorrection, c.judged)})</td><td>${c.unjudged}</td><td>${c.noFollowUp}</td></tr>`;

const ratio = (c: VersionCounts) => `${c.withHumanCorrection} of ${c.judged} judged`;

export function promptFor(card: CardView) {
  const where = card.places.map((p) => `${p.machine} (${p.harness})`).join(", ");
  const { before, after } = card.sides;
  return [
    `The skill "${card.skill}" changed from version ${short(card.before)} to ${short(card.after)}${card.revert ? ` in hub commit ${card.revert.slice(0, 12)}` : ""}.`,
    `On ${where}, sessions that loaded it had a human correction in ${ratio(before.loaded)} before and ${ratio(after.loaded)} after (${before.loaded.sessions} and ${after.loaded.sessions} sessions).`,
    `Sessions on the same machines and harnesses without the skill went from ${ratio(before.without)} to ${ratio(after.without)}.`,
    `This is ${BASIS}.`,
    `Review the diff of ${card.path ?? "the skill folder"} between these two versions and suggest a revision for me to review. Do not apply anything.`,
  ].join("\n");
}

export function versionSection(html: Html, head: string, cards: CardView[]) {
  if (!cards.length)
    return `<p>No skill version changes reported yet. A card appears when a machine reports sessions before and after a skill's tree hash changed.</p>`;
  const body = cards.map((card) => {
    const title = `<h3>${html.escape(card.skill)} <code>${short(card.before)}</code> → <code>${short(card.after)}</code></h3>`;
    if (!card.shown)
      return `<section class="card thin">${title}<p>not enough sessions (${card.sessions})</p></section>`;
    const { before, after } = card.sides;
    const where = card.places
      .map((p) => `${html.escape(p.machine)} (${html.escape(p.harness)})`)
      .join(", ");
    const diff =
      card.diff === null
        ? "<p>One of these versions is not in the hub's history, so there is no diff.</p>"
        : card.diff === ""
          ? "<p>No file changes between these versions.</p>"
          : `<pre class="diff">${card.diff
              .split("\n")
              .map((l) =>
                l.startsWith("+") && !l.startsWith("+++")
                  ? `<span class="add">${html.escape(l)}</span>`
                  : l.startsWith("-") && !l.startsWith("---")
                    ? `<span class="del">${html.escape(l)}</span>`
                    : html.escape(l),
              )
              .join("\n")}</pre>`;
    const revert = card.revert
      ? `${html.button("/revert", { base: head, commit: card.revert }, `Revert commit ${card.revert.slice(0, 12)}`)} <small>Makes one revert commit after you read the diff above. Machines pick it up on their next poll.</small>`
      : "<small>No single hub commit made this change at HEAD, so there is nothing to revert here.</small>";
    return `<section class="card">${title}<p class="basis">${BASIS}</p><p>Same machines and harnesses: ${where}</p>
<table><tr><th></th><th>Sessions</th><th>Judged (coverage)</th><th>Human correction</th><th>Unjudged</th><th>No follow-up</th></tr>
${row("Loaded it, before", before.loaded)}${row("Loaded it, after", after.loaded)}${row("Without it, before", before.without)}${row("Without it, after", after.without)}</table>
<h4>Diff</h4>${diff}
<h4>Suggestions</h4><p>${revert}</p><label>Copy this prompt<br><textarea readonly rows="6">${html.escape(promptFor(card))}</textarea></label><p><small>Nothing here is applied automatically.</small></p></section>`;
  });
  return `<p>When a skill's tree hash changes on a machine, sessions on the same machines and harnesses before and after the change are compared, with sessions that did not load the skill as a baseline. Cards need ${SAMPLE_FLOOR} sessions that loaded the skill on each side.</p>${body.join("")}`;
}
