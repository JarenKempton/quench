import { useShellStore } from "../store";
import type { Cost } from "../generated/Cost";
import type { Row } from "../generated/Row";
import type { Toggle } from "../generated/Toggle";
import { ChangesBar } from "./ChangesBar";

export function ContextPanel() {
  const view = useShellStore((s) => s.view);
  const status = useShellStore((s) => s.status);
  const error = useShellStore((s) => s.error);
  const pick = useShellStore((s) => s.pick);

  if (!view) {
    return (
      <section className="panel">
        {status === "loading" && <p className="muted">Reading project…</p>}
        {status === "error" && <Notice text={error} />}
        {status !== "loading" && (
          <div className="empty">
            <p className="empty-lead">Open a project to see what Claude Code loads there.</p>
            <button type="button" className="open-button" onClick={() => void pick()}>
              Open project…
            </button>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="panel panel--wide">
      <header className="panel-head">
        <div>
          <h1 className="panel-title">{view.project.label}</h1>
          <p className="panel-tagline">
            {view.project.path} · {view.project.identity}
          </p>
        </div>
        <div className="total" title={view.token_method}>
          <span className="total-value">~{view.always_tokens.toLocaleString()}</span>
          <span className="total-label">
            tokens always loaded in {view.harness} ({view.token_method})
          </span>
        </div>
      </header>
      {status === "error" && <Notice text={error} />}
      <ChangesBar />
      <div className="panel-body">
        {view.sections.map((section) => (
          <section key={section.id} className="ctx-section">
            <h2 className="ctx-title">
              {section.title} <span className="muted">{section.rows.length}</span>
            </h2>
            <ul className="skill-list">
              {section.rows.map((row) => (
                <ContextRow key={row.id} row={row} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </section>
  );
}

function ContextRow({ row }: { row: Row }) {
  return (
    <li className="skill-row">
      <div className="skill-line">
        <span className="skill-name">{row.title}</span>
        <span className="tag">{row.scope}</span>
        <span className="cost">{costLabel(row.cost)}</span>
        {row.toggle && <ToggleSelect toggle={row.toggle} />}
      </div>
      {row.detail && <p className="skill-desc">{row.detail}</p>}
      <p className="skill-origin" title={row.location}>
        {row.location}
        {row.notes.map((n) => ` · ${n}`).join("")}
      </p>
    </li>
  );
}

const VALUES = [
  ["inherit", "Inherit"],
  ["on", "On"],
  ["name-only", "Name only"],
  ["user-invocable-only", "Slash only"],
  ["off", "Off"],
] as const;

function ToggleSelect({ toggle }: { toggle: Toggle }) {
  const stage = useShellStore((s) => s.stage);
  const current = toggle.pending ?? toggle.local ?? "inherit";
  return (
    <select
      className={`toggle ${toggle.pending ? "toggle--pending" : ""}`}
      aria-label={`${toggle.skill} in this project`}
      title={`Effective: ${toggle.value} (from ${toggle.source}). Changes write this project's .claude/settings.local.json.`}
      disabled={toggle.locked}
      value={current}
      onChange={(e) =>
        void stage(toggle.skill, e.target.value === "inherit" ? null : e.target.value)
      }
    >
      {VALUES.map(([value, label]) => (
        <option key={value} value={value}>
          {value === "inherit" ? `${label} (${toggle.local ? "default" : toggle.value})` : label}
        </option>
      ))}
    </select>
  );
}

function costLabel(cost: Cost): string {
  if (cost.kind === "duplicate") return "counted once";
  if (cost.kind === "unknown") return "cost unknown";
  const onDemand = cost.on_demand_tokens > 0 ? `${cost.on_demand_tokens} on use` : "";
  if (cost.always_tokens === 0) return onDemand ? `${onDemand} only` : "0 tok";
  return onDemand ? `~${cost.always_tokens} tok · ${onDemand}` : `~${cost.always_tokens} tok`;
}

function Notice({ text }: { text: string | null }) {
  return (
    <div className="notice notice--error">
      <p className="notice-lead">Couldn't open that project.</p>
      <p className="notice-body">{text}</p>
    </div>
  );
}
