import type { ReactNode } from "react";

/**
 * The scaffold's panels are deliberately empty shells (hone#12). A stub renders
 * its identity and an honest "not built yet" state — never fabricated data, per
 * Hone's standing stance that every number has provenance.
 */
export function StubPanel(props: { title: string; tagline: string; planned: ReactNode }) {
  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h1 className="panel-title">{props.title}</h1>
          <p className="panel-tagline">{props.tagline}</p>
        </div>
        <span className="stub-badge">stub</span>
      </header>
      <div className="panel-body">
        <div className="empty">
          <p className="empty-lead">Not built yet.</p>
          <p className="empty-planned">{props.planned}</p>
        </div>
      </div>
    </section>
  );
}
