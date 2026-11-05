import type { FleetFile, MachineState } from "@quench/fleet";
import type { Commit } from "./git.ts";
import { placed } from "./hub.ts";
import type { Flag } from "./review.ts";
import type { MachineRow, StoredProposal } from "./store.ts";

export const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const STYLE = `body{font:14px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:72rem;padding:0 1rem;color:#111;background:#fff}
table{border-collapse:collapse;margin:.5rem 0 1.5rem}td,th{border:1px solid #ddd;padding:.25rem .5rem;text-align:left}
pre{background:#f5f5f5;padding:.75rem;overflow:auto}textarea{width:100%;font:13px ui-monospace,monospace}
form{display:inline}code{background:#f5f5f5;padding:.1rem .3rem}.add{color:#060}.del{color:#a00}.err{color:#a00}
.claim{color:#555;font-style:italic}.flag{font-weight:600}`;

export const page = (
  title: string,
  body: string,
  status = 200,
  extra: Record<string, string> = {},
) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
        "x-frame-options": "DENY",
        "cache-control": "no-store",
        ...extra,
      },
    },
  );

const hidden = (fields: Record<string, string>) =>
  Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`)
    .join("");

const button = (action: string, fields: Record<string, string>, label: string) =>
  `<form method="post" action="${action}">${hidden(fields)}<button>${escape(label)}</button></form>`;

export const loginPage = (error = "", status = 200) =>
  page(
    "Quench hub",
    `<h1>Quench hub</h1>${error ? `<p class="err">${escape(error)}</p>` : ""}<form method="post" action="/login"><label>Owner password <input type="password" name="password" autofocus required></label> <button>Sign in</button></form>`,
    status,
  );

export const messagePage = (
  title: string,
  message: string,
  status: number,
  headers: Record<string, string> = {},
) =>
  page(
    title,
    `<h1>${escape(title)}</h1><p class="err">${escape(message)}</p><p><a href="/">Back</a></p>`,
    status,
    headers,
  );

const when = (ms: number | null) => (ms ? new Date(ms).toISOString() : "never");

const stateCell = (state: MachineState | null) =>
  state
    ? Object.entries(state.harnesses)
        .map(
          ([h, s]) =>
            `${escape(h)}: ${s.snapshot.installs.length} installed, ${s.snapshot.conflicts} conflicts${s.stale ? " (stale)" : ""}`,
        )
        .join("<br>") || "no complete harness yet"
    : "no snapshot yet";

export function dashboard(input: {
  head: string;
  fleet: FleetFile;
  warnings: string[];
  machines: (Omit<MachineRow, "state"> & { state: MachineState | null })[];
  history: Commit[];
  files: string[];
  proposals: ProposalSummary[];
  shipped: string | null;
}) {
  const { head, fleet } = input;
  const names = [
    ...new Set([...input.machines.map((m) => m.name), ...Object.keys(fleet.machines)]),
  ].sort();
  const skills = Object.keys(fleet.skills).sort();
  const grid = skills.length
    ? `<table><tr><th>Skill</th>${names.map((n) => `<th>${escape(n)}</th>`).join("")}</tr>${skills
        .map(
          (skill) =>
            `<tr><td><a href="/edit?path=${encodeURIComponent(`${fleet.skills[skill]!.path}/SKILL.md`)}">${escape(skill)}</a></td>${names
              .map((machine) => {
                const on = placed(fleet, skill, machine);
                return `<td>${on ? "on" : "off"} ${button("/toggle", { base: head, skill, machine, on: on ? "0" : "1" }, on ? "Turn off" : "Turn on")}</td>`;
              })
              .join("")}</tr>`,
        )
        .join("")}</table>`
    : "<p>No skills yet. Import a skills repo with <code>quench hub import</code>, or add one below.</p>";
  const machines = input.machines.length
    ? `<table><tr><th>Machine</th><th>Paired</th><th>Last seen</th><th>Generation</th><th>Reported state</th><th>Proposals</th><th></th></tr>${input.machines
        .map(
          (m) =>
            `<tr><td>${escape(m.name)}</td><td>${when(m.paired_at)}</td><td>${when(m.last_seen_at)}</td><td>${m.state?.generation ?? "–"}</td><td>${stateCell(m.state)}</td><td>${m.proposals ? `proposals allowed ${button("/machines/propose/revoke", { name: m.name }, "Revoke proposals")}` : button("/machines/propose", { name: m.name }, "Allow proposals")}</td><td>${button("/machines/revoke", { name: m.name }, "Revoke")}</td></tr>`,
        )
        .join("")}</table>`
    : "<p>No machines paired yet.</p>";
  const history = `<table><tr><th>Commit</th><th>When</th><th>Change</th><th></th></tr>${input.history
    .map(
      (c) =>
        `<tr><td><code>${c.sha.slice(0, 12)}</code></td><td>${escape(c.date)}</td><td>${escape(c.subject)}</td><td>${button("/revert", { base: head, commit: c.sha }, "Revert")}</td></tr>`,
    )
    .join("")}</table>`;
  const files = `<ul>${input.files
    .map((f) => `<li><a href="/edit?path=${encodeURIComponent(f)}">${escape(f)}</a></li>`)
    .join(
      "",
    )}</ul><form method="get" action="/edit"><input name="path" placeholder="skills/new-skill/SKILL.md" required> <button>Edit or create</button></form>`;
  const warnings = input.warnings.length
    ? `<ul>${input.warnings.map((w) => `<li>${escape(w)}</li>`).join("")}</ul>`
    : "";
  return page(
    "Quench hub",
    `<h1>Quench hub</h1><p>Skills at <code>${head.slice(0, 12)}</code> ${button("/logout", {}, "Sign out")}</p>${warnings}
<h2>Skills by machine</h2>${grid}${input.shipped ? `<p>${button("/skills/shipped", { base: head }, `Add the shipped ${input.shipped} skill`)} so agents can find Quench and propose skill changes.</p>` : ""}
<h2>Proposals</h2>${proposalList(input.proposals)}
<h2>Machines</h2>${machines}<form method="post" action="/machines"><label>Add machine <input name="name" pattern="[a-z0-9][a-z0-9._\\-]*" placeholder="laptop" required></label> <button>Add machine</button></form>
<h2>History</h2>${history}
<h2>Files</h2>${files}`,
  );
}

const diffBlock = (diff: string, id: string) =>
  `<pre id="${id}">${diff
    .split("\n")
    .map((l) =>
      l.startsWith("+") && !l.startsWith("+++")
        ? `<span class="add">${escape(l)}</span>`
        : l.startsWith("-") && !l.startsWith("---")
          ? `<span class="del">${escape(l)}</span>`
          : escape(l),
    )
    .join("\n")}</pre>`;

export const connectPage = (machine: string, command: string, proposals = false) =>
  page(
    proposals ? "Allow proposals" : "Add machine",
    `<h1>${proposals ? "Allow proposals from" : "Add"} ${escape(machine)}</h1><p>Run this on ${escape(machine)} within 10 minutes. The code works once.${proposals ? " It gives agents there a proposal token: they can read and propose changes to skills assigned to this machine, and nothing else." : ""}</p><pre id="connect">${escape(command)}</pre><p><a href="/">Back</a></p>`,
  );

export type ProposalSummary = Pick<
  StoredProposal,
  "id" | "skill" | "machine" | "submitted_at" | "approved_at" | "approved_commit"
> & { stale: boolean };

const status = (p: {
  approved_at: number | null;
  approved_commit: string | null;
  stale: boolean;
}) =>
  p.approved_at
    ? `approved in <code>${escape((p.approved_commit ?? "").slice(0, 12))}</code>`
    : p.stale
      ? `<span class="err">stale</span>`
      : "pending";

const proposalList = (proposals: ProposalSummary[]) =>
  proposals.length
    ? `<table><tr><th>Proposal</th><th>Skill</th><th>From machine</th><th>Submitted</th><th>Status</th></tr>${proposals
        .map(
          (p) =>
            `<tr><td><a href="/proposal?id=${p.id}">#${p.id}</a></td><td>${escape(p.skill)}</td><td>${escape(p.machine)}</td><td>${when(p.submitted_at)}</td><td>${status(p)}</td></tr>`,
        )
        .join("")}</table>`
    : "<p>No proposals yet.</p>";

const FLAG_LABELS: Record<Flag["kind"], string> = {
  url: "new URL",
  shell: "shell command",
  script: "script",
  credential: "credential mention",
};

const claim = (value: string | undefined) =>
  value === undefined
    ? `<span class="claim">not given</span>`
    : `${escape(value)} <span class="claim">(claimed, not verified)</span>`;

export function proposalPage(input: {
  proposal: StoredProposal;
  head: string;
  current: { path: string; treeHash: string } | null;
  diff: string;
  flags: Flag[];
  threeWay: string | null;
  error?: string;
  status?: number;
}) {
  const p = input.proposal;
  const stale = !input.current || input.current.treeHash !== p.base_tree_hash;
  const rows: [string, string][] = [
    ["Skill", escape(p.skill)],
    ["File", `<code>${escape(input.current?.path ?? p.skill)}/SKILL.md</code>`],
    ["Machine", `${escape(p.machine)} <span class="claim">(from its proposal token)</span>`],
    ["Agent", claim(p.claims.agent)],
    ["Harness", claim(p.claims.harness)],
    ["Session", claim(p.claims.session)],
    ["Submitted", when(p.submitted_at)],
    ["Base tree hash", `<code>${escape(p.base_tree_hash)}</code>`],
    ["Revision", `<code>${escape(p.revision)}</code>`],
    ["Status", status({ ...p, stale })],
  ];
  const evidence = p.evidence.length
    ? `<ul id="evidence">${p.evidence
        .map(
          (e) =>
            `<li>${escape(e.kind)} <b>${escape(e.name)}</b>: ${Object.entries(e.counts)
              .map(([k, n]) => `${escape(k)} ${n}`)
              .join(", ")}</li>`,
        )
        .join("")}</ul>`
    : `<p id="evidence">No evidence attached. This proposal cites no insight card or eval.</p>`;
  const flags = input.flags.length
    ? `<table id="flags"><tr><th>Flag</th><th>Line</th><th>Added text</th></tr>${input.flags
        .map(
          (f) =>
            `<tr><td class="flag">${FLAG_LABELS[f.kind]}</td><td>${f.line}</td><td><code>${escape(f.text)}</code></td></tr>`,
        )
        .join("")}</table>`
    : `<p id="flags">No new URLs, shell commands, scripts or credential mentions.</p>`;
  const decision = p.approved_at
    ? `<p>Approved and committed in <code>${escape(p.approved_commit ?? "")}</code>.</p>`
    : stale
      ? `<p class="err" id="stale">Stale: ${escape(p.skill)} ${input.current ? `changed after this proposal's base (now <code>${escape(input.current.treeHash)}</code>)` : "is no longer in the fleet"}. Approval is blocked and nothing is merged automatically.</p>${
          input.threeWay === null
            ? ""
            : `<h2>3-way diff</h2><p>current on main, the proposal's base, and the proposal, as conflict markers. Shown only; not saved.</p><pre id="three-way">${escape(input.threeWay)}</pre>`
        }`
      : `<h2>Approve</h2><form method="post" action="/proposal/approve">${hidden({ id: String(p.id), base: input.head })}<label>Re-enter the owner password <input type="password" name="password" autocomplete="current-password" required></label> <button>Approve and commit</button></form>`;
  return page(
    `Proposal #${p.id}`,
    `<h1>Proposal #${p.id} to ${escape(p.skill)}</h1>${input.error ? `<p class="err">${escape(input.error)}</p>` : ""}
<p>Written by an agent. Everything it reports about itself is a claim; the machine comes from its token.</p>
<table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("")}</table>
<h2>Evidence</h2>${evidence}
<h2>Flags</h2>${flags}
<h2>Diff against its base</h2>${input.diff ? diffBlock(input.diff, "diff") : "<p>No changes.</p>"}
${decision}
<p><a href="/">Back</a></p>`,
    input.status ?? (input.error ? 400 : 200),
  );
}

export const editPage = (input: {
  path: string;
  base: string;
  content: string;
  diff?: string;
  previewed?: string;
  error?: string;
}) => {
  const fields = {
    path: input.path,
    base: input.base,
    ...(input.previewed ? { previewed: input.previewed } : {}),
  };
  const diff =
    input.diff === undefined
      ? ""
      : input.diff === ""
        ? "<p>No changes.</p>"
        : `<h2>Diff</h2>${diffBlock(input.diff, "diff")}`;
  const save =
    input.diff && !input.error
      ? `<button name="action" value="save">Save as one commit</button>`
      : "";
  return page(
    `Edit ${input.path}`,
    `<h1>Edit <code>${escape(input.path)}</code></h1>${input.error ? `<p class="err">${escape(input.error)}</p>` : ""}${diff}
<form method="post" action="/edit">${hidden(fields)}<textarea name="content" rows="30">${escape(input.content)}</textarea><p><button name="action" value="preview">Show diff</button> ${save} <a href="/">Cancel</a></p></form>`,
    input.error ? 400 : 200,
  );
};
