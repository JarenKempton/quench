import { useEffect } from "react";
import { Link, Outlet } from "@tanstack/react-router";
import { useShellStore } from "./store";

const NAV = [
  { to: "/", label: "X-ray", hint: "What's entering context" },
  { to: "/matrix", label: "Matrix", hint: "Skills × harnesses" },
  { to: "/skills", label: "Skill editor", hint: "Author & stage" },
] as const;

export function AppLayout() {
  const coreVersion = useShellStore((s) => s.coreVersion);
  const connect = useShellStore((s) => s.connect);
  const runScan = useShellStore((s) => s.runScan);

  useEffect(() => {
    connect();
    runScan();
  }, [connect, runScan]);

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <span className="brand-mark">H</span>
          <span className="brand-name">Hone</span>
        </div>
        <nav className="nav">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              className="nav-item"
              activeProps={{ className: "nav-item nav-item--active" }}
              activeOptions={{ exact: n.to === "/" }}
            >
              <span className="nav-label">{n.label}</span>
              <span className="nav-hint">{n.hint}</span>
            </Link>
          ))}
        </nav>
        <footer className="rail-foot">
          {coreVersion ? (
            <span className="core-badge core-badge--live">core {coreVersion}</span>
          ) : (
            <span className="core-badge">core: not connected</span>
          )}
        </footer>
      </aside>
      <main className="stage">
        <Outlet />
      </main>
    </div>
  );
}
