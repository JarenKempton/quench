import { useEffect } from "react";
import { Outlet } from "@tanstack/react-router";
import { useShellStore } from "./store";

export function AppLayout() {
  const machine = useShellStore((s) => s.machine);
  const recent = useShellStore((s) => s.recent);
  const openPath = useShellStore((s) => s.openPath);
  const init = useShellStore((s) => s.init);
  const open = useShellStore((s) => s.open);
  const pick = useShellStore((s) => s.pick);

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <span className="brand-mark">Q</span>
          <span className="brand-name">Quench</span>
        </div>
        <button type="button" className="open-button" onClick={() => void pick()}>
          Open project…
        </button>
        <nav className="nav" aria-label="Projects">
          {recent.map((p) => (
            <button
              type="button"
              key={p.path}
              className={`nav-item ${p.path === openPath ? "nav-item--active" : ""}`}
              title={p.path}
              onClick={() => void open(p.path)}
            >
              <span className="nav-label">{p.label}</span>
              <span className="nav-hint">{p.path}</span>
            </button>
          ))}
        </nav>
        <footer className="rail-foot">
          {machine && (
            <span className="core-badge" title={machine.id}>
              {machine.label}
            </span>
          )}
        </footer>
      </aside>
      <main className="stage">
        <Outlet />
      </main>
    </div>
  );
}
