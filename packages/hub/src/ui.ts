import type { FleetFile, MachineState } from "@quench/fleet";
import type { Commit } from "./git.ts";
import { placed } from "./hub.ts";
import { skillGrid, versionSection, type CardView, type Desired } from "./skill-views.ts";
import type { MachineRow } from "./store.ts";

export const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const STYLE = `body{font:14px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:72rem;padding:0 1rem;color:#111;background:#fff}
table{border-collapse:collapse;margin:.5rem 0 1.5rem}td,th{border:1px solid #ddd;padding:.25rem .5rem;text-align:left}
pre{background:#f5f5f5;padding:.75rem;overflow:auto}textarea{width:100%;font:13px ui-monospace,monospace}
form{display:inline}code{background:#f5f5f5;padding:.1rem .3rem}.add{color:#060}.del{color:#a00}.err{color:#a00}
.grid td{vertical-align:top}.grid div{white-space:nowrap}small,.n{color:#555;font-size:12px}.warn{color:#a50}
.card{border:1px solid #ddd;border-radius:4px;padding:.25rem 1rem .75rem;margin:1rem 0}.card.thin{color:#555}
.basis{font-weight:600}.diff{max-height:24rem}`;

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

export const button = (action: string, fields: Record<string, string>, label: string) =>
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

const staleness = (state: MachineState) =>
  state.staleness
    ? `<br><span class="warn">stale from ${escape(state.staleness.since)} until ${escape(state.staleness.until)}</span>`
    : "";

const stateCell = (state: MachineState | null) =>
  state
    ? (Object.entries(state.harnesses)
        .map(
          ([h, s]) =>
            `${escape(h)}: ${s.snapshot.installs.length} installed, ${s.snapshot.conflicts} conflicts${s.stale ? " (stale)" : ""}`,
        )
        .join("<br>") || "no complete harness yet") + staleness(state)
    : "no snapshot yet";

export function dashboard(input: {
  head: string;
  fleet: FleetFile;
  warnings: string[];
  machines: (Omit<MachineRow, "state"> & { state: MachineState | null })[];
  history: Commit[];
  files: string[];
  desired: Desired;
  cards: CardView[];
}) {
  const { head, fleet } = input;
  const grid = skillGrid(
    { escape, button },
    {
      head,
      fleet,
      machines: input.machines,
      desired: input.desired,
      placed: (skill, machine) => placed(fleet, skill, machine),
    },
  );
  const machines = input.machines.length
    ? `<table><tr><th>Machine</th><th>Paired</th><th>Last seen</th><th>Generation</th><th>Reported state</th><th></th></tr>${input.machines
        .map(
          (m) =>
            `<tr><td>${escape(m.name)}</td><td>${when(m.paired_at)}</td><td>${when(m.last_seen_at)}</td><td>${m.state?.generation ?? "–"}</td><td>${stateCell(m.state)}</td><td>${button("/machines/revoke", { name: m.name }, "Revoke")}</td></tr>`,
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
<h2>Skills by machine</h2>${grid}
<h2>Skill versions</h2>${versionSection({ escape, button }, head, input.cards)}
<h2>Machines</h2>${machines}<form method="post" action="/machines"><label>Add machine <input name="name" pattern="[a-z0-9][a-z0-9._\\-]*" placeholder="laptop" required></label> <button>Add machine</button></form>
<h2>History</h2>${history}
<h2>Files</h2>${files}`,
  );
}

export const connectPage = (machine: string, command: string) =>
  page(
    "Add machine",
    `<h1>Add ${escape(machine)}</h1><p>Run this on ${escape(machine)} within 10 minutes. The code works once.</p><pre id="connect">${escape(command)}</pre><p><a href="/">Back</a></p>`,
  );

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
        : `<h2>Diff</h2><pre id="diff">${input.diff
            .split("\n")
            .map((l) =>
              l.startsWith("+") && !l.startsWith("+++")
                ? `<span class="add">${escape(l)}</span>`
                : l.startsWith("-") && !l.startsWith("---")
                  ? `<span class="del">${escape(l)}</span>`
                  : escape(l),
            )
            .join("\n")}</pre>`;
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
