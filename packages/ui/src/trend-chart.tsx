import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { tokens, type Day } from "./report.ts";

const HEIGHT = 140;
const PAD = { top: 12, right: 12, bottom: 22, left: 44 };

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(value));
  const nice = [1, 2, 2.5, 5, 10].find((m) => m * step >= value)!;
  return nice * step;
}

const shortDate = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

export function TrendChart({ window, days }: { window: string[]; days: Day[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [focus, setFocus] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const byDay = new Map(days.map((d) => [d.day, d]));
  const points = window.map((day, i) => ({ i, day, data: byDay.get(day) ?? null }));
  const known = points.filter((p) => p.data?.startingLoad != null);
  const top = niceMax(Math.max(0, ...known.map((p) => p.data!.startingLoad!)));
  const plotW = Math.max(1, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (i: number) =>
    PAD.left + (window.length > 1 ? (i / (window.length - 1)) * plotW : plotW / 2);
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;

  let path = "";
  let previous = -2;
  for (const p of known) {
    path += `${p.i === previous + 1 ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.data!.startingLoad!).toFixed(1)}`;
    previous = p.i;
  }
  const lonely = known.filter(
    (p) => !known.some((q) => q.i === p.i - 1) && !known.some((q) => q.i === p.i + 1),
  );
  const last = known.at(-1);
  const active = focus === null ? null : points[focus]!;

  const nearest = (event: PointerEvent<SVGSVGElement>) => {
    const left = event.currentTarget.getBoundingClientRect().left;
    const at = ((event.clientX - left - PAD.left) / plotW) * (window.length - 1);
    setFocus(Math.min(window.length - 1, Math.max(0, Math.round(at))));
  };
  const step = (event: KeyboardEvent<SVGSVGElement>) => {
    const move = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (!move) return;
    event.preventDefault();
    const from = focus ?? (move > 0 ? -1 : window.length);
    setFocus(Math.min(window.length - 1, Math.max(0, from + move)));
  };
  const ticks = [0, top / 2, top];
  const labels = [0, Math.floor((window.length - 1) / 2), window.length - 1];

  return (
    <div ref={box} className="relative">
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label="Median starting load per day, in tokens"
        tabIndex={0}
        className="block touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        onPointerMove={nearest}
        onPointerLeave={() => setFocus(null)}
        onKeyDown={step}
        onBlur={() => setFocus(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(t)}
              y2={y(t)}
              className="stroke-border"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={y(t)}
              dy="0.32em"
              textAnchor="end"
              className="fill-muted-foreground font-mono text-[10px]"
            >
              {tokens(t)}
            </text>
          </g>
        ))}
        {labels.map((i, n) => (
          <text
            key={i}
            x={x(i)}
            y={HEIGHT - 6}
            textAnchor={n === 0 ? "start" : n === 2 ? "end" : "middle"}
            className="fill-muted-foreground font-mono text-[10px]"
          >
            {shortDate(window[i]!)}
          </text>
        ))}
        {active && (
          <line
            x1={x(active.i)}
            x2={x(active.i)}
            y1={PAD.top}
            y2={PAD.top + plotH}
            className="stroke-ring"
            strokeWidth={1}
          />
        )}
        <path
          d={path}
          fill="none"
          stroke="var(--series-1)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {lonely.map((p) => (
          <circle
            key={p.i}
            cx={x(p.i)}
            cy={y(p.data!.startingLoad!)}
            r={4}
            fill="var(--series-1)"
          />
        ))}
        {[active?.data?.startingLoad != null ? active : last].map(
          (p) =>
            p && (
              <circle
                key="marker"
                cx={x(p.i)}
                cy={y(p.data!.startingLoad!)}
                r={4}
                fill="var(--series-1)"
                stroke="var(--background)"
                strokeWidth={2}
              />
            ),
        )}
      </svg>
      {active && (
        <div
          role="status"
          className="pointer-events-none absolute top-0 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs shadow-sm"
          style={{
            left: Math.min(Math.max(0, x(active.i) + 10), width - 150),
          }}
        >
          <div className="flex items-center gap-2">
            <span className="h-0.5 w-3 rounded-full bg-[var(--series-1)]" />
            <span className="font-mono font-semibold">
              {active.data?.startingLoad != null ? tokens(active.data.startingLoad) : "–"}
            </span>
            <span className="text-muted-foreground">median start</span>
          </div>
          <div className="mt-0.5 text-muted-foreground">
            {shortDate(active.day)} ·{" "}
            {active.data ? `${active.data.sessions} sessions` : "no sessions"}
          </div>
        </div>
      )}
    </div>
  );
}
