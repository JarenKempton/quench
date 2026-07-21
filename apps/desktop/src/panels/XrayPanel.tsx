import { useShellStore } from "../store";
import { originLabel, tildeify, type Harness, type Scan, type Skill } from "../scan";

/**
 * X-ray: the first panel with real data (quench#13). Every harness, every skill,
 * every count here is read live off this machine's filesystem with honest
 * provenance — a symlinked skill shows the source repo it resolves to, a broken
 * link is surfaced rather than hidden, and nothing is ever fabricated.
 */
export function XrayPanel() {
  const scan = useShellStore((s) => s.scan);
  const status = useShellStore((s) => s.scanStatus);
  const error = useShellStore((s) => s.scanError);

  return (
    <section className="panel panel--wide">
      <header className="panel-head">
        <div>
          <h1 className="panel-title">X-ray</h1>
          <p className="panel-tagline">
            Everything entering an agent's context, read live off this machine with honest
            provenance.
          </p>
        </div>
        <ScanBadge status={status} count={scan?.harnesses.length ?? 0} />
      </header>

      <div className="panel-body">
        {status === "error" && (
          <div className="notice notice--error">
            <p className="notice-lead">Scan failed.</p>
            <p className="notice-body">{error}</p>
          </div>
        )}
        {status === "scanning" && !scan && <p className="muted">Scanning this machine…</p>}
        {scan && (
          <>
            <div className="harness-grid">
              {scan.harnesses.map((h) => (
                <HarnessCard key={h.id} harness={h} />
              ))}
            </div>
            <ProjectStrays scan={scan} />
            {scan.duplicate_names.length > 0 && (
              <div className="notice">
                <p className="notice-lead">
                  {scan.duplicate_names.length} skill
                  {scan.duplicate_names.length === 1 ? "" : "s"} appear across more than one harness
                </p>
                <p className="notice-body">
                  {scan.duplicate_names.join(", ")} — the same name resolved by multiple harnesses.
                  See the Matrix for where each is active.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function HarnessCard({ harness }: { harness: Harness }) {
  return (
    <article className={`hcard ${harness.home.present ? "" : "hcard--absent"}`}>
      <header className="hcard-head">
        <span className="hcard-name">{harness.name}</span>
        {harness.home.present ? (
          <span className="tag tag--live">{harness.skills.length} skills</span>
        ) : (
          <span className="tag">not installed</span>
        )}
      </header>

      {harness.home.present ? (
        <>
          <p className="hcard-path" title={harness.skills_dir.path}>
            {harness.skills_dir.present ? tildeify(harness.skills_dir.path) : "no skills dir"}
          </p>

          {harness.context_files.map((c) => (
            <p key={c.path} className="hcard-context" title={c.path}>
              context · {tildeify(c.path)} · {c.bytes} B{c.linked_to ? " · linked" : ""}
            </p>
          ))}

          <ul className="skill-list">
            {harness.skills.map((s) => (
              <SkillRow key={s.manifest} skill={s} />
            ))}
          </ul>

          {harness.dangling.length > 0 && (
            <p className="hcard-danger">
              {harness.dangling.length} broken link
              {harness.dangling.length === 1 ? "" : "s"} (target missing)
            </p>
          )}
        </>
      ) : (
        <p className="hcard-path" title={harness.home.path}>
          {tildeify(harness.home.path)}
        </p>
      )}
    </article>
  );
}

function SkillRow({ skill }: { skill: Skill }) {
  const label = tildeify(originLabel(skill.origin));
  return (
    <li className="skill-row">
      <div className="skill-line">
        <span className="skill-name">{skill.name}</span>
        <span
          className={`skill-origin ${skill.origin.kind === "linked" ? "skill-origin--linked" : ""}`}
          title={label}
        >
          {skill.origin.kind === "linked" ? "↳ " : ""}
          {label}
        </span>
      </div>
      {skill.description && <p className="skill-desc">{skill.description}</p>}
    </li>
  );
}

function ProjectStrays({ scan }: { scan: Scan }) {
  const { project } = scan;
  return (
    <div className="strays">
      <h2 className="strays-title">Project strays</h2>
      <p className="strays-sub" title={project.root}>
        skills committed inside the launched project — {tildeify(project.root)}
      </p>
      {project.skills.length === 0 ? (
        <p className="muted">None found. This project defines no local skills of its own.</p>
      ) : (
        <ul className="skill-list">
          {project.skills.map((s) => (
            <SkillRow key={s.manifest} skill={s} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ScanBadge({ status, count }: { status: string; count: number }) {
  if (status === "ready") {
    return <span className="stub-badge stub-badge--live">{count} harnesses</span>;
  }
  if (status === "scanning") return <span className="stub-badge">scanning…</span>;
  if (status === "error") return <span className="stub-badge">scan failed</span>;
  return <span className="stub-badge">idle</span>;
}
