import { useMemo } from "react";
import { useShellStore } from "../store";
import type { Scan } from "../scan";

/**
 * Matrix: every discovered skill against every harness (hone#13) — its first
 * real data too. A cell is filled only where the scanner actually found that
 * skill under that harness; staging activation as a mutation to apply is later
 * (the Zustand tray model is still fog, hone#7). Read-only and honest for now.
 */
export function MatrixPanel() {
  const scan = useShellStore((s) => s.scan);
  const status = useShellStore((s) => s.scanStatus);

  const rows = useMemo(() => (scan ? buildRows(scan) : []), [scan]);

  return (
    <section className="panel panel--wide">
      <header className="panel-head">
        <div>
          <h1 className="panel-title">Matrix</h1>
          <p className="panel-tagline">
            Every skill on this machine against every harness — filled only where the
            scanner really found it.
          </p>
        </div>
        {scan && (
          <span className="stub-badge stub-badge--live">
            {rows.length} × {scan.harnesses.length}
          </span>
        )}
      </header>

      <div className="panel-body">
        {status === "scanning" && !scan && <p className="muted">Scanning this machine…</p>}
        {status === "error" && <p className="muted">Scan failed — nothing to grid.</p>}
        {scan && rows.length === 0 && <p className="muted">No skills found.</p>}
        {scan && rows.length > 0 && (
          <div className="matrix-scroll">
            <table className="matrix">
              <thead>
                <tr>
                  <th className="matrix-corner">skill</th>
                  {scan.harnesses.map((h) => (
                    <th key={h.id} className="matrix-col" title={h.skills_dir.path}>
                      {h.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.name} className={row.count > 1 ? "matrix-dup" : ""}>
                    <th className="matrix-skill" title={row.name}>
                      {row.name}
                    </th>
                    {scan.harnesses.map((h) => (
                      <td key={h.id} className="matrix-cell">
                        {row.present.has(h.id) ? <span className="dot" /> : ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

interface Row {
  name: string;
  present: Set<string>;
  count: number;
}

/** One row per unique skill name (case-insensitive), marking which harnesses have it. */
function buildRows(scan: Scan): Row[] {
  const byName = new Map<string, Row>();
  for (const h of scan.harnesses) {
    for (const s of h.skills) {
      const key = s.name.toLowerCase();
      let row = byName.get(key);
      if (!row) {
        row = { name: s.name, present: new Set(), count: 0 };
        byName.set(key, row);
      }
      if (!row.present.has(h.id)) {
        row.present.add(h.id);
        row.count += 1;
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}
