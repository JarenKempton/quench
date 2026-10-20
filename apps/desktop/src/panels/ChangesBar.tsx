import { useShellStore } from "../store";

export function ChangesBar() {
  const changes = useShellStore((s) => s.changes);
  const run = useShellStore((s) => s.run);
  if (!changes || (changes.items.length === 0 && !changes.can_undo)) return null;

  return (
    <aside className="changes" aria-label="Pending changes">
      <div className="changes-head">
        <span className="changes-title">
          {changes.items.length === 0
            ? "No pending changes"
            : `${changes.items.length} pending change${changes.items.length === 1 ? "" : "s"}`}
        </span>
        <div className="changes-actions">
          {changes.can_undo && (
            <button type="button" className="ghost-button" onClick={() => void run("undo")}>
              Undo last apply
            </button>
          )}
          {changes.items.length > 0 && (
            <>
              <button type="button" className="ghost-button" onClick={() => void run("discard")}>
                Discard
              </button>
              <button type="button" className="open-button" onClick={() => void run("apply")}>
                Apply
              </button>
            </>
          )}
        </div>
      </div>
      {changes.items.length > 0 && (
        <ul className="changes-list">
          {changes.items.map((c) => (
            <li key={`${c.project}:${c.skill}`}>
              {c.project} · <strong>{c.skill}</strong> {c.from} → {c.to}
            </li>
          ))}
        </ul>
      )}
      {changes.files.map((f) => (
        <details key={f.file} className="changes-diff">
          <summary>{f.file}</summary>
          <div className="diff-cols">
            <pre>{f.before || "(new file)"}</pre>
            <pre>{f.after}</pre>
          </div>
        </details>
      ))}
    </aside>
  );
}
